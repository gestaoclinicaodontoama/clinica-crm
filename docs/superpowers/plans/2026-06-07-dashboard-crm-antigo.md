# Dashboard Comercial do CRM Antigo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar um dashboard comercial sobre o CRM Antigo (`leads` + `lead_eventos`, eventos `historico_*`) com filtro de período global, funil de conversão por coorte + gargalo, KPI de Venda, tendência, comparação entre períodos e quebra por dia da semana.

**Architecture:** Funções puras em `lib/funil/` (testadas com Vitest) fazem todo o cálculo; `lib/funil/eventos.js` isola a leitura paginada do Supabase; uma rota fina em `server.js` orquestra e devolve um payload canônico; o front em `public/comercial/` consome com Chart.js (JS puro). Fonte ÚNICA = eventos `historico_*` do nosso banco (nunca Clinicorp).

**Tech Stack:** Node.js + Express, `@supabase/supabase-js`, **`node:test` + `node:assert`** (runner nativo — o projeto NÃO usa Vitest), Chart.js (vendorizado). Spec: `docs/superpowers/specs/2026-06-06-dashboard-crm-antigo-design.md`.

> ⚠️ **Correção de convenção de testes:** os blocos de teste abaixo mostram sintaxe Vitest, mas o repo usa o runner nativo do Node (ver `lib/funil/agregar.test.js`). Em cada task, traduzir o teste para:
> ```js
> const { test } = require('node:test');
> const assert = require('node:assert');
> // assert.strictEqual(a, b) no lugar de expect(a).toBe(b)
> // assert.ok(Math.abs(a-b) < 1e-4) no lugar de toBeCloseTo
> ```
> Rodar com `node --test lib/funil/<arquivo>.test.js` (NÃO `npx vitest`). Não há `npm run test` configurado.

---

## Estrutura de arquivos

```
lib/funil/
  periodo.js        + periodo.test.js      # presets de período + fuso UTC-3 + período anterior
  conversao.js      + conversao.test.js    # funil → pct + gargalo + flag de cobertura desigual
  series.js         + series.test.js       # série dia/semana + quebra por dia da semana
  comparacao.js     + comparacao.test.js   # delta % por KPI vs período anterior
  eventos.js        + eventos.test.js      # IO: lê lead_eventos historico_* paginado; monta coorte (puro testável)
  dashboard.js                             # orquestra o payload canônico (casca de composição)
server.js                                  # + rota GET /api/comercial/dashboard
public/comercial/
  index.html                               # evolui: filtro de período + canvases
  dashboard.js                             # consome a API + desenha (Chart.js)
```

**Convenção do repo (seguir):** funções puras recebem arrays já buscados e retornam objetos (padrão de `lib/funil/agregar.js`). A rota faz IO. CommonJS (`require`/`module.exports`). Testes em arquivo irmão `*.test.js` com Vitest.

---

## Task 1: Inventário dos eventos historico_* (medição, sem código de produção)

**Objetivo:** calibrar o funil e os eixos com dados reais ANTES de codar a tela. Leitura só do NOSSO banco.

**Files:**
- Create (temporário): `scripts/_inventario-historico.js` (apagar ao fim; já coberto por `.gitignore` via `_review_*.js`? não — usar nome `_inventario`; apagar manualmente)

- [ ] **Step 1: Escrever o script de inventário**

```js
// scripts/_inventario-historico.js  (TEMPORÁRIO — apagar depois)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function rq(fn, n = 8) { let last; for (let i = 0; i < n; i++) { try { const r = await fn(); if (r && r.error) { last = r.error; await sleep(500*(i+1)); continue; } return r; } catch (e) { last = e; await sleep(500*(i+1)); } } throw new Error(last?.message || String(last)); }
const cTipo = async (t) => (await rq(() => sb.from('lead_eventos').select('*', { count: 'exact', head: true }).eq('tipo', t))).count;

(async () => {
  const tipos = ['historico_lead_criado','historico_agendado','historico_compareceu','historico_orcamento','historico_fechou'];
  for (const t of tipos) console.log(t, '=', await cTipo(t));
  // leads (coorte) que fecharam SEM evento de orçamento (dimensiona o flag de cobertura desigual)
  const fech = await rq(() => sb.from('lead_eventos').select('lead_id').eq('tipo','historico_fechou').range(0, 19999));
  const orc  = await rq(() => sb.from('lead_eventos').select('lead_id').eq('tipo','historico_orcamento').range(0, 19999));
  const orcSet = new Set((orc.data||[]).map(r => r.lead_id));
  const fechSemOrc = (fech.data||[]).filter(r => !orcSet.has(r.lead_id)).length;
  console.log('fechou_sem_orcamento =', fechSemOrc, 'de', (fech.data||[]).length);
  // origens distintas (decidir se precisa unir variantes no filtro)
  const lds = await rq(() => sb.from('leads').select('origem').range(0, 19999));
  const dist = {}; for (const r of (lds.data||[])) { const k = (r.origem||'Sem origem').trim(); dist[k] = (dist[k]||0)+1; }
  console.log('origens distintas:', Object.entries(dist).sort((a,b)=>b[1]-a[1]));
})().catch(e => { console.error('FALHA:', e.message); process.exit(1); });
```

- [ ] **Step 2: Rodar e anotar os números**

Run: `node scripts/_inventario-historico.js`
Expected: contagem por etapa (ex.: `historico_lead_criado = ~13900`, etc.) + `fechou_sem_orcamento`. Anotar no topo do plano/PR — usado pra validar o funil no Task 8/9.

- [ ] **Step 3: Apagar o script temporário e commitar nada**

```bash
rm scripts/_inventario-historico.js
```
Sem commit (script temporário, não vai pro repo).

---

## Task 2: `lib/funil/periodo.js` — presets de período + período anterior

**Files:**
- Create: `lib/funil/periodo.js`
- Test: `lib/funil/periodo.test.js`

- [ ] **Step 1: Escrever o teste que falha**

```js
// lib/funil/periodo.test.js
const { describe, it, expect } = require('vitest');
const { resolvePeriodo } = require('./periodo');

describe('resolvePeriodo', () => {
  const now = new Date('2026-06-15T10:00:00-03:00');

  it('preset 30d gera intervalo de 30 dias incluindo hoje (hoje − 29)', () => {
    const p = resolvePeriodo('30d', null, null, now);
    expect(p.from).toBe('2026-05-17T00:00:00-03:00');
    expect(p.to).toBe('2026-06-15T23:59:59-03:00');
  });

  it('preset 30d gera período anterior de mesma duração imediatamente antes', () => {
    const p = resolvePeriodo('30d', null, null, now);
    expect(p.anterior.from).toBe('2026-04-17T00:00:00-03:00');
    expect(p.anterior.to).toBe('2026-05-16T23:59:59-03:00');
  });

  it('preset mes gera o mês corrente e anterior = mês passado', () => {
    const p = resolvePeriodo('mes', null, null, now);
    expect(p.from).toBe('2026-06-01T00:00:00-03:00');
    expect(p.to).toBe('2026-06-30T23:59:59-03:00');
    expect(p.anterior.from).toBe('2026-05-01T00:00:00-03:00');
    expect(p.anterior.to).toBe('2026-05-31T23:59:59-03:00');
  });

  it('custom usa as datas recebidas e calcula granularidade', () => {
    const p = resolvePeriodo('custom', '2026-01-01', '2026-06-30', now);
    expect(p.from).toBe('2026-01-01T00:00:00-03:00');
    expect(p.to).toBe('2026-06-30T23:59:59-03:00');
    expect(p.granularidade).toBe('semana'); // > 60 dias
  });

  it('intervalo curto usa granularidade dia', () => {
    expect(resolvePeriodo('30d', null, null, now).granularidade).toBe('dia');
  });
});
```

- [ ] **Step 2: Rodar pra confirmar que falha**

Run: `npx vitest run lib/funil/periodo.test.js`
Expected: FAIL — "resolvePeriodo is not a function".

- [ ] **Step 3: Implementar**

```js
// lib/funil/periodo.js
// Resolve presets de período em limites ISO com fuso de Brasília (-03:00),
// + período anterior de mesma duração + granularidade do gráfico.
const TZ = '-03:00';

function ymd(d) {
  // componentes em UTC-3 (Brasília) sem libs externas
  const t = new Date(d.getTime() - 3 * 3600 * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), day: t.getUTCDate() };
}
function dateStr(y, m, day) {
  const mm = String(m + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}
function fromISO(s) { return `${s}T00:00:00${TZ}`; }
function toISO(s) { return `${s}T23:59:59${TZ}`; }
function addDaysStr(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return dateStr(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
}
function diffDays(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

function resolvePeriodo(preset, fromStr, toStr, now = new Date()) {
  const { y, m, day } = ymd(now);
  const hoje = dateStr(y, m, day);
  let from, to;

  if (preset === 'hoje') { from = hoje; to = hoje; }
  else if (preset === '7d') { from = addDaysStr(hoje, -6); to = hoje; }
  else if (preset === '30d') { from = addDaysStr(hoje, -29); to = hoje; }
  else if (preset === 'mes') { from = dateStr(y, m, 1); to = dateStr(y, m, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()); }
  else { from = fromStr; to = toStr; } // custom

  const dur = diffDays(from, to); // dias inclusivos = dur+1
  let antFrom, antTo;
  if (preset === 'mes') {
    const pm = m === 0 ? 11 : m - 1;
    const py = m === 0 ? y - 1 : y;
    antFrom = dateStr(py, pm, 1);
    antTo = dateStr(py, pm, new Date(Date.UTC(py, pm + 1, 0)).getUTCDate());
  } else {
    antTo = addDaysStr(from, -1);
    antFrom = addDaysStr(antTo, -dur);
  }

  const granularidade = dur > 60 ? 'semana' : 'dia';
  return {
    from: fromISO(from), to: toISO(to),
    anterior: { from: fromISO(antFrom), to: toISO(antTo) },
    granularidade, preset,
  };
}

module.exports = { resolvePeriodo };
```

- [ ] **Step 4: Rodar pra confirmar que passa**

Run: `npx vitest run lib/funil/periodo.test.js`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/funil/periodo.js lib/funil/periodo.test.js
git commit -m "feat(comercial): periodo.js — presets + periodo anterior + granularidade"
```

---

## Task 3: `lib/funil/conversao.js` — funil → conversão + gargalo + flag de cobertura

**Files:**
- Create: `lib/funil/conversao.js`
- Test: `lib/funil/conversao.test.js`

- [ ] **Step 1: Escrever o teste que falha**

```js
// lib/funil/conversao.test.js
const { describe, it, expect } = require('vitest');
const { calcularFunil } = require('./conversao');

describe('calcularFunil', () => {
  it('calcula pct do topo, conversão da etapa anterior e gargalo', () => {
    const r = calcularFunil([
      { id: 'leads', rotulo: 'Leads', n: 100 },
      { id: 'agendados', rotulo: 'Agendados', n: 60 },
      { id: 'compareceram', rotulo: 'Compareceram', n: 45 },
      { id: 'orcaram', rotulo: 'Orçaram', n: 40 },
      { id: 'fecharam', rotulo: 'Fecharam', n: 12 },
    ]);
    expect(r.etapas[0].pct_do_topo).toBe(1);
    expect(r.etapas[1].conv_etapa_anterior).toBeCloseTo(0.6);
    expect(r.etapas[4].conv_etapa_anterior).toBeCloseTo(0.3); // 12/40
    expect(r.gargalo.id).toBe('fecharam'); // menor conversão
    expect(r.etapas.every(e => !e.cobertura_suspeita)).toBe(true);
  });

  it('marca cobertura_suspeita quando uma etapa tem mais leads que a anterior', () => {
    const r = calcularFunil([
      { id: 'leads', rotulo: 'Leads', n: 100 },
      { id: 'orcaram', rotulo: 'Orçaram', n: 5 },
      { id: 'fecharam', rotulo: 'Fecharam', n: 8 }, // 8 > 5 → suspeito
    ]);
    expect(r.etapas[2].cobertura_suspeita).toBe(true);
    expect(r.etapas[2].conv_etapa_anterior).toBe(1); // capado em 1, não 1.6
  });

  it('não divide por zero quando etapa anterior é 0', () => {
    const r = calcularFunil([
      { id: 'leads', rotulo: 'Leads', n: 0 },
      { id: 'agendados', rotulo: 'Agendados', n: 0 },
    ]);
    expect(r.etapas[1].conv_etapa_anterior).toBe(0);
    expect(r.etapas[1].pct_do_topo).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar pra confirmar que falha**

Run: `npx vitest run lib/funil/conversao.test.js`
Expected: FAIL — "calcularFunil is not a function".

- [ ] **Step 3: Implementar**

```js
// lib/funil/conversao.js
// Recebe etapas ordenadas [{id, rotulo, n}] (contagem em leads distintos) e
// devolve pct do topo + conversão da etapa anterior + flag de cobertura desigual + gargalo.
function pct(num, den) { return den > 0 ? num / den : 0; }

function calcularFunil(etapasBrutas) {
  const topo = etapasBrutas.length ? etapasBrutas[0].n : 0;
  const etapas = etapasBrutas.map((e, i) => {
    const anterior = i > 0 ? etapasBrutas[i - 1].n : null;
    const cobertura_suspeita = anterior !== null && e.n > anterior;
    let conv_etapa_anterior = null;
    if (i > 0) {
      conv_etapa_anterior = cobertura_suspeita ? 1 : pct(e.n, anterior);
    }
    return {
      id: e.id, rotulo: e.rotulo, n: e.n,
      pct_do_topo: pct(e.n, topo),
      conv_etapa_anterior,
      cobertura_suspeita,
    };
  });

  // gargalo = etapa (exceto topo) com menor conversão real (ignora as suspeitas)
  let gargalo = null;
  for (let i = 1; i < etapas.length; i++) {
    const e = etapas[i];
    if (e.cobertura_suspeita) continue;
    if (!gargalo || e.conv_etapa_anterior < gargalo.conv) {
      gargalo = { id: e.id, rotulo: e.rotulo, conv: e.conv_etapa_anterior };
    }
  }
  return { etapas, gargalo };
}

module.exports = { calcularFunil };
```

- [ ] **Step 4: Rodar pra confirmar que passa**

Run: `npx vitest run lib/funil/conversao.test.js`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/funil/conversao.js lib/funil/conversao.test.js
git commit -m "feat(comercial): conversao.js — funil, gargalo e flag de cobertura desigual"
```

---

## Task 4: `lib/funil/series.js` — série temporal + quebra por dia da semana

**Files:**
- Create: `lib/funil/series.js`
- Test: `lib/funil/series.test.js`

- [ ] **Step 1: Escrever o teste que falha**

```js
// lib/funil/series.test.js
const { describe, it, expect } = require('vitest');
const { serieTemporal, porDiaSemana } = require('./series');

const eventos = [
  { tipo: 'historico_lead_criado', criado_em: '2026-06-01T12:00:00-03:00' }, // segunda
  { tipo: 'historico_lead_criado', criado_em: '2026-06-01T15:00:00-03:00' },
  { tipo: 'historico_compareceu',  criado_em: '2026-06-02T10:00:00-03:00' }, // terça
  { tipo: 'historico_fechou',      criado_em: '2026-06-02T11:00:00-03:00' },
];

describe('serieTemporal', () => {
  it('agrupa por dia contando leads/comparecimentos/fechamentos', () => {
    const pts = serieTemporal(eventos, 'dia');
    const d1 = pts.find(p => p.data === '2026-06-01');
    const d2 = pts.find(p => p.data === '2026-06-02');
    expect(d1.leads).toBe(2);
    expect(d2.comparecimentos).toBe(1);
    expect(d2.fechamentos).toBe(1);
  });
});

describe('porDiaSemana', () => {
  it('soma leads e fechamentos por dia da semana (seg..dom)', () => {
    const dows = porDiaSemana(eventos);
    expect(dows.find(d => d.dia === 'seg').leads).toBe(2);
    expect(dows.find(d => d.dia === 'ter').fechamentos).toBe(1);
  });
});
```

- [ ] **Step 2: Rodar pra confirmar que falha**

Run: `npx vitest run lib/funil/series.test.js`
Expected: FAIL — "serieTemporal is not a function".

- [ ] **Step 3: Implementar**

```js
// lib/funil/series.js
// Série temporal (dia/semana) e quebra por dia da semana, a partir de eventos historico_*.
// Cada métrica conta eventos do tipo correspondente NAQUELE dia (atividade, não coorte).
const DOW = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

// extrai a data local (YYYY-MM-DD) de um ISO com offset -03:00
function diaLocal(iso) { return String(iso).slice(0, 10); }
function dowLocal(iso) {
  const [y, m, d] = diaLocal(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function semanaLocal(iso) {
  const [y, m, d] = diaLocal(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  const seg = new Date(dt.getTime() - ((dow + 6) % 7) * 86400000); // segunda da semana
  return seg.toISOString().slice(0, 10);
}

const TIPO_METRICA = {
  historico_lead_criado: 'leads',
  historico_compareceu: 'comparecimentos',
  historico_fechou: 'fechamentos',
};

function serieTemporal(eventos, granularidade) {
  const chave = granularidade === 'semana' ? semanaLocal : diaLocal;
  const mapa = new Map();
  for (const e of eventos) {
    const metrica = TIPO_METRICA[e.tipo];
    if (!metrica) continue;
    const k = chave(e.criado_em);
    if (!mapa.has(k)) mapa.set(k, { data: k, leads: 0, comparecimentos: 0, fechamentos: 0 });
    mapa.get(k)[metrica]++;
  }
  return [...mapa.values()].sort((a, b) => (a.data < b.data ? -1 : 1));
}

function porDiaSemana(eventos) {
  const base = DOW.map(dia => ({ dia, leads: 0, fechamentos: 0 }));
  for (const e of eventos) {
    const i = dowLocal(e.criado_em);
    if (e.tipo === 'historico_lead_criado') base[i].leads++;
    else if (e.tipo === 'historico_fechou') base[i].fechamentos++;
  }
  // reordena seg..dom pra leitura comercial
  return [...base.slice(1), base[0]];
}

module.exports = { serieTemporal, porDiaSemana };
```

- [ ] **Step 4: Rodar pra confirmar que passa**

Run: `npx vitest run lib/funil/series.test.js`
Expected: PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/funil/series.js lib/funil/series.test.js
git commit -m "feat(comercial): series.js — serie temporal e quebra por dia da semana"
```

---

## Task 5: `lib/funil/comparacao.js` — delta % vs período anterior

**Files:**
- Create: `lib/funil/comparacao.js`
- Test: `lib/funil/comparacao.test.js`

- [ ] **Step 1: Escrever o teste que falha**

```js
// lib/funil/comparacao.test.js
const { describe, it, expect } = require('vitest');
const { compararKpis } = require('./comparacao');

describe('compararKpis', () => {
  it('calcula delta percentual por KPI', () => {
    const r = compararKpis(
      { leads: 320, fechamentos: 42, venda: 410000 },
      { leads: 280, fechamentos: 38, venda: 365000 },
    );
    expect(r.leads.atual).toBe(320);
    expect(r.leads.anterior).toBe(280);
    expect(r.leads.delta_pct).toBeCloseTo(0.142857, 4);
  });

  it('delta null quando anterior é 0 (evita divisão por zero)', () => {
    const r = compararKpis({ leads: 10 }, { leads: 0 });
    expect(r.leads.delta_pct).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar pra confirmar que falha**

Run: `npx vitest run lib/funil/comparacao.test.js`
Expected: FAIL — "compararKpis is not a function".

- [ ] **Step 3: Implementar**

```js
// lib/funil/comparacao.js
// Compara KPIs do período atual com o anterior. delta_pct = (atual-anterior)/anterior.
function compararKpis(atual, anterior) {
  const out = {};
  for (const k of Object.keys(atual)) {
    const a = Number(atual[k] || 0);
    const b = Number(anterior?.[k] || 0);
    out[k] = { atual: a, anterior: b, delta_pct: b > 0 ? (a - b) / b : null };
  }
  return out;
}

module.exports = { compararKpis };
```

- [ ] **Step 4: Rodar pra confirmar que passa**

Run: `npx vitest run lib/funil/comparacao.test.js`
Expected: PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/funil/comparacao.js lib/funil/comparacao.test.js
git commit -m "feat(comercial): comparacao.js — delta % entre periodos"
```

---

## Task 6: `lib/funil/eventos.js` — montar coorte + KPIs a partir de eventos historico_*

**Files:**
- Create: `lib/funil/eventos.js`
- Test: `lib/funil/eventos.test.js`

A função pura `montarCoorte` recebe (1) os eventos `historico_lead_criado` do período (define o coorte), (2) TODOS os eventos `historico_*` desses leads (qualquer data), (3) um mapa `leadId → origem`, e (4) filtro de origem opcional. Devolve as 5 etapas (leads distintos) + KPIs (Venda, entrada, etc.). A função de IO `buscarCoorte` faz as duas queries paginadas.

- [ ] **Step 1: Escrever o teste que falha (função pura)**

```js
// lib/funil/eventos.test.js
const { describe, it, expect } = require('vitest');
const { montarCoorte } = require('./eventos');

const origemPorLead = new Map([[1, 'Meta Ads'], [2, 'Meta Ads'], [3, 'Indicação']]);

// eventos de criação NO período (define coorte): leads 1,2,3
const criadosNoPeriodo = [
  { lead_id: 1, tipo: 'historico_lead_criado', criado_em: '2026-05-02T10:00:00-03:00' },
  { lead_id: 2, tipo: 'historico_lead_criado', criado_em: '2026-05-03T10:00:00-03:00' },
  { lead_id: 3, tipo: 'historico_lead_criado', criado_em: '2026-05-04T10:00:00-03:00' },
];
// todos os eventos historico_* desses leads (qualquer data)
const eventosDoCoorte = [
  ...criadosNoPeriodo,
  { lead_id: 1, tipo: 'historico_agendado', criado_em: '2026-05-05T10:00:00-03:00' },
  { lead_id: 1, tipo: 'historico_compareceu', criado_em: '2026-05-06T10:00:00-03:00' },
  { lead_id: 1, tipo: 'historico_orcamento', criado_em: '2026-05-07T10:00:00-03:00' },
  { lead_id: 1, tipo: 'historico_fechou', criado_em: '2026-05-10T10:00:00-03:00', metadata: { valor: 20000, entrada: 5000 } },
  { lead_id: 2, tipo: 'historico_agendado', criado_em: '2026-05-06T10:00:00-03:00' },
];

describe('montarCoorte', () => {
  it('conta as 5 etapas em leads distintos', () => {
    const r = montarCoorte(criadosNoPeriodo, eventosDoCoorte, origemPorLead, null);
    const n = Object.fromEntries(r.etapas.map(e => [e.id, e.n]));
    expect(n.leads).toBe(3);
    expect(n.agendados).toBe(2);     // leads 1 e 2
    expect(n.compareceram).toBe(1);  // lead 1
    expect(n.orcaram).toBe(1);
    expect(n.fecharam).toBe(1);
  });

  it('soma Venda e entrada do historico_fechou', () => {
    const r = montarCoorte(criadosNoPeriodo, eventosDoCoorte, origemPorLead, null);
    expect(r.kpis.venda).toBe(20000);
    expect(r.kpis.entrada).toBe(5000);
    expect(r.kpis.fechamentos).toBe(1);
  });

  it('filtra por origem usando o mapa leadId→origem', () => {
    const r = montarCoorte(criadosNoPeriodo, eventosDoCoorte, origemPorLead, 'Indicação');
    const n = Object.fromEntries(r.etapas.map(e => [e.id, e.n]));
    expect(n.leads).toBe(1);   // só lead 3
    expect(n.agendados).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar pra confirmar que falha**

Run: `npx vitest run lib/funil/eventos.test.js`
Expected: FAIL — "montarCoorte is not a function".

- [ ] **Step 3: Implementar (função pura + IO paginada)**

```js
// lib/funil/eventos.js
// Lê lead_eventos historico_* (IO paginada) e monta o coorte do período (puro/testável).
const ETAPAS = [
  { id: 'leads', rotulo: 'Leads', tipo: 'historico_lead_criado' },
  { id: 'agendados', rotulo: 'Agendados', tipo: 'historico_agendado' },
  { id: 'compareceram', rotulo: 'Compareceram', tipo: 'historico_compareceu' },
  { id: 'orcaram', rotulo: 'Orçaram', tipo: 'historico_orcamento' },
  { id: 'fecharam', rotulo: 'Fecharam', tipo: 'historico_fechou' },
];

// Paginação real (contorna o teto de 1000 do PostgREST).
async function buscarTodos(query) {
  const page = 1000;
  let from = 0, out = [];
  for (;;) {
    const { data, error } = await query.range(from, from + page - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < page) break;
    from += page;
  }
  return out;
}

// IO: busca os leads criados no período + todos os eventos historico_* desses leads.
async function buscarCoorte(sb, fromISO, toISO) {
  const criados = await buscarTodos(
    sb.from('lead_eventos').select('lead_id, tipo, criado_em, metadata')
      .eq('tipo', 'historico_lead_criado').gte('criado_em', fromISO).lte('criado_em', toISO)
      .order('criado_em', { ascending: true })
  );
  const leadIds = [...new Set(criados.map(e => e.lead_id))];
  const eventos = [];
  for (let i = 0; i < leadIds.length; i += 500) {
    const chunk = leadIds.slice(i, i + 500);
    const evs = await buscarTodos(
      sb.from('lead_eventos').select('lead_id, tipo, criado_em, metadata')
        .in('lead_id', chunk).like('tipo', 'historico_%')
    );
    eventos.push(...evs);
  }
  // mapa de origem
  const origemPorLead = new Map();
  for (let i = 0; i < leadIds.length; i += 500) {
    const chunk = leadIds.slice(i, i + 500);
    const { data, error } = await sb.from('leads').select('id, origem').in('id', chunk);
    if (error) throw new Error(error.message);
    // origem já é um rótulo (ex.: "WhatsApp Direto", "Meta Ads"); agrupa como está, só com trim.
    // NÃO aplicar normalizarOrigem() do server.js — aquele é pra derivar de UTM na criação.
    for (const l of (data || [])) origemPorLead.set(l.id, (l.origem || 'Sem origem').trim());
  }
  return { criados, eventos, origemPorLead };
}

// Puro: monta etapas (leads distintos) + KPIs. Filtro de origem opcional.
function montarCoorte(criados, eventos, origemPorLead, origem) {
  const naOrigem = (leadId) => !origem || origemPorLead.get(leadId) === origem;
  const coorte = new Set(criados.map(e => e.lead_id).filter(naOrigem));

  const porEtapa = new Map(ETAPAS.map(e => [e.tipo, new Set()]));
  let venda = 0, entrada = 0;
  for (const e of eventos) {
    if (!coorte.has(e.lead_id)) continue;
    if (porEtapa.has(e.tipo)) porEtapa.get(e.tipo).add(e.lead_id);
    if (e.tipo === 'historico_fechou') {
      venda += Number(e.metadata?.valor || 0);
      entrada += Number(e.metadata?.entrada || 0);
    }
  }

  const etapas = ETAPAS.map(e => ({ id: e.id, rotulo: e.rotulo, n: porEtapa.get(e.tipo).size }));
  etapas[0].n = coorte.size; // topo = leads do coorte
  const fechamentos = porEtapa.get('historico_fechou').size;

  return {
    etapas,
    kpis: {
      leads: coorte.size,
      agendamentos: porEtapa.get('historico_agendado').size,
      comparecimentos: porEtapa.get('historico_compareceu').size,
      orcamentos: porEtapa.get('historico_orcamento').size,
      fechamentos,
      venda,
      entrada,
      ticket_medio: fechamentos ? Math.round((venda / fechamentos) * 100) / 100 : 0,
    },
  };
}

module.exports = { buscarCoorte, montarCoorte, ETAPAS };
```

- [ ] **Step 4: Rodar pra confirmar que passa**

Run: `npx vitest run lib/funil/eventos.test.js`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/funil/eventos.js lib/funil/eventos.test.js
git commit -m "feat(comercial): eventos.js — busca paginada + montagem do coorte"
```

---

## Task 7: `lib/funil/dashboard.js` — orquestra o payload canônico

**Files:**
- Create: `lib/funil/dashboard.js`
- Test: `lib/funil/dashboard.test.js`

- [ ] **Step 1: Escrever o teste que falha**

```js
// lib/funil/dashboard.test.js
const { describe, it, expect, vi } = require('vitest');
const { montarDashboard } = require('./dashboard');

// stub de buscarCoorte injetável: devolve coorte fixo conforme o intervalo
function fakeCoorte(tag) {
  const lead = (id) => ({ lead_id: id, tipo: 'historico_lead_criado', criado_em: '2026-05-02T10:00:00-03:00' });
  if (tag === 'atual') {
    return {
      criados: [lead(1), lead(2)],
      eventos: [lead(1), lead(2), { lead_id: 1, tipo: 'historico_fechou', criado_em: '2026-05-10T10:00:00-03:00', metadata: { valor: 1000, entrada: 200 } }],
      origemPorLead: new Map([[1, 'Meta Ads'], [2, 'Meta Ads']]),
    };
  }
  return { criados: [lead(9)], eventos: [lead(9)], origemPorLead: new Map([[9, 'Meta Ads']]) };
}

describe('montarDashboard', () => {
  it('monta payload com funil, kpis, comparacao, serie e periodo', async () => {
    const deps = { buscarCoorte: vi.fn(async (_sb, from) => fakeCoorte(from.includes('2026-04') ? 'anterior' : 'atual')) };
    const periodo = {
      from: '2026-05-01T00:00:00-03:00', to: '2026-05-31T23:59:59-03:00',
      anterior: { from: '2026-04-01T00:00:00-03:00', to: '2026-04-30T23:59:59-03:00' },
      granularidade: 'dia', preset: 'mes',
    };
    const out = await montarDashboard({}, periodo, null, deps);
    expect(out.funil.etapas[0].n).toBe(2);
    expect(out.kpis.venda).toBe(1000);
    expect(out.comparacao.leads.anterior).toBe(1);
    expect(out.funil.gargalo).toBeDefined();
    expect(out.serie.granularidade).toBe('dia');
    expect(out.periodo.preset).toBe('mes');
  });
});
```

- [ ] **Step 2: Rodar pra confirmar que falha**

Run: `npx vitest run lib/funil/dashboard.test.js`
Expected: FAIL — "montarDashboard is not a function".

- [ ] **Step 3: Implementar**

```js
// lib/funil/dashboard.js
// Orquestra as funções puras + IO num payload canônico único.
const { calcularFunil } = require('./conversao');
const { serieTemporal, porDiaSemana } = require('./series');
const { compararKpis } = require('./comparacao');
const eventosMod = require('./eventos');
const { montarCoorte } = eventosMod;

async function montarDashboard(sb, periodo, origem, deps = {}) {
  const buscarCoorte = deps.buscarCoorte || eventosMod.buscarCoorte;

  const atual = await buscarCoorte(sb, periodo.from, periodo.to);
  const anterior = await buscarCoorte(sb, periodo.anterior.from, periodo.anterior.to);

  const cAtual = montarCoorte(atual.criados, atual.eventos, atual.origemPorLead, origem);
  const cAnterior = montarCoorte(anterior.criados, anterior.eventos, anterior.origemPorLead, origem);

  const funil = calcularFunil(cAtual.etapas);

  // série/dia-semana = atividade dos eventos do período atual (não coorte)
  const serie = { granularidade: periodo.granularidade, pontos: serieTemporal(atual.eventos, periodo.granularidade) };
  const por_dia_semana = porDiaSemana(atual.eventos);

  const comparacao = compararKpis(
    { leads: cAtual.kpis.leads, fechamentos: cAtual.kpis.fechamentos, venda: cAtual.kpis.venda },
    { leads: cAnterior.kpis.leads, fechamentos: cAnterior.kpis.fechamentos, venda: cAnterior.kpis.venda },
  );

  const origens = [...new Set([...atual.origemPorLead.values()].filter(Boolean))].sort();

  return { periodo, origem: origem || 'all', origens, funil, kpis: cAtual.kpis, comparacao, serie, por_dia_semana };
}

module.exports = { montarDashboard };
```

- [ ] **Step 4: Rodar pra confirmar que passa**

Run: `npx vitest run lib/funil/dashboard.test.js`
Expected: PASS (1 teste).

- [ ] **Step 5: Commit**

```bash
git add lib/funil/dashboard.js lib/funil/dashboard.test.js
git commit -m "feat(comercial): dashboard.js — orquestra payload canonico"
```

---

## Task 8: Rota `GET /api/comercial/dashboard` no `server.js`

**Files:**
- Modify: `server.js` (adicionar rota perto das outras `/api/comercial/*`, ~linha 3019; adicionar `require` no topo junto aos outros `lib/funil`)

- [ ] **Step 1: Adicionar os requires no topo do server.js**

Localizar (perto da linha 18-19):
```js
const { agregarFunil } = require('./lib/funil/agregar');
const { agregarFechamentos, temposPorFase } = require('./lib/funil/fechamentos');
```
Adicionar logo abaixo:
```js
const { resolvePeriodo } = require('./lib/funil/periodo');
const { montarDashboard } = require('./lib/funil/dashboard');
```

- [ ] **Step 2: Adicionar a rota (após a rota `/api/comercial/funil`)**

```js
// Dashboard comercial do CRM Antigo (eventos historico_*). Spec: docs/superpowers/specs/2026-06-06...
app.get('/api/comercial/dashboard', requireAuth, requireDashboardAvaliacao, rateLimit, async (req, res) => {
  try {
    const preset = req.query.preset || '30d';
    const origem = (req.query.origem && req.query.origem !== 'all') ? req.query.origem : null;
    if (preset === 'custom' && (!req.query.from || !req.query.to)) {
      return res.status(400).json({ error: 'custom exige from e to (YYYY-MM-DD)' });
    }
    const periodo = resolvePeriodo(preset, req.query.from || null, req.query.to || null);
    const payload = await montarDashboard(supabase, periodo, origem);
    res.json(payload);
  } catch (e) {
    console.error('❌ /api/comercial/dashboard:', e.message);
    res.status(500).json({ error: 'Falha ao montar o dashboard' });
  }
});
```

- [ ] **Step 3: Subir o server e testar a rota com curl autenticado**

Run: `npm run dev` (noutro terminal) e então:
```bash
# pegar um token válido no localStorage do navegador logado (sb-...-auth-token → access_token)
curl -s "http://localhost:3000/api/comercial/dashboard?preset=mes" -H "Authorization: Bearer <TOKEN>" | head -c 600
```
Expected: JSON com `funil`, `kpis`, `comparacao`, `serie`, `periodo`. Conferir que `kpis.leads` bate na ordem de grandeza do inventário (Task 1).

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(comercial): rota GET /api/comercial/dashboard"
```

---

## Task 9: Front — filtro de período global + gráficos (Chart.js)

**Files:**
- Create: `public/js/vendor/chart.umd.min.js` (Chart.js vendorizado — evita risco de CDN comprometido / SRI)
- Modify: `public/comercial/index.html` (adicionar barra de período, cards de KPI, canvases, e os `<script src` locais)
- Create: `public/comercial/dashboard.js`

- [ ] **Step 0: Vendorizar o Chart.js localmente (segurança — sem CDN externo)**

```bash
mkdir -p public/js/vendor
curl -fsSL "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js" -o public/js/vendor/chart.umd.min.js
# conferir que baixou (deve ter > 100KB):
ls -l public/js/vendor/chart.umd.min.js
```
> Servir localmente elimina a necessidade de SRI e o risco de CDN comprometido — padrão preferido pelo guia de segurança do projeto. Se preferir CDN, use `integrity="sha384-..." crossorigin="anonymous"` (como o sheetjs já faz no index).

- [ ] **Step 1: Adicionar Chart.js (local), a barra de período e os canvases no index.html**

No `<head>` (após os outros scripts):
```html
<script src="/js/vendor/chart.umd.min.js"></script>
```
No corpo, substituir/inserir a barra de filtros por:
```html
<div class="filtros">
  <select id="f-preset">
    <option value="hoje">Hoje</option>
    <option value="7d">7 dias</option>
    <option value="30d" selected>30 dias</option>
    <option value="mes">Este mês</option>
    <option value="custom">Personalizado</option>
  </select>
  <label>De <input type="date" id="f-from" disabled></label>
  <label>Até <input type="date" id="f-to" disabled></label>
  <select id="f-origem"><option value="all">Todas as origens</option></select>
  <button id="f-aplicar">Aplicar</button>
</div>
<div id="kpis" class="kpis"></div>
<div id="funil" class="funil"></div>
<div class="graf"><canvas id="g-tendencia"></canvas></div>
<div class="graf"><canvas id="g-dow"></canvas></div>
```
Antes do `</body>`, após o supabase-js:
```html
<script src="/comercial/dashboard.js"></script>
```

- [ ] **Step 2: Criar `public/comercial/dashboard.js`**

```js
// public/comercial/dashboard.js — consome /api/comercial/dashboard e desenha (Chart.js)
function token() {
  for (const k in localStorage) {
    if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
      try { return JSON.parse(localStorage[k]).access_token; } catch { /* ignora */ }
    }
  }
  return null;
}
const fmtBRL = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtPct = (v) => v == null ? '—' : (v * 100).toFixed(1) + '%';
let chartTend, chartDow;

async function carregar() {
  const preset = document.getElementById('f-preset').value;
  const origem = document.getElementById('f-origem').value;
  const qs = new URLSearchParams({ preset, origem });
  if (preset === 'custom') { qs.set('from', document.getElementById('f-from').value); qs.set('to', document.getElementById('f-to').value); }
  const r = await fetch('/api/comercial/dashboard?' + qs, { headers: { Authorization: 'Bearer ' + token() } });
  if (!r.ok) { alert('Erro ao carregar dashboard'); return; }
  const d = await r.json();
  renderKpis(d.kpis, d.comparacao);
  renderFunil(d.funil);
  renderOrigens(d.origens, origem);
  renderTendencia(d.serie);
  renderDow(d.por_dia_semana);
}

function renderKpis(k, c) {
  const card = (rotulo, valor, delta) =>
    `<div class="kpi"><div class="kpi-rotulo">${rotulo}</div><div class="kpi-valor">${valor}</div>` +
    (delta != null ? `<div class="kpi-delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${fmtPct(Math.abs(delta))}</div>` : '') + `</div>`;
  document.getElementById('kpis').innerHTML = [
    card('Venda (contrato)', fmtBRL(k.venda), c.venda.delta_pct),
    card('Entrada (caixa)', fmtBRL(k.entrada), null),
    card('Leads', k.leads, c.leads.delta_pct),
    card('Fechamentos', k.fechamentos, c.fechamentos.delta_pct),
    card('Ticket médio', fmtBRL(k.ticket_medio), null),
  ].join('');
}

function renderFunil(f) {
  document.getElementById('funil').innerHTML = f.etapas.map(e => {
    const garg = f.gargalo && f.gargalo.id === e.id ? ' gargalo' : '';
    const susp = e.cobertura_suspeita ? ' <span class="aviso" title="Cobertura de dado incompleta">⚠</span>' : '';
    const conv = e.conv_etapa_anterior == null ? '' : `<span class="conv">${fmtPct(e.conv_etapa_anterior)} da etapa anterior</span>`;
    return `<div class="etapa${garg}"><b>${e.rotulo}</b><span class="n">${e.n}</span>${conv}${susp}</div>`;
  }).join('');
}

function renderOrigens(origens, sel) {
  const s = document.getElementById('f-origem');
  if (s.options.length > 1) return; // já populado
  for (const o of origens) { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; if (o === sel) opt.selected = true; s.appendChild(opt); }
}

function renderTendencia(serie) {
  const ctx = document.getElementById('g-tendencia');
  const labels = serie.pontos.map(p => p.data);
  if (chartTend) chartTend.destroy();
  chartTend = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Leads', data: serie.pontos.map(p => p.leads) },
      { label: 'Comparecimentos', data: serie.pontos.map(p => p.comparecimentos) },
      { label: 'Fechamentos', data: serie.pontos.map(p => p.fechamentos) },
    ] },
    options: { responsive: true, plugins: { title: { display: true, text: `Atividade por ${serie.granularidade}` } } },
  });
}

function renderDow(dows) {
  const ctx = document.getElementById('g-dow');
  if (chartDow) chartDow.destroy();
  chartDow = new Chart(ctx, {
    type: 'bar',
    data: { labels: dows.map(d => d.dia), datasets: [
      { label: 'Leads', data: dows.map(d => d.leads) },
      { label: 'Fechamentos', data: dows.map(d => d.fechamentos) },
    ] },
    options: { responsive: true, plugins: { title: { display: true, text: 'Por dia da semana' } } },
  });
}

document.getElementById('f-preset').addEventListener('change', (e) => {
  const custom = e.target.value === 'custom';
  document.getElementById('f-from').disabled = !custom;
  document.getElementById('f-to').disabled = !custom;
});
document.getElementById('f-aplicar').addEventListener('click', carregar);
carregar();
```

- [ ] **Step 3: Validar no navegador (Playwright MCP se disponível, ou manual)**

Subir `npm run dev`, logar, abrir `/comercial/`. Conferir:
- KPIs aparecem com Venda em destaque + deltas.
- Funil mostra as 5 etapas, gargalo destacado, ⚠ onde houver cobertura suspeita.
- Trocar preset (30d → mês → custom) recarrega tudo.
- Filtro de origem recarrega.
- Gráficos de tendência e dia-da-semana renderizam.

> **Não afirmar "funciona" sem evidência** — usar `superpowers:verification-before-completion`.

- [ ] **Step 4: Commit**

```bash
git add public/comercial/index.html public/comercial/dashboard.js
git commit -m "feat(comercial): tela do dashboard CRM Antigo com Chart.js"
```

---

## Task 10: Estilos + polish da tela

**Files:**
- Modify: `public/comercial/index.html` (bloco `<style>`) ou `public/css/` conforme padrão do projeto

- [ ] **Step 1: Adicionar CSS para `.kpis/.kpi/.funil/.etapa/.gargalo/.graf`**

```css
.kpis { display:flex; gap:14px; flex-wrap:wrap; margin:18px 0; }
.kpi { background:var(--bg2); border:1px solid var(--border); border-radius:12px; padding:14px 18px; min-width:150px; }
.kpi-rotulo { font-size:11.5px; color:var(--muted); }
.kpi-valor { font-size:22px; font-weight:700; margin-top:4px; }
.kpi-delta.up { color:#2e7d32; } .kpi-delta.down { color:#c62828; }
.funil { display:flex; gap:8px; flex-wrap:wrap; margin:18px 0; }
.etapa { background:var(--bg2); border:1px solid var(--border); border-radius:10px; padding:12px 16px; flex:1; min-width:120px; }
.etapa .n { display:block; font-size:20px; font-weight:700; }
.etapa .conv { font-size:11px; color:var(--muted); }
.etapa.gargalo { border-color:#c62828; box-shadow:0 0 0 1px #c62828 inset; }
.graf { background:var(--bg2); border:1px solid var(--border); border-radius:12px; padding:16px; margin:18px 0; max-width:900px; }
```

- [ ] **Step 2: Conferir visual no navegador e ajustar espaçamentos**

- [ ] **Step 3: Commit**

```bash
git add public/comercial/index.html
git commit -m "style(comercial): polish dos KPIs, funil e graficos"
```

---

## Task 11: Verificação final + deploy

- [ ] **Step 1: Rodar a suíte de testes inteira**

Run: `npm run test`
Expected: todos os testes verdes (incluindo os novos de `lib/funil/*.test.js`).

- [ ] **Step 2: Conferência de tipos/lint do projeto (se houver)**

Run: `npm run check` (se existir no projeto)
Expected: sem erros.

- [ ] **Step 3: Validar a rota com dados reais e cruzar com o inventário (Task 1)**

Conferir que `kpis.leads` de "tudo" (`custom` 2023-01-01 → hoje) ≈ total de `historico_lead_criado` do inventário. Divergência grande = bug de paginação ou coorte.

- [ ] **Step 4: Commit final, push e deploy (com OK do Luiz)**

```bash
git push
# deploy CRM (conforme CLAUDE.md):
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

---

## Fora de escopo (próximas etapas — não implementar aqui)
- Etapa 2: Monitor de Validação Diária do CRM Novo (junho).
- Etapa 3: Dashboard unificado CRM Antigo + CRM Novo (julho) — adiciona adaptador de `status_mudou`/`lead_criado` sem mexer na tela.
- Recortes por avaliador e CRC.
- Pré-cálculo/cache dos agregados do CRM Antigo (otimização, se "tudo" ficar lento).
