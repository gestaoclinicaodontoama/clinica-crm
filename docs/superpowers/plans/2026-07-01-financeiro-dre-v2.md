# Financeiro/DRE v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evoluir `/financeiro/` de tabela Conta×Total para painel com cascata de subtotais, coluna por mês, análise vertical/horizontal, média+anomalia, drill-down, ponto de equilíbrio e projeção do mês.

**Architecture:** Uma RPC nova agrega por mês; um endpoint novo devolve um array de DREs (reusando `montarDRE`) + resumo de não-categorizados. Toda a análise (cascata, AV%, variação, média, anomalia, PE, run-rate) fica num módulo puro compartilhado browser/Node (`dre-analise.js`), testado com `node:test`. A página é reescrita com a lógica em `dre-page.js` (JS externo, não inline).

**Tech Stack:** Node/Express, Supabase (RPC via MCP, project `mtqdpjhhqzvuklnlfpvi`), front vanilla HTML/CSS/JS, `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-01-financeiro-dre-v2-design.md` — ler antes de começar.

## Global Constraints

- Front é vanilla: **nenhuma lib nova**, nenhum framework, nenhum npm install.
- Testes: `node --test "lib/**/*.test.js"` (glob só pega testes dentro de `lib/`).
- Endpoint novo usa `requireAuth, requireFinanceiro` (mesmos middlewares do `/api/financeiro/dre`).
- O endpoint antigo `/api/financeiro/dre` **não muda** (outras telas podem usar).
- Valores de saída na DRE são **negativos** (sinal aplicado no `montarDRE`); a cascata soma grupos com sinal.
- Classificação PE: variáveis = grupos `2, 3.0, 3.1, 3.2, 3.3`; fixas = grupo `4`; fora = `5, 7`.
- Anomalia: só linhas de saída, só com ≥3 meses completos; âmbar >125% da média, vermelho >150%.
- Mês corrente NUNCA conta como completo (fica fora de média/anomalia/PE).
- Tema claro/escuro via variáveis CSS existentes (`--bg2`, `--border`, `--green`, `--red`, `--yellow` etc.).
- Commits na `main` local; **push só na Task 7** (evita deploy à toa; se o push for rejeitado por divergência real, isolar os commits em branch a partir de `origin/main` — NÃO rebase forçado).
- Working dir é compartilhado com outras sessões: `git add` sempre com caminhos explícitos, nunca `git add -A`.

---

### Task 1: Agrupador mensal `montarDREMensal`

**Files:**
- Create: `lib/financeiro/dre-mensal.js`
- Test: `lib/financeiro/dre-mensal.test.js`

**Interfaces:**
- Consumes: `montarDRE(lancs)` de `lib/financeiro/dre.js`.
- Produces: `montarDREMensal(rows, from, to)` → `[{ ym, receita, grupos, resultado }]` onde `rows = [{ym:'YYYY-MM', conta_codigo, fluxo, total}]` (formato da RPC da Task 2) e `from`/`to` são `'YYYY-MM-DD'`. Meses do range sem lançamento entram zerados. Também exporta `listarMeses(from, to)` → `['YYYY-MM', ...]`.

- [ ] **Step 1: Write the failing test**

`lib/financeiro/dre-mensal.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { montarDREMensal, listarMeses } = require('./dre-mensal');

test('listarMeses cobre o range inclusive, virando o ano', () => {
  assert.deepEqual(listarMeses('2025-11-01', '2026-02-28'),
    ['2025-11', '2025-12', '2026-01', '2026-02']);
});

test('agrupa linhas por mês e roda montarDRE em cada um', () => {
  const rows = [
    { ym: '2026-05', conta_codigo: '1.2', fluxo: 'entra', total: '1000' },
    { ym: '2026-05', conta_codigo: '2.1', fluxo: 'sai', total: '100' },
    { ym: '2026-06', conta_codigo: '1.2', fluxo: 'entra', total: '2000' },
  ];
  const meses = montarDREMensal(rows, '2026-05-01', '2026-06-30');
  assert.equal(meses.length, 2);
  assert.equal(meses[0].ym, '2026-05');
  assert.equal(meses[0].receita, 1000);
  assert.equal(meses[0].resultado, 900);
  assert.equal(meses[1].resultado, 2000);
});

test('mês sem lançamento entra zerado', () => {
  const rows = [{ ym: '2026-04', conta_codigo: '1.2', fluxo: 'entra', total: '500' }];
  const meses = montarDREMensal(rows, '2026-04-01', '2026-06-30');
  assert.equal(meses.length, 3);
  assert.equal(meses[1].ym, '2026-05');
  assert.equal(meses[1].receita, 0);
  assert.equal(meses[1].resultado, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:\Users\Luiz Martins\Desktop\Projeto Claude Code\clinica-crm" && node --test lib/financeiro/dre-mensal.test.js`
Expected: FAIL — `Cannot find module './dre-mensal'`

- [ ] **Step 3: Write minimal implementation**

`lib/financeiro/dre-mensal.js`:

```js
const { montarDRE } = require('./dre');

// Range de meses 'YYYY-MM' inclusive, a partir de datas 'YYYY-MM-DD'.
function listarMeses(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const fim = to.slice(0, 7);
  for (;;) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    if (ym > fim) break;
    out.push(ym);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// rows = saída da RPC fin_dre_agg_mensal; meses do range sem lançamento entram zerados.
function montarDREMensal(rows, from, to) {
  const porMes = new Map();
  for (const r of rows) {
    if (!porMes.has(r.ym)) porMes.set(r.ym, []);
    porMes.get(r.ym).push({ fluxo: r.fluxo, valor: Number(r.total), conta_codigo: r.conta_codigo });
  }
  return listarMeses(from, to).map(ym => ({ ym, ...montarDRE(porMes.get(ym) || []) }));
}

module.exports = { montarDREMensal, listarMeses };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/financeiro/dre-mensal.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Rodar a suíte inteira e commitar**

Run: `npm test` — Expected: todos passam.

```bash
git add lib/financeiro/dre-mensal.js lib/financeiro/dre-mensal.test.js
git commit -m "feat(financeiro): agrupador mensal da DRE (montarDREMensal)"
```

---

### Task 2: Migração — RPCs `fin_dre_agg_mensal` e `fin_sem_categoria_resumo`

**Files:**
- Create: `supabase/migrations/20260701090000_financeiro_dre_mensal.sql`

**Interfaces:**
- Produces: RPC `fin_dre_agg_mensal(p_from date, p_to date)` → `(ym text, conta_codigo text, fluxo text, total numeric)`; RPC `fin_sem_categoria_resumo(p_from date, p_to date)` → `(qtd bigint, total numeric)`. Consumidas pela Task 3.

- [ ] **Step 1: Criar o arquivo de migração**

`supabase/migrations/20260701090000_financeiro_dre_mensal.sql`:

```sql
-- DRE por mês (mesma base da fin_dre_agg de 20260615120200, + mês no group by).
create or replace function fin_dre_agg_mensal(p_from date, p_to date)
returns table(ym text, conta_codigo text, fluxo text, total numeric)
language sql stable security definer
set search_path = public as $$
  select to_char(l.data, 'YYYY-MM'), c.codigo, l.fluxo, sum(l.valor)
  from fin_lancamentos l
  join fin_contas c on c.id = l.conta_id
  where l.ativo = true and l.data between p_from and p_to and l.conta_id is not null
  group by 1, 2, 3;
$$;

-- Saídas sem categoria no período (ficam FORA da DRE — aviso na página).
create or replace function fin_sem_categoria_resumo(p_from date, p_to date)
returns table(qtd bigint, total numeric)
language sql stable security definer
set search_path = public as $$
  select count(*), coalesce(sum(valor), 0)
  from fin_lancamentos
  where ativo = true and fluxo = 'sai' and conta_id is null
    and data between p_from and p_to;
$$;
```

- [ ] **Step 2: Aplicar via MCP Supabase**

Tool: `mcp__plugin_supabase_supabase__apply_migration` com `project_id: mtqdpjhhqzvuklnlfpvi`, `name: financeiro_dre_mensal`, query = conteúdo do arquivo.
Depois `list_migrations` e confirmar que `financeiro_dre_mensal` aparece.

- [ ] **Step 3: Verificar as RPCs com dados reais**

Tool: `mcp__plugin_supabase_supabase__execute_sql`:

```sql
select * from fin_dre_agg_mensal('2026-05-01','2026-06-30') order by ym, conta_codigo limit 10;
select * from fin_sem_categoria_resumo('2026-01-01','2026-06-30');
```

Expected: primeira devolve linhas com `ym` em `2026-05`/`2026-06`; segunda devolve 1 linha `(qtd, total)` sem erro.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260701090000_financeiro_dre_mensal.sql
git commit -m "feat(financeiro): RPCs fin_dre_agg_mensal + fin_sem_categoria_resumo"
```

---

### Task 3: Endpoint `GET /api/financeiro/dre-mensal` + `FinAPI.dreMensal`

**Files:**
- Modify: `server.js` (require no topo junto aos outros de `lib/financeiro`, ~linha 25; rota logo após `/api/financeiro/dre`, ~linha 7340)
- Modify: `public/js/financeiro/api.js`

**Interfaces:**
- Consumes: `montarDREMensal` (Task 1), RPCs (Task 2), `requireAuth`/`requireFinanceiro` existentes.
- Produces: `GET /api/financeiro/dre-mensal?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ meses: [{ym, receita, grupos, resultado}], sem_categoria: {qtd, total} }`; `FinAPI.dreMensal(from, to)` no front.

- [ ] **Step 1: Adicionar o require no topo do server.js**

Perto de `const { montarDRE } = require('./lib/financeiro/dre');` (linha ~25), adicionar:

```js
const { montarDREMensal } = require('./lib/financeiro/dre-mensal');
```

- [ ] **Step 2: Adicionar a rota (logo após o bloco do /api/financeiro/dre)**

```js
// DRE mensal: uma DRE por mês do período + resumo de saídas sem categoria (fora da DRE)
app.get('/api/financeiro/dre-mensal', requireAuth, requireFinanceiro, async (req, res) => {
  const { from, to } = req.query;
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from || '') || !re.test(to || '') || from > to) return res.status(400).json({ error: 'periodo invalido' });
  const [agg, semCat] = await Promise.all([
    supabase.rpc('fin_dre_agg_mensal', { p_from: from, p_to: to }),
    supabase.rpc('fin_sem_categoria_resumo', { p_from: from, p_to: to }),
  ]);
  if (agg.error) return res.status(500).json({ error: agg.error.message });
  if (semCat.error) return res.status(500).json({ error: semCat.error.message });
  const sc = (semCat.data || [])[0] || { qtd: 0, total: 0 };
  res.json({
    meses: montarDREMensal(agg.data || [], from, to),
    sem_categoria: { qtd: Number(sc.qtd), total: Number(sc.total) },
  });
});
```

- [ ] **Step 3: Adicionar ao FinAPI**

Em `public/js/financeiro/api.js`, logo abaixo da linha `dre:`:

```js
  dreMensal: (from, to) => api(`/api/financeiro/dre-mensal?from=${from}&to=${to}`),
```

- [ ] **Step 4: Verificar sintaxe e suíte**

Run: `node --check server.js && node --check public/js/financeiro/api.js && npm test`
Expected: sem erro de sintaxe, testes passam.

- [ ] **Step 5: Commit**

```bash
git add server.js public/js/financeiro/api.js
git commit -m "feat(financeiro): endpoint /api/financeiro/dre-mensal"
```

---

### Task 4: Módulo de análise `dre-analise.js` (puro, TDD)

**Files:**
- Create: `public/js/financeiro/dre-analise.js`
- Test: `lib/financeiro/dre-analise.test.js` (importa `../../public/js/financeiro/dre-analise.js` — o glob do npm test só varre `lib/`)

**Interfaces:**
- Consumes: nada (funções puras; recebe DREs no formato `{ym, receita, grupos:[{codigo,titulo,total,contas}], resultado}`).
- Produces (browser: `window.DREAnalise`; Node: `module.exports`):
  - `VARIAVEIS = ['2','3.0','3.1','3.2','3.3']`, `FIXAS = ['4']`
  - `somaGrupos(dre, codigos)` → number (com sinal)
  - `subtotais(dre)` → `{receitaBruta, receitaLiquida, lucroBruto, resultadoOperacional, resultadoFinal}`
  - `av(valor, receitaBruta)` → fração ou `null`
  - `variacao(natureza, atual, anterior)` → pct ou `null` (natureza: `'entrada'|'saida'`)
  - `classeVariacao(natureza, pct)` → `'melhor'|'pior'|null`
  - `mesCompleto(ym, hoje)` → boolean (mês corrente NUNCA é completo)
  - `media(valores)` → number ou `null`
  - `nivelAnomalia(valor, mediaVal, nMesesCompletos)` → `'ambar'|'vermelho'|null`
  - `pontoEquilibrio(mesesCompletos)` → `{pe, mcPct, fixasMediaMes}` ou `{erro}`
  - `projecaoMes(mesParcial, mesesCompletos, hoje)` → `{receitaProj, variaveisProj, fixasProj, resultadoProj, fixasAproximada}` ou `null`
  - `maiorDesvio(mesesCompletos)` → `{codigo, nome, pct, ym, valor, media}` ou `null`

- [ ] **Step 1: Write the failing tests**

`lib/financeiro/dre-analise.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const A = require('../../public/js/financeiro/dre-analise.js');

// helper: DRE mínima a partir de {codigoGrupo: total} (+ contas opcionais)
function dre(ym, totais, contas = {}) {
  const grupos = Object.entries(totais).map(([codigo, total]) => ({
    codigo, titulo: codigo, total,
    contas: (contas[codigo] || []).map(c => ({ ...c })),
  }));
  const receita = totais['1'] || 0;
  return { ym, receita, grupos, resultado: Object.values(totais).reduce((s, v) => s + v, 0) };
}

test('subtotais: cascata bate com o resultado final', () => {
  const d = dre('2026-05', { '1': 1000, '2': -100, '3.1': -200, '4': -300, '5': -50 });
  const s = A.subtotais(d);
  assert.equal(s.receitaBruta, 1000);
  assert.equal(s.receitaLiquida, 900);
  assert.equal(s.lucroBruto, 700);
  assert.equal(s.resultadoOperacional, 400);
  assert.equal(s.resultadoFinal, 350);
  assert.equal(s.resultadoFinal, d.resultado);
});

test('av: fração da receita bruta; null com receita 0', () => {
  assert.equal(A.av(-200, 1000), -0.2);
  assert.equal(A.av(500, 0), null);
});

test('variacao entrada usa sinal; saida usa módulo', () => {
  assert.equal(A.variacao('entrada', 1200, 1000), 0.2);
  assert.equal(A.variacao('entrada', 50, -10), 6);           // virou de prejuízo p/ lucro
  assert.ok(Math.abs(A.variacao('saida', -120, -100) - 0.2) < 1e-9); // gastou 20% a mais
  assert.equal(A.variacao('saida', -120, 0), null);
});

test('classeVariacao: despesa subir é pior, receita subir é melhor', () => {
  assert.equal(A.classeVariacao('entrada', 0.2), 'melhor');
  assert.equal(A.classeVariacao('saida', 0.2), 'pior');
  assert.equal(A.classeVariacao('saida', -0.2), 'melhor');
  assert.equal(A.classeVariacao('saida', null), null);
});

test('mesCompleto: mês corrente nunca é completo', () => {
  const hoje = new Date(2026, 6, 15); // 2026-07-15
  assert.equal(A.mesCompleto('2026-06', hoje), true);
  assert.equal(A.mesCompleto('2026-07', hoje), false);
  assert.equal(A.mesCompleto('2026-07', new Date(2026, 6, 31)), false);
});

test('nivelAnomalia: limiares 125%/150%, exige 3 meses e média não-zero', () => {
  assert.equal(A.nivelAnomalia(-130, -100, 3), 'ambar');
  assert.equal(A.nivelAnomalia(-160, -100, 3), 'vermelho');
  assert.equal(A.nivelAnomalia(-120, -100, 3), null);
  assert.equal(A.nivelAnomalia(-160, -100, 2), null);
  assert.equal(A.nivelAnomalia(-160, 0, 3), null);
});

test('pontoEquilibrio: PE = fixas médias / MC%', () => {
  const meses = [
    dre('2026-04', { '1': 1000, '2': -100, '3.1': -300, '4': -240 }),
    dre('2026-05', { '1': 1000, '2': -100, '3.1': -300, '4': -260 }),
  ];
  const r = A.pontoEquilibrio(meses);
  // variáveis 40% → MC 60%; fixas médias 250 → PE = 416,67
  assert.ok(Math.abs(r.mcPct - 0.6) < 1e-9);
  assert.ok(Math.abs(r.pe - 250 / 0.6) < 0.01);
});

test('pontoEquilibrio: guardas de erro', () => {
  assert.ok(A.pontoEquilibrio([]).erro);
  assert.ok(A.pontoEquilibrio([dre('2026-05', { '1': 0, '4': -100 })]).erro);
  assert.ok(A.pontoEquilibrio([dre('2026-05', { '1': 100, '2': -150, '4': -10 })]).erro); // MC negativa
});

test('projecaoMes: linear na receita, fixas pela média histórica', () => {
  const parcial = dre('2026-07', { '1': 500, '2': -50, '4': -100 });
  const hist = [dre('2026-06', { '1': 1000, '2': -100, '3.1': -300, '4': -240 })];
  const p = A.projecaoMes(parcial, hist, new Date(2026, 6, 10)); // dia 10 de 31
  assert.ok(Math.abs(p.receitaProj - 500 / 10 * 31) < 0.01);
  assert.ok(Math.abs(p.variaveisProj - p.receitaProj * 0.4) < 0.01);
  assert.equal(p.fixasProj, 240);
  assert.equal(p.fixasAproximada, false);
});

test('projecaoMes: sem histórico usa o próprio mês parcial (fixas lineares, aproximadas)', () => {
  const parcial = dre('2026-07', { '1': 500, '2': -100, '4': -100 });
  const p = A.projecaoMes(parcial, [], new Date(2026, 6, 10));
  assert.equal(p.fixasAproximada, true);
  assert.ok(Math.abs(p.fixasProj - 100 / 10 * 31) < 0.01);
});

test('maiorDesvio: acha a conta de saída que mais estourou no último mês completo', () => {
  const contas = (v) => ({ '3.1': [{ codigo: '3.1.3', nome: 'Dentais', total: v }] });
  const meses = [
    dre('2026-04', { '1': 1000, '3.1': -100 }, contas(-100)),
    dre('2026-05', { '1': 1000, '3.1': -100 }, contas(-100)),
    dre('2026-06', { '1': 1000, '3.1': -400 }, contas(-400)),
  ];
  const d = A.maiorDesvio(meses);
  assert.equal(d.codigo, '3.1.3');
  assert.equal(d.ym, '2026-06');
  assert.ok(d.pct > 0.9); // -400 vs média -200 → +100%
  assert.equal(A.maiorDesvio(meses.slice(0, 2)), null); // <3 meses
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/financeiro/dre-analise.test.js`
Expected: FAIL — `Cannot find module '../../public/js/financeiro/dre-analise.js'`

- [ ] **Step 3: Write the implementation**

`public/js/financeiro/dre-analise.js`:

```js
// Análise da DRE v2 — funções puras, compartilhadas entre browser (window.DREAnalise)
// e testes Node (module.exports). Formato de entrada: DRE do montarDRE
// { ym, receita, grupos:[{codigo,titulo,total,contas:[{codigo,nome,total}]}], resultado }
// Saídas têm total NEGATIVO (sinal já aplicado no montarDRE).
(function (global) {
  const VARIAVEIS = ['2', '3.0', '3.1', '3.2', '3.3']; // impostos + custos (premissa do spec §2.5)
  const FIXAS = ['4'];
  const ZERO = 0.005; // abaixo disso, trata como zero (evita divisão instável)

  const somaGrupos = (dre, codigos) =>
    (dre.grupos || []).filter(g => codigos.includes(g.codigo)).reduce((s, g) => s + g.total, 0);

  function subtotais(dre) {
    const receitaBruta = somaGrupos(dre, ['1']);
    const receitaLiquida = receitaBruta + somaGrupos(dre, ['2']);
    const lucroBruto = receitaLiquida + somaGrupos(dre, ['3.0', '3.1', '3.2', '3.3']);
    const resultadoOperacional = lucroBruto + somaGrupos(dre, ['4']);
    const resultadoFinal = resultadoOperacional + somaGrupos(dre, ['5', '7']);
    return { receitaBruta, receitaLiquida, lucroBruto, resultadoOperacional, resultadoFinal };
  }

  function av(valor, receitaBruta) {
    return Math.abs(receitaBruta) < ZERO ? null : valor / receitaBruta;
  }

  // entrada: variação com sinal (pega resultado cruzando de prejuízo p/ lucro);
  // saída: variação do MÓDULO (gastou mais/menos), pra leitura intuitiva.
  function variacao(natureza, atual, anterior) {
    if (anterior == null || Math.abs(anterior) < ZERO) return null;
    if (natureza === 'entrada') return (atual - anterior) / Math.abs(anterior);
    return (Math.abs(atual) - Math.abs(anterior)) / Math.abs(anterior);
  }

  function classeVariacao(natureza, pct) {
    if (pct == null || pct === 0) return null;
    if (natureza === 'entrada') return pct > 0 ? 'melhor' : 'pior';
    return pct > 0 ? 'pior' : 'melhor';
  }

  // Mês corrente nunca é completo (o dia de hoje ainda não acabou).
  function mesCompleto(ym, hoje) {
    const corrente = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    return ym < corrente;
  }

  function media(valores) {
    if (!valores.length) return null;
    return valores.reduce((s, v) => s + v, 0) / valores.length;
  }

  function nivelAnomalia(valor, mediaVal, nMesesCompletos) {
    if (nMesesCompletos < 3 || mediaVal == null || Math.abs(mediaVal) < ZERO) return null;
    const razao = Math.abs(valor) / Math.abs(mediaVal);
    if (razao > 1.5) return 'vermelho';
    if (razao > 1.25) return 'ambar';
    return null;
  }

  // mesesCompletos: DREs de meses completos. PE = fixas médias mensais / margem de contribuição.
  function pontoEquilibrio(mesesCompletos) {
    if (!mesesCompletos.length) return { erro: 'sem meses completos no período' };
    let receita = 0, variaveis = 0, fixas = 0;
    for (const m of mesesCompletos) {
      receita += somaGrupos(m, ['1']);
      variaveis += somaGrupos(m, VARIAVEIS);
      fixas += somaGrupos(m, FIXAS);
    }
    if (receita <= ZERO) return { erro: 'sem receita no período' };
    const mcPct = 1 - Math.abs(variaveis) / receita;
    if (mcPct <= 0) return { erro: 'margem de contribuição não positiva no período' };
    const fixasMediaMes = Math.abs(fixas) / mesesCompletos.length;
    return { pe: fixasMediaMes / mcPct, mcPct, fixasMediaMes };
  }

  // Projeção do mês corrente. Receita linear por dia corrido; variáveis pelo % histórico;
  // fixas pela média histórica (fallback linear, marcado fixasAproximada).
  function projecaoMes(mesParcial, mesesCompletos, hoje) {
    const diasMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
    const diasCorridos = hoje.getDate();
    if (diasCorridos < 1) return null;
    const receitaAtual = somaGrupos(mesParcial, ['1']);
    const receitaProj = receitaAtual / diasCorridos * diasMes;
    let pctVar, fixasProj, fixasAproximada = false;
    if (mesesCompletos.length) {
      const receitaHist = mesesCompletos.reduce((s, m) => s + somaGrupos(m, ['1']), 0);
      const varHist = mesesCompletos.reduce((s, m) => s + somaGrupos(m, VARIAVEIS), 0);
      pctVar = receitaHist > ZERO ? Math.abs(varHist) / receitaHist : 0;
      fixasProj = Math.abs(mesesCompletos.reduce((s, m) => s + somaGrupos(m, FIXAS), 0)) / mesesCompletos.length;
    } else {
      pctVar = receitaAtual > ZERO ? Math.abs(somaGrupos(mesParcial, VARIAVEIS)) / receitaAtual : 0;
      fixasProj = Math.abs(somaGrupos(mesParcial, FIXAS)) / diasCorridos * diasMes;
      fixasAproximada = true;
    }
    const variaveisProj = receitaProj * pctVar;
    return { receitaProj, variaveisProj, fixasProj, resultadoProj: receitaProj - variaveisProj - fixasProj, fixasAproximada };
  }

  // Conta de saída com maior estouro % (último mês completo vs média dos completos).
  function maiorDesvio(mesesCompletos) {
    if (mesesCompletos.length < 3) return null;
    const ultimo = mesesCompletos[mesesCompletos.length - 1];
    const porConta = new Map(); // codigo → { nome, porMes: {ym: total} }
    for (const m of mesesCompletos) for (const g of (m.grupos || [])) {
      if (g.codigo === '1') continue;
      for (const c of (g.contas || [])) {
        if (!porConta.has(c.codigo)) porConta.set(c.codigo, { nome: c.nome, porMes: {} });
        porConta.get(c.codigo).porMes[m.ym] = c.total;
      }
    }
    let top = null;
    for (const [codigo, info] of porConta) {
      const valores = mesesCompletos.map(m => info.porMes[m.ym] || 0);
      const med = media(valores);
      if (med == null || Math.abs(med) < ZERO) continue;
      const atual = info.porMes[ultimo.ym] || 0;
      const pct = (Math.abs(atual) - Math.abs(med)) / Math.abs(med);
      if (pct > 0 && (!top || pct > top.pct)) {
        top = { codigo, nome: info.nome, pct, ym: ultimo.ym, valor: atual, media: med };
      }
    }
    return top;
  }

  const api = { VARIAVEIS, FIXAS, somaGrupos, subtotais, av, variacao, classeVariacao,
    mesCompleto, media, nivelAnomalia, pontoEquilibrio, projecaoMes, maiorDesvio };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DREAnalise = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/financeiro/dre-analise.test.js && npm test`
Expected: PASS (11 tests novos; suíte inteira verde)

- [ ] **Step 5: Commit**

```bash
git add public/js/financeiro/dre-analise.js lib/financeiro/dre-analise.test.js
git commit -m "feat(financeiro): módulo de análise da DRE (cascata, AV, variação, PE, run-rate)"
```

---

### Task 5: Página — tabela nova (cascata, colunas mensais, AV%, ▲▼, média, anomalia, colapso, banner, guarda 24m)

**Files:**
- Modify: `public/financeiro/index.html` (estilos + markup; scripts saem do inline)
- Create: `public/js/financeiro/dre-page.js` (toda a lógica da página; Task 6 acrescenta KPIs/drill-down neste mesmo arquivo)

**Interfaces:**
- Consumes: `FinAPI.dreMensal(from, to)` (Task 3), `FinAPI.sync()`, `window.DREAnalise` (Task 4).
- Produces: função global `carregar()` e `sincronizar()` (chamadas pelos botões); estado global `window._dreState = { meses, semCat, from, to }` que a Task 6 consome; `tbody` com células de conta portando `data-conta` e `data-ym` (ou `data-ym="total"`) que a Task 6 pluga o drill-down.

- [ ] **Step 1: Reescrever `public/financeiro/index.html`**

Substituir o arquivo inteiro por:

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Financeiro — AMA</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root[data-theme="dark"] {
  --bg: #0f1117; --bg2: #181b24; --bg3: #1e2230; --border: #2a2f42;
  --text: #e8eaf0; --muted: #6b7280; --accent: #4f8ef7; --accent-hover: #3a78e0;
  --green: #22c55e; --yellow: #f59e0b; --red: #ef4444; --teal: #14b8a6; --purple: #a855f7;
  --anom-ambar: rgba(245, 158, 11, .16); --anom-verm: rgba(239, 68, 68, .18);
}
:root[data-theme="light"] {
  --bg: #f7f8fa; --bg2: #ffffff; --bg3: #f1f3f7; --border: #e3e6ed;
  --text: #1a1d29; --muted: #6b7280; --accent: #3b82f6; --accent-hover: #2563eb;
  --green: #16a34a; --yellow: #d97706; --red: #dc2626; --teal: #0d9488; --purple: #9333ea;
  --anom-ambar: rgba(217, 119, 6, .14); --anom-verm: rgba(220, 38, 38, .14);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'DM Sans', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
.fin-wrap { padding: 20px 24px; }
.fin-header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
.fin-header h1 { font-size: 20px; font-weight: 700; flex: 1; min-width: 160px; }
.fin-links { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
.fin-link { padding: 6px 14px; border-radius: 8px; font-size: 13px; font-weight: 500;
  text-decoration: none; color: var(--muted); background: var(--bg2);
  border: 1px solid var(--border); transition: all .15s; }
.fin-link:hover { border-color: var(--accent); color: var(--accent); }
.fin-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.fin-controls label { font-size: 13px; color: var(--muted); font-weight: 500; }
.fin-controls input[type="month"] { padding: 6px 10px; border: 1px solid var(--border);
  border-radius: 8px; font-size: 13px; background: var(--bg2); color: var(--text);
  font-family: inherit; outline: none; }
.fin-controls input:focus { border-color: var(--accent); }
.btn { padding: 7px 16px; border-radius: 8px; font-size: 13px; font-weight: 600;
  cursor: pointer; border: none; font-family: inherit; transition: all .15s; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { background: var(--accent-hover); }
.btn-primary:disabled { opacity: .6; cursor: default; }
.btn-ghost { background: var(--bg2); color: var(--text); border: 1px solid var(--border); }
.btn-ghost:hover { background: var(--bg3); }

/* Banner de não categorizados */
.banner-semcat { display: none; padding: 10px 14px; margin-bottom: 16px; border-radius: 10px;
  font-size: 13px; background: var(--anom-ambar); border: 1px solid var(--yellow); }
.banner-semcat a { color: var(--accent); font-weight: 600; }

/* Cards de KPI (preenchidos na Task 6) */
.kpis { display: none; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px; margin-bottom: 16px; }
.kpi { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 14px; }
.kpi .kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: .5px;
  color: var(--muted); font-weight: 600; margin-bottom: 6px; }
.kpi .kpi-valor { font-size: 19px; font-weight: 700; }
.kpi .kpi-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
.kpi.clicavel { cursor: pointer; }
.kpi.clicavel:hover { border-color: var(--accent); }
.kpi .selo { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 7px;
  border-radius: 99px; background: var(--bg3); color: var(--muted); margin-left: 6px;
  vertical-align: middle; text-transform: uppercase; letter-spacing: .5px; }
.kpi .barra { height: 6px; background: var(--bg3); border-radius: 99px; margin-top: 8px; overflow: hidden; }
.kpi .barra > div { height: 100%; border-radius: 99px; background: var(--yellow); }
.kpi .barra > div.ok { background: var(--green); }

#dreMsg { padding: 40px; color: var(--muted); text-align: center; }

/* Tabela */
.dre-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; overflow-x: auto; }
table.dre { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 13px; }
table.dre th { padding: 10px 12px; text-align: right; font-size: 11px; font-weight: 600;
  color: var(--muted); border-bottom: 1px solid var(--border);
  text-transform: uppercase; letter-spacing: .5px; white-space: nowrap; }
table.dre th.col-conta { text-align: left; }
table.dre td { padding: 8px 12px; border-bottom: 1px solid var(--border);
  text-align: right; white-space: nowrap; }
table.dre td.col-conta { text-align: left; }
table.dre tr:last-child td { border-bottom: none; }
/* primeira coluna fixa no scroll horizontal */
table.dre th.col-conta, table.dre td.col-conta { position: sticky; left: 0; background: var(--bg2); z-index: 1; }
table.dre tr.grupo td.col-conta, table.dre tr.grupo th.col-conta { background: var(--bg3); }
table.dre tr.subtotal td.col-conta { background: var(--bg3); }

table.dre tr.grupo td { background: var(--bg3); font-weight: 700; font-size: 13px; cursor: pointer; }
table.dre tr.grupo .chev { display: inline-block; width: 14px; color: var(--muted);
  transition: transform .15s; }
table.dre tr.grupo.aberto .chev { transform: rotate(90deg); }
table.dre tr.conta td.col-conta { padding-left: 34px; color: var(--muted); }
table.dre tr.conta td.valor-conta { cursor: pointer; text-decoration: underline dotted transparent; }
table.dre tr.conta td.valor-conta:hover { text-decoration-color: var(--accent); color: var(--accent); }
table.dre tr.subtotal td { background: var(--bg3); font-weight: 700; font-size: 13.5px;
  border-top: 2px solid var(--border); }
.margem { display: block; font-size: 10.5px; font-weight: 500; color: var(--muted); }
.var { display: block; font-size: 10.5px; font-weight: 600; }
.var.melhor { color: var(--green); }
.var.pior { color: var(--red); }
.var.neutro { color: var(--muted); }
td.anom-ambar { background: var(--anom-ambar) !important; }
td.anom-verm { background: var(--anom-verm) !important; }
.valor-positivo { color: var(--green); }
.valor-negativo { color: var(--red); }
.col-parcial { opacity: .75; }

/* Modal drill-down (usado na Task 6) */
.modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 50; }
.modal-bg.aberto { display: flex; align-items: center; justify-content: center; }
.modal { background: var(--bg2); border: 1px solid var(--border); border-radius: 14px;
  width: min(720px, 92vw); max-height: 82vh; display: flex; flex-direction: column; }
.modal-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px;
  border-bottom: 1px solid var(--border); }
.modal-head h2 { font-size: 15px; font-weight: 700; flex: 1; }
.modal-head button { background: none; border: none; color: var(--muted); font-size: 20px;
  cursor: pointer; line-height: 1; }
.modal-body { overflow-y: auto; padding: 8px 18px 16px; }
.modal-body table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.modal-body th { text-align: left; font-size: 11px; color: var(--muted); text-transform: uppercase;
  letter-spacing: .5px; padding: 8px 6px; border-bottom: 1px solid var(--border); }
.modal-body td { padding: 7px 6px; border-bottom: 1px solid var(--border); }
.modal-body td.num, .modal-body th.num { text-align: right; white-space: nowrap; }
.modal-body tr.soma td { font-weight: 700; border-bottom: none; }
.modal-aviso { font-size: 12px; color: var(--yellow); padding: 6px 0; }
</style>
</head>
<body>
<script src="/js/shared-nav.js" data-active="financeiro"></script>
<div class="main-content">
<div class="fin-wrap">

  <div class="fin-header">
    <h1>Financeiro — DRE</h1>
  </div>

  <div class="fin-links">
    <a class="fin-link" href="/financeiro/a-categorizar.html">A categorizar</a>
    <a class="fin-link" href="/financeiro/lancamentos.html">Lançamentos</a>
    <a class="fin-link" href="/financeiro/cadastros.html">Cadastros</a>
  </div>

  <div class="fin-controls">
    <label for="from">De</label>
    <input type="month" id="from" />
    <label for="to">Até</label>
    <input type="month" id="to" />
    <button class="btn btn-primary" id="btnCarregar" onclick="carregar()">Ver DRE</button>
    <button class="btn btn-ghost" id="btnSync" onclick="sincronizar()">Atualizar dados</button>
  </div>

  <div class="banner-semcat" id="semCat"></div>
  <div class="kpis" id="kpis"></div>

  <div id="dreMsg">Carregando…</div>
  <div id="dreWrap" style="display:none" class="dre-wrap">
    <div id="dre"></div>
  </div>

</div>
</div>

<div class="modal-bg" id="drillBg">
  <div class="modal">
    <div class="modal-head">
      <h2 id="drillTitulo"></h2>
      <button onclick="fecharDrill()" aria-label="Fechar">×</button>
    </div>
    <div class="modal-body" id="drillBody"></div>
  </div>
</div>

<script src="/js/financeiro/api.js"></script>
<script src="/js/financeiro/dre-analise.js"></script>
<script src="/js/financeiro/dre-page.js"></script>
</body>
</html>
```

- [ ] **Step 2: Criar `public/js/financeiro/dre-page.js` (parte 1 — tabela)**

```js
// Página da DRE v2 — orquestra FinAPI + DREAnalise e renderiza a tabela/KPIs.
(function () {
  const A = window.DREAnalise;

  // Esqueleto da cascata: grupos na ordem do GRUPOS_DRE + subtotais intercalados.
  const LINHAS = [
    { tipo: 'grupo', codigo: '1', natureza: 'entrada' },
    { tipo: 'grupo', codigo: '2', natureza: 'saida' },
    { tipo: 'subtotal', chave: 'receitaLiquida', label: 'RECEITA LÍQUIDA' },
    { tipo: 'grupo', codigo: '3.0', natureza: 'saida' },
    { tipo: 'grupo', codigo: '3.1', natureza: 'saida' },
    { tipo: 'grupo', codigo: '3.2', natureza: 'saida' },
    { tipo: 'grupo', codigo: '3.3', natureza: 'saida' },
    { tipo: 'subtotal', chave: 'lucroBruto', label: 'LUCRO BRUTO' },
    { tipo: 'grupo', codigo: '4', natureza: 'saida' },
    { tipo: 'subtotal', chave: 'resultadoOperacional', label: 'RESULTADO OPERACIONAL' },
    { tipo: 'grupo', codigo: '5', natureza: 'saida' },
    { tipo: 'grupo', codigo: '7', natureza: 'saida' },
    { tipo: 'subtotal', chave: 'resultadoFinal', label: 'RESULTADO FINAL' },
  ];

  const $ = (id) => document.getElementById(id);
  const fmt = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtPct = (f) => (f * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
  const fmtMes = (ym) => {
    const [y, m] = ym.split('-');
    return ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][Number(m) - 1] + '/' + y.slice(2);
  };
  const valorClass = (v) => Number(v) >= 0 ? 'valor-positivo' : 'valor-negativo';

  // Defaults: mês corrente
  (function () {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    $('from').value = ym;
    $('to').value = ym;
  })();

  const lastDayOf = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  };

  // Estado de expansão dos grupos
  const LS_KEY = 'dre_grupos_abertos';
  let abertos;
  try { abertos = new Set(JSON.parse(localStorage.getItem(LS_KEY) || '[]')); }
  catch { abertos = new Set(); }
  const salvarAbertos = () => localStorage.setItem(LS_KEY, JSON.stringify([...abertos]));

  window._dreState = null; // { meses, semCat, from, to, mesesCompletos }

  window.carregar = async function carregar() {
    const fromYm = $('from').value, toYm = $('to').value;
    const msg = $('dreMsg'), wrap = $('dreWrap'), btn = $('btnCarregar');
    if (!fromYm || !toYm || fromYm > toYm) {
      msg.textContent = 'Selecione um período válido.'; msg.style.display = '';
      wrap.style.display = 'none'; return;
    }
    const nMeses = (Number(toYm.slice(0, 4)) - Number(fromYm.slice(0, 4))) * 12
      + (Number(toYm.slice(5)) - Number(fromYm.slice(5))) + 1;
    if (nMeses > 24) {
      msg.textContent = 'Período máximo: 24 meses.'; msg.style.display = '';
      wrap.style.display = 'none'; return;
    }
    const from = fromYm + '-01';
    const to = toYm + '-' + String(lastDayOf(toYm)).padStart(2, '0');

    msg.textContent = 'Carregando…'; msg.style.display = '';
    wrap.style.display = 'none'; $('kpis').style.display = 'none';
    $('semCat').style.display = 'none'; btn.disabled = true;
    try {
      const r = await FinAPI.dreMensal(from, to);
      const hoje = new Date();
      const mesesCompletos = r.meses.filter(m => A.mesCompleto(m.ym, hoje));
      window._dreState = { meses: r.meses, semCat: r.sem_categoria, from, to, mesesCompletos };
      renderSemCat(r.sem_categoria);
      renderTabela(window._dreState);
      if (window.renderKpis) window.renderKpis(window._dreState); // Task 6
      msg.style.display = 'none'; wrap.style.display = '';
    } catch (e) {
      msg.textContent = 'Erro ao carregar DRE: ' + e.message;
      msg.style.display = ''; wrap.style.display = 'none';
    } finally { btn.disabled = false; }
  };

  window.sincronizar = async function sincronizar() {
    const btn = $('btnSync');
    btn.disabled = true; btn.textContent = 'Sincronizando…';
    try {
      await FinAPI.sync();
      btn.textContent = 'Sincronizado!';
      await window.carregar();
    } catch (e) {
      $('dreMsg').textContent = 'Erro ao sincronizar: ' + e.message;
      $('dreMsg').style.display = '';
    } finally {
      btn.disabled = false;
      setTimeout(() => { btn.textContent = 'Atualizar dados'; }, 2000);
    }
  };

  function renderSemCat(sc) {
    const el = $('semCat');
    if (!sc || !sc.qtd) { el.style.display = 'none'; return; }
    el.innerHTML = `⚠️ <b>${sc.qtd}</b> lançamento${sc.qtd > 1 ? 's' : ''} sem categoria no período ` +
      `(<b>${fmt(sc.total)}</b> fora da DRE) — ` +
      `<a href="/financeiro/a-categorizar.html">categorizar agora</a>`;
    el.style.display = '';
  }

  // ── Tabela ──────────────────────────────────────────────────────────────────
  function renderTabela(st) {
    const { meses, mesesCompletos } = st;
    const multi = meses.length > 1;
    const hoje = new Date();
    const subs = meses.map(m => A.subtotais(m));
    const subTotal = A.subtotais(somarMeses(meses));
    const receitaBrutaTotal = subTotal.receitaBruta;
    const nComp = mesesCompletos.length;

    let html = '<table class="dre"><thead><tr><th class="col-conta">Conta</th>';
    if (multi) {
      for (const m of meses) {
        const parcial = !A.mesCompleto(m.ym, hoje);
        html += `<th${parcial ? ' class="col-parcial" title="mês em andamento (fora da média)"' : ''}>${fmtMes(m.ym)}${parcial ? '*' : ''}</th>`;
      }
      html += '<th>Média</th>';
    }
    html += '<th>Total</th><th>AV%</th></tr></thead><tbody>';

    for (const linha of LINHAS) {
      if (linha.tipo === 'grupo') html += renderGrupo(linha, st, subs, receitaBrutaTotal, nComp, multi);
      else html += renderSubtotal(linha, subs, subTotal, receitaBrutaTotal, multi);
    }
    html += '</tbody></table>';
    $('dre').innerHTML = html;

    // toggle de grupos
    for (const tr of document.querySelectorAll('tr.grupo')) {
      tr.addEventListener('click', () => {
        const cod = tr.dataset.grupo;
        if (abertos.has(cod)) abertos.delete(cod); else abertos.add(cod);
        salvarAbertos();
        renderTabela(window._dreState);
      });
    }
    if (window.plugarDrill) window.plugarDrill(); // Task 6
  }

  function somarMeses(meses) {
    // DRE "total": soma grupo a grupo e conta a conta
    const porGrupo = new Map();
    for (const m of meses) for (const g of (m.grupos || [])) {
      if (!porGrupo.has(g.codigo)) porGrupo.set(g.codigo, { codigo: g.codigo, titulo: g.titulo, total: 0, contas: new Map() });
      const ag = porGrupo.get(g.codigo);
      ag.total += g.total;
      for (const c of (g.contas || [])) {
        if (!ag.contas.has(c.codigo)) ag.contas.set(c.codigo, { codigo: c.codigo, nome: c.nome, total: 0 });
        ag.contas.get(c.codigo).total += c.total;
      }
    }
    const grupos = [...porGrupo.values()].map(g => ({ ...g, contas: [...g.contas.values()] }));
    return { grupos };
  }

  const acharGrupo = (dre, cod) => (dre.grupos || []).find(g => g.codigo === cod);

  function celulaValor({ valor, anterior, natureza, mediaVal, nComp, ehSaida, parcial }) {
    const pct = A.variacao(natureza, valor, anterior);
    const cls = A.classeVariacao(natureza, pct);
    const anom = (ehSaida && !parcial) ? A.nivelAnomalia(valor, mediaVal, nComp) : null;
    let td = `<td class="${anom ? 'anom-' + (anom === 'vermelho' ? 'verm' : 'ambar') : ''}${parcial ? ' col-parcial' : ''}"`;
    if (anom) td += ` title="${fmt(valor)} vs média ${fmt(mediaVal)}"`;
    td += `>${fmt(valor)}`;
    if (pct != null) {
      td += `<span class="var ${cls || 'neutro'}">${pct > 0 ? '▲' : '▼'} ${fmtPct(Math.abs(pct))}</span>`;
    }
    return td + '</td>';
  }

  function renderGrupo(linha, st, subs, receitaBrutaTotal, nComp, multi) {
    const { meses, mesesCompletos } = st;
    const hoje = new Date();
    const cod = linha.codigo;
    const grupoTotal = acharGrupo(somarMeses(meses), cod) || { titulo: tituloGrupo(meses, cod), total: 0, contas: [] };
    const aberto = abertos.has(cod);
    const valores = meses.map(m => (acharGrupo(m, cod) || {}).total || 0);
    const mediaVal = A.media(mesesCompletos.map(m => (acharGrupo(m, cod) || {}).total || 0));

    let html = `<tr class="grupo${aberto ? ' aberto' : ''}" data-grupo="${cod}">` +
      `<td class="col-conta"><span class="chev">▸</span>${grupoTotal.titulo}</td>`;
    if (multi) {
      valores.forEach((v, i) => {
        html += celulaValor({
          valor: v, anterior: i > 0 ? valores[i - 1] : null, natureza: linha.natureza,
          mediaVal, nComp, ehSaida: linha.natureza === 'saida',
          parcial: !A.mesCompleto(meses[i].ym, hoje),
        });
      });
      html += `<td>${mediaVal == null ? '–' : fmt(mediaVal)}</td>`;
    }
    const avG = A.av(grupoTotal.total, receitaBrutaTotal);
    html += `<td class="${valorClass(grupoTotal.total)}">${fmt(grupoTotal.total)}</td>` +
      `<td>${avG == null ? '–' : fmtPct(avG)}</td></tr>`;

    if (aberto) {
      // união de contas (do total somado — cobre conta que só existe num mês)
      for (const conta of grupoTotal.contas.sort((a, b) => a.codigo < b.codigo ? -1 : 1)) {
        html += `<tr class="conta"><td class="col-conta">${conta.codigo} ${conta.nome}</td>`;
        if (multi) {
          const vals = meses.map(m => {
            const g = acharGrupo(m, cod);
            return ((g && g.contas.find(c => c.codigo === conta.codigo)) || {}).total || 0;
          });
          const medC = A.media(mesesCompletos.map(m => {
            const g = acharGrupo(m, cod);
            return ((g && g.contas.find(c => c.codigo === conta.codigo)) || {}).total || 0;
          }));
          vals.forEach((v, i) => {
            const parcial = !A.mesCompleto(meses[i].ym, hoje);
            const pct = A.variacao(linha.natureza, v, i > 0 ? vals[i - 1] : null);
            const cls = A.classeVariacao(linha.natureza, pct);
            const anom = (linha.natureza === 'saida' && !parcial) ? A.nivelAnomalia(v, medC, nComp) : null;
            html += `<td class="valor-conta ${anom ? 'anom-' + (anom === 'vermelho' ? 'verm' : 'ambar') : ''}${parcial ? ' col-parcial' : ''}"` +
              ` data-conta="${conta.codigo}" data-ym="${meses[i].ym}"` +
              (anom ? ` title="${fmt(v)} vs média ${fmt(medC)}"` : '') + `>${fmt(v)}`;
            if (pct != null) html += `<span class="var ${cls || 'neutro'}">${pct > 0 ? '▲' : '▼'} ${fmtPct(Math.abs(pct))}</span>`;
            html += '</td>';
          });
          html += `<td>${medC == null ? '–' : fmt(medC)}</td>`;
        }
        const avC = A.av(conta.total, receitaBrutaTotal);
        html += `<td class="valor-conta" data-conta="${conta.codigo}" data-ym="total">${fmt(conta.total)}</td>` +
          `<td>${avC == null ? '–' : fmtPct(avC)}</td></tr>`;
      }
    }
    return html;
  }

  function tituloGrupo(meses, cod) {
    for (const m of meses) { const g = acharGrupo(m, cod); if (g) return g.titulo; }
    return cod;
  }

  function renderSubtotal(linha, subs, subTotal, receitaBrutaTotal, multi) {
    const hoje = new Date();
    const st = window._dreState;
    let html = `<tr class="subtotal"><td class="col-conta">${linha.label}</td>`;
    if (multi) {
      const vals = subs.map(s => s[linha.chave]);
      vals.forEach((v, i) => {
        const parcial = !A.mesCompleto(st.meses[i].ym, hoje);
        const pct = A.variacao('entrada', v, i > 0 ? vals[i - 1] : null);
        const cls = A.classeVariacao('entrada', pct);
        const margem = A.av(v, subs[i].receitaBruta);
        html += `<td class="${valorClass(v)}${parcial ? ' col-parcial' : ''}">${fmt(v)}` +
          (margem != null ? `<span class="margem">${fmtPct(margem)}</span>` : '') +
          (pct != null ? `<span class="var ${cls || 'neutro'}">${pct > 0 ? '▲' : '▼'} ${fmtPct(Math.abs(pct))}</span>` : '') +
          '</td>';
      });
      const medS = A.media(st.mesesCompletos.map(m => A.subtotais(m)[linha.chave]));
      html += `<td>${medS == null ? '–' : fmt(medS)}</td>`;
    }
    const total = subTotal[linha.chave];
    const margemT = A.av(total, receitaBrutaTotal);
    html += `<td class="${valorClass(total)}">${fmt(total)}` +
      (margemT != null ? `<span class="margem">${fmtPct(margemT)}</span>` : '') + '</td>' +
      `<td>${margemT == null ? '–' : fmtPct(margemT)}</td></tr>`;
    return html;
  }

  window.carregar();
})();
```

- [ ] **Step 3: Verificar sintaxe**

Run: `node --check public/js/financeiro/dre-page.js`
Expected: sem erro. (O arquivo referencia `window`/`document`, mas `--check` só valida sintaxe.)

- [ ] **Step 4: Smoke visual local (se .env local tiver Supabase) ou revisão manual do HTML**

Se `node server.js` subir localmente: abrir `http://localhost:3000/financeiro/`, logar, conferir 1 mês (colunas Conta|Total|AV%) e 3+ meses (colunas mensais + Média, subtotais em destaque, grupos colapsam). Senão, seguir — o smoke completo é a Task 7.

- [ ] **Step 5: Commit**

```bash
git add public/financeiro/index.html public/js/financeiro/dre-page.js
git commit -m "feat(financeiro): DRE v2 — cascata, colunas mensais, AV%, variação, média e anomalia"
```

---

### Task 6: Página — KPIs (PE, projeção, maior desvio) + drill-down

**Files:**
- Modify: `public/js/financeiro/dre-page.js` (acrescentar no MESMO arquivo, antes do `window.carregar()` final)

**Interfaces:**
- Consumes: `window._dreState` (Task 5), células `[data-conta][data-ym]`, `FinAPI.contas()`, `FinAPI.lancamentos({conta_id, from, to})`, `DREAnalise.pontoEquilibrio/projecaoMes/maiorDesvio/subtotais/mesCompleto`.
- Produces: `window.renderKpis(st)` e `window.plugarDrill()` (chamados pela Task 5); `window.fecharDrill()` (botão do modal).

- [ ] **Step 1: Acrescentar KPIs e drill-down ao dre-page.js**

Inserir dentro da IIFE, imediatamente antes da linha final `window.carregar();`:

```js
  // ── KPIs (Task 6) ───────────────────────────────────────────────────────────
  window.renderKpis = function renderKpis(st) {
    const { meses, mesesCompletos } = st;
    const hoje = new Date();
    // Âncora no mês corrente DE VERDADE (não "primeiro incompleto": um período que
    // termina em mês futuro tem meses vazios incompletos e pegaria o mês errado).
    const ymCorrente = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    const mesCorrente = meses.find(m => m.ym === ymCorrente) || null;
    const total = A.subtotais(somarMeses(meses));
    const cards = [];

    cards.push(`<div class="kpi"><div class="kpi-label">Receita Bruta</div>
      <div class="kpi-valor">${fmt(total.receitaBruta)}</div>
      <div class="kpi-sub">${meses.length} ${meses.length > 1 ? 'meses' : 'mês'}</div></div>`);

    const margem = A.av(total.resultadoFinal, total.receitaBruta);
    cards.push(`<div class="kpi"><div class="kpi-label">Resultado Final</div>
      <div class="kpi-valor ${valorClass(total.resultadoFinal)}">${fmt(total.resultadoFinal)}</div>
      <div class="kpi-sub">margem ${margem == null ? '–' : fmtPct(margem)}</div></div>`);

    const pe = A.pontoEquilibrio(mesesCompletos);
    if (pe.erro) {
      cards.push(`<div class="kpi"><div class="kpi-label">Ponto de Equilíbrio</div>
        <div class="kpi-valor">–</div><div class="kpi-sub">${pe.erro}</div></div>`);
    } else {
      let barra = '';
      if (mesCorrente) {
        const receitaMes = A.somaGrupos(mesCorrente, ['1']);
        const frac = Math.min(receitaMes / pe.pe, 1);
        barra = `<div class="barra"><div class="${frac >= 1 ? 'ok' : ''}" style="width:${(frac * 100).toFixed(0)}%"></div></div>
          <div class="kpi-sub">mês atual: ${fmt(receitaMes)} (${fmtPct(receitaMes / pe.pe)})</div>`;
      }
      cards.push(`<div class="kpi"><div class="kpi-label">Ponto de Equilíbrio</div>
        <div class="kpi-valor">${fmt(pe.pe)}/mês</div>
        <div class="kpi-sub">MC ${fmtPct(pe.mcPct)} · fixas ${fmt(pe.fixasMediaMes)}/mês</div>${barra}</div>`);
    }

    if (mesCorrente) {
      const p = A.projecaoMes(mesCorrente, mesesCompletos, hoje);
      if (p) {
        cards.push(`<div class="kpi" title="Receita linear por dia corrido; variáveis pelo % histórico; fixas pela ${p.fixasAproximada ? 'projeção linear do próprio mês (aproximada)' : 'média dos meses completos'}. Financeiras/investimentos fora.">
          <div class="kpi-label">Projeção ${fmtMes(mesCorrente.ym)}<span class="selo">projeção</span></div>
          <div class="kpi-valor ${valorClass(p.resultadoProj)}">${fmt(p.resultadoProj)}</div>
          <div class="kpi-sub">receita proj. ${fmt(p.receitaProj)}</div></div>`);
      }
    }

    const desvio = A.maiorDesvio(mesesCompletos);
    if (desvio) {
      cards.push(`<div class="kpi clicavel" id="kpiDesvio" data-conta="${desvio.codigo}" data-ym="${desvio.ym}">
        <div class="kpi-label">Maior Desvio (${fmtMes(desvio.ym)})</div>
        <div class="kpi-valor valor-negativo">${desvio.nome}</div>
        <div class="kpi-sub">${fmt(desvio.valor)} vs média ${fmt(desvio.media)} (+${fmtPct(desvio.pct)}) — clique p/ ver</div></div>`);
    }

    const el = $('kpis');
    el.innerHTML = cards.join('');
    el.style.display = 'grid';
    const kd = $('kpiDesvio');
    if (kd) kd.addEventListener('click', () => abrirDrill(kd.dataset.conta, kd.dataset.ym));
  };

  // ── Drill-down (Task 6) ─────────────────────────────────────────────────────
  let _contasCache = null; // [{id, codigo, nome}]
  async function contaPorCodigo(codigo) {
    if (!_contasCache) _contasCache = await FinAPI.contas();
    return (_contasCache || []).find(c => c.codigo === codigo) || null;
  }

  window.plugarDrill = function plugarDrill() {
    for (const td of document.querySelectorAll('td.valor-conta[data-conta]')) {
      td.addEventListener('click', (ev) => {
        ev.stopPropagation();
        abrirDrill(td.dataset.conta, td.dataset.ym);
      });
    }
  };

  window.fecharDrill = () => { $('drillBg').classList.remove('aberto'); };
  $('drillBg').addEventListener('click', (e) => { if (e.target === $('drillBg')) window.fecharDrill(); });

  async function abrirDrill(codigo, ym) {
    const st = window._dreState;
    const bg = $('drillBg'), body = $('drillBody'), titulo = $('drillTitulo');
    let from = st.from, to = st.to, rotulo = 'período';
    if (ym !== 'total') {
      from = ym + '-01';
      to = ym + '-' + String(lastDayOf(ym)).padStart(2, '0');
      rotulo = fmtMes(ym);
    }
    bg.classList.add('aberto');
    body.innerHTML = '<p style="padding:20px;color:var(--muted)">Carregando…</p>';
    try {
      const conta = await contaPorCodigo(codigo);
      if (!conta) throw new Error('conta não encontrada no cadastro');
      titulo.textContent = `${conta.codigo} ${conta.nome} — ${rotulo}`;
      const lancs = await FinAPI.lancamentos({ conta_id: conta.id, from, to });
      lancs.sort((a, b) => Math.abs(b.valor) - Math.abs(a.valor));
      const soma = lancs.reduce((s, l) => s + (l.fluxo === 'entra' ? 1 : -1) * Number(l.valor), 0);
      let html = lancs.length >= 2000 ? '<div class="modal-aviso">⚠️ Lista truncada em 2000 lançamentos — a soma abaixo pode não bater com a célula.</div>' : '';
      html += '<table><thead><tr><th>Data</th><th>Descrição</th><th class="num">Valor</th></tr></thead><tbody>';
      for (const l of lancs) {
        html += `<tr><td>${(l.data || '').split('-').reverse().join('/')}</td>` +
          `<td>${l.descricao || ''}</td>` +
          `<td class="num ${l.fluxo === 'entra' ? 'valor-positivo' : ''}">${fmt((l.fluxo === 'entra' ? 1 : -1) * Number(l.valor))}</td></tr>`;
      }
      html += `<tr class="soma"><td colspan="2">Soma (${lancs.length})</td><td class="num ${valorClass(soma)}">${fmt(soma)}</td></tr>`;
      html += '</tbody></table>';
      body.innerHTML = html;
    } catch (e) {
      body.innerHTML = `<p style="padding:20px;color:var(--red)">Erro: ${e.message}</p>`;
    }
  }
```

- [ ] **Step 2: Verificar sintaxe + suíte**

Run: `node --check public/js/financeiro/dre-page.js && npm test`
Expected: sem erro; suíte verde.

- [ ] **Step 3: Commit**

```bash
git add public/js/financeiro/dre-page.js
git commit -m "feat(financeiro): DRE v2 — KPIs (PE, projeção, maior desvio) e drill-down de lançamentos"
```

---

### Task 7: Push, deploy e smoke em produção

**Files:** nenhum novo (deploy + verificação).

- [ ] **Step 1: Suíte final**

Run: `npm test` — Expected: tudo verde.

- [ ] **Step 2: Push**

```bash
git pull --rebase origin main && git push origin main
```

Se o push for rejeitado com histórico realmente divergente (outra sessão), NÃO forçar: criar branch a partir de `origin/main`, cherry-pick dos commits desta feature, push da branch e merge.

- [ ] **Step 3: Deploy Easypanel (sem perguntar — fluxo padrão)**

```bash
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

- [ ] **Step 4: Verificar que o deploy trocou o CONTEÚDO servido**

```bash
curl -s "https://plataformaama-plataforma.uc5as5.easypanel.host/financeiro/" | grep -c "dre-page.js"
```

Expected: `1` (ou mais). Se continuar `0` após ~2 min, o swap do Easypanel travou → avisar o Luiz para Stop→Start no painel (NUNCA Destroy).

- [ ] **Step 5: Smoke via Playwright (logado) OU checklist para o Luiz**

Se houver credenciais de teste: abrir `/financeiro/`, selecionar jan–jun/2026, conferir: (1) banner de não categorizados se houver; (2) KPIs aparecem (PE com valor, projeção se período incluir julho); (3) subtotais RECEITA LÍQUIDA/LUCRO BRUTO/RESULTADO OPERACIONAL/RESULTADO FINAL; (4) expandir grupo 3.1 e clicar num valor → modal com lançamentos cuja soma bate com a célula; (5) uma célula âmbar/vermelha tem tooltip com a média. Senão, registrar esses 5 passos como pendência de validação do Luiz.

- [ ] **Step 6: Atualizar memória de pendências**

Adicionar item na lista `pending_tests.md` (memória): "DRE v2 deployada — validar logado" com o checklist do Step 5, e registrar commit hash.
