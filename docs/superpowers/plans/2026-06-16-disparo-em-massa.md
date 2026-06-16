# Disparo em Massa via WhatsApp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disparar um template WhatsApp aprovado para uma lista de CSV de uma vez, com controle (progresso/pausa/retomar), registro no perfil de cada lead e criação de lead leve para quem ainda não existe.

**Architecture:** Backend Express com endpoints `/api/disparos/*`; parser e matching de telefone em módulos puros e testáveis (`lib/disparos/`); um runner in-process que envia ~1 msg/2,5s persistindo estado por contato no Supabase (resiliente a restart). Frontend vanilla na página Disparos (áreas Disparar + Campanhas) e uma aba "📢 Disparos" no modal do lead.

**Tech Stack:** Node.js + Express, Supabase (Postgres), multer (upload já configurado), WhatsApp Cloud API (`whatsapp.js`), `node --test` para testes.

**Spec:** `docs/superpowers/specs/2026-06-16-disparo-em-massa-design.md`

---

## File Structure

- **Create** `supabase/migrations/20260616000000_disparos_em_massa.sql` — tabelas `disparos_campanhas` e `disparos_contatos` + índices.
- **Create** `lib/disparos/parser.js` — parse do CSV cru → contatos normalizados (puro, testável).
- **Create** `lib/disparos/parser.test.js` — testes do parser.
- **Create** `lib/disparos/matching.js` — `ultimos8()` + `confirmarMatch()` (puro, testável).
- **Create** `lib/disparos/matching.test.js` — testes do matching.
- **Create** `lib/disparos/runner.js` — runner de envio em background.
- **Modify** `server.js` — endpoints `/api/disparos/*`, `/api/leads/:id/disparos`, recuperação no boot, middleware `requireDisparos`.
- **Modify** `public/index.html` — reorganização da página Disparos, aba "📢 Disparos" no modal, badge na sidebar, JS.

Convenções existentes a seguir: helper `api()`, `toast()`, `escHtml()`, `setPage()`, `setTab()`, `logEvento(leadId, tipo, descricao, metadata, usuarioId)`, `chaveTelefone()` em `lib/funil/telefone.js`, `whatsapp.enviarBroadcast({ para, templateName, lang, variaveis })`, multer `_upload` (memória, 16MB). Status de entrega em `mensagens.wa_status`/`wa_erro`.

---

## Task 1: Migração — tabelas de disparo

**Files:**
- Create: `supabase/migrations/20260616000000_disparos_em_massa.sql`

- [ ] **Step 1: Escrever a migração**

```sql
-- Disparo em massa via WhatsApp (Fase 1)
create table if not exists disparos_campanhas (
  id            bigint generated always as identity primary key,
  nome          text not null,
  template_nome text not null,
  lang          text not null default 'pt_BR',
  total         int  not null default 0,
  enviados      int  not null default 0,
  falhas        int  not null default 0,
  status        text not null default 'rascunho',  -- rascunho/enviando/pausada/concluida
  auto_pausada  boolean not null default false,
  criado_por    uuid,
  criado_em     timestamptz not null default now(),
  iniciada_em   timestamptz,
  concluida_em  timestamptz
);

create table if not exists disparos_contatos (
  id            bigint generated always as identity primary key,
  campanha_id   bigint not null references disparos_campanhas(id) on delete cascade,
  lead_id       bigint references leads(id) on delete set null,
  nome          text,
  primeiro_nome text,
  telefone      text not null,
  variaveis     jsonb not null default '[]'::jsonb,
  status        text not null default 'pendente',  -- pendente/enviado/falha
  wa_id         text,
  erro          text,
  enviado_em    timestamptz
);

create index if not exists idx_disparos_contatos_campanha_status
  on disparos_contatos (campanha_id, status);
create index if not exists idx_disparos_contatos_lead
  on disparos_contatos (lead_id);
create index if not exists idx_disparos_campanhas_status
  on disparos_campanhas (status);
```

- [ ] **Step 2: Aplicar via MCP Supabase**

Usar a ferramenta MCP `apply_migration` (project `mtqdpjhhqzvuklnlfpvi`), name `disparos_em_massa`, com o SQL acima.

- [ ] **Step 3: Verificar**

Usar MCP `list_migrations` e confirmar que `20260616000000` (ou o timestamp aplicado) aparece. Usar `list_tables` e confirmar `disparos_campanhas` e `disparos_contatos`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260616000000_disparos_em_massa.sql
git commit -m "feat(disparos): migracao das tabelas de campanha e contatos"
```

---

## Task 2: Parser de CSV (servidor)

**Files:**
- Create: `lib/disparos/parser.js`
- Test: `lib/disparos/parser.test.js`

- [ ] **Step 1: Escrever os testes (falhando)**

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { parseCsv, normalizarTelefoneEnvio } = require('./parser');

test('normaliza telefone de 11 digitos prefixando 55', () => {
  assert.strictEqual(normalizarTelefoneEnvio('31998059819'), '5531998059819');
});

test('normaliza telefone de 10 digitos (sem 9) prefixando 55', () => {
  assert.strictEqual(normalizarTelefoneEnvio('3132249419'), '553132249419');
});

test('mantem telefone que ja vem com 55', () => {
  assert.strictEqual(normalizarTelefoneEnvio('5531998059819'), '5531998059819');
});

test('limpa mascara e simbolos', () => {
  assert.strictEqual(normalizarTelefoneEnvio('(31) 99805-9819'), '5531998059819');
});

test('telefone curto demais e invalido', () => {
  assert.strictEqual(normalizarTelefoneEnvio('99819'), null);
});

test('parseia CSV real wa_3 com cabecalho completo', () => {
  const csv = [
    'nome_completo,primeiro_nome,telefone,tratamento,valor_orcamento',
    'Antonio Augusto de Padua Mendes (20594),Antonio,31998059819,Invisalign,17500',
    'Giuseppe Rafaelle Meireles Rosa (20720),Giuseppe,31985566017,Invisalign,17100',
  ].join('\n');
  const r = parseCsv(csv);
  assert.strictEqual(r.contatos.length, 2);
  assert.strictEqual(r.invalidos, 0);
  assert.deepStrictEqual(r.contatos[0], {
    nome: 'Antonio Augusto de Padua Mendes',
    primeiro_nome: 'Antonio',
    telefone: '5531998059819',
  });
});

test('parseia CSV simples nome,telefone e deriva primeiro_nome', () => {
  const csv = 'Maria Silva, 5531999990001\nJoao Souza, 31988887777';
  const r = parseCsv(csv);
  assert.strictEqual(r.contatos.length, 2);
  assert.strictEqual(r.contatos[0].primeiro_nome, 'Maria');
  assert.strictEqual(r.contatos[0].telefone, '5531999990001');
  assert.strictEqual(r.contatos[1].telefone, '5531988887777');
});

test('aceita separador ponto-e-virgula', () => {
  const csv = 'nome;telefone\nAna Paula;31977776666';
  const r = parseCsv(csv);
  assert.strictEqual(r.contatos.length, 1);
  assert.strictEqual(r.contatos[0].primeiro_nome, 'Ana');
});

test('linha sem telefone valido conta como invalido e nao entra', () => {
  const csv = 'nome,telefone\nFulano,abc\nBeltrano,31955554444';
  const r = parseCsv(csv);
  assert.strictEqual(r.contatos.length, 1);
  assert.strictEqual(r.invalidos, 1);
});

test('primeiro_nome vazio cai para fallback generico', () => {
  const csv = 'nome_completo,primeiro_nome,telefone\n,,31944443333';
  const r = parseCsv(csv);
  assert.strictEqual(r.contatos[0].primeiro_nome, 'tudo bem');
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm test`
Expected: FAIL — `Cannot find module './parser'`.

- [ ] **Step 3: Implementar `lib/disparos/parser.js`**

```javascript
// Parser de CSV para disparo em massa (roda no servidor).
// Aceita o formato wa_3 (nome_completo,primeiro_nome,telefone,tratamento,valor_orcamento)
// e o formato simples (nome,telefone). Separador virgula ou ponto-e-virgula.

function normalizarTelefoneEnvio(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if ((d.length === 10 || d.length === 11) && !d.startsWith('55')) d = '55' + d;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
  return null;
}

// Quebra uma linha de CSV respeitando aspas. Separador virgula ou ponto-e-virgula.
function splitLinha(linha) {
  const out = []; let i = 0, campo = '', emAspas = false;
  while (i < linha.length) {
    const ch = linha[i];
    if (emAspas) {
      if (ch === '"' && linha[i + 1] === '"') { campo += '"'; i += 2; continue; }
      if (ch === '"') { emAspas = false; i++; continue; }
      campo += ch; i++; continue;
    }
    if (ch === '"') { emAspas = true; i++; continue; }
    if (ch === ',' || ch === ';') { out.push(campo.trim()); campo = ''; i++; continue; }
    campo += ch; i++;
  }
  out.push(campo.trim());
  return out;
}

function tirarIdParenteses(nome) {
  return String(nome || '').replace(/\s*\(\d+\)\s*$/, '').trim();
}

function primeiroToken(nome) {
  const t = String(nome || '').trim().split(/\s+/)[0];
  return t || '';
}

// Detecta o indice de colunas conhecidas a partir do cabecalho.
function mapearColunas(cabecalho) {
  const norm = cabecalho.map(c => c.toLowerCase().replace(/^﻿/, '').trim());
  const idx = (nomes) => {
    for (const n of nomes) { const i = norm.indexOf(n); if (i >= 0) return i; }
    return -1;
  };
  return {
    nomeCompleto: idx(['nome_completo', 'nome', 'name']),
    primeiroNome: idx(['primeiro_nome', 'first_name', 'fn']),
    telefone: idx(['telefone', 'phone', 'celular', 'whatsapp']),
  };
}

const CABECALHO_RX = /(nome|name|telefone|phone|celular|whatsapp|primeiro_nome)/i;

function parseCsv(texto) {
  const linhas = String(texto || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  if (!linhas.length) return { contatos: [], invalidos: 0 };

  // Decide se a 1a linha e cabecalho.
  const primeira = splitLinha(linhas[0]);
  const temCabecalho = primeira.some(c => CABECALHO_RX.test(c)) &&
    normalizarTelefoneEnvio(primeira.find(c => /\d/.test(c)) || '') === null;

  let cols, dados;
  if (temCabecalho) {
    cols = mapearColunas(primeira);
    dados = linhas.slice(1);
  } else {
    // Sem cabecalho: assume nome, telefone (telefone = ultima coluna com muitos digitos).
    cols = { nomeCompleto: 0, primeiroNome: -1, telefone: 1 };
    dados = linhas;
  }

  const contatos = [];
  let invalidos = 0;
  for (const linha of dados) {
    const campos = splitLinha(linha);
    // telefone: coluna mapeada, ou a 1a coluna que normalize para um numero valido.
    let telBruto = cols.telefone >= 0 ? campos[cols.telefone] : '';
    let telefone = normalizarTelefoneEnvio(telBruto);
    if (!telefone) {
      for (const c of campos) { const t = normalizarTelefoneEnvio(c); if (t) { telefone = t; break; } }
    }
    if (!telefone) { invalidos++; continue; }

    const nomeCompletoRaw = cols.nomeCompleto >= 0 ? campos[cols.nomeCompleto] : '';
    const nome = tirarIdParenteses(nomeCompletoRaw);
    let primeiro_nome = cols.primeiroNome >= 0 ? campos[cols.primeiroNome] : '';
    primeiro_nome = (primeiro_nome || primeiroToken(nome)).trim() || 'tudo bem';

    contatos.push({ nome: nome || primeiro_nome, primeiro_nome, telefone });
  }
  return { contatos, invalidos };
}

module.exports = { parseCsv, normalizarTelefoneEnvio };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test`
Expected: PASS — todos os testes do parser verdes.

- [ ] **Step 5: Commit**

```bash
git add lib/disparos/parser.js lib/disparos/parser.test.js
git commit -m "feat(disparos): parser de CSV no servidor com testes"
```

---

## Task 3: Matching de telefone (evita duplicar lead)

**Files:**
- Create: `lib/disparos/matching.js`
- Test: `lib/disparos/matching.test.js`

- [ ] **Step 1: Escrever os testes (falhando)**

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { ultimos8, confirmarMatch } = require('./matching');

test('ultimos8 pega os 8 ultimos digitos ignorando mascara', () => {
  assert.strictEqual(ultimos8('5531998059819'), '98059819');
  assert.strictEqual(ultimos8('(31) 99805-9819'), '98059819');
});

test('confirmarMatch casa numero com 9 contra lead sem 9', () => {
  const cands = [{ id: 7, telefone: '553198059819' }]; // sem o 9 extra
  const m = confirmarMatch('5531998059819', cands);
  assert.strictEqual(m.id, 7);
});

test('confirmarMatch casa formatos com e sem DDI', () => {
  const cands = [{ id: 9, telefone: '31998059819' }];
  const m = confirmarMatch('5531998059819', cands);
  assert.strictEqual(m.id, 9);
});

test('confirmarMatch retorna null quando ninguem casa', () => {
  const cands = [{ id: 1, telefone: '5531911112222' }];
  assert.strictEqual(confirmarMatch('5531998059819', cands), null);
});

test('confirmarMatch nao casa familiares com 3o digito diferente de 9', () => {
  // 4475089 vs 4495089 sao pessoas diferentes (ver telefone.js)
  const cands = [{ id: 2, telefone: '553144750890' }];
  assert.strictEqual(confirmarMatch('553144950890', cands), null);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm test`
Expected: FAIL — `Cannot find module './matching'`.

- [ ] **Step 3: Implementar `lib/disparos/matching.js`**

```javascript
// Matching de telefone para casar contato do CSV com lead existente.
// NUNCA carrega a tabela inteira de leads (cliente Supabase trunca em 1000 linhas).
// Estrategia: pre-filtrar no banco pelos ultimos 8 digitos (invariantes a DDI e ao
// 9o digito) e confirmar com chaveTelefone na lista pequena de candidatos.
const { chaveTelefone } = require('../funil/telefone');

function ultimos8(telefone) {
  const d = String(telefone || '').replace(/\D/g, '');
  return d.slice(-8);
}

function confirmarMatch(telefone, candidatos) {
  const alvo = chaveTelefone(telefone);
  if (!alvo) return null;
  return (candidatos || []).find(c => chaveTelefone(c.telefone) === alvo) || null;
}

// Resolve o lead_id de um contato. Recebe o client supabase.
// Retorna { lead_id, criado: boolean }.
async function resolverLead(supabase, contato, nomeCampanha, criarLeadLeve) {
  const ult8 = ultimos8(contato.telefone);
  let candidatos = [];
  if (ult8.length === 8) {
    const { data } = await supabase
      .from('leads').select('id, telefone')
      .ilike('telefone', '%' + ult8 + '%').limit(50);
    candidatos = data || [];
  }
  const match = confirmarMatch(contato.telefone, candidatos);
  if (match) return { lead_id: match.id, criado: false };
  const novo = await criarLeadLeve(contato, nomeCampanha);
  return { lead_id: novo.id, criado: true };
}

module.exports = { ultimos8, confirmarMatch, resolverLead };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/disparos/matching.js lib/disparos/matching.test.js
git commit -m "feat(disparos): matching de telefone por ultimos 8 digitos"
```

---

## Task 4: Runner de envio em background

**Files:**
- Create: `lib/disparos/runner.js`

> O runner usa o client `supabase` e o módulo `whatsapp` injetados (facilita teste/uso). Não tem teste unitário automatizado nesta fase (envolve I/O externo); é validado manualmente na Task 8.

- [ ] **Step 1: Implementar `lib/disparos/runner.js`**

```javascript
// Runner de disparo em massa. Processa contatos 'pendente' de uma campanha,
// ~1 envio a cada PAUSA_MS, persistindo estado por contato (resiliente a restart).
const { resolverLead } = require('./matching');

const PAUSA_MS = 2500;
const emExecucao = new Set(); // campanhas rodando neste processo (anti-duplo-start)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// criarLeadLeve: espelha o shape do insert de /api/leads em server.js.
function makeCriarLeadLeve(supabase) {
  return async function criarLeadLeve(contato, nomeCampanha) {
    const { data, error } = await supabase.from('leads').insert({
      nome: contato.nome || contato.primeiro_nome,
      telefone: contato.telefone,
      email: '', origem: 'disparo-csv',
      campanha: '', conteudo: '', fbclid: '', gclid: '', ctwa_clid: '',
      status: 'Lead', valor: null, tipo_trat: '',
      notas_sdr: '', notas_avaliacao: '', notas_comercial: '',
      score_interesse: null, perfil_disc: '',
      etiquetas: nomeCampanha ? [nomeCampanha] : [],
      proximo_contato: null, ultimo_contato: null,
      enviado_meta: false, enviado_google: false, eventos_meta_enviados: [],
    }).select('id').single();
    if (error) throw error;
    return data;
  };
}

// Inicia o runner de uma campanha. Retorna imediatamente (roda solto).
// deps = { supabase, whatsapp, logEvento }.
function iniciarRunner(campanhaId, deps) {
  if (emExecucao.has(campanhaId)) return;
  emExecucao.add(campanhaId);
  _loop(campanhaId, deps).catch(e => console.error('❌ runner', campanhaId, e.message))
    .finally(() => emExecucao.delete(campanhaId));
}

async function _loop(campanhaId, deps) {
  const { supabase, whatsapp, logEvento } = deps;
  const criarLeadLeve = makeCriarLeadLeve(supabase);

  const { data: camp } = await supabase.from('disparos_campanhas')
    .select('*').eq('id', campanhaId).maybeSingle();
  if (!camp) return;

  while (true) {
    // Re-checa status a cada iteracao (permite pausar).
    const { data: atual } = await supabase.from('disparos_campanhas')
      .select('status').eq('id', campanhaId).maybeSingle();
    if (!atual || atual.status !== 'enviando') return;

    const { data: pend } = await supabase.from('disparos_contatos')
      .select('*').eq('campanha_id', campanhaId).eq('status', 'pendente')
      .order('id').limit(1);
    const contato = pend && pend[0];
    if (!contato) {
      await supabase.from('disparos_campanhas')
        .update({ status: 'concluida', concluida_em: new Date().toISOString() })
        .eq('id', campanhaId);
      return;
    }

    try {
      const { lead_id } = await resolverLead(supabase, contato, camp.nome, criarLeadLeve);
      const variaveis = Array.isArray(contato.variaveis) && contato.variaveis.length
        ? contato.variaveis : [contato.primeiro_nome || 'tudo bem'];
      const resultado = await whatsapp.enviarBroadcast({
        para: contato.telefone, templateName: camp.template_nome,
        lang: camp.lang, variaveis,
      });
      const waId = resultado?.messages?.[0]?.id || '';

      await supabase.from('mensagens').insert({
        lead_id, direcao: 'enviada', canal: 'broadcast',
        texto: '[disparo: ' + camp.template_nome + ']',
        wa_id: waId, wa_number_id: whatsapp.broadcastPhoneId() || '',
      });
      await supabase.from('disparos_contatos').update({
        lead_id, status: 'enviado', wa_id: waId, erro: null,
        enviado_em: new Date().toISOString(),
      }).eq('id', contato.id);
      await supabase.from('leads')
        .update({ ultimo_contato: new Date().toISOString() }).eq('id', lead_id);
      await supabase.rpc('increment', {}).catch(() => {}); // no-op se nao existir
      await supabase.from('disparos_campanhas')
        .update({ enviados: (camp.enviados = camp.enviados + 1) }).eq('id', campanhaId);

      logEvento(lead_id, 'disparo_massa', 'Disparo enviado: ' + camp.template_nome,
        { campanha_id: campanhaId, template: camp.template_nome }, camp.criado_por || null);
    } catch (e) {
      await supabase.from('disparos_contatos').update({
        status: 'falha', erro: String(e.message || e).slice(0, 300),
      }).eq('id', contato.id);
      await supabase.from('disparos_campanhas')
        .update({ falhas: (camp.falhas = camp.falhas + 1) }).eq('id', campanhaId);
      console.warn('⚠️ disparo falhou contato', contato.id, e.message);
    }

    await sleep(PAUSA_MS);
  }
}

// No boot: campanhas 'enviando' orfas viram 'pausada' + auto_pausada (avisa o usuario).
async function recuperarOrfas(supabase) {
  const { error } = await supabase.from('disparos_campanhas')
    .update({ status: 'pausada', auto_pausada: true }).eq('status', 'enviando');
  if (error) console.error('❌ recuperarOrfas:', error.message);
}

module.exports = { iniciarRunner, recuperarOrfas, PAUSA_MS };
```

> Nota: a linha `supabase.rpc('increment'...)` é um no-op defensivo e deve ser **removida** — os contadores `enviados`/`falhas` já são atualizados pelos `update` logo acima. Não incluir essa linha na implementação final. (Mantida aqui só para deixar explícito que NÃO se usa RPC para contador.)

- [ ] **Step 2: Remover a linha no-op de RPC**

Garantir que `lib/disparos/runner.js` NÃO contém `supabase.rpc('increment'...)`. Os contadores são atualizados só pelos dois `update` de `enviados`/`falhas`.

- [ ] **Step 3: Sanity check de sintaxe**

Run: `node -e "require('./lib/disparos/runner.js'); console.log('ok')"`
Expected: imprime `ok` (módulo carrega sem erro de sintaxe).

- [ ] **Step 4: Commit**

```bash
git add lib/disparos/runner.js
git commit -m "feat(disparos): runner de envio em background com resiliencia"
```

---

## Task 5: Endpoints de disparo no server.js

**Files:**
- Modify: `server.js` (perto do bloco "CAMPANHAS DE DISCAGEM PREDITIVA", e nos requires do topo)

- [ ] **Step 1: Importar os módulos novos**

No topo do `server.js`, junto dos outros requires (perto de `const { chaveTelefone } = require('./lib/funil/telefone');`), adicionar:

```javascript
const { parseCsv } = require('./lib/disparos/parser');
const disparoRunner = require('./lib/disparos/runner');
```

- [ ] **Step 2: Definir o middleware de acesso**

Perto dos outros `requireRole(...)` (ex.: onde está `requireCrcLead`), adicionar:

```javascript
const requireDisparos = requireRole('admin', 'gestor', 'crc_comercial');
```

- [ ] **Step 3: Adicionar os endpoints**

Inserir este bloco logo após o bloco de "CAMPANHAS DE DISCAGEM PREDITIVA" (após o endpoint `/api/campanhas/:id/resultado`):

```javascript
// ========== DISPARO EM MASSA (WhatsApp) ==========

// Lê o CSV cru do request: arquivo (multer, campo 'file') ou { texto } no body.
function lerCsvDoRequest(req) {
  if (req.file && req.file.buffer) return req.file.buffer.toString('utf8');
  if (req.body && typeof req.body.texto === 'string') return req.body.texto;
  return '';
}

app.post('/api/disparos/preview', requireAuth, requireDisparos, _upload.single('file'), async (req, res) => {
  try {
    const texto = lerCsvDoRequest(req);
    const { contatos, invalidos } = parseCsv(texto);
    if (!contatos.length) return res.json({ casam: 0, novos: 0, invalidos, amostra: [] });

    // Conta quantos casam com lead existente (matching por ultimos 8 + chaveTelefone).
    const { ultimos8, confirmarMatch } = require('./lib/disparos/matching');
    let casam = 0;
    for (const c of contatos) {
      const ult8 = ultimos8(c.telefone);
      let cand = [];
      if (ult8.length === 8) {
        const { data } = await supabase.from('leads').select('id, telefone')
          .ilike('telefone', '%' + ult8 + '%').limit(50);
        cand = data || [];
      }
      if (confirmarMatch(c.telefone, cand)) casam++;
    }
    res.json({
      casam, novos: contatos.length - casam, invalidos,
      total: contatos.length,
      amostra: contatos.slice(0, 5).map(c => ({ nome: c.nome, telefone: c.telefone })),
    });
  } catch (e) {
    console.error('❌ disparos/preview:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/disparos/criar', requireAuth, requireDisparos, _upload.single('file'), async (req, res) => {
  try {
    const nome = sanitizeStr(req.body.nome, 120);
    const template_nome = sanitizeStr(req.body.template_nome, 100);
    const lang = sanitizeStr(req.body.lang || 'pt_BR', 12);
    if (!nome) return res.status(400).json({ error: 'Nome da campanha obrigatório' });
    if (!template_nome) return res.status(400).json({ error: 'Template obrigatório' });

    const texto = lerCsvDoRequest(req);
    const { contatos } = parseCsv(texto);
    if (!contatos.length) return res.status(400).json({ error: 'Nenhum contato válido no CSV' });

    const { data: camp, error: cErr } = await supabase.from('disparos_campanhas').insert({
      nome, template_nome, lang, total: contatos.length,
      status: 'rascunho', criado_por: req.user.id,
    }).select().single();
    if (cErr) throw cErr;

    const rows = contatos.map(c => ({
      campanha_id: camp.id, nome: c.nome, primeiro_nome: c.primeiro_nome,
      telefone: c.telefone, variaveis: [c.primeiro_nome || 'tudo bem'], status: 'pendente',
    }));
    // insere em lotes de 500
    for (let i = 0; i < rows.length; i += 500) {
      const { error: iErr } = await supabase.from('disparos_contatos').insert(rows.slice(i, i + 500));
      if (iErr) throw iErr;
    }
    res.json({ campanha_id: camp.id, total: contatos.length });
  } catch (e) {
    console.error('❌ disparos/criar:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/disparos/:id/iniciar', requireAuth, requireDisparos, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    if (!whatsapp.temBroadcast()) return res.status(503).json({ error: 'Número de broadcast não configurado.' });
    const { data: ativa } = await supabase.from('disparos_campanhas')
      .select('id').eq('status', 'enviando').neq('id', id).limit(1);
    if (ativa && ativa.length) return res.status(409).json({ error: 'Já existe uma campanha enviando. Aguarde ou pause antes.' });

    await supabase.from('disparos_campanhas')
      .update({ status: 'enviando', auto_pausada: false, iniciada_em: new Date().toISOString() })
      .eq('id', id);
    disparoRunner.iniciarRunner(id, { supabase, whatsapp, logEvento });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/disparos/:id/pausar', requireAuth, requireDisparos, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await supabase.from('disparos_campanhas').update({ status: 'pausada' }).eq('id', id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/disparos/:id/retomar', requireAuth, requireDisparos, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { data: ativa } = await supabase.from('disparos_campanhas')
      .select('id').eq('status', 'enviando').neq('id', id).limit(1);
    if (ativa && ativa.length) return res.status(409).json({ error: 'Já existe uma campanha enviando. Aguarde ou pause antes.' });
    await supabase.from('disparos_campanhas')
      .update({ status: 'enviando', auto_pausada: false }).eq('id', id);
    disparoRunner.iniciarRunner(id, { supabase, whatsapp, logEvento });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/disparos/:id/progresso', requireAuth, requireDisparos, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { data: c } = await supabase.from('disparos_campanhas')
      .select('status, total, enviados, falhas').eq('id', id).maybeSingle();
    if (!c) return res.status(404).json({ error: 'Campanha não encontrada' });
    res.json({ ...c, restantes: Math.max(0, c.total - c.enviados - c.falhas) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/disparos/pendentes-aviso', requireAuth, requireDisparos, async (req, res) => {
  try {
    const { data } = await supabase.from('disparos_campanhas')
      .select('id, nome, enviados, total').eq('auto_pausada', true).order('id', { ascending: false });
    res.json({ campanhas: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/disparos', requireAuth, requireDisparos, async (req, res) => {
  try {
    const { data } = await supabase.from('disparos_campanhas')
      .select('*').order('id', { ascending: false }).limit(100);
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/disparos/:id', requireAuth, requireDisparos, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { data: camp } = await supabase.from('disparos_campanhas').select('*').eq('id', id).maybeSingle();
    if (!camp) return res.status(404).json({ error: 'Campanha não encontrada' });
    const { data: contatos } = await supabase.from('disparos_contatos')
      .select('nome, telefone, status, erro, enviado_em').eq('campanha_id', id).order('id').limit(2000);
    res.json({ campanha: camp, contatos: contatos || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Disparos recebidos por um lead (para a aba no perfil).
app.get('/api/leads/:id/disparos', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { data: contatos } = await supabase.from('disparos_contatos')
      .select('wa_id, status, enviado_em, campanha:disparos_campanhas(nome, template_nome)')
      .eq('lead_id', id).order('id', { ascending: false }).limit(100);
    const waIds = (contatos || []).map(c => c.wa_id).filter(Boolean);
    let statusPorWa = {};
    if (waIds.length) {
      const { data: msgs } = await supabase.from('mensagens')
        .select('wa_id, wa_status, wa_erro').in('wa_id', waIds);
      for (const m of msgs || []) statusPorWa[m.wa_id] = { wa_status: m.wa_status, wa_erro: m.wa_erro };
    }
    res.json((contatos || []).map(c => ({
      campanha: c.campanha?.nome || '',
      template: c.campanha?.template_nome || '',
      enviado_em: c.enviado_em, status_envio: c.status,
      entrega: statusPorWa[c.wa_id] || null,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 4: Chamar `recuperarOrfas` no boot**

Procurar onde o servidor sobe (ex.: `app.listen(`). Imediatamente antes/depois do `app.listen`, adicionar:

```javascript
disparoRunner.recuperarOrfas(supabase).catch(e => console.error('recuperarOrfas:', e.message));
```

- [ ] **Step 5: Sanity check de sintaxe**

Run: `node --check server.js`
Expected: sem erro de sintaxe. (Não subir o server aqui — falta de envs faria `app.listen` falhar; o boot real é validado no deploy, Task 8.)

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(disparos): endpoints de campanha, runner trigger e aba do lead"
```

---

## Task 6: Frontend — página Disparos (Disparar + Campanhas)

**Files:**
- Modify: `public/index.html` (`#page-disparos` e o bloco JS `// ============ DISPAROS ============`)

- [ ] **Step 1: Reestruturar o HTML da página**

No `<div id="page-disparos">`, ANTES da `<div class="disparos-grid">` existente (que contém Templates + Importar), inserir as duas novas áreas. Manter a grid existente abaixo (Templates + Importar Pacientes ficam intactos).

```html
  <!-- DISPARO EM MASSA -->
  <div class="disparos-panel" style="margin-bottom:24px">
    <div class="disparos-panel-titulo">📢 Disparo em Massa</div>
    <div class="disparos-panel-sub">Suba um CSV (nome, telefone) e envie um template aprovado para todos. Quem não for lead vira um lead novo automaticamente.</div>

    <div id="disp-banner-interrompida" style="display:none;background:rgba(220,38,38,.12);border:1px solid rgba(220,38,38,.4);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:13px"></div>

    <div class="form-row" style="margin-bottom:10px">
      <div class="form-group" style="margin-bottom:0">
        <label>Nome da campanha</label>
        <input id="disp-nome" placeholder="ex: Invisalign Condição Junho">
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label>Template (aprovado)</label>
        <select id="disp-template"><option value="">Carregando...</option></select>
      </div>
    </div>

    <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <label class="btn btn-ghost" style="font-size:12.5px;cursor:pointer">
        📎 Escolher CSV
        <input type="file" id="disp-file" accept=".csv,.txt" style="display:none" onchange="dispArquivoEscolhido(event)">
      </label>
      <span id="disp-file-nome" style="font-size:12px;color:var(--muted);align-self:center"></span>
      <button class="btn btn-ghost" style="font-size:12.5px" onclick="dispPreview()">👁 Visualizar</button>
    </div>

    <div id="disp-preview" style="display:none;font-size:13px;background:var(--bg3);border-radius:8px;padding:12px;margin-bottom:12px"></div>
    <button id="disp-btn-iniciar" class="btn btn-success" style="width:100%;display:none" onclick="dispCriarEIniciar(this)">🚀 Iniciar disparo</button>

    <div id="disp-progresso" style="display:none;margin-top:14px">
      <div style="height:10px;background:var(--bg3);border-radius:6px;overflow:hidden;margin-bottom:8px">
        <div id="disp-progresso-bar" style="height:100%;width:0;background:var(--green);transition:width .3s"></div>
      </div>
      <div id="disp-progresso-txt" style="font-size:12.5px;color:var(--muted)"></div>
      <button class="btn btn-ghost" style="font-size:12px;margin-top:8px" onclick="dispPausar()">⏸ Pausar</button>
    </div>
  </div>

  <!-- HISTORICO DE CAMPANHAS -->
  <div class="disparos-panel" style="margin-bottom:24px">
    <div class="disparos-panel-titulo">📋 Campanhas</div>
    <div class="disparos-panel-sub">Histórico dos disparos feitos.</div>
    <div id="disp-campanhas"><div class="empty-small">Carregando...</div></div>
  </div>
```

- [ ] **Step 2: Substituir `loadDisparos` e adicionar as funções JS**

No bloco `// ============ DISPAROS ============`, substituir a função `loadDisparos` por:

```javascript
let _dispFileTexto = '';
let _dispCampanhaAtual = null;
let _dispPollTimer = null;

async function loadDisparos() {
  await syncMeta(null, true);          // sync silencioso de templates
  await dispCarregarTemplates();
  await dispCarregarCampanhas();
  await dispCarregarAviso();
}

async function dispCarregarTemplates() {
  const sel = document.getElementById('disp-template');
  if (!sel) return;
  try {
    const tpls = await api('/api/templates');
    const aprovados = tpls.filter(t => t.status === 'aprovado');
    sel.innerHTML = aprovados.length
      ? aprovados.map(t => `<option value="${escHtml(t.nome)}">${escHtml(t.titulo || t.nome)}</option>`).join('')
      : '<option value="">Nenhum template aprovado</option>';
  } catch (e) { sel.innerHTML = '<option value="">Erro ao carregar</option>'; }
}

function dispArquivoEscolhido(ev) {
  const f = ev.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    _dispFileTexto = reader.result;
    document.getElementById('disp-file-nome').textContent = f.name;
  };
  reader.readAsText(f);
}

async function dispPreview() {
  if (!_dispFileTexto) { toast('Escolha um CSV primeiro', true); return; }
  const box = document.getElementById('disp-preview');
  box.style.display = 'block'; box.textContent = 'Analisando...';
  try {
    const r = await api('/api/disparos/preview', { method: 'POST', body: JSON.stringify({ texto: _dispFileTexto }) });
    if (r.error) { box.textContent = '❌ ' + r.error; return; }
    box.innerHTML = `<strong>${r.total}</strong> contatos válidos · <strong>${r.casam}</strong> já são leads · <strong>${r.novos}</strong> serão criados`
      + (r.invalidos ? ` · <span style="color:var(--red)">${r.invalidos} sem telefone válido (ignorados)</span>` : '');
    document.getElementById('disp-btn-iniciar').style.display = r.total ? 'block' : 'none';
  } catch (e) { box.textContent = '❌ ' + e.message; }
}

async function dispCriarEIniciar(btn) {
  const nome = document.getElementById('disp-nome').value.trim();
  const template_nome = document.getElementById('disp-template').value;
  if (!nome) { toast('Dê um nome à campanha', true); return; }
  if (!template_nome) { toast('Escolha um template aprovado', true); return; }
  if (!_dispFileTexto) { toast('Escolha um CSV', true); return; }
  if (!confirm(`Disparar "${template_nome}" para esta lista? Os envios começam agora.`)) return;
  btn.disabled = true; btn.textContent = 'Criando...';
  try {
    const r = await api('/api/disparos/criar', { method: 'POST', body: JSON.stringify({ nome, template_nome, texto: _dispFileTexto }) });
    if (r.error) { toast('❌ ' + r.error, true); return; }
    const ini = await api(`/api/disparos/${r.campanha_id}/iniciar`, { method: 'POST', body: '{}' });
    if (ini.error) { toast('❌ ' + ini.error, true); return; }
    _dispCampanhaAtual = r.campanha_id;
    toast('🚀 Disparo iniciado!');
    document.getElementById('disp-progresso').style.display = 'block';
    dispPoll();
    dispCarregarCampanhas();
  } catch (e) { toast('❌ ' + e.message, true); }
  finally { btn.disabled = false; btn.textContent = '🚀 Iniciar disparo'; }
}

async function dispPoll() {
  if (!_dispCampanhaAtual) return;
  try {
    const p = await api(`/api/disparos/${_dispCampanhaAtual}/progresso`);
    if (!p.error) {
      const feito = p.enviados + p.falhas;
      const pct = p.total ? Math.round(feito / p.total * 100) : 0;
      document.getElementById('disp-progresso-bar').style.width = pct + '%';
      document.getElementById('disp-progresso-txt').textContent =
        `${p.enviados} enviados · ${p.falhas} falhas · ${p.restantes} restantes (${p.status})`;
      if (p.status === 'enviando') { _dispPollTimer = setTimeout(dispPoll, 2500); return; }
      if (p.status === 'concluida') toast('✅ Disparo concluído!');
      dispCarregarCampanhas();
    }
  } catch (e) { /* silencia; tenta de novo */ _dispPollTimer = setTimeout(dispPoll, 4000); }
}

async function dispPausar() {
  if (!_dispCampanhaAtual) return;
  await api(`/api/disparos/${_dispCampanhaAtual}/pausar`, { method: 'POST', body: '{}' });
  if (_dispPollTimer) clearTimeout(_dispPollTimer);
  toast('⏸ Pausado'); dispCarregarCampanhas();
}

async function dispRetomar(id) {
  const r = await api(`/api/disparos/${id}/retomar`, { method: 'POST', body: '{}' });
  if (r.error) { toast('❌ ' + r.error, true); return; }
  _dispCampanhaAtual = id;
  document.getElementById('disp-progresso').style.display = 'block';
  toast('▶ Retomado'); dispPoll(); dispCarregarAviso();
}

async function dispCarregarCampanhas() {
  const el = document.getElementById('disp-campanhas');
  if (!el) return;
  try {
    const camps = await api('/api/disparos');
    if (!camps.length) { el.innerHTML = '<div class="empty-small">Nenhuma campanha ainda.</div>'; return; }
    const STAT = { rascunho: '📝 Rascunho', enviando: '📤 Enviando', pausada: '⏸ Pausada', concluida: '✅ Concluída' };
    el.innerHTML = camps.map(c => `
      <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <strong>${escHtml(c.nome)}</strong>
          <span style="font-size:12px;color:var(--muted)">${STAT[c.status] || c.status}${c.auto_pausada ? ' ⚠️ interrompida' : ''}</span>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">
          ${escHtml(c.template_nome)} · ${c.enviados}/${c.total} enviados${c.falhas ? ` · ${c.falhas} falhas` : ''}
        </div>
        ${['pausada'].includes(c.status) ? `<button class="btn btn-primary" style="font-size:11px;padding:4px 10px;margin-top:6px" onclick="dispRetomar(${c.id})">▶ Retomar</button>` : ''}
      </div>`).join('');
  } catch (e) { el.innerHTML = '<div class="empty-small" style="color:var(--red)">Erro ao carregar campanhas</div>'; }
}

async function dispCarregarAviso() {
  const box = document.getElementById('disp-banner-interrompida');
  if (!box) return;
  try {
    const r = await api('/api/disparos/pendentes-aviso');
    const camps = r.campanhas || [];
    if (!camps.length) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.innerHTML = camps.map(c =>
      `⚠️ A campanha <strong>${escHtml(c.nome)}</strong> foi interrompida em ${c.enviados}/${c.total}. `
      + `<button class="btn btn-primary" style="font-size:11px;padding:3px 8px" onclick="dispRetomar(${c.id})">Retomar</button>`
    ).join('<br>');
  } catch (e) { box.style.display = 'none'; }
}
```

- [ ] **Step 3: Testar no navegador (manual rápido)**

Subir o servidor local (`npm start` se houver envs) ou validar após deploy. Abrir a página Disparos: a área "📢 Disparo em Massa" e "📋 Campanhas" aparecem; o select de templates lista só aprovados.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(disparos): UI de disparo em massa e historico de campanhas"
```

---

## Task 7: Frontend — aba "📢 Disparos" no perfil do lead + badge na sidebar

**Files:**
- Modify: `public/index.html` (tabs do modal ~linha 1500, conteúdo das tabs ~1599, link da sidebar ~642, `abrirLead`/`setTab`)

- [ ] **Step 1: Adicionar o botão da aba**

Após o botão da aba Chamadas (linha ~1504):

```html
    <button class="tab" data-tab="disparos-lead" onclick="setTab('disparos-lead',this)">📢 Disparos</button>
```

- [ ] **Step 2: Adicionar o conteúdo da aba**

Após o `<div class="tab-content" id="tab-chamadas">...</div>` (linha ~1601):

```html
  <!-- TAB: DISPAROS DO LEAD -->
  <div class="tab-content" id="tab-disparos-lead">
    <div id="disparos-lead-lista"><div class="empty-small">Carregando...</div></div>
  </div>
```

- [ ] **Step 3: Carregar os disparos ao abrir o lead**

Na função `abrirLead` (perto de `carregarLigacoes(id);`, linha ~2181), adicionar:

```javascript
    carregarDisparosLead(id);
```

E adicionar a função (perto de `carregarLigacoes`):

```javascript
async function carregarDisparosLead(leadId) {
  const div = document.getElementById('disparos-lead-lista');
  if (!div) return;
  try {
    const lista = await api(`/api/leads/${leadId}/disparos`);
    if (!lista.length) { div.innerHTML = '<div class="empty-small">Nenhum disparo recebido.</div>'; return; }
    const ENTREGA = { sent: '✓ enviado', delivered: '✓✓ entregue', read: '✓✓ lido', failed: '⚠️ não entregue' };
    div.innerHTML = lista.map(d => {
      const ent = d.entrega?.wa_status ? ENTREGA[d.entrega.wa_status] || d.entrega.wa_status : (d.status_envio === 'falha' ? '⚠️ falhou' : '—');
      const cor = (d.entrega?.wa_status === 'failed' || d.status_envio === 'falha') ? 'var(--red)' : 'var(--muted)';
      return `<div style="border-bottom:1px solid var(--border);padding:8px 0">
        <div style="font-size:13px"><strong>${escHtml(d.campanha || d.template)}</strong></div>
        <div style="font-size:11.5px;color:${cor}">${d.enviado_em ? _fmtDateFull(d.enviado_em) : ''} · ${ent}</div>
      </div>`;
    }).join('');
  } catch (e) {
    div.innerHTML = '<div class="empty-small" style="color:var(--red)">Erro ao carregar disparos</div>';
  }
}
```

- [ ] **Step 4: Badge de interrupção na sidebar**

No link de Disparos da sidebar (linha ~642, o `<button ... data-page="disparos" ...>`), adicionar um `<span>` para o badge dentro do botão, ao final do texto:

```html
    Disparos <span id="nav-disp-badge" style="display:none;color:var(--red);font-weight:700">•</span>
```

E na função de inicialização do app (onde já se chamam loaders pós-login — ex.: junto de onde o nav é montado), adicionar uma checagem leve que liga o badge:

```javascript
async function atualizarBadgeDisparos() {
  try {
    const r = await api('/api/disparos/pendentes-aviso');
    const b = document.getElementById('nav-disp-badge');
    if (b) b.style.display = (r.campanhas && r.campanhas.length) ? 'inline' : 'none';
  } catch (e) { /* silencioso */ }
}
```

Onde chamar `atualizarBadgeDisparos()`: localizar a função que roda uma vez após o login e monta o nav/contagens iniciais — buscar no `index.html` por `filtrarNavPorRoles`, `aplicarRoles`, ou pela primeira chamada a `setPage(` após autenticar (é o ponto que liga a sidebar). Chamar `atualizarBadgeDisparos()` ali. Como rede de segurança, chamar também no fim de `loadDisparos()` (garante atualização quando a página Disparos é aberta). Só atende admin/gestor/crc_comercial; usuários sem esse role recebem 403 silencioso no fetch (já tratado pelo `catch`).

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(disparos): aba de disparos no perfil do lead e badge na sidebar"
```

---

## Task 8: Validação manual ponta-a-ponta + deploy

**Files:** nenhum (operacional)

- [ ] **Step 1: Rodar a suíte de testes**

Run: `npm test`
Expected: PASS (parser + matching verdes).

- [ ] **Step 2: Sanity de sintaxe**

Run: `node --check server.js`
Expected: sem erro.

- [ ] **Step 3: Push + deploy**

```bash
git push -u origin feat/disparo-em-massa
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

- [ ] **Step 4: Teste de fumaça em produção com lista pequena**

Criar um CSV de teste com 2 contatos (um que já é lead, um novo) e disparar um template aprovado de baixo risco. Conferir:
- Preview mostra "1 já é lead · 1 será criado".
- Progresso anda e conclui.
- O lead novo aparece em Leads com origem `disparo-csv` e etiqueta = nome da campanha.
- Aba "📢 Disparos" do lead mostra o disparo com status de entrega.
- Campanha aparece em "📋 Campanhas" como Concluída.

- [ ] **Step 5: Disparo real Invisalign**

Subir `wa_3_orcamento_invisalign_ortodontia.csv` (245), template Invisalign aprovado, iniciar. Acompanhar o progresso (~10 min). Conferir contagem final de enviados/falhas.

---

## Notas de validação cruzada com a spec

- **Não cria lead duplicado:** matching por últimos 8 + `chaveTelefone` (Task 3), nunca carrega tabela inteira (footgun das 1000 linhas evitado).
- **Lead leve espelha shape de `/api/leads`:** Task 4 `criarLeadLeve`.
- **Registro no perfil:** aba "📢 Disparos" (Task 7) + evento `disparo_massa` na timeline do Trajeto via `logEvento` (Task 4). Mini-timeline do modal não é alterada (decisão da spec).
- **Aviso de interrupção:** `recuperarOrfas` no boot (Task 5) + banner + badge (Tasks 6/7). O **push web** (best-effort na spec) fica **deferido** nesta fase — depende das chaves VAPID, hoje instáveis no Easypanel (ver pendências). O banner + badge são a garantia, conforme a spec já definiu.
- **Uma campanha por vez:** checagem 409 em iniciar/retomar (Task 5).
- **Ritmo seguro:** `PAUSA_MS=2500` no runner (Task 4).
- **Limite de 200kb:** CSV cru via multer/texto, parse no servidor (Tasks 2/5).
- **Status de entrega:** lê `mensagens.wa_status`/`wa_erro` (Task 5).
