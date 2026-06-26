# Qualidade de Lead por Campanha + Restyle do Agente de Marketing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar ao Agente de Marketing um painel que ranqueia campanhas Meta por etapa de qualificação do lead (padrão "sem interesse" = Perdido + Não tem Interesse), e reestilizar a página para o padrão de tema do resto do sistema.

**Architecture:** Backend Express (`server.js`) ganha 2 rotas (`/api/marketing/qualidade-lead` e `.../drill`) apoiadas numa RPC Postgres nova que devolve o breakdown por status de cada campanha; o front recalcula/ordena por etapa sem novo round-trip. A lógica pura de ranking vive em `lib/marketing/qualidade.js` (testável). A página vira duas abas (ROAS existente + Qualidade) e adota os tokens de tema (`var(--bg)` etc.).

**Tech Stack:** Node.js + Express, Supabase (Postgres RPC), HTML/CSS/JS vanilla, runner de testes `node --test`.

## Global Constraints

- Backend: rotas usam `requireAuth, requireRole('admin','gestor'), rateLimit` (padrão das rotas `/api/marketing/*` vizinhas em `server.js`).
- Meta Graph: usar `META_API_VERSION` (`'v21.0'`, server.js:2720) e `META_AD_ACCOUNT_ID` (server.js:5921); token = `process.env.META_ADS_TOKEN || process.env.META_ACCESS_TOKEN`. Sem token → resposta com `sem_token:true`, mostra IDs crus, nunca quebra.
- Supabase project id: `mtqdpjhhqzvuklnlfpvi`. Aplicar DDL via MCP `apply_migration`. Nunca somar no JS o que pode ser truncado em 1000 linhas — agregação sempre no SQL/RPC.
- Anti-XSS: toda string externa (nome de campanha do Meta, nome do lead) passa pelo `esc()` já existente em `public/js/marketing-agente/app.js` antes de ir ao `innerHTML`.
- Tema: NÃO inventar cores; usar os tokens `--bg, --bg2, --bg3, --border, --text, --muted, --accent, --green, --red, --yellow` exatamente como definidos em `public/capi-saude/index.html:9-10`.
- Deep-link de lead: `/?abrir_lead=<id>` (handler em `public/index.html:5627`).
- Status válidos (domínio atual): `Novo, Em qualificação, Avaliação agendada, Em negociação, Compareceu, Fechou, Perdido, Não tem Interesse`.
- Testes só onde há lógica pura (`lib/`); HTML/DOM e SQL validam-se manualmente/por query, conforme o restante do repo (não há framework de teste de front).

---

### Task 1: Lógica pura de ranking — `lib/marketing/qualidade.js`

**Files:**
- Create: `lib/marketing/qualidade.js`
- Test: `lib/marketing/qualidade.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `METRICAS` — array de `{ key:string, label:string, status:string[], tom:'ruim'|'bom' }`.
  - `metricaPorKey(key:string) -> objeto de METRICAS` (cai em `METRICAS[0]` = `sem_interesse` se key desconhecida).
  - `valorDaMetrica(porStatus:object, metrica:objeto) -> number` (soma as contagens dos status da métrica).
  - `rankCampanhas(campanhas:Array<{campanha_id,campanha_nome,total,por_status}>, metricaKey:string, opts?:{ordenarPor?:'volume'|'taxa', minLeads?:number}) -> Array<{...campanha, valor:number, taxa:number}>` — filtra `valor>0`; em `'taxa'` filtra `total>=minLeads` e ordena por taxa desc; em `'volume'` (default) ordena por valor desc.

- [ ] **Step 1: Write the failing test**

Create `lib/marketing/qualidade.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { METRICAS, metricaPorKey, valorDaMetrica, rankCampanhas } = require('./qualidade');

const CAMPS = [
  { campanha_id: 'A', campanha_nome: 'Camp A', total: 10, por_status: { 'Perdido': 6, 'Não tem Interesse': 2, 'Fechou': 1 } },
  { campanha_id: 'B', campanha_nome: 'Camp B', total: 4,  por_status: { 'Perdido': 3, 'Fechou': 1 } },
  { campanha_id: 'C', campanha_nome: 'Camp C', total: 20, por_status: { 'Fechou': 5 } },
];

test('METRICAS começa em sem_interesse e tem as 7 etapas', () => {
  assert.strictEqual(METRICAS[0].key, 'sem_interesse');
  assert.deepStrictEqual(METRICAS[0].status, ['Perdido', 'Não tem Interesse']);
  assert.strictEqual(METRICAS.length, 7);
});

test('metricaPorKey cai em sem_interesse quando key é desconhecida', () => {
  assert.strictEqual(metricaPorKey('xpto').key, 'sem_interesse');
  assert.strictEqual(metricaPorKey('fechou').key, 'fechou');
});

test('valorDaMetrica soma os status da métrica', () => {
  assert.strictEqual(valorDaMetrica({ 'Perdido': 6, 'Não tem Interesse': 2 }, metricaPorKey('sem_interesse')), 8);
  assert.strictEqual(valorDaMetrica({ 'Fechou': 1 }, metricaPorKey('sem_interesse')), 0);
});

test('rankCampanhas por volume (default) ordena por valor desc e filtra valor 0', () => {
  const r = rankCampanhas(CAMPS, 'sem_interesse');
  assert.deepStrictEqual(r.map(c => c.campanha_id), ['A', 'B']); // C tem valor 0 → fora
  assert.strictEqual(r[0].valor, 8);
  assert.strictEqual(r[0].taxa, 0.8);
});

test('rankCampanhas por taxa aplica minLeads', () => {
  const r = rankCampanhas(CAMPS, 'sem_interesse', { ordenarPor: 'taxa', minLeads: 5 });
  assert.deepStrictEqual(r.map(c => c.campanha_id), ['A']); // B total 4 < 5 → fora
});

test('rankCampanhas por etapa boa (fechou) muda o ranking', () => {
  const r = rankCampanhas(CAMPS, 'fechou');
  assert.deepStrictEqual(r.map(c => c.campanha_id), ['C', 'A', 'B']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/marketing/qualidade.test.js`
Expected: FAIL — `Cannot find module './qualidade'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/marketing/qualidade.js`:

```js
// Etapas do funil expostas como "métricas" do painel de Qualidade de Lead.
// A ordem importa: METRICAS[0] é o default ("sem interesse"). `tom` decide a cor
// da pill no front (ruim = vermelho, bom = verde).
const METRICAS = [
  { key: 'sem_interesse', label: 'Sem interesse',       status: ['Perdido', 'Não tem Interesse'], tom: 'ruim' },
  { key: 'perdido',       label: 'Perdido',             status: ['Perdido'],                       tom: 'ruim' },
  { key: 'qualificacao',  label: 'Em qualificação',     status: ['Em qualificação'],               tom: 'bom'  },
  { key: 'agendada',      label: 'Avaliação agendada',  status: ['Avaliação agendada'],            tom: 'bom'  },
  { key: 'compareceu',    label: 'Compareceu',          status: ['Compareceu'],                    tom: 'bom'  },
  { key: 'negociacao',    label: 'Em negociação',       status: ['Em negociação'],                 tom: 'bom'  },
  { key: 'fechou',        label: 'Fechou',              status: ['Fechou'],                        tom: 'bom'  },
];

function metricaPorKey(key) {
  return METRICAS.find(m => m.key === key) || METRICAS[0];
}

function valorDaMetrica(porStatus, metrica) {
  return metrica.status.reduce((s, st) => s + ((porStatus && porStatus[st]) || 0), 0);
}

function rankCampanhas(campanhas, metricaKey, opts) {
  const { ordenarPor = 'volume', minLeads = 5 } = opts || {};
  const metrica = metricaPorKey(metricaKey);
  let rows = (campanhas || []).map(c => {
    const valor = valorDaMetrica(c.por_status, metrica);
    return Object.assign({}, c, { valor, taxa: c.total > 0 ? valor / c.total : 0 });
  }).filter(r => r.valor > 0);
  if (ordenarPor === 'taxa') {
    rows = rows.filter(r => r.total >= minLeads).sort((a, b) => (b.taxa - a.taxa) || (b.valor - a.valor));
  } else {
    rows.sort((a, b) => (b.valor - a.valor) || (b.taxa - a.taxa));
  }
  return rows;
}

module.exports = { METRICAS, metricaPorKey, valorDaMetrica, rankCampanhas };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/marketing/qualidade.test.js`
Expected: PASS — 6 tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add lib/marketing/qualidade.js lib/marketing/qualidade.test.js
git commit -m "feat(marketing): lógica pura de ranking de qualidade de lead por campanha"
```

---

### Task 2: RPC Postgres `marketing_qualidade_lead`

**Files:**
- Migration via MCP Supabase `apply_migration` (name: `marketing_qualidade_lead`).

**Interfaces:**
- Consumes: tabela `leads` (colunas `campanha text`, `status text`, `criado_em timestamptz`).
- Produces: function `marketing_qualidade_lead(p_desde date, p_ate date)` retornando linhas `(campanha_id text, total bigint, por_status jsonb)`. `campanha_id` é `NULL` para leads sem campanha. `por_status` = `{ "<status>": <count> }`. `total` = nº de leads da campanha no período.

- [ ] **Step 1: Aplicar a migração**

Via MCP `mcp__plugin_supabase_supabase__apply_migration` (project `mtqdpjhhqzvuklnlfpvi`, name `marketing_qualidade_lead`):

```sql
create or replace function marketing_qualidade_lead(p_desde date, p_ate date)
returns table(campanha_id text, total bigint, por_status jsonb)
language sql
stable
as $$
  select
    g.campanha as campanha_id,
    sum(g.cnt)::bigint as total,
    jsonb_object_agg(g.status, g.cnt) as por_status
  from (
    select
      nullif(trim(coalesce(campanha, '')), '') as campanha,
      status,
      count(*) as cnt
    from leads
    where criado_em >= p_desde::timestamptz
      and criado_em <  ((p_ate)::date + 1)::timestamptz
    group by 1, 2
  ) g
  group by g.campanha;
$$;
```

- [ ] **Step 2: Validar contra números conhecidos**

Via MCP `execute_sql` (project `mtqdpjhhqzvuklnlfpvi`):

```sql
select campanha_id, total, por_status
from marketing_qualidade_lead((now() - interval '90 days')::date, now()::date)
where campanha_id = '120247232763550629';
```

Expected: 1 linha, `total = 10`, e `por_status` contendo `"Perdido"` + `"Não tem Interesse"` somando 8 (campanha que sabíamos ser 8 sem-interesse / 10 total). Conferir também que existe uma linha com `campanha_id` nulo (balde sem campanha).

- [ ] **Step 3: Registrar a migração no repo**

Confirmar via MCP `list_migrations` que `marketing_qualidade_lead` aparece. (DDL fica no Supabase; não há arquivo a commitar neste passo — o commit de código é no Task 3.)

---

### Task 3: Rotas backend `/api/marketing/qualidade-lead` e `.../drill`

**Files:**
- Modify: `server.js` — inserir as 2 rotas logo após o bloco `/api/marketing/drill/paciente` (~server.js:6115), antes de `/api/marketing/config`.

**Interfaces:**
- Consumes: `METRICAS`, `metricaPorKey` de `lib/marketing/qualidade.js`; RPC `marketing_qualidade_lead`; constantes `META_API_VERSION`, `META_AD_ACCOUNT_ID`.
- Produces:
  - `GET /api/marketing/qualidade-lead?periodo=&desde=&ate=` → `{ desde, ate, sem_token, metricas:[{key,label,status,tom}], campanhas:[{campanha_id,campanha_nome,resolvido,total,por_status}], sem_campanha:{total,por_status} }`. `campanhas` ordenado por nº de leads da campanha desc (ordenação final por etapa é no front).
  - `GET /api/marketing/qualidade-lead/drill?campanha_id=&metrica=&periodo=&desde=&ate=` → `{ leads:[{lead_id,nome,status,criado_em}] }`. `campanha_id=__none__` = balde sem campanha.

- [ ] **Step 1: Importar a lib no topo do server.js**

Localizar o bloco de `require(...)` no topo de `server.js` e adicionar (perto dos outros require de `lib/`):

```js
const { METRICAS: MKT_METRICAS, metricaPorKey: mktMetricaPorKey } = require('./lib/marketing/qualidade');
```

- [ ] **Step 2: Inserir a rota de ranking**

Inserir após a rota `/api/marketing/drill/paciente` (logo antes de `app.get('/api/marketing/config', ...)`):

```js
app.get('/api/marketing/qualidade-lead', requireAuth, requireRole('admin', 'gestor'), rateLimit, async (req, res) => {
  try {
    const _parseDate = (s) => { const d = new Date(s); if (isNaN(d.getTime())) throw Object.assign(new Error('Data inválida'), { status: 400 }); return d; };
    const periodo = parseInt(req.query.periodo, 10) || 30;
    const dDesde = req.query.desde ? _parseDate(req.query.desde) : new Date(Date.now() - periodo * 86400000);
    const dAte   = req.query.ate   ? _parseDate(req.query.ate)   : new Date();
    const ymd = d => d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

    const { data: rpc, error } = await supabase.rpc('marketing_qualidade_lead', { p_desde: ymd(dDesde), p_ate: ymd(dAte) });
    if (error) throw new Error(error.message);

    // Resolve id da campanha Meta -> nome legível (1 chamada; cai pro ID se faltar token/nome).
    const nomes = {};
    let semToken = true;
    const TOKEN = process.env.META_ADS_TOKEN || process.env.META_ACCESS_TOKEN;
    if (TOKEN) {
      semToken = false;
      const url = 'https://graph.facebook.com/' + META_API_VERSION + '/act_' + META_AD_ACCOUNT_ID +
        '/campaigns?fields=id,name&limit=500';
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 25000);
      try {
        const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + TOKEN }, signal: ctrl.signal });
        const j = await r.json();
        (j.data || []).forEach(c => { nomes[c.id] = c.name; });
      } catch (_) { /* segue com IDs crus */ } finally { clearTimeout(to); }
    }

    const campanhas = [];
    let semCampanha = { total: 0, por_status: {} };
    (rpc || []).forEach(row => {
      if (row.campanha_id == null) { semCampanha = { total: Number(row.total) || 0, por_status: row.por_status || {} }; return; }
      const nome = nomes[row.campanha_id];
      campanhas.push({
        campanha_id: row.campanha_id,
        campanha_nome: nome || row.campanha_id,
        resolvido: !!nome,
        total: Number(row.total) || 0,
        por_status: row.por_status || {},
      });
    });
    campanhas.sort((a, b) => b.total - a.total);

    res.json({
      desde: ymd(dDesde), ate: ymd(dAte), sem_token: semToken,
      metricas: MKT_METRICAS.map(m => ({ key: m.key, label: m.label, status: m.status, tom: m.tom })),
      campanhas, sem_campanha: semCampanha,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
```

- [ ] **Step 3: Inserir a rota de drill**

Logo abaixo da rota anterior:

```js
app.get('/api/marketing/qualidade-lead/drill', requireAuth, requireRole('admin', 'gestor'), rateLimit, async (req, res) => {
  try {
    const _parseDate = (s) => { const d = new Date(s); if (isNaN(d.getTime())) throw Object.assign(new Error('Data inválida'), { status: 400 }); return d; };
    const periodo = parseInt(req.query.periodo, 10) || 30;
    const dDesde = req.query.desde ? _parseDate(req.query.desde) : new Date(Date.now() - periodo * 86400000);
    const dAte   = req.query.ate   ? _parseDate(req.query.ate)   : new Date();
    const ymd = d => d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

    // metrica vinda do cliente é validada contra a lista conhecida (nunca status cru no filtro).
    const metrica = mktMetricaPorKey(String(req.query.metrica || 'sem_interesse'));
    const campId = String(req.query.campanha_id || '');

    let q = supabase.from('leads')
      .select('id, nome, status, criado_em')
      .in('status', metrica.status)
      .gte('criado_em', ymd(dDesde) + 'T00:00:00-03:00')
      .lt('criado_em', ymd(dAte) + 'T23:59:59-03:00')
      .order('criado_em', { ascending: false })
      .limit(200);
    if (campId === '__none__') q = q.is('campanha', null);
    else q = q.eq('campanha', campId);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ leads: (data || []).map(l => ({ lead_id: l.id, nome: l.nome, status: l.status, criado_em: l.criado_em })) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
```

- [ ] **Step 4: Smoke test manual das rotas**

Rodar o servidor localmente se possível (`node server.js`) e, autenticado, abrir no browser/fetch:
`/api/marketing/qualidade-lead?periodo=90`
Expected: JSON com `metricas` (7 itens), `campanhas` (array com `por_status`) e `sem_campanha`. Se não der pra subir local, validar pós-deploy (Task 7).

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(marketing): rotas qualidade-lead (ranking por etapa) + drill"
```

---

### Task 4: Restyle da página — tokens de tema + abas (ROAS preservado)

**Files:**
- Modify: `public/marketing-agente/index.html`

**Interfaces:**
- Consumes: tokens de `capi-saude/index.html:9-10`; `shared-nav.js` (já aplica `data-theme`).
- Produces: estrutura de 2 abas com containers `#tab-roas` e `#tab-qualidade`; botões `#aba-roas` / `#aba-qualidade`. A aba ROAS reusa os ids existentes (`#resumo`, `#lista`, `#lente`, `#periodo`, `#atualizar`, `#btn-config`) — **sem renomear**, para o `app.js` atual continuar funcionando.

- [ ] **Step 1: Reescrever o `<head>`/`<style>` com tokens e classes do padrão**

Substituir o `<html ...>` e o bloco `<style>...</style>` atuais por:

```html
<html lang="pt-BR" data-theme="dark">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="/favicon.ico">
  <title>Agente de Marketing</title>
  <style>
    :root { --bg:#0f1115; --bg2:#171a21; --bg3:#1f2330; --border:#2a2f3d; --text:#e8eaf0; --muted:#8b93a7; --accent:#4f8ef7; --green:#22c55e; --red:#ef4444; --yellow:#f59e0b; }
    [data-theme="light"] { --bg:#f5f6f8; --bg2:#fff; --bg3:#eef0f4; --border:#dde1e8; --text:#1a1d26; --muted:#6b7280; --accent:#2563eb; --green:#16a34a; --red:#dc2626; --yellow:#d97706; }
    body { font-family:system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; }
    .mkt-wrap { max-width: 1100px; margin: 0 auto; padding: 16px; }
    h1 { font-size:20px; margin-bottom:4px; }
    .sub { color:var(--muted); font-size:13px; margin-bottom:16px; }
    h2 { font-size:14px; text-transform:uppercase; letter-spacing:.4px; color:var(--muted); margin:22px 0 10px; }
    .mkt-tabs { display:flex; gap:8px; margin-bottom:16px; border-bottom:1px solid var(--border); }
    .mkt-tab { background:none; border:none; border-bottom:2px solid transparent; color:var(--muted); padding:8px 14px; font-size:14px; cursor:pointer; }
    .mkt-tab.active { color:var(--text); border-bottom-color:var(--accent); font-weight:600; }
    .mkt-controls { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:16px; }
    .mkt-controls select, .mkt-controls input { background:var(--bg2); border:1px solid var(--border); color:var(--text); border-radius:8px; padding:6px 10px; font-size:13px; }
    .btn { background:var(--bg2); border:1px solid var(--border); color:var(--text); border-radius:8px; padding:8px 14px; font-size:13px; cursor:pointer; }
    .btn:hover { background:var(--bg3); }
    .mkt-card { border:1px solid var(--border); border-radius:12px; padding:14px; margin-bottom:10px; background:var(--bg2); }
    .pill { display:inline-block; font-weight:600; padding:3px 10px; border-radius:999px; font-size:12px; }
    .pill-green { background:color-mix(in srgb, var(--green) 22%, transparent); color:var(--green); }
    .pill-red   { background:color-mix(in srgb, var(--red) 22%, transparent);   color:var(--red); }
    .pill-yellow{ background:color-mix(in srgb, var(--yellow) 22%, transparent); color:var(--yellow); }
    .pill-muted { background:var(--bg3); color:var(--muted); }
    .mkt-num { font-variant-numeric: tabular-nums; }
    .mkt-drill { margin-top:10px; padding-top:10px; border-top:1px dashed var(--border); font-size:13px; }
    .mkt-cobertura { font-size:12px; color:var(--muted); }
    .mkt-clickable { cursor:pointer; text-decoration:underline dotted; color:var(--accent); }
    .mkt-modal-bg { position:fixed; inset:0; background:rgba(0,0,0,.5); display:none; align-items:center; justify-content:center; z-index:50; }
    .mkt-modal-bg.open { display:flex; }
    .mkt-modal { background:var(--bg2); border:1px solid var(--border); border-radius:12px; padding:18px; width:320px; max-width:92vw; }
    .mkt-modal label { display:block; font-size:12px; color:var(--muted); margin:10px 0 4px; }
    .mkt-modal input { width:100%; box-sizing:border-box; background:var(--bg); border:1px solid var(--border); color:var(--text); border-radius:8px; padding:7px 9px; }
    .mkt-modal-acoes { display:flex; gap:8px; justify-content:flex-end; margin-top:16px; }
  </style>
</head>
```

- [ ] **Step 2: Reestruturar o `<body>` em abas (ROAS preservado + container de qualidade)**

Substituir o `<div id="app" class="mkt-wrap">...</div>` por:

```html
<div id="app" class="mkt-wrap">
  <h1>📊 Agente de Marketing</h1>
  <p class="sub">Read-only · cruza gasto Meta × resultado real do Clinicorp e mostra a qualidade do lead por campanha.</p>

  <div class="mkt-tabs">
    <button class="mkt-tab active" id="aba-roas">ROAS</button>
    <button class="mkt-tab" id="aba-qualidade">Qualidade de Lead</button>
  </div>

  <section id="tab-roas">
    <div class="mkt-controls">
      <label>Lente:
        <select id="lente"><option value="safra">Faturamento (safra)</option><option value="caixa">Caixa (entradas)</option></select>
      </label>
      <label>Período:
        <select id="periodo"><option value="30">30 dias</option><option value="90">90 dias</option><option value="365">12 meses</option></select>
      </label>
      <button class="btn" id="atualizar">🔄 Atualizar</button>
      <button class="btn" id="btn-config">⚙️ Parâmetros</button>
    </div>
    <div id="resumo"></div>
    <div id="lista"></div>
  </section>

  <section id="tab-qualidade" style="display:none">
    <div class="mkt-controls">
      <label>Etapa: <select id="q-metrica"></select></label>
      <label>Período:
        <select id="q-periodo"><option value="30">30 dias</option><option value="90" selected>90 dias</option><option value="365">12 meses</option></select>
      </label>
      <label>Ordenar: <select id="q-ordenar"><option value="volume">Volume</option><option value="taxa">Taxa (%)</option></select></label>
      <label>Mín. leads: <input id="q-minleads" type="number" min="1" value="5" style="width:64px"></label>
      <button class="btn" id="q-atualizar">🔄 Atualizar</button>
    </div>
    <div id="q-cobertura" class="mkt-cobertura" style="margin-bottom:10px"></div>
    <div id="q-lista"></div>
    <div id="q-semcamp" style="margin-top:14px"></div>
  </section>
</div>

<!-- Modal de parâmetros (substitui os prompt()) -->
<div class="mkt-modal-bg" id="cfg-modal-bg">
  <div class="mkt-modal">
    <h2 style="margin-top:0">Parâmetros</h2>
    <label>Meta de ROAS (x)</label><input id="cfg-roas" type="number" step="0.1">
    <label>Gasto mínimo (R$)</label><input id="cfg-gasto" type="number">
    <label>Maturação (dias)</label><input id="cfg-mat" type="number">
    <label>Cobertura mínima (0–1)</label><input id="cfg-cob" type="number" step="0.05">
    <div class="mkt-modal-acoes">
      <button class="btn" id="cfg-cancelar">Cancelar</button>
      <button class="btn" id="cfg-salvar" style="border-color:var(--accent);color:var(--accent)">Salvar</button>
    </div>
  </div>
</div>
```

(Mantém os scripts no fim do `<body>` como já estão: `api.js`, `app.js`, `shared-nav.js`.)

- [ ] **Step 3: Verificação manual do reskin (sem mexer em JS ainda)**

Abrir a página servida; a aba ROAS deve renderizar como antes (o `app.js` atual ainda roda `carregar()` e usa `#resumo`/`#lista`). Conferir no toggle de tema (botão da sidebar) que as cores mudam claro/escuro. As novas seções de Qualidade aparecem vazias (JS vem no Task 5). Os selos da ROAS ainda usam classes antigas `selo-*` — serão migrados no Task 5/6; aceitar provisoriamente.

- [ ] **Step 4: Commit**

```bash
git add public/marketing-agente/index.html
git commit -m "style(marketing): tokens de tema + abas + scaffold modal/qualidade"
```

---

### Task 5: Frontend — aba Qualidade de Lead (ranking + drill + cobertura)

**Files:**
- Modify: `public/js/marketing-agente/app.js`

**Interfaces:**
- Consumes: `mktApi(path)` de `api.js`; rotas do Task 3; ids do HTML do Task 4 (`#aba-roas`, `#aba-qualidade`, `#tab-roas`, `#tab-qualidade`, `#q-metrica`, `#q-periodo`, `#q-ordenar`, `#q-minleads`, `#q-atualizar`, `#q-cobertura`, `#q-lista`, `#q-semcamp`).
- Produces: troca de abas; render do ranking pela etapa selecionada; drill por campanha.

- [ ] **Step 1: Adicionar troca de abas e estado da aba qualidade (topo do app.js, após `let _state`)**

Inserir em `public/js/marketing-agente/app.js` logo após a linha `let _state = {...}`:

```js
let _q = { dados: null }; // cache da resposta de qualidade-lead

function trocarAba(qual) {
  const roas = qual === 'roas';
  document.getElementById('tab-roas').style.display = roas ? '' : 'none';
  document.getElementById('tab-qualidade').style.display = roas ? 'none' : '';
  document.getElementById('aba-roas').classList.toggle('active', roas);
  document.getElementById('aba-qualidade').classList.toggle('active', !roas);
  if (!roas && !_q.dados) carregarQualidade();
}

// Reimplementa o ranking do lib/marketing/qualidade.js no cliente (8 linhas; o backend
// envia `metricas[]` como fonte de verdade do mapeamento status→etapa).
function _valorMetrica(porStatus, metrica) {
  return (metrica.status || []).reduce((s, st) => s + ((porStatus && porStatus[st]) || 0), 0);
}
function _rank(campanhas, metrica, ordenarPor, minLeads) {
  let rows = (campanhas || []).map(c => {
    const valor = _valorMetrica(c.por_status, metrica);
    return Object.assign({}, c, { valor, taxa: c.total > 0 ? valor / c.total : 0 });
  }).filter(r => r.valor > 0);
  if (ordenarPor === 'taxa') rows = rows.filter(r => r.total >= minLeads).sort((a, b) => (b.taxa - a.taxa) || (b.valor - a.valor));
  else rows.sort((a, b) => (b.valor - a.valor) || (b.taxa - a.taxa));
  return rows;
}
function _metricaAtual() {
  const key = document.getElementById('q-metrica').value;
  const ms = (_q.dados && _q.dados.metricas) || [];
  return ms.find(m => m.key === key) || ms[0] || { key: 'sem_interesse', label: 'Sem interesse', status: ['Perdido', 'Não tem Interesse'], tom: 'ruim' };
}
```

- [ ] **Step 2: Buscar dados e popular o seletor de etapa**

Adicionar:

```js
async function carregarQualidade() {
  const periodo = document.getElementById('q-periodo').value;
  document.getElementById('q-lista').innerHTML = 'Carregando…';
  try {
    const d = await mktApi(`/api/marketing/qualidade-lead?periodo=${periodo}`);
    _q.dados = d;
    const sel = document.getElementById('q-metrica');
    if (!sel.options.length) {
      sel.innerHTML = d.metricas.map(m => `<option value="${esc(m.key)}">${esc(m.label)}</option>`).join('');
    }
    renderQualidade();
  } catch (e) { erro(document.getElementById('q-lista'), e.message); }
}
```

- [ ] **Step 3: Renderizar ranking + cobertura + balde sem campanha**

Adicionar:

```js
function renderQualidade() {
  const d = _q.dados; if (!d) return;
  const metrica = _metricaAtual();
  const ordenarPor = document.getElementById('q-ordenar').value;
  const minLeads = parseInt(document.getElementById('q-minleads').value, 10) || 1;
  const rows = _rank(d.campanhas, metrica, ordenarPor, minLeads);
  const pillCls = metrica.tom === 'ruim' ? 'pill-red' : 'pill-green';

  // Cobertura da etapa: quantos leads da etapa têm campanha identificada.
  const comCamp = d.campanhas.reduce((s, c) => s + _valorMetrica(c.por_status, metrica), 0);
  const semCamp = _valorMetrica(d.sem_campanha.por_status, metrica);
  const totalEtapa = comCamp + semCamp;
  document.getElementById('q-cobertura').innerHTML = totalEtapa
    ? `${Math.round(100 * comCamp / totalEtapa)}% dos leads de “${esc(metrica.label)}” têm campanha identificada (${comCamp} de ${totalEtapa})` + (d.sem_token ? ' · ⚠️ sem token Meta: mostrando IDs' : '')
    : `Nenhum lead em “${esc(metrica.label)}” no período.`;

  document.getElementById('q-lista').innerHTML = rows.length ? rows.map((c, idx) => `
    <div class="mkt-card">
      <div><span class="pill ${pillCls}">${c.valor} ${esc(metrica.label)}</span>
        <b>${esc(c.campanha_nome)}</b>${c.resolvido ? '' : ' <span class="mkt-cobertura">(ID não resolvido)</span>'}</div>
      <div class="mkt-cobertura mkt-num">${Math.round(c.taxa * 100)}% dos ${c.total} leads da campanha ·
        <span class="mkt-clickable" data-qcamp="${idx}">ver leads</span></div>
      <div class="mkt-drill" id="qdrill-${idx}" style="display:none"></div>
    </div>`).join('') : '<p>Nenhuma campanha nessa etapa/critério.</p>';
  document.querySelectorAll('[data-qcamp]').forEach(el => el.onclick = () => abrirQDrill(rows[el.dataset.qcamp], el.dataset.qcamp, metrica.key));

  const sc = d.sem_campanha; const scVal = _valorMetrica(sc.por_status, metrica);
  document.getElementById('q-semcamp').innerHTML = scVal ? `
    <div class="mkt-card" style="opacity:.7">
      <span class="pill pill-muted">${scVal}</span> <b>(sem campanha)</b>
      <span class="mkt-cobertura"> · leads sem origem de campanha (orgânico/manual) · </span>
      <span class="mkt-clickable" data-qcamp-none="1">ver leads</span>
      <div class="mkt-drill" id="qdrill-none" style="display:none"></div>
    </div>` : '';
  const noneEl = document.querySelector('[data-qcamp-none]');
  if (noneEl) noneEl.onclick = () => abrirQDrill({ campanha_id: '__none__' }, 'none', metrica.key);
}
```

- [ ] **Step 4: Drill — listar leads da campanha na etapa, linkando para a ficha**

Adicionar:

```js
async function abrirQDrill(camp, idx, metricaKey) {
  const box = document.getElementById('qdrill-' + idx);
  if (box.style.display === 'block') { box.style.display = 'none'; return; }
  box.style.display = 'block'; box.innerHTML = 'Carregando leads…';
  const periodo = document.getElementById('q-periodo').value;
  try {
    const d = await mktApi(`/api/marketing/qualidade-lead/drill?campanha_id=${encodeURIComponent(camp.campanha_id)}&metrica=${encodeURIComponent(metricaKey)}&periodo=${periodo}`);
    box.innerHTML = d.leads.length ? d.leads.map(l =>
      `<div>• <a class="mkt-clickable" href="/?abrir_lead=${encodeURIComponent(l.lead_id)}" target="_blank" rel="noopener">${esc(l.nome || '(sem nome)')}</a>
        <span class="mkt-cobertura">— ${esc(l.status)} · ${esc((l.criado_em || '').slice(0, 10))}</span></div>`
    ).join('') : '<i>Sem leads.</i>';
  } catch (e) { erro(box, e.message); }
}
```

- [ ] **Step 5: Ligar os eventos (fim do app.js, junto dos outros handlers)**

Adicionar antes da chamada final `carregar();`:

```js
document.getElementById('aba-roas').onclick = () => trocarAba('roas');
document.getElementById('aba-qualidade').onclick = () => trocarAba('qualidade');
document.getElementById('q-atualizar').onclick = carregarQualidade;
document.getElementById('q-periodo').onchange = carregarQualidade;
['q-metrica', 'q-ordenar', 'q-minleads'].forEach(id => document.getElementById(id).addEventListener('change', renderQualidade));
```

- [ ] **Step 6: Verificação manual**

Abrir a página, clicar na aba "Qualidade de Lead". Expected: seletor de Etapa com 7 opções (default "Sem interesse"); ranking de campanhas com `N Sem interesse` + `% dos leads`; trocar para "Fechou" reordena; "ver leads" expande e os nomes linkam para `/?abrir_lead=<id>`. Conferir a nota de cobertura e o card "(sem campanha)".

- [ ] **Step 7: Commit**

```bash
git add public/js/marketing-agente/app.js
git commit -m "feat(marketing): aba Qualidade de Lead (ranking por etapa + drill)"
```

---

### Task 6: UX — modal de Parâmetros + selos da ROAS no padrão pill

**Files:**
- Modify: `public/js/marketing-agente/app.js`

**Interfaces:**
- Consumes: modal `#cfg-modal-bg` e inputs `#cfg-roas/#cfg-gasto/#cfg-mat/#cfg-cob` (Task 4); rota `/api/marketing/config`.
- Produces: `#btn-config` abre modal em vez de `prompt()`; selos ROAS usam classes `pill`.

- [ ] **Step 1: Substituir o handler de `prompt()` por modal**

Em `app.js`, substituir todo o bloco `document.getElementById('btn-config').onclick = async () => { ... };` (os 4 `prompt()`) por:

```js
const cfgBg = document.getElementById('cfg-modal-bg');
document.getElementById('btn-config').onclick = async () => {
  const cfg = await mktApi('/api/marketing/config');
  document.getElementById('cfg-roas').value = cfg.meta_roas;
  document.getElementById('cfg-gasto').value = cfg.gasto_minimo;
  document.getElementById('cfg-mat').value = cfg.maturacao_dias;
  document.getElementById('cfg-cob').value = cfg.cobertura_minima;
  cfgBg.classList.add('open');
};
document.getElementById('cfg-cancelar').onclick = () => cfgBg.classList.remove('open');
cfgBg.onclick = (e) => { if (e.target === cfgBg) cfgBg.classList.remove('open'); };
document.getElementById('cfg-salvar').onclick = async () => {
  await mktApi('/api/marketing/config', { method: 'PUT', body: JSON.stringify({
    meta_roas: document.getElementById('cfg-roas').value,
    gasto_minimo: document.getElementById('cfg-gasto').value,
    maturacao_dias: document.getElementById('cfg-mat').value,
    cobertura_minima: document.getElementById('cfg-cob').value,
  }) });
  cfgBg.classList.remove('open');
  carregar();
};
```

- [ ] **Step 2: Migrar os selos da ROAS para o padrão pill**

No `renderLista` e `renderResumo`/`abrirDrill`, as classes `mkt-selo selo-${seloClass(c.selo)}` referenciam CSS que foi removido no Task 4. Mapear selo → pill. Adicionar perto do topo do app.js (após `SELO_OK`):

```js
const SELO_PILL = { escalar:'pill-green', cortar:'pill-red', observar:'pill-yellow', cobertura_baixa:'pill-muted', caixa:'pill-green' };
const seloPill = s => SELO_PILL[s] || 'pill-muted';
```

E trocar nas chamadas de render: onde houver `class="mkt-selo selo-${seloClass(c.selo)}"`, usar `class="pill ${seloPill(c.selo)}"`. No `abrirDrill`, onde monta `selo-${cls}` para o vínculo, trocar para `pill ${cls === 'escalar' ? 'pill-green' : cls === 'observar' ? 'pill-yellow' : 'pill-muted'}`.

- [ ] **Step 3: Verificação manual**

Abrir a aba ROAS: o botão "⚙️ Parâmetros" abre o modal preenchido; Salvar persiste e recarrega; os selos (Escalar/Cortar/Observar) aparecem como pills coloridas no tema. Cancelar/clicar fora fecha.

- [ ] **Step 4: Commit**

```bash
git add public/js/marketing-agente/app.js
git commit -m "feat(marketing): modal de parâmetros + selos ROAS no padrão pill"
```

---

### Task 7: Deploy + validação fim-a-fim

**Files:** nenhum (operacional).

- [ ] **Step 1: Conferir branch e rodar a suíte de testes**

```bash
git rev-parse --abbrev-ref HEAD   # esperar: main (ou worktree isolado)
node --test "lib/**/*.test.js"     # esperar: todos passam, incl. qualidade.test.js
```

- [ ] **Step 2: Push + deploy Easypanel do CRM**

```bash
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

- [ ] **Step 3: Validação no ar**

Abrir `https://plataformaama-plataforma.uc5as5.easypanel.host/marketing-agente/` logado como admin/gestor:
- Aba ROAS funciona como antes; modal de parâmetros OK.
- Aba Qualidade: etapa default "Sem interesse" mostra ranking; campanha `120247232763550629` aparece com ~8 e taxa ~80% (período 90d); trocar etapa para "Fechou" reordena; "ver leads" abre nomes que linkam para a ficha.
- Conferir tema claro/escuro alinhado ao resto do sistema.
- Confirmar via Easypanel que o container trocou (conferir conteúdo servido, não Last-Modified).

---

## Notas de execução

- **Working dir concorrente:** várias sessões trocam branch no mesmo `clinica-crm`. Conferir branch antes de cada commit; se preciso isolar, usar worktree.
- **Sem deep-link de ficha genérico:** `/?abrir_lead=<id>` abre o lead pela view de Conversas (depende do lead estar em `chatLeads`). Para leads Perdido fora de conversa pode não abrir — é a única convenção existente e está fora de escopo criar uma nova. Aceitar como limitação conhecida.
- **Duplicação consciente:** a lógica de ranking existe em `lib/marketing/qualidade.js` (testada, usada no server p/ validar `metrica`) e reimplementada em ~8 linhas no `app.js` (front não importa módulo node). A fonte de verdade do mapeamento status→etapa é o `metricas[]` enviado pela API.
