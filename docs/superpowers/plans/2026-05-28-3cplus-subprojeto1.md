# 3cplus Sub-projeto 1 — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrar o 3cplus ao CRM — click-to-call no painel do lead, gravação automática, análise de áudio com Gemini, visão gerencial de chamadas, painel de custo e migração do módulo Avaliação Dentista de Deepgram para Gemini.

**Architecture:** Monolito Express em `server.js`. Novo módulo `lib/3cplus.js` (padrão `totalvoice.js`). Gemini analisa áudio via inline base64 em uma única chamada. Cron de retry via `setInterval` em-processo (1h). Frontend vanilla JS nos arquivos HTML existentes + nova `public/ligacoes.html`.

**Tech Stack:** Node.js 18+, Express, Supabase (PostgreSQL), Gemini API (via `lib/gemini.js`), 3cplus API (click-to-call + webhook)

> ⚠️ **Pendências antes de implementar:**
> - Pedir ao usuário o `THREEC_WEBHOOK_TOKEN` (segredo para validar chamadas do 3cplus)
> - Confirmar os nomes reais dos campos no payload do webhook 3cplus (o plano usa nomes assumidos: `threec_call_id`, `agent_id`, `status`, `duracao_segundos`, `gravacao_url`)
> - Confirmar endpoint e autenticação da API 3cplus para click-to-call (o plano usa estrutura baseada no padrão da plataforma)

---

## Mapa de arquivos

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `supabase/migrations/20260528000000_3cplus_ligacoes.sql` | Criar | Tabelas ligacoes, ia_config, ia_uso_log + campo threec_agent_id |
| `lib/3cplus.js` | Criar | Cliente da API 3cplus (ligar, verificar token) |
| `lib/gemini.js` | Modificar | Adicionar `analyzeLigacao()` — transcrição + análise de áudio |
| `server.js` | Modificar | Todas as novas rotas (ligar, webhook, analisar, cron, gerencial, ia-config) |
| `public/index.html` | Modificar | Substituir UI de chamadas TotalVoice pela UI 3cplus + modal detalhes |
| `public/ligacoes.html` | Criar | Tela gerencial (Seção 5.5) + painel de custo (Seção 6) |

---

## Task 1: Migration SQL

**Files:**
- Create: `supabase/migrations/20260528000000_3cplus_ligacoes.sql`

- [ ] **Step 1: Criar o arquivo de migration**

```sql
-- 20260528000000_3cplus_ligacoes.sql
-- 3cplus Sub-projeto 1: ligacoes, ia_config, ia_uso_log, profiles.threec_agent_id

-- ROLLBACK:
-- DROP TABLE IF EXISTS ia_uso_log;
-- DROP TABLE IF EXISTS ia_config;
-- DROP TABLE IF EXISTS ligacoes;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS threec_agent_id;

-- ── 1. CAMPO threec_agent_id em profiles ────────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS threec_agent_id text;

-- ── 2. TABELA ligacoes ───────────────────────────────────────────────────────
CREATE TABLE ligacoes (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             uuid        REFERENCES leads(id) ON DELETE SET NULL,
  usuario_id          uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  threec_call_id      text        UNIQUE,
  status              text        NOT NULL DEFAULT 'iniciada',
  -- status: iniciada | atendida | nao_atendida | ocupado | falha_gravacao
  duracao_segundos    integer,
  gravacao_url        text,
  tentativas_gravacao integer     NOT NULL DEFAULT 0,
  transcricao         text,
  analise_ia          jsonb,
  -- analise_ia: { resumo, pontos_fortes[], pontos_melhora[], score }
  modulo              text        NOT NULL DEFAULT 'leads',
  -- modulo: leads | agendamentos | avaliacao_dentista
  criada_em           timestamptz NOT NULL DEFAULT now(),
  analisada_em        timestamptz
);

CREATE INDEX idx_ligacoes_lead_id   ON ligacoes (lead_id);
CREATE INDEX idx_ligacoes_usuario_id ON ligacoes (usuario_id);
CREATE INDEX idx_ligacoes_criada_em ON ligacoes (criada_em DESC);
CREATE INDEX idx_ligacoes_modulo    ON ligacoes (modulo);

-- RLS: service_role tem acesso total via bypass; anon não acessa
ALTER TABLE ligacoes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role bypass" ON ligacoes USING (true) WITH CHECK (true);

-- ── 3. TABELA ia_config ──────────────────────────────────────────────────────
CREATE TABLE ia_config (
  modulo              text    PRIMARY KEY,
  -- modulo: leads | agendamentos | avaliacao_dentista
  auto_analise_ativo  boolean NOT NULL DEFAULT true,
  min_duracao_s       integer NOT NULL DEFAULT 60,
  limite_diario       integer NOT NULL DEFAULT 50,
  limite_semanal      integer NOT NULL DEFAULT 200
);

ALTER TABLE ia_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role bypass" ON ia_config USING (true) WITH CHECK (true);

-- Seeds
INSERT INTO ia_config (modulo) VALUES
  ('leads'),
  ('agendamentos'),
  ('avaliacao_dentista')
ON CONFLICT (modulo) DO NOTHING;

-- ── 4. TABELA ia_uso_log ─────────────────────────────────────────────────────
CREATE TABLE ia_uso_log (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  modulo           text        NOT NULL,
  duracao_audio_s  integer,
  tokens_entrada   integer,
  tokens_saida     integer,
  custo_estimado   numeric(10,4),
  criado_em        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ia_uso_log_criado_em ON ia_uso_log (criado_em DESC);
CREATE INDEX idx_ia_uso_log_modulo    ON ia_uso_log (modulo);

ALTER TABLE ia_uso_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role bypass" ON ia_uso_log USING (true) WITH CHECK (true);
```

- [ ] **Step 2: Aplicar a migration via Supabase Dashboard**

Copiar o conteúdo do arquivo e colar no **SQL Editor** do Supabase Dashboard (Project ID: `mtqdpjhhqzvuklnlfpvi`). Executar. Em seguida verificar com MCP Supabase `list_migrations` ou na aba Table Editor.

Verificar no Dashboard → Table Editor que as tabelas `ligacoes`, `ia_config`, `ia_uso_log` existem e `profiles` tem coluna `threec_agent_id`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260528000000_3cplus_ligacoes.sql
git commit -m "feat: migration ligacoes + ia_config + ia_uso_log + profiles.threec_agent_id"
```

---

## Task 2: lib/3cplus.js — Cliente da API 3cplus

**Files:**
- Create: `lib/3cplus.js`

> ⚠️ Os endpoints e campos da API 3cplus abaixo são baseados na estrutura típica da plataforma. Confirmar com a documentação real antes de implementar. A URL base pode ser `https://api.3cplus.com.br` ou similar.

- [ ] **Step 1: Criar lib/3cplus.js**

```js
'use strict';
const https = require('https');

const THREEC_TOKEN = () => process.env.THREEC_TOKEN || '';
const THREEC_BASE  = () => process.env.THREEC_BASE_URL || 'https://api.3cplus.com.br';

function temToken() {
  return Boolean(THREEC_TOKEN());
}

function httpsRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const url = new URL(path, THREEC_BASE());
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${THREEC_TOKEN()}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: 15000,
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('3cplus timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Click-to-call: cria uma chamada. A plataforma liga para o agente primeiro,
// depois conecta com o destino.
// ⚠️ Confirmar endpoint e campos reais na doc da API 3cplus.
async function ligar({ agentId, numeroDestino }) {
  if (!temToken()) throw new Error('3cplus não configurado — preencha THREEC_TOKEN no .env');

  const { status, body } = await httpsRequest('POST', '/v1/call', {
    agent_id: agentId,
    destination: numeroDestino.replace(/\D/g, ''),
  });

  if (status !== 200 && status !== 201) {
    const err = new Error(`3cplus erro ${status}: ${body.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }

  const data = JSON.parse(body);
  // ⚠️ Confirmar nome do campo call_id na resposta real
  if (!data.call_id && !data.id) throw new Error('3cplus: resposta sem call_id');
  return { callId: data.call_id || data.id, ...data };
}

// Baixa o buffer de áudio de uma URL de gravação
async function downloadGravacao(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : require('http');
    mod.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        // Seguir redirect manual
        return downloadGravacao(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Download gravação falhou: ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'audio/mpeg' }));
      res.on('error', reject);
    }).on('timeout', () => reject(new Error('Download gravação timeout'))).on('error', reject);
  });
}

module.exports = { ligar, downloadGravacao, temToken };
```

- [ ] **Step 2: Adicionar variáveis de ambiente no .env e Easypanel**

No `.env` local (para desenvolvimento):
```
THREEC_TOKEN=seu_token_aqui
THREEC_BASE_URL=https://api.3cplus.com.br
THREEC_WEBHOOK_TOKEN=segredo_para_validar_webhook
```

No Easypanel: adicionar as mesmas 3 variáveis em Environment.

- [ ] **Step 3: Commit**

```bash
git add lib/3cplus.js
git commit -m "feat: lib/3cplus.js — cliente API click-to-call e download de gravação"
```

---

## Task 3: lib/gemini.js — Adicionar analyzeLigacao()

**Files:**
- Modify: `lib/gemini.js`

A função recebe um buffer de áudio e retorna transcrição + análise em uma única chamada. Usa o mesmo padrão de `callWithRetry` existente mas com inline audio data.

- [ ] **Step 1: Adicionar schema Zod para análise de ligação**

Após a linha `const BenchmarkSchema = ...` (por volta da linha 30 de `lib/gemini.js`), adicionar:

```js
const LigacaoAnaliseSchema = z.object({
  transcricao: z.string(),
  resumo: z.string().max(1000),
  pontos_fortes: z.array(z.string()).max(10),
  pontos_melhora: z.array(z.string()).max(10),
  score: z.number().min(0).max(10),
});
```

- [ ] **Step 2: Adicionar função analyzeLigacao() antes do module.exports**

Antes da linha `module.exports = { ... }` no final de `lib/gemini.js`:

```js
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
      lastErr = e;
    }
  }
  const err = new Error(`analyzeLigacao falhou: ${lastErr?.message}`);
  err.status = 502;
  throw err;
}
```

- [ ] **Step 3: Exportar analyzeLigacao no module.exports**

Atualizar a última linha de `lib/gemini.js`:

```js
module.exports = { analyzeTranscript, detalharEtapa, gerarInsights, gerarBenchmark, analyzeLigacao };
```

- [ ] **Step 4: Verificar que a função é válida sintaticamente**

```bash
node -e "require('./lib/gemini.js'); console.log('OK')"
```

Esperado: `OK`

- [ ] **Step 5: Commit**

```bash
git add lib/gemini.js
git commit -m "feat: gemini.js — analyzeLigacao() para transcrição+análise de chamadas"
```

---

## Task 4: server.js — Click-to-call + GET ligações por lead

**Files:**
- Modify: `server.js`

Substituir a rota `POST /api/leads/:id/ligar` existente (TotalVoice, linha ~475) pela versão 3cplus. Adicionar `GET /api/leads/:id/ligacoes`.

- [ ] **Step 1: Adicionar require do 3cplus no topo de server.js**

Após a linha `const whatsapp = require('./whatsapp');`:

```js
const threec = require('./lib/3cplus');
```

- [ ] **Step 2: Adicionar middleware requireCrcLead**

Após `const requireGestor = requireRole('gestor', 'admin');`:

```js
const requireCrcLead = requireRole('crc_leads', 'crc_comercial', 'admin', 'gestor');
```

- [ ] **Step 3: Substituir a rota POST /api/leads/:id/ligar**

Localizar o bloco da rota `app.post('/api/leads/:id/ligar', ...)` (linha ~475) e substituir inteiro:

```js
app.post('/api/leads/:id/ligar', requireAuth, requireCrcLead, rateLimit, async (req, res) => {
  try {
    const leadId = req.params.id;
    if (!UUID_V4_RE.test(leadId)) return res.status(400).json({ error: 'ID inválido' });

    const p = await loadProfile(req);
    if (!p.threec_agent_id) {
      return res.status(400).json({ error: 'Configure seu ID de agente do 3cplus em Configurações → Perfil antes de ligar.' });
    }

    const { data: lead } = await supabase.from('leads').select('id, nome, telefone').eq('id', leadId).maybeSingle();
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (!lead.telefone) return res.status(400).json({ error: 'Lead sem telefone cadastrado' });

    if (!threec.temToken()) return res.status(503).json({ error: '3cplus não configurado no servidor' });

    const { callId } = await threec.ligar({ agentId: p.threec_agent_id, numeroDestino: lead.telefone });

    const { data: ligacao, error: lErr } = await supabase.from('ligacoes').insert({
      lead_id: leadId,
      usuario_id: req.user.id,
      threec_call_id: callId,
      status: 'iniciada',
      modulo: 'leads',
    }).select().single();
    if (lErr) throw lErr;

    res.json({ ok: true, ligacao });
  } catch (e) {
    console.error('❌ 3cplus ligar:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});
```

- [ ] **Step 4: Adicionar GET /api/leads/:id/ligacoes logo após a rota de ligar**

```js
app.get('/api/leads/:id/ligacoes', requireAuth, rateLimit, async (req, res) => {
  try {
    const leadId = req.params.id;
    if (!UUID_V4_RE.test(leadId)) return res.status(400).json({ error: 'ID inválido' });
    const { data, error } = await supabase.from('ligacoes')
      .select('id, threec_call_id, status, duracao_segundos, gravacao_url, transcricao, analise_ia, tentativas_gravacao, criada_em, analisada_em')
      .eq('lead_id', leadId)
      .order('criada_em', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 5: Adicionar GET/PATCH /api/me/threec-agent-id para a CRC configurar o próprio ID**

Logo após o bloco `GET /api/me`:

```js
app.patch('/api/me/threec-agent-id', requireAuth, async (req, res) => {
  try {
    const { threec_agent_id } = req.body;
    if (typeof threec_agent_id !== 'string') return res.status(400).json({ error: 'threec_agent_id deve ser string' });
    const val = threec_agent_id.trim().slice(0, 100);
    const { error } = await supabase.from('profiles').update({ threec_agent_id: val || null }).eq('id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 6: Verificar sintaxe do server.js**

```bash
node --check server.js && echo "OK"
```

Esperado: `OK`

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat: click-to-call 3cplus — POST /api/leads/:id/ligar + GET ligacoes + PATCH threec-agent-id"
```

---

## Task 5: server.js — Webhook + processarGravacao

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Adicionar helper para buscar ia_config**

Antes das rotas de webhook, adicionar a função (pode ser colocada próximo de `getConfigVal`):

```js
async function getIaConfig(modulo) {
  const { data } = await supabase.from('ia_config').select('*').eq('modulo', modulo).maybeSingle();
  return data || { auto_analise_ativo: false, min_duracao_s: 60, limite_diario: 50, limite_semanal: 200 };
}

async function contarAnalisesHoje(modulo) {
  const hoje = new Date().toISOString().slice(0, 10);
  const { count } = await supabase.from('ia_uso_log')
    .select('*', { count: 'exact', head: true })
    .eq('modulo', modulo)
    .gte('criado_em', hoje + 'T00:00:00Z');
  return count || 0;
}

async function contarAnalisesSemana(modulo) {
  const seteDias = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const { count } = await supabase.from('ia_uso_log')
    .select('*', { count: 'exact', head: true })
    .eq('modulo', modulo)
    .gte('criado_em', seteDias);
  return count || 0;
}
```

- [ ] **Step 2: Adicionar função processarGravacao**

Após os helpers acima:

```js
async function processarGravacao(ligacao) {
  try {
    const config = await getIaConfig(ligacao.modulo);

    // Verificar elegibilidade para análise automática
    const elegivel = (
      ligacao.status === 'atendida' &&
      (ligacao.duracao_segundos || 0) >= config.min_duracao_s &&
      config.auto_analise_ativo &&
      (await contarAnalisesHoje(ligacao.modulo)) < config.limite_diario &&
      (await contarAnalisesSemana(ligacao.modulo)) < config.limite_semanal
    );

    if (!elegivel) return; // Ligação registrada, análise não automática

    // Tentar baixar a gravação
    let audioBuffer, contentType;
    try {
      ({ buffer: audioBuffer, contentType } = await threec.downloadGravacao(ligacao.gravacao_url));
    } catch (downloadErr) {
      console.warn(`⚠️ Download gravação falhou (tentativa ${ligacao.tentativas_gravacao + 1}):`, downloadErr.message);
      await supabase.from('ligacoes').update({
        tentativas_gravacao: (ligacao.tentativas_gravacao || 0) + 1,
        ...(ligacao.tentativas_gravacao >= 2 ? { status: 'falha_gravacao' } : {}),
      }).eq('id', ligacao.id);
      return;
    }

    // Analisar com Gemini
    const duracao = ligacao.duracao_segundos || 0;
    const { data: analise, tokensIn, tokensOut } = await geminiLib().analyzeLigacao({
      audioBuffer, contentType, modulo: ligacao.modulo,
    });

    const custoMin = parseFloat(process.env.GEMINI_COST_PER_MIN || '0.016');
    const custoEstimado = parseFloat(((duracao / 60) * custoMin).toFixed(4));

    await Promise.all([
      supabase.from('ligacoes').update({
        transcricao: analise.transcricao,
        analise_ia: { resumo: analise.resumo, pontos_fortes: analise.pontos_fortes, pontos_melhora: analise.pontos_melhora, score: analise.score },
        analisada_em: new Date().toISOString(),
        tentativas_gravacao: (ligacao.tentativas_gravacao || 0) + 1,
      }).eq('id', ligacao.id),
      supabase.from('ia_uso_log').insert({
        modulo: ligacao.modulo,
        duracao_audio_s: duracao,
        tokens_entrada: tokensIn,
        tokens_saida: tokensOut,
        custo_estimado: custoEstimado,
      }),
    ]);

    console.log(`✅ Ligação ${ligacao.id} analisada — score ${analise.score}`);
  } catch (e) {
    console.error('❌ processarGravacao:', ligacao.id, e.message);
  }
}
```

- [ ] **Step 3: Adicionar rota POST /api/webhooks/3cplus**

Após o bloco `app.post('/webhooks/totalvoice', ...)`:

```js
// ========== 3CPLUS WEBHOOK ==========
app.post('/api/webhooks/3cplus', async (req, res) => {
  try {
    const token = req.headers['x-webhook-token'] || '';
    const expected = process.env.THREEC_WEBHOOK_TOKEN || '';
    if (!expected || token !== expected) return res.status(401).send('unauthorized');

    // ⚠️ Confirmar nomes reais dos campos com documentação 3cplus
    const {
      threec_call_id,  // ID único da chamada no 3cplus
      agent_id,        // ID do agente (não usado no lookup — já temos no registro)
      status,          // atendida | nao_atendida | ocupado
      duracao_segundos,
      gravacao_url,
    } = req.body;

    if (!threec_call_id) return res.status(400).send('threec_call_id obrigatório');

    const statusMap = {
      atendida: 'atendida', answered: 'atendida',
      nao_atendida: 'nao_atendida', 'no-answer': 'nao_atendida',
      ocupado: 'ocupado', busy: 'ocupado',
    };
    const statusNormalizado = statusMap[status] || 'nao_atendida';

    const { data: ligacao, error } = await supabase.from('ligacoes')
      .select('*')
      .eq('threec_call_id', threec_call_id)
      .maybeSingle();

    if (error || !ligacao) {
      console.warn('⚠️ webhook 3cplus: ligação não encontrada para call_id', threec_call_id);
      return res.status(200).send('ok'); // 200 para evitar reenvio
    }

    const patch = {
      status: statusNormalizado,
      duracao_segundos: Number.isFinite(parseInt(duracao_segundos, 10)) ? parseInt(duracao_segundos, 10) : null,
      gravacao_url: gravacao_url || null,
    };

    await supabase.from('ligacoes').update(patch).eq('id', ligacao.id);

    // Fire-and-forget: não bloqueia a resposta ao 3cplus
    if (gravacao_url && statusNormalizado === 'atendida') {
      processarGravacao({ ...ligacao, ...patch }).catch(() => {});
    }

    res.status(200).send('ok');
  } catch (e) {
    console.error('❌ webhook 3cplus:', e.message);
    res.status(500).send('erro');
  }
});
```

- [ ] **Step 4: Verificar sintaxe**

```bash
node --check server.js && echo "OK"
```

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: webhook 3cplus + processarGravacao com análise Gemini automática"
```

---

## Task 6: server.js — Análise manual + Cron de retry

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Adicionar POST /api/ligacoes/:id/analisar**

Após o bloco do webhook 3cplus:

```js
app.post('/api/ligacoes/:id/analisar', requireAuth, rateLimit, async (req, res) => {
  try {
    const ligacaoId = req.params.id;
    if (!UUID_V4_RE.test(ligacaoId)) return res.status(400).json({ error: 'ID inválido' });

    const { data: ligacao } = await supabase.from('ligacoes')
      .select('*').eq('id', ligacaoId).maybeSingle();
    if (!ligacao) return res.status(404).json({ error: 'Ligação não encontrada' });
    if (ligacao.status !== 'atendida') return res.status(400).json({ error: 'Apenas chamadas atendidas podem ser analisadas' });
    if (!ligacao.gravacao_url) return res.status(400).json({ error: 'Gravação não disponível' });

    res.json({ ok: true, msg: 'Análise iniciada' });

    // Fire-and-forget com override de limites (manual)
    (async () => {
      try {
        const { buffer: audioBuffer, contentType } = await threec.downloadGravacao(ligacao.gravacao_url);
        const { data: analise, tokensIn, tokensOut } = await geminiLib().analyzeLigacao({
          audioBuffer, contentType, modulo: ligacao.modulo,
        });
        const custoMin = parseFloat(process.env.GEMINI_COST_PER_MIN || '0.016');
        const duracao = ligacao.duracao_segundos || 0;
        const custoEstimado = parseFloat(((duracao / 60) * custoMin).toFixed(4));
        await Promise.all([
          supabase.from('ligacoes').update({
            transcricao: analise.transcricao,
            analise_ia: { resumo: analise.resumo, pontos_fortes: analise.pontos_fortes, pontos_melhora: analise.pontos_melhora, score: analise.score },
            analisada_em: new Date().toISOString(),
          }).eq('id', ligacaoId),
          supabase.from('ia_uso_log').insert({
            modulo: ligacao.modulo, duracao_audio_s: duracao,
            tokens_entrada: tokensIn, tokens_saida: tokensOut, custo_estimado: custoEstimado,
          }),
        ]);
        console.log(`✅ Análise manual concluída: ${ligacaoId}`);
      } catch (e) {
        console.error('❌ análise manual:', ligacaoId, e.message);
      }
    })();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Adicionar cron de retry (setInterval 1h) ao final do server.js, antes do app.listen**

Localizar `app.listen(` e adicionar antes:

```js
// Cron 3cplus: reprocessa gravações com falha de download (tentativas > 0, < 3)
setInterval(async () => {
  try {
    const { data: pendentes } = await supabase.from('ligacoes')
      .select('*')
      .not('gravacao_url', 'is', null)
      .is('transcricao', null)
      .gt('tentativas_gravacao', 0)
      .lt('tentativas_gravacao', 3)
      .neq('status', 'falha_gravacao')
      .limit(10);
    if (!pendentes?.length) return;
    console.log(`🔄 Cron 3cplus: reprocessando ${pendentes.length} gravação(ões)`);
    for (const lig of pendentes) {
      await processarGravacao(lig).catch(() => {});
    }
  } catch (e) {
    console.error('❌ cron 3cplus retry:', e.message);
  }
}, 3600000); // 1 hora
```

- [ ] **Step 3: Verificar sintaxe**

```bash
node --check server.js && echo "OK"
```

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: análise manual de ligações + cron retry de gravações (1h)"
```

---

## Task 7: server.js — Listagem gerencial + ia-config + ia-uso-log

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Adicionar GET /api/ligacoes (listagem gerencial com filtros)**

```js
app.get('/api/ligacoes', requireAuth, requireGestor, rateLimit, async (req, res) => {
  try {
    const { desde, ate, usuario_id, modulo, status, score_min, score_max, origem, page = '1' } = req.query;
    const limit = 50;
    const offset = (Math.max(1, parseInt(page, 10)) - 1) * limit;

    let q = supabase.from('ligacoes')
      .select(`
        id, threec_call_id, status, duracao_segundos, modulo,
        criada_em, analisada_em, analise_ia,
        usuario_id, profiles!ligacoes_usuario_id_fkey(nome),
        lead_id, leads!ligacoes_lead_id_fkey(nome, origem)
      `, { count: 'exact' })
      .order('criada_em', { ascending: false })
      .range(offset, offset + limit - 1);

    if (desde) q = q.gte('criada_em', desde + 'T00:00:00Z');
    if (ate)   q = q.lte('criada_em', ate + 'T23:59:59Z');
    if (usuario_id && UUID_V4_RE.test(usuario_id)) q = q.eq('usuario_id', usuario_id);
    if (modulo)  q = q.eq('modulo', modulo);
    if (status)  q = q.eq('status', status);
    if (score_min) q = q.gte('analise_ia->>score', score_min);
    if (score_max) q = q.lte('analise_ia->>score', score_max);
    // Nota: filtro por origem é feito no cliente (JS) após o fetch — filtrar em join
    // de tabela relacionada no Supabase client exige RPC ou query raw, fora do escopo aqui

    const { data, error, count } = await q;
    if (error) throw error;
    res.json({ data: data || [], total: count || 0, page: parseInt(page, 10), limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Adicionar GET /api/ligacoes/stats (cards de resumo)**

```js
app.get('/api/ligacoes/stats', requireAuth, requireGestor, async (req, res) => {
  try {
    const { desde, ate, modulo, usuario_id } = req.query;
    let q = supabase.from('ligacoes').select('status, duracao_segundos, analise_ia');
    if (desde) q = q.gte('criada_em', desde + 'T00:00:00Z');
    if (ate)   q = q.lte('criada_em', ate + 'T23:59:59Z');
    if (modulo && modulo !== 'todos') q = q.eq('modulo', modulo);
    if (usuario_id && UUID_V4_RE.test(usuario_id)) q = q.eq('usuario_id', usuario_id);
    const { data } = await q;
    const rows = data || [];
    const total = rows.length;
    const atendidas = rows.filter(r => r.status === 'atendida').length;
    const taxaAtendimento = total ? Math.round((atendidas / total) * 100) : 0;
    const comDuracao = rows.filter(r => r.duracao_segundos > 0);
    const duracaoMedia = comDuracao.length
      ? Math.round(comDuracao.reduce((s, r) => s + r.duracao_segundos, 0) / comDuracao.length)
      : 0;
    const comScore = rows.filter(r => r.analise_ia?.score != null);
    const scoreMedia = comScore.length
      ? parseFloat((comScore.reduce((s, r) => s + r.analise_ia.score, 0) / comScore.length).toFixed(1))
      : null;
    res.json({ total, atendidas, taxa_atendimento: taxaAtendimento, duracao_media_s: duracaoMedia, score_medio: scoreMedia });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 3: Adicionar GET + PUT /api/ia-config**

```js
app.get('/api/ia-config', requireAuth, requireGestor, async (req, res) => {
  try {
    const { data, error } = await supabase.from('ia_config').select('*').order('modulo');
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/ia-config/:modulo', requireAuth, requireGestor, async (req, res) => {
  try {
    const { modulo } = req.params;
    if (!['leads', 'agendamentos', 'avaliacao_dentista'].includes(modulo))
      return res.status(400).json({ error: 'Módulo inválido' });
    const { auto_analise_ativo, min_duracao_s, limite_diario, limite_semanal } = req.body;
    const patch = {};
    if (typeof auto_analise_ativo === 'boolean') patch.auto_analise_ativo = auto_analise_ativo;
    if (Number.isFinite(min_duracao_s) && min_duracao_s >= 0) patch.min_duracao_s = min_duracao_s;
    if (Number.isFinite(limite_diario) && limite_diario > 0) patch.limite_diario = limite_diario;
    if (Number.isFinite(limite_semanal) && limite_semanal > 0) patch.limite_semanal = limite_semanal;
    const { error } = await supabase.from('ia_config').update(patch).eq('modulo', modulo);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 4: Adicionar GET /api/ia-uso-log (painel de custo)**

```js
app.get('/api/ia-uso-log', requireAuth, requireGestor, async (req, res) => {
  try {
    const diasAtras = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    const { data, error } = await supabase.from('ia_uso_log')
      .select('*')
      .gte('criado_em', diasAtras)
      .order('criado_em', { ascending: false })
      .limit(500);
    if (error) throw error;

    // Agregar por data+modulo para tabela
    const byDia = {};
    for (const row of (data || [])) {
      const dia = row.criado_em.slice(0, 10);
      const k = `${dia}|${row.modulo}`;
      if (!byDia[k]) byDia[k] = { data: dia, modulo: row.modulo, analises: 0, minutos: 0, custo: 0 };
      byDia[k].analises++;
      byDia[k].minutos += Math.ceil((row.duracao_audio_s || 0) / 60);
      byDia[k].custo += parseFloat(row.custo_estimado || 0);
    }

    // Cards do mês atual
    const inicioMes = new Date();
    inicioMes.setDate(1); inicioMes.setHours(0, 0, 0, 0);
    const mesRows = (data || []).filter(r => r.criado_em >= inicioMes.toISOString());
    const analisesMes = mesRows.length;
    const minutosMes = mesRows.reduce((s, r) => s + Math.ceil((r.duracao_audio_s || 0) / 60), 0);
    const custoMes = parseFloat(mesRows.reduce((s, r) => s + parseFloat(r.custo_estimado || 0), 0).toFixed(2));
    const diasDecorridos = new Date().getDate();
    const diasNoMes = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const projecao = diasDecorridos > 0 ? parseFloat(((custoMes / diasDecorridos) * diasNoMes).toFixed(2)) : 0;

    res.json({
      cards: { analises_mes: analisesMes, minutos_mes: minutosMes, custo_mes: custoMes, projecao_mes: projecao },
      tabela: Object.values(byDia).sort((a, b) => b.data.localeCompare(a.data)),
      custo_por_min: parseFloat(process.env.GEMINI_COST_PER_MIN || '0.016'),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 5: Verificar sintaxe**

```bash
node --check server.js && echo "OK"
```

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: GET /api/ligacoes + stats + ia-config + ia-uso-log"
```

---

## Task 8: public/index.html — UI click-to-call + histórico + modal detalhes

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Substituir conteúdo da tab chamadas**

Localizar `<div class="tab-content" id="tab-chamadas">` e substituir seu conteúdo:

```html
<div class="tab-content" id="tab-chamadas">
  <div id="ligacoes-lista"><div class="empty-small">Carregando...</div></div>
</div>
```

- [ ] **Step 2: Substituir botão Ligar no rodapé do modal**

Localizar `<button class="btn btn-call" id="btn-ligar" onclick="ligarLead()" ...>` e substituir:

```html
<button class="btn btn-call" id="btn-ligar" onclick="ligarLead3c()" style="display:none">📞 Ligar</button>
```

- [ ] **Step 3: Adicionar modal de detalhes da ligação**

Antes do fechamento `</body>`, adicionar:

```html
<!-- MODAL DETALHES LIGAÇÃO -->
<div class="modal-bg" id="modal-ligacao-bg" onclick="if(event.target===this)fecharModalLigacao()">
<div class="modal" style="max-width:600px">
  <div class="modal-header">
    <div class="modal-titulo" id="ml-titulo">Detalhes da chamada</div>
    <button class="modal-close" onclick="fecharModalLigacao()">×</button>
  </div>
  <div id="ml-body" style="padding:0 4px">
    <!-- preenchido via JS -->
  </div>
</div>
</div>
```

- [ ] **Step 4: Substituir função ligarLead() no JS**

Localizar `async function ligarLead()` no JS inline e substituir:

```js
async function ligarLead3c() {
  if (!leadAtual) return;
  try {
    toast('📞 Iniciando ligação...');
    const r = await api(`/api/leads/${leadAtual.id}/ligar`, { method: 'POST' });
    if (r.error) { toast('❌ ' + r.error, true); return; }
    toast('✅ Ligação iniciada! Aguarde o seu telefone tocar.');
    setTimeout(() => carregarLigacoes(leadAtual.id), 3000);
  } catch (e) {
    toast('❌ ' + e.message, true);
  }
}
```

- [ ] **Step 5: Substituir função carregarChamadas() por carregarLigacoes()**

Localizar a função `async function carregarChamadas(` e substituir:

```js
async function carregarLigacoes(leadId) {
  const div = document.getElementById('ligacoes-lista');
  try {
    const lista = await api(`/api/leads/${leadId}/ligacoes`);
    if (!lista.length) {
      div.innerHTML = '<div class="empty-small">Nenhuma chamada ainda.</div>';
      return;
    }
    div.innerHTML = lista.map(c => {
      const dt = c.criada_em ? new Date(c.criada_em).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—';
      const dur = c.duracao_segundos ? `${Math.floor(c.duracao_segundos/60)}min ${c.duracao_segundos%60}s` : '—';
      const statusLabel = { atendida:'✅ Atendida', nao_atendida:'📵 Não atendida', ocupado:'📴 Ocupado', iniciada:'⏳ Iniciada', falha_gravacao:'⚠️ Falha gravação' }[c.status] || c.status;
      const score = c.analise_ia?.score;
      const scoreBadge = score != null ? `<span style="margin-left:6px;padding:1px 6px;border-radius:8px;font-size:11px;font-weight:700;background:${score>=7?'#16a34a':score>=4?'#d97706':'#dc2626'};color:#fff">${score}</span>` : '';
      return `<div class="chamada-item" style="cursor:pointer" onclick="abrirModalLigacao(${JSON.stringify(JSON.stringify(c))})">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12.5px">${statusLabel}${scoreBadge}</span>
          <span style="color:var(--muted);font-size:11.5px">${dt} · ${dur} →</span>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    div.innerHTML = '<div class="empty-small" style="color:var(--red)">Erro ao carregar chamadas</div>';
  }
}

function abrirModalLigacao(cJson) {
  const c = JSON.parse(cJson);
  const bg = document.getElementById('modal-ligacao-bg');
  const dt = c.criada_em ? new Date(c.criada_em).toLocaleString('pt-BR') : '—';
  const dur = c.duracao_segundos ? `${Math.floor(c.duracao_segundos/60)}min ${c.duracao_segundos%60}s` : '—';

  const processando = c.gravacao_url && !c.transcricao && c.tentativas_gravacao < 3 && c.status !== 'falha_gravacao';
  const semGravacao = !c.gravacao_url || c.status === 'falha_gravacao';

  let audioHtml = '';
  if (semGravacao) audioHtml = '<p style="color:var(--muted);font-size:12.5px">Gravação não disponível</p>';
  else if (processando) audioHtml = '<p style="color:var(--muted);font-size:12.5px">⏳ Aguardando gravação...</p>';
  else audioHtml = `<audio controls src="${escHtml(c.gravacao_url)}" style="width:100%"></audio>`;

  let analiseHtml = '';
  if (c.analise_ia) {
    const s = c.analise_ia.score;
    const cor = s >= 7 ? '#16a34a' : s >= 4 ? '#d97706' : '#dc2626';
    analiseHtml = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <span style="font-size:28px;font-weight:800;color:${cor}">${s}</span>
        <span style="font-size:12.5px;color:var(--muted)">/ 10</span>
      </div>
      <p style="font-size:13px;margin-bottom:10px">${escHtml(c.analise_ia.resumo || '')}</p>
      ${(c.analise_ia.pontos_fortes || []).map(p => `<div style="font-size:12.5px;color:#16a34a;margin-bottom:3px">✓ ${escHtml(p)}</div>`).join('')}
      ${(c.analise_ia.pontos_melhora || []).map(p => `<div style="font-size:12.5px;color:#d97706;margin-bottom:3px">△ ${escHtml(p)}</div>`).join('')}`;
  } else if (c.status === 'atendida' && !processando) {
    analiseHtml = `<p style="color:var(--muted);font-size:12.5px">Análise pendente</p>
      <button class="btn btn-ghost" style="font-size:12px;margin-top:6px" onclick="analisarLigacao('${c.id}')">Analisar agora</button>`;
  }

  document.getElementById('ml-titulo').textContent = `Chamada — ${dt}`;
  document.getElementById('ml-body').innerHTML = `
    <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
      <span style="font-size:12.5px"><strong>Status:</strong> ${escHtml(c.status)}</span>
      <span style="font-size:12.5px"><strong>Duração:</strong> ${dur}</span>
      ${c.analisada_em ? `<span style="font-size:11.5px;color:var(--muted)">Analisado em ${new Date(c.analisada_em).toLocaleString('pt-BR')}</span>` : ''}
    </div>
    <div style="margin-bottom:16px">${audioHtml}</div>
    ${c.transcricao ? `<details style="margin-bottom:16px"><summary style="cursor:pointer;font-size:12.5px;font-weight:600">Transcrição</summary><pre style="font-size:11.5px;white-space:pre-wrap;background:var(--bg3);padding:10px;border-radius:6px;margin-top:8px;max-height:200px;overflow-y:auto">${escHtml(c.transcricao)}</pre></details>` : ''}
    ${analiseHtml}
  `;
  bg.style.display = 'flex';
}

function fecharModalLigacao() {
  document.getElementById('modal-ligacao-bg').style.display = 'none';
}

async function analisarLigacao(id) {
  try {
    toast('⏳ Análise iniciada...');
    await api(`/api/ligacoes/${id}/analisar`, { method: 'POST' });
    toast('✅ Análise em andamento. Recarregue em alguns instantes.');
  } catch (e) {
    toast('❌ ' + e.message, true);
  }
}
```

- [ ] **Step 6: Atualizar chamada carregarChamadas → carregarLigacoes no carregamento do lead**

Localizar onde `carregarChamadas(` é chamado (dentro de alguma função que carrega o modal do lead) e substituir por `carregarLigacoes(`:

```js
// Antes (localizar e substituir):
// carregarChamadas(leadId);
// Depois:
carregarLigacoes(leadId);
```

- [ ] **Step 7: Testar no browser**

1. Iniciar servidor: `node server.js`
2. Abrir o CRM no browser
3. Abrir um lead com telefone
4. Verificar que aba "Chamadas" carrega sem erros no console
5. Verificar que botão 📞 Ligar está visível para usuário com role `crc_leads`

- [ ] **Step 8: Commit**

```bash
git add public/index.html
git commit -m "feat: UI click-to-call 3cplus + histórico + modal detalhes de ligação"
```

---

## Task 9: public/ligacoes.html — Tela gerencial + painel de custo

**Files:**
- Create: `public/ligacoes.html`

- [ ] **Step 1: Criar public/ligacoes.html**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ligações — CRM AMA</title>
  <link rel="stylesheet" href="/css/main.css">
  <style>
    .page-tabs { display:flex; gap:0; border-bottom:1px solid var(--border); margin-bottom:20px; }
    .page-tab { padding:10px 20px; cursor:pointer; font-size:13px; border-bottom:2px solid transparent; }
    .page-tab.active { border-bottom-color:var(--primary); font-weight:600; color:var(--primary); }
    .filter-bar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:16px; }
    .filter-bar select, .filter-bar input { padding:6px 10px; border:1px solid var(--border); border-radius:6px; font-size:12.5px; background:var(--bg2); color:var(--text); }
    .cards-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:12px; margin-bottom:20px; }
    .card { background:var(--bg2); border:1px solid var(--border); border-radius:8px; padding:14px; text-align:center; }
    .card-val { font-size:22px; font-weight:700; color:var(--primary); }
    .card-lbl { font-size:11.5px; color:var(--muted); margin-top:3px; }
    table { width:100%; border-collapse:collapse; font-size:12.5px; }
    th { text-align:left; padding:8px 10px; font-weight:600; border-bottom:2px solid var(--border); }
    td { padding:8px 10px; border-bottom:1px solid var(--border); }
    tr:hover td { background:var(--bg3); }
    .badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600; }
    .toggle-row { display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid var(--border); }
    .toggle { position:relative; display:inline-block; width:40px; height:22px; }
    .toggle input { opacity:0; width:0; height:0; }
    .toggle-slider { position:absolute; cursor:pointer; inset:0; background:#ccc; border-radius:22px; transition:.2s; }
    .toggle input:checked + .toggle-slider { background:var(--primary); }
    .toggle-slider:before { content:''; position:absolute; width:16px; height:16px; left:3px; bottom:3px; background:#fff; border-radius:50%; transition:.2s; }
    .toggle input:checked + .toggle-slider:before { transform:translateX(18px); }
    .score-badge { padding:2px 8px; border-radius:10px; font-size:11px; font-weight:700; color:#fff; }
  </style>
</head>
<body>
  <div id="nav-placeholder"></div>

  <div class="container" style="max-width:1100px;margin:0 auto;padding:20px">
    <h1 style="margin-bottom:16px">📞 Ligações</h1>

    <div class="page-tabs">
      <div class="page-tab active" onclick="setTab('chamadas',this)">Detalhes das Chamadas</div>
      <div class="page-tab" onclick="setTab('custo',this)">Painel de Custo IA</div>
    </div>

    <!-- TAB: CHAMADAS -->
    <div id="tab-chamadas">
      <div class="cards-row" id="stats-cards">
        <div class="card"><div class="card-val" id="stat-total">—</div><div class="card-lbl">Total</div></div>
        <div class="card"><div class="card-val" id="stat-atendidas">—</div><div class="card-lbl">Atendidas</div></div>
        <div class="card"><div class="card-val" id="stat-taxa">—</div><div class="card-lbl">Taxa atend.</div></div>
        <div class="card"><div class="card-val" id="stat-duracao">—</div><div class="card-lbl">Dur. média</div></div>
        <div class="card"><div class="card-val" id="stat-score">—</div><div class="card-lbl">Score médio IA</div></div>
      </div>

      <div class="filter-bar">
        <input type="date" id="f-desde" onchange="carregar()">
        <input type="date" id="f-ate" onchange="carregar()">
        <select id="f-crc" onchange="carregar()"><option value="">Todas as CRCs</option></select>
        <select id="f-setor" onchange="carregar()">
          <option value="">Todos os setores</option>
          <option value="leads">Leads</option>
          <option value="agendamentos">Agendamentos</option>
          <option value="avaliacao_dentista">Avaliação Dentista</option>
        </select>
        <select id="f-status" onchange="carregar()">
          <option value="">Todos os status</option>
          <option value="atendida">Atendida</option>
          <option value="nao_atendida">Não atendida</option>
          <option value="ocupado">Ocupado</option>
          <option value="falha_gravacao">Falha</option>
        </select>
        <select id="f-score" onchange="carregar()">
          <option value="">Todos os scores</option>
          <option value="alto">Alto (≥7)</option>
          <option value="medio">Médio (4-6)</option>
          <option value="baixo">Baixo (&lt;4)</option>
        </select>
      </div>

      <div id="tabela-container">
        <table>
          <thead><tr>
            <th>Data/hora</th><th>CRC</th><th>Lead</th><th>Setor</th>
            <th>Status</th><th>Duração</th><th>Score IA</th>
          </tr></thead>
          <tbody id="tabela-body"><tr><td colspan="7" style="text-align:center;padding:20px;color:var(--muted)">Carregando...</td></tr></tbody>
        </table>
        <div id="paginacao" style="display:flex;gap:8px;justify-content:center;margin-top:14px;font-size:12.5px"></div>
      </div>
    </div>

    <!-- TAB: CUSTO -->
    <div id="tab-custo" style="display:none">
      <div class="cards-row" style="margin-bottom:20px" id="custo-cards">
        <div class="card"><div class="card-val" id="c-analises">—</div><div class="card-lbl">Análises/mês</div></div>
        <div class="card"><div class="card-val" id="c-minutos">—</div><div class="card-lbl">Minutos/mês</div></div>
        <div class="card"><div class="card-val" id="c-custo">—</div><div class="card-lbl">Custo mês (R$)</div></div>
        <div class="card"><div class="card-val" id="c-projecao">—</div><div class="card-lbl">Projeção mês (R$)</div></div>
      </div>
      <p id="custo-ref" style="font-size:11.5px;color:var(--muted);margin-bottom:20px"></p>

      <h3 style="font-size:14px;margin-bottom:14px">Controles por módulo</h3>
      <div id="ia-config-lista" style="margin-bottom:24px"></div>

      <h3 style="font-size:14px;margin-bottom:14px">Uso dos últimos 30 dias</h3>
      <table>
        <thead><tr><th>Data</th><th>Módulo</th><th>Análises</th><th>Minutos</th><th>Custo (R$)</th></tr></thead>
        <tbody id="custo-tabela-body"></tbody>
      </table>
    </div>
  </div>

  <!-- MODAL DETALHES LIGAÇÃO -->
  <div class="modal-bg" id="modal-lig-bg" style="display:none" onclick="if(event.target===this)fecharModal()">
  <div class="modal" style="max-width:600px">
    <div class="modal-header">
      <div class="modal-titulo" id="ml-titulo">Detalhes</div>
      <button class="modal-close" onclick="fecharModal()">×</button>
    </div>
    <div id="ml-body" style="padding:0 4px"></div>
  </div>
  </div>

<script src="/js/shared-nav.js"></script>
<script>
const TOKEN = () => localStorage.getItem('authToken') || '';
const escHtml = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { Authorization: 'Bearer ' + TOKEN(), 'Content-Type':'application/json', ...(opts.headers||{}) }, ...opts });
  return r.json();
}

let paginaAtual = 1;

function setTab(tab, el) {
  document.querySelectorAll('.page-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('tab-chamadas').style.display = tab === 'chamadas' ? '' : 'none';
  document.getElementById('tab-custo').style.display = tab === 'custo' ? '' : 'none';
  if (tab === 'custo') carregarCusto();
}

async function carregarCrcs() {
  try {
    const users = await api('/api/admin/users');
    const sel = document.getElementById('f-crc');
    (users || []).forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.id; opt.textContent = u.nome;
      sel.appendChild(opt);
    });
  } catch (_) {}
}

function scoreParams() {
  const v = document.getElementById('f-score').value;
  if (v === 'alto')  return { score_min: 7 };
  if (v === 'medio') return { score_min: 4, score_max: 6.99 };
  if (v === 'baixo') return { score_max: 3.99 };
  return {};
}

async function carregar(page = 1) {
  paginaAtual = page;
  const params = new URLSearchParams({
    page,
    ...(document.getElementById('f-desde').value ? { desde: document.getElementById('f-desde').value } : {}),
    ...(document.getElementById('f-ate').value ? { ate: document.getElementById('f-ate').value } : {}),
    ...(document.getElementById('f-crc').value ? { usuario_id: document.getElementById('f-crc').value } : {}),
    ...(document.getElementById('f-setor').value ? { modulo: document.getElementById('f-setor').value } : {}),
    ...(document.getElementById('f-status').value ? { status: document.getElementById('f-status').value } : {}),
    ...scoreParams(),
  });

  const [dados, stats] = await Promise.all([
    api('/api/ligacoes?' + params),
    api('/api/ligacoes/stats?' + params),
  ]);

  // Cards
  document.getElementById('stat-total').textContent = stats.total ?? '—';
  document.getElementById('stat-atendidas').textContent = stats.atendidas ?? '—';
  document.getElementById('stat-taxa').textContent = stats.taxa_atendimento != null ? stats.taxa_atendimento + '%' : '—';
  const dm = stats.duracao_media_s;
  document.getElementById('stat-duracao').textContent = dm ? `${Math.floor(dm/60)}m ${dm%60}s` : '—';
  document.getElementById('stat-score').textContent = stats.score_medio ?? '—';

  // Tabela
  const tbody = document.getElementById('tabela-body');
  const rows = dados.data || [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--muted)">Nenhuma ligação encontrada</td></tr>';
  } else {
    tbody.innerHTML = rows.map(r => {
      const dt = r.criada_em ? new Date(r.criada_em).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—';
      const crc = r.profiles?.nome || '—';
      const lead = r.leads?.nome || (r.modulo === 'avaliacao_dentista' ? '(avaliação)' : '—');
      const dur = r.duracao_segundos ? `${Math.floor(r.duracao_segundos/60)}m ${r.duracao_segundos%60}s` : '—';
      const statusMap = { atendida:'✅ Atendida', nao_atendida:'📵 N/A', ocupado:'📴 Ocup.', falha_gravacao:'⚠️ Falha' };
      const score = r.analise_ia?.score;
      const scoreBadge = score != null
        ? `<span class="score-badge" style="background:${score>=7?'#16a34a':score>=4?'#d97706':'#dc2626'}">${score}</span>`
        : '—';
      const setorMap = { leads:'Leads', agendamentos:'Agend.', avaliacao_dentista:'Aval.' };
      return `<tr style="cursor:pointer" onclick="abrirModal(${escHtml(JSON.stringify(JSON.stringify(r)))})">
        <td>${dt}</td><td>${escHtml(crc)}</td><td>${escHtml(lead)}</td>
        <td>${setorMap[r.modulo]||r.modulo}</td>
        <td>${statusMap[r.status]||r.status}</td><td>${dur}</td><td>${scoreBadge}</td>
      </tr>`;
    }).join('');
  }

  // Paginação
  const total = dados.total || 0;
  const totalPags = Math.ceil(total / (dados.limit || 50));
  const pg = document.getElementById('paginacao');
  pg.innerHTML = '';
  if (totalPags > 1) {
    if (page > 1) pg.innerHTML += `<button class="btn btn-ghost" onclick="carregar(${page-1})">← Anterior</button>`;
    pg.innerHTML += `<span style="padding:6px 10px">${page} / ${totalPags}</span>`;
    if (page < totalPags) pg.innerHTML += `<button class="btn btn-ghost" onclick="carregar(${page+1})">Próxima →</button>`;
  }
}

async function carregarCusto() {
  try {
    const d = await api('/api/ia-uso-log');
    document.getElementById('c-analises').textContent = d.cards.analises_mes;
    document.getElementById('c-minutos').textContent = d.cards.minutos_mes;
    document.getElementById('c-custo').textContent = 'R$ ' + d.cards.custo_mes.toFixed(2);
    document.getElementById('c-projecao').textContent = 'R$ ' + d.cards.projecao_mes.toFixed(2);
    document.getElementById('custo-ref').textContent = `Custo de referência: ~R$ ${d.custo_por_min}/min de áudio (Gemini)`;

    const configs = await api('/api/ia-config');
    const nomeModulo = { leads:'Leads', agendamentos:'Agendamentos', avaliacao_dentista:'Avaliação Dentista' };
    document.getElementById('ia-config-lista').innerHTML = configs.map(c => `
      <div class="toggle-row">
        <div>
          <strong style="font-size:13px">${nomeModulo[c.modulo]||c.modulo}</strong>
          <div style="font-size:11.5px;color:var(--muted);margin-top:2px">
            Mín. ${c.min_duracao_s}s · Limite diário: ${c.limite_diario} · Semanal: ${c.limite_semanal}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:11.5px;color:var(--muted)">${c.auto_analise_ativo?'Automática ON':'Automática OFF'}</span>
          <label class="toggle">
            <input type="checkbox" ${c.auto_analise_ativo?'checked':''} onchange="toggleAnalise('${c.modulo}',this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
    `).join('');

    const tbody = document.getElementById('custo-tabela-body');
    tbody.innerHTML = (d.tabela || []).map(r => `<tr>
      <td>${r.data}</td>
      <td>${nomeModulo[r.modulo]||r.modulo}</td>
      <td>${r.analises}</td>
      <td>${r.minutos}</td>
      <td>R$ ${r.custo.toFixed(2)}</td>
    </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--muted)">Sem dados</td></tr>';
  } catch (e) {
    console.error('carregarCusto:', e);
  }
}

async function toggleAnalise(modulo, ativo) {
  try {
    await api(`/api/ia-config/${modulo}`, { method:'PUT', body: JSON.stringify({ auto_analise_ativo: ativo }) });
  } catch (e) {
    alert('Erro: ' + e.message);
  }
}

function abrirModal(cJson) {
  const c = JSON.parse(cJson);
  const dt = c.criada_em ? new Date(c.criada_em).toLocaleString('pt-BR') : '—';
  const dur = c.duracao_segundos ? `${Math.floor(c.duracao_segundos/60)}m ${c.duracao_segundos%60}s` : '—';
  const processando = c.gravacao_url && !c.transcricao && c.tentativas_gravacao < 3 && c.status !== 'falha_gravacao';
  const semGravacao = !c.gravacao_url || c.status === 'falha_gravacao';
  let audioHtml = semGravacao ? '<p style="color:var(--muted);font-size:12.5px">Gravação não disponível</p>'
    : processando ? '<p style="color:var(--muted);font-size:12.5px">⏳ Aguardando gravação...</p>'
    : `<audio controls src="${escHtml(c.gravacao_url)}" style="width:100%"></audio>`;
  let analiseHtml = '';
  if (c.analise_ia) {
    const s = c.analise_ia.score;
    const cor = s>=7?'#16a34a':s>=4?'#d97706':'#dc2626';
    analiseHtml = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <span style="font-size:28px;font-weight:800;color:${cor}">${s}</span><span style="font-size:12.5px;color:var(--muted)">/ 10</span></div>
      <p style="font-size:13px">${escHtml(c.analise_ia.resumo||'')}</p>
      ${(c.analise_ia.pontos_fortes||[]).map(p=>`<div style="font-size:12.5px;color:#16a34a;margin-bottom:3px">✓ ${escHtml(p)}</div>`).join('')}
      ${(c.analise_ia.pontos_melhora||[]).map(p=>`<div style="font-size:12.5px;color:#d97706;margin-bottom:3px">△ ${escHtml(p)}</div>`).join('')}`;
  } else if (c.status === 'atendida' && !processando) {
    analiseHtml = `<p style="color:var(--muted);font-size:12.5px">Análise pendente</p>
      <button class="btn btn-ghost" style="font-size:12px;margin-top:6px" onclick="analisar('${c.id}')">Analisar agora</button>`;
  }
  document.getElementById('ml-titulo').textContent = `Chamada — ${dt}`;
  document.getElementById('ml-body').innerHTML = `
    <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
      <span style="font-size:12.5px"><strong>Status:</strong> ${escHtml(c.status)}</span>
      <span style="font-size:12.5px"><strong>Duração:</strong> ${dur}</span>
      ${c.analisada_em?`<span style="font-size:11.5px;color:var(--muted)">Analisado em ${new Date(c.analisada_em).toLocaleString('pt-BR')}</span>`:''}
    </div>
    <div style="margin-bottom:16px">${audioHtml}</div>
    ${c.transcricao?`<details style="margin-bottom:16px"><summary style="cursor:pointer;font-size:12.5px;font-weight:600">Transcrição</summary><pre style="font-size:11px;white-space:pre-wrap;background:var(--bg3);padding:10px;border-radius:6px;margin-top:8px;max-height:200px;overflow-y:auto">${escHtml(c.transcricao)}</pre></details>`:''}
    ${analiseHtml}`;
  document.getElementById('modal-lig-bg').style.display = 'flex';
}

function fecharModal() { document.getElementById('modal-lig-bg').style.display = 'none'; }

async function analisar(id) {
  try {
    await api(`/api/ligacoes/${id}/analisar`, { method:'POST' });
    alert('Análise iniciada. Recarregue em alguns instantes.');
    fecharModal();
  } catch (e) { alert('Erro: ' + e.message); }
}

// Inicializar
carregarCrcs();
carregar();
</script>
</body>
</html>
```

- [ ] **Step 2: Adicionar rota de servir a página no server.js**

No bloco de arquivos estáticos do server.js (próximo de `app.use(express.static(...))`), adicionar:

```js
app.get('/ligacoes', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ligacoes.html'));
});
```

- [ ] **Step 2b: Registrar no nav lateral (CLAUDE.md — padrão obrigatório)**

**Em `public/index.html`** — adicionar antes do botão "Usuários":
```html
<a class="nav-btn" href="/ligacoes" data-roles="gestor,admin">
  <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.8a19.79 19.79 0 01-3.07-8.64A2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14.92v2z"/>
  </svg>
  Ligações
</a>
```

**Em `public/js/shared-nav.js`** — adicionar entrada na lista de links:
```js
{ href: '/ligacoes', label: 'Ligações', slug: 'ligacoes', roles: ['gestor', 'admin'] },
```

**Em `public/ligacoes.html`** — o `<script src="/js/shared-nav.js">` já está no template acima com `data-active="ligacoes"`. ✓

- [ ] **Step 3: Verificar sintaxe do server.js**

```bash
node --check server.js && echo "OK"
```

- [ ] **Step 4: Testar no browser**

1. Acessar `/ligacoes` com usuário gestor
2. Verificar que a tabela carrega
3. Verificar que cards de stats aparecem
4. Clicar em "Painel de Custo IA" e verificar que a tela de controles e custos carrega

- [ ] **Step 5: Commit**

```bash
git add public/ligacoes.html server.js
git commit -m "feat: public/ligacoes.html — tela gerencial + painel de custo IA"
```

---

## Task 10: Migração Deepgram → Gemini (Avaliação Dentista — Seção 7)

**Files:**
- Modify: `server.js`
- Modify: `lib/gemini.js`

A rota `POST /api/avaliacoes/transcrever` atualmente usa Deepgram para transcrever. Vamos substituir por uma chamada Gemini que faz transcrição + análise juntas. A interface da rota permanece igual (cliente envia áudio, recebe jobId, faz polling).

- [ ] **Step 1: Adicionar transcreverComGemini() em lib/gemini.js**

Antes do `module.exports`:

```js
// Transcreve áudio usando Gemini (sem análise) — para uso no módulo Avaliação Dentista.
// Retorna formato compatível com o que Deepgram retornava (words array).
async function transcreverAudio({ audioBuffer, contentType = 'audio/mpeg' }) {
  const base64Audio = audioBuffer.toString('base64');
  const prompt = `Transcreva o áudio a seguir em português brasileiro.
Retorne APENAS JSON válido (sem markdown), no formato:
{"transcricao": "texto completo da transcrição identificando os falantes como Dentista e Paciente"}`;

  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: contentType, data: base64Audio } },
      { text: prompt },
    ]}],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  };

  const TranscricaoSchema = z.object({ transcricao: z.string() });

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { status, body: raw } = await httpsPost(geminiUrl(), body, 180000);
      if (status !== 200) { lastErr = new Error(`Gemini ${status}`); continue; }
      const json = JSON.parse(raw);
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) { lastErr = new Error('Gemini: empty'); continue; }
      const result = TranscricaoSchema.safeParse(JSON.parse(text));
      if (!result.success) { lastErr = new Error('Zod'); continue; }
      const usage = json?.usageMetadata ?? {};
      return { transcricao: result.data.transcricao, tokensIn: usage.promptTokenCount ?? 0, tokensOut: usage.candidatesTokenCount ?? 0 };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`transcreverAudio falhou: ${lastErr?.message}`);
}
```

- [ ] **Step 2: Exportar transcreverAudio**

Atualizar `module.exports`:

```js
module.exports = { analyzeTranscript, detalharEtapa, gerarInsights, gerarBenchmark, analyzeLigacao, transcreverAudio };
```

- [ ] **Step 3: Substituir a rota POST /api/avaliacoes/transcrever no server.js**

Localizar `app.post('/api/avaliacoes/transcrever',` (linha ~2075) e substituir o handler internamente:

```js
app.post('/api/avaliacoes/transcrever',
  requireAuth, requireDentista, requireModuloAtivo,
  express.raw({ type: '*/*', limit: '300mb' }),
  (req, res) => {
    const jobId = crypto.randomUUID();
    const contentType = (req.headers['x-audio-content-type'] || req.headers['content-type'] || 'audio/mpeg')
      .split(';')[0].trim();
    const buffer = req.body;

    _transcribeJobs.set(jobId, { status: 'pending', result: null, error: null, userId: req.user.id });
    res.json({ jobId });

    // Usar Gemini em vez de Deepgram — mesmo padrão lazy-load do restante do servidor
    geminiLib().transcreverAudio({ audioBuffer: buffer, contentType })
      .then(({ transcricao }) => {
        // Compatibilidade: o cliente espera { words: [...] }
        // Retornamos a transcrição como texto único em words[0]
        _transcribeJobs.set(jobId, {
          status: 'done',
          result: { transcricao, words: [{ word: transcricao, start: 0, end: 0, speaker: 0 }] },
          error: null, userId: req.user.id,
        });
      })
      .catch(e => {
        _transcribeJobs.set(jobId, { status: 'error', result: null, error: e.message, userId: req.user.id });
      });

    setTimeout(() => _transcribeJobs.delete(jobId), 15 * 60 * 1000);
  }
);
```

> **Nota:** O cliente de avaliação dentista lê `result.words` para montar o transcript. Verificar se o frontend de avaliação usa `words` para construir o texto da transcrição ou se usa `result.transcricao` diretamente. Se usar `.words`, o campo de compatibilidade acima funciona. Se o cliente precisar do formato exato de diarização do Deepgram, ajustar o frontend para usar `result.transcricao` em vez de processar `words`.

- [ ] **Step 4: Remover require do deepgram que não é mais necessário**

No topo de `server.js`, localizar onde `deepgramLib` é definido/importado e verificar se ainda é usado em outras rotas (como o endpoint de token efêmero `POST /api/avaliacoes/deepgram-token`). Se `deepgram-token` ainda existir, o require deve permanecer. Desabilitar apenas a lógica de transcrição, não o módulo inteiro.

> **Atenção:** O endpoint `POST /api/avaliacoes/deepgram-token` serve tokens efêmeros para transcrição client-side. Após a migração, esse endpoint pode ser removido se o frontend não usar mais transcrição client-side. Verificar antes de remover.

- [ ] **Step 5: Verificar sintaxe**

```bash
node --check server.js && echo "OK"
node -e "require('./lib/gemini.js'); console.log('OK')"
```

- [ ] **Step 6: Testar manualmente**

1. Iniciar servidor
2. Acessar módulo Avaliação Dentista
3. Fazer upload de um áudio curto
4. Verificar polling: `GET /api/avaliacoes/transcrever/:jobId` retorna `status: done`
5. Verificar que a transcrição aparece na interface

- [ ] **Step 7: Commit**

```bash
git add server.js lib/gemini.js
git commit -m "feat: migração Deepgram → Gemini no módulo Avaliação Dentista"
```

---

## Task 11: Deploy e verificação final

**Files:**
- Nenhum arquivo novo

- [ ] **Step 1: Push para o repositório**

```bash
git push origin main
```

- [ ] **Step 2: Deploy no Easypanel**

```bash
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

- [ ] **Step 3: Adicionar variáveis de ambiente no Easypanel**

Verificar que estas variáveis estão configuradas em Environment:
- `THREEC_TOKEN` — token da API 3cplus
- `THREEC_BASE_URL` — URL base da API (ex: `https://api.3cplus.com.br`)
- `THREEC_WEBHOOK_TOKEN` — segredo para validar webhooks
- `GEMINI_COST_PER_MIN` — `0.016` (custo por minuto de áudio Gemini)

- [ ] **Step 4: Verificar saúde do servidor**

```bash
curl http://2.24.94.120:3000/health
```

Esperado: `{"ok":true}`

- [ ] **Step 5: Testar fluxo completo**

1. Acessar CRM → abrir lead → aba Chamadas → clicar 📞 Ligar
2. Verificar ligação criada em `ligacoes` no Supabase Dashboard
3. Simular webhook (com curl) para atualizar status e URL de gravação:

```bash
curl -X POST http://2.24.94.120:3000/api/webhooks/3cplus \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: <THREEC_WEBHOOK_TOKEN>" \
  -d '{"threec_call_id":"<id_do_registro>","status":"atendida","duracao_segundos":180,"gravacao_url":"https://url-da-gravacao.mp3"}'
```

4. Verificar que `processarGravacao` roda e preenche `transcricao` + `analise_ia`
5. Abrir modal "→" da ligação e verificar dados

- [ ] **Step 6: Commit final de verificação (se algum ajuste for necessário)**

```bash
git add -p
git commit -m "fix: ajustes pós-deploy 3cplus sub-projeto 1"
git push origin main
```
