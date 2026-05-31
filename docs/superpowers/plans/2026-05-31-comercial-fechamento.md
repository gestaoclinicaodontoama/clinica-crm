# Dashboard Comercial Sub-1 — Fechamento, Entrada e Tempos por Fase — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Estender o Dashboard Comercial para contar fechamentos pelo mês em que fecharam (só particular), capturar a entrada (1º pagamento) automaticamente, exibir tempos por fase da jornada, e contar no funil só avaliações com orçamento criado.

**Architecture:** O sync passa a classificar orçamentos (particular vs convênio), gravar data de fechamento e entrada, carimbar tempos da avaliação e marcar quais avaliações têm orçamento. Funções puras novas (`lib/funil/orcamento.js`, `lib/funil/fechamentos.js`) agregam fechamentos por data de fechamento e tempos por fase. O endpoint e a página ganham os blocos novos.

**Tech Stack:** Node.js + Express (`server.js`), Supabase (Postgres + RLS), JS vanilla no front, testes com `node --test`. Spec: `docs/superpowers/specs/2026-05-31-comercial-fechamento-design.md`.

**Pré-requisito:** Sub-0 (commit a9cb7a1) já deployado: tabelas `avaliacoes`, `orcamentos`, `config_*`, sync com `syncAvaliacoes`/`syncOrcamentos`/`vincularLeads`, endpoint `/api/comercial/funil`, página `/comercial/`.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20260531000001_comercial_fechamento.sql` | Colunas novas em `orcamentos` e `avaliacoes` |
| `lib/funil/orcamento.js` (+ `.test.js`) | `classificarOrcamento` — particular vs convênio (pura) |
| `lib/funil/fechamentos.js` (+ `.test.js`) | `agregarFechamentos` e `temposPorFase` (puras) |
| `sync/clinicorp-sync.js` | orçamentos com classificação/fechamento; `syncEntradas`; timestamps + `marcarAvaliacoesComOrcamento` |
| `server.js` | endpoint `/api/comercial/funil` estendido |
| `public/comercial/index.html`, `public/js/comercial/app.js` | blocos "Fechamentos do mês" e "Tempos por fase" |

---

## Task 1: Migração — colunas novas

**Files:**
- Create: `supabase/migrations/20260531000001_comercial_fechamento.sql`

- [ ] **Step 1: Escrever a migração**

```sql
-- Sub-1 comercial: fechamento, entrada, tempos por fase, validade por orçamento
alter table public.orcamentos
  add column if not exists data_fechamento  date,
  add column if not exists valor_particular numeric(12,2) not null default 0,
  add column if not exists eh_convenio      boolean not null default false,
  add column if not exists entrada_valor     numeric(12,2),
  add column if not exists entrada_data      date;

create index if not exists idx_orcamentos_fechamento on public.orcamentos (data_fechamento);

alter table public.avaliacoes
  add column if not exists agendado_em       timestamptz,
  add column if not exists comparecimento_em timestamptz,
  add column if not exists tem_orcamento     boolean not null default false;

create index if not exists idx_avaliacoes_tem_orcamento on public.avaliacoes (tem_orcamento);
```

- [ ] **Step 2: Aplicar via MCP Supabase**

Aplicar com `apply_migration` (project_id `mtqdpjhhqzvuklnlfpvi`, name `comercial_fechamento`, query = conteúdo acima). Verificar com `list_tables` (verbose) que as colunas existem.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260531000001_comercial_fechamento.sql
git commit -m "feat(comercial): migracao colunas de fechamento/entrada/tempos"
```

---

## Task 2: `classificarOrcamento` — particular vs convênio (pura, TDD)

**Files:**
- Create: `lib/funil/orcamento.js`
- Test: `lib/funil/orcamento.test.js`

- [ ] **Step 1: Escrever o teste que falha**

```js
// lib/funil/orcamento.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { classificarOrcamento } = require('./orcamento');

test('soma só procedimentos particulares (ignora CLAIM/convênio)', () => {
  const o = { Amount: 1000, ProcedureList: [
    { FinalAmount: 800, BillType: 'PRIVATE' },
    { FinalAmount: 200, BillType: 'CLAIM', ClaimNumber: '123' },
  ]};
  const r = classificarOrcamento(o);
  assert.strictEqual(r.valorParticular, 800);
  assert.strictEqual(r.ehConvenio, false);
});

test('orçamento 100% convênio: valorParticular 0 e ehConvenio true', () => {
  const o = { Amount: 200, ProcedureList: [ { FinalAmount: 200, BillType: 'CLAIM', ClaimNumber: '9' } ] };
  const r = classificarOrcamento(o);
  assert.strictEqual(r.valorParticular, 0);
  assert.strictEqual(r.ehConvenio, true);
});

test('sem ProcedureList: usa Amount como particular (fallback)', () => {
  const o = { Amount: 500, ProcedureList: [] };
  const r = classificarOrcamento(o);
  assert.strictEqual(r.valorParticular, 500);
  assert.strictEqual(r.ehConvenio, false);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/funil/orcamento.test.js`
Expected: FAIL ("Cannot find module './orcamento'").

- [ ] **Step 3: Implementar**

```js
// lib/funil/orcamento.js
// Classifica um estimate da Clinicorp em valor particular (não-convênio) e flag de convênio.
function classificarOrcamento(o) {
  const procs = Array.isArray(o.ProcedureList) ? o.ProcedureList : [];
  if (procs.length === 0) {
    // Sem detalhe de procedimentos: assume particular pelo Amount total.
    return { valorParticular: Number(o.Amount || 0), ehConvenio: false };
  }
  let valorParticular = 0;
  for (const p of procs) {
    const convenio = p.BillType === 'CLAIM' || (p.ClaimNumber != null && p.ClaimNumber !== '');
    if (!convenio) valorParticular += Number(p.FinalAmount ?? p.Amount ?? 0);
  }
  valorParticular = Math.round(valorParticular * 100) / 100;
  const ehConvenio = valorParticular === 0;
  return { valorParticular, ehConvenio };
}

module.exports = { classificarOrcamento };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/funil/orcamento.test.js`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/funil/orcamento.js lib/funil/orcamento.test.js
git commit -m "feat(comercial): classificarOrcamento (particular vs convenio) com testes"
```

---

## Task 3: Sync — orçamentos com classificação e data de fechamento

**Files:**
- Modify: `sync/clinicorp-sync.js`

- [ ] **Step 1: Importar a função pura**

No topo de `sync/clinicorp-sync.js`, junto ao require de telefone:

```js
const { classificarOrcamento } = require('../lib/funil/orcamento');
```

- [ ] **Step 2: Atualizar o mapeamento em `syncOrcamentos`**

Em `syncOrcamentos`, substituir o objeto montado dentro do loop por:

```js
    const { valorParticular, ehConvenio } = classificarOrcamento(o);
    byId.set(id, {
      clinicorp_estimate_id: id,
      treatment_id:          o.TreatmentId != null ? String(o.TreatmentId) : null,
      paciente_clinicorp_id: String(o.PatientId || ''),
      telefone:              normalizarTelefone(o.PatientMobilePhone),
      profissional_nome:     o.ProfessionalName || '',
      valor:                 Number(o.Amount || 0),
      valor_particular:      valorParticular,
      eh_convenio:           ehConvenio,
      status:                o.Status || null,
      data_criacao:          toDate(o.CreateDate),
      data_fechamento:       o.Status === 'APPROVED' ? toDate(o.LastChange_Date) : null,
      atualizado_em:         new Date().toISOString(),
    });
```

- [ ] **Step 3: Verificar manualmente (após reset do rate limit)**

Run (script ad-hoc que chama só `syncOrcamentos` via require, igual ao `_verify_funil.js` do Sub-0):
`node -e "require('./sync/clinicorp-sync').syncOrcamentos().then(n=>console.log('orc',n))"`
Expected: log "Orçamentos: N" sem erro. MCP `execute_sql`:
`select count(*) filter (where valor_particular>0) particular, count(*) filter (where eh_convenio) convenio, count(*) filter (where data_fechamento is not null) com_fechamento from public.orcamentos;`
Conferir que `particular` é a maioria e `com_fechamento` bate com os APPROVED. Se `BillType`/`ClaimNumber`/`FinalAmount` vierem com outro nome (inspecionar 1 estimate cru), ajustar `classificarOrcamento` e re-rodar.

- [ ] **Step 4: Commit**

```bash
git add sync/clinicorp-sync.js
git commit -m "feat(comercial): sync classifica orcamento e grava data_fechamento"
```

---

## Task 4: Sync — entradas (1º pagamento)

**Files:**
- Modify: `sync/clinicorp-sync.js`

- [ ] **Step 1: Adicionar `syncEntradas`** (perto das outras fases do funil)

```js
async function syncEntradas() {
  log(`Buscando pagamentos do funil (${FUNIL_DIAS}d) para casar entradas...`);
  const pays = await fetchRangeChunked('/payment/list', FUNIL_DIAS);

  // mapa paciente → pagamentos ordenados por data asc
  const byPat = new Map();
  for (const p of pays) {
    const pid  = String(p.PatientId || p.patientId || '');
    const data = toDate(p.ReceivedDate || p.CheckOutDate || p.PaymentDate || p.Date);
    const valor = Number(p.Amount ?? p.PaidValue ?? p.Value ?? p.TotalPaid ?? 0);
    if (!pid || !data) continue;
    if (!byPat.has(pid)) byPat.set(pid, []);
    byPat.get(pid).push({ data, valor });
  }
  for (const arr of byPat.values()) arr.sort((a, b) => (a.data < b.data ? -1 : 1));

  // orçamentos aprovados particulares → casar 1º pagamento >= data_criacao
  const { data: orcs } = await supabase.from('orcamentos')
    .select('clinicorp_estimate_id, paciente_clinicorp_id, data_criacao')
    .eq('status', 'APPROVED').gt('valor_particular', 0);

  let n = 0;
  for (const o of (orcs || [])) {
    const arr = byPat.get(String(o.paciente_clinicorp_id)) || [];
    const entrada = arr.find(p => p.data >= o.data_criacao);
    if (!entrada) continue;
    const { error } = await supabase.from('orcamentos')
      .update({ entrada_valor: entrada.valor, entrada_data: entrada.data })
      .eq('clinicorp_estimate_id', o.clinicorp_estimate_id);
    if (!error) n++;
  }
  log(`Entradas casadas: ${n}`);
  return n;
}
```

- [ ] **Step 2: Exportar para teste ad-hoc**

No `module.exports`, adicionar `syncEntradas` (e as demais novas conforme forem criadas):

```js
module.exports = { runSync, loadFunilConfig, syncAvaliacoes, syncOrcamentos, vincularLeads, syncEntradas };
```

- [ ] **Step 3: Verificar (após reset do rate limit)**

Run: `node -e "require('./sync/clinicorp-sync').syncEntradas().then(n=>console.log('entradas',n))"`
Expected: log "Entradas casadas: N". MCP `execute_sql`:
`select count(*) com_entrada, round(avg(entrada_valor)) media from public.orcamentos where entrada_valor is not null;`
Se `media` vier 0/nula, inspecionar 1 objeto de `/payment/list` para achar o campo de valor correto e ajustar a lista de fallback.

- [ ] **Step 4: Commit**

```bash
git add sync/clinicorp-sync.js
git commit -m "feat(comercial): sync casa entrada (1o pagamento) nos orcamentos"
```

---

## Task 5: Sync — timestamps da avaliação + marcar tem_orcamento

**Files:**
- Modify: `sync/clinicorp-sync.js`

- [ ] **Step 1: Gravar `agendado_em` e `comparecimento_em` em `syncAvaliacoes`**

No objeto `rows.push({...})` de `syncAvaliacoes`, adicionar:

```js
      agendado_em:       a.CreateDate || null,
      comparecimento_em: a.CheckinTime ? new Date(Number(a.CheckinTime)).toISOString() : null,
```

- [ ] **Step 2: Adicionar helper de data e `marcarAvaliacoesComOrcamento`**

```js
function addDias(dateStr, dias) {
  const d = new Date(dateStr); d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

// Marca avaliacoes.tem_orcamento = paciente tem orçamento PARTICULAR criado em [data, data+60d].
async function marcarAvaliacoesComOrcamento() {
  const { data: orcs } = await supabase.from('orcamentos')
    .select('paciente_clinicorp_id, data_criacao').gt('valor_particular', 0);
  const byPat = new Map();
  for (const o of (orcs || [])) {
    if (!byPat.has(o.paciente_clinicorp_id)) byPat.set(o.paciente_clinicorp_id, []);
    byPat.get(o.paciente_clinicorp_id).push(o.data_criacao);
  }

  const { data: avals } = await supabase.from('avaliacoes')
    .select('clinicorp_appointment_id, paciente_clinicorp_id, data');

  const updates = [];
  for (const a of (avals || [])) {
    const datas = byPat.get(a.paciente_clinicorp_id) || [];
    const limite = a.data ? addDias(a.data, 60) : null;
    const tem = !!(a.data && datas.some(d => d >= a.data && d <= limite));
    updates.push({ clinicorp_appointment_id: a.clinicorp_appointment_id, tem_orcamento: tem });
  }

  let validas = updates.filter(u => u.tem_orcamento).length;
  for (let i = 0; i < updates.length; i += 500) {
    const chunk = updates.slice(i, i + 500);
    const { error } = await supabase.from('avaliacoes')
      .upsert(chunk, { onConflict: 'clinicorp_appointment_id' });
    if (error) log(`ERRO upsert tem_orcamento: ${error.message}`);
  }
  log(`Avaliações válidas (com orçamento): ${validas}/${updates.length}`);
  return validas;
}
```

- [ ] **Step 3: Chamar as fases no `runSync`** (após a Fase 8 `vincularLeads`)

```js
    // Fase 9: entradas (1o pagamento)
    result.steps.entradas = await syncEntradas();

    // Fase 10: marcar avaliacoes validas (com orcamento particular em 60d)
    result.steps.avaliacoes_validas = await marcarAvaliacoesComOrcamento();
```

- [ ] **Step 4: Atualizar exports**

```js
module.exports = { runSync, loadFunilConfig, syncAvaliacoes, syncOrcamentos, vincularLeads, syncEntradas, marcarAvaliacoesComOrcamento };
```

- [ ] **Step 5: Verificar (após reset do rate limit)**

Run: `node -e "require('./sync/clinicorp-sync').marcarAvaliacoesComOrcamento().then(n=>console.log('validas',n))"`
Expected: log "Avaliações válidas (com orçamento): N/M" com N < M (ruído filtrado). MCP `execute_sql`:
`select count(*) filter (where tem_orcamento) validas, count(*) total, count(*) filter (where agendado_em is not null) com_agendado, count(*) filter (where comparecimento_em is not null) com_checkin from public.avaliacoes;`

- [ ] **Step 6: Commit**

```bash
git add sync/clinicorp-sync.js
git commit -m "feat(comercial): timestamps de fase e marcacao de avaliacoes validas"
```

---

## Task 6: `agregarFechamentos` (pura, TDD)

**Files:**
- Create: `lib/funil/fechamentos.js`
- Test: `lib/funil/fechamentos.test.js`

- [ ] **Step 1: Escrever o teste que falha**

```js
// lib/funil/fechamentos.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { agregarFechamentos } = require('./fechamentos');

// 2 pacientes fecharam em maio. A foi avaliado em maio (mesmo mês), B em abril (anterior).
const orcamentos = [
  { paciente_clinicorp_id: 'A', valor_particular: 10000, entrada_valor: 2000, data_fechamento: '2026-05-10' },
  { paciente_clinicorp_id: 'B', valor_particular: 6000,  entrada_valor: 1000, data_fechamento: '2026-05-20' },
];
const avaliacoesPorPaciente = new Map([
  ['A', [{ data: '2026-05-01' }]],
  ['B', [{ data: '2026-04-15' }]],
]);

test('conta fechamentos, valores, ticket e entradas', () => {
  const r = agregarFechamentos({ orcamentos, avaliacoesPorPaciente });
  assert.strictEqual(r.fechamentos, 2);
  assert.strictEqual(r.valor_fechado, 16000);
  assert.strictEqual(r.entradas_recebidas, 3000);
  assert.strictEqual(r.ticket_medio, 8000);
});

test('tempo médio até fechar e split de origem', () => {
  const r = agregarFechamentos({ orcamentos, avaliacoesPorPaciente });
  // A: 9 dias (01→10), B: 35 dias (04-15→05-20) => média 22
  assert.strictEqual(r.tempo_medio_ate_fechar, 22);
  assert.strictEqual(r.origem_fechamento.mesmo_mes, 1);       // A
  assert.strictEqual(r.origem_fechamento.meses_anteriores, 1); // B
});

test('paciente sem avaliação não entra no tempo nem no split', () => {
  const r = agregarFechamentos({
    orcamentos: [{ paciente_clinicorp_id: 'C', valor_particular: 5000, entrada_valor: 0, data_fechamento: '2026-05-05' }],
    avaliacoesPorPaciente: new Map(),
  });
  assert.strictEqual(r.fechamentos, 1);
  assert.strictEqual(r.tempo_medio_ate_fechar, null);
  assert.strictEqual(r.origem_fechamento.mesmo_mes, 0);
  assert.strictEqual(r.origem_fechamento.meses_anteriores, 0);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/funil/fechamentos.test.js`
Expected: FAIL ("Cannot find module './fechamentos'").

- [ ] **Step 3: Implementar `agregarFechamentos` (e helpers)**

```js
// lib/funil/fechamentos.js
// Agregações de fechamento por mês de fechamento + tempos por fase (puras).
function media(arr) { return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null; }
function diasEntre(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
function mesDe(d) { return String(d).slice(0, 7); }

// orcamentos: já filtrados a particulares aprovados com data_fechamento no período.
function agregarFechamentos({ orcamentos = [], avaliacoesPorPaciente = new Map() }) {
  // agrega por paciente (1 paciente = 1 fechamento)
  const porPaciente = new Map();
  for (const o of orcamentos) {
    const p = o.paciente_clinicorp_id;
    if (!porPaciente.has(p)) porPaciente.set(p, { valor: 0, entrada: 0, data_fechamento: o.data_fechamento });
    const acc = porPaciente.get(p);
    acc.valor   += Number(o.valor_particular || 0);
    acc.entrada += Number(o.entrada_valor || 0);
    if (o.data_fechamento > acc.data_fechamento) acc.data_fechamento = o.data_fechamento;
  }

  const fechamentos = porPaciente.size;
  let valor_fechado = 0, entradas_recebidas = 0;
  const tempos = [];
  let mesmo_mes = 0, meses_anteriores = 0;

  for (const [p, acc] of porPaciente) {
    valor_fechado      += acc.valor;
    entradas_recebidas += acc.entrada;
    const avals = (avaliacoesPorPaciente.get(p) || [])
      .filter(a => a.data && a.data <= acc.data_fechamento)
      .sort((x, y) => (x.data < y.data ? 1 : -1)); // mais recente primeiro
    const aval = avals[0];
    if (aval) {
      tempos.push(diasEntre(aval.data, acc.data_fechamento));
      if (mesDe(aval.data) === mesDe(acc.data_fechamento)) mesmo_mes++; else meses_anteriores++;
    }
  }

  const comAval = mesmo_mes + meses_anteriores;
  return {
    fechamentos,
    valor_fechado,
    entradas_recebidas,
    ticket_medio: fechamentos ? Math.round((valor_fechado / fechamentos) * 100) / 100 : 0,
    tempo_medio_ate_fechar: media(tempos),
    origem_fechamento: {
      mesmo_mes,
      meses_anteriores,
      pct_mesmo_mes: comAval ? mesmo_mes / comAval : null,
    },
  };
}

module.exports = { agregarFechamentos, media, diasEntre, mesDe };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/funil/fechamentos.test.js`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/funil/fechamentos.js lib/funil/fechamentos.test.js
git commit -m "feat(comercial): agregarFechamentos (por mes de fechamento) com testes"
```

---

## Task 7: `temposPorFase` (pura, TDD)

**Files:**
- Modify: `lib/funil/fechamentos.js`
- Modify: `lib/funil/fechamentos.test.js`

- [ ] **Step 1: Adicionar o teste que falha**

Acrescentar em `lib/funil/fechamentos.test.js`:

```js
const { temposPorFase } = require('./fechamentos');

test('tempos por fase clínica e leads (médias em dias)', () => {
  const avaliacoes = [
    { paciente_clinicorp_id: 'A', agendado_em: '2026-05-01T09:00:00Z', comparecimento_em: '2026-05-03T09:00:00Z' }, // 2d
  ];
  const fechamentoPorPaciente = new Map([['A', '2026-05-13']]); // compareceu 05-03 → fechou 05-13 = 10d
  const leads = [
    { id: 1, data_lead: '2026-05-01', data_agendamento: '2026-05-05', data_comparecimento: '2026-05-08' }, // 4d, 3d
  ];
  const fechamentoPorLead = new Map([[1, '2026-05-18']]); // compareceu 05-08 → fechou 05-18 = 10d

  const r = temposPorFase({ avaliacoes, fechamentoPorPaciente, leads, fechamentoPorLead });
  assert.strictEqual(r.clinica.agendou_compareceu, 2);
  assert.strictEqual(r.clinica.compareceu_fechou, 10);
  assert.strictEqual(r.leads.lead_agendou, 4);
  assert.strictEqual(r.leads.agendou_compareceu, 3);
  assert.strictEqual(r.leads.compareceu_fechou, 10);
});

test('fases sem dados retornam null', () => {
  const r = temposPorFase({ avaliacoes: [], fechamentoPorPaciente: new Map(), leads: [], fechamentoPorLead: new Map() });
  assert.strictEqual(r.clinica.agendou_compareceu, null);
  assert.strictEqual(r.leads.lead_agendou, null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/funil/fechamentos.test.js`
Expected: FAIL ("temposPorFase is not a function").

- [ ] **Step 3: Implementar `temposPorFase`**

Adicionar em `lib/funil/fechamentos.js` (antes do `module.exports`):

```js
// Média de dias por transição; ignora pares sem ambas as pontas.
function temposPorFase({ avaliacoes = [], fechamentoPorPaciente = new Map(), leads = [], fechamentoPorLead = new Map() }) {
  const mediaPares = (pares) => media(pares.filter(([a, b]) => a && b).map(([a, b]) => diasEntre(a, b)));

  const clinica = {
    agendou_compareceu: mediaPares(avaliacoes.map(a => [a.agendado_em, a.comparecimento_em])),
    compareceu_fechou:  mediaPares(avaliacoes
      .map(a => [a.comparecimento_em, fechamentoPorPaciente.get(a.paciente_clinicorp_id)])),
  };

  const leadsView = {
    lead_agendou:       mediaPares(leads.map(l => [l.data_lead, l.data_agendamento])),
    agendou_compareceu: mediaPares(leads.map(l => [l.data_agendamento, l.data_comparecimento])),
    compareceu_fechou:  mediaPares(leads.map(l => [l.data_comparecimento, fechamentoPorLead.get(l.id)])),
  };

  return { clinica, leads: leadsView };
}

// ...e incluir temposPorFase no module.exports:
// module.exports = { agregarFechamentos, temposPorFase, media, diasEntre, mesDe };
```

Atualizar a linha `module.exports` para:

```js
module.exports = { agregarFechamentos, temposPorFase, media, diasEntre, mesDe };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/funil/fechamentos.test.js`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/funil/fechamentos.js lib/funil/fechamentos.test.js
git commit -m "feat(comercial): temposPorFase (jornada lead/clinica) com testes"
```

---

## Task 8: Endpoint `/api/comercial/funil` estendido

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Importar as funções novas**

Junto ao `require('./lib/funil/agregar')` no topo:

```js
const { agregarFechamentos, temposPorFase } = require('./lib/funil/fechamentos');
```

- [ ] **Step 2: Substituir o handler da rota `/api/comercial/funil`**

Trocar todo o corpo do `app.get('/api/comercial/funil', ...)` por:

```js
app.get('/api/comercial/funil', requireAuth, requireDashboardAvaliacao, rateLimit, async (req, res) => {
  try {
    const { from, to } = req.query;
    const origem = (req.query.origem && req.query.origem !== 'all') ? req.query.origem : null;
    if (!from || !to) return res.status(400).json({ error: 'from e to são obrigatórios (YYYY-MM-DD)' });
    const toEnd = to + 'T23:59:59';

    // Avaliações VÁLIDAS (com orçamento) no período — topo do funil + tempos clínica
    const { data: avaliacoes } = await supabase.from('avaliacoes')
      .select('paciente_clinicorp_id, telefone, data, compareceu, lead_id, agendado_em, comparecimento_em')
      .eq('tem_orcamento', true).gte('data', from).lte('data', to);

    // Orçamentos PARTICULARES criados no período (pipeline do topo)
    const { data: orcCriados } = await supabase.from('orcamentos')
      .select('paciente_clinicorp_id, telefone, valor_particular, status, data_criacao, lead_id')
      .gt('valor_particular', 0).gte('data_criacao', from).lte('data_criacao', to);

    // Leads no período
    const { data: leads } = await supabase.from('leads')
      .select('id, telefone, origem, data_lead, data_agendamento, data_comparecimento')
      .gte('data_lead', from).lte('data_lead', toEnd);

    // Fechamentos no período (por data_fechamento) — particular aprovado
    const { data: fechados } = await supabase.from('orcamentos')
      .select('paciente_clinicorp_id, valor_particular, entrada_valor, data_fechamento, lead_id')
      .eq('status', 'APPROVED').gt('valor_particular', 0)
      .gte('data_fechamento', from).lte('data_fechamento', to);

    // Avaliações dos pacientes dos fechamentos (qualquer data) p/ tempo-até-fechar e split
    const pacientesFechados = [...new Set((fechados || []).map(f => f.paciente_clinicorp_id))];
    let avalFechados = [];
    if (pacientesFechados.length) {
      const r = await supabase.from('avaliacoes')
        .select('paciente_clinicorp_id, data, comparecimento_em')
        .in('paciente_clinicorp_id', pacientesFechados);
      avalFechados = r.data || [];
    }

    const avaliacoesPorPaciente = new Map();
    for (const a of avalFechados) {
      if (!avaliacoesPorPaciente.has(a.paciente_clinicorp_id)) avaliacoesPorPaciente.set(a.paciente_clinicorp_id, []);
      avaliacoesPorPaciente.get(a.paciente_clinicorp_id).push(a);
    }
    const fechamentoPorPaciente = new Map();
    const fechamentoPorLead = new Map();
    for (const f of (fechados || [])) {
      const cur = fechamentoPorPaciente.get(f.paciente_clinicorp_id);
      if (!cur || f.data_fechamento > cur) fechamentoPorPaciente.set(f.paciente_clinicorp_id, f.data_fechamento);
      if (f.lead_id != null) {
        const c2 = fechamentoPorLead.get(f.lead_id);
        if (!c2 || f.data_fechamento > c2) fechamentoPorLead.set(f.lead_id, f.data_fechamento);
      }
    }

    // topo do funil: usa valor_particular como "valor"
    const orcTopo = (orcCriados || []).map(o => ({ ...o, valor: o.valor_particular }));
    const resultado = agregarFunil({ leads: leads || [], avaliacoes: avaliacoes || [], orcamentos: orcTopo, origem });
    const fechamentos_mes = agregarFechamentos({ orcamentos: fechados || [], avaliacoesPorPaciente });
    const tempos_fase = temposPorFase({ avaliacoes: avaliacoes || [], fechamentoPorPaciente, leads: leads || [], fechamentoPorLead });

    const origens = [...new Set((leads || []).map(l => l.origem).filter(Boolean))].sort();
    res.json({ from, to, origem: origem || 'all', origens, ...resultado, fechamentos_mes, tempos_fase });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Verificar sintaxe + endpoint (smoke)**

Run: `node --check server.js` → "SYNTAX OK".
Run (servidor local): `node server.js &` depois `curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/api/comercial/funil?from=2026-05-01&to=2026-05-31"` → espera `401` (sem token). Parar o servidor.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(comercial): endpoint retorna fechamentos_mes e tempos_fase"
```

---

## Task 9: UI — blocos "Fechamentos do mês" e "Tempos por fase"

**Files:**
- Modify: `public/comercial/index.html`
- Modify: `public/js/comercial/app.js`

- [ ] **Step 1: Adicionar os contêineres no `index.html`**

Logo após o `<div class="visoes">...</div>` (antes do `<script src="/js/comercial/api.js">`), inserir:

```html
  <div class="bloco">
    <div class="bloco-head">
      <h2>Fechamentos do mês</h2>
      <span class="selo">automático — pendente de conferência</span>
    </div>
    <div class="cards" id="cards-fechamentos"></div>
  </div>

  <div class="bloco">
    <h2>Tempos por fase <span class="sub">(média de dias em cada etapa)</span></h2>
    <div class="fases" id="fases-clinica"></div>
    <div class="fases" id="fases-leads"></div>
  </div>
```

E no `<style>` adicionar:

```css
  .bloco { margin-top: 24px; }
  .bloco-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .selo { font-size:11px; color:var(--yellow); border:1px solid var(--yellow); border-radius:999px; padding:2px 8px; }
  .fases { display:flex; gap:10px; flex-wrap:wrap; margin:8px 0 0; }
  .fase { background:var(--bg2); border:1px solid var(--border); border-radius:10px; padding:10px 12px; font-size:12.5px; }
  .fase b { display:block; font-size:18px; font-weight:700; margin-top:3px; }
  .fase .grupo { font-size:10.5px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
```

- [ ] **Step 2: Renderizar os blocos no `app.js`**

Adicionar as funções e chamá-las dentro de `carregar()` (após os dois `render(...)` existentes):

```js
const DIAS = v => (v == null ? '—' : `${v} ${v === 1 ? 'dia' : 'dias'}`);

function renderFechamentos(el, f) {
  const cards = [
    ['Fechamentos no mês', NUM(f.fechamentos)],
    ['Valor fechado', BRL(f.valor_fechado)],
    ['Entradas recebidas', BRL(f.entradas_recebidas)],
    ['Ticket médio', BRL(f.ticket_medio)],
    ['Tempo médio até fechar', DIAS(f.tempo_medio_ate_fechar)],
    ['Origem do fechamento', `${PCT(f.origem_fechamento.pct_mesmo_mes)} no mês · ${f.origem_fechamento.meses_anteriores} de antes`],
  ];
  el.innerHTML = cards
    .map(([r, val]) => `<div class="card"><div class="rotulo">${r}</div><div class="valor">${val}</div></div>`)
    .join('');
}

function renderFases(el, grupo, t) {
  const itens = grupo === 'clinica'
    ? [['Agendou → Compareceu', t.agendou_compareceu], ['Compareceu → Fechou', t.compareceu_fechou]]
    : [['Lead → Agendou', t.lead_agendou], ['Agendou → Compareceu', t.agendou_compareceu], ['Compareceu → Fechou', t.compareceu_fechou]];
  const titulo = grupo === 'clinica' ? 'Clínica' : 'Leads rastreados';
  el.innerHTML = `<div class="fase" style="background:none;border:none;padding:10px 4px"><span class="grupo">${titulo}</span></div>` +
    itens.map(([r, v]) => `<div class="fase">${r}<b>${DIAS(v)}</b></div>`).join('');
}
```

E dentro de `carregar()`, após os `render(...)`:

```js
  renderFechamentos(document.getElementById('cards-fechamentos'), data.fechamentos_mes);
  renderFases(document.getElementById('fases-clinica'), 'clinica', data.tempos_fase.clinica);
  renderFases(document.getElementById('fases-leads'), 'leads', data.tempos_fase.leads);
```

- [ ] **Step 3: Remover os cards de fechamento/valor do TOPO (agora vivem no bloco novo)**

Em `app.js`, na função `cardsDe`, remover as linhas dos cards `Fechamentos`, `% de fechamentos`, `Valor em oportunidades`, `Valor fechado`, `Ticket médio` e `Taxa de conversão (R$)` — manter só os de atividade:

```js
function cardsDe(v) {
  const out = [];
  const add = (cond, rotulo, val) => { if (cond) out.push([rotulo, val]); };
  add(v.leads_criados   != null, 'Leads criados',        NUM(v.leads_criados));
  add(true,                      'Agendamentos',         NUM(v.agendamentos));
  add(v.pct_agendamentos != null,'% de agendamentos',    PCT(v.pct_agendamentos));
  add(v.leads_agendados != null, 'Leads agendados',      `${v.leads_agendados} (${PCT(v.pct_leads_agendados)})`);
  add(true,                      'Comparecimentos',      NUM(v.comparecimentos));
  add(true,                      '% de comparecimentos', PCT(v.pct_comparecimentos));
  return out;
}
```

- [ ] **Step 4: Smoke test local**

Run: `node server.js &` ; abrir `http://localhost:3000/comercial/` → 200 e assets 200; parar o servidor. (Render com dados reais exige login; validação visual logada fica para o deploy.)

- [ ] **Step 5: Commit**

```bash
git add public/comercial/index.html public/js/comercial/app.js
git commit -m "feat(comercial): blocos Fechamentos do mes e Tempos por fase na UI"
```

---

## Task 10: Re-sync, deploy e validação

**Files:** nenhum (operacional)

- [ ] **Step 1: Rodar o sync do funil completo (após reset do rate limit ~1h)**

Run: `node -e "const s=require('./sync/clinicorp-sync'); (async()=>{const c=await s.loadFunilConfig(); await s.syncAvaliacoes(c); await s.syncOrcamentos(); await s.vincularLeads(); await s.syncEntradas(); await s.marcarAvaliacoesComOrcamento(); console.log('done');})()"`
Expected: logs sem erro de upsert. Conferir via MCP `execute_sql`:
`select count(*) filter (where tem_orcamento) validas, count(*) filter (where data_fechamento is not null and valor_particular>0) fechados_particular, count(*) filter (where entrada_valor is not null) com_entrada from public.avaliacoes a, public.orcamentos o;` (rodar como queries separadas se preferir).

- [ ] **Step 2: Push + deploy (fluxo do projeto)**

```bash
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

- [ ] **Step 3: Validar em produção**

Na URL pública, conferir `/comercial/` → 200, `/api/comercial/funil` sem token → 401. Logado como gestor/crc_comercial: abrir `/comercial/` e conferir o bloco "Fechamentos do mês" (valor fechado, entradas, ticket, tempo médio, origem) e "Tempos por fase". Avisar o usuário para a validação visual final.

---

## Self-Review (cobertura do spec)

- Avaliação válida (tem_orcamento, 60d) → Tasks 1, 5, 8 ✓
- Convênio fora dos valores (valor_particular) → Tasks 1, 2, 3, 8 ✓
- Fechamento por data_fechamento, particular → Tasks 1, 3, 6, 8 ✓
- Entrada = 1º pagamento → Tasks 1, 4 ✓
- Tempos por fase (clínica + leads) → Tasks 1, 5, 7, 8 ✓
- Bloco "Fechamentos do mês" + "Tempos por fase" na UI → Task 9 ✓
- Selo "pendente de conferência" → Task 9 ✓
- Sem % cross-coorte enganoso → Task 9 (cards de fechamento saem do topo) ✓
- Aprovação CRC → fora de escopo (Sub-2) ✓

**Riscos documentados:** nomes de campos do Clinicorp (`BillType`/`ClaimNumber`/`FinalAmount`/valor do pagamento) confirmados nas verificações das Tasks 3, 4 quando o rate limit resetar; `LastChange_Date` é proxy de data de fechamento; tempos de leads esparsos até entrarem leads reais.
