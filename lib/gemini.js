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

// ── Avaliação do consultor (DRE) ─────────────────────────────────────────────
const AVALIACAO_DRE_SCHEMA = z.object({
  resumo: z.string().min(20),
  pontos: z.array(z.string()).min(2).max(5),
  recomendacoes: z.array(z.string()).min(1).max(4),
});

// Recebe os FATOS já calculados (lib/financeiro/avaliacao.js) e escreve a
// leitura de consultor. A IA não calcula nada — só interpreta os números dados.
async function avaliarDRE({ fatos }) {
  const prompt = [
    'Você é um consultor financeiro experiente de clínicas odontológicas no Brasil.',
    'Avalie o desempenho do período com base EXCLUSIVAMENTE nos fatos calculados abaixo (JSON).',
    'NUNCA invente ou recalcule números — cite apenas valores presentes nos fatos, formatados em R$ (milhar com ponto) ou %.',
    'Campos: receita/resultado/margem do período; contexto = média dos meses anteriores; vsContexto = período vs essa média;',
    'anoAnterior = mesmos meses do ano passado; desvios = contas de saída que mais fugiram da média (deltaMes = R$/mês);',
    'pontoEquilibrio.folgaPct = quanto a receita média mensal ficou acima(+)/abaixo(−) do necessário para empatar.',
    'Tom: direto e prático, de consultor para o dono da clínica. Português do Brasil.',
    'NUNCA use siglas financeiras (PE, MC, ROI, YoY, AV etc.) — escreva por extenso e, ao usar um termo financeiro,',
    'explique em poucas palavras o que ele significa (ex.: "ponto de equilíbrio — a receita mínima para não ter prejuízo").',
    'Responda em JSON: { "resumo": string (3-5 frases, a leitura geral: o período foi bom/ruim e por quê),',
    '"pontos": [2-5 strings curtas, cada uma começando com "✅ ", "⚠️ " ou "🔴 " — destaques e alertas],',
    '"recomendacoes": [1-4 strings curtas, ações práticas e específicas] }',
    '',
    'FATOS:',
    JSON.stringify(fatos),
  ].join('\n');
  const responseSchema = {
    type: 'object',
    properties: {
      resumo: { type: 'string' },
      pontos: { type: 'array', items: { type: 'string' } },
      recomendacoes: { type: 'array', items: { type: 'string' } },
    },
    required: ['resumo', 'pontos', 'recomendacoes'],
  };
  return callWithRetry(prompt, AVALIACAO_DRE_SCHEMA, responseSchema);
}

const PERGUNTA_DRE_SCHEMA = z.object({ resposta: z.string().min(10) });

// Pergunta livre do usuário sobre a DRE do período — responde com os dados
// fornecidos (fatos + todas as contas com média mensal vs contexto).
async function perguntarDRE({ fatos, contas, pergunta }) {
  const prompt = [
    'Você é um consultor financeiro experiente de clínicas odontológicas no Brasil.',
    'O dono da clínica fez uma pergunta sobre a DRE do período. Responda usando EXCLUSIVAMENTE os dados abaixo.',
    'NUNCA invente ou recalcule números — cite apenas valores presentes nos dados, em R$ ou %.',
    'Se os dados não bastarem para responder, diga exatamente o que falta (ex.: "precisa abrir os lançamentos da conta X").',
    'Se a pergunta não for sobre finanças da clínica, diga educadamente que só avalia a DRE.',
    'DADOS: "fatos" = resumo do período (contexto = média dos meses anteriores; anoAnterior = mesmos meses do ano passado).',
    '"contas" = cada conta da DRE com mediaMesPeriodo vs mediaMesContexto e deltaPct (variação do valor absoluto).',
    'Valores de saída são negativos; ao falar de gasto, use o valor absoluto.',
    'Tom: direto e prático. Português do Brasil. 3 a 8 frases; pode usar travessões ou bullets no texto.',
    'NUNCA use siglas financeiras (PE, MC, ROI etc.) — escreva por extenso e explique termos financeiros em poucas palavras.',
    'Responda em JSON: { "resposta": string }',
    '',
    'FATOS:', JSON.stringify(fatos),
    'CONTAS:', JSON.stringify(contas),
    'PERGUNTA DO DONO:', String(pergunta).slice(0, 300),
  ].join('\n');
  const responseSchema = {
    type: 'object',
    properties: { resposta: { type: 'string' } },
    required: ['resposta'],
  };
  return callWithRetry(prompt, PERGUNTA_DRE_SCHEMA, responseSchema);
}

// ===== Social Media (Agente de Social Media — Fase 3) =====
const PAUTA_SOCIAL_SCHEMA = z.object({
  sugestoes: z.array(z.object({
    perfil: z.string(), tema: z.string(), formato: z.string(),
    titulo: z.string().min(3).max(120), gancho: z.string().min(10).max(500),
    dia_sugerido: z.string(), justificativa: z.string().min(10).max(500),
  })).min(3).max(5),
  observacoes_cobertura: z.string().max(600),
});

async function sugerirPautaSocial({ fatos, hoje }) {
  const prompt = [
    'Você é um estrategista de social media especializado em clínicas odontológicas no Brasil (funil TOF/MOF/BOF).',
    'Sugira a pauta de conteúdo dos PRÓXIMOS DIAS para o perfil de Instagram descrito nos fatos abaixo (JSON).',
    'Baseie CADA sugestão EXCLUSIVAMENTE nos números dos fatos e cite-os na justificativa. NUNCA invente ou recalcule números.',
    'O bloco "cobertura" lista o que está magro nos dados: resuma essas limitações em observacoes_cobertura e',
    'NUNCA infira tendência temporal (crescimento/queda) com menos de 28 dias de série — os fatos dizem quantos dias há.',
    'O bloco "radar_referencia" traz posts de perfis de referência do nicho (dados públicos): quando fizer sentido, use como inspiração citando o @.',
    'Respeite o público do campo "perfil" e a ancoragem local (campo "cidade") — conteúdo com cara de "clínica daqui".',
    'Regras de conteúdo odontológico: nunca prometer resultado clínico garantido; prova social e explicação de mecanismo funcionam melhor.',
    `Datas: hoje é ${hoje}; dia_sugerido deve estar entre amanhã e 10 dias à frente (formato AAAA-MM-DD).`,
    'Campos de cada sugestão: perfil (repetir a chave do perfil analisado), tema (um de: depoimento, educativo, oferta, bastidor, institucional),',
    'formato (um de: reel, carrossel, foto), titulo (curto — vira o título do card no calendário), gancho (a ideia do conteúdo em 1-3 frases:',
    'o que mostrar e falar), dia_sugerido, justificativa (o número dos fatos que sustenta a escolha).',
    'Responda em JSON: { "sugestoes": [3 a 5 itens], "observacoes_cobertura": string (1-2 frases) }',
    'Português do Brasil, tom direto e prático.',
    '',
    'FATOS:',
    JSON.stringify(fatos),
  ].join('\n');
  const responseSchema = {
    type: 'object',
    properties: {
      sugestoes: { type: 'array', items: { type: 'object', properties: {
        perfil: { type: 'string' }, tema: { type: 'string' }, formato: { type: 'string' },
        titulo: { type: 'string' }, gancho: { type: 'string' }, dia_sugerido: { type: 'string' }, justificativa: { type: 'string' },
      }, required: ['perfil', 'tema', 'formato', 'titulo', 'gancho', 'dia_sugerido', 'justificativa'] } },
      observacoes_cobertura: { type: 'string' },
    },
    required: ['sugestoes', 'observacoes_cobertura'],
  };
  return callWithRetry(prompt, PAUTA_SOCIAL_SCHEMA, responseSchema);
}

const ANALISE_SOCIAL_SCHEMA = z.object({
  resumo: z.string().min(20),
  pontos: z.array(z.string()).min(2).max(5),
  acoes: z.array(z.string()).min(1).max(3),
  limitacoes: z.string(),
});

async function analisarSocialMedia({ fatos }) {
  const prompt = [
    'Você é um consultor de marketing digital experiente de clínicas odontológicas no Brasil.',
    'Faça a leitura CRUZADA do mês com base EXCLUSIVAMENTE nos fatos abaixo (JSON): conteúdo orgânico do Instagram,',
    'tráfego pago (gasto/leads/faturamento) e funil de leads. O ouro está no cruzamento: o que o orgânico ensina pro pago e vice-versa',
    '(ex.: tema que rende nos dois; perfil que cresce mas não vira lead; anúncio bom vindo de conteúdo que já bombou).',
    'NUNCA invente ou recalcule números — cite apenas valores presentes nos fatos, em R$ (milhar com ponto) ou %.',
    'O bloco "cobertura" lista limitações dos dados: preencha "limitacoes" com elas e NUNCA infira tendência com menos de 28 dias de série.',
    'NUNCA use siglas financeiras ou de marketing (ROI, CPL, CTR etc.) — escreva por extenso e explique termos em poucas palavras.',
    'Tom: direto e prático, de consultor para o dono da clínica. Português do Brasil.',
    'Responda em JSON: { "resumo": string (3-5 frases — o mês foi bom/ruim e por quê),',
    '"pontos": [2-5 strings curtas começando com "✅ ", "⚠️ " ou "🔴 "],',
    '"acoes": [1-3 strings — ações práticas e específicas pra semana que vem],',
    '"limitacoes": string (o que os dados ainda não permitem afirmar) }',
    '',
    'FATOS:',
    JSON.stringify(fatos),
  ].join('\n');
  const responseSchema = {
    type: 'object',
    properties: {
      resumo: { type: 'string' },
      pontos: { type: 'array', items: { type: 'string' } },
      acoes: { type: 'array', items: { type: 'string' } },
      limitacoes: { type: 'string' },
    },
    required: ['resumo', 'pontos', 'acoes', 'limitacoes'],
  };
  return callWithRetry(prompt, ANALISE_SOCIAL_SCHEMA, responseSchema);
}

const PERGUNTA_SOCIAL_SCHEMA = z.object({ resposta: z.string().min(10) });

async function perguntarSocialMedia({ fatos, pergunta }) {
  const prompt = [
    'Você é um consultor de marketing digital de clínicas odontológicas no Brasil.',
    'O dono da clínica fez uma pergunta sobre o desempenho do social media do mês. Responda usando EXCLUSIVAMENTE os fatos abaixo.',
    'NUNCA invente ou recalcule números. Se os fatos não bastarem para responder, diga exatamente o que falta.',
    'Se a pergunta não for sobre o marketing/conteúdo da clínica, diga educadamente que só analisa esses dados.',
    'NUNCA use siglas financeiras ou de marketing — escreva por extenso e explique termos em poucas palavras.',
    'Tom: direto e prático. Português do Brasil. 3 a 8 frases.',
    'Responda em JSON: { "resposta": string }',
    '',
    'FATOS:', JSON.stringify(fatos),
    'PERGUNTA DO DONO:', String(pergunta).slice(0, 300),
  ].join('\n');
  const responseSchema = { type: 'object', properties: { resposta: { type: 'string' } }, required: ['resposta'] };
  return callWithRetry(prompt, PERGUNTA_SOCIAL_SCHEMA, responseSchema);
}

// ===== Protético (Financeiro → Laboratórios) =====
const NOTA_PROTETICO_SCHEMA = z.object({
  laboratorio_sugerido: z.string().max(80),
  referencia: z.string().max(120),
  emitida_em: z.string().nullable(),
  total_informado: z.number().nullable(),
  itens: z.array(z.object({
    paciente: z.string(),
    dentista: z.string().nullable(),
    descricao: z.string(),
    dente: z.string().nullable(),
    quantidade: z.number().int().positive().default(1),
    valor_total: z.number(),
    data_entrada: z.string().nullable(),
    data_prevista: z.string().nullable(),
    data_entrega: z.string().nullable(),
    incerto: z.boolean().default(false),
  })).max(300),
});

// Extrai as linhas de uma cobrança de laboratório de prótese (PDF de sistema, nota avulsa,
// planilha ou caderno manuscrito fotografado). NÃO grava nada — o resultado vai para a tela
// de conferência humana antes de salvar.
async function extrairNotaProtetico({ fileBuffer, mimeType }) {
  const base64File = fileBuffer.toString('base64');
  const prompt = `Você lê cobranças de laboratórios de prótese dentária enviadas a uma clínica odontológica no Brasil.
O documento pode ser: relatório de sistema ("Pedidos Finalizados"), nota de serviços, planilha mensal ou página de caderno MANUSCRITO fotografada.
Extraia TODAS as linhas de serviço cobradas. NUNCA invente linha, valor ou data — o que não estiver legível marque com incerto=true.
Regras:
- datas em YYYY-MM-DD (dia/mês no formato brasileiro DD/MM/YYYY; assuma o ano do próprio documento quando a linha omitir);
- valores como número (ex.: "1.234,56" vira 1234.56); linha sem valor legível: valor_total 0 e incerto=true;
- quantidade: número no começo da descrição ("02 coroas e-max" = quantidade 2, descricao "coroas e-max"); sem número = 1;
- se a linha tiver quantidade e o valor impresso for unitário, valor_total = quantidade × unitário (relatórios "Pedidos Finalizados" já mostram o total da linha — use o impresso);
- dentista: campo "Dentista:" ou "Conv:" da linha/bloco; cabeçalho do documento pode indicar um dentista único; sem indicação = null;
- dente: número(s) de dente quando presentes ("D: 45", "Dente: 24/25/26"), como texto; senão null;
- laboratorio_sugerido: nome do laboratório emissor (cabeçalho/logotipo);
- referencia: número da nota ("Nota 686") ou descrição curta do documento ("Pedidos Finalizados 01/01–31/07/2026", "Caderno 06/01/2026");
- emitida_em: data de emissão do documento (YYYY-MM-DD) ou null;
- total_informado: total impresso no documento ou null. NÃO recalcule.
Responda APENAS o JSON no formato combinado.`;

  const responseSchema = {
    type: 'object',
    properties: {
      laboratorio_sugerido: { type: 'string' },
      referencia: { type: 'string' },
      emitida_em: { type: 'string', nullable: true },
      total_informado: { type: 'number', nullable: true },
      itens: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            paciente: { type: 'string' },
            dentista: { type: 'string', nullable: true },
            descricao: { type: 'string' },
            dente: { type: 'string', nullable: true },
            quantidade: { type: 'integer' },
            valor_total: { type: 'number' },
            data_entrada: { type: 'string', nullable: true },
            data_prevista: { type: 'string', nullable: true },
            data_entrega: { type: 'string', nullable: true },
            incerto: { type: 'boolean' },
          },
          required: ['paciente', 'descricao', 'valor_total'],
        },
      },
    },
    required: ['laboratorio_sugerido', 'referencia', 'itens'],
  };

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const withSchema = attempt === 0;
    const body = {
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: base64File } },
          { text: prompt },
        ],
      }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        ...(withSchema ? { responseSchema } : {}),
      },
    };
    try {
      const { status, body: raw } = await httpsPost(geminiUrl(), body, 120000);
      if (status === 429) {
        let msg = 'Créditos do Gemini esgotados.';
        try { msg = JSON.parse(raw)?.error?.message || msg; } catch (_) {}
        const e = new Error(`Gemini: ${msg}`); e.status = 503; throw e;
      }
      if (status === 400 && withSchema) { lastErr = new Error(`Gemini 400 com schema: ${raw.slice(0, 200)}`); continue; }
      if (status !== 200) { lastErr = new Error(`Gemini ${status}: ${raw.slice(0, 200)}`); continue; }
      const geminiJson = JSON.parse(raw);
      const text = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) { lastErr = new Error('Gemini: resposta vazia'); continue; }
      const parsed = JSON.parse(text);
      const result = NOTA_PROTETICO_SCHEMA.safeParse(parsed);
      if (!result.success) {
        lastErr = new Error(`Zod: ${JSON.stringify(result.error.issues.slice(0, 3))}`);
        continue;
      }
      const usage = geminiJson?.usageMetadata ?? {};
      return { data: result.data, tokensIn: usage.promptTokenCount ?? 0, tokensOut: usage.candidatesTokenCount ?? 0 };
    } catch (e) {
      if (e.status === 503) throw e;
      lastErr = e;
    }
  }
  const err = new Error(`Não consegui ler a nota: ${lastErr?.message}`);
  err.status = 502;
  throw err;
}

module.exports = { analyzeTranscript, detalharEtapa, gerarInsights, gerarBenchmark, analyzeLigacao, transcreverAudio, avaliarDRE, perguntarDRE, sugerirPautaSocial, analisarSocialMedia, perguntarSocialMedia, extrairNotaProtetico };
