'use strict';
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { AnalysisV1 } = require('./schemas/analysis.v1');

const API_KEY = () => process.env.GEMINI_API_KEY || '';
const MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const BASE_URL = () => process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

const DetalheSchema = z.object({
  momentos: z.array(z.object({
    trecho: z.string().max(500),
    problema: z.string().max(500),
    alternativa: z.string().max(500),
  })).max(10),
});

const BenchmarkSchema = z.object({
  resultado: z.object({
    resumo_grupo: z.string(),
    etapas_criticas: z.array(z.string()).optional(),
    destaques: z.array(z.string()).optional(),
  }),
  planos: z.array(z.object({
    dentista_id: z.string().uuid(),
    plano: z.string().max(500),
  })),
});

const LigacaoAnaliseSchema = z.object({
  transcricao: z.string(),
  resumo: z.string().max(1000),
  pontos_fortes: z.array(z.string()).max(10),
  pontos_melhora: z.array(z.string()).max(10),
  score: z.number().min(0).max(10),
});

// Gemini response_schema for AnalysisV1.
// Nested nullable objects in response_schema can cause 400 from Gemini — we omit "detalhe"
// from the schema and let Zod handle the full validation instead.
const ANALYSIS_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    schema_version: { type: 'integer' },
    nota_final: { type: 'number' },
    veredito: { type: 'string' },
    fechou: { type: 'boolean', nullable: true },
    etapas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nome: { type: 'string' },
          nota: { type: 'number' },
          feedback: { type: 'string' },
          melhoria: { type: 'string' },
          trechos: { type: 'array', items: { type: 'string' } },
        },
        required: ['nome', 'nota', 'feedback', 'melhoria', 'trechos'],
      },
    },
    relatorios: {
      type: 'object',
      properties: {
        comercial: {
          type: 'object',
          properties: {
            paciente: { type: 'string' },
            contato: { type: 'string' },
            queixa_principal: { type: 'string' },
            tratamento_proposto: { type: 'string' },
            valor: { type: 'string' },
            poder_de_compra: { type: 'string' },
            abordagem_followup: { type: 'string' },
            objecoes: { type: 'array', items: { type: 'string' } },
            gatilhos_emocionais: { type: 'array', items: { type: 'string' } },
          },
        },
        sucesso: {
          type: 'object',
          properties: {
            resumo_clinico: { type: 'string' },
            jornada_paciente: { type: 'string' },
            como_garantir_boa_experiencia: { type: 'string' },
            plano_de_fases: { type: 'array', items: { type: 'string' } },
            pontos_atencao_emocional: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
  required: ['schema_version', 'nota_final', 'veredito', 'etapas'],
};

const _promptCache = {};
function loadPrompt(name) {
  return _promptCache[name] ??= fs.readFileSync(path.join(__dirname, 'prompts', name), 'utf8');
}

function nonce() {
  return crypto.randomBytes(8).toString('hex');
}

// Removes all nonce-delimiter patterns from user-controlled text to neutralize prompt injection
function sanitize(text) {
  if (!text) return '';
  return text.replace(/<<<[A-Z_]+(?:_[0-9a-f]+)?>>>/g, '');
}

function httpsPost(url, body, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: timeoutMs,
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Gemini timeout após 90s')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function geminiUrl() {
  return `${BASE_URL()}/models/${MODEL()}:generateContent?key=${API_KEY()}`;
}

function extractText(raw) {
  const json = JSON.parse(raw);
  const candidate = json?.candidates?.[0];
  if (!candidate) throw new Error('Gemini: no candidates in response');
  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini: empty text part');
  return text;
}

// Attempts up to 2 calls: first with response_schema, then without (fallback when Gemini returns 400).
// Validates result with zodSchema in both cases.
async function callWithRetry(prompt, zodSchema, responseSchema) {
  let lastErr;

  for (let attempt = 0; attempt < 2; attempt++) {
    const withSchema = attempt === 0 && responseSchema != null;
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: withSchema ? 0.3 : 0,
        responseMimeType: 'application/json',
        ...(withSchema ? { responseSchema } : {}),
      },
    };

    try {
      const { status, body: raw } = await httpsPost(geminiUrl(), body);

      // 429 = quota/credits exhausted — no point retrying, surface immediately
      if (status === 429) {
        let geminiMsg = 'Créditos do Gemini esgotados.';
        try { geminiMsg = JSON.parse(raw)?.error?.message || geminiMsg; } catch (_) {}
        const err = new Error(`Gemini: ${geminiMsg}`);
        err.status = 503;
        throw err;
      }

      // Gemini returns 400 when response_schema is incompatible — drop it and retry
      if (status === 400 && withSchema) {
        lastErr = new Error(`Gemini 400 with schema (will retry without): ${raw.slice(0, 200)}`);
        continue;
      }

      if (status !== 200) {
        lastErr = new Error(`Gemini ${status}: ${raw.slice(0, 200)}`);
        continue;
      }

      const geminiJson = JSON.parse(raw);
      const candidate = geminiJson?.candidates?.[0];
      if (!candidate) throw new Error('Gemini: no candidates in response');
      const text = candidate?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Gemini: empty text part');
      const parsed = JSON.parse(text);
      const result = zodSchema.safeParse(parsed);
      if (!result.success) {
        lastErr = new Error(`Zod validation failed: ${JSON.stringify(result.error.issues.slice(0, 3))}`);
        continue;
      }
      const usage = geminiJson?.usageMetadata ?? {};
      return {
        data: result.data,
        tokensIn: usage.promptTokenCount ?? 0,
        tokensOut: usage.candidatesTokenCount ?? 0,
      };
    } catch (err) {
      lastErr = err;
    }
  }

  const err = new Error(`Gemini falhou após 2 tentativas: ${lastErr?.message}`);
  err.status = 502;
  throw err;
}

async function analyzeTranscript({ dentistId, transcript, contextoPrompt, consultaId, supabase }) {
  // Idempotency: return cached analysis if this consultaId was already analyzed
  if (consultaId && supabase) {
    const { data: existing } = await supabase
      .from('consultas_spin')
      .select('analysis')
      .eq('id', consultaId)
      .eq('dentista_id', dentistId)
      .maybeSingle();
    if (existing?.analysis) {
      const cached = AnalysisV1.safeParse(existing.analysis);
      if (cached.success) return { analysis: cached.data, tokensIn: 0, tokensOut: 0, custoUsd: 0 };
    }
  }

  const n = nonce();
  const template = loadPrompt('analise.v1.txt');
  const safeContexto = sanitize(contextoPrompt);
  const rawTranscript = typeof transcript === 'string' ? transcript : JSON.stringify(transcript);
  const safeTranscript = sanitize(rawTranscript);

  const prompt = template
    .replace('{CONTEXTO_DENTISTA}', safeContexto || '(sem contexto adicional)')
    .replace(/\{NONCE\}/g, n)
    .replace('{TRANSCRIPT}', safeTranscript);

  const { data: analysis, tokensIn, tokensOut } = await callWithRetry(prompt, AnalysisV1, ANALYSIS_RESPONSE_SCHEMA);
  const custoUsd = parseFloat(((tokensIn * 0.15 + tokensOut * 0.60) / 1_000_000).toFixed(6));
  return { analysis, tokensIn, tokensOut, custoUsd };
}

async function detalharEtapa({ etapaIdx, etapaNome, trechos, nota, dentistId, supabase }) {
  const n = nonce();
  const template = loadPrompt('detalhar.v1.txt');
  const trechosText = sanitize(Array.isArray(trechos) ? trechos.join('\n') : String(trechos || ''));

  const prompt = template
    .replace('{ETAPA}', sanitize(etapaNome))
    .replace('{NOTA}', sanitize(String(nota)))
    .replace(/\{NONCE\}/g, n)
    .replace('{TRECHOS}', trechosText);

  const { data, tokensIn, tokensOut } = await callWithRetry(prompt, DetalheSchema, null);
  return { detalhe: data, tokensIn, tokensOut };
}

async function gerarInsights({ feedbacks }) {
  const n = nonce();
  const template = loadPrompt('insights.v1.txt');
  const feedbacksText = Array.isArray(feedbacks)
    ? feedbacks.map((f, i) => {
        // Sanitize free-text comentario to neutralize prompt injection
        const safe = { ...f };
        if (safe.comentario) safe.comentario = sanitize(String(safe.comentario));
        if (Array.isArray(safe.etapas)) {
          safe.etapas = safe.etapas.map(e => ({
            ...e,
            comentario: e.comentario ? sanitize(String(e.comentario)) : e.comentario,
          }));
        }
        return `[${i + 1}] ${JSON.stringify(safe)}`;
      }).join('\n')
    : sanitize(String(feedbacks || ''));

  const prompt = template
    .replace(/\{NONCE\}/g, n)
    .replace('{FEEDBACKS}', `<<<INSIGHTS_FEEDBACKS_BEGIN_${n}>>>\n${feedbacksText}\n<<<INSIGHTS_FEEDBACKS_END_${n}>>>`);

  // Insights is free-form text, not JSON — use plain generateContent without JSON mode
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3 },
  };

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { status, body: raw } = await httpsPost(geminiUrl(), body);
      if (status === 429) {
        let msg = 'Créditos do Gemini esgotados.';
        try { msg = JSON.parse(raw)?.error?.message || msg; } catch (_) {}
        const e = new Error(`Gemini: ${msg}`); e.status = 503; throw e;
      }
      if (status !== 200) {
        lastErr = new Error(`Gemini ${status}: ${raw.slice(0, 200)}`);
        continue;
      }
      const text = extractText(raw).trim();
      if (!text) { lastErr = new Error('Gemini: empty insights response'); continue; }
      return text;
    } catch (err) {
      if (err.status === 503) throw err;
      lastErr = err;
    }
  }

  const err = new Error(`Gemini insights falhou após 2 tentativas: ${lastErr?.message}`);
  err.status = 502;
  throw err;
}

async function gerarBenchmark({ agregados, periodo }) {
  const template = loadPrompt('benchmark.v1.txt');
  const agregadosText = typeof agregados === 'string' ? agregados : JSON.stringify(agregados, null, 2);
  const periodoText = typeof periodo === 'string' ? periodo : JSON.stringify(periodo);

  const prompt = template
    .replace('{PERIODO}', periodoText)
    .replace('{AGREGADOS}', agregadosText);

  const { data, tokensIn, tokensOut } = await callWithRetry(prompt, BenchmarkSchema, null);
  const custoUsd = parseFloat(((tokensIn * 0.15 + tokensOut * 0.60) / 1_000_000).toFixed(6));
  return { ...data, tokensIn, tokensOut, custoUsd };
}

// Transcreve e analisa uma gravação de ligação em uma única chamada Gemini.
// audioBuffer: Buffer com o áudio; contentType: 'audio/mpeg' | 'audio/ogg' | etc.
async function analyzeLigacao({ audioBuffer, contentType = 'audio/mpeg', modulo = 'leads' }) {
  const base64Audio = audioBuffer.toString('base64');

  const prompt = `Você é um avaliador de qualidade de atendimento de uma clínica odontológica.
Transcreva e analise a chamada a seguir em português.
Retorne APENAS JSON válido (sem markdown), no formato:
{
  "transcricao": "texto completo da conversa, identificando os falantes como Atendente e Paciente",
  "resumo": "resumo em 2-3 frases do que foi discutido",
  "pontos_fortes": ["ponto 1", "ponto 2"],
  "pontos_melhora": ["ponto 1", "ponto 2"],
  "score": 7
}
O score vai de 0 a 10 com base na qualidade do atendimento.`;

  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: contentType, data: base64Audio } },
        { text: prompt },
      ],
    }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
    },
  };

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { status, body: raw } = await httpsPost(geminiUrl(), body, 180000);
      if (status === 429) {
        let msg = 'Créditos do Gemini esgotados.';
        try { msg = JSON.parse(raw)?.error?.message || msg; } catch (_) {}
        const e = new Error(`Gemini: ${msg}`); e.status = 503; throw e;
      }
      if (status !== 200) {
        lastErr = new Error(`Gemini ${status}: ${raw.slice(0, 200)}`);
        continue;
      }
      const geminiJson = JSON.parse(raw);
      const text = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) { lastErr = new Error('Gemini: empty text'); continue; }
      const parsed = JSON.parse(text);
      const result = LigacaoAnaliseSchema.safeParse(parsed);
      if (!result.success) {
        lastErr = new Error(`Zod: ${JSON.stringify(result.error.issues.slice(0, 2))}`);
        continue;
      }
      const usage = geminiJson?.usageMetadata ?? {};
      return {
        data: result.data,
        tokensIn: usage.promptTokenCount ?? 0,
        tokensOut: usage.candidatesTokenCount ?? 0,
      };
    } catch (e) {
      if (e.status === 503) throw e;
      lastErr = e;
    }
  }
  const err = new Error(`analyzeLigacao falhou: ${lastErr?.message}`);
  err.status = 502;
  throw err;
}

async function transcreverAudio({ audioBuffer, contentType = 'audio/mpeg' }) {
  const base64Audio = audioBuffer.toString('base64');
  const prompt = `Transcreva o áudio a seguir em português brasileiro.
Identifique os falantes como Dentista e Paciente.
Retorne APENAS JSON válido (sem markdown), no formato:
{"linhas": [{"falante": "Dentista", "fala": "..."}, {"falante": "Paciente", "fala": "..."}]}
Se não conseguir distinguir os falantes, use "Dentista" para todas as falas.`;

  const TranscricaoSchema = z.object({
    linhas: z.array(z.object({
      falante: z.string(),
      fala: z.string(),
    })).min(1),
  });

  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: contentType, data: base64Audio } },
      { text: prompt },
    ]}],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  };

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { status, body: raw } = await httpsPost(geminiUrl(), body, 180000);
      if (status === 429) {
        let msg = 'Créditos do Gemini esgotados.';
        try { msg = JSON.parse(raw)?.error?.message || msg; } catch (_) {}
        const e = new Error(`Gemini: ${msg}`); e.status = 503; throw e;
      }
      if (status !== 200) { lastErr = new Error(`Gemini ${status}`); continue; }
      const json = JSON.parse(raw);
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) { lastErr = new Error('Gemini: empty'); continue; }
      const result = TranscricaoSchema.safeParse(JSON.parse(text));
      if (!result.success) { lastErr = new Error(`Zod: ${JSON.stringify(result.error.issues[0])}`); continue; }
      const usage = json?.usageMetadata ?? {};
      // Convert to words-compatible format (speaker 0 = Dentista, 1 = Paciente)
      const words = result.data.linhas.map((linha, i) => ({
        word: linha.fala,
        punctuated_word: linha.fala,
        start: i,
        end: i + 1,
        speaker: linha.falante.toLowerCase().includes('paciente') ? 1 : 0,
      }));
      return { words, tokensIn: usage.promptTokenCount ?? 0, tokensOut: usage.candidatesTokenCount ?? 0 };
    } catch (e) {
      if (e.status === 503) throw e;
      lastErr = e;
    }
  }
  throw new Error(`transcreverAudio falhou: ${lastErr?.message}`);
}

module.exports = { analyzeTranscript, detalharEtapa, gerarInsights, gerarBenchmark, analyzeLigacao, transcreverAudio };
