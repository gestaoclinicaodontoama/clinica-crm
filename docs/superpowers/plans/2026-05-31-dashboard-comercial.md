# Dashboard Comercial — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir a página `/comercial/` no CRM com o funil comercial de avaliações (12 cards iguais ao appcrc), filtro de período e quebra por campanha, em duas visões: toda a clínica (por avaliador) e leads rastreados.

**Architecture:** O sync da Clinicorp passa a persistir duas tabelas pequenas (`avaliacoes`, `orcamentos`) + config de avaliadores e de status. Um endpoint lê essas tabelas + `leads`, agrega com uma função pura e devolve os cards. A página renderiza os cards. Tudo lê do Supabase (não acopla ao limite de 25 req/h da Clinicorp).

**Tech Stack:** Node.js + Express (`server.js`), Supabase (Postgres + RLS), JS vanilla no front, testes com `node --test` (node:test, sem dependências novas). Spec: `docs/superpowers/specs/2026-05-31-dashboard-comercial-design.md`.

**Fórmulas confirmadas contra os números do appcrc (visão leads):**
- `pct_agendamentos = agendamentos / leads_criados` (28,03% = 169/603)
- `pct_leads_agendados = leads_agendados / leads_criados` (25,87% = 156/603)
- `pct_comparecimentos = comparecimentos / leads_agendados` (57,69% = 90/156)
- `pct_fechamentos = fechamentos / comparecimentos` (23,33% = 21/90)
- `taxa_conversao = valor_fechamentos / valor_oportunidades` (19,69% = 242.534/1.231.878)
- `ticket_medio = valor_fechamentos / fechamentos`

Na **visão clínica (por avaliador)** não há leads; os denominadores passam a ser baseados em atividade: `pct_comparecimentos = comparecimentos / agendamentos`, e os cards de leads ficam `null` (ocultos na tela).

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20260531000000_dashboard_comercial.sql` | Tabelas `avaliacoes`, `orcamentos`, `config_avaliadores`, `config_status_compareceu` + RLS + policies + seed |
| `lib/funil/telefone.js` | `normalizarTelefone(raw)` — pura |
| `lib/funil/telefone.test.js` | testes node:test |
| `lib/funil/agregar.js` | `agregarFunil({...})` — pura, calcula os 12 cards nas 2 visões |
| `lib/funil/agregar.test.js` | testes node:test |
| `sync/clinicorp-sync.js` | novas fases: persistir avaliações e orçamentos + ligar a leads |
| `server.js` | `GET /api/comercial/funil` |
| `public/comercial/index.html` | página dos cards |
| `public/js/comercial/api.js` | auth/fetch (padrão de módulo) |
| `public/js/comercial/app.js` | render dos cards + filtros |
| `public/index.html`, `public/js/shared-nav.js` | entrada no nav + registro no módulo Usuários |

---

## Task 1: Migração — tabelas e config

**Files:**
- Create: `supabase/migrations/20260531000000_dashboard_comercial.sql`

- [ ] **Step 1: Escrever a migração**

```sql
-- Dashboard Comercial: funil de avaliações
-- avaliacoes: 1 linha por agendamento de avaliador
create table if not exists public.avaliacoes (
  clinicorp_appointment_id text primary key,
  paciente_clinicorp_id    text,
  telefone                 text,            -- normalizado (só dígitos)
  dentista_nome            text,
  dentista_clinicorp_id    text,
  data                     date,
  compareceu               boolean not null default false,
  status_raw               text,           -- StatusId cru da Clinicorp
  lead_id                  bigint,         -- nullable; resolvido por telefone
  atualizado_em            timestamptz not null default now()
);
create index if not exists idx_avaliacoes_data     on public.avaliacoes (data);
create index if not exists idx_avaliacoes_telefone on public.avaliacoes (telefone);
create index if not exists idx_avaliacoes_lead     on public.avaliacoes (lead_id);

-- orcamentos: 1 linha por estimate
create table if not exists public.orcamentos (
  clinicorp_estimate_id text primary key,
  treatment_id          text,
  paciente_clinicorp_id text,
  telefone              text,
  profissional_nome     text,
  valor                 numeric(12,2) not null default 0,
  status                text,             -- APPROVED | OPEN | ...
  data_criacao          date,
  lead_id               bigint,
  atualizado_em         timestamptz not null default now()
);
create index if not exists idx_orcamentos_data     on public.orcamentos (data_criacao);
create index if not exists idx_orcamentos_paciente on public.orcamentos (paciente_clinicorp_id);
create index if not exists idx_orcamentos_telefone on public.orcamentos (telefone);
create index if not exists idx_orcamentos_lead     on public.orcamentos (lead_id);

-- config de dentistas avaliadores
create table if not exists public.config_avaliadores (
  id           bigint generated always as identity primary key,
  clinicorp_id text,
  nome         text not null,
  ativo        boolean not null default true,
  criado_em    timestamptz not null default now()
);

-- config: quais StatusId contam como "compareceu"
create table if not exists public.config_status_compareceu (
  status_id   text primary key,
  descricao   text,
  compareceu  boolean not null default false,
  criado_em   timestamptz not null default now()
);

-- Seed dos StatusId observados (rotular compareceu na Task 2)
insert into public.config_status_compareceu (status_id, descricao) values
  ('6702677734588416', 'observado: maioria dos agendamentos'),
  ('4838751182913536', 'observado'),
  ('5848518009421824', 'observado: raro')
on conflict (status_id) do nothing;

-- RLS: habilitado, leitura para roles comerciais; escrita só service_role (sync)
alter table public.avaliacoes              enable row level security;
alter table public.orcamentos              enable row level security;
alter table public.config_avaliadores      enable row level security;
alter table public.config_status_compareceu enable row level security;

create policy "comercial le avaliacoes" on public.avaliacoes
  for select to authenticated using (true);
create policy "comercial le orcamentos" on public.orcamentos
  for select to authenticated using (true);
create policy "comercial le config_avaliadores" on public.config_avaliadores
  for select to authenticated using (true);
create policy "comercial le config_status" on public.config_status_compareceu
  for select to authenticated using (true);
```

- [ ] **Step 2: Aplicar via MCP Supabase**

Aplicar com a ferramenta MCP `apply_migration` (project_id `mtqdpjhhqzvuklnlfpvi`, name `dashboard_comercial`, query = conteúdo do arquivo).
Verificar com `list_migrations` que `20260531000000` aparece e com `list_tables` que as 4 tabelas existem com `rls_enabled: true`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260531000000_dashboard_comercial.sql
git commit -m "feat(comercial): migracao tabelas do funil (avaliacoes, orcamentos, config)"
```

---

## Task 2: Confirmar avaliadores e status de comparecimento (com o usuário)

**Files:** nenhum (configuração de dados, via MCP `execute_sql`).

- [ ] **Step 1: Listar profissionais avaliadores observados**

Mostrar ao usuário os nomes que aparecem em `/estimates/list` e `/appointment/list` (ex.: "Marcos Vinícius Coelho Vidigal Martins", "Matheus G. - Execução") e perguntar **quais registros são os dentistas avaliadores**.

- [ ] **Step 2: Inserir avaliadores confirmados**

Via MCP `execute_sql` (substituir pelos nomes/ids confirmados):

```sql
insert into public.config_avaliadores (nome, clinicorp_id, ativo) values
  ('<NOME EXATO MARCOS>', '<id ou null>', true),
  ('<NOME EXATO MATHEUS>', '<id ou null>', true);
```

- [ ] **Step 3: Rotular StatusId de comparecimento**

Mostrar ao usuário a distribuição (`6702677...`=341, `4838751...`=64, `5848518...`=4) e a descrição equivalente na Clinicorp; marcar os que significam "paciente compareceu/atendido":

```sql
update public.config_status_compareceu set compareceu = true
where status_id in ('<ids que significam compareceu>');
```

> Se o usuário não souber de imediato, deixar todos `false` (comparecimentos = 0) e refinar depois — não bloqueia o resto.

---

## Task 3: Utilitário de normalização de telefone

**Files:**
- Create: `lib/funil/telefone.js`
- Test: `lib/funil/telefone.test.js`

- [ ] **Step 1: Escrever o teste que falha**

```js
// lib/funil/telefone.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizarTelefone } = require('./telefone');

test('remove tudo que não é dígito', () => {
  assert.strictEqual(normalizarTelefone('(31) 99669-2011'), '31996692011');
});

test('remove DDI 55 quando presente em número de 13 dígitos', () => {
  assert.strictEqual(normalizarTelefone('5531996692011'), '31996692011');
});

test('mantém 11 dígitos (DDD + 9 dígitos)', () => {
  assert.strictEqual(normalizarTelefone('31996692011'), '31996692011');
});

test('retorna null para vazio ou curto demais', () => {
  assert.strictEqual(normalizarTelefone(''), null);
  assert.strictEqual(normalizarTelefone(null), null);
  assert.strictEqual(normalizarTelefone('1234'), null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/funil/telefone.test.js`
Expected: FAIL ("Cannot find module './telefone'").

- [ ] **Step 3: Implementar**

```js
// lib/funil/telefone.js
// Normaliza telefones brasileiros para "DDD + número" só com dígitos.
function normalizarTelefone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55')) d = d.slice(2); // remove DDI
  if (d.length === 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length < 10) return null;
  return d;
}

module.exports = { normalizarTelefone };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/funil/telefone.test.js`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/funil/telefone.js lib/funil/telefone.test.js
git commit -m "feat(comercial): util normalizarTelefone com testes"
```

---

## Task 4: Função pura de agregação do funil

**Files:**
- Create: `lib/funil/agregar.js`
- Test: `lib/funil/agregar.test.js`

Entrada: arrays **já filtrados pelo período** mais um filtro opcional de `origem`.
Saída: `{ clinica: <view>, leads: <view> }`, cada `view` com os 12 campos.

- [ ] **Step 1: Escrever o teste que falha**

```js
// lib/funil/agregar.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { agregarFunil } = require('./agregar');

// Cenário: 2 leads, ambos viraram avaliação (1 compareceu), 1 fechou.
const leads = [
  { id: 1, telefone: '31999990001', origem: 'invisalign', created_at: '2026-05-02' },
  { id: 2, telefone: '31999990002', origem: 'protocolo',  created_at: '2026-05-03' },
];
const avaliacoes = [
  { paciente_clinicorp_id: 'A', telefone: '31999990001', data: '2026-05-05', compareceu: true,  lead_id: 1 },
  { paciente_clinicorp_id: 'B', telefone: '31999990002', data: '2026-05-06', compareceu: false, lead_id: 2 },
  // avaliação sem lead (walk-in) — entra só na visão clínica
  { paciente_clinicorp_id: 'C', telefone: '31988880003', data: '2026-05-07', compareceu: true,  lead_id: null },
];
const orcamentos = [
  { paciente_clinicorp_id: 'A', telefone: '31999990001', valor: 10000, status: 'APPROVED', data_criacao: '2026-05-05', lead_id: 1 },
  { paciente_clinicorp_id: 'B', telefone: '31999990002', valor: 8000,  status: 'OPEN',     data_criacao: '2026-05-06', lead_id: 2 },
  { paciente_clinicorp_id: 'C', telefone: '31988880003', valor: 5000,  status: 'OPEN',     data_criacao: '2026-05-07', lead_id: null },
];

test('visão leads: contagens e percentuais', () => {
  const r = agregarFunil({ leads, avaliacoes, orcamentos });
  const v = r.leads;
  assert.strictEqual(v.leads_criados, 2);
  assert.strictEqual(v.agendamentos, 2);
  assert.strictEqual(v.leads_agendados, 2);
  assert.strictEqual(v.comparecimentos, 1);
  assert.strictEqual(v.fechamentos, 1);            // só paciente A aprovado
  assert.strictEqual(v.valor_oportunidades, 18000); // 10000 + 8000 (coorte de leads)
  assert.strictEqual(v.valor_fechamentos, 10000);
  assert.strictEqual(v.ticket_medio, 10000);
  assert.ok(Math.abs(v.taxa_conversao - (10000 / 18000)) < 1e-9);
});

test('visão clínica inclui walk-in e zera cards de lead', () => {
  const r = agregarFunil({ leads, avaliacoes, orcamentos });
  const v = r.clinica;
  assert.strictEqual(v.agendamentos, 3);     // inclui paciente C
  assert.strictEqual(v.comparecimentos, 2);  // A e C
  assert.strictEqual(v.valor_oportunidades, 23000); // 10000+8000+5000
  assert.strictEqual(v.leads_criados, null);
  assert.strictEqual(v.leads_agendados, null);
});

test('filtro de origem restringe a visão leads', () => {
  const r = agregarFunil({ leads, avaliacoes, orcamentos, origem: 'invisalign' });
  assert.strictEqual(r.leads.leads_criados, 1);
  assert.strictEqual(r.leads.fechamentos, 1);
  assert.strictEqual(r.leads.valor_oportunidades, 10000);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/funil/agregar.test.js`
Expected: FAIL ("Cannot find module './agregar'").

- [ ] **Step 3: Implementar**

```js
// lib/funil/agregar.js
// Agrega o funil comercial em duas visões a partir de arrays já filtrados por período.
function pct(num, den) { return den > 0 ? num / den : 0; }

// Calcula uma "view" (12 cards) a partir de avaliações/orçamentos de uma coorte.
// base = { leads_criados, leads_agendados } na visão leads, ou null na visão clínica.
function computeView(avaliacoes, orcamentos, base) {
  const agendamentos    = avaliacoes.length;
  const comparecimentos = avaliacoes.filter(a => a.compareceu).length;

  const coorte = new Set(avaliacoes.map(a => a.paciente_clinicorp_id));
  const orcCoorte = orcamentos.filter(o => coorte.has(o.paciente_clinicorp_id));
  const aprovados = orcCoorte.filter(o => o.status === 'APPROVED');

  const pacientesFechados = new Set(aprovados.map(o => o.paciente_clinicorp_id));
  const fechamentos       = pacientesFechados.size;
  const valor_fechamentos = aprovados.reduce((s, o) => s + Number(o.valor || 0), 0);
  const valor_oportunidades = orcCoorte
    .filter(o => o.status === 'APPROVED' || o.status === 'OPEN')
    .reduce((s, o) => s + Number(o.valor || 0), 0);

  const leads_criados   = base ? base.leads_criados   : null;
  const leads_agendados = base ? base.leads_agendados : null;

  // Denominadores: visão leads é ancorada em leads; visão clínica em atividade.
  const denAgendamento   = base ? leads_criados   : agendamentos;
  const denComparecimento = base ? leads_agendados : agendamentos;

  return {
    leads_criados,
    agendamentos,
    pct_agendamentos:     pct(agendamentos, denAgendamento),
    leads_agendados,
    pct_leads_agendados:  base ? pct(leads_agendados, leads_criados) : null,
    comparecimentos,
    pct_comparecimentos:  pct(comparecimentos, denComparecimento),
    fechamentos,
    pct_fechamentos:      pct(fechamentos, comparecimentos),
    valor_oportunidades,
    valor_fechamentos,
    ticket_medio:         pct(valor_fechamentos, fechamentos),
    taxa_conversao:       pct(valor_fechamentos, valor_oportunidades),
  };
}

function agregarFunil({ leads = [], avaliacoes = [], orcamentos = [], origem = null }) {
  // ----- Visão clínica: tudo -----
  const clinica = computeView(avaliacoes, orcamentos, null);

  // ----- Visão leads: só linhas com lead_id, filtradas por origem -----
  const leadById = new Map(leads.map(l => [l.id, l]));
  const origemOf = (lead_id) => (leadById.get(lead_id) || {}).origem;

  let leadsArr = leads;
  let avalLeads = avaliacoes.filter(a => a.lead_id != null);
  let orcLeads  = orcamentos.filter(o => o.lead_id != null);

  if (origem) {
    leadsArr  = leadsArr.filter(l => l.origem === origem);
    avalLeads = avalLeads.filter(a => origemOf(a.lead_id) === origem);
    orcLeads  = orcLeads.filter(o => origemOf(o.lead_id) === origem);
  }

  const leadsComAvaliacao = new Set(avalLeads.map(a => a.lead_id));
  const base = {
    leads_criados:   leadsArr.length,
    leads_agendados: leadsComAvaliacao.size,
  };
  const leadsView = computeView(avalLeads, orcLeads, base);

  return { clinica, leads: leadsView };
}

module.exports = { agregarFunil, computeView };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/funil/agregar.test.js`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/funil/agregar.js lib/funil/agregar.test.js
git commit -m "feat(comercial): agregarFunil (2 visoes) com testes"
```

---

## Task 5: Sync — persistir avaliações

**Files:**
- Modify: `sync/clinicorp-sync.js`

Janela de coleta: configurável, default 180 dias para trás (cobre o filtro de período do dashboard). Constante no topo do arquivo.

- [ ] **Step 1: Adicionar import e constante**

No topo de `sync/clinicorp-sync.js`, após o require de `ClinicorpApi` (linha ~11):

```js
const { normalizarTelefone } = require('../lib/funil/telefone');
const FUNIL_DIAS = 180; // janela de coleta do funil comercial
```

- [ ] **Step 2: Carregar configs (avaliadores + status compareceu)**

Adicionar função (perto das outras fases):

```js
async function loadFunilConfig() {
  const [{ data: av }, { data: st }] = await Promise.all([
    supabase.from('config_avaliadores').select('nome, clinicorp_id').eq('ativo', true),
    supabase.from('config_status_compareceu').select('status_id').eq('compareceu', true),
  ]);
  const nomes = new Set((av || []).map(r => (r.nome || '').trim().toLowerCase()));
  const ids   = new Set((av || []).map(r => String(r.clinicorp_id || '')).filter(Boolean));
  const statusCompareceu = new Set((st || []).map(r => String(r.status_id)));
  return { nomes, ids, statusCompareceu };
}
```

- [ ] **Step 3: Buscar e persistir avaliações**

Adicionar função:

```js
async function syncAvaliacoes(cfg) {
  const today = new Date();
  const past  = new Date(today); past.setDate(past.getDate() - FUNIL_DIAS);
  log(`Buscando agendamentos do funil (${FUNIL_DIAS}d)...`);
  const appts = await api.get('/appointment/list', { from: dateStr(past), to: dateStr(today) });
  const arr = Array.isArray(appts) ? appts : [];

  const rows = [];
  for (const a of arr) {
    if ((a.Deleted || '') === 'X') continue;
    const dentNome = (a.ProfessionalName || '').trim().toLowerCase();
    const dentId   = String(a.Dentist_PersonId || a.ScheduleToId || '');
    const isAvaliador = cfg.nomes.has(dentNome) || (dentId && cfg.ids.has(dentId));
    if (!isAvaliador) continue;

    const statusId = String(a.StatusId || '');
    rows.push({
      clinicorp_appointment_id: String(a.id || a.Id || `${a.Patient_PersonId}_${a.AtomicDate}`),
      paciente_clinicorp_id:    String(a.Patient_PersonId || a.PatientId || ''),
      telefone:                 normalizarTelefone(a.MobilePhone || a.Phone),
      dentista_nome:            a.ProfessionalName || '',
      dentista_clinicorp_id:    dentId || null,
      data:                     toDate(a.date || a.Date),
      compareceu:               cfg.statusCompareceu.has(statusId),
      status_raw:               statusId || null,
      atualizado_em:            new Date().toISOString(),
    });
  }

  log(`Avaliações de avaliadores: ${rows.length}`);
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from('avaliacoes')
      .upsert(chunk, { onConflict: 'clinicorp_appointment_id' });
    if (error) log(`ERRO upsert avaliacoes: ${error.message}`);
  }
  return rows.length;
}
```

- [ ] **Step 4: Chamar no runSync**

Dentro de `runSync`, após a Fase 5 (`upsertAbcData`), adicionar:

```js
    // Fase 6: funil comercial (avaliações)
    const funilCfg = await loadFunilConfig();
    result.steps.avaliacoes_funil = await syncAvaliacoes(funilCfg);
```

- [ ] **Step 5: Verificar manualmente**

Run: `node sync/clinicorp-sync.js`
Expected: log "Avaliações de avaliadores: N" sem erro de upsert. Conferir via MCP `execute_sql`: `select count(*), sum(case when compareceu then 1 else 0 end) from public.avaliacoes;`

- [ ] **Step 6: Commit**

```bash
git add sync/clinicorp-sync.js
git commit -m "feat(comercial): sync persiste avaliacoes dos avaliadores"
```

---

## Task 6: Sync — persistir orçamentos

**Files:**
- Modify: `sync/clinicorp-sync.js`

- [ ] **Step 1: Buscar e persistir orçamentos**

Adicionar função:

```js
async function syncOrcamentos() {
  const today = new Date();
  const past  = new Date(today); past.setDate(past.getDate() - FUNIL_DIAS);
  log(`Buscando orçamentos do funil (${FUNIL_DIAS}d)...`);
  const est = await api.get('/estimates/list', { from: dateStr(past), to: dateStr(today) });
  const arr = Array.isArray(est) ? est : [];

  const rows = arr.map(o => ({
    clinicorp_estimate_id: String(o.id),
    treatment_id:          o.TreatmentId != null ? String(o.TreatmentId) : null,
    paciente_clinicorp_id: String(o.PatientId || ''),
    telefone:              normalizarTelefone(o.PatientMobilePhone),
    profissional_nome:     o.ProfessionalName || '',
    valor:                 Number(o.Amount || 0),
    status:                o.Status || null,
    data_criacao:          toDate(o.CreateDate),
    atualizado_em:         new Date().toISOString(),
  })).filter(r => r.clinicorp_estimate_id && r.clinicorp_estimate_id !== 'undefined');

  log(`Orçamentos: ${rows.length}`);
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from('orcamentos')
      .upsert(chunk, { onConflict: 'clinicorp_estimate_id' });
    if (error) log(`ERRO upsert orcamentos: ${error.message}`);
  }
  return rows.length;
}
```

- [ ] **Step 2: Chamar no runSync**

Após a Fase 6, adicionar:

```js
    // Fase 7: funil comercial (orçamentos)
    result.steps.orcamentos_funil = await syncOrcamentos();
```

- [ ] **Step 3: Verificar**

Run: `node sync/clinicorp-sync.js`
Expected: log "Orçamentos: N". MCP `execute_sql`: `select status, count(*), sum(valor) from public.orcamentos group by status;` deve mostrar APPROVED/OPEN com valores plausíveis.

- [ ] **Step 4: Commit**

```bash
git add sync/clinicorp-sync.js
git commit -m "feat(comercial): sync persiste orcamentos"
```

---

## Task 7: Sync — ligar avaliações/orçamentos a leads por telefone

**Files:**
- Modify: `sync/clinicorp-sync.js`

- [ ] **Step 1: Função de vínculo**

Adicionar:

```js
async function vincularLeads() {
  const { data: leads } = await supabase.from('leads').select('id, telefone');
  const mapa = new Map();
  for (const l of (leads || [])) {
    const t = normalizarTelefone(l.telefone);
    if (t && !mapa.has(t)) mapa.set(t, l.id);
  }
  if (!mapa.size) { log('vincularLeads: nenhum lead com telefone'); return 0; }

  let n = 0;
  for (const tabela of ['avaliacoes', 'orcamentos']) {
    const { data: rows } = await supabase.from(tabela)
      .select(tabela === 'avaliacoes' ? 'clinicorp_appointment_id, telefone' : 'clinicorp_estimate_id, telefone')
      .is('lead_id', null);
    const pk = tabela === 'avaliacoes' ? 'clinicorp_appointment_id' : 'clinicorp_estimate_id';
    for (const r of (rows || [])) {
      const lid = mapa.get(r.telefone);
      if (!lid) continue;
      await supabase.from(tabela).update({ lead_id: lid }).eq(pk, r[pk]);
      n++;
    }
  }
  log(`vincularLeads: ${n} linhas ligadas a leads`);
  return n;
}
```

- [ ] **Step 2: Chamar no runSync**

Após a Fase 7:

```js
    // Fase 8: vincular avaliações/orçamentos a leads (por telefone)
    result.steps.leads_vinculados = await vincularLeads();
```

- [ ] **Step 3: Verificar**

Run: `node sync/clinicorp-sync.js`
Expected: log "vincularLeads: N linhas ligadas". (N pode ser baixo hoje — só 8 leads.) Sem erros.

- [ ] **Step 4: Commit**

```bash
git add sync/clinicorp-sync.js
git commit -m "feat(comercial): vincula avaliacoes/orcamentos a leads por telefone"
```

---

## Task 8: Endpoint `GET /api/comercial/funil`

**Files:**
- Modify: `server.js`

Padrão de rota do projeto: `app.get(path, requireAuth, requireRole(...), rateLimit, handler)`. Reusar role comercial existente (`crc_comercial`, `gestor`, `admin`).

- [ ] **Step 1: Adicionar a rota**

Localizar onde ficam as rotas `/api/leads` e adicionar (perto delas) — importar a função pura no topo do `server.js` junto aos outros requires:

```js
const { agregarFunil } = require('./lib/funil/agregar');
```

Rota:

```js
// GET /api/comercial/funil?from=YYYY-MM-DD&to=YYYY-MM-DD&origem=<campanha|all>
app.get('/api/comercial/funil',
  requireAuth, requireRole('admin', 'gestor', 'crc_comercial'), rateLimit,
  async (req, res) => {
    try {
      const { from, to } = req.query;
      const origem = (req.query.origem && req.query.origem !== 'all') ? req.query.origem : null;
      if (!from || !to) return res.status(400).json({ error: 'from e to são obrigatórios (YYYY-MM-DD)' });

      const [{ data: avaliacoes, error: e1 }, { data: orcamentos, error: e2 }, { data: leads, error: e3 }] =
        await Promise.all([
          supabase.from('avaliacoes')
            .select('paciente_clinicorp_id, telefone, data, compareceu, lead_id')
            .gte('data', from).lte('data', to),
          supabase.from('orcamentos')
            .select('paciente_clinicorp_id, telefone, valor, status, data_criacao, lead_id')
            .gte('data_criacao', from).lte('data_criacao', to),
          supabase.from('leads')
            .select('id, telefone, origem, created_at')
            .gte('created_at', from).lte('created_at', to + 'T23:59:59'),
        ]);
      if (e1 || e2 || e3) throw new Error((e1 || e2 || e3).message);

      const resultado = agregarFunil({
        leads: leads || [], avaliacoes: avaliacoes || [], orcamentos: orcamentos || [], origem,
      });

      // lista de origens disponíveis para o seletor
      const origens = [...new Set((leads || []).map(l => l.origem).filter(Boolean))].sort();

      res.json({ from, to, origem: origem || 'all', origens, ...resultado });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
```

> Observação: o `supabase` usado no `server.js` deve ser o mesmo client já instanciado no arquivo (procurar `createClient` no topo do `server.js`; usar a variável existente).

- [ ] **Step 2: Verificar com curl (após login)**

Subir local: `node server.js`. Com um token válido no header `Authorization: Bearer <token>`:

Run:
```bash
curl -s "http://localhost:3000/api/comercial/funil?from=2026-05-01&to=2026-05-28" \
  -H "Authorization: Bearer <TOKEN>" | python3 -m json.tool
```
Expected: JSON com `clinica` e `leads`, cada um com os 12 campos; `origens` como array.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(comercial): endpoint GET /api/comercial/funil"
```

---

## Task 9: Página `/comercial/` (cards + filtros)

**Files:**
- Create: `public/comercial/index.html`
- Create: `public/js/comercial/api.js`
- Create: `public/js/comercial/app.js`
- Modify: `public/index.html` (nav)
- Modify: `public/js/shared-nav.js` (nav nas páginas separadas)

Seguir o padrão de módulo do `CLAUDE.md`: shared-nav, auth via chave `sb-{ref}-auth-token`, role-gate no link.

- [ ] **Step 1: api.js (auth + fetch)**

```js
// public/js/comercial/api.js
function _token() {
  for (const k in localStorage) {
    if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
      try { return JSON.parse(localStorage.getItem(k)).access_token; } catch (_) {}
    }
  }
  return null;
}
async function getFunil({ from, to, origem }) {
  const qs = new URLSearchParams({ from, to, origem: origem || 'all' });
  const r = await fetch(`/api/comercial/funil?${qs}`, {
    headers: { Authorization: `Bearer ${_token()}` },
  });
  if (!r.ok) throw new Error((await r.json()).error || r.statusText);
  return r.json();
}
window.ComercialApi = { getFunil };
```

- [ ] **Step 2: index.html (estrutura + shared-nav)**

```html
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Comercial — Funil</title>
  <link rel="stylesheet" href="/css/app.css">
  <style>
    .filtros { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:16px; }
    .visoes { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin:16px; }
    @media (max-width:760px){ .visoes{ grid-template-columns:1fr; } }
    .cards { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .card { background:#fff; border-radius:14px; padding:14px; box-shadow:0 1px 4px rgba(0,0,0,.08); }
    .card .rotulo { font-size:13px; color:#555; }
    .card .valor { font-size:22px; font-weight:700; color:#333; }
    .col h2 { margin:0 16px; font-size:16px; }
  </style>
</head>
<body>
  <script src="/js/shared-nav.js" data-active="comercial"></script>
  <div class="filtros">
    <label>De <input type="date" id="f-from"></label>
    <label>Até <input type="date" id="f-to"></label>
    <label>Origem <select id="f-origem"><option value="all">Todas</option></select></label>
    <button id="f-aplicar">Aplicar</button>
  </div>
  <div class="visoes">
    <div class="col"><h2>Toda a clínica (por avaliador)</h2><div class="cards" id="cards-clinica"></div></div>
    <div class="col"><h2>Leads rastreados</h2><div class="cards" id="cards-leads"></div></div>
  </div>
  <script src="/js/comercial/api.js"></script>
  <script src="/js/comercial/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: app.js (render)**

```js
// public/js/comercial/app.js
const BRL = v => (v == null ? '—' : v.toLocaleString('pt-BR', { style:'currency', currency:'BRL' }));
const PCT = v => (v == null ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%');
const NUM = v => (v == null ? '—' : String(v));

function cardsDe(v) {
  return [
    ['Total de leads criados', NUM(v.leads_criados)],
    ['Total de agendamentos', NUM(v.agendamentos)],
    ['Percentual de agendamentos', PCT(v.pct_agendamentos)],
    ['Leads agendados', v.leads_agendados == null ? '—' : `${v.leads_agendados} (${PCT(v.pct_leads_agendados)})`],
    ['Total de comparecimentos', NUM(v.comparecimentos)],
    ['Percentual de comparecimentos', PCT(v.pct_comparecimentos)],
    ['Total de fechamentos', NUM(v.fechamentos)],
    ['Percentual de fechamentos', PCT(v.pct_fechamentos)],
    ['Valor total de oportunidades', BRL(v.valor_oportunidades)],
    ['Valor total de fechamentos', BRL(v.valor_fechamentos)],
    ['Ticket médio', BRL(v.ticket_medio)],
    ['Taxa de conversão de vendas', PCT(v.taxa_conversao)],
  ];
}
function render(el, v) {
  el.innerHTML = cardsDe(v)
    .filter(([, val]) => val !== '—' || true) // mostra todos; '—' onde não se aplica
    .map(([r, val]) => `<div class="card"><div class="rotulo">${r}</div><div class="valor">${val}</div></div>`)
    .join('');
}
function primeiroDiaMes() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0,10); }

async function carregar() {
  const from = document.getElementById('f-from').value;
  const to   = document.getElementById('f-to').value;
  const origem = document.getElementById('f-origem').value;
  const data = await ComercialApi.getFunil({ from, to, origem });
  // popular seletor de origens (uma vez)
  const sel = document.getElementById('f-origem');
  if (sel.options.length <= 1 && data.origens) {
    for (const o of data.origens) sel.add(new Option(o, o));
  }
  render(document.getElementById('cards-clinica'), data.clinica);
  render(document.getElementById('cards-leads'), data.leads);
}

document.getElementById('f-from').value = primeiroDiaMes();
document.getElementById('f-to').value   = new Date().toISOString().slice(0,10);
document.getElementById('f-aplicar').addEventListener('click', carregar);
carregar().catch(e => alert('Erro: ' + e.message));
```

- [ ] **Step 4: Registrar no nav (index.html)**

Em `public/index.html`, antes do botão "Usuários", adicionar:

```html
<a class="nav-btn" href="/comercial/" data-roles="gestor,crc_comercial">
  <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg>
  Comercial
</a>
```

- [ ] **Step 5: Registrar no shared-nav.js**

Em `public/js/shared-nav.js`, adicionar à lista de links do nav uma entrada com slug `comercial` (href `/comercial/`, roles `gestor,crc_comercial`), seguindo o formato das entradas existentes no arquivo.

- [ ] **Step 6: Verificar no navegador**

Subir local, logar como usuário com role `gestor` ou `crc_comercial`, abrir `/comercial/`. Esperado: filtros + duas colunas de cards; "Aplicar" recarrega; visão clínica com números, visão leads possivelmente esparsa (poucos leads).

- [ ] **Step 7: Commit**

```bash
git add public/comercial/ public/js/comercial/ public/index.html public/js/shared-nav.js
git commit -m "feat(comercial): pagina /comercial/ com cards do funil e filtros"
```

---

## Task 10: Registrar módulo em Usuários + deploy

**Files:**
- Modify: `public/index.html` (módulo Usuários)

- [ ] **Step 1: Registrar role/módulo em Usuários**

Conforme CLAUDE.md (seção "Módulo de Usuários"): como o role `crc_comercial` já existe, garantir que o link `/comercial/` aparece para ele (já feito via `data-roles`). Se desejado um módulo extra granular, adicionar checkbox `#nu-mod-comercial`, `_ROLE_LABELS` e `criarUsuario()` — opcional no v1, confirmar com o usuário.

- [ ] **Step 2: Push + deploy (fluxo do projeto)**

```bash
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

- [ ] **Step 3: Disparar sync e validar em produção**

`POST /api/admin/sync-clinicorp` (autenticado) para popular as tabelas. Abrir `/comercial/` na URL pública e conferir os cards do mês corrente.

---

## Self-Review (cobertura do spec)

- Funil 12 cards → Tasks 4, 8, 9 ✓
- Duas visões (clínica/leads) → Task 4 (`agregarFunil`), Task 9 (duas colunas) ✓
- Filtro de período → Tasks 8, 9 ✓
- Quebra por campanha (origem) → Tasks 4, 8, 9 ✓
- Camada de dados persistida + config avaliadores → Tasks 1, 5, 6 ✓
- Comparecimento via StatusId configurável → Tasks 1, 2, 5 ✓
- Vínculo lead↔paciente por telefone → Tasks 3, 7 ✓
- RLS habilitado nas tabelas novas → Task 1 ✓
- Fora do v1 (desconto/entrada/metas/import) → não implementado, conforme spec ✓

**Riscos remanescentes (documentados):** nomes exatos dos avaliadores e mapeamento de Status→compareceu dependem da confirmação do usuário (Task 2); semântica dos % validada contra os números do appcrc (visão leads). A visão de leads fica esparsa até o import do appcrc (sub-projeto separado).
