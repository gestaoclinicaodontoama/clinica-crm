# Módulo Financeiro / DRE — Fase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Espelhar os lançamentos financeiros do Clinicorp no CRM, categorizá-los automaticamente (motor de 3 camadas) e gerar a DRE gerencial consolidada em regime de caixa, substituindo o controle manual em Excel.

**Architecture:** CRM como camada gerencial sobre o Clinicorp (Opção B). Sync em lote (`list_summary`, 1 req/mês) → tabelas Supabase → motor de categorização (lib pura, testável) → DRE calculada por views/queries. Lógica de negócio isolada em `lib/financeiro/` (funções puras com testes), persistência/sync em `sync/`, rotas em `server.js`, UI em `public/financeiro/`.

**Tech Stack:** Node.js + Express, Supabase (Postgres + RLS), `@supabase/supabase-js`, `zod`, testes com `node:test` (`node --test "lib/**/*.test.js"`), frontend HTML/CSS/JS vanilla. Spec: `docs/superpowers/specs/2026-06-15-financeiro-dre-fase1-design.md`.

---

## File Structure

**Lógica pura (TDD, `lib/financeiro/`):**
- `lib/financeiro/normalizar.js` — normaliza descrição (núcleo), extrai empresa (AMA/MAR/PF). + `.test.js`
- `lib/financeiro/data.js` — converte data UTC→America/Sao_Paulo, extrai mês/dia. + `.test.js`
- `lib/financeiro/mapear-lancamento.js` — lançamento bruto Clinicorp → registro normalizado (fluxo, valor, forma_pgto, receita tipo). + `.test.js`
- `lib/financeiro/categorizar.js` — motor 3 camadas (exato→pessoa→keyword c/ limiar). + `.test.js`
- `lib/financeiro/dre.js` — agrega lançamentos na cascata 1→7. + `.test.js`
- `lib/financeiro/receita-sub.js` — split Entrada/Parcelas (stateful por paciente). + `.test.js`
- `lib/financeiro/taxonomia.js` — as 31 categorias canônicas (seed em código). + `.test.js`

**Sync/persistência (`sync/`):**
- `sync/financeiro-sync.js` — puxa list_summary, mapeia, upsert, reconcilia, categoriza.

**Migrações (`supabase/migrations/`):**
- `NNNN_financeiro_tabelas.sql` — 5 tabelas + índices + RLS.

**Scripts (`scripts/`):**
- `scripts/seed-financeiro-contas.js` — insere taxonomia em `fin_contas`.
- `scripts/seed-financeiro-regras.js` — lê o de-para `.xlsm` (local) → insere `fin_regras` (gera artefato gitignored).
- `scripts/backfill-financeiro.js` — backfill 2026→2025→2024 + validação.

**Rotas (`server.js`):** middleware `requireFinanceiro` + rotas `/api/financeiro/*`.

**Frontend (`public/financeiro/`):** `index.html` (DRE), `a-categorizar.html`, `lancamentos.html`, `cadastros.html`; `public/js/financeiro/api.js`.

---

## Grupo A — Schema & Taxonomia

### Task 1: Migração das 5 tabelas

**Files:**
- Create: `supabase/migrations/20260615120000_financeiro_tabelas.sql`

- [ ] **Step 1: Escrever a migração**

```sql
-- fin_contas: plano de contas canônico
create table if not exists fin_contas (
  id          bigint generated always as identity primary key,
  codigo      text not null,                 -- "3.1.7", "1.2"
  nome        text not null,                 -- "Invisalign", "Particular"
  grupo       text not null,                 -- "3.1 - CUSTOS MATERIAL"
  tipo        text not null check (tipo in ('receita','imposto','custo','despesa','financeiro','investimento')),
  ordem       int  not null default 0,
  ativo       boolean not null default true,
  unique (codigo)
);

-- fin_lancamentos: espelho dos lançamentos do Clinicorp
create table if not exists fin_lancamentos (
  id                   bigint generated always as identity primary key,
  clinicorp_id         text not null unique,            -- "id" do lançamento
  data                 date not null,                   -- já em America/Sao_Paulo
  descricao            text not null,
  valor                numeric(14,2) not null,          -- sempre positivo
  fluxo                text not null check (fluxo in ('entra','sai')),
  post_type            text,
  entry_type           text,
  forma_pgto           text,                            -- dinheiro/cartao/boleto/pix/convenio
  empresa              text,                            -- AMA/MAR/PF/null
  paciente_id          text,                            -- RelatedPersonId
  receita_sub          text check (receita_sub in ('entrada','parcelas')),
  conta_id             bigint references fin_contas(id),
  classificacao_metodo text,                            -- exato/regra/pessoa/manual
  override_manual      boolean not null default false,
  ativo                boolean not null default true,
  visto_em             timestamptz,
  raw                  jsonb,
  criado_em            timestamptz not null default now()
);
create index if not exists idx_fin_lanc_data    on fin_lancamentos(data);
create index if not exists idx_fin_lanc_conta   on fin_lancamentos(conta_id);
create index if not exists idx_fin_lanc_semcat  on fin_lancamentos(conta_id) where conta_id is null;
create index if not exists idx_fin_lanc_pac     on fin_lancamentos(paciente_id);

-- fin_regras: regras de categorização
create table if not exists fin_regras (
  id         bigint generated always as identity primary key,
  metodo     text not null check (metodo in ('exato','keyword','pessoa')),
  padrao     text not null,                  -- descrição-núcleo / token / nome
  conta_id   bigint not null references fin_contas(id),
  prioridade int not null default 0,
  origem     text not null default 'manual', -- semente/manual
  criado_por text,
  hits       int not null default 0,
  criado_em  timestamptz not null default now(),
  unique (metodo, padrao)
);

-- fin_pessoas: registro de nomes próprios
create table if not exists fin_pessoas (
  id        bigint generated always as identity primary key,
  nome      text not null,
  papel     text,                            -- dentista_socio/dentista_cnpj/funcionario/tecnico
  conta_id  bigint references fin_contas(id),
  empresa   text,
  ativo     boolean not null default true,
  unique (nome)
);

-- fin_sync_log: auditoria
create table if not exists fin_sync_log (
  id              bigint generated always as identity primary key,
  periodo         text,
  qtd_lancamentos int,
  novos           int,
  inativados      int,
  quando          timestamptz not null default now(),
  status          text,
  erro            text
);

alter table fin_contas      enable row level security;
alter table fin_lancamentos enable row level security;
alter table fin_regras      enable row level security;
alter table fin_pessoas     enable row level security;
alter table fin_sync_log    enable row level security;
```

- [ ] **Step 2: Aplicar via MCP Supabase**

Aplicar com `apply_migration` (project `mtqdpjhhqzvuklnlfpvi`), name `financeiro_tabelas`.
Expected: sucesso, sem erro.

- [ ] **Step 3: Verificar**

Rodar `list_tables` (MCP) e confirmar as 5 tabelas `fin_*` criadas.
Expected: `fin_contas`, `fin_lancamentos`, `fin_regras`, `fin_pessoas`, `fin_sync_log` presentes.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260615120000_financeiro_tabelas.sql
git commit -m "feat(financeiro): schema das 5 tabelas (fase 1)"
```

---

### Task 2: Taxonomia canônica (lib + seed)

**Files:**
- Create: `lib/financeiro/taxonomia.js`
- Test: `lib/financeiro/taxonomia.test.js`

- [ ] **Step 1: Escrever o teste**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { CONTAS, byCodigo, GRUPOS_DRE } = require('./taxonomia');

test('tem 31 contas com codigo unico', () => {
  assert.equal(CONTAS.length, 31);
  const cods = new Set(CONTAS.map(c => c.codigo));
  assert.equal(cods.size, 31);
});

test('receita tem Convênio e Particular', () => {
  const rec = CONTAS.filter(c => c.tipo === 'receita').map(c => c.nome);
  assert.ok(rec.includes('Convênio'));
  assert.ok(rec.includes('Particular'));
});

test('byCodigo encontra Invisalign', () => {
  assert.equal(byCodigo('3.1.7').nome, 'Invisalign');
});

test('cascata DRE na ordem certa', () => {
  assert.deepEqual(GRUPOS_DRE.map(g => g.codigo), ['1','2','3.0','3.1','3.2','3.3','4','5','7']);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -- lib/financeiro/taxonomia.test.js` (ou `node --test lib/financeiro/taxonomia.test.js`)
Expected: FAIL — "Cannot find module './taxonomia'".

- [ ] **Step 3: Implementar**

```js
// 31 categorias canônicas (extraídas de "descricao e cat certa.xlsm" / DRE do Luiz).
// tipo: receita|imposto|custo|despesa|financeiro|investimento
const CONTAS = [
  { codigo: '1.1', nome: 'Convênio',   grupo: '1 - RECEITA', tipo: 'receita', ordem: 1 },
  { codigo: '1.2', nome: 'Particular', grupo: '1 - RECEITA', tipo: 'receita', ordem: 2 },

  { codigo: '2.1', nome: 'SIMPLES',     grupo: '2 - IMPOSTOS', tipo: 'imposto', ordem: 10 },
  { codigo: '2.2', nome: 'Cofins',      grupo: '2 - IMPOSTOS', tipo: 'imposto', ordem: 11 },
  { codigo: '2.3', nome: 'CSLL',        grupo: '2 - IMPOSTOS', tipo: 'imposto', ordem: 12 },
  { codigo: '2.4', nome: 'IRPJ',        grupo: '2 - IMPOSTOS', tipo: 'imposto', ordem: 13 },
  { codigo: '2.6', nome: 'PIS',         grupo: '2 - IMPOSTOS', tipo: 'imposto', ordem: 14 },
  { codigo: '2.7', nome: 'ISS',         grupo: '2 - IMPOSTOS', tipo: 'imposto', ordem: 15 },
  { codigo: '2.8', nome: 'Carnê Leão',  grupo: '2 - IMPOSTOS', tipo: 'imposto', ordem: 16 },

  { codigo: '3.0.1', nome: 'Tarifa cartão de crédito', grupo: '3.0 - TARIFAS', tipo: 'custo', ordem: 20 },

  { codigo: '3.1.2', nome: 'Laboratório de Prótese', grupo: '3.1 - CUSTOS MATERIAL', tipo: 'custo', ordem: 30 },
  { codigo: '3.1.3', nome: 'Dentais',         grupo: '3.1 - CUSTOS MATERIAL', tipo: 'custo', ordem: 31 },
  { codigo: '3.1.4', nome: 'Farmácias',       grupo: '3.1 - CUSTOS MATERIAL', tipo: 'custo', ordem: 32 },
  { codigo: '3.1.5', nome: 'Gases medicinais',grupo: '3.1 - CUSTOS MATERIAL', tipo: 'custo', ordem: 33 },
  { codigo: '3.1.6', nome: 'Implantes',       grupo: '3.1 - CUSTOS MATERIAL', tipo: 'custo', ordem: 34 },
  { codigo: '3.1.7', nome: 'Invisalign',      grupo: '3.1 - CUSTOS MATERIAL', tipo: 'custo', ordem: 35 },

  { codigo: '3.2.1', nome: 'Pagamento aos dentistas - Sócios', grupo: '3.2 - MÃO DE OBRA DENTISTA', tipo: 'custo', ordem: 40 },
  { codigo: '3.2.2', nome: 'Pagamento aos dentistas - CNPJ',   grupo: '3.2 - MÃO DE OBRA DENTISTA', tipo: 'custo', ordem: 41 },

  { codigo: '3.3.1', nome: 'Técnicos',            grupo: '3.3 - CUSTOS INDIRETOS', tipo: 'custo', ordem: 50 },
  { codigo: '3.3.2', nome: 'Moto taxi (Transporte)', grupo: '3.3 - CUSTOS INDIRETOS', tipo: 'custo', ordem: 51 },

  { codigo: '4.1.1', nome: 'Recursos Humanos',        grupo: '4 - DESPESAS FIXAS', tipo: 'despesa', ordem: 60 },
  { codigo: '4.1.2', nome: 'Administrativo',          grupo: '4 - DESPESAS FIXAS', tipo: 'despesa', ordem: 61 },
  { codigo: '4.1.3', nome: 'Comercial',               grupo: '4 - DESPESAS FIXAS', tipo: 'despesa', ordem: 62 },
  { codigo: '4.1.4', nome: 'Marketing',               grupo: '4 - DESPESAS FIXAS', tipo: 'despesa', ordem: 63 },
  { codigo: '4.1.5', nome: 'Conservação e Reposição', grupo: '4 - DESPESAS FIXAS', tipo: 'despesa', ordem: 64 },
  { codigo: '4.1.6', nome: 'Cursos/Treinamentos',     grupo: '4 - DESPESAS FIXAS', tipo: 'despesa', ordem: 65 },

  { codigo: '5.1', nome: 'Empréstimos (Juros)',       grupo: '5 - FINANCEIRAS', tipo: 'financeiro', ordem: 70 },
  { codigo: '5.5', nome: 'Devolução de recebimento',  grupo: '5 - FINANCEIRAS', tipo: 'financeiro', ordem: 71 },

  { codigo: '7.3', nome: 'Reforma (Melhorias)', grupo: '7 - INVESTIMENTOS', tipo: 'investimento', ordem: 80 },
  { codigo: '7.5', nome: 'Investimentos',       grupo: '7 - INVESTIMENTOS', tipo: 'investimento', ordem: 81 },
];

const GRUPOS_DRE = [
  { codigo: '1',   titulo: '1 - RECEITA' },
  { codigo: '2',   titulo: '2 - IMPOSTOS' },
  { codigo: '3.0', titulo: '3.0 - TARIFAS' },
  { codigo: '3.1', titulo: '3.1 - CUSTOS MATERIAL' },
  { codigo: '3.2', titulo: '3.2 - MÃO DE OBRA DENTISTA' },
  { codigo: '3.3', titulo: '3.3 - CUSTOS INDIRETOS' },
  { codigo: '4',   titulo: '4 - DESPESAS FIXAS' },
  { codigo: '5',   titulo: '5 - FINANCEIRAS' },
  { codigo: '7',   titulo: '7 - INVESTIMENTOS' },
];

const _byCodigo = new Map(CONTAS.map(c => [c.codigo, c]));
const byCodigo = (cod) => _byCodigo.get(cod);

module.exports = { CONTAS, GRUPOS_DRE, byCodigo };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/financeiro/taxonomia.test.js`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/financeiro/taxonomia.js lib/financeiro/taxonomia.test.js
git commit -m "feat(financeiro): taxonomia canônica (31 contas)"
```

---

### Task 3: Seed de `fin_contas`

**Files:**
- Create: `scripts/seed-financeiro-contas.js`

- [ ] **Step 1: Escrever o script de seed**

```js
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { CONTAS } = require('../lib/financeiro/taxonomia');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

(async () => {
  const rows = CONTAS.map(c => ({ codigo: c.codigo, nome: c.nome, grupo: c.grupo, tipo: c.tipo, ordem: c.ordem, ativo: true }));
  const { error } = await supabase.from('fin_contas').upsert(rows, { onConflict: 'codigo' });
  if (error) { console.error('Erro:', error.message); process.exit(1); }
  console.log(`Seed fin_contas: ${rows.length} contas.`);
})();
```

- [ ] **Step 2: Rodar**

Run: `node scripts/seed-financeiro-contas.js`
Expected: "Seed fin_contas: 30 contas."

- [ ] **Step 3: Verificar via MCP**

`execute_sql`: `select count(*), count(distinct grupo) from fin_contas;`
Expected: 30 contas, 9 grupos.

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-financeiro-contas.js
git commit -m "feat(financeiro): seed do plano de contas"
```

---

## Grupo B — Lógica pura (lib/financeiro, TDD)

### Task 4: Normalização de descrição + extração de empresa

**Files:**
- Create: `lib/financeiro/normalizar.js`
- Test: `lib/financeiro/normalizar.test.js`

- [ ] **Step 1: Escrever o teste**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { nucleo, empresa, tokens } = require('./normalizar');

test('nucleo remove prefixo, empresa, parcela, acento', () => {
  assert.equal(nucleo('Pagamento de Conta: Pró labore Marcos Vinicius - PF 3/12'), 'pro labore marcos vinicius');
  assert.equal(nucleo('Pagamento de Conta: Simples - AMA'), 'simples');
});

test('empresa extrai sufixo', () => {
  assert.equal(empresa('Pagamento de Conta: Salários - AMA'), 'AMA');
  assert.equal(empresa('Pagamento de Conta: IRPF Dorinha - MAR'), 'MAR');
  assert.equal(empresa('Pagamento de Conta: Pagamento Matheus - PF 3/12'), 'PF');
  assert.equal(empresa('Pagamento de Conta: Martins - Martins'), 'MAR'); // alias
  assert.equal(empresa('Pagamento de Conta: Conservação'), null);
});

test('tokens remove stopwords e numeros', () => {
  assert.deepEqual(tokens('Pagamento de Conta: NFe 72 - Atelie Odonto Prótese - PF'),
    ['atelie','odonto','protese']);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/financeiro/normalizar.test.js`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

```js
function deacc(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}
const ENT = /\s*-\s*(AMA|MAR|PF|Martins)\b/i;
const STOP = new Set(['de','da','do','dos','das','e','a','o','conta','pagamento','nfe','nf','n','por','para','com']);

function nucleo(desc) {
  let s = deacc(desc);
  s = s.replace(/^pagamento de conta:\s*/i, '');
  s = s.replace(/\s*\d+\/\d+\s*/g, ' ');   // parcela N/M
  s = s.replace(ENT, ' ');
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function empresa(desc) {
  const m = ENT.exec(String(desc || ''));
  if (!m) return null;
  const e = m[1].toUpperCase();
  return (e === 'MARTINS') ? 'MAR' : e;
}

function tokens(desc) {
  return nucleo(desc).match(/[a-z]{3,}/g)?.filter(t => !STOP.has(t)) || [];
}

module.exports = { nucleo, empresa, tokens, deacc };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/financeiro/normalizar.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/financeiro/normalizar.js lib/financeiro/normalizar.test.js
git commit -m "feat(financeiro): normalização de descrição e empresa"
```

---

### Task 5: Data com fuso America/Sao_Paulo

**Files:**
- Create: `lib/financeiro/data.js`
- Test: `lib/financeiro/data.test.js`

- [ ] **Step 1: Escrever o teste**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { dataLocal, mesLocal } = require('./data');

test('UTC tarde da noite cai no dia certo em BR', () => {
  // 31/03 22h BRT = 01:00Z do dia 01/04
  assert.equal(dataLocal('2026-04-01T01:00:00.000Z'), '2026-03-31');
  assert.equal(mesLocal('2026-04-01T01:00:00.000Z'), '2026-03');
});

test('manhã UTC permanece no mesmo dia', () => {
  assert.equal(dataLocal('2026-05-18T14:00:00.000Z'), '2026-05-18');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/financeiro/data.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementar**

```js
// Converte timestamp ISO (UTC) para data/mês no fuso America/Sao_Paulo.
const TZ = 'America/Sao_Paulo';
const FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

function dataLocal(iso) {
  if (!iso) return null;
  return FMT.format(new Date(iso));       // en-CA → "YYYY-MM-DD"
}
function mesLocal(iso) {
  const d = dataLocal(iso);
  return d ? d.slice(0, 7) : null;        // "YYYY-MM"
}

module.exports = { dataLocal, mesLocal, TZ };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/financeiro/data.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/financeiro/data.js lib/financeiro/data.test.js
git commit -m "feat(financeiro): data no fuso America/Sao_Paulo"
```

---

### Task 6: Mapear lançamento bruto do Clinicorp

**Files:**
- Create: `lib/financeiro/mapear-lancamento.js`
- Test: `lib/financeiro/mapear-lancamento.test.js`

- [ ] **Step 1: Escrever o teste**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { mapear } = require('./mapear-lancamento');

const despesa = { id: '5671', PostType: 'EXPENSES', EntryType: 'ACCOUNTS_PAYMENT',
  Description: 'Pagamento de Conta: Salários - AMA', Amount: 26047.0, PostDate: '2026-05-03T05:25:24.934Z' };
const convenio = { id: '99', PostType: 'RECEIVED', EntryType: 'INSURANCE_PLAN_CLAIM',
  Description: 'Reconciliação Plano', Amount: 100.5, PostDate: '2026-05-10T13:00:00Z', RelatedPersonId: 7 };
const pix = { id: '100', PostType: 'RECEIVED', EntryType: '',
  Description: 'Confirmação Pix', Amount: 50.0, PostDate: '2026-05-10T13:00:00Z', RelatedPersonId: 8 };

test('despesa vira fluxo sai, valor positivo, empresa AMA', () => {
  const m = mapear(despesa);
  assert.equal(m.fluxo, 'sai'); assert.equal(m.valor, 26047.0);
  assert.equal(m.empresa, 'AMA'); assert.equal(m.clinicorp_id, '5671');
  assert.equal(m.data, '2026-05-03');
});

test('convênio: fluxo entra, forma_pgto convenio', () => {
  const m = mapear(convenio);
  assert.equal(m.fluxo, 'entra'); assert.equal(m.forma_pgto, 'convenio');
  assert.equal(m.paciente_id, '7');
});

test('pix particular: forma_pgto pix', () => {
  assert.equal(mapear(pix).forma_pgto, 'pix');
});

test('Amount negativo inverte fluxo e vira positivo', () => {
  const m = mapear({ ...despesa, Amount: -10 });
  assert.equal(m.valor, 10); assert.equal(m.fluxo, 'entra');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/financeiro/mapear-lancamento.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementar**

```js
const { empresa } = require('./normalizar');
const { dataLocal } = require('./data');

function formaPgto(e) {
  if (e.EntryType === 'INSURANCE_PLAN_CLAIM') return 'convenio';
  const d = (e.Description || '').toLowerCase();
  if (d.includes('plano')) return 'convenio';
  if (d.includes('pix')) return 'pix';
  if (d.includes('cartão') || d.includes('cartao')) return 'cartao';
  if (d.includes('boleto')) return 'boleto';
  if (d.includes('pagamento de tratamento')) return 'dinheiro';
  return null;
}

function mapear(e) {
  const ehDespesa = e.PostType === 'EXPENSES' || e.EntryType === 'ACCOUNTS_PAYMENT';
  let valor = Number(e.Amount) || 0;
  let fluxo = ehDespesa ? 'sai' : 'entra';
  if (valor < 0) { valor = Math.abs(valor); fluxo = fluxo === 'sai' ? 'entra' : 'sai'; }
  return {
    clinicorp_id: String(e.id),
    data: dataLocal(e.PostDate || e.Date),
    descricao: e.Description || '',
    valor: Math.round(valor * 100) / 100,
    fluxo,
    post_type: e.PostType || null,
    entry_type: e.EntryType || null,
    forma_pgto: ehDespesa ? null : formaPgto(e),
    empresa: empresa(e.Description),
    paciente_id: (e.RelatedPersonId != null && e.RelatedPersonId !== -1) ? String(e.RelatedPersonId) : null,
    raw: e,
  };
}

module.exports = { mapear, formaPgto };
```

> Nota: o campo de data (`PostDate` vs `Date`) é confirmado empiricamente na Task 14 (validação). Se `Date` reproduzir melhor o `cash_flow`, trocar a ordem em `mapear`.

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/financeiro/mapear-lancamento.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/financeiro/mapear-lancamento.js lib/financeiro/mapear-lancamento.test.js
git commit -m "feat(financeiro): mapeamento de lançamento bruto"
```

---

### Task 7: Motor de categorização (3 camadas + limiar)

**Files:**
- Create: `lib/financeiro/categorizar.js`
- Test: `lib/financeiro/categorizar.test.js`

- [ ] **Step 1: Escrever o teste**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { criarCategorizador } = require('./categorizar');

const regras = [
  { metodo: 'exato',   padrao: 'simples', conta_codigo: '2.1' },
  { metodo: 'keyword', padrao: 'invisalign', conta_codigo: '3.1.7' },
  { metodo: 'keyword', padrao: 'neodent', conta_codigo: '3.1.6' },
];
const pessoas = [{ nome: 'Amanda', conta_codigo: '3.2.2' }];

test('camada exata vence', () => {
  const cat = criarCategorizador({ regras, pessoas });
  const r = cat('Pagamento de Conta: Simples - AMA');
  assert.equal(r.conta_codigo, '2.1'); assert.equal(r.metodo, 'exato');
});

test('pessoa vem antes de keyword', () => {
  // "Pagamento Amanda" não tem keyword, mas pessoa resolve
  const cat = criarCategorizador({ regras, pessoas });
  const r = cat('Pagamento de Conta: Pagamento Amanda - MAR 3/12');
  assert.equal(r.conta_codigo, '3.2.2'); assert.equal(r.metodo, 'pessoa');
});

test('keyword resolve fornecedor', () => {
  const cat = criarCategorizador({ regras, pessoas });
  assert.equal(cat('Pagamento de Conta: NFe 12 - Invisalign - PF').conta_codigo, '3.1.7');
});

test('sem match → null (a categorizar)', () => {
  const cat = criarCategorizador({ regras, pessoas });
  const r = cat('Pagamento de Conta: Fornecedor Desconhecido XYZ - AMA');
  assert.equal(r.conta_codigo, null); assert.equal(r.metodo, null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/financeiro/categorizar.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementar**

```js
const { nucleo, tokens, deacc } = require('./normalizar');

// Cria um categorizador a partir de regras (exato/keyword) e pessoas.
// Ordem das camadas: exato → pessoa → keyword (do mais específico ao mais genérico).
function criarCategorizador({ regras = [], pessoas = [], limiar = 1 }) {
  const exatos = new Map();
  const keywords = new Map(); // token → [{conta_codigo, peso}]
  for (const r of regras) {
    if (r.metodo === 'exato') exatos.set(r.padrao, r.conta_codigo);
    else if (r.metodo === 'keyword') {
      const arr = keywords.get(r.padrao) || [];
      arr.push({ conta: r.conta_codigo, peso: r.peso || 1 });
      keywords.set(r.padrao, arr);
    }
  }
  const pessoasNorm = pessoas
    .filter(p => p.conta_codigo)
    .map(p => ({ nome: deacc(p.nome).toLowerCase(), conta: p.conta_codigo }));

  return function categorizar(descricao) {
    // 1. exato
    const nuc = nucleo(descricao);
    if (exatos.has(nuc)) return { conta_codigo: exatos.get(nuc), metodo: 'exato' };

    // 2. pessoa (nome como palavra inteira no núcleo)
    for (const p of pessoasNorm) {
      const re = new RegExp(`\\b${p.nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (re.test(nuc)) return { conta_codigo: p.conta, metodo: 'pessoa' };
    }

    // 3. keyword com votação + limiar
    const score = new Map();
    for (const t of tokens(descricao)) {
      for (const { conta, peso } of (keywords.get(t) || [])) {
        score.set(conta, (score.get(conta) || 0) + peso);
      }
    }
    if (score.size) {
      const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
      const [conta, top] = ranked[0];
      const segundo = ranked[1]?.[1] || 0;
      if (top >= limiar && top > segundo) return { conta_codigo: conta, metodo: 'regra' };
    }
    return { conta_codigo: null, metodo: null };
  };
}

module.exports = { criarCategorizador };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/financeiro/categorizar.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/financeiro/categorizar.js lib/financeiro/categorizar.test.js
git commit -m "feat(financeiro): motor de categorização 3 camadas"
```

---

### Task 8: Cálculo da DRE (cascata)

**Files:**
- Create: `lib/financeiro/dre.js`
- Test: `lib/financeiro/dre.test.js`

- [ ] **Step 1: Escrever o teste**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { montarDRE } = require('./dre');

// lançamentos já com conta (codigo) e valor positivo
const lancs = [
  { fluxo: 'entra', valor: 72985.41, conta_codigo: '1.1' }, // Convênio
  { fluxo: 'entra', valor: 294466.02, conta_codigo: '1.2' }, // Particular
  { fluxo: 'sai',   valor: 6364.62,  conta_codigo: '2.1' }, // SIMPLES
  { fluxo: 'sai',   valor: 26201.51, conta_codigo: '3.1.7' }, // Invisalign
];

test('soma receita e subtrai despesa, resultado correto', () => {
  const dre = montarDRE(lancs);
  assert.equal(dre.receita, 367451.43);
  const grupo2 = dre.grupos.find(g => g.codigo === '2');
  assert.equal(grupo2.total, -6364.62);
  assert.equal(dre.resultado, 367451.43 - 6364.62 - 26201.51);
});

test('agrupa por grupo da conta', () => {
  const dre = montarDRE(lancs);
  const g31 = dre.grupos.find(g => g.codigo === '3.1');
  assert.equal(g31.total, -26201.51);
  assert.equal(g31.contas[0].nome, 'Invisalign');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/financeiro/dre.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementar**

```js
const { CONTAS, GRUPOS_DRE, byCodigo } = require('./taxonomia');

// Recebe lançamentos {fluxo, valor, conta_codigo} → estrutura de DRE em cascata.
function montarDRE(lancs) {
  const porConta = new Map();      // codigo → soma (com sinal)
  for (const l of lancs) {
    if (!l.conta_codigo) continue;
    const sinal = l.fluxo === 'entra' ? 1 : -1;
    porConta.set(l.conta_codigo, (porConta.get(l.conta_codigo) || 0) + sinal * l.valor);
  }
  const r2 = (n) => Math.round(n * 100) / 100;

  const grupos = GRUPOS_DRE.map(g => {
    const contas = CONTAS
      .filter(c => c.grupo.startsWith(g.titulo.split(' - ')[0] + ' ') || c.grupo === g.titulo)
      .filter(c => porConta.has(c.codigo))
      .map(c => ({ codigo: c.codigo, nome: c.nome, total: r2(porConta.get(c.codigo)) }))
      .sort((a, b) => byCodigo(a.codigo).ordem - byCodigo(b.codigo).ordem);
    return { codigo: g.codigo, titulo: g.titulo, total: r2(contas.reduce((s, c) => s + c.total, 0)), contas };
  });

  const receita = grupos.find(g => g.codigo === '1')?.total || 0;
  const resultado = r2(grupos.reduce((s, g) => s + g.total, 0));
  return { receita: r2(receita), grupos, resultado };
}

module.exports = { montarDRE };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/financeiro/dre.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/financeiro/dre.js lib/financeiro/dre.test.js
git commit -m "feat(financeiro): cálculo da DRE em cascata"
```

---

### Task 9: Subsplit Entrada/Parcelas (stateful por paciente)

**Files:**
- Create: `lib/financeiro/receita-sub.js`
- Test: `lib/financeiro/receita-sub.test.js`

- [ ] **Step 1: Escrever o teste**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { marcarEntradaParcelas } = require('./receita-sub');

// Recebe TODA a receita particular do paciente (histórico completo), ordena por data.
test('primeiro pagamento do paciente = entrada; resto = parcelas', () => {
  const lancs = [
    { paciente_id: '1', data: '2026-02-10', valor: 500, forma_pgto: 'pix' },
    { paciente_id: '1', data: '2026-01-05', valor: 1000, forma_pgto: 'pix' }, // mais antigo
    { paciente_id: '1', data: '2026-03-10', valor: 500, forma_pgto: 'boleto' },
    { paciente_id: '2', data: '2026-02-01', valor: 200, forma_pgto: 'pix' },
  ];
  const out = marcarEntradaParcelas(lancs);
  const p1 = out.filter(l => l.paciente_id === '1').sort((a,b)=>a.data.localeCompare(b.data));
  assert.equal(p1[0].receita_sub, 'entrada');   // 05/01
  assert.equal(p1[1].receita_sub, 'parcelas');  // 10/02
  assert.equal(p1[2].receita_sub, 'parcelas');  // 10/03
  assert.equal(out.find(l => l.paciente_id === '2').receita_sub, 'entrada');
});

test('sem paciente_id → receita_sub null', () => {
  const out = marcarEntradaParcelas([{ paciente_id: null, data: '2026-01-01', valor: 10 }]);
  assert.equal(out[0].receita_sub, null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/financeiro/receita-sub.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementar**

```js
// Marca o 1º pagamento (por data) de cada paciente como 'entrada', os demais como 'parcelas'.
// IMPORTANTE: receber o histórico COMPLETO do paciente (rodar só após backfill total).
// O caso "entrada parcelada no cartão" fica em aberto (ver spec §12) — ajuste manual pontual.
function marcarEntradaParcelas(lancs) {
  const primeiroPorPaciente = new Map();
  for (const l of lancs) {
    if (!l.paciente_id) continue;
    const atual = primeiroPorPaciente.get(l.paciente_id);
    if (!atual || l.data < atual) primeiroPorPaciente.set(l.paciente_id, l.data);
  }
  return lancs.map(l => {
    if (!l.paciente_id) return { ...l, receita_sub: null };
    const ehEntrada = l.data === primeiroPorPaciente.get(l.paciente_id);
    return { ...l, receita_sub: ehEntrada ? 'entrada' : 'parcelas' };
  });
}

module.exports = { marcarEntradaParcelas };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/financeiro/receita-sub.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/financeiro/receita-sub.js lib/financeiro/receita-sub.test.js
git commit -m "feat(financeiro): subsplit Entrada/Parcelas por paciente"
```

---

## Grupo C — Seed de regras (de-para) & Sync

### Task 10: Seed de `fin_regras` a partir do de-para `.xlsm`

**Files:**
- Create: `scripts/seed-financeiro-regras.js`
- Modify: `.gitignore` (adicionar `scripts/_seed_regras.json`)

- [ ] **Step 1: Escrever o script**

Lê o de-para local, gera regras `exato` (descrição-núcleo → conta) e `keyword` (tokens distintos que votam categoria), insere em `fin_regras`. O `.xlsm` só existe na máquina do Luiz; o artefato JSON gerado é gitignored.

```js
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { nucleo, tokens } = require('../lib/financeiro/normalizar');

const XLSM = process.env.DEPARA_PATH || 'P:\\LUIZ\\AMA -ADMIN\\descricao e cat certa.xlsm';
// Requer 'xlsx' instalado localmente só para o seed (devDependency).
const XLSX = require('xlsx');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });

(async () => {
  const wb = XLSX.readFile(XLSM);
  const ws = wb.Sheets['Planilha1'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }).slice(2);

  // mapa código por NOME de categoria (a planilha usa "2.1. SIMPLES" etc.)
  const { CONTAS } = require('../lib/financeiro/taxonomia');
  const byNomeLower = new Map(CONTAS.map(c => [c.nome.toLowerCase(), c.codigo]));
  function resolveCodigo(catCerta) {
    // "3.1.7 Invisalign" → tenta código no início, senão nome
    const m = String(catCerta).match(/^(\d+(?:\.\d+)*)/);
    if (m && CONTAS.find(c => c.codigo === m[1])) return m[1];
    const nome = String(catCerta).replace(/^[\d.\s]+/, '').trim().toLowerCase();
    return byNomeLower.get(nome) || null;
  }

  const exatos = new Map();         // nucleo → codigo
  const tokVote = new Map();        // token → Map(codigo→count)
  for (const r of rows) {
    const desc = r[0], cat = r[1];
    if (!desc || !cat) continue;
    const cod = resolveCodigo(cat);
    if (!cod) continue;
    exatos.set(nucleo(desc), cod);
    for (const t of tokens(desc)) {
      const m = tokVote.get(t) || new Map();
      m.set(cod, (m.get(cod) || 0) + 1);
      tokVote.set(t, m);
    }
  }
  // keyword: token vence se a categoria majoritária tem ≥2 votos
  const keywords = [];
  for (const [t, m] of tokVote) {
    const [cod, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n >= 2) keywords.push({ metodo: 'keyword', padrao: t, conta_codigo: cod, peso: n });
  }
  const seed = [
    ...[...exatos].map(([padrao, cod]) => ({ metodo: 'exato', padrao, conta_codigo: cod, peso: 1 })),
    ...keywords,
  ];
  fs.writeFileSync(__dirname + '/_seed_regras.json', JSON.stringify(seed, null, 2));

  // resolve conta_codigo → conta_id e insere
  const { data: contas } = await supabase.from('fin_contas').select('id,codigo');
  const idByCod = new Map(contas.map(c => [c.codigo, c.id]));
  const rowsDb = seed.filter(s => idByCod.has(s.conta_codigo))
    .map(s => ({ metodo: s.metodo, padrao: s.padrao, conta_id: idByCod.get(s.conta_codigo), peso: s.peso, origem: 'semente' }));
  // peso não existe no schema base de fin_regras → adicionar coluna (ver Step 2)
  const { error } = await supabase.from('fin_regras').upsert(rowsDb, { onConflict: 'metodo,padrao' });
  if (error) { console.error(error.message); process.exit(1); }
  console.log(`Seed regras: ${exatos.size} exatas + ${keywords.length} keywords.`);
})();
```

- [ ] **Step 2: Adicionar coluna `peso` em `fin_regras`**

Migração `apply_migration` name `financeiro_regras_peso`:
```sql
alter table fin_regras add column if not exists peso int not null default 1;
```

- [ ] **Step 3: Instalar `xlsx` como devDependency e rodar**

Run: `npm install --save-dev xlsx && node scripts/seed-financeiro-regras.js`
Expected: "Seed regras: ~2100 exatas + N keywords."

- [ ] **Step 4: Gitignore do artefato + commit**

Adicionar `scripts/_seed_regras.json` ao `.gitignore`.
```bash
git add scripts/seed-financeiro-regras.js .gitignore supabase/migrations/*regras_peso.sql package.json package-lock.json
git commit -m "feat(financeiro): seed de regras a partir do de-para"
```

---

### Task 11: Sync financeiro (list_summary → upsert → categorizar → reconciliar)

**Files:**
- Create: `sync/financeiro-sync.js`

- [ ] **Step 1: Implementar o sync**

```js
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const ClinicorpApi = require('./clinicorp-api');
const { mapear } = require('../lib/financeiro/mapear-lancamento');
const { criarCategorizador } = require('../lib/financeiro/categorizar');

const supabase = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });
const api = new ClinicorpApi({
  user: process.env.CLINICORP_USER, token: process.env.CLINICORP_TOKEN,
  subscriberId: process.env.CLINICORP_SUBSCRIBER_ID, businessId: process.env.CLINICORP_BUSINESS_ID,
});

async function carregarCategorizador() {
  const [{ data: contas }, { data: regras }, { data: pessoas }] = await Promise.all([
    supabase.from('fin_contas').select('id,codigo'),
    supabase.from('fin_regras').select('metodo,padrao,peso,conta_id'),
    supabase.from('fin_pessoas').select('nome,conta_id').eq('ativo', true),
  ]);
  const codById = new Map(contas.map(c => [c.id, c.codigo]));
  const idByCod = new Map(contas.map(c => [c.codigo, c.id]));
  const cat = criarCategorizador({
    regras: regras.map(r => ({ metodo: r.metodo, padrao: r.padrao, peso: r.peso, conta_codigo: codById.get(r.conta_id) })),
    pessoas: pessoas.map(p => ({ nome: p.nome, conta_codigo: codById.get(p.conta_id) })),
  });
  return { cat, idByCod };
}

// Sincroniza um período [from,to] (YYYY-MM-DD). Idempotente + reconciliação.
async function syncPeriodo(from, to) {
  const inicio = new Date().toISOString();
  const r = await api.get('/financial/list_summary', { from, to });
  const itens = (r.values || []);
  const { cat, idByCod } = await carregarCategorizador();

  let novos = 0;
  for (const e of itens) {
    const m = mapear(e);
    if (!m.data) continue;
    // não sobrescreve categoria de linhas com override_manual
    const { data: existente } = await supabase.from('fin_lancamentos')
      .select('id,override_manual').eq('clinicorp_id', m.clinicorp_id).maybeSingle();
    let conta_id = null, metodo = null;
    if (m.fluxo === 'sai') { const c = cat(m.descricao); conta_id = c.conta_codigo ? idByCod.get(c.conta_codigo) : null; metodo = c.metodo; }
    else { conta_id = idByCod.get(m.forma_pgto === 'convenio' ? '1.1' : '1.2'); metodo = 'auto'; }

    const row = {
      clinicorp_id: m.clinicorp_id, data: m.data, descricao: m.descricao, valor: m.valor,
      fluxo: m.fluxo, post_type: m.post_type, entry_type: m.entry_type, forma_pgto: m.forma_pgto,
      empresa: m.empresa, paciente_id: m.paciente_id, raw: m.raw, ativo: true, visto_em: inicio,
    };
    if (!existente?.override_manual) { row.conta_id = conta_id; row.classificacao_metodo = metodo; }
    const { error } = await supabase.from('fin_lancamentos').upsert(row, { onConflict: 'clinicorp_id' });
    if (error) throw new Error(error.message);
    if (!existente) novos++;
  }

  // reconciliação: lançamentos do período não confirmados neste sync → ativo=false
  const { data: inativados } = await supabase.from('fin_lancamentos')
    .update({ ativo: false }).gte('data', from).lte('data', to).lt('visto_em', inicio).select('id');

  await supabase.from('fin_sync_log').insert({
    periodo: `${from}~${to}`, qtd_lancamentos: itens.length, novos,
    inativados: inativados?.length || 0, status: 'ok',
  });
  return { total: itens.length, novos, inativados: inativados?.length || 0 };
}

module.exports = { syncPeriodo };
```

- [ ] **Step 2: Smoke test manual (um mês)**

Run: `node -e "require('./sync/financeiro-sync').syncPeriodo('2026-05-01','2026-05-31').then(r=>console.log(r))"`
Expected: objeto `{ total: ~2200, novos: ~2200, inativados: 0 }`.

- [ ] **Step 3: Verificar via MCP**

`execute_sql`: `select fluxo, count(*), sum(valor) from fin_lancamentos group by fluxo;`
Expected: `entra` ~R$252k (caixa de Maio), `sai` ~R$286k.

- [ ] **Step 4: Commit**

```bash
git add sync/financeiro-sync.js
git commit -m "feat(financeiro): sync list_summary com categorização e reconciliação"
```

---

## Grupo D — Rotas & Backfill

### Task 12: Middleware + rotas de leitura (DRE, lançamentos, a-categorizar)

**Files:**
- Modify: `server.js` (adicionar bloco de rotas `/api/financeiro/*` e middleware `requireFinanceiro`)

- [ ] **Step 1: Adicionar middleware e rotas de leitura**

Localizar onde os outros `requireRole` são definidos e adicionar:
```js
const requireFinanceiro = requireRole('financeiro', 'admin', 'mod_financeiro');
```
Adicionar bloco de rotas (perto dos demais `app.get('/api/...')`):
```js
const { montarDRE } = require('./lib/financeiro/dre');

// DRE do período
app.get('/api/financeiro/dre', requireAuth, requireFinanceiro, async (req, res) => {
  const { from, to } = req.query;
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from || '') || !re.test(to || '') || from > to) return res.status(400).json({ error: 'periodo invalido' });
  const { data, error } = await supabase.from('fin_lancamentos')
    .select('fluxo,valor,receita_sub,conta_id,fin_contas(codigo,nome)')
    .eq('ativo', true).gte('data', from).lte('data', to);
  if (error) return res.status(500).json({ error: error.message });
  const lancs = (data || []).map(l => ({ fluxo: l.fluxo, valor: Number(l.valor), conta_codigo: l.fin_contas?.codigo, receita_sub: l.receita_sub }));
  res.json(montarDRE(lancs));
});

// Lançamentos filtráveis
app.get('/api/financeiro/lancamentos', requireAuth, requireFinanceiro, async (req, res) => {
  const { from, to, empresa, conta_id, fluxo, incluir_inativos } = req.query;
  let q = supabase.from('fin_lancamentos').select('*, fin_contas(codigo,nome)').order('data', { ascending: false }).limit(2000);
  if (from) q = q.gte('data', from);
  if (to) q = q.lte('data', to);
  if (empresa) q = q.eq('empresa', empresa);
  if (conta_id) q = q.eq('conta_id', conta_id);
  if (fluxo) q = q.eq('fluxo', fluxo);
  if (incluir_inativos !== '1') q = q.eq('ativo', true);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Fila "A categorizar" (despesas sem conta)
app.get('/api/financeiro/a-categorizar', requireAuth, requireFinanceiro, async (req, res) => {
  const { data, error } = await supabase.from('fin_lancamentos')
    .select('*').eq('ativo', true).eq('fluxo', 'sai').is('conta_id', null).order('valor', { ascending: false }).limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});
```

- [ ] **Step 2: Verificar (smoke)**

Subir o server local (`npm start`) e, autenticado, chamar `GET /api/financeiro/dre?from=2026-05-01&to=2026-05-31`.
Expected: JSON com `receita`, `grupos[]`, `resultado`.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(financeiro): rotas de leitura DRE/lançamentos/a-categorizar"
```

---

### Task 13: Rotas de classificação + cadastros

**Files:**
- Modify: `server.js`
- Create: `lib/financeiro/reclassificar.js` + `lib/financeiro/reclassificar.test.js`

- [ ] **Step 1: Teste da função de alcance de reclassificação**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { alvosDaRegra } = require('./reclassificar');

test('alvosDaRegra acha lançamentos compatíveis sem override', () => {
  const lancs = [
    { id: 1, descricao: 'Pagamento de Conta: Pagamento Amanda - MAR', override_manual: false },
    { id: 2, descricao: 'Pagamento de Conta: Pagamento Amanda - PF', override_manual: false },
    { id: 3, descricao: 'Pagamento de Conta: Pagamento Amanda - AMA', override_manual: true },
  ];
  const ids = alvosDaRegra(lancs, { metodo: 'pessoa', padrao: 'Amanda' }).map(l => l.id);
  assert.deepEqual(ids, [1, 2]); // exclui o override
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/financeiro/reclassificar.test.js`
Expected: FAIL.

- [ ] **Step 3: Implementar `reclassificar.js`**

```js
const { nucleo, deacc } = require('./normalizar');

// Dado um conjunto de lançamentos e uma regra, retorna os que ela deveria classificar
// (ignorando os override_manual).
function alvosDaRegra(lancs, regra) {
  const p = deacc(regra.padrao).toLowerCase();
  return lancs.filter(l => {
    if (l.override_manual) return false;
    const nuc = nucleo(l.descricao);
    if (regra.metodo === 'exato') return nuc === p;
    return new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(nuc);
  });
}

module.exports = { alvosDaRegra };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/financeiro/reclassificar.test.js`
Expected: PASS.

- [ ] **Step 5: Adicionar rotas de classificação e cadastros em server.js**

```js
const { alvosDaRegra } = require('./lib/financeiro/reclassificar');

// Classificar 1 lançamento. body: { conta_id, alcance: 'so_esta'|'todas', metodo, padrao, papel }
app.post('/api/financeiro/lancamentos/:id/classificar', requireAuth, requireFinanceiro, async (req, res) => {
  const { conta_id, alcance, metodo, padrao } = req.body || {};
  if (!conta_id) return res.status(400).json({ error: 'conta_id obrigatório' });
  // a linha sempre recebe a conta + override_manual=true se "só esta"
  await supabase.from('fin_lancamentos').update({
    conta_id, classificacao_metodo: 'manual', override_manual: alcance === 'so_esta',
  }).eq('id', req.params.id);

  if (alcance === 'todas') {
    // cria regra e reclassifica retroativo
    await supabase.from('fin_regras').upsert(
      { metodo: metodo || 'exato', padrao, conta_id, origem: 'manual', criado_por: req.user?.id },
      { onConflict: 'metodo,padrao' });
    const { data: cands } = await supabase.from('fin_lancamentos')
      .select('id,descricao,override_manual').eq('fluxo', 'sai').or('conta_id.is.null,override_manual.eq.false');
    const alvos = alvosDaRegra(cands || [], { metodo: metodo || 'exato', padrao });
    if (alvos.length) {
      await supabase.from('fin_lancamentos').update({ conta_id, classificacao_metodo: metodo === 'pessoa' ? 'pessoa' : 'regra' })
        .in('id', alvos.map(a => a.id)).eq('override_manual', false);
    }
  }
  res.json({ ok: true });
});

// CRUD simples de cadastros
for (const tabela of ['fin_contas', 'fin_regras', 'fin_pessoas']) {
  app.get(`/api/financeiro/${tabela.replace('fin_', '')}`, requireAuth, requireFinanceiro, async (req, res) => {
    const { data, error } = await supabase.from(tabela).select('*').order('id');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });
  app.post(`/api/financeiro/${tabela.replace('fin_', '')}`, requireAuth, requireFinanceiro, async (req, res) => {
    const { data, error } = await supabase.from(tabela).insert(req.body).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });
  app.patch(`/api/financeiro/${tabela.replace('fin_', '')}/:id`, requireAuth, requireFinanceiro, async (req, res) => {
    const { data, error } = await supabase.from(tabela).update(req.body).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });
}
```

- [ ] **Step 6: Commit**

```bash
git add server.js lib/financeiro/reclassificar.js lib/financeiro/reclassificar.test.js
git commit -m "feat(financeiro): classificação manual, regras retroativas e cadastros"
```

---

### Task 14: Backfill + validação (campo de data, multi-empresa)

**Files:**
- Create: `scripts/backfill-financeiro.js`

- [ ] **Step 1: Implementar backfill por ano com validação**

```js
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { syncPeriodo } = require('../sync/financeiro-sync');

// Backfill em ordem 2026 → 2025 → 2024, mês a mês (1 req/mês respeita o rate limit).
async function backfillAno(ano) {
  for (let m = 1; m <= 12; m++) {
    const from = `${ano}-${String(m).padStart(2,'0')}-01`;
    const to = new Date(ano, m, 0).toISOString().slice(0,10); // último dia do mês
    if (new Date(from) > new Date()) break;
    const r = await syncPeriodo(from, to);
    console.log(`[backfill ${from}~${to}]`, r);
  }
}

(async () => {
  const ano = Number(process.argv[2]) || 2026;
  await backfillAno(ano);
  console.log(`Backfill ${ano} concluído.`);
})();
```

- [ ] **Step 2: Rodar backfill 2026 e validar contra o cash_flow**

Run: `node scripts/backfill-financeiro.js 2026`
Depois, para cada mês, comparar `select sum(valor) from fin_lancamentos where fluxo='entra' and data between ...` com o `cash_flow.in` do mês.
**Experimento do campo de data:** se a receita não bater no centavo, alternar `PostDate`↔`Date` em `mapear-lancamento.js` e re-rodar; escolher o que reproduz o `cash_flow`.
Expected: receita de caixa = `cash_flow.in` no centavo; Convênio exato.

- [ ] **Step 3: Checkpoint multi-empresa**

`execute_sql`: `select empresa, count(*), sum(valor) from fin_lancamentos where fluxo='sai' group by empresa;`
Confirmar que AMA+MAR+PF aparecem; comparar total de receita do mês com o Excel consolidado (AMA+MAR+PF). Se faltar receita de MAR/PF, registrar para tratamento (chamada por `business_id` adicional).

- [ ] **Step 4: Validar a cascata de Março contra o Excel**

Chamar `GET /api/financeiro/dre?from=2026-03-01&to=2026-03-31` e comparar **cada linha** com `03.Março.2026.xlsx` (Planilha3). Critério: cada grupo dentro da tolerância; resultado ~R$117.302 (±R$30).
Expected: bate dentro da tolerância após cadastro de pessoas (Task 13 / cadastros).

- [ ] **Step 5: Backfill 2025 e 2024 + ativar subsplit**

Run: `node scripts/backfill-financeiro.js 2025 && node scripts/backfill-financeiro.js 2024`
Após completar, rodar a marcação Entrada/Parcelas (Task 9) sobre toda a receita particular e gravar `receita_sub`.

- [ ] **Step 6: Commit**

```bash
git add scripts/backfill-financeiro.js
git commit -m "feat(financeiro): backfill 2026-2024 com validação"
```

---

## Grupo E — Frontend

### Task 15: Página DRE + api.js + registro do módulo

**Files:**
- Create: `public/financeiro/index.html`, `public/js/financeiro/api.js`
- Modify: `public/index.html` (nav), `public/js/shared-nav.js`, `server.js` (middleware já feito na Task 12)

- [ ] **Step 1: Criar `public/js/financeiro/api.js`** (padrão do projeto, ver `public/js/pacientes/api.js`)

```js
let _token = null;
function getToken() {
  if (_token) return _token;
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
      try { _token = JSON.parse(localStorage.getItem(k))?.access_token; } catch {}
    }
  }
  return _token;
}
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken(), ...(opts.headers || {}) } });
  if (r.status === 401) _token = null;
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
  return r.json();
}
window.FinAPI = {
  dre: (from, to) => api(`/api/financeiro/dre?from=${from}&to=${to}`),
  lancamentos: (q={}) => api('/api/financeiro/lancamentos?' + new URLSearchParams(q)),
  aCategorizar: () => api('/api/financeiro/a-categorizar'),
  classificar: (id, body) => api(`/api/financeiro/lancamentos/${id}/classificar`, { method: 'POST', body: JSON.stringify(body) }),
  contas: () => api('/api/financeiro/contas'),
  pessoas: () => api('/api/financeiro/pessoas'),
  criarPessoa: (b) => api('/api/financeiro/pessoas', { method: 'POST', body: JSON.stringify(b) }),
};
```

- [ ] **Step 2: Criar `public/financeiro/index.html`** (DRE em cascata)

Página com: seletor de período (default mês corrente), botão "Atualizar dados", tabela da cascata renderizando `dre.grupos[]` (cada grupo com seu total e contas; receita positiva, despesa negativa, resultado no rodapé), link para "A categorizar" e "Cadastros". Incluir `<script src="/js/shared-nav.js" data-active="financeiro"></script>` e `<script src="/js/financeiro/api.js"></script>`. Renderização:
```html
<div id="dre"></div>
<script>
async function carregar() {
  const hoje = new Date(); const ym = hoje.toISOString().slice(0,7);
  const from = ym + '-01'; const to = new Date(hoje.getFullYear(), hoje.getMonth()+1, 0).toISOString().slice(0,10);
  const dre = await FinAPI.dre(from, to);
  const fmt = v => v.toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
  let html = `<table><tbody>`;
  for (const g of dre.grupos) {
    html += `<tr class="grupo"><td><b>${g.titulo}</b></td><td><b>${fmt(g.total)}</b></td></tr>`;
    for (const c of g.contas) html += `<tr><td style="padding-left:24px">${c.codigo} ${c.nome}</td><td>${fmt(c.total)}</td></tr>`;
  }
  html += `<tr class="resultado"><td><b>RESULTADO</b></td><td><b>${fmt(dre.resultado)}</b></td></tr></tbody></table>`;
  document.getElementById('dre').innerHTML = html;
}
carregar();
</script>
```

- [ ] **Step 3: Registrar o módulo (checklist `AGENTS.md`)**

1. `public/index.html`: adicionar link nav antes de "Usuários":
```html
<a class="nav-btn" href="/financeiro/" data-roles="financeiro,mod_financeiro">
  <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg>
  Financeiro
</a>
```
2. `public/index.html` (módulo Usuários): checkbox em Módulos Extras `id="nu-mod-financeiro"`; `_ROLE_LABELS.mod_financeiro = 'Financeiro'`; em `criarUsuario()` push `mod_financeiro` se marcado.
3. `public/js/shared-nav.js`: adicionar entrada do link Financeiro (mesmo `data-active="financeiro"`).
4. `server.js`: `requireFinanceiro` já criado (Task 12) com `mod_financeiro`.

- [ ] **Step 4: Verificar no navegador**

`npm start`, logar como admin, abrir `/financeiro/`. Conferir que a DRE do mês renderiza e a sidebar aparece.
Expected: cascata 1→7 com resultado; link visível no nav.

- [ ] **Step 5: Commit**

```bash
git add public/financeiro/index.html public/js/financeiro/api.js public/index.html public/js/shared-nav.js
git commit -m "feat(financeiro): página DRE + registro do módulo"
```

---

### Task 16: Página "A categorizar"

**Files:**
- Create: `public/financeiro/a-categorizar.html`

- [ ] **Step 1: Criar a página**

Lista os lançamentos de `FinAPI.aCategorizar()`. Cada linha mostra descrição + valor + select de conta (de `FinAPI.contas()`) + dois botões: **"Só esta"** e **"Todas iguais"**. Ao clicar, chama `FinAPI.classificar(id, { conta_id, alcance, metodo:'exato', padrao:<núcleo da descrição> })` e remove a linha da lista. Incluir shared-nav (`data-active="financeiro"`) e `api.js`. Núcleo calculado no front por uma cópia mínima de `nucleo()` ou enviando a descrição crua e deixando o servidor derivar (preferir: servidor deriva o `padrao` a partir da descrição na rota da Task 13 quando `padrao` vier vazio).

- [ ] **Step 2: Ajuste no servidor para derivar `padrao`**

Em `server.js`, na rota `/classificar`, se `alcance==='todas'` e `padrao` vazio, derivar com `require('./lib/financeiro/normalizar').nucleo(descricaoDoLancamento)`.

- [ ] **Step 3: Verificar no navegador**

Abrir `/financeiro/a-categorizar.html`, classificar um item com "Todas iguais", confirmar que some da fila e que outros iguais também somem (reclassificação retroativa).
Expected: fila diminui; DRE reflete.

- [ ] **Step 4: Commit**

```bash
git add public/financeiro/a-categorizar.html server.js
git commit -m "feat(financeiro): página A categorizar com reclassificação retroativa"
```

---

### Task 17: Páginas Lançamentos e Cadastros

**Files:**
- Create: `public/financeiro/lancamentos.html`, `public/financeiro/cadastros.html`

- [ ] **Step 1: Página Lançamentos**

Tabela de `FinAPI.lancamentos(filtros)` com filtros (período, empresa, conta, fluxo, incluir inativos). Cada linha tem botão "trocar categoria" → modal com select de conta + escolha "só esta"/"todas iguais" → `FinAPI.classificar`. Shared-nav + api.js.

- [ ] **Step 2: Página Cadastros**

Três abas: **Plano de contas** (lista/edita `fin_contas`), **Regras** (lista/edita `fin_regras`), **Pessoas** (CRUD `fin_pessoas` com nome/papel/conta — usado pela camada 2 do motor). Shared-nav + api.js.

- [ ] **Step 3: Verificar no navegador**

Abrir ambas, cadastrar uma pessoa (ex.: "Fernanda" → 3.2.2), re-rodar sync de um mês e confirmar que os "Pagamento Fernanda" caem em 3.2.2.
Expected: cadastro de pessoa reflete na categorização.

- [ ] **Step 4: Commit**

```bash
git add public/financeiro/lancamentos.html public/financeiro/cadastros.html
git commit -m "feat(financeiro): páginas Lançamentos e Cadastros"
```

---

### Task 18: Sync agendado + botão "Atualizar dados"

**Files:**
- Modify: `server.js` (hook no `setInterval` existente + endpoint manual)

- [ ] **Step 1: Endpoint de sync manual**

```js
const { syncPeriodo } = require('./sync/financeiro-sync');
app.post('/api/financeiro/sync', requireAuth, requireFinanceiro, async (req, res) => {
  const hoje = new Date();
  const from = hoje.toISOString().slice(0,8) + '01';
  const to = hoje.toISOString().slice(0,10);
  try { res.json(await syncPeriodo(from, to)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 2: Hook no agendador existente**

Localizar o `setInterval(...)` em `server.js` (linha ~151) usado pelos syncs e adicionar a chamada diária do `syncPeriodo` do mês corrente (try/catch, sem derrubar). Não criar scheduler novo.

- [ ] **Step 3: Ligar o botão "Atualizar dados" da DRE**

Em `public/financeiro/index.html`, o botão chama `await FinAPI.sync()` (adicionar `sync: () => api('/api/financeiro/sync', { method:'POST' })` ao `FinAPI`) e recarrega a DRE.

- [ ] **Step 4: Verificar**

Clicar "Atualizar dados", ver o toast de sucesso e a DRE recarregar.
Expected: sync roda e atualiza.

- [ ] **Step 5: Commit + deploy**

```bash
git add server.js public/financeiro/index.html public/js/financeiro/api.js
git commit -m "feat(financeiro): sync agendado e manual"
```
Deploy (ver `AGENTS.md`): `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`

---

## Self-Review (cobertura do spec)

- §2 Arquitetura → Tasks 1–18 (lib pura + sync + rotas + UI). ✓
- §3 Semântica (despesa/receita/data-fuso/estorno/subsplit) → Tasks 5, 6, 9, 14. ✓
- §4 Modelo de dados (5 tabelas, campos) → Task 1. ✓
- §5 Plano de contas → Tasks 2, 3. ✓
- §6 Motor 3 camadas (ordem exato→pessoa→keyword, limiar, override, retroativo) → Tasks 7, 13. ✓
- §7 Empresas (sufixo) → Task 4 (extração) + 14 (checkpoint). ✓
- §8 Telas (DRE, A categorizar, Lançamentos, Cadastros) + registro módulo → Tasks 15–17. ✓
- §9 Sync (agendado+manual, idempotência, reconciliação, backfill) → Tasks 11, 14, 18. ✓
- §10 Erros/segurança/aceite por linha + multi-empresa → Tasks 12 (RLS/role), 14 (validação). ✓
- §11 Fora de escopo (F2/F3) → não implementado (correto).
- §12 Decisões (juros em Particular, backfill, subsplit pós-backfill) → Tasks 6, 9, 14. ✓

**Em aberto (do spec, conscientes):** caso da entrada parcelada no cartão (ajuste manual via override até resolver); valor exato do limiar keyword e campo de data (calibrados na Task 14). **RLS policies:** Task 1 habilita RLS mas as policies por role devem seguir o padrão das outras tabelas do projeto (conferir uma tabela existente e replicar na migração antes do deploy).
