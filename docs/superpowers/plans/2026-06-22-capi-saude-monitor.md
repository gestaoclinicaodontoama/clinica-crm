# Monitor de Saúde do CAPI — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detectar automaticamente quando o envio de eventos CAPI quebra (falhas, silêncio, erro novo, queda de volume) e dar visibilidade da contagem de eventos por semana, via dashboard + alertas + resumos diários.

**Architecture:** Lógica pura em `lib/capi/health.js` (recebe linhas do `lead_eventos`, devolve agregações e estados de gatilho — testável sem banco). `server.js` faz as queries, expõe o endpoint do dashboard, e roda os crons (alerta self-healing + resumos 8h/18h idempotentes). Fase 2 adiciona o cross-check com a Meta, isolado e degradável.

**Tech Stack:** Node 18+ / Express, Supabase (Postgres), web-push (já configurado), test runner nativo `node --test`. Sem novas dependências.

## Global Constraints

- Testes: arquivos `lib/**/*.test.js`, rodados por `npm test` (`node --test "lib/**/*.test.js"`). Use `node:test` + `node:assert/strict`.
- Fuso de referência para dias/semanas: **America/Sao_Paulo**. Semana = segunda a domingo.
- Migrations: arquivos em `supabase/migrations/<timestamp>_<nome>.sql`, aplicadas via MCP Supabase (`apply_migration`), project `mtqdpjhhqzvuklnlfpvi`. Verificar com `list_migrations`.
- Notificações: `criarNotificacao(usuarioId, tipo, titulo, corpo, { url })` (já existe em `server.js`). Destinatários: `profiles` com `roles` contendo `admin` ou `gestor`.
- Auth de endpoint: `requireAuth` + `requireGestor` (já existem; `requireGestor = requireRole('gestor','admin')`).
- Deploy: após `git push`, `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`.
- NÃO alterar `dispararConversaoMeta` — `lead_eventos` (tipo `capi_disparado`) é a fonte e já está pronta.
- Datasets monitorados (constante): `904146029308947` (página 106 Dr. Marcos) e `981176104681444` (página 1204 Clínica AMA).

**Forma normalizada de um evento** (produzida pelo mapper `normalizar`, consumida por todas as funções de `health.js`):
```
{
  ts: Date,                 // criado_em
  evento: string,           // 'LeadSubmitted' | 'LeadQualified' | 'Schedule' | 'Contact' | 'Purchase'
  sucesso: boolean,         // metadata.sucesso === 'true' || === true
  httpStatus: number|null,
  subcode: string|null,     // metadata.resposta_meta.error.error_subcode
  pageId: string|null,      // metadata.payload_enviado.user_data.page_id
  isCTWA: boolean,          // actionSource é business_messaging|system_generated
  has: { telefone:bool, email:bool, nome:bool, ctwa_clid:bool, page_id:bool }
}
```

---

## FASE 1 — Núcleo (independe da Meta)

### Task 1: Migration `capi_monitor_estado` + colunas de idempotência

**Files:**
- Create: `supabase/migrations/20260622100000_capi_monitor.sql`

**Interfaces:**
- Produces: tabela `capi_monitor_estado(gatilho, escopo, status, fingerprint, ultimo_alerta_em, detalhe, atualizado_em)`; colunas `app_config.capi_resumo_8h_ultimo`, `capi_resumo_18h_ultimo` (date).

- [ ] **Step 1: Escrever a migration**

```sql
-- supabase/migrations/20260622100000_capi_monitor.sql
create table if not exists capi_monitor_estado (
  id bigint generated always as identity primary key,
  gatilho text not null,
  escopo text,
  status text not null default 'ok',         -- 'ok' | 'alertado'
  fingerprint text,
  ultimo_alerta_em timestamptz,
  detalhe jsonb,
  atualizado_em timestamptz not null default now(),
  unique (gatilho, escopo)
);

-- idempotência dos resumos diários (claim atômico, padrão do resumo_crc)
alter table app_config add column if not exists capi_resumo_8h_ultimo date;
alter table app_config add column if not exists capi_resumo_18h_ultimo date;
```

- [ ] **Step 2: Aplicar via MCP Supabase**

Use `apply_migration` (project `mtqdpjhhqzvuklnlfpvi`, name `capi_monitor`) com o SQL acima.

- [ ] **Step 3: Verificar**

Use `list_migrations` e confirme que `capi_monitor` aparece. Rode `execute_sql`: `select count(*) from capi_monitor_estado;` (espera 0, sem erro).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260622100000_capi_monitor.sql
git commit -m "feat(capi-monitor): migration estado dos gatilhos + idempotência dos resumos"
```

---

### Task 2: `health.js` — normalizar + agregações

**Files:**
- Create: `lib/capi/health.js`
- Test: `lib/capi/health.test.js`

**Interfaces:**
- Produces:
  - `normalizar(leadEvento) -> NormRow` (NormRow = forma normalizada acima)
  - `contagensPorSemana(rows, agora) -> { atual: {EVENTO:{enviados,sucesso,falha}}, anterior: {...} }`
  - `coberturaMatch(rows) -> { telefone, email, nome, ctwa_clid, page_id }` (percentuais 0–100)
  - `totais7d(rows, agora) -> { total, sucesso, falha, porPagina: {pageId:{sucesso,falha}} }`
  - `EVENTOS = ['LeadSubmitted','LeadQualified','Schedule','Contact','Purchase']`

- [ ] **Step 1: Escrever os testes**

```js
// lib/capi/health.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./health');

function ev(over = {}) {
  return {
    criado_em: over.criado_em || '2026-06-22T12:00:00-03:00',
    metadata: {
      evento: over.evento || 'LeadSubmitted',
      sucesso: over.sucesso === undefined ? 'true' : String(over.sucesso),
      http_status: over.http || '200',
      action_source: over.action_source || 'business_messaging',
      payload_enviado: { user_data: over.user_data || { ph: ['x'], page_id: '1204513262736152', ctwa_clid: 'c' } },
      resposta_meta: over.subcode ? { error: { error_subcode: over.subcode } } : { events_received: 1 },
    },
  };
}

test('normalizar extrai os campos', () => {
  const n = h.normalizar(ev({ evento: 'Schedule', sucesso: false, http: '400', subcode: '2804065' }));
  assert.equal(n.evento, 'Schedule');
  assert.equal(n.sucesso, false);
  assert.equal(n.subcode, '2804065');
  assert.equal(n.pageId, '1204513262736152');
  assert.equal(n.has.telefone, true);
  assert.equal(n.has.email, false);
});

test('contagensPorSemana separa atual x anterior e soma sucesso/falha', () => {
  const agora = new Date('2026-06-24T12:00:00-03:00'); // quarta — semana de 22 a 28
  const rows = [
    h.normalizar(ev({ criado_em: '2026-06-23T10:00:00-03:00', evento: 'LeadSubmitted', sucesso: true })),
    h.normalizar(ev({ criado_em: '2026-06-23T11:00:00-03:00', evento: 'LeadSubmitted', sucesso: false, subcode: '2804065' })),
    h.normalizar(ev({ criado_em: '2026-06-18T11:00:00-03:00', evento: 'LeadSubmitted', sucesso: true })), // semana anterior
  ];
  const c = h.contagensPorSemana(rows, agora);
  assert.equal(c.atual.LeadSubmitted.enviados, 2);
  assert.equal(c.atual.LeadSubmitted.sucesso, 1);
  assert.equal(c.atual.LeadSubmitted.falha, 1);
  assert.equal(c.anterior.LeadSubmitted.sucesso, 1);
});

test('coberturaMatch: ctwa_clid/page_id só sobre CTWA; telefone sobre todos', () => {
  const rows = [
    h.normalizar(ev({ user_data: { ph: ['x'], page_id: 'p', ctwa_clid: 'c' }, action_source: 'business_messaging' })),
    h.normalizar(ev({ user_data: { ph: ['x'] }, action_source: 'website' })), // não-CTWA, sem page_id
  ];
  const cov = h.coberturaMatch(rows);
  assert.equal(cov.telefone, 100);     // 2/2
  assert.equal(cov.page_id, 100);      // 1/1 dos CTWA
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL (`Cannot find module './health'`).

- [ ] **Step 3: Implementar `health.js` (agregações)**

```js
// lib/capi/health.js
const EVENTOS = ['LeadSubmitted', 'LeadQualified', 'Schedule', 'Contact', 'Purchase'];
const TZ = 'America/Sao_Paulo';

function normalizar(le) {
  const m = le.metadata || {};
  const ud = (m.payload_enviado && m.payload_enviado.user_data) || {};
  const as = m.action_source || '';
  return {
    ts: new Date(le.criado_em),
    evento: m.evento || null,
    sucesso: m.sucesso === true || m.sucesso === 'true',
    httpStatus: m.http_status ? Number(m.http_status) : null,
    subcode: (m.resposta_meta && m.resposta_meta.error && m.resposta_meta.error.error_subcode)
      ? String(m.resposta_meta.error.error_subcode) : null,
    pageId: ud.page_id || null,
    isCTWA: as === 'business_messaging' || as === 'system_generated',
    has: {
      telefone: !!ud.ph, email: !!ud.em, nome: !!ud.fn,
      ctwa_clid: !!ud.ctwa_clid, page_id: !!ud.page_id,
    },
  };
}

// Segunda-feira 00:00 BRT da semana que contém `d`.
function inicioSemana(d) {
  const ymd = d.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD no fuso BRT
  const base = new Date(`${ymd}T00:00:00-03:00`);
  const dow = (base.getDay() + 6) % 7; // 0 = segunda
  return new Date(base.getTime() - dow * 86400000);
}

function _bucket() { return { enviados: 0, sucesso: 0, falha: 0 }; }
function _add(acc, r) { acc.enviados++; r.sucesso ? acc.sucesso++ : acc.falha++; }

function contagensPorSemana(rows, agora = new Date()) {
  const ini = inicioSemana(agora);
  const iniAnt = new Date(ini.getTime() - 7 * 86400000);
  const atual = {}, anterior = {};
  for (const e of EVENTOS) { atual[e] = _bucket(); anterior[e] = _bucket(); }
  for (const r of rows) {
    if (!EVENTOS.includes(r.evento)) continue;
    if (r.ts >= ini) _add(atual[r.evento], r);
    else if (r.ts >= iniAnt && r.ts < ini) _add(anterior[r.evento], r);
  }
  return { atual, anterior };
}

function coberturaMatch(rows) {
  const tot = rows.length || 1;
  const ctwa = rows.filter(r => r.isCTWA);
  const totC = ctwa.length || 1;
  const pct = (n, d) => Math.round((n / d) * 100);
  return {
    telefone: pct(rows.filter(r => r.has.telefone).length, tot),
    email: pct(rows.filter(r => r.has.email).length, tot),
    nome: pct(rows.filter(r => r.has.nome).length, tot),
    ctwa_clid: pct(ctwa.filter(r => r.has.ctwa_clid).length, totC),
    page_id: pct(ctwa.filter(r => r.has.page_id).length, totC),
  };
}

function totais7d(rows, agora = new Date()) {
  const corte = new Date(agora.getTime() - 7 * 86400000);
  const r7 = rows.filter(r => r.ts >= corte);
  const porPagina = {};
  let sucesso = 0, falha = 0;
  for (const r of r7) {
    r.sucesso ? sucesso++ : falha++;
    const k = r.pageId || '(sem página)';
    porPagina[k] = porPagina[k] || { sucesso: 0, falha: 0 };
    r.sucesso ? porPagina[k].sucesso++ : porPagina[k].falha++;
  }
  return { total: r7.length, sucesso, falha, porPagina };
}

module.exports = { EVENTOS, TZ, normalizar, inicioSemana, contagensPorSemana, coberturaMatch, totais7d };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS (3 testes de agregação).

- [ ] **Step 5: Commit**

```bash
git add lib/capi/health.js lib/capi/health.test.js
git commit -m "feat(capi-monitor): health.js normalizar + agregações (semana, cobertura, 7d) com testes"
```

---

### Task 3: `health.js` — gatilhos 1–4

**Files:**
- Modify: `lib/capi/health.js`
- Test: `lib/capi/health.test.js`

**Interfaces:**
- Produces:
  - `LIMITES` (objeto de constantes — ajustável)
  - `avaliarGatilhos(rows, agora) -> Array<{ gatilho, escopo, status:'ok'|'ruim', detalhe }>`
  - gatilhos: `taxa_falha` (escopo null), `silencio` (escopo=pageId, 1 por página ativa), `erro_novo` (escopo null), `queda_volume` (escopo null)

- [ ] **Step 1: Escrever os testes**

```js
// adicionar em lib/capi/health.test.js
const N = (over) => h.normalizar(ev(over));
function serie(n, over) { return Array.from({ length: n }, () => N(over)); }

test('gatilho taxa_falha: >30% com >=10 tentativas dispara', () => {
  const agora = new Date('2026-06-22T18:00:00-03:00');
  const t = (s) => ({ criado_em: '2026-06-22T15:00:00-03:00', sucesso: s, subcode: s ? null : '2804065', http: s ? '200' : '400' });
  const rows = [...serie(6, t(true)), ...serie(4, t(false))]; // 10 tentativas, 40% falha
  const g = h.avaliarGatilhos(rows, agora).find(x => x.gatilho === 'taxa_falha');
  assert.equal(g.status, 'ruim');
});

test('gatilho taxa_falha: <10 tentativas não dispara (guarda de volume)', () => {
  const agora = new Date('2026-06-22T18:00:00-03:00');
  const rows = serie(3, { criado_em: '2026-06-22T15:00:00-03:00', sucesso: false, subcode: '2804065', http: '400' });
  const g = h.avaliarGatilhos(rows, agora).find(x => x.gatilho === 'taxa_falha');
  assert.equal(g.status, 'ok');
});

test('gatilho silencio: página ativa 18h sem sucesso dispara', () => {
  const agora = new Date('2026-06-22T20:00:00-03:00');
  // baseline: 7 dias atrás, média >=3/dia de sucesso na página P
  const baseline = [];
  for (let d = 2; d <= 8; d++) for (let i = 0; i < 4; i++)
    baseline.push(N({ criado_em: `2026-06-${String(22 - d).padStart(2, '0')}T10:00:00-03:00`, sucesso: true, user_data: { ph: ['x'], page_id: 'P', ctwa_clid: 'c' } }));
  // janela: nenhum sucesso da página P nas últimas 18h
  const g = h.avaliarGatilhos(baseline, agora).filter(x => x.gatilho === 'silencio' && x.escopo === 'P');
  assert.equal(g.length, 1);
  assert.equal(g[0].status, 'ruim');
});

test('gatilho erro_novo: subcode inédito nas últimas 24h dispara', () => {
  const agora = new Date('2026-06-22T18:00:00-03:00');
  const rows = [
    N({ criado_em: '2026-06-10T10:00:00-03:00', sucesso: false, subcode: '2804065', http: '400' }), // histórico
    N({ criado_em: '2026-06-22T10:00:00-03:00', sucesso: false, subcode: '9999999', http: '400' }), // novo
  ];
  const g = h.avaliarGatilhos(rows, agora).find(x => x.gatilho === 'erro_novo');
  assert.equal(g.status, 'ruim');
  assert.ok(JSON.stringify(g.detalhe).includes('9999999'));
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL (`avaliarGatilhos is not a function`).

- [ ] **Step 3: Implementar os gatilhos**

```js
// adicionar em lib/capi/health.js, antes do module.exports
const LIMITES = {
  taxaFalha: { janelaH: 6, minTentativas: 10, max: 0.30 },
  silencio:  { janelaH: 18, baselineDias: 7, minMediaDia: 3 },
  erroNovo:  { janelaH: 24, historicoDias: 14 },
  quedaVolume: { semanas: 3, fracaoMin: 0.50 },
};

const _desde = (agora, horas) => new Date(agora.getTime() - horas * 3600000);

function _taxaFalha(rows, agora) {
  const r = rows.filter(x => x.ts >= _desde(agora, LIMITES.taxaFalha.janelaH));
  const det = { tentativas: r.length, falhas: r.filter(x => !x.sucesso).length };
  det.taxa = r.length ? det.falhas / r.length : 0;
  const ruim = r.length >= LIMITES.taxaFalha.minTentativas && det.taxa > LIMITES.taxaFalha.max;
  return { gatilho: 'taxa_falha', escopo: null, status: ruim ? 'ruim' : 'ok', detalhe: det };
}

function _silencio(rows, agora) {
  const { baselineDias, minMediaDia, janelaH } = LIMITES.silencio;
  const ini = _desde(agora, baselineDias * 24);
  const corteJanela = _desde(agora, janelaH);
  const porPagina = {};
  for (const r of rows) {
    if (!r.pageId) continue;
    porPagina[r.pageId] = porPagina[r.pageId] || { baselineSucesso: 0, janelaSucesso: 0 };
    if (r.sucesso && r.ts >= ini && r.ts < corteJanela) porPagina[r.pageId].baselineSucesso++;
    if (r.sucesso && r.ts >= corteJanela) porPagina[r.pageId].janelaSucesso++;
  }
  const out = [];
  for (const [page, d] of Object.entries(porPagina)) {
    const ativa = d.baselineSucesso / baselineDias >= minMediaDia;
    if (!ativa) continue;
    const ruim = d.janelaSucesso === 0;
    out.push({ gatilho: 'silencio', escopo: page, status: ruim ? 'ruim' : 'ok', detalhe: { page, ...d } });
  }
  return out;
}

function _erroNovo(rows, agora) {
  const { janelaH, historicoDias } = LIMITES.erroNovo;
  const corte = _desde(agora, janelaH);
  const iniHist = _desde(agora, historicoDias * 24);
  const hist = new Set(rows.filter(r => r.subcode && r.ts >= iniHist && r.ts < corte).map(r => r.subcode));
  const novos = [...new Set(rows.filter(r => r.subcode && r.ts >= corte).map(r => r.subcode))].filter(s => !hist.has(s));
  return { gatilho: 'erro_novo', escopo: null, status: novos.length ? 'ruim' : 'ok', detalhe: { novos } };
}

function _quedaVolume(rows, agora) {
  const { semanas, fracaoMin } = LIMITES.quedaVolume;
  const diaMs = 86400000;
  const hojeSucesso = rows.filter(r => r.sucesso && r.ts >= _desde(agora, 24)).length;
  const amostras = [];
  for (let k = 1; k <= semanas; k++) {
    const fim = new Date(agora.getTime() - k * 7 * diaMs);
    const ini = new Date(fim.getTime() - diaMs);
    amostras.push(rows.filter(r => r.sucesso && r.ts >= ini && r.ts < fim).length);
  }
  if (amostras.length < 2) return { gatilho: 'queda_volume', escopo: null, status: 'ok', detalhe: { motivo: 'sem histórico' } };
  const media = amostras.reduce((a, b) => a + b, 0) / amostras.length;
  const ruim = media > 0 && hojeSucesso < media * fracaoMin;
  return { gatilho: 'queda_volume', escopo: null, status: ruim ? 'ruim' : 'ok', detalhe: { hojeSucesso, media: Math.round(media) } };
}

function avaliarGatilhos(rows, agora = new Date()) {
  return [
    _taxaFalha(rows, agora),
    ..._silencio(rows, agora),
    _erroNovo(rows, agora),
    _quedaVolume(rows, agora),
  ];
}
```
Acrescente `LIMITES, avaliarGatilhos` ao `module.exports`.

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS (todos, incluindo os 4 novos).

- [ ] **Step 5: Commit**

```bash
git add lib/capi/health.js lib/capi/health.test.js
git commit -m "feat(capi-monitor): gatilhos 1-4 (taxa falha, silêncio, erro novo, queda volume) com testes"
```

---

### Task 4: `health.js` — dedup/transições de alerta

**Files:**
- Modify: `lib/capi/health.js`
- Test: `lib/capi/health.test.js`

**Interfaces:**
- Produces: `decidirAlertas(estadosAtuais, estadosSalvos, agora) -> { notificar: Array<{gatilho,escopo,detalhe,fingerprint}>, upserts: Array<{gatilho,escopo,status,fingerprint,ultimo_alerta_em,detalhe}> }`
- `fingerprint(estado) -> string`
- Regra: notifica na virada ok→ruim; se continua ruim, no máximo 1x a cada `COOLDOWN_H` (12); ao normalizar, grava `ok` sem notificar.

- [ ] **Step 1: Escrever os testes**

```js
// adicionar em lib/capi/health.test.js
test('decidirAlertas: ok->ruim notifica uma vez', () => {
  const agora = new Date('2026-06-22T12:00:00-03:00');
  const atuais = [{ gatilho: 'taxa_falha', escopo: null, status: 'ruim', detalhe: { taxa: 0.5 } }];
  const { notificar, upserts } = h.decidirAlertas(atuais, [], agora);
  assert.equal(notificar.length, 1);
  assert.equal(upserts[0].status, 'alertado');
});

test('decidirAlertas: ruim contínuo dentro do cooldown não re-notifica', () => {
  const agora = new Date('2026-06-22T12:00:00-03:00');
  const atuais = [{ gatilho: 'taxa_falha', escopo: null, status: 'ruim', detalhe: { taxa: 0.5 } }];
  const salvos = [{ gatilho: 'taxa_falha', escopo: null, status: 'alertado', fingerprint: h.fingerprint(atuais[0]), ultimo_alerta_em: '2026-06-22T06:00:00-03:00' }];
  const { notificar } = h.decidirAlertas(atuais, salvos, agora); // 6h depois < 12h
  assert.equal(notificar.length, 0);
});

test('decidirAlertas: ruim->ok reseta sem notificar', () => {
  const agora = new Date('2026-06-22T12:00:00-03:00');
  const atuais = [{ gatilho: 'taxa_falha', escopo: null, status: 'ok', detalhe: {} }];
  const salvos = [{ gatilho: 'taxa_falha', escopo: null, status: 'alertado' }];
  const { notificar, upserts } = h.decidirAlertas(atuais, salvos, agora);
  assert.equal(notificar.length, 0);
  assert.equal(upserts[0].status, 'ok');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL (`decidirAlertas is not a function`).

- [ ] **Step 3: Implementar**

```js
// adicionar em lib/capi/health.js
const COOLDOWN_H = 12;

function fingerprint(e) {
  // só campos estáveis do problema, sem números que oscilam a cada tick
  if (e.gatilho === 'erro_novo') return 'erro_novo:' + (e.detalhe.novos || []).join(',');
  return e.gatilho + ':' + (e.escopo || '');
}

function decidirAlertas(atuais, salvos, agora = new Date()) {
  const mapaSalvo = new Map(salvos.map(s => [s.gatilho + '|' + (s.escopo || ''), s]));
  const notificar = [], upserts = [];
  for (const e of atuais) {
    const chave = e.gatilho + '|' + (e.escopo || '');
    const prev = mapaSalvo.get(chave);
    const fp = fingerprint(e);
    if (e.status === 'ok') {
      if (prev && prev.status === 'alertado') upserts.push({ ...base(e, fp), status: 'ok', ultimo_alerta_em: prev.ultimo_alerta_em || null });
      continue;
    }
    // status ruim
    const eraAlertado = prev && prev.status === 'alertado' && prev.fingerprint === fp;
    const dentroCooldown = eraAlertado && prev.ultimo_alerta_em &&
      (agora.getTime() - new Date(prev.ultimo_alerta_em).getTime()) < COOLDOWN_H * 3600000;
    if (dentroCooldown) {
      upserts.push({ ...base(e, fp), status: 'alertado', ultimo_alerta_em: prev.ultimo_alerta_em });
    } else {
      notificar.push({ gatilho: e.gatilho, escopo: e.escopo || null, detalhe: e.detalhe, fingerprint: fp });
      upserts.push({ ...base(e, fp), status: 'alertado', ultimo_alerta_em: agora.toISOString() });
    }
  }
  return { notificar, upserts };
}
function base(e, fp) { return { gatilho: e.gatilho, escopo: e.escopo || null, fingerprint: fp, detalhe: e.detalhe }; }
```
Acrescente `decidirAlertas, fingerprint, COOLDOWN_H` ao `module.exports`.

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add lib/capi/health.js lib/capi/health.test.js
git commit -m "feat(capi-monitor): decisão de alertas com dedup/cooldown (testado)"
```

---

### Task 5: Acesso a dados + endpoint `GET /api/admin/capi-saude`

**Files:**
- Modify: `server.js` (adicionar bloco perto dos outros endpoints admin, ~após o `/api/admin/sync-status`)

**Interfaces:**
- Consumes: `lib/capi/health.js` (todas as funções da Fase 1).
- Produces:
  - `capiCarregarRows(diasAtras=21) -> Promise<NormRow[]>` (lê `lead_eventos` tipo `capi_disparado`, normaliza)
  - `GET /api/admin/capi-saude` → `{ semana, cobertura, totais7d, gatilhos, atualizadoEm }`

- [ ] **Step 1: Implementar o carregador + endpoint**

```js
// server.js — novo bloco "CAPI SAÚDE"
const capiHealth = require('./lib/capi/health');

async function capiCarregarRows(diasAtras = 21) {
  const desde = new Date(Date.now() - diasAtras * 86400000).toISOString();
  const todos = [];
  let from = 0; const passo = 1000;
  while (true) { // lead_eventos pode passar de 1000 linhas — paginar
    const { data, error } = await supabase.from('lead_eventos')
      .select('criado_em, metadata')
      .eq('tipo', 'capi_disparado').gte('criado_em', desde)
      .order('criado_em', { ascending: false }).range(from, from + passo - 1);
    if (error) throw error;
    todos.push(...(data || []));
    if (!data || data.length < passo) break;
    from += passo;
  }
  return todos.map(capiHealth.normalizar);
}

app.get('/api/admin/capi-saude', requireAuth, requireGestor, async (req, res) => {
  try {
    const agora = new Date();
    const rows = await capiCarregarRows(21);
    res.json({
      semana: capiHealth.contagensPorSemana(rows, agora),
      cobertura: capiHealth.coberturaMatch(rows.filter(r => r.ts >= new Date(agora - 7 * 86400000))),
      totais7d: capiHealth.totais7d(rows, agora),
      gatilhos: capiHealth.avaliarGatilhos(rows, agora),
      atualizadoEm: agora.toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 2: Validar sintaxe**

Run: `node --check server.js`
Expected: sem saída (OK).

- [ ] **Step 3: Smoke test manual (após deploy, ao fim da fase)** — anotar para a validação final: `GET /api/admin/capi-saude` autenticado retorna JSON com as 4 chaves.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(capi-monitor): carregador de eventos + GET /api/admin/capi-saude"
```

---

### Task 6: Cron de alerta (self-healing) + persistência + `POST recheck`

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `capiCarregarRows`, `capiHealth.{avaliarGatilhos,decidirAlertas}`, `criarNotificacao`.
- Produces: `capiChearGatilhos()` (avalia, persiste estado, notifica), cron a cada 10 min, `POST /api/admin/capi-saude/recheck`.

- [ ] **Step 1: Implementar a checagem + cron + endpoint**

```js
// server.js — abaixo do endpoint da Task 5
function _textoAlerta(n) {
  const map = {
    taxa_falha: 'Taxa de falha alta no CAPI',
    silencio: 'Página sem eventos CAPI (silêncio)',
    erro_novo: 'Novo erro no CAPI',
    queda_volume: 'Queda de volume de eventos CAPI',
    divergencia: 'Divergência enviado x registrado na Meta',
  };
  return (map[n.gatilho] || n.gatilho) + (n.escopo ? ` — ${n.escopo}` : '');
}

let _capiChecando = false;
async function capiChecarGatilhos() {
  if (_capiChecando) return;
  _capiChecando = true;
  try {
    const agora = new Date();
    const rows = await capiCarregarRows(21);
    const atuais = capiHealth.avaliarGatilhos(rows, agora);
    const { data: salvos } = await supabase.from('capi_monitor_estado').select('*');
    const { notificar, upserts } = capiHealth.decidirAlertas(atuais, salvos || [], agora);
    for (const u of upserts) {
      await supabase.from('capi_monitor_estado')
        .upsert({ ...u, atualizado_em: agora.toISOString() }, { onConflict: 'gatilho,escopo' });
    }
    if (notificar.length) {
      const { data: gestores } = await supabase.from('profiles').select('id').or('roles.cs.{admin},roles.cs.{gestor}');
      for (const n of notificar) {
        const corpo = _textoAlerta(n) + ' — veja o detalhe no monitor.';
        for (const g of gestores || []) await criarNotificacao(g.id, 'capi_alerta', 'Alerta CAPI', corpo, { url: '/capi-saude/' });
      }
      console.log('[capi-monitor] alertas enviados:', notificar.map(_textoAlerta).join(' | '));
    }
  } catch (e) { console.error('[capi-monitor] checagem falhou:', e.message); }
  finally { _capiChecando = false; }
}

setTimeout(() => capiChecarGatilhos(), 45_000);
setInterval(() => capiChecarGatilhos(), 30 * 60_000); // a cada 30 min
console.log('[capi-monitor] scheduler de alertas ativo (30 min)');

app.post('/api/admin/capi-saude/recheck', requireAuth, requireGestor, async (req, res) => {
  res.json({ ok: true, msg: 'Re-checagem disparada' });
  capiChecarGatilhos().catch(e => console.error('[capi-monitor] recheck:', e.message));
});
```

- [ ] **Step 2: Validar sintaxe**

Run: `node --check server.js`
Expected: OK.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(capi-monitor): cron de alertas self-healing + persistência + POST recheck"
```

---

### Task 7: Resumos diários 8h/18h (idempotentes)

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `capiCarregarRows`, `capiHealth.*`, `criarNotificacao`, `app_config.capi_resumo_8h_ultimo/18h_ultimo`.
- Produces: `capiEnviarResumo(slot)` (`'8h'|'18h'`), cron self-healing.

- [ ] **Step 1: Implementar o resumo + cron**

```js
// server.js — abaixo da Task 6
function _resumoTexto(rows, slot, agora) {
  const t = capiHealth.totais7d(rows, agora);
  const g = capiHealth.avaliarGatilhos(rows, agora).filter(x => x.status === 'ruim');
  const cab = slot === '8h' ? 'Saúde CAPI (ontem)' : 'Saúde CAPI (hoje até agora)';
  const status = g.length ? `⚠️ ${g.length} alerta(s)` : '✅ tudo ok';
  return `${cab}: ${status}. 7d: ${t.sucesso} ok / ${t.falha} falha.`;
}

async function capiEnviarResumo(slot, force = false) {
  const col = slot === '8h' ? 'capi_resumo_8h_ultimo' : 'capi_resumo_18h_ultimo';
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  if (!force) {
    const { data: claimed, error } = await supabase.from('app_config')
      .update({ [col]: hoje }).eq('id', 1)
      .or(`${col}.is.null,${col}.neq.${hoje}`).select('id');
    if (error || !claimed || !claimed.length) return false; // já enviado hoje
  } else {
    await supabase.from('app_config').update({ [col]: hoje }).eq('id', 1);
  }
  const rows = await capiCarregarRows(21);
  const texto = _resumoTexto(rows, slot, new Date());
  const { data: gestores } = await supabase.from('profiles').select('id').or('roles.cs.{admin},roles.cs.{gestor}');
  for (const gst of gestores || []) await criarNotificacao(gst.id, 'capi_resumo', 'Resumo CAPI', texto, { url: '/capi-saude/' });
  console.log('[capi-monitor] resumo', slot, 'enviado:', texto);
  return true;
}

// scheduler self-healing dos resumos (claim atômico evita duplicação entre ticks/instâncias)
(function agendarResumosCapi() {
  function horaBRT() { return Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false })); }
  async function tick() {
    const hh = horaBRT();
    try {
      if (hh >= 8 && hh < 18) await capiEnviarResumo('8h');
      if (hh >= 18) await capiEnviarResumo('18h');
    } catch (e) { console.error('[capi-monitor] resumo tick:', e.message); }
  }
  setTimeout(() => tick().catch(() => {}), 60_000);
  setInterval(() => tick().catch(() => {}), 15 * 60_000);
  console.log('[capi-monitor] scheduler de resumos 8h/18h ativo');
})();
```

- [ ] **Step 2: Validar sintaxe**

Run: `node --check server.js`
Expected: OK.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(capi-monitor): resumos diários 8h/18h idempotentes (push aos gestores)"
```

---

### Task 8: Página `/capi-saude/` + nav

**Files:**
- Create: `public/capi-saude/index.html`
- Create: `public/js/capi-saude/api.js`
- Modify: `public/js/nav-config.js` (adicionar item ao `CRM_NAV`)

**Interfaces:**
- Consumes: `GET /api/admin/capi-saude`, `POST /api/admin/capi-saude/recheck`.

- [ ] **Step 1: Criar o `api.js` da página**

```js
// public/js/capi-saude/api.js
function _token() {
  for (const k of Object.keys(localStorage))
    if (k.startsWith('sb-') && k.endsWith('-auth-token'))
      try { return JSON.parse(localStorage.getItem(k)).access_token; } catch {}
  return null;
}
async function capiApi(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _token(), ...(opts.headers || {}) } });
  if (r.status === 401) { location.href = '/'; return; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('Erro ' + r.status));
  return j;
}
window.capiApi = capiApi;
```

- [ ] **Step 2: Criar a página**

```html
<!-- public/capi-saude/index.html -->
<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Saúde do CAPI</title>
<link rel="stylesheet" href="/css/app.css">
</head><body>
<script src="/js/shared-nav.js" data-active="capi-saude"></script>
<main class="crm-content" style="padding:16px">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
    <h1 id="status" style="font-size:18px">Saúde do CAPI</h1>
    <button id="recheck" class="btn">Re-checar agora</button>
  </div>
  <p id="atualizado" style="color:#666;font-size:12px"></p>
  <section id="cards"></section>
  <h2 style="font-size:15px;margin-top:16px">Eventos por semana</h2>
  <table id="tab-semana" border="0" cellpadding="6" style="width:100%;border-collapse:collapse"></table>
  <h2 style="font-size:15px;margin-top:16px">Qualidade do match</h2>
  <div id="cobertura"></div>
  <h2 style="font-size:15px;margin-top:16px">Gatilhos</h2>
  <div id="gatilhos"></div>
</main>
<script src="/js/capi-saude/api.js"></script>
<script>
const EVS = ['LeadSubmitted','LeadQualified','Schedule','Contact','Purchase'];
function cell(v){ return '<td style="border-bottom:1px solid #eee">'+v+'</td>'; }
async function carregar() {
  const d = await capiApi('/api/admin/capi-saude');
  const ruins = d.gatilhos.filter(g=>g.status==='ruim').length;
  document.getElementById('status').textContent = 'Saúde do CAPI — ' + (ruins ? ('⚠️ '+ruins+' alerta(s)') : '✅ tudo ok');
  document.getElementById('atualizado').textContent = 'Atualizado: ' + new Date(d.atualizadoEm).toLocaleString('pt-BR');
  // cartões 7d
  const t = d.totais7d, pct = t.total ? Math.round(t.sucesso/t.total*100) : 0;
  let cards = `<div>Últimos 7 dias: <b>${t.total}</b> tentativas · <b>${pct}%</b> sucesso · ${t.falha} falha</div>`;
  cards += '<div style="margin-top:6px">' + Object.entries(t.porPagina).map(([p,v])=>`Página ${p}: ${v.sucesso}✓ / ${v.falha}✗`).join(' &nbsp;|&nbsp; ') + '</div>';
  document.getElementById('cards').innerHTML = cards;
  // tabela semana
  let h = '<tr><th align="left">Evento</th><th>Sem. atual (✓/✗)</th><th>Sem. anterior (✓/✗)</th></tr>';
  for (const e of EVS) { const a=d.semana.atual[e], b=d.semana.anterior[e];
    h += '<tr>'+cell(e)+cell(`${a.sucesso}/${a.falha} (${a.enviados})`)+cell(`${b.sucesso}/${b.falha} (${b.enviados})`)+'</tr>'; }
  document.getElementById('tab-semana').innerHTML = h;
  // cobertura
  document.getElementById('cobertura').innerHTML = Object.entries(d.cobertura).map(([k,v])=>`${k}: <b>${v}%</b>`).join(' &nbsp;·&nbsp; ');
  // gatilhos
  document.getElementById('gatilhos').innerHTML = d.gatilhos.map(g=>`<div>${g.status==='ruim'?'🔴':'🟢'} ${g.gatilho}${g.escopo?(' ('+g.escopo+')'):''}</div>`).join('');
}
document.getElementById('recheck').onclick = async () => { await capiApi('/api/admin/capi-saude/recheck',{method:'POST'}); setTimeout(carregar, 1500); };
carregar().catch(e=>{ document.getElementById('status').textContent = 'Erro: '+e.message; });
</script>
</body></html>
```

- [ ] **Step 3: Adicionar o item de menu**

Em `public/js/nav-config.js`, no array `CRM_NAV` (perto de `monitor-crc`), adicionar:
```js
{ slug: 'capi-saude', label: 'Saúde do CAPI', icon: 'funil', roles: 'admin,gestor', mode: 'link', href: '/capi-saude/' },
```
(Use um `icon` existente do `PATHS`; `funil` serve. Ajuste se houver um mais adequado.)

- [ ] **Step 4: Validação manual (após deploy)** — abrir `/capi-saude/` logado como admin/gestor: status, cartões, tabela semanal, cobertura e gatilhos renderizam; botão "Re-checar agora" recarrega.

- [ ] **Step 5: Commit + deploy**

```bash
git add public/capi-saude/index.html public/js/capi-saude/api.js public/js/nav-config.js
git commit -m "feat(capi-monitor): página /capi-saude/ + item no menu"
git push origin main
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

- [ ] **Step 6: Validação manual ponta-a-ponta (Fase 1)** — após o deploy: abrir a página, conferir números contra um `execute_sql` manual no `lead_eventos` (contagem por evento na semana), clicar "Re-checar agora" e confirmar nos logs `[capi-monitor]`. **Fim da Fase 1 — o monitor já evita "dias sem perceber".**

---

## FASE 2 — Cross-check com a Meta

### Task 9: Spike de viabilidade dos endpoints Graph (stats + EMQ)

**Files:**
- Create: `lib/capi/metaStats.js`
- Create: `scripts/spike-meta-stats.js`

**Interfaces:**
- Produces: `buscarStatsDataset(datasetId, token) -> { porEvento: {EVENTO:int}, total:int }` e `buscarEmq(datasetId, token) -> number|null`; **decisão documentada** de quais endpoints Graph funcionam.

- [ ] **Step 1: Escrever o script de spike**

```js
// scripts/spike-meta-stats.js — roda manualmente no servidor (tem env)
const TOKEN = process.env.META_ACCESS_TOKEN;
const V = process.env.META_API_VERSION || 'v21.0';
const datasets = ['904146029308947', '981176104681444'];
(async () => {
  for (const d of datasets) {
    for (const path of [`${d}/stats`, `${d}/event_stats`, `${d}`]) {
      try {
        const r = await fetch(`https://graph.facebook.com/${V}/${path}?access_token=${TOKEN}`);
        console.log(path, r.status, (await r.text()).slice(0, 300));
      } catch (e) { console.log(path, 'ERRO', e.message); }
    }
  }
})();
```

- [ ] **Step 2: Rodar no servidor e anotar o que responde**

Pedir ao Luiz para rodar via console do Easypanel (ou endpoint admin temporário): `node scripts/spike-meta-stats.js`. **Registrar no spec/plano qual endpoint devolve contagem por evento e se há EMQ.** Se NENHUM devolver dado confiável: marcar Fase 2 como "cross-check indisponível" e **parar aqui** (a Fase 1 já entrega o valor central) — Tasks 10–12 ficam pendentes até a Meta expor o dado.

- [ ] **Step 3: Implementar `metaStats.js` conforme o endpoint que funcionou**

```js
// lib/capi/metaStats.js — preencher o parse conforme o resultado do spike
async function buscarStatsDataset(datasetId, token, fetchImpl = fetch) {
  const V = process.env.META_API_VERSION || 'v21.0';
  const r = await fetchImpl(`https://graph.facebook.com/${V}/${datasetId}/stats?access_token=${token}`);
  if (!r.ok) return null; // indisponível
  const j = await r.json();
  // TODO-spike: mapear j -> { porEvento, total } conforme formato real confirmado no Step 2
  return parseStats(j);
}
function parseStats(j) { /* preencher após spike */ return { porEvento: {}, total: 0 }; }
async function buscarEmq(datasetId, token, fetchImpl = fetch) {
  // preencher conforme spike; se não houver endpoint público, retornar null sempre
  return null;
}
module.exports = { buscarStatsDataset, buscarEmq, parseStats };
```

- [ ] **Step 4: Teste do parser com a resposta real capturada**

Criar `lib/capi/metaStats.test.js` com um caso usando o JSON **real** capturado no Step 2 (mock de `fetchImpl`), afirmando `porEvento`/`total`. Run: `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/capi/metaStats.js lib/capi/metaStats.test.js scripts/spike-meta-stats.js
git commit -m "feat(capi-monitor): spike + metaStats (parser de stats do dataset) testado"
```

---

### Task 10: Migration `capi_meta_snapshot`

**Files:**
- Create: `supabase/migrations/20260622110000_capi_meta_snapshot.sql`

- [ ] **Step 1: Escrever a migration**

```sql
create table if not exists capi_meta_snapshot (
  id bigint generated always as identity primary key,
  data date not null,
  dataset_id text not null,
  evento text,
  enviados_sucesso int not null default 0,
  registrados_meta int,
  emq numeric,
  criado_em timestamptz not null default now(),
  unique (data, dataset_id, evento)
);
alter table app_config add column if not exists capi_crosscheck_ultimo date;
```

- [ ] **Step 2: Aplicar via MCP + verificar com `list_migrations`.**

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260622110000_capi_meta_snapshot.sql
git commit -m "feat(capi-monitor): migration capi_meta_snapshot + marcador de cross-check"
```

---

### Task 11: Job de cross-check diário (idempotente)

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `capiCarregarRows`, `metaStats.buscarStatsDataset/buscarEmq`, datasets monitorados.
- Produces: `capiCrossCheck()` (grava `capi_meta_snapshot` do dia), cron ~6h.

- [ ] **Step 1: Implementar**

```js
// server.js
const metaStats = require('./lib/capi/metaStats');
const CAPI_DATASETS_POR_PAGINA = { '106183378976777': '904146029308947', '1204513262736152': '981176104681444' };
const CAPI_DATASETS = ['904146029308947', '981176104681444'];

async function capiCrossCheck(force = false) {
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  if (!force) {
    const { data: claimed, error } = await supabase.from('app_config')
      .update({ capi_crosscheck_ultimo: hoje }).eq('id', 1)
      .or(`capi_crosscheck_ultimo.is.null,capi_crosscheck_ultimo.neq.${hoje}`).select('id');
    if (error || !claimed || !claimed.length) return false;
  }
  const rows = await capiCarregarRows(2);
  const ontem = new Date(Date.now() - 24 * 86400000);
  for (const ds of CAPI_DATASETS) {
    const stats = await metaStats.buscarStatsDataset(ds, process.env.META_ACCESS_TOKEN).catch(() => null);
    const emq = await metaStats.buscarEmq(ds, process.env.META_ACCESS_TOKEN).catch(() => null);
    const pagina = Object.keys(CAPI_DATASETS_POR_PAGINA).find(p => CAPI_DATASETS_POR_PAGINA[p] === ds);
    for (const e of capiHealth.EVENTOS) {
      const enviados = rows.filter(r => r.pageId === pagina && r.evento === e && r.sucesso && r.ts >= ontem).length;
      await supabase.from('capi_meta_snapshot').upsert({
        data: hoje, dataset_id: ds, evento: e,
        enviados_sucesso: enviados,
        registrados_meta: stats && stats.porEvento ? (stats.porEvento[e] ?? null) : null,
      }, { onConflict: 'data,dataset_id,evento' });
    }
    await supabase.from('capi_meta_snapshot').upsert({ data: hoje, dataset_id: ds, evento: null, enviados_sucesso: 0, emq }, { onConflict: 'data,dataset_id,evento' });
  }
  console.log('[capi-monitor] cross-check gravado para', hoje);
  return true;
}

(function agendarCrossCheck() {
  function horaBRT() { return Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false })); }
  async function tick() { try { if (horaBRT() >= 6) await capiCrossCheck(); } catch (e) { console.error('[capi-monitor] crosscheck tick:', e.message); } }
  setTimeout(() => tick().catch(() => {}), 90_000);
  setInterval(() => tick().catch(() => {}), 30 * 60_000);
  console.log('[capi-monitor] scheduler de cross-check ativo (>=6h BRT)');
})();
```

- [ ] **Step 2: `node --check server.js` → OK. Commit.**

```bash
git add server.js
git commit -m "feat(capi-monitor): job de cross-check diário com a Meta (idempotente)"
```

---

### Task 12: Gatilho 5 + seção "enviamos vs registrou" no dashboard

**Files:**
- Modify: `lib/capi/health.js` (+ teste), `server.js` (endpoint inclui snapshot + gatilho 5), `public/capi-saude/index.html`

**Interfaces:**
- Produces: `avaliarDivergencia(snapshotRows) -> {gatilho:'divergencia', escopo:dataset, status, detalhe}[]`; endpoint passa a devolver `crosscheck`.

- [ ] **Step 1: Teste do gatilho 5**

```js
// lib/capi/health.test.js
test('divergencia: Meta < 50% do enviado com >=20 dispara', () => {
  const snap = [{ dataset_id: '981176104681444', enviados_sucesso: 30, registrados_meta: 10 }];
  const g = h.avaliarDivergencia(snap).find(x => x.escopo === '981176104681444');
  assert.equal(g.status, 'ruim');
});
test('divergencia: <20 enviados não dispara (guarda)', () => {
  const snap = [{ dataset_id: 'x', enviados_sucesso: 10, registrados_meta: 0 }];
  assert.equal(h.avaliarDivergencia(snap)[0].status, 'ok');
});
```

- [ ] **Step 2: Implementar `avaliarDivergencia`**

```js
// lib/capi/health.js
LIMITES.divergencia = { minEnviados: 20, fracaoMin: 0.50 };
function avaliarDivergencia(snapshotRows) {
  const porDs = {};
  for (const s of snapshotRows) {
    if (s.registrados_meta == null) continue;
    porDs[s.dataset_id] = porDs[s.dataset_id] || { enviados: 0, registrados: 0 };
    porDs[s.dataset_id].enviados += s.enviados_sucesso || 0;
    porDs[s.dataset_id].registrados += s.registrados_meta || 0;
  }
  return Object.entries(porDs).map(([ds, v]) => {
    const ruim = v.enviados >= LIMITES.divergencia.minEnviados && v.registrados < v.enviados * LIMITES.divergencia.fracaoMin;
    return { gatilho: 'divergencia', escopo: ds, status: ruim ? 'ruim' : 'ok', detalhe: v };
  });
}
```
Exportar `avaliarDivergencia`. Run `npm test` → PASS.

- [ ] **Step 3: Ligar no endpoint e no cron**

Em `GET /api/admin/capi-saude` e em `capiChecarGatilhos`, carregar o snapshot de hoje:
```js
const { data: snap } = await supabase.from('capi_meta_snapshot').select('*').eq('data', new Date().toLocaleDateString('sv-SE',{timeZone:'America/Sao_Paulo'}));
```
No endpoint, incluir `crosscheck: snap || []` e concatenar `...capiHealth.avaliarDivergencia(snap||[])` em `gatilhos`. No cron, concatenar o mesmo array em `atuais` antes do `decidirAlertas`.

- [ ] **Step 4: Seção no dashboard**

No `index.html`, adicionar bloco que renderiza `d.crosscheck` (por dataset: enviados x registrados x emq).

- [ ] **Step 5: `node --check server.js` → OK. Commit + deploy.**

```bash
git add lib/capi/health.js lib/capi/health.test.js server.js public/capi-saude/index.html
git commit -m "feat(capi-monitor): gatilho 5 divergência + seção enviamos-vs-registrou (Fase 2)"
git push origin main
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

- [ ] **Step 6: Validação manual** — após cross-check rodar (ou `capiCrossCheck(true)` via recheck temporário), conferir a seção no dashboard e que o gatilho 5 não dá falso positivo.

---

## Self-Review (preenchido pelo autor do plano)

- **Cobertura do spec:** dashboard (T5,T8) ✓; 5 gatilhos (T3 1–4, T12 nº5) ✓; dedup/cooldown (T4) ✓; resumos 8h/18h idempotentes (T7) ✓; alerta por exceção (T6) ✓; cross-check + EMQ + snapshot (T9–T11) ✓; cobertura de match CTWA (T2) ✓; faseamento (Fase 1/2) ✓; tabelas (T1,T10) ✓; tratamento de erro/degradação (try/catch nos crons + endpoint 500-safe + indisponível) ✓.
- **Placeholders:** os únicos "a preencher" são intencionais e isolados na Task 9 (parser de stats da Meta), que **depende do resultado do spike** — por design, não dá pra cravar o formato antes de ver a resposta real. Todo o resto tem código completo.
- **Consistência de tipos:** `normalizar`→`NormRow` usado por todas as agregações/gatilhos; `avaliarGatilhos`/`decidirAlertas`/`avaliarDivergencia` com assinaturas estáveis entre tasks; `capiCarregarRows` reusado por endpoint, cron e resumo.
