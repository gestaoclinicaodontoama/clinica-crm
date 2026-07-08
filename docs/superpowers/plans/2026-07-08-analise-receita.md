# Análise de Receita — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Página `/financeiro/receita/` que separa o caixa em Entrada nova (parcela 0) × Base recorrente (parcelas 1+), com réguas da DRE, meta do mês editável, colchão e rumo ao degrau.

**Architecture:** Funções puras em `lib/financeiro/receita-motor.js` rodam 1x/dia dentro do `fetchInadimplentesBackground` (mesmos itens do `/payment/list`, zero chamada extra) e gravam JSON em `fin_receita_analises`. `GET /api/analise-receita` junta esse JSON com a meta do mês (`fin_receita_metas`), ticket e dias úteis. Página vanilla + Chart.js lê tudo de uma vez.

**Tech Stack:** Node/Express, Supabase (service_role no servidor), Chart.js 4.4.3 (CDN, já usado na Saúde), node:test.

**Spec:** `docs/superpowers/specs/2026-07-08-analise-receita-design.md`

## Global Constraints

- **Sem sigla financeira na UI** (regra do Luiz): nada de PE/MC/ROI — tudo por extenso, com "▸ entenda" por bloco.
- **RLS ligada em TODA tabela nova, sem policy** (só service_role acessa) — CLAUDE.md.
- Supabase client trunca em 1000 linhas — queries de `orcamentos` aqui são ~200 linhas/6m (ok), não aumentar janela sem agregar em SQL.
- Nunca `.catch()` direto no builder Supabase — try/catch no `await`.
- Menu SÓ via `CRM_NAV` em `public/js/nav-config.js`.
- Roles da página: `admin,gestor` (`requireGestor` já existe, server.js:418). Sem role `mod_` nova.
- Datas: comparar strings ISO via `slice(0,10)` / `slice(0,7)` (padrão dos módulos financeiros).
- Commits: mensagem `feat(receita): …` + rodapé Co-Authored-By padrão da sessão.
- Trabalho na `main` (working dir concorrente: commits pequenos e frequentes; se o push divergir, isolar em branch de origin/main — nunca forçar).

---

### Task 1: Migração — `fin_receita_analises` + `fin_receita_metas`

**Files:**
- Create: `supabase/migrations/20260708120000_analise_receita.sql`

**Interfaces:**
- Produces: tabela `fin_receita_analises (id int PK, dados jsonb, atualizado_em timestamptz)` e `fin_receita_metas (mes date PK, lucro_alvo numeric, atualizado_em timestamptz)`, ambas com RLS ligada e sem policy.

- [ ] **Step 1: Escrever a migração**

```sql
-- Análise de Receita (entrada nova × base recorrente) — spec 2026-07-08.
-- fin_receita_analises: 1 linha JSON sobrescrita pelo job diário (padrão fin_saude_analises).
-- fin_receita_metas: lucro-alvo editável por mês (página Análise de Receita).
create table if not exists public.fin_receita_analises (
  id int primary key,
  dados jsonb not null,
  atualizado_em timestamptz not null default now()
);
alter table public.fin_receita_analises enable row level security;

create table if not exists public.fin_receita_metas (
  mes date primary key,
  lucro_alvo numeric not null check (lucro_alvo >= 0),
  atualizado_em timestamptz not null default now()
);
alter table public.fin_receita_metas enable row level security;
-- Sem policies de propósito: só o servidor (service_role) lê/escreve.
```

- [ ] **Step 2: Aplicar no projeto `mtqdpjhhqzvuklnlfpvi` via MCP Supabase**

`mcp__plugin_supabase_supabase__apply_migration` com `name: "analise_receita"` e o SQL acima.

- [ ] **Step 3: Verificar**

`mcp__plugin_supabase_supabase__list_migrations` → migração listada; `list_tables` → as 2 tabelas com `rls_enabled: true`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260708120000_analise_receita.sql
git commit -m "feat(receita): tabelas fin_receita_analises + fin_receita_metas (RLS, sem policy)"
```

---

### Task 2: Motor parte 1 — decomposição, taxa de realização, realização por mês

**Files:**
- Create: `lib/financeiro/receita-motor.js`
- Test: `lib/financeiro/receita-motor.test.js`

**Interfaces:**
- Consumes: itens crus do `/payment/list` (campos `InstallmentNumber`, `ReceivedDate`, `DueDate`, `PaymentReceived`, `Canceled`, `PaymentForm`, `AmountWithDiscounts|Amount|TotalPostAmount`).
- Produces (module.exports):
  - `decomposicao12m(items, hojeISO, nMeses=12)` → `[{ mes:'YYYY-MM', entrada:number, recorrente:number }]` (inclui mês corrente parcial)
  - `taxaRealizacao(items, hojeISO, nMeses=6)` → `{ geral:{taxa,base,realizado}, 'Boleto':{...}, 'Cartão de Crédito':{...}, outras:{...} }` (taxa `null` se base 0)
  - `realizacaoPorMes(items, hojeISO, nMeses=6)` → `[{ mes, boleto, cartao, outras }]` (frações 0–1 ou null)

- [ ] **Step 1: Escrever os testes (falhando)**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('./receita-motor');

const HOJE = '2026-07-08';

test('decomposicao12m: entrada = parcela 0, recorrente = 1+, cancelada fora, sem nº → recorrente', () => {
  const items = [
    { InstallmentNumber: 0, ReceivedDate: '2026-06-10', Amount: 100 },
    { InstallmentNumber: 1, ReceivedDate: '2026-06-15T03:00:00Z', Amount: 50 },
    { InstallmentNumber: 2, ReceivedDate: '2026-06-20', Amount: 25, Canceled: 'X' }, // fora
    { ReceivedDate: '2026-06-21', Amount: 7 },                    // sem nº → recorrente
    { InstallmentNumber: 0, DueDate: '2026-06-05', Amount: 999 }, // não recebida — fora
    { InstallmentNumber: 0, ReceivedDate: '2026-07-01', Amount: 30 },
  ];
  const r = M.decomposicao12m(items, HOJE, 3);
  assert.deepEqual(r.map(x => x.mes), ['2026-05', '2026-06', '2026-07']);
  assert.deepEqual(r[1], { mes: '2026-06', entrada: 100, recorrente: 57 });
  assert.deepEqual(r[2], { mes: '2026-07', entrada: 30, recorrente: 0 });
});

test('taxaRealizacao: só parcelas 1+ de meses fechados; pagou no próprio mês = realizada', () => {
  const items = [
    { InstallmentNumber: 1, DueDate: '2026-06-10', ReceivedDate: '2026-06-12', Amount: 80, PaymentForm: 'Boleto' },  // realizada
    { InstallmentNumber: 2, DueDate: '2026-06-10', ReceivedDate: '2026-07-02', Amount: 20, PaymentForm: 'Boleto' },  // atrasada → não realizada
    { InstallmentNumber: 3, DueDate: '2026-05-10', Amount: 100, PaymentForm: 'Cartão de Crédito' },                  // nunca paga
    { InstallmentNumber: 0, DueDate: '2026-06-10', ReceivedDate: '2026-06-10', Amount: 999 },                        // entrada — fora
    { InstallmentNumber: 1, DueDate: '2026-07-05', ReceivedDate: '2026-07-06', Amount: 999 },                        // mês corrente — fora
  ];
  const r = M.taxaRealizacao(items, HOJE, 6);
  assert.equal(r.geral.base, 200);
  assert.equal(r.geral.realizado, 80);
  assert.equal(r.geral.taxa, 0.4);
  assert.equal(r['Boleto'].taxa, 0.8);
  assert.equal(r['Cartão de Crédito'].taxa, 0);
  assert.equal(r.outras.taxa, null);
});

test('realizacaoPorMes: fração por forma, mês sem base → null', () => {
  const items = [
    { InstallmentNumber: 1, DueDate: '2026-06-10', ReceivedDate: '2026-06-12', Amount: 75, PaymentForm: 'Boleto' },
    { InstallmentNumber: 2, DueDate: '2026-06-15', Amount: 25, PaymentForm: 'Boleto' },
  ];
  const r = M.realizacaoPorMes(items, HOJE, 2);
  assert.deepEqual(r.map(x => x.mes), ['2026-05', '2026-06']);
  assert.equal(r[1].boleto, 0.75);
  assert.equal(r[1].cartao, null);
  assert.equal(r[0].boleto, null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/financeiro/receita-motor.test.js`
Expected: FAIL — `Cannot find module './receita-motor'`

- [ ] **Step 3: Implementar**

```js
// Motor da Análise de Receita: separa o caixa recebido em ENTRADA NOVA
// (1ª parcela do contrato, InstallmentNumber 0) × BASE RECORRENTE (parcelas 1+)
// e deriva réguas, meta e colchão. Funções puras sobre os itens crus do
// /payment/list; datas podem vir com hora — tudo normalizado com slice.
// Convênio não passa pelo /payment/list — tudo aqui é particular.
const dia = (s) => (s || '').slice(0, 10);
const ym = (s) => dia(s).slice(0, 7);
const recebida = (it) => it.PaymentReceived === 'X' ||
  !!(it.ReceivedDate && dia(it.ReceivedDate) !== '' && dia(it.ReceivedDate) !== '0001-01-01');
const valor = (it) => Number(it.AmountWithDiscounts || it.Amount || it.TotalPostAmount) || 0;
const cancelada = (it) => it.Canceled === 'X' || it.Canceled === true;
// Entrada = parcela 0. Sem número de parcela → recorrente (conservador:
// nunca superestimar o dinheiro novo).
const ehEntrada = (it) => Number(it.InstallmentNumber) === 0;
const arred = (v) => Math.round(v * 100) / 100;
const FORMAS = ['Boleto', 'Cartão de Crédito'];
const formaDe = (it) => FORMAS.includes(it.PaymentForm) ? it.PaymentForm : 'outras';

// ['YYYY-MM', ...] do mais antigo ao mês corrente (n itens).
function mesesAtras(hojeISO, n) {
  let [y, m] = hojeISO.slice(0, 7).split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    let mm = m - i, yy = y;
    while (mm < 1) { mm += 12; yy--; }
    out.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  return out;
}

// Recebido por mês de ReceivedDate, separado entrada × recorrente.
// Inclui o mês corrente (parcial). Canceladas fora.
function decomposicao12m(items, hojeISO, nMeses = 12) {
  const ordem = mesesAtras(hojeISO, nMeses);
  const porMes = new Map(ordem.map(k => [k, { entrada: 0, recorrente: 0 }]));
  for (const it of (items || [])) {
    if (cancelada(it) || !recebida(it)) continue;
    const x = porMes.get(ym(it.ReceivedDate));
    if (!x) continue;
    if (ehEntrada(it)) x.entrada += valor(it); else x.recorrente += valor(it);
  }
  return ordem.map(k => { const x = porMes.get(k);
    return { mes: k, entrada: arred(x.entrada), recorrente: arred(x.recorrente) }; });
}

// Dos últimos N meses FECHADOS: do que venceu de parcela 1+, quanto caiu
// DENTRO do próprio mês (pagou atrasado = recuperação, não realização).
function taxaRealizacao(items, hojeISO, nMeses = 6) {
  const fechados = new Set(mesesAtras(hojeISO, nMeses + 1).slice(0, nMeses));
  const acc = { geral: { base: 0, realizado: 0 } };
  for (const f of [...FORMAS, 'outras']) acc[f] = { base: 0, realizado: 0 };
  for (const it of (items || [])) {
    if (cancelada(it) || ehEntrada(it)) continue;
    const mDue = ym(it.DueDate);
    if (!fechados.has(mDue)) continue;
    const v = valor(it);
    const ok = recebida(it) && ym(it.ReceivedDate) === mDue;
    for (const k of ['geral', formaDe(it)]) {
      acc[k].base += v;
      if (ok) acc[k].realizado += v;
    }
  }
  const out = {};
  for (const k of Object.keys(acc)) out[k] = {
    taxa: acc[k].base ? Math.round(acc[k].realizado / acc[k].base * 1000) / 1000 : null,
    base: arred(acc[k].base), realizado: arred(acc[k].realizado),
  };
  return out;
}

// Realização mês a mês (últimos N fechados), por forma. Fração 0–1 ou null.
function realizacaoPorMes(items, hojeISO, nMeses = 6) {
  const ordem = mesesAtras(hojeISO, nMeses + 1).slice(0, nMeses);
  const acc = new Map(ordem.map(k => [k,
    { Boleto: { b: 0, r: 0 }, 'Cartão de Crédito': { b: 0, r: 0 }, outras: { b: 0, r: 0 } }]));
  for (const it of (items || [])) {
    if (cancelada(it) || ehEntrada(it)) continue;
    const x = acc.get(ym(it.DueDate));
    if (!x) continue;
    const f = x[formaDe(it)];
    f.b += valor(it);
    if (recebida(it) && ym(it.ReceivedDate) === ym(it.DueDate)) f.r += valor(it);
  }
  const pct = (f) => f.b ? Math.round(f.r / f.b * 1000) / 1000 : null;
  return ordem.map(k => { const x = acc.get(k);
    return { mes: k, boleto: pct(x.Boleto), cartao: pct(x['Cartão de Crédito']), outras: pct(x.outras) }; });
}

module.exports = { decomposicao12m, taxaRealizacao, realizacaoPorMes,
  _interno: { mesesAtras, formaDe, ehEntrada, recebida, valor, cancelada, arred, dia, ym } };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/financeiro/receita-motor.test.js`
Expected: 3 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add lib/financeiro/receita-motor.js lib/financeiro/receita-motor.test.js
git commit -m "feat(receita): motor — decomposição entrada×recorrente + taxa de realização"
```

---

### Task 3: Motor parte 2 — mês corrente e colchão

**Files:**
- Modify: `lib/financeiro/receita-motor.js` (adicionar funções + exports)
- Test: `lib/financeiro/receita-motor.test.js` (adicionar testes)

**Interfaces:**
- Consumes: `taxaRealizacao` (Task 2) — objeto `realizacao` com `.geral.taxa` e por forma.
- Produces:
  - `mesCorrente(items, hojeISO, realizacao)` → `{ recorrenteCru, recorrentePrevisto, recorrenteRecebido, entradaRecebida }`
  - `colchao(items, hojeISO, taxaGeral, reguaFixas, nMeses=24)` → `{ meses:[{mes,cru,previsto}], mesesCobertos:number|null }`

- [ ] **Step 1: Adicionar testes (falhando)**

```js
test('mesCorrente: previsto = a vencer no mês × taxa da forma; recebidos separados', () => {
  const realizacao = { geral: { taxa: 0.5 }, 'Boleto': { taxa: 0.8 },
    'Cartão de Crédito': { taxa: null }, outras: { taxa: null } };
  const items = [
    { InstallmentNumber: 1, DueDate: '2026-07-20', Amount: 100, PaymentForm: 'Boleto' },       // 100×0.8
    { InstallmentNumber: 2, DueDate: '2026-07-25', Amount: 100, PaymentForm: 'Pix' },          // outras null → geral 0.5
    { InstallmentNumber: 1, DueDate: '2026-07-05', ReceivedDate: '2026-07-05', Amount: 40, PaymentForm: 'Boleto' }, // vencida no mês E recebida: cru + recebido
    { InstallmentNumber: 0, ReceivedDate: '2026-07-03', Amount: 70 },                          // entrada recebida
    { InstallmentNumber: 1, DueDate: '2026-08-10', Amount: 999 },                              // mês seguinte — fora
    { InstallmentNumber: 1, DueDate: '2026-07-10', Amount: 999, Canceled: 'X' },               // cancelada — fora
  ];
  const r = M.mesCorrente(items, HOJE, realizacao);
  assert.equal(r.recorrenteCru, 240);                 // 100+100+40
  assert.equal(r.recorrentePrevisto, 100 * 0.8 + 100 * 0.5 + 40 * 0.8);
  assert.equal(r.recorrenteRecebido, 40);
  assert.equal(r.entradaRecebida, 70);
});

test('colchao: só parcelas 1+ futuras não recebidas, a partir do mês seguinte, × taxa', () => {
  const items = [
    { InstallmentNumber: 1, DueDate: '2026-08-10', Amount: 200 },
    { InstallmentNumber: 2, DueDate: '2026-09-10', Amount: 200 },
    { InstallmentNumber: 3, DueDate: '2026-10-10', Amount: 50 },
    { InstallmentNumber: 0, DueDate: '2026-08-15', Amount: 999 },                              // entrada futura — fora
    { InstallmentNumber: 1, DueDate: '2026-08-20', ReceivedDate: '2026-07-01', Amount: 999 },  // já recebida — fora
    { InstallmentNumber: 1, DueDate: '2026-07-20', Amount: 999 },                              // mês corrente — fora
  ];
  const r = M.colchao(items, HOJE, 0.5, 90, 3);
  assert.deepEqual(r.meses, [
    { mes: '2026-08', cru: 200, previsto: 100 },
    { mes: '2026-09', cru: 200, previsto: 100 },
    { mes: '2026-10', cru: 50, previsto: 25 },
  ]);
  assert.equal(r.mesesCobertos, 2);                   // ago e set ≥ 90; out não
});

test('colchao: sem régua → mesesCobertos null', () => {
  assert.equal(M.colchao([], HOJE, 0.5, null, 2).mesesCobertos, null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/financeiro/receita-motor.test.js`
Expected: FAIL — `M.mesCorrente is not a function`

- [ ] **Step 3: Implementar (adicionar antes do module.exports; incluir as 2 funções no exports)**

```js
// Retrato do mês corrente: recorrente a vencer (cru), previsto (cru × taxa
// da forma, cai pra geral e depois 1 se não houver histórico) e já recebidos.
function mesCorrente(items, hojeISO, realizacao) {
  const mesAtual = hojeISO.slice(0, 7);
  const out = { recorrenteCru: 0, recorrentePrevisto: 0, recorrenteRecebido: 0, entradaRecebida: 0 };
  for (const it of (items || [])) {
    if (cancelada(it)) continue;
    if (recebida(it) && ym(it.ReceivedDate) === mesAtual) {
      if (ehEntrada(it)) out.entradaRecebida += valor(it);
      else out.recorrenteRecebido += valor(it);
    }
    if (!ehEntrada(it) && ym(it.DueDate) === mesAtual) {
      const v = valor(it);
      out.recorrenteCru += v;
      const t = realizacao?.[formaDe(it)]?.taxa ?? realizacao?.geral?.taxa ?? 1;
      out.recorrentePrevisto += v * (t == null ? 1 : t);
    }
  }
  for (const k of Object.keys(out)) out[k] = arred(out[k]);
  return out;
}

// Se parar de vender hoje: recorrente já contratado a vencer nos próximos
// nMeses (a partir do mês SEGUINTE), ajustado pela taxa geral de realização.
// mesesCobertos = meses CONSECUTIVOS com previsto ≥ régua das fixas.
function colchao(items, hojeISO, taxaGeral, reguaFixas, nMeses = 24) {
  let [y, m] = hojeISO.slice(0, 7).split('-').map(Number);
  const ordem = [];
  for (let i = 1; i <= nMeses; i++) {
    let mm = m + i, yy = y;
    while (mm > 12) { mm -= 12; yy++; }
    ordem.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  const porMes = new Map(ordem.map(k => [k, 0]));
  for (const it of (items || [])) {
    if (cancelada(it) || ehEntrada(it) || recebida(it)) continue;
    const k = ym(it.DueDate);
    if (porMes.has(k)) porMes.set(k, porMes.get(k) + valor(it));
  }
  const t = taxaGeral == null ? 1 : taxaGeral;
  const meses = ordem.map(k => ({ mes: k, cru: arred(porMes.get(k)), previsto: arred(porMes.get(k) * t) }));
  let cobertos = 0;
  if (reguaFixas > 0) { for (const x of meses) { if (x.previsto >= reguaFixas) cobertos++; else break; } }
  return { meses, mesesCobertos: reguaFixas > 0 ? cobertos : null };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/financeiro/receita-motor.test.js`
Expected: 6 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add lib/financeiro/receita-motor.js lib/financeiro/receita-motor.test.js
git commit -m "feat(receita): motor — mês corrente (previsto/recebido) + colchão da carteira"
```

---

### Task 4: Motor parte 3 — rumo ao degrau, razão entrada÷venda, meta, dias úteis

**Files:**
- Modify: `lib/financeiro/receita-motor.js`
- Test: `lib/financeiro/receita-motor.test.js`

**Interfaces:**
- Consumes: `decomposicao12m` (Task 2).
- Produces:
  - `rumoAoDegrau(decomposicao, hojeISO, reguas)` → `{ tendencia:{a,b}, media3, fixas:{status,meses?,mesAlvo?}|null, total:{...}|null }` ou `{ erro }` (status: `'cruzou'|'a_caminho'|'nao_cruza'`)
  - `razaoEntradaVenda(decomposicao, vendasPorMes, hojeISO, nMeses=6)` → `{ razao|null, entrada, vendas }` (`vendasPorMes: [{mes,vendas}]`)
  - `metaDoMes({saidaTotalMedia, convenioMedio, recorrentePrevisto, entradaRecebida, lucroAlvo, razao, ticket})` → `{ empate:{metaEntrada,restante,vendasNecessarias,fechamentos,batida}, comLucro:{...}|null }` ou `{ erro }`
  - `diasUteisRestantes(hojeISO)` → number (seg–sex = 1, sábado = 0,5; de hoje inclusive ao fim do mês)

- [ ] **Step 1: Adicionar testes (falhando)**

```js
test('rumoAoDegrau: série crescente cruza a régua na data certa', () => {
  // recorrente fechado: 100, 110, ..., 150 (6 meses, +10/mês); corrente = 2026-07 (fora)
  const dec = [
    { mes: '2026-01', recorrente: 100, entrada: 0 }, { mes: '2026-02', recorrente: 110, entrada: 0 },
    { mes: '2026-03', recorrente: 120, entrada: 0 }, { mes: '2026-04', recorrente: 130, entrada: 0 },
    { mes: '2026-05', recorrente: 140, entrada: 0 }, { mes: '2026-06', recorrente: 150, entrada: 0 },
    { mes: '2026-07', recorrente: 5, entrada: 0 },
  ];
  const r = M.rumoAoDegrau(dec, HOJE, { fixas: 130, saidaTotal: 200 });
  assert.equal(r.fixas.status, 'cruzou');            // média últimos 3 = 140 ≥ 130
  assert.equal(r.total.status, 'a_caminho');         // reta 100+10x cruza 200 em x=10 → 5 meses após jun
  assert.equal(r.total.meses, 5);
  assert.equal(r.total.mesAlvo, '2026-11');
});

test('rumoAoDegrau: inclinação ≤ 0 abaixo da régua → nao_cruza; régua nula → null', () => {
  const dec = [
    { mes: '2026-04', recorrente: 100, entrada: 0 }, { mes: '2026-05', recorrente: 90, entrada: 0 },
    { mes: '2026-06', recorrente: 80, entrada: 0 },
  ];
  const r = M.rumoAoDegrau(dec, HOJE, { fixas: 500, saidaTotal: null });
  assert.equal(r.fixas.status, 'nao_cruza');
  assert.equal(r.total, null);
});

test('razaoEntradaVenda: Σ entrada ÷ Σ vendas nos meses fechados', () => {
  const dec = [
    { mes: '2026-05', entrada: 100, recorrente: 0 }, { mes: '2026-06', entrada: 200, recorrente: 0 },
    { mes: '2026-07', entrada: 999, recorrente: 0 },  // corrente — fora
  ];
  const vendas = [{ mes: '2026-05', vendas: 400 }, { mes: '2026-06', vendas: 600 }, { mes: '2026-07', vendas: 999 }];
  const r = M.razaoEntradaVenda(dec, vendas, HOJE, 6);
  assert.equal(r.razao, 0.3);                        // 300 / 1000
  assert.equal(M.razaoEntradaVenda(dec, [], HOJE).razao, null);
});

test('metaDoMes: empate e com lucro; batida quando restante zera', () => {
  const p = { saidaTotalMedia: 300, convenioMedio: 50, recorrentePrevisto: 150,
    entradaRecebida: 60, lucroAlvo: 40, razao: 0.5, ticket: 10 };
  const r = M.metaDoMes(p);
  assert.equal(r.empate.metaEntrada, 100);           // 300−50−150
  assert.equal(r.empate.restante, 40);               // 100−60
  assert.equal(r.empate.vendasNecessarias, 80);      // 40/0.5
  assert.equal(r.empate.fechamentos, 8);
  assert.equal(r.comLucro.metaEntrada, 140);
  assert.equal(M.metaDoMes({ ...p, entradaRecebida: 500 }).empate.batida, true);
  assert.deepEqual(M.metaDoMes({}), { erro: 'reguas indisponiveis' });
});

test('diasUteisRestantes: seg–sex 1, sábado 0,5, de hoje ao fim do mês', () => {
  // 2026-07-08 (qua) → 08–31/jul: 17 dias úteis seg–sex + 4 sábados (11,18,25) = 3×0,5… conferir:
  // qua08 qui09 sex10 =3; sem 13–17 =5; 20–24 =5; 27–31 =5 → 18; sáb 11,18,25 → +1,5 = 19,5
  assert.equal(M.diasUteisRestantes('2026-07-08'), 19.5);
  assert.equal(M.diasUteisRestantes('2026-07-31'), 1); // sexta
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/financeiro/receita-motor.test.js`
Expected: FAIL — `M.rumoAoDegrau is not a function`

- [ ] **Step 3: Implementar (adicionar + exportar)**

```js
// Regressão linear simples sobre o recorrente dos meses FECHADOS.
// Por régua: 'cruzou' (média dos últimos 3 fechados ≥ régua), 'a_caminho'
// (inclinação > 0 → meses até a reta cruzar, contados do último mês fechado)
// ou 'nao_cruza'. Régua nula/≤0 → null.
function rumoAoDegrau(decomposicao, hojeISO, reguas) {
  const mesAtual = hojeISO.slice(0, 7);
  const serie = (decomposicao || []).filter(d => d.mes < mesAtual).map(d => d.recorrente);
  const n = serie.length;
  if (n < 3) return { erro: 'historico insuficiente' };
  const mx = (n - 1) / 2, my = serie.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (i - mx) * (serie[i] - my); sxx += (i - mx) ** 2; }
  const b = sxy / sxx, a = my - b * mx;
  const media3 = serie.slice(-3).reduce((s, v) => s + v, 0) / Math.min(3, n);
  const alvo = (regua) => {
    if (!(regua > 0)) return null;
    if (media3 >= regua) return { status: 'cruzou' };
    if (b <= 0) return { status: 'nao_cruza' };
    const faltam = Math.max(1, Math.ceil((regua - a) / b - (n - 1))); // meses após o último fechado
    let [yy, mm] = mesAtual.split('-').map(Number);
    mm += faltam - 1; // último fechado = mês anterior ao corrente
    while (mm > 12) { mm -= 12; yy++; }
    return { status: 'a_caminho', meses: faltam, mesAlvo: `${yy}-${String(mm).padStart(2, '0')}` };
  };
  return { tendencia: { a: arred(a), b: arred(b) }, media3: arred(media3),
    fixas: alvo(reguas?.fixas), total: alvo(reguas?.saidaTotal) };
}

// Σ entrada recebida ÷ Σ vendas fechadas nos últimos N meses fechados.
function razaoEntradaVenda(decomposicao, vendasPorMes, hojeISO, nMeses = 6) {
  const mesAtual = hojeISO.slice(0, 7);
  const fechados = new Set((decomposicao || [])
    .filter(d => d.mes < mesAtual).map(d => d.mes).slice(-nMeses));
  const entrada = (decomposicao || []).filter(d => fechados.has(d.mes)).reduce((s, d) => s + d.entrada, 0);
  const vendas = (vendasPorMes || []).filter(v => fechados.has(v.mes)).reduce((s, v) => s + v.vendas, 0);
  return { razao: vendas > 0 ? Math.round(entrada / vendas * 1000) / 1000 : null,
    entrada: arred(entrada), vendas: arred(vendas) };
}

// Meta de entrada do mês corrente (tudo em R$ do mês). Sem régua → erro.
function metaDoMes(p) {
  const { saidaTotalMedia, convenioMedio, recorrentePrevisto, entradaRecebida,
    lucroAlvo, razao, ticket } = p || {};
  if (!(saidaTotalMedia > 0)) return { erro: 'reguas indisponiveis' };
  const base = saidaTotalMedia - (convenioMedio || 0) - (recorrentePrevisto || 0);
  const alvo = (extra) => {
    const meta = Math.max(0, base + extra);
    const restante = Math.max(0, arred(meta - (entradaRecebida || 0)));
    return { metaEntrada: arred(meta), restante,
      vendasNecessarias: razao > 0 ? arred(restante / razao) : null,
      fechamentos: (razao > 0 && ticket > 0) ? Math.ceil(restante / razao / ticket) : null,
      batida: restante === 0 };
  };
  return { empate: alvo(0), comLucro: lucroAlvo > 0 ? alvo(lucroAlvo) : null };
}

// De hoje (inclusive) ao fim do mês: seg–sex = 1, sábado = 0,5.
function diasUteisRestantes(hojeISO) {
  const [y, m, d] = hojeISO.slice(0, 10).split('-').map(Number);
  const fim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let total = 0;
  for (let dd = d; dd <= fim; dd++) {
    const dow = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
    if (dow >= 1 && dow <= 5) total += 1;
    else if (dow === 6) total += 0.5;
  }
  return total;
}
```

Atualizar o `module.exports`:

```js
module.exports = { decomposicao12m, taxaRealizacao, realizacaoPorMes, mesCorrente,
  colchao, rumoAoDegrau, razaoEntradaVenda, metaDoMes, diasUteisRestantes,
  _interno: { mesesAtras, formaDe, ehEntrada, recebida, valor, cancelada, arred, dia, ym } };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/financeiro/receita-motor.test.js`
Expected: 11 pass, 0 fail. Rodar também a suíte inteira: `node --test lib/` → tudo verde.

- [ ] **Step 5: Commit**

```bash
git add lib/financeiro/receita-motor.js lib/financeiro/receita-motor.test.js
git commit -m "feat(receita): motor — rumo ao degrau, razão entrada÷venda, meta do mês, dias úteis"
```

---

### Task 5: Servidor — `atualizarAnaliseReceita` no job diário

**Files:**
- Modify: `server.js` — import no topo (junto de `_analiseParcelas`, ~linha 27); função nova após `gravarSnapshotSaude` (~linha 3880); chamada dentro de `fetchInadimplentesBackground` (após o bloco `gravarSnapshotSaude`, ~linha 3795).

**Interfaces:**
- Consumes: motor completo (Tasks 2–4); `montarDREMensal` (já importado, linha 26), `_DREAnalise` (linha 27), `supabase`, tabela `fin_receita_analises` (Task 1).
- Produces: linha `fin_receita_analises id=1` com `dados = { hoje, decomposicao, realizacao, realizacaoMes, mesCorrente, reguas:{fixas,saidaTotal,convenioMedio,nMeses}, razaoEntradaVenda, colchao, rumo, vendasPorMes }`.

- [ ] **Step 1: Import no topo (perto da linha 27)**

```js
const _receitaMotor = require('./lib/financeiro/receita-motor');
```

- [ ] **Step 2: Função (após `gravarSnapshotSaude`)**

```js
// Análise de Receita (entrada nova × base recorrente) — spec 2026-07-08.
// Réguas = médias dos últimos 6 meses FECHADOS da DRE; vendas = orcamentos
// APPROVED ≥ R$1.000 (mesmo critério de fechamento do Painel do Gestor).
async function atualizarAnaliseReceita(items, today) {
  const primeiroDiaMenos = (n) => { const [y, m] = today.slice(0, 7).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 10); };
  const agg = await supabase.rpc('fin_dre_agg_mensal', { p_from: primeiroDiaMenos(7), p_to: today });
  if (agg.error) throw new Error(agg.error.message);
  const completos = montarDREMensal(agg.data || [], primeiroDiaMenos(7), today)
    .filter(m => _DREAnalise.mesCompleto(m.ym, new Date())).slice(-6);
  const somaGrupos = (m, codigos) => (m.grupos || [])
    .filter(g => codigos.includes(g.codigo)).reduce((s, g) => s + g.total, 0);
  const somaConta = (m, codigo) => (m.grupos || []).flatMap(g => g.contas || [])
    .filter(c => c.codigo === codigo).reduce((s, c) => s + c.total, 0);
  const media = (fn) => completos.length
    ? completos.reduce((s, m) => s + Math.abs(fn(m)), 0) / completos.length : null;
  const reguas = {
    fixas: media(m => _DREAnalise.fixasDe(m)),
    // Saída total = grupos 2–7 (impostos, custos, fixas, financeiras, investimentos).
    // Distribuição (8) e provisões (9) ficam fora — não são conta do mês.
    saidaTotal: media(m => somaGrupos(m, ['2', '3.0', '3.1', '3.2', '3.3', '4', '5', '7'])),
    convenioMedio: media(m => somaConta(m, '1.1')),
    nMeses: completos.length,
  };
  // Vendas fechadas por mês (6 meses fechados) — ~200 linhas, longe do teto de 1000.
  const { data: orc, error: orcErr } = await supabase.from('orcamentos')
    .select('valor_particular,valor_aprovado,revisao_status,data_fechamento')
    .eq('status', 'APPROVED').gt('valor_particular', 0)
    .gte('data_fechamento', primeiroDiaMenos(6)).lt('data_fechamento', today.slice(0, 8) + '01');
  if (orcErr) throw new Error(orcErr.message);
  const porMes = {};
  for (const o of (orc || [])) {
    if (o.revisao_status === 'rejeitado') continue;
    const v = Number(o.valor_aprovado ?? o.valor_particular) || 0;
    if (v < 1000) continue;
    const k = String(o.data_fechamento).slice(0, 7);
    porMes[k] = (porMes[k] || 0) + v;
  }
  const vendasPorMes = Object.entries(porMes).map(([mes, vendas]) => ({ mes, vendas }));

  const realizacao = _receitaMotor.taxaRealizacao(items, today);
  const decomposicao = _receitaMotor.decomposicao12m(items, today, 12);
  const dados = {
    hoje: today,
    decomposicao,
    realizacao,
    realizacaoMes: _receitaMotor.realizacaoPorMes(items, today),
    mesCorrente: _receitaMotor.mesCorrente(items, today, realizacao),
    reguas,
    razaoEntradaVenda: _receitaMotor.razaoEntradaVenda(decomposicao, vendasPorMes, today),
    colchao: _receitaMotor.colchao(items, today, realizacao.geral.taxa, reguas.fixas),
    rumo: _receitaMotor.rumoAoDegrau(decomposicao, today, reguas),
    vendasPorMes,
  };
  const { error } = await supabase.from('fin_receita_analises')
    .upsert({ id: 1, dados, atualizado_em: new Date().toISOString() }, { onConflict: 'id' });
  if (error) throw new Error(error.message);
  console.log('[analise_receita] atualizada');
}
```

- [ ] **Step 3: Chamada no `fetchInadimplentesBackground`** — logo após o bloco `gravarSnapshotSaude` (~linha 3795), mesmo padrão de isolamento:

```js
    // Análise de Receita (entrada × recorrente) — mesmos itens.
    try { await atualizarAnaliseReceita(allItems, today); }
    catch(e){ console.error('[analise_receita] erro:', e.message); }
```

- [ ] **Step 4: Verificar sintaxe e suíte**

Run: `node --check server.js && node --test lib/`
Expected: sem erro de parse; testes todos verdes.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(receita): análise diária gravada em fin_receita_analises (job de inadimplentes)"
```

---

### Task 6: Servidor — endpoints GET/meta/sync + FinAPI

**Files:**
- Modify: `server.js` — 3 rotas novas logo APÓS a rota `/api/painel-gestor` (~linha 8404, depois do `});` dela)
- Modify: `public/js/financeiro/api.js` — 3 entradas novas no `window.FinAPI`

**Interfaces:**
- Consumes: `fin_receita_analises`/`fin_receita_metas` (Task 1), `_receitaMotor.metaDoMes`/`diasUteisRestantes` (Task 4), `requireAuth`/`requireGestor` (server.js:418), `_finDataLocal`, `fetchInadimplentesBackground`.
- Produces:
  - `GET /api/analise-receita` → `{ ...dados, atualizado_em, meta, lucroAlvo, ticket, diasUteisRestantes }` ou `{ vazio: true }`
  - `POST /api/analise-receita/meta` body `{ mes:'YYYY-MM-01', lucro_alvo:number≥0 }` → `{ ok:true }`
  - `POST /api/analise-receita/sync` → 202 `{ ok:true }` (dispara refresh em background)
  - `FinAPI.analiseReceita()`, `FinAPI.analiseReceitaMeta(mes, lucroAlvo)`, `FinAPI.analiseReceitaSync()`

- [ ] **Step 1: Rotas no server.js**

```js
// ── Análise de Receita (entrada nova × base recorrente) ─────────────────────
app.get('/api/analise-receita', requireAuth, requireGestor, async (req, res) => {
  try {
    const hoje = _finDataLocal(new Date());
    const [anal, meta, orc] = await Promise.all([
      supabase.from('fin_receita_analises').select('dados,atualizado_em').eq('id', 1).maybeSingle(),
      supabase.from('fin_receita_metas').select('lucro_alvo').eq('mes', hoje.slice(0, 7) + '-01').maybeSingle(),
      supabase.from('orcamentos').select('valor_particular,valor_aprovado,revisao_status')
        .eq('status', 'APPROVED').gt('valor_particular', 0)
        .gte('data_fechamento', hoje.slice(0, 8) + '01').lte('data_fechamento', hoje),
    ]);
    if (anal.error) return res.status(500).json({ error: anal.error.message });
    const d = anal.data?.dados;
    if (!d) return res.json({ vazio: true });
    // Ticket do mês corrente — mesmo critério do Painel do Gestor (≥ R$1.000).
    const vals = (orc.data || []).filter(o => o.revisao_status !== 'rejeitado')
      .map(o => Number(o.valor_aprovado ?? o.valor_particular) || 0).filter(v => v >= 1000);
    const ticket = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    const lucroAlvo = Number(meta.data?.lucro_alvo) || 0;
    res.json({
      ...d,
      atualizado_em: anal.data.atualizado_em,
      lucroAlvo, ticket,
      diasUteisRestantes: _receitaMotor.diasUteisRestantes(hoje),
      meta: _receitaMotor.metaDoMes({
        saidaTotalMedia: d.reguas?.saidaTotal, convenioMedio: d.reguas?.convenioMedio,
        recorrentePrevisto: d.mesCorrente?.recorrentePrevisto,
        entradaRecebida: d.mesCorrente?.entradaRecebida,
        lucroAlvo, razao: d.razaoEntradaVenda?.razao, ticket,
      }),
    });
  } catch (e) {
    console.error('❌ /api/analise-receita:', e.message);
    res.status(500).json({ error: 'Falha ao montar a análise de receita' });
  }
});

app.post('/api/analise-receita/meta', requireAuth, requireGestor, async (req, res) => {
  const { mes, lucro_alvo } = req.body || {};
  if (!/^\d{4}-\d{2}-01$/.test(mes || '') || !(Number(lucro_alvo) >= 0))
    return res.status(400).json({ error: 'mes (YYYY-MM-01) e lucro_alvo (>= 0) obrigatorios' });
  const { error } = await supabase.from('fin_receita_metas')
    .upsert({ mes, lucro_alvo: Number(lucro_alvo), atualizado_em: new Date().toISOString() },
      { onConflict: 'mes' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/analise-receita/sync', requireAuth, requireGestor, (req, res) => {
  // Guard interno do fetchInadimplentesBackground evita execução dupla.
  fetchInadimplentesBackground().catch(e => console.error('[analise-receita-sync] erro:', e.message));
  res.status(202).json({ ok: true });
});
```

- [ ] **Step 2: FinAPI (`public/js/financeiro/api.js`, dentro do objeto `window.FinAPI`)**

```js
  analiseReceita: () => api('/api/analise-receita'),
  analiseReceitaMeta: (mes, lucroAlvo) => api('/api/analise-receita/meta',
    { method: 'POST', body: JSON.stringify({ mes, lucro_alvo: lucroAlvo }) }),
  analiseReceitaSync: () => api('/api/analise-receita/sync', { method: 'POST' }),
```

- [ ] **Step 3: Verificar**

Run: `node --check server.js && node --check public/js/financeiro/api.js`
Expected: sem erro.

- [ ] **Step 4: Commit**

```bash
git add server.js public/js/financeiro/api.js
git commit -m "feat(receita): endpoints /api/analise-receita (dados, meta editável, sync manual)"
```

---

### Task 7: Nav + página HTML

**Files:**
- Modify: `public/js/nav-config.js` — item novo na seção `financeiro-sec` (após `financeiro-saude`, ~linha 104)
- Create: `public/financeiro/receita/index.html`

**Interfaces:**
- Consumes: `shared-nav.js` (carrega o nav-config sozinho), Chart.js CDN (mesma tag da Saúde), `FinAPI` (Task 6).
- Produces: IDs de DOM que a Task 8 usa: `btn-sync, atualizado, nota-velho, nota-vazio, sintese-num, deg1-bar, deg1-rot, deg2-bar, deg2-rot, sintese-entenda, meta-modo, meta-lucro, meta-salvar, meta-linhas, meta-entenda, grafico-decomposicao, tabela-decomposicao, rumo-texto, grafico-rumo, colchao-texto, grafico-colchao, qualidade-tabela`.

- [ ] **Step 1: Item no `CRM_NAV`** (seção `financeiro-sec`, logo após o item `financeiro-saude`; a seção já inclui `admin,gestor` nos roles):

```js
      { slug: 'analise-receita', label: 'Análise de Receita', roles: 'admin,gestor', mode: 'link', href: '/financeiro/receita/' },
```

- [ ] **Step 2: Criar `public/financeiro/receita/index.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Análise de Receita — AMA</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root[data-theme="dark"] { --bg:#0f1117; --bg2:#181b24; --bg3:#1e2230; --border:#2a2f42;
  --text:#e8eaf0; --muted:#6b7280; --accent:#4f8ef7; --accent-hover:#3a78e0;
  --green:#22c55e; --yellow:#f59e0b; --red:#ef4444; --nota-bg:rgba(245,158,11,.16); }
:root[data-theme="light"] { --bg:#f7f8fa; --bg2:#fff; --bg3:#f1f3f7; --border:#e3e6ed;
  --text:#1a1d29; --muted:#6b7280; --accent:#3b82f6; --accent-hover:#2563eb;
  --green:#16a34a; --yellow:#d97706; --red:#dc2626; --nota-bg:rgba(217,119,6,.14); }
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:'DM Sans',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; }
.wrap { padding:20px 24px; max-width:1100px; }
.header { display:flex; align-items:center; gap:12px; margin-bottom:6px; flex-wrap:wrap; }
.header h1 { font-size:20px; font-weight:700; flex:1; min-width:220px; }
.sub { font-size:12px; color:var(--muted); margin-bottom:16px; }
.btn { padding:7px 16px; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer;
  border:none; font-family:inherit; transition:all .15s; }
.btn-primary { background:var(--accent); color:#fff; }
.btn-primary:hover { background:var(--accent-hover); }
.btn-primary:disabled { opacity:.6; cursor:default; }
.card { background:var(--bg2); border:1px solid var(--border); border-radius:12px;
  padding:16px; margin-bottom:16px; }
.card h2 { font-size:14px; font-weight:700; margin-bottom:12px; }
.chart-wrap { height:300px; position:relative; }
.nota { padding:10px 14px; margin-bottom:16px; border-radius:10px; font-size:13px;
  background:var(--nota-bg); border:1px solid var(--yellow); display:none; }
.sintese-num { font-size:28px; font-weight:700; margin-bottom:10px; }
.degrau { margin:10px 0; }
.degrau .rot { display:flex; justify-content:space-between; font-size:12px;
  color:var(--muted); margin-bottom:4px; }
.barra { height:14px; border-radius:7px; background:var(--bg3); overflow:hidden; }
.barra > div { height:100%; border-radius:7px; transition:width .4s; }
.meta-input { display:flex; gap:8px; align-items:center; margin:6px 0 12px; flex-wrap:wrap; font-size:13px; }
.meta-input input { width:140px; padding:6px 10px; border-radius:8px; border:1px solid var(--border);
  background:var(--bg3); color:var(--text); font-family:inherit; font-size:13px; }
.meta-linha { display:flex; justify-content:space-between; padding:7px 0; font-size:13px;
  border-bottom:1px solid var(--border); }
.meta-linha b.ok { color:var(--green); }
.meta-destaque { font-size:16px; font-weight:700; margin:10px 0 2px; }
details.entenda { margin-top:10px; font-size:12px; color:var(--muted); }
details.entenda summary { cursor:pointer; color:var(--accent); font-weight:600; list-style:none; }
details.entenda p { margin-top:6px; line-height:1.5; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th,td { padding:8px 10px; text-align:right; border-bottom:1px solid var(--border); }
th:first-child,td:first-child { text-align:left; }
th { font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:var(--muted); }
.tot td { font-weight:700; border-top:2px solid var(--border); }
@media (max-width:700px){ .wrap{padding:12px} .chart-wrap{height:240px} }
</style>
</head>
<body>
<script src="/js/shared-nav.js" data-active="analise-receita"></script>
<div class="wrap">
  <div class="header">
    <h1>📈 Análise de Receita</h1>
    <button class="btn btn-primary" id="btn-sync">🔄 Atualizar dados</button>
  </div>
  <div class="sub" id="atualizado">Carregando…</div>
  <div class="nota" id="nota-velho">⚠️ Dados com mais de 36 horas — clique em "Atualizar dados".</div>
  <div class="nota" id="nota-vazio">Ainda não há análise gravada. Clique em "Atualizar dados" e recarregue em ~2 minutos.</div>

  <div class="card">
    <h2>🫀 O mês já nasceu pago?</h2>
    <div class="sintese-num" id="sintese-num">—</div>
    <div class="degrau">
      <div class="rot"><span>Degrau 1 — despesas fixas do mês</span><span id="deg1-rot">—</span></div>
      <div class="barra"><div id="deg1-bar" style="width:0%;background:var(--green)"></div></div>
    </div>
    <div class="degrau">
      <div class="rot"><span>Degrau 2 — saída total média do mês</span><span id="deg2-rot">—</span></div>
      <div class="barra"><div id="deg2-bar" style="width:0%;background:var(--accent)"></div></div>
    </div>
    <details class="entenda"><summary>▸ entenda</summary><p id="sintese-entenda"></p></details>
  </div>

  <div class="card">
    <h2>🎯 Meta do mês</h2>
    <div class="meta-input">
      <label>Quero fechar o mês com lucro de R$</label>
      <input type="number" id="meta-lucro" min="0" step="1000" placeholder="0">
      <button class="btn btn-primary" id="meta-salvar">Salvar</button>
    </div>
    <div id="meta-linhas"></div>
    <details class="entenda"><summary>▸ entenda</summary><p id="meta-entenda"></p></details>
  </div>

  <div class="card">
    <h2>📊 Entrada nova × Base recorrente (12 meses)</h2>
    <div class="chart-wrap"><canvas id="grafico-decomposicao"></canvas></div>
    <table id="tabela-decomposicao"></table>
    <details class="entenda"><summary>▸ entenda</summary>
      <p>Entrada nova = 1º pagamento de cada contrato (dinheiro de venda recente).
      Base recorrente = parcelas seguintes (boletos e cartão da carteira antiga).
      Convênio não entra — é faturado direto para a operadora.</p></details>
  </div>

  <div class="card">
    <h2>📈 Rumo ao degrau</h2>
    <div class="sub" id="rumo-texto" style="margin-bottom:10px">—</div>
    <div class="chart-wrap"><canvas id="grafico-rumo"></canvas></div>
    <details class="entenda"><summary>▸ entenda</summary>
      <p>Linha do recorrente mês a mês contra as duas réguas (fixas e saída total).
      A projeção usa a tendência dos meses fechados: se o crescimento atual se
      mantiver, mostra em que mês a base recorrente passa a cobrir cada régua.</p></details>
  </div>

  <div class="card">
    <h2>🛡️ Colchão da carteira</h2>
    <div class="sub" id="colchao-texto" style="margin-bottom:10px">—</div>
    <div class="chart-wrap"><canvas id="grafico-colchao"></canvas></div>
    <details class="entenda"><summary>▸ entenda</summary>
      <p>Se a clínica parasse de vender hoje: as parcelas já contratadas que
      vencem nos próximos meses, ajustadas pela taxa histórica de queda real.
      "Meses garantidos" = por quantos meses seguidos esse valor cobre as
      despesas fixas.</p></details>
  </div>

  <div class="card">
    <h2>🧪 Qualidade do recorrente</h2>
    <table id="qualidade-tabela"></table>
    <details class="entenda"><summary>▸ entenda</summary>
      <p>Do que venceu em cada mês, quanto caiu dentro do próprio mês. Cartão
      de crédito cai sozinho (a operadora repassa); boleto depende do paciente
      pagar — por isso os dois aparecem separados. Pagamento atrasado conta
      como recuperação, não como recorrência confiável.</p></details>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js" integrity="sha384-JUh163oCRItcbPme8pYnROHQMC6fNKTBWtRG3I3I0erJkzNgL7uxKlNwcrcFKeqF" crossorigin="anonymous"></script>
<script src="/js/financeiro/api.js"></script>
<script src="/js/financeiro/receita-page.js"></script>
</body>
</html>
```

- [ ] **Step 3: Verificar estático**

Abrir `http://localhost` não é necessário — conferir apenas que o arquivo existe e o nav não quebrou: `node --check public/js/nav-config.js`
Expected: sem erro.

- [ ] **Step 4: Commit**

```bash
git add public/js/nav-config.js public/financeiro/receita/index.html
git commit -m "feat(receita): página /financeiro/receita/ (estrutura) + item no menu"
```

---

### Task 8: Página JS — render dos 6 blocos

**Files:**
- Create: `public/js/financeiro/receita-page.js`

**Interfaces:**
- Consumes: `FinAPI.analiseReceita/analiseReceitaMeta/analiseReceitaSync` (Task 6); IDs de DOM da Task 7; payload do GET (Task 6): `{ decomposicao, realizacao, realizacaoMes, mesCorrente, reguas, razaoEntradaVenda, colchao, rumo, meta, lucroAlvo, ticket, diasUteisRestantes, atualizado_em, vazio? }`.
- Produces: página funcional.

- [ ] **Step 1: Escrever `public/js/financeiro/receita-page.js`**

```js
// Página Análise de Receita — lê /api/analise-receita e renderiza os 6 blocos.
// Sem sigla financeira na cópia (regra do Luiz) — tudo por extenso.
(function () {
  const $ = (id) => document.getElementById(id);
  const fmt = (v) => v == null ? '—' :
    'R$ ' + Math.round(v).toLocaleString('pt-BR');
  const pct = (v) => v == null ? '—' :
    (v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + '%';
  const MESES_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const rotulo = (ym) => MESES_PT[Number(ym.slice(5, 7)) - 1] + '/' + ym.slice(2, 4);
  const ymAtual = new Date().toISOString().slice(0, 7);
  let charts = {};
  const cores = () => {
    const s = getComputedStyle(document.documentElement);
    return { accent: s.getPropertyValue('--accent').trim(), green: s.getPropertyValue('--green').trim(),
      yellow: s.getPropertyValue('--yellow').trim(), red: s.getPropertyValue('--red').trim(),
      muted: s.getPropertyValue('--muted').trim(), text: s.getPropertyValue('--text').trim() };
  };
  const escala = (c) => ({ x: { ticks: { color: c.muted } }, y: { ticks: { color: c.muted,
    callback: (v) => 'R$ ' + (v / 1000).toLocaleString('pt-BR') + 'k' } } });
  const novoChart = (id, cfg) => {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart($(id), cfg);
  };
  // Retry 5xx: 2 tentativas extra (1,5s / 3s) — padrão das páginas principais.
  async function comRetry(fn) {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) { if (i >= 2) throw e; await new Promise(r => setTimeout(r, i === 0 ? 1500 : 3000)); }
    }
  }

  function renderSintese(d, c) {
    const prev = d.mesCorrente?.recorrentePrevisto;
    const r = d.reguas || {};
    const barra = (idBar, idRot, regua) => {
      const p = (regua > 0 && prev != null) ? prev / regua : null;
      $(idBar).style.width = p == null ? '0%' : Math.min(100, p * 100) + '%';
      $(idRot).textContent = p == null ? 'réguas indisponíveis'
        : `${pct(p)} (${fmt(prev)} de ${fmt(regua)})`;
      return p;
    };
    barra('deg1-bar', 'deg1-rot', r.fixas);
    const p2 = barra('deg2-bar', 'deg2-rot', r.saidaTotal);
    $('sintese-num').textContent = p2 == null ? '—' :
      `${rotulo(ymAtual)} nasceu ${pct(p2)} pago`;
    $('sintese-entenda').textContent =
      `Base recorrente prevista para o mês: ${fmt(d.mesCorrente?.recorrenteCru)} contratados × ` +
      `${pct(d.realizacao?.geral?.taxa)} de realização histórica = ${fmt(prev)}. ` +
      `Réguas = médias dos últimos ${r.nMeses || 0} meses fechados: fixas ${fmt(r.fixas)}, ` +
      `saída total ${fmt(r.saidaTotal)}. Quanto maior a fatia do mês que o recorrente cobre ` +
      `sozinho, menos o resultado depende de vender naquele mês.`;
  }

  function renderMeta(d) {
    $('meta-lucro').value = d.lucroAlvo || '';
    const m = d.meta;
    if (!m || m.erro) {
      $('meta-linhas').innerHTML = '<div class="meta-linha"><span>Réguas indisponíveis — a DRE precisa de meses fechados.</span></div>';
      return;
    }
    const linha = (rot, alvo) => {
      if (!alvo) return '';
      const fech = alvo.fechamentos != null ? ` · ~${alvo.fechamentos} fechamentos` : '';
      const vend = alvo.vendasNecessarias != null ? ` (≈ ${fmt(alvo.vendasNecessarias)} em vendas${fech})` : '';
      return `<div class="meta-linha"><span>${rot} — meta de entrada ${fmt(alvo.metaEntrada)}</span>` +
        (alvo.batida ? '<b class="ok">✅ meta batida</b>'
          : `<b>faltam ${fmt(alvo.restante)}${vend}</b></div>`) + '</div>';
    };
    $('meta-linhas').innerHTML =
      `<div class="meta-destaque">${$('meta-lucro').value ? '' : 'Defina um lucro-alvo acima, ou acompanhe o empate:'}</div>` +
      linha('Empatar o mês', m.empate) +
      linha(`Com lucro de ${fmt(d.lucroAlvo)}`, m.comLucro) +
      `<div class="meta-linha"><span>Entrada já recebida no mês</span><b>${fmt(d.mesCorrente?.entradaRecebida)}</b></div>` +
      `<div class="meta-linha"><span>Dias úteis restantes</span><b>${(d.diasUteisRestantes ?? '—').toLocaleString('pt-BR')}</b></div>`;
    $('meta-entenda').textContent =
      `Meta de entrada = saída total média (${fmt(d.reguas?.saidaTotal)}) + lucro-alvo − convênio médio ` +
      `(${fmt(d.reguas?.convenioMedio)}) − recorrente previsto (${fmt(d.mesCorrente?.recorrentePrevisto)}). ` +
      `A tradução em vendas usa a razão histórica entrada÷venda (${pct(d.razaoEntradaVenda?.razao)}) ` +
      `e o valor médio por fechamento do mês (${fmt(d.ticket)}).`;
  }

  function renderDecomposicao(d, c) {
    const dec = d.decomposicao || [];
    novoChart('grafico-decomposicao', {
      type: 'bar',
      data: { labels: dec.map(x => rotulo(x.mes) + (x.mes === ymAtual ? ' *' : '')), datasets: [
        { label: 'Entrada nova', data: dec.map(x => x.entrada), backgroundColor: c.accent, stack: 's' },
        { label: 'Base recorrente', data: dec.map(x => x.recorrente), backgroundColor: c.green, stack: 's' },
      ]},
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: c.text } } },
        scales: { x: { stacked: true, ticks: { color: c.muted } },
          y: { stacked: true, ticks: { color: c.muted,
            callback: (v) => 'R$ ' + (v / 1000).toLocaleString('pt-BR') + 'k' } } } },
    });
    $('tabela-decomposicao').innerHTML =
      '<thead><tr><th>Mês</th><th>Entrada nova</th><th>Recorrente</th><th>Total</th><th>% recorrente</th></tr></thead><tbody>' +
      dec.map(x => { const t = x.entrada + x.recorrente;
        return `<tr><td>${rotulo(x.mes)}${x.mes === ymAtual ? ' *' : ''}</td><td>${fmt(x.entrada)}</td>` +
          `<td>${fmt(x.recorrente)}</td><td>${fmt(t)}</td><td>${t ? pct(x.recorrente / t) : '—'}</td></tr>`;
      }).join('') + '</tbody>';
  }

  function renderRumo(d, c) {
    const dec = (d.decomposicao || []).filter(x => x.mes < ymAtual);
    const r = d.rumo || {};
    const frase = (nome, a) => !a ? '' :
      a.status === 'cruzou' ? `✅ o recorrente já cobre ${nome}. ` :
      a.status === 'a_caminho' ? `No ritmo atual, cobre ${nome} em ~${a.meses} meses (≈ ${rotulo(a.mesAlvo)}). ` :
      `No ritmo atual, não cruza ${nome} — o recorrente não está crescendo. `;
    $('rumo-texto').textContent = r.erro ? 'Histórico insuficiente para projetar.'
      : frase('as despesas fixas', r.fixas) + frase('a saída total', r.total);
    const reta = (regua) => dec.map(() => regua);
    novoChart('grafico-rumo', {
      type: 'line',
      data: { labels: dec.map(x => rotulo(x.mes)), datasets: [
        { label: 'Base recorrente', data: dec.map(x => x.recorrente), borderColor: c.green,
          backgroundColor: c.green, tension: .3 },
        { label: 'Despesas fixas (média)', data: reta(d.reguas?.fixas), borderColor: c.yellow,
          borderDash: [6, 4], pointRadius: 0 },
        { label: 'Saída total (média)', data: reta(d.reguas?.saidaTotal), borderColor: c.red,
          borderDash: [6, 4], pointRadius: 0 },
      ]},
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: c.text } } }, scales: escala(c) },
    });
  }

  function renderColchao(d, c) {
    const col = d.colchao || {};
    $('colchao-texto').textContent = col.mesesCobertos == null
      ? 'Régua das fixas indisponível.'
      : `Se as vendas parassem hoje, a carteira cobre as despesas fixas por ~${col.mesesCobertos} ` +
        `${col.mesesCobertos === 1 ? 'mês' : 'meses'}.`;
    const meses = col.meses || [];
    novoChart('grafico-colchao', {
      type: 'line',
      data: { labels: meses.map(x => rotulo(x.mes)), datasets: [
        { label: 'Recorrente já contratado (ajustado)', data: meses.map(x => x.previsto),
          borderColor: c.green, backgroundColor: c.green + '33', fill: true, tension: .3 },
        { label: 'Despesas fixas (média)', data: meses.map(() => d.reguas?.fixas),
          borderColor: c.yellow, borderDash: [6, 4], pointRadius: 0 },
      ]},
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: c.text } } }, scales: escala(c) },
    });
  }

  function renderQualidade(d) {
    const rm = d.realizacaoMes || [];
    $('qualidade-tabela').innerHTML =
      '<thead><tr><th>Mês</th><th>Boleto</th><th>Cartão de crédito</th><th>Outras formas</th></tr></thead><tbody>' +
      rm.map(x => `<tr><td>${rotulo(x.mes)}</td><td>${pct(x.boleto)}</td><td>${pct(x.cartao)}</td><td>${pct(x.outras)}</td></tr>`).join('') +
      `<tr class="tot"><td>Média (6m)</td><td>${pct(d.realizacao?.['Boleto']?.taxa)}</td>` +
      `<td>${pct(d.realizacao?.['Cartão de Crédito']?.taxa)}</td><td>${pct(d.realizacao?.outras?.taxa)}</td></tr></tbody>`;
  }

  function render(d) {
    $('nota-vazio').style.display = d.vazio ? '' : 'none';
    if (d.vazio) { $('atualizado').textContent = 'Sem análise gravada ainda.'; return; }
    const quando = new Date(d.atualizado_em);
    $('atualizado').textContent = 'Atualizado em ' + quando.toLocaleString('pt-BR');
    $('nota-velho').style.display = (Date.now() - quando.getTime() > 36 * 3600 * 1000) ? '' : 'none';
    const c = cores();
    renderSintese(d, c);
    renderMeta(d);
    renderDecomposicao(d, c);
    renderRumo(d, c);
    renderColchao(d, c);
    renderQualidade(d);
  }

  let dados = null;
  async function carregar() {
    dados = await comRetry(() => FinAPI.analiseReceita());
    render(dados);
  }

  $('meta-salvar').addEventListener('click', async () => {
    const v = Number($('meta-lucro').value);
    if (!(v >= 0)) { alert('Informe um valor de lucro maior ou igual a zero.'); return; }
    const b = $('meta-salvar'); b.disabled = true;
    try { await FinAPI.analiseReceitaMeta(ymAtual + '-01', v); await carregar(); }
    catch (e) { alert('Erro ao salvar a meta: ' + e.message); }
    finally { b.disabled = false; }
  });

  $('btn-sync').addEventListener('click', async () => {
    const b = $('btn-sync'); b.disabled = true; b.textContent = 'Atualizando…';
    try {
      const antes = dados?.atualizado_em;
      await FinAPI.analiseReceitaSync();
      // O refresh roda em background (~1–2 min): sondar o atualizado_em a cada 15s.
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 15000));
        const novo = await FinAPI.analiseReceita();
        if (novo.atualizado_em !== antes) { dados = novo; render(novo); break; }
      }
    } catch (e) { alert('Erro ao atualizar: ' + e.message); }
    finally { b.disabled = false; b.textContent = '🔄 Atualizar dados'; }
  });

  carregar().catch(e => { $('atualizado').textContent = 'Erro ao carregar: ' + e.message; });
})();
```

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check public/js/financeiro/receita-page.js`
Expected: sem erro.

- [ ] **Step 3: Commit**

```bash
git add public/js/financeiro/receita-page.js
git commit -m "feat(receita): render dos 6 blocos (síntese, meta, decomposição, rumo, colchão, qualidade)"
```

---

### Task 9: Deploy + smoke test

**Files:** nenhum novo.

- [ ] **Step 1: Suíte completa + push**

```bash
node --test lib/ && node --check server.js
git push
```
Se o push divergir (working dir concorrente): `git pull --rebase` primeiro; se conflitar de verdade, isolar os commits em branch a partir de `origin/main` (regra da casa; token via CredRead se o GCM travar).

- [ ] **Step 2: Deploy Easypanel (imediato, sem perguntar — regra da casa)**

```bash
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

- [ ] **Step 3: Smoke — endpoint protegido**

```bash
curl -s -o /dev/null -w "%{http_code}" https://plataformaama-plataforma.uc5as5.easypanel.host/api/analise-receita
```
Expected: `401` (sem token = bloqueado; se vier 404, o container não trocou — Stop→Start no Easypanel, nunca Destroy, e conferir o CONTEÚDO servido).

- [ ] **Step 4: Popular a primeira análise**

Via MCP Supabase (`execute_sql`): `select id, atualizado_em from fin_receita_analises;` → vazio. Disparar o job: aguardar o refresh diário OU chamar o sync logado. Mais simples sem token: rodar 1x no servidor não dá — então usar o botão da própria página logado, OU aguardar o cron noturno. Registrar no relatório final qual caminho ficou.
Depois: `select atualizado_em, jsonb_object_keys(dados) from fin_receita_analises, jsonb_object_keys(dados);` → chaves `decomposicao, realizacao, realizacaoMes, mesCorrente, reguas, razaoEntradaVenda, colchao, rumo, vendasPorMes, hoje`.

- [ ] **Step 5: Validação visual (pendente do Luiz)**

A página `/financeiro/receita/` precisa de login com role gestor/admin — validação final é do Luiz (padrão do projeto: registrar como pendência).

- [ ] **Step 6: Commit final (se houve ajuste)**

```bash
git add -A && git commit -m "fix(receita): ajustes pós-deploy" && git push
```
(+ redeploy do Step 2 se commitou algo.)

---

## Self-review do plano (feito na escrita)

- **Cobertura do spec:** decomposição ✓ (T2), realização ✓ (T2), mês corrente ✓ (T3), colchão só 1+ ✓ (T3), rumo ✓ (T4), razão/meta/dias úteis ✓ (T4), réguas DRE ✓ (T5), convênio médio ✓ (T5), vendas por mês ✓ (T5), tabelas+RLS ✓ (T1), 3 endpoints ✓ (T6), nav+página ✓ (T7), 6 blocos+entenda+sem siglas ✓ (T7/T8), degradação de erro ✓ (T8: notas, '—', tarja 36h), botão sync ✓ (T6/T8), fase 2 fora ✓.
- **Tipos consistentes:** `realizacao` usa chaves `geral|Boleto|Cartão de Crédito|outras` em T2→T3→T5→T8 ✓; payload GET (T6) = campos lidos em T8 ✓; `mesCorrente.recorrentePrevisto/entradaRecebida` batem entre T3/T4/T6/T8 ✓.
- **Placeholders:** nenhum TBD/TODO; único ponto aberto declarado é o Step 4 da T9 (primeira população: botão logado ou cron noturno) — decisão operacional, não de código.
