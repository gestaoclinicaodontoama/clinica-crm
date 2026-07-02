# A Receber / A Pagar (saúde 24m) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Página `/financeiro/saude/` mostrando a receber × a pagar por mês (24 meses) a partir do `list_cash_flow` do Clinicorp, com cards, gráfico e tabela.

**Architecture:** 1 chamada Clinicorp por sync alimenta a tabela `fin_fluxo_futuro` (só futuro, upsert por mês). Endpoint fino lê a tabela + RPC de vencido. Front vanilla com Chart.js. Parser do ano (a API não devolve o ano do mês!) isolado em lib pura com testes.

**Tech Stack:** Node/Express (server.js), Supabase (Postgres + MCP p/ migração), HTML/CSS/JS vanilla, Chart.js 4.4.3 via CDN (SRI), `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-02-a-receber-a-pagar-design.md`

## Global Constraints

- Front é vanilla — sem framework, sem lib nova além do Chart.js já usado (CDN pinado `chart.js@4.4.3` com o mesmo `integrity` de `public/producao/dentista/index.html`).
- Item de menu SÓ em `public/js/nav-config.js` (fonte única — nunca editar sidebar em index.html/shared-nav.js).
- Somas de tabelas grandes SEMPRE no SQL (client JS trunca em 1000 linhas) — daí a RPC `fin_vencido_total`.
- Roles do módulo: `financeiro,mod_financeiro` (+ admin implícito) — mesmo `requireFinanceiro` existente (server.js:401).
- Migrações: aplicar via MCP Supabase (project `mtqdpjhhqzvuklnlfpvi`) e conferir com `list_migrations`.
- Rate limit Clinicorp 25 req/h — o sync usa 1 chamada; não chamar a API ao vivo em endpoint de página.
- Deploy: após `git push`, rodar `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"` sem perguntar.
- Working dir concorrente: antes do push final, `git pull --rebase origin main`; se houver conflito real, parar e reportar (não forçar).

---

### Task 1: Lib pura `fluxo-futuro` (parser do cash_flow + janela)

**Files:**
- Create: `lib/financeiro/fluxo-futuro.js`
- Test: `lib/financeiro/fluxo-futuro.test.js`

**Interfaces:**
- Consumes: nada (lib pura).
- Produces: `parseCashFlow(resposta, fromISO) → [{mes:'YYYY-MM', a_receber:Number, a_pagar:Number}]`; `janela24m(hojeISO) → {from:'YYYY-MM-DD', to:'YYYY-MM-DD'}`; `totais(meses) → {receber, pagar, diferenca}`. Usadas pela Task 3 (sync).

**Contexto crítico:** a resposta do `GET /financial/list_cash_flow` é um array de `{month:"July", in_forecast, out_forecast, ...}` — **sem ano**. A ordem é cronológica a partir do `from`; o ano é derivado andando um cursor de mês. Um mês pode ser omitido pela API — o cursor avança pelo NOME do mês, não cegamente pela posição.

- [ ] **Step 1: Write the failing tests**

```js
// lib/financeiro/fluxo-futuro.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseCashFlow, janela24m, totais } = require('./fluxo-futuro');

test('parseCashFlow deriva o ano pela ordem, virando o ano', () => {
  const resposta = [
    { month: 'November', in_forecast: 96322.39, out_forecast: 200221.9 },
    { month: 'December', in_forecast: 90672.46, out_forecast: 194379.97 },
    { month: 'January',  in_forecast: 83624.62, out_forecast: 95960.88 },
  ];
  const meses = parseCashFlow(resposta, '2026-11-01');
  assert.deepEqual(meses.map(x => x.mes), ['2026-11', '2026-12', '2027-01']);
  assert.equal(meses[2].a_pagar, 95960.88);
  assert.equal(meses[0].a_receber, 96322.39);
});

test('mês pulado pela API não desloca os seguintes', () => {
  const meses = parseCashFlow([
    { month: 'November', in_forecast: 1, out_forecast: 1 },
    { month: 'January',  in_forecast: 2, out_forecast: 2 },
  ], '2026-11-01');
  assert.deepEqual(meses.map(x => x.mes), ['2026-11', '2027-01']);
});

test('resposta vazia, nula ou com mês desconhecido → ignora', () => {
  assert.deepEqual(parseCashFlow([], '2026-07-01'), []);
  assert.deepEqual(parseCashFlow(null, '2026-07-01'), []);
  assert.deepEqual(parseCashFlow([{ month: 'Julho', in_forecast: 1 }], '2026-07-01'), []);
});

test('forecast ausente vira 0', () => {
  const [m] = parseCashFlow([{ month: 'July' }], '2026-07-01');
  assert.equal(m.a_receber, 0);
  assert.equal(m.a_pagar, 0);
});

test('janela24m: de hoje até o último dia do 24º mês à frente', () => {
  assert.deepEqual(janela24m('2026-07-02'), { from: '2026-07-02', to: '2028-07-31' });
  assert.deepEqual(janela24m('2026-01-15'), { from: '2026-01-15', to: '2028-01-31' });
});

test('totais soma e calcula diferença', () => {
  assert.deepEqual(totais([{ a_receber: 100, a_pagar: 40 }, { a_receber: 50, a_pagar: 200 }]),
    { receber: 150, pagar: 240, diferenca: -90 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/financeiro/fluxo-futuro.test.js`
Expected: FAIL — `Cannot find module './fluxo-futuro'`

- [ ] **Step 3: Write the implementation**

```js
// lib/financeiro/fluxo-futuro.js
// Fluxo futuro (a receber × a pagar) a partir do /financial/list_cash_flow.
// A resposta NÃO tem ano — cada item vem só com month:"July". A ordem é
// cronológica a partir do from; o ano é derivado andando um cursor de mês
// pelo NOME (tolera mês omitido pela API sem deslocar os seguintes).
const MESES_EN = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Janela [hoje, último dia do 24º mês à frente] em YYYY-MM-DD.
function janela24m(hojeISO) {
  const [y, m] = hojeISO.slice(0, 7).split('-').map(Number);
  const fim = new Date(Date.UTC(y, m - 1 + 25, 0)); // dia 0 do mês seguinte ao 24º
  return { from: hojeISO, to: fim.toISOString().slice(0, 10) };
}

function parseCashFlow(resposta, fromISO) {
  let [y, m] = fromISO.slice(0, 7).split('-').map(Number);
  const out = [];
  for (const item of (resposta || [])) {
    const alvo = MESES_EN.indexOf(item.month) + 1; // 1-12; 0 = nome desconhecido
    if (!alvo) continue;
    while (m !== alvo) { m++; if (m > 12) { m = 1; y++; } }
    out.push({
      mes: `${y}-${String(m).padStart(2, '0')}`,
      a_receber: Number(item.in_forecast) || 0,
      a_pagar: Number(item.out_forecast) || 0,
    });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function totais(meses) {
  const receber = meses.reduce((s, x) => s + x.a_receber, 0);
  const pagar = meses.reduce((s, x) => s + x.a_pagar, 0);
  return { receber, pagar, diferenca: receber - pagar };
}

module.exports = { parseCashFlow, janela24m, totais };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/financeiro/fluxo-futuro.test.js`
Expected: 6 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add lib/financeiro/fluxo-futuro.js lib/financeiro/fluxo-futuro.test.js
git commit -m "feat(financeiro): lib pura do fluxo futuro (parser cash_flow 24m)"
```

---

### Task 2: Migração `fin_fluxo_futuro` + RPC `fin_vencido_total`

**Files:**
- Create: `supabase/migrations/20260702100000_fin_fluxo_futuro.sql`

**Interfaces:**
- Consumes: tabela existente `pacientes_financeiro` (coluna `total_vencido` — confirmada em `supabase/migrations/20260625120200_mkt_drill_rpcs.sql:79`).
- Produces: tabela `fin_fluxo_futuro(mes date pk, a_receber numeric, a_pagar numeric, atualizado_em timestamptz)` e RPC `fin_vencido_total() → numeric`. Usadas pelas Tasks 3 e 4.

- [ ] **Step 1: Write the migration file**

```sql
-- A Receber / A Pagar (saúde 24m): agregado mensal futuro do list_cash_flow.
-- Tabela guarda SÓ o futuro (mês corrente em diante); sem histórico de snapshots.
create table if not exists fin_fluxo_futuro (
  mes date primary key,                    -- dia 1 do mês
  a_receber numeric not null default 0,    -- in_forecast (parcelas a vencer)
  a_pagar numeric not null default 0,      -- out_forecast (contas lançadas)
  atualizado_em timestamptz not null default now()
);
-- Mesmo padrão das demais fin_*: RLS ligada sem policies = acesso só via service role.
alter table fin_fluxo_futuro enable row level security;

-- Vencido a receber: SUM no SQL (o client JS trunca em 1000 linhas).
create or replace function fin_vencido_total()
returns numeric language sql stable as $$
  select coalesce(sum(total_vencido), 0) from pacientes_financeiro;
$$;
```

- [ ] **Step 2: Apply via MCP Supabase**

Usar `mcp__plugin_supabase_supabase__apply_migration` no project `mtqdpjhhqzvuklnlfpvi` com name `fin_fluxo_futuro` e o SQL acima. Depois `list_migrations` e confirmar que `20260702100000` (ou o version gerado) aparece.

- [ ] **Step 3: Verify with SQL**

Via `execute_sql`:
```sql
select fin_vencido_total() as vencido;
select count(*) from fin_fluxo_futuro;
```
Expected: `vencido` > 0 (na casa de R$ 200–300k), `count` = 0 (tabela nova vazia).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260702100000_fin_fluxo_futuro.sql
git commit -m "feat(financeiro): tabela fin_fluxo_futuro + RPC fin_vencido_total"
```

---

### Task 3: `syncFluxoFuturo()` + wiring no sync das 02h e no sync manual

**Files:**
- Modify: `sync/financeiro-sync.js` (adicionar função + export; hoje exporta só `syncPeriodo` na linha 112)
- Modify: `server.js:29` (import), `server.js:~4475` (bloco 02h), `server.js:~7559` (POST /api/financeiro/sync)

**Interfaces:**
- Consumes: `parseCashFlow`/`janela24m` da Task 1; tabela `fin_fluxo_futuro` da Task 2; `api` (ClinicorpApi) e `supabase` já instanciados no topo de `sync/financeiro-sync.js`; `dataLocal` de `lib/financeiro/data`.
- Produces: `syncFluxoFuturo(hojeISO?) → {meses: n}` exportada de `sync/financeiro-sync.js`. Usada pelo server.js.

- [ ] **Step 1: Adicionar a função em `sync/financeiro-sync.js`**

No topo, junto dos requires existentes:
```js
const { parseCashFlow, janela24m } = require('../lib/financeiro/fluxo-futuro');
const { dataLocal } = require('../lib/financeiro/data');
```

Antes do `module.exports`:
```js
// Fluxo futuro (A Receber / A Pagar, 24 meses) — 1 chamada list_cash_flow.
// Upsert por mês + limpeza dos meses passados (a tabela guarda só o futuro).
async function syncFluxoFuturo(hojeISO = dataLocal(new Date().toISOString())) {
  const { from, to } = janela24m(hojeISO);
  const r = await api.get('/financial/list_cash_flow', { from, to });
  const meses = parseCashFlow(r, from);
  const agora = new Date().toISOString();
  const rows = meses.map(m => ({
    mes: m.mes + '-01', a_receber: m.a_receber, a_pagar: m.a_pagar, atualizado_em: agora,
  }));
  if (rows.length) {
    const { error } = await supabase.from('fin_fluxo_futuro').upsert(rows, { onConflict: 'mes' });
    if (error) throw new Error(error.message);
  }
  await supabase.from('fin_fluxo_futuro').delete().lt('mes', hojeISO.slice(0, 7) + '-01');
  return { meses: rows.length };
}
```

E o export final vira:
```js
module.exports = { syncPeriodo, syncFluxoFuturo };
```

- [ ] **Step 2: Wiring no server.js**

Linha 29 — trocar:
```js
const { syncPeriodo: syncFinanceiro } = require('./sync/financeiro-sync');
```
por:
```js
const { syncPeriodo: syncFinanceiro, syncFluxoFuturo } = require('./sync/financeiro-sync');
```

No bloco das 02h (server.js ~4475), logo APÓS o `catch` do `[financeiro-sync]` e ANTES do comentário do `fetchInadimplentesBackground`, inserir bloco isolado:
```js
    // A Receber / A Pagar (24m) — 1 chamada list_cash_flow, erro não derruba as demais fases
    try {
      await syncFluxoFuturo();
      console.log('[fluxo-futuro] 24m sincronizado');
    } catch (e) { console.error('[fluxo-futuro] erro:', e.message); }
```

No `POST /api/financeiro/sync` (~7559) — trocar o handler por:
```js
app.post('/api/financeiro/sync', requireAuth, requireFinanceiro, async (req, res) => {
  const { from, to } = _finMesCorrente();
  try {
    const r = await syncFinanceiro(from, to);
    // fluxo futuro no mesmo botão; falha aqui não invalida o sync da DRE
    try { await syncFluxoFuturo(); }
    catch (e) { console.error('[fluxo-futuro] erro:', e.message); }
    res.json(r);
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 3: Smoke test real (1 chamada Clinicorp)**

Run: `node -e "require('./sync/financeiro-sync').syncFluxoFuturo().then(r => console.log(r)).catch(e => { console.error(e.message); process.exit(1); })"`
Expected: `{ meses: 24 }` ou `{ meses: 25 }`

Depois, via MCP `execute_sql`:
```sql
select min(mes) as primeiro, max(mes) as ultimo, count(*) as n,
       round(sum(a_receber)) as receber, round(sum(a_pagar)) as pagar
from fin_fluxo_futuro;
```
Expected: `primeiro` = mês corrente, `n` = 24–25, `receber`/`pagar` na casa de centenas de milhares a ~2M. Conferir julho/2026 ≈ receber 153k / pagar 170k (valores do teste da spec; podem variar um pouco).

- [ ] **Step 4: Rodar TODOS os testes do financeiro (regressão)**

Run: `node --test lib/financeiro/`
Expected: todos passam (11+ existentes + 6 novos)

- [ ] **Step 5: Commit**

```bash
git add sync/financeiro-sync.js server.js
git commit -m "feat(financeiro): syncFluxoFuturo no sync 02h e no botão Atualizar dados"
```

---

### Task 4: Endpoint `GET /api/financeiro/saude` + `FinAPI.saude`

**Files:**
- Modify: `server.js` (novo endpoint junto dos demais `/api/financeiro/*`, após o `/a-categorizar/resumo` ~linha 7474)
- Modify: `public/js/financeiro/api.js` (nova entrada no objeto `window.FinAPI`)

**Interfaces:**
- Consumes: tabela `fin_fluxo_futuro` + RPC `fin_vencido_total` (Task 2).
- Produces: `GET /api/financeiro/saude` → `{ meses: [{mes:'YYYY-MM', a_receber, a_pagar}], vencido: Number, atualizado_em: string|null }`; `FinAPI.saude()` no browser. Usados pela Task 5.

- [ ] **Step 1: Endpoint no server.js**

```js
// Saúde 24m: a receber × a pagar por mês (fin_fluxo_futuro) + vencido a receber
app.get('/api/financeiro/saude', requireAuth, requireFinanceiro, async (req, res) => {
  const [fluxo, vencido] = await Promise.all([
    supabase.from('fin_fluxo_futuro').select('mes,a_receber,a_pagar,atualizado_em').order('mes'),
    supabase.rpc('fin_vencido_total'),
  ]);
  if (fluxo.error) return res.status(500).json({ error: fluxo.error.message });
  if (vencido.error) return res.status(500).json({ error: vencido.error.message });
  res.json({
    meses: (fluxo.data || []).map(r => ({
      mes: String(r.mes).slice(0, 7), a_receber: Number(r.a_receber), a_pagar: Number(r.a_pagar),
    })),
    vencido: Number(vencido.data || 0),
    atualizado_em: (fluxo.data || [])[0]?.atualizado_em || null,
  });
});
```

- [ ] **Step 2: `FinAPI.saude` em public/js/financeiro/api.js**

Dentro do objeto `window.FinAPI`, junto das entradas existentes:
```js
  saude: () => api('/api/financeiro/saude'),
```

- [ ] **Step 3: Sanity check de sintaxe**

Run: `node --check server.js && node --check public/js/financeiro/api.js`
Expected: sem output (exit 0)

- [ ] **Step 4: Commit**

```bash
git add server.js public/js/financeiro/api.js
git commit -m "feat(financeiro): endpoint /api/financeiro/saude"
```

---

### Task 5: Página `/financeiro/saude/` + item no nav

**Files:**
- Create: `public/financeiro/saude/index.html`
- Create: `public/js/financeiro/saude-page.js`
- Modify: `public/js/nav-config.js` (seção `financeiro-sec`, ~linha 97)

**Interfaces:**
- Consumes: `FinAPI.saude()` e `FinAPI.sync()` (Task 4 / api.js existente); `shared-nav.js` (`data-active` deve bater com o slug novo); Chart.js CDN.
- Produces: página final. Nada consome dela.

- [ ] **Step 1: Item no nav-config.js**

Na seção `financeiro-sec`, logo abaixo do item `financeiro` (DRE):
```js
      { slug: 'financeiro-saude', label: 'A Receber / A Pagar', roles: 'financeiro,mod_financeiro', mode: 'link', href: '/financeiro/saude/' },
```

- [ ] **Step 2: Criar `public/financeiro/saude/index.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>A Receber / A Pagar — AMA</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root[data-theme="dark"] {
  --bg: #0f1117; --bg2: #181b24; --bg3: #1e2230; --border: #2a2f42;
  --text: #e8eaf0; --muted: #6b7280; --accent: #4f8ef7; --accent-hover: #3a78e0;
  --green: #22c55e; --yellow: #f59e0b; --red: #ef4444;
  --nota-bg: rgba(245, 158, 11, .16); --ruim-bg: rgba(239, 68, 68, .10);
}
:root[data-theme="light"] {
  --bg: #f7f8fa; --bg2: #ffffff; --bg3: #f1f3f7; --border: #e3e6ed;
  --text: #1a1d29; --muted: #6b7280; --accent: #3b82f6; --accent-hover: #2563eb;
  --green: #16a34a; --yellow: #d97706; --red: #dc2626;
  --nota-bg: rgba(217, 119, 6, .14); --ruim-bg: rgba(220, 38, 38, .08);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'DM Sans', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
.fin-wrap { padding: 20px 24px; }
.fin-header { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; flex-wrap: wrap; }
.fin-header h1 { font-size: 20px; font-weight: 700; flex: 1; min-width: 200px; }
.fin-sub { font-size: 12px; color: var(--muted); margin-bottom: 16px; }
.btn { padding: 7px 16px; border-radius: 8px; font-size: 13px; font-weight: 600;
  cursor: pointer; border: none; font-family: inherit; transition: all .15s; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { background: var(--accent-hover); }
.btn-primary:disabled { opacity: .6; cursor: default; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px; margin-bottom: 16px; }
.kpi { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 14px; }
.kpi .kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: .5px;
  color: var(--muted); font-weight: 600; margin-bottom: 6px; }
.kpi .kpi-valor { font-size: 19px; font-weight: 700; }
.kpi .kpi-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
.kpi a { color: var(--accent); text-decoration: none; font-weight: 600; }
.nota { padding: 10px 14px; margin-bottom: 16px; border-radius: 10px; font-size: 13px;
  background: var(--nota-bg); border: 1px solid var(--yellow); }
.card { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px;
  padding: 16px; margin-bottom: 16px; }
.chart-wrap { height: 320px; position: relative; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 8px 10px; text-align: right; border-bottom: 1px solid var(--border); }
th:first-child, td:first-child { text-align: left; }
th { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); }
tr.ruim td { background: var(--ruim-bg); }
td.dif-pos { color: var(--green); font-weight: 600; }
td.dif-neg { color: var(--red); font-weight: 600; }
.vazio { padding: 24px; text-align: center; color: var(--muted); font-size: 14px; }
@media (max-width: 700px) { .fin-wrap { padding: 12px; } .chart-wrap { height: 240px; } }
</style>
</head>
<body>
<script src="/js/shared-nav.js" data-active="financeiro-saude"></script>
<div class="fin-wrap">
  <div class="fin-header">
    <h1>💸 A Receber / A Pagar — próximos 24 meses</h1>
    <button class="btn btn-primary" id="btn-sync">🔄 Atualizar dados</button>
  </div>
  <div class="fin-sub" id="atualizado"></div>

  <div class="kpis">
    <div class="kpi"><div class="kpi-label">A receber (24m)</div><div class="kpi-valor" id="kpi-receber">—</div><div class="kpi-sub">parcelas a vencer contratadas</div></div>
    <div class="kpi"><div class="kpi-label">A pagar (24m)</div><div class="kpi-valor" id="kpi-pagar">—</div><div class="kpi-sub">contas lançadas no Clinicorp</div></div>
    <div class="kpi"><div class="kpi-label">Diferença</div><div class="kpi-valor" id="kpi-diferenca">—</div><div class="kpi-sub">receber − pagar</div></div>
    <div class="kpi"><div class="kpi-label">Vencido a receber</div><div class="kpi-valor" id="kpi-vencido">—</div><div class="kpi-sub"><a href="/?page=inadimplentes">ver Inadimplentes →</a></div></div>
  </div>

  <div class="nota">⚠️ As contas <b>a pagar</b> são lançadas com poucos meses de antecedência —
  os meses mais distantes mostram menos saída do que realmente haverá. O lado
  <b>a receber</b> (parcelas de pacientes) tem horizonte mais longo.</div>

  <div class="card"><div class="chart-wrap"><canvas id="grafico"></canvas></div></div>

  <div class="card">
    <table>
      <thead><tr><th>Mês</th><th>A receber</th><th>A pagar</th><th>Diferença</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
    <div class="vazio" id="vazio" style="display:none">Sem dados ainda — clique em "🔄 Atualizar dados" para buscar do Clinicorp.</div>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js" integrity="sha384-JUh163oCRItcbPme8pYnROHQMC6fNKTBWtRG3I3I0erJkzNgL7uxKlNwcrcFKeqF" crossorigin="anonymous"></script>
<script src="/js/financeiro/api.js"></script>
<script src="/js/financeiro/saude-page.js"></script>
</body>
</html>
```

- [ ] **Step 3: Criar `public/js/financeiro/saude-page.js`**

```js
(function () {
  const $ = (id) => document.getElementById(id);
  const fmt = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const MESES_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const rotulo = (ym) => { const [y, m] = ym.split('-').map(Number); return `${MESES_PT[m - 1]}/${String(y).slice(2)}`; };
  let chart = null;

  function render(d) {
    const receber = d.meses.reduce((s, m) => s + m.a_receber, 0);
    const pagar = d.meses.reduce((s, m) => s + m.a_pagar, 0);
    const dif = receber - pagar;
    $('kpi-receber').textContent = fmt(receber);
    $('kpi-pagar').textContent = fmt(pagar);
    $('kpi-diferenca').textContent = fmt(dif);
    $('kpi-diferenca').style.color = dif >= 0 ? 'var(--green)' : 'var(--red)';
    $('kpi-vencido').textContent = fmt(d.vencido);
    $('atualizado').textContent = d.atualizado_em
      ? 'Atualizado em ' + new Date(d.atualizado_em).toLocaleString('pt-BR') : '';

    const vazio = !d.meses.length;
    $('vazio').style.display = vazio ? '' : 'none';
    if (vazio) { if (chart) { chart.destroy(); chart = null; } $('tbody').innerHTML = ''; return; }

    const css = getComputedStyle(document.documentElement);
    if (chart) chart.destroy();
    chart = new Chart($('grafico'), {
      type: 'bar',
      data: {
        labels: d.meses.map(m => rotulo(m.mes)),
        datasets: [
          { label: 'A receber', data: d.meses.map(m => m.a_receber), backgroundColor: css.getPropertyValue('--green').trim() },
          { label: 'A pagar',   data: d.meses.map(m => m.a_pagar),   backgroundColor: css.getPropertyValue('--red').trim() },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: css.getPropertyValue('--text').trim() } } },
        scales: {
          x: { ticks: { color: css.getPropertyValue('--muted').trim() }, grid: { display: false } },
          y: { ticks: { color: css.getPropertyValue('--muted').trim(), callback: v => 'R$ ' + Math.round(v / 1000) + 'k' },
               grid: { color: css.getPropertyValue('--border').trim() } },
        },
      },
    });

    $('tbody').innerHTML = d.meses.map(m => {
      const md = m.a_receber - m.a_pagar;
      return `<tr class="${md < 0 ? 'ruim' : ''}"><td>${rotulo(m.mes)}</td><td>${fmt(m.a_receber)}</td>` +
        `<td>${fmt(m.a_pagar)}</td><td class="${md >= 0 ? 'dif-pos' : 'dif-neg'}">${fmt(md)}</td></tr>`;
    }).join('');
  }

  async function carregar() { render(await FinAPI.saude()); }

  $('btn-sync').addEventListener('click', async () => {
    const b = $('btn-sync'); b.disabled = true; b.textContent = 'Atualizando…';
    try { await FinAPI.sync(); await carregar(); }
    catch (e) { alert('Erro ao atualizar: ' + e.message); }
    finally { b.disabled = false; b.textContent = '🔄 Atualizar dados'; }
  });

  carregar().catch(e => { $('atualizado').textContent = 'Erro ao carregar: ' + e.message; });
})();
```

- [ ] **Step 4: Sanity check**

Run: `node --check public/js/financeiro/saude-page.js && node --check public/js/nav-config.js`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add public/financeiro/saude/index.html public/js/financeiro/saude-page.js public/js/nav-config.js
git commit -m "feat(financeiro): página A Receber / A Pagar (saúde 24m)"
```

---

### Task 6: Push, deploy e verificação ponta-a-ponta

**Files:** nenhum novo (integração).

- [ ] **Step 1: Regressão completa dos testes do financeiro**

Run: `node --test lib/financeiro/`
Expected: todos passam.

- [ ] **Step 2: Push (com cuidado do workdir concorrente)**

```bash
git pull --rebase origin main
git push origin main
```
Se o rebase acusar conflito real, PARAR e reportar (não forçar).

- [ ] **Step 3: Deploy Easypanel (sem perguntar)**

```bash
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```
Aguardar ~2 min. ⚠️ Se o conteúdo servido não trocar, é o swap travado do Easypanel — workaround é Stop→Start no painel (nunca Destroy); checar o CONTEÚDO servido, não Last-Modified.

- [ ] **Step 4: Smoke pós-deploy**

```bash
curl -s -o /dev/null -w "%{http_code}" "https://plataformaama-plataforma.uc5as5.easypanel.host/financeiro/saude/"
```
Expected: `200`. E `curl -s .../api/financeiro/saude` sem token → `401` (auth ativa).

- [ ] **Step 5: Checklist de validação logado (fica para o Luiz)**

1. Menu Financeiro → "A Receber / A Pagar" aparece (roles financeiro/mod_financeiro/admin).
2. Cards, gráfico e tabela consistentes entre si; jul/2026 ≈ receber R$153k / pagar R$170k.
3. Virada de ano correta (jan/27 depois de dez/26).
4. Card Vencido bate com `select fin_vencido_total()`.
5. Botão "Atualizar dados" roda e atualiza o timestamp.
