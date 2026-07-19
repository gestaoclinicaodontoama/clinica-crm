# Modo de Planejamento (Produção ①) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Todo orçamento aprovado no Clinicorp nasce automaticamente na Sucesso (`pacientes_sucesso`) e vira um plano de tratamento com etapas/executor/tempos montado pelo dentista (ou por delegação — Mônica), substituindo a Conferência.

**Architecture:** Nova fase do sync noturno lê a tabela `orcamentos` (já sincronizada — **zero chamadas novas à API Clinicorp**), cria pacientes na Sucesso + planos com triagem automática; lógica pura (estados, triagem, duplicata, re-sync) em `lib/planejamento/` com testes; rotas `/api/planejamento/*` no server.js; página única `/planejamento/` com 3 abas por papel (Planejar / Suspeitas / Gestora).

**Tech Stack:** Node.js + Express (server.js), Supabase (Postgres + RLS), front vanilla (padrão do CRM), `node --test` para unit.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-19-modo-planejamento-design.md` — em conflito, a spec vence.
- **Zero chamadas novas à API Clinicorp** (limite ~25/h): tudo deriva de `orcamentos`/`agenda_appointments` já sincronizadas. Sync manual = `runGuardedSync('manual')` já existente (server.js:5745).
- Toda tabela nova: `ENABLE ROW LEVEL SECURITY`, sem policy (front nunca lê direto; tudo via `/api` + service_role) — regra do CLAUDE.md.
- Status do plano: `aguardando_planejamento | planejado | em_andamento | concluido | descartado | cancelado`. Veredito CRC usa `cancelado` (motivo `duplicata`/`nao_venda`) — NUNCA `descartado`.
- `plano_pendente` (visão da Sucesso) = existe plano do estimate com status em `{aguardando_planejamento}` — computado, sem coluna nova em `pacientes_sucesso`.
- "Plano ativo" (dispensa na auditoria) = status em `{aguardando_planejamento, planejado, em_andamento}`.
- Tempo NUNCA multiplica pela quantidade — padrão sugere, humano crava.
- Config única `prazo_escalonamento_dias` (default 7) para os 2 alertas.
- Commits frequentes; mensagens em pt-BR estilo do repo (`feat:`/`fix:`/`spec:`); rodar `npm test` antes de cada commit.
- Deploy só na Task 10 (migração aplicada via MCP Supabase ANTES do deploy do código).

---

### Task 1: Verificações V1–V3 (sonda e documenta — não escreve código de produção)

**Files:**
- Create: `scripts/verificar-planejamento.js`
- Create: `docs/superpowers/specs/2026-07-19-verificacoes-planejamento.md` (resultado)

**Interfaces:**
- Produces: documento com decisões V1 (itens/quantidade por estimate), V2 (como cancelamento aparece), V3 (mapa profissional→usuário) que as Tasks 2 e 4 consomem.

- [ ] **Step 1: Escrever o script de sonda (1 chamada à API + consultas ao banco)**

```js
// scripts/verificar-planejamento.js — sonda V1/V2/V3 da spec do Modo de Planejamento.
// Uso: node scripts/verificar-planejamento.js   (1 única chamada à API Clinicorp)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BASE = 'https://api.clinicorp.com/rest/v1';
const user = process.env.CLINICORP_USER, token = process.env.CLINICORP_TOKEN;
const auth = 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');

async function apiGet(path, params) {
  const qs = new URLSearchParams({ subscriber_id: user, business_id: user, ...params });
  const r = await fetch(`${BASE}${path}?${qs}`, { headers: { Authorization: auth, 'X-Api-Key': token } });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return r.json();
}

(async () => {
  // V1 — um estimate APROVADO recente: dump das chaves do estimate e de 1 item da ProcedureList
  const hoje = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const ests = await apiGet('/estimates/list', { from, to: hoje });
  const aprovado = (Array.isArray(ests) ? ests : []).find(e => e.Status === 'APPROVED' && (e.ProcedureList || []).length);
  console.log('=== V1: chaves do estimate ===\n', aprovado ? Object.keys(aprovado).sort().join(', ') : 'NENHUM APROVADO NA JANELA');
  if (aprovado) {
    console.log('=== V1: item[0] da ProcedureList (procurar: status por item? quantidade?) ===');
    console.log(JSON.stringify(aprovado.ProcedureList[0], null, 2));
    const qtdKeys = Object.keys(aprovado.ProcedureList[0]).filter(k => /qty|quant|amount|tooth|dente/i.test(k));
    console.log('candidatas a quantidade/dente:', qtdKeys.join(', ') || '(nenhuma)');
  }
  // V2 — domínios de status vistos no nosso banco (o que o sync enxerga)
  const { data: sts } = await supabase.rpc('exec_sql_readonly', {}).catch(() => ({ data: null }));
  const { data: statusRows } = await supabase.from('orcamentos').select('status').limit(1000);
  console.log('\n=== V2: valores distintos de orcamentos.status (amostra 1000) ===');
  console.log([...new Set((statusRows || []).map(r => r.status))].join(', '));
  // V3 — profissionais dos orçamentos aprovados × usuários com role dentista
  const { data: profs } = await supabase.from('orcamentos').select('profissional_nome').eq('status', 'APPROVED').limit(1000);
  const contagem = {};
  for (const p of profs || []) contagem[p.profissional_nome || '(vazio)'] = (contagem[p.profissional_nome || '(vazio)'] || 0) + 1;
  console.log('\n=== V3: profissional_nome dos APPROVED (contagem) ===');
  console.log(JSON.stringify(contagem, null, 2));
  const { data: users } = await supabase.from('profiles').select('id, email, roles');
  console.log('\n=== V3: usuários com role dentista ===');
  for (const u of users || []) if ((u.roles || []).includes('dentista')) console.log(u.email, u.id);
})();
```

- [ ] **Step 2: Rodar e capturar a saída**

Run: `node scripts/verificar-planejamento.js`
Expected: dump das chaves do estimate + item, lista de status distintos (esperado ao menos `APPROVED`; anotar se existe `CANCELED`/`REPROVED` etc.), contagem por profissional, lista de dentistas com login.

- [ ] **Step 3: Registrar as decisões no documento**

Criar `docs/superpowers/specs/2026-07-19-verificacoes-planejamento.md` com, obrigatoriamente:
- **V1:** existe campo de quantidade por item? (se NÃO: `quantidade` do plano_itens default 1 e agrupamento por `PriceId` repetido — N linhas do mesmo PriceId = quantidade N). Existe status de aprovação POR ITEM? (se NÃO: fallback da spec — plano do orçamento inteiro; itens com `Executed='X'` nascem `concluida_retroativa`).
- **V2:** tabela "o que o sync enxerga quando venda é desfeita" → regra concreta: se aparecer status ≠ APPROVED para estimate que já tem plano → `cancelado`; "sumiu do retorno" NÃO cancela sozinho (janela móvel de 120d gera falso-positivo) — só marca `fora_da_janela` em log.
- **V3:** tabela profissional_nome → user_id (preencher com os dentistas achados; quem não mapeia fica NULL → fila da gestora). Contar % de APPROVED não-mapeáveis.

- [ ] **Step 4: Commit**

```bash
git add scripts/verificar-planejamento.js docs/superpowers/specs/2026-07-19-verificacoes-planejamento.md
git commit -m "feat(planejamento): sonda V1-V3 + decisões de verificação documentadas"
```

---

### Task 2: Migração — tabelas do planejamento + seed da população 4

**Files:**
- Create: `supabase/migrations/20260719120000_modo_planejamento.sql`

**Interfaces:**
- Produces: tabelas `plano_tratamento`, `plano_itens` (self-ref p/ sub-lotes), `plano_etapas`, `processos_padrao`, `planejamento_config` (linha única), `planejamento_dentistas` (mapa profissional→usuário); coluna `orcamentos.procedure_list jsonb`.

- [ ] **Step 1: Escrever a migração**

```sql
-- Modo de Planejamento (Produção ①) — spec docs/superpowers/specs/2026-07-19-modo-planejamento-design.md

-- Snapshot dos itens do orçamento (preenchido pelo syncOrcamentos; zero chamadas novas)
ALTER TABLE orcamentos ADD COLUMN IF NOT EXISTS procedure_list jsonb;

CREATE TABLE IF NOT EXISTS plano_tratamento (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinicorp_estimate_id text UNIQUE NOT NULL,
  paciente_clinicorp_id text,
  paciente_nome text,
  dentista_avaliador_id uuid,          -- usuário do CRM (nullable → fila da gestora)
  planejado_por uuid,                  -- quem preencheu (delegação: Mônica) — pode diferir do responsável
  status text NOT NULL DEFAULT 'aguardando_planejamento'
    CHECK (status IN ('aguardando_planejamento','planejado','em_andamento','concluido','descartado','cancelado')),
  status_motivo text,                  -- 'duplicata' | 'nao_venda' | 'rejeitado_conferencia' | 'venda_desfeita' | 'sem_etapas' | livre
  valor numeric, entrada numeric,      -- espelho read-only do Clinicorp
  orientacao_clinica text,             -- avaliador → executor (sensível)
  recado_sucesso text,                 -- avaliador → CRC Sucesso
  possivel_duplicata boolean NOT NULL DEFAULT false,
  duplicata_de text,                   -- estimate_id irmão apontado pela heurística
  divergencia_reportada boolean NOT NULL DEFAULT false,
  divergencia_texto text,
  trava_resync text,                   -- motivo da trava (item/qtde alterado com etapas executadas); NULL = sem trava
  trocas_responsavel jsonb NOT NULL DEFAULT '[]',  -- [{de, para, por, em}]
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  planejado_em timestamptz
);
CREATE INDEX IF NOT EXISTS idx_plano_trat_status ON plano_tratamento(status);
CREATE INDEX IF NOT EXISTS idx_plano_trat_dentista ON plano_tratamento(dentista_avaliador_id);

-- Itens: linha raiz (parent_id NULL) = item do orçamento; filhos = sub-lotes.
-- Etapas penduram em FOLHAS (item sem filhos = 1 sub-lote implícito; regra na lib).
CREATE TABLE IF NOT EXISTS plano_itens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plano_id bigint NOT NULL REFERENCES plano_tratamento(id) ON DELETE CASCADE,
  parent_id bigint REFERENCES plano_itens(id) ON DELETE CASCADE,
  price_id text, procedure_name text NOT NULL,
  quantidade int NOT NULL DEFAULT 1 CHECK (quantidade >= 1),
  rotulo text,                         -- "4 superiores", "2 inferiores"…
  ordem int NOT NULL DEFAULT 0,
  removido_em timestamptz              -- re-sync: item removido sem etapas executadas (histórico)
);
CREATE INDEX IF NOT EXISTS idx_plano_itens_plano ON plano_itens(plano_id);

CREATE TABLE IF NOT EXISTS plano_etapas (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES plano_itens(id) ON DELETE CASCADE,
  ordem int NOT NULL DEFAULT 0,
  descricao text NOT NULL,
  profissional_executor text,          -- nome (livre; casa com dentist_name da produção)
  tempo_planejado_min int,
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','concluida','concluida_retroativa')),
  tempo_real_min int,                  -- entrega ②
  asb_responsavel uuid,                -- entrega ②
  concluida_em timestamptz
);
CREATE INDEX IF NOT EXISTS idx_plano_etapas_item ON plano_etapas(item_id);

CREATE TABLE IF NOT EXISTS processos_padrao (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  price_id text,                       -- casa com catálogo (96,6%); NULL = padrão por nome
  procedure_name text NOT NULL,
  requer_plano boolean NOT NULL DEFAULT true,
  margem_alvo numeric,                 -- override; NULL = usa default da config (entrega ③)
  etapas jsonb NOT NULL DEFAULT '[]',  -- [{descricao, profissional_sugerido, tempo_sugerido_min}]
  status text NOT NULL DEFAULT 'aprovado' CHECK (status IN ('rascunho','aprovado')),
  criado_por uuid, criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_processos_padrao_price ON processos_padrao(price_id) WHERE price_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS planejamento_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  custo_hora_clinica numeric NOT NULL DEFAULT 180,     -- varia no tempo; UI na entrega ③
  margem_alvo_default numeric NOT NULL DEFAULT 20,
  prazo_escalonamento_dias int NOT NULL DEFAULT 7,     -- config ÚNICA dos 2 alertas
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
INSERT INTO planejamento_config (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS planejamento_dentistas (
  profissional_nome text PRIMARY KEY,  -- como vem em orcamentos.profissional_nome
  user_id uuid,                        -- NULL = não mapeado → fila da gestora
  ativo boolean NOT NULL DEFAULT true
);

-- Segurança (regra da casa): RLS ligado, SEM policy — front nunca lê direto, tudo via /api (service_role)
ALTER TABLE plano_tratamento      ENABLE ROW LEVEL SECURITY;
ALTER TABLE plano_itens           ENABLE ROW LEVEL SECURITY;
ALTER TABLE plano_etapas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE processos_padrao      ENABLE ROW LEVEL SECURITY;
ALTER TABLE planejamento_config   ENABLE ROW LEVEL SECURITY;
ALTER TABLE planejamento_dentistas ENABLE ROW LEVEL SECURITY;

-- POPULAÇÃO 4 do cutover (spec): aprovados já REJEITADOS pela CRC antiga viram 'cancelado'
-- (lista de supressão do sync) NO MESMO deploy — senão o 1º sync ressuscita casos já julgados.
INSERT INTO plano_tratamento (clinicorp_estimate_id, paciente_clinicorp_id, paciente_nome, status, status_motivo, valor, entrada)
SELECT o.clinicorp_estimate_id, o.paciente_clinicorp_id, o.paciente_nome,
       'cancelado', 'rejeitado_conferencia', o.valor_particular, o.entrada_valor
FROM orcamentos o
WHERE o.revisao_status = 'rejeitado'
ON CONFLICT (clinicorp_estimate_id) DO NOTHING;
```

- [ ] **Step 2: Aplicar via MCP Supabase** (`apply_migration`, project `mtqdpjhhqzvuklnlfpvi`) e conferir com `list_migrations`.

- [ ] **Step 3: Verificar RLS**

Via MCP Supabase (`execute_sql`): `SELECT tablename, rowsecurity FROM pg_tables WHERE tablename LIKE 'plano%' OR tablename LIKE 'planejamento%' OR tablename = 'processos_padrao';`
Expected: `rowsecurity = true` em todas.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260719120000_modo_planejamento.sql
git commit -m "feat(planejamento): tabelas do modo de planejamento + seed população 4 (rejeitados da Conferência)"
```

---

### Task 3: `lib/planejamento/triagem.js` — triagem `requer_plano` + heurística de duplicata (TDD)

**Files:**
- Create: `lib/planejamento/triagem.js`
- Test: `lib/planejamento/triagem.test.js`

**Interfaces:**
- Produces:
  - `agruparItens(procedureList) → [{ price_id, procedure_name, quantidade, executados }]` — agrupa a ProcedureList crua por PriceId (N linhas iguais = quantidade N); `executados` = quantas linhas com `Executed==='X'`.
  - `requerPlano(itensAgrupados, padroesByPriceId) → boolean` — false só se TODOS os itens têm padrão com `requer_plano=false`.
  - `heuristicaDuplicata(orc, orcsAprovadosRecentes) → { suspeito: boolean, de: string|null }` — mesmo `paciente_clinicorp_id`, outro estimate APPROVED, `|dias entre data_fechamento| <= 30`, e ≥1 `price_id` em comum.

- [ ] **Step 1: Escrever os testes que falham**

```js
// lib/planejamento/triagem.test.js
const test = require('node:test');
const assert = require('node:assert');
const { agruparItens, requerPlano, heuristicaDuplicata } = require('./triagem');

test('agruparItens: N linhas do mesmo PriceId viram quantidade N', () => {
  const lista = [
    { PriceId: 10, ProcedureName: 'Faceta', Executed: '' },
    { PriceId: 10, ProcedureName: 'Faceta', Executed: '' },
    { PriceId: 10, ProcedureName: 'Faceta', Executed: 'X' },
    { PriceId: 22, ProcedureName: 'Clareamento', Executed: '' },
  ];
  const r = agruparItens(lista);
  assert.equal(r.length, 2);
  const faceta = r.find(i => i.price_id === '10');
  assert.equal(faceta.quantidade, 3);
  assert.equal(faceta.executados, 1);
});

test('agruparItens: lista vazia/nula → []', () => {
  assert.deepEqual(agruparItens(null), []);
  assert.deepEqual(agruparItens([]), []);
});

test('requerPlano: false só quando TODOS os itens dispensam', () => {
  const padroes = new Map([['10', { requer_plano: false }], ['22', { requer_plano: true }]]);
  assert.equal(requerPlano([{ price_id: '10' }], padroes), false);
  assert.equal(requerPlano([{ price_id: '10' }, { price_id: '22' }], padroes), true);
  // item SEM padrão cadastrado → requer plano (default conservador da spec)
  assert.equal(requerPlano([{ price_id: '99' }], padroes), true);
});

test('heuristicaDuplicata: mesmo paciente + item em comum + janela 30d → suspeito', () => {
  const orc = { clinicorp_estimate_id: 'B', paciente_clinicorp_id: 'P1', data_fechamento: '2026-07-10',
                itens: [{ price_id: '10' }] };
  const outros = [
    { clinicorp_estimate_id: 'A', paciente_clinicorp_id: 'P1', data_fechamento: '2026-06-25',
      itens: [{ price_id: '10' }, { price_id: '22' }] },
  ];
  const r = heuristicaDuplicata(orc, outros);
  assert.equal(r.suspeito, true);
  assert.equal(r.de, 'A');
});

test('heuristicaDuplicata: fora da janela OU sem item em comum OU outro paciente → não suspeito', () => {
  const orc = { clinicorp_estimate_id: 'B', paciente_clinicorp_id: 'P1', data_fechamento: '2026-07-10', itens: [{ price_id: '10' }] };
  assert.equal(heuristicaDuplicata(orc, [{ clinicorp_estimate_id: 'A', paciente_clinicorp_id: 'P1', data_fechamento: '2026-01-01', itens: [{ price_id: '10' }] }]).suspeito, false);
  assert.equal(heuristicaDuplicata(orc, [{ clinicorp_estimate_id: 'A', paciente_clinicorp_id: 'P1', data_fechamento: '2026-07-01', itens: [{ price_id: '22' }] }]).suspeito, false);
  assert.equal(heuristicaDuplicata(orc, [{ clinicorp_estimate_id: 'A', paciente_clinicorp_id: 'P2', data_fechamento: '2026-07-01', itens: [{ price_id: '10' }] }]).suspeito, false);
  // não compara consigo mesmo
  assert.equal(heuristicaDuplicata(orc, [orc]).suspeito, false);
});
```

- [ ] **Step 2: Rodar e ver falhar** — `npm test` → Expected: FAIL (`Cannot find module './triagem'`).

- [ ] **Step 3: Implementar**

```js
// lib/planejamento/triagem.js — lógica pura da triagem e da heurística de duplicata.
// Spec: docs/superpowers/specs/2026-07-19-modo-planejamento-design.md

/** Agrupa a ProcedureList crua por PriceId: N linhas iguais = quantidade N. */
function agruparItens(procedureList) {
  const by = new Map();
  for (const p of procedureList || []) {
    const pid = p.PriceId != null ? String(p.PriceId) : `nome:${p.ProcedureName || ''}`;
    const cur = by.get(pid) || { price_id: p.PriceId != null ? String(p.PriceId) : null,
      procedure_name: p.ProcedureName || p.Name || '', quantidade: 0, executados: 0 };
    cur.quantidade += 1;
    if (p.Executed === 'X') cur.executados += 1;
    by.set(pid, cur);
  }
  return [...by.values()];
}

/** false só se TODOS os itens têm padrão com requer_plano=false (item sem padrão → requer). */
function requerPlano(itens, padroesByPriceId) {
  if (!itens || !itens.length) return true;
  return !itens.every(i => padroesByPriceId.get(String(i.price_id))?.requer_plano === false);
}

const JANELA_DUP_DIAS = 30;
/** Mesmo paciente + outro APPROVED em ≤30d + ≥1 price_id em comum → possível duplicata (renegociação). */
function heuristicaDuplicata(orc, outros) {
  const meus = new Set((orc.itens || []).map(i => String(i.price_id)));
  const d0 = orc.data_fechamento ? new Date(orc.data_fechamento).getTime() : null;
  for (const o of outros || []) {
    if (o.clinicorp_estimate_id === orc.clinicorp_estimate_id) continue;
    if (!o.paciente_clinicorp_id || o.paciente_clinicorp_id !== orc.paciente_clinicorp_id) continue;
    if (d0 == null || !o.data_fechamento) continue;
    const dias = Math.abs(d0 - new Date(o.data_fechamento).getTime()) / 864e5;
    if (dias > JANELA_DUP_DIAS) continue;
    if ((o.itens || []).some(i => meus.has(String(i.price_id)))) return { suspeito: true, de: o.clinicorp_estimate_id };
  }
  return { suspeito: false, de: null };
}

module.exports = { agruparItens, requerPlano, heuristicaDuplicata, JANELA_DUP_DIAS };
```

- [ ] **Step 4: Rodar e ver passar** — `npm test` → Expected: PASS (todos).

- [ ] **Step 5: Commit** — `git add lib/planejamento/ && git commit -m "feat(planejamento): triagem requer_plano + heurística de duplicata (TDD)"`

---

### Task 4: `lib/planejamento/estados.js` — máquina de estados + regras de re-sync + conservação de sub-lotes (TDD)

**Files:**
- Create: `lib/planejamento/estados.js`
- Test: `lib/planejamento/estados.test.js`

**Interfaces:**
- Consumes: formato `{ price_id, quantidade }` de `agruparItens` (Task 3).
- Produces:
  - `transicaoValida(de, para) → boolean` — grafo: aguardando→planejado→em_andamento→concluido; de QUALQUER não-lateral pode ir a descartado/cancelado; laterais podem voltar a aguardando_planejamento (maleabilidade/ressurreição).
  - `validarSubLotes(quantidadeItem, subLotes) → { ok, erro? }` — soma das quantidades = quantidade do item.
  - `aplicarResync({ plano, itensPlano, itensNovos }) → { acoes: [...] }` — implementa a tabela da spec; ações: `{tipo:'adicionar_item'|'remover_item'|'travar'|'regredir'|'ressuscitar'|'atualizar_valor'|'cancelar', ...}`. `itensPlano` inclui `etapas_executadas` (bool por item).

- [ ] **Step 1: Escrever os testes que falham**

```js
// lib/planejamento/estados.test.js
const test = require('node:test');
const assert = require('node:assert');
const { transicaoValida, validarSubLotes, aplicarResync } = require('./estados');

test('transições do fluxo principal e laterais', () => {
  assert.equal(transicaoValida('aguardando_planejamento', 'planejado'), true);
  assert.equal(transicaoValida('planejado', 'em_andamento'), true);
  assert.equal(transicaoValida('em_andamento', 'concluido'), true);
  assert.equal(transicaoValida('planejado', 'concluido'), false);       // não pula
  assert.equal(transicaoValida('aguardando_planejamento', 'descartado'), true);
  assert.equal(transicaoValida('planejado', 'cancelado'), true);
  assert.equal(transicaoValida('descartado', 'aguardando_planejamento'), true); // ressurreição
  assert.equal(transicaoValida('cancelado', 'aguardando_planejamento'), true);  // maleabilidade
  assert.equal(transicaoValida('concluido', 'aguardando_planejamento'), true);  // regressão por re-sync
  assert.equal(transicaoValida('descartado', 'planejado'), false);
});

test('validarSubLotes: conservação da quantidade', () => {
  assert.equal(validarSubLotes(6, [{ quantidade: 4 }, { quantidade: 2 }]).ok, true);
  assert.equal(validarSubLotes(6, [{ quantidade: 4 }, { quantidade: 3 }]).ok, false);
  assert.equal(validarSubLotes(6, []).ok, false);
});

test('re-sync: item adicionado regride plano planejado', () => {
  const r = aplicarResync({
    plano: { status: 'planejado' },
    itensPlano: [{ price_id: '10', quantidade: 6, etapas_executadas: false }],
    itensNovos: [{ price_id: '10', quantidade: 6 }, { price_id: '22', quantidade: 1 }],
  });
  assert.ok(r.acoes.some(a => a.tipo === 'adicionar_item' && a.price_id === '22'));
  assert.ok(r.acoes.some(a => a.tipo === 'regredir'));
});

test('re-sync: item adicionado ressuscita plano descartado', () => {
  const r = aplicarResync({
    plano: { status: 'descartado' },
    itensPlano: [{ price_id: '10', quantidade: 1, etapas_executadas: false }],
    itensNovos: [{ price_id: '10', quantidade: 1 }, { price_id: '22', quantidade: 1 }],
  });
  assert.ok(r.acoes.some(a => a.tipo === 'ressuscitar'));
});

test('re-sync: item removido sem etapas → remover; com etapas → travar', () => {
  const base = { plano: { status: 'planejado' }, itensNovos: [{ price_id: '10', quantidade: 6 }] };
  const sem = aplicarResync({ ...base, itensPlano: [{ price_id: '10', quantidade: 6, etapas_executadas: false }, { price_id: '22', quantidade: 1, etapas_executadas: false }] });
  assert.ok(sem.acoes.some(a => a.tipo === 'remover_item' && a.price_id === '22'));
  const com = aplicarResync({ ...base, itensPlano: [{ price_id: '10', quantidade: 6, etapas_executadas: false }, { price_id: '22', quantidade: 1, etapas_executadas: true }] });
  assert.ok(com.acoes.some(a => a.tipo === 'travar'));
});

test('re-sync: quantidade alterada sem etapas → regredir+replanejar; com etapas → travar', () => {
  const sem = aplicarResync({ plano: { status: 'planejado' },
    itensPlano: [{ price_id: '10', quantidade: 6, etapas_executadas: false }],
    itensNovos: [{ price_id: '10', quantidade: 4 }] });
  assert.ok(sem.acoes.some(a => a.tipo === 'regredir'));
  const com = aplicarResync({ plano: { status: 'planejado' },
    itensPlano: [{ price_id: '10', quantidade: 6, etapas_executadas: true }],
    itensNovos: [{ price_id: '10', quantidade: 4 }] });
  assert.ok(com.acoes.some(a => a.tipo === 'travar'));
});

test('re-sync: status revertido no Clinicorp → cancelar; plano travado não recebe ação nova', () => {
  const r = aplicarResync({ plano: { status: 'planejado' }, statusClinicorp: 'CANCELED',
    itensPlano: [], itensNovos: [] });
  assert.ok(r.acoes.some(a => a.tipo === 'cancelar'));
  const travado = aplicarResync({ plano: { status: 'planejado', trava_resync: 'item removido' },
    itensPlano: [{ price_id: '10', quantidade: 1, etapas_executadas: false }],
    itensNovos: [] });
  assert.deepEqual(travado.acoes, []);   // trava = humano decide antes de qualquer reconciliação nova
});
```

- [ ] **Step 2: Rodar e ver falhar** — `npm test` → FAIL (`Cannot find module './estados'`).

- [ ] **Step 3: Implementar**

```js
// lib/planejamento/estados.js — máquina de estados e regras de re-sync (tabela da spec).
const FLUXO = { aguardando_planejamento: ['planejado'], planejado: ['em_andamento'], em_andamento: ['concluido'], concluido: [] };
const LATERAIS = ['descartado', 'cancelado'];

function transicaoValida(de, para) {
  if (LATERAIS.includes(para)) return !LATERAIS.includes(de);                 // qualquer ativo → lateral
  if (para === 'aguardando_planejamento') return de !== 'aguardando_planejamento'; // regressão/ressurreição/maleabilidade
  return (FLUXO[de] || []).includes(para);
}

function validarSubLotes(quantidadeItem, subLotes) {
  const soma = (subLotes || []).reduce((s, l) => s + (Number(l.quantidade) || 0), 0);
  if (!subLotes || !subLotes.length) return { ok: false, erro: 'nenhum sub-lote' };
  if (soma !== Number(quantidadeItem)) return { ok: false, erro: `soma dos sub-lotes (${soma}) ≠ quantidade do item (${quantidadeItem})` };
  return { ok: true };
}

/** Tabela de re-sync da spec. plano travado → nenhuma ação nova até humano destravar. */
function aplicarResync({ plano, itensPlano, itensNovos, statusClinicorp }) {
  const acoes = [];
  if (plano.trava_resync) return { acoes };
  if (statusClinicorp && statusClinicorp !== 'APPROVED') {
    acoes.push({ tipo: 'cancelar', motivo: 'venda_desfeita', statusClinicorp });
    return { acoes };
  }
  const atuais = new Map((itensPlano || []).map(i => [String(i.price_id), i]));
  const novos  = new Map((itensNovos || []).map(i => [String(i.price_id), i]));
  let regride = false, ressuscita = false;

  for (const [pid, novo] of novos) {
    const cur = atuais.get(pid);
    if (!cur) {
      acoes.push({ tipo: 'adicionar_item', price_id: pid, quantidade: novo.quantidade, procedure_name: novo.procedure_name });
      if (plano.status === 'descartado') ressuscita = true; else regride = true;
    } else if (Number(cur.quantidade) !== Number(novo.quantidade)) {
      if (cur.etapas_executadas) acoes.push({ tipo: 'travar', motivo: `quantidade de ${pid} mudou (${cur.quantidade}→${novo.quantidade}) com etapas executadas` });
      else { acoes.push({ tipo: 'atualizar_quantidade', price_id: pid, quantidade: novo.quantidade }); regride = true; }
    }
  }
  for (const [pid, cur] of atuais) {
    if (!novos.has(pid)) {
      if (cur.etapas_executadas) acoes.push({ tipo: 'travar', motivo: `item ${pid} removido no Clinicorp com etapas executadas` });
      else acoes.push({ tipo: 'remover_item', price_id: pid });
    }
  }
  if (acoes.some(a => a.tipo === 'travar')) return { acoes: acoes.filter(a => a.tipo === 'travar') };
  if (ressuscita) acoes.push({ tipo: 'ressuscitar' });
  else if (regride && ['planejado', 'em_andamento', 'concluido'].includes(plano.status)) acoes.push({ tipo: 'regredir' });
  return { acoes };
}

module.exports = { transicaoValida, validarSubLotes, aplicarResync };
```

- [ ] **Step 4: Rodar e ver passar** — `npm test` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(planejamento): máquina de estados + regras de re-sync + conservação de sub-lotes (TDD)"`

---

### Task 5: Sync — snapshot de itens + fase `planejamento` + desligar hook antigo (cutover)

**Files:**
- Modify: `sync/clinicorp-sync.js` (syncOrcamentos ~linha 421; runSync fase nova após linha 957)
- Modify: `server.js:4966-4998` (hook da Conferência)

**Interfaces:**
- Consumes: `agruparItens`, `requerPlano`, `heuristicaDuplicata` (Task 3); `aplicarResync`, `transicaoValida` (Task 4); tabelas da Task 2.
- Produces: fase `planejamento` no runSync que (a) cria `pacientes_sucesso` (dedup estimate_id) para APPROVED não-suprimidos, (b) cria/atualiza `plano_tratamento`+`plano_itens`, (c) aplica re-sync. Exporta `syncPlanejamento` para o backfill (Task 6).

- [ ] **Step 1: `syncOrcamentos` passa a persistir o snapshot dos itens**

Em `sync/clinicorp-sync.js`, dentro do loop de `syncOrcamentos()` (após a linha `clinicorp_lastchange: ...`), adicionar ao objeto do `byId.set`:

```js
      procedure_list:        Array.isArray(o.ProcedureList) ? o.ProcedureList.map(p => ({
                               PriceId: p.PriceId ?? null, ProcedureName: p.ProcedureName || p.Name || '',
                               Executed: p.Executed || '', Dentist_PersonId: p.Dentist_PersonId ?? null,
                               ProfessionalName: p.ProfessionalName || null, Amount: p.Amount ?? null,
                             })) : null,
```

- [ ] **Step 2: Escrever `syncPlanejamento()` no fim de `sync/clinicorp-sync.js` (antes do `module.exports`)**

```js
// ─── Modo de Planejamento (Produção ①) ────────────────────────────────────────
// Deriva TUDO da tabela `orcamentos` (zero chamadas novas à API).
const { agruparItens, requerPlano, heuristicaDuplicata } = require('../lib/planejamento/triagem');
const { aplicarResync } = require('../lib/planejamento/estados');

async function syncPlanejamento() {
  // 1) universo: orçamentos APPROVED da janela + planos existentes + padrões + mapa de dentistas
  const orcs = await selectAll('orcamentos',
    'clinicorp_estimate_id, paciente_clinicorp_id, paciente_nome, telefone, profissional_nome, valor_particular, entrada_valor, status, data_fechamento, lead_id, procedure_list',
    q => q.eq('status', 'APPROVED').not('data_fechamento', 'is', null));
  const planos = await selectAll('plano_tratamento', 'id, clinicorp_estimate_id, status, trava_resync, valor, entrada');
  const planosByEst = new Map(planos.map(p => [p.clinicorp_estimate_id, p]));
  const padroesArr = await selectAll('processos_padrao', 'price_id, requer_plano, etapas, status', q => q.not('price_id', 'is', null));
  const padroes = new Map(padroesArr.map(p => [String(p.price_id), p]));
  const { data: mapaArr } = await supabase.from('planejamento_dentistas').select('profissional_nome, user_id').eq('ativo', true);
  const mapa = new Map((mapaArr || []).map(m => [m.profissional_nome, m.user_id]));

  // pré-computa itens agrupados por orçamento (p/ heurística e criação)
  const comItens = orcs.map(o => ({ ...o, itens: agruparItens(o.procedure_list) }));

  let criadosSucesso = 0, criadosPlanos = 0, resyncs = 0;
  for (const o of comItens) {
    const estId = o.clinicorp_estimate_id;
    const jaTem = planosByEst.get(estId);

    if (jaTem) {
      // RE-SYNC: compara itens do plano com o snapshot atual
      if (['cancelado'].includes(jaTem.status)) continue;   // supressão (pop. 4 e vereditos)
      const { data: itensPlano } = await supabase.from('plano_itens')
        .select('id, price_id, quantidade, removido_em, plano_etapas(status)')
        .eq('plano_id', jaTem.id).is('parent_id', null).is('removido_em', null);
      const itensFmt = (itensPlano || []).map(i => ({
        price_id: i.price_id, quantidade: i.quantidade,
        etapas_executadas: (i.plano_etapas || []).some(e => e.status !== 'pendente'),
      }));
      const { acoes } = aplicarResync({ plano: jaTem, itensPlano: itensFmt, itensNovos: o.itens, statusClinicorp: o.status });
      if (acoes.length) { resyncs++; await executarAcoesResync(jaTem, acoes, o); }
      // espelho de valor/entrada sempre atual
      if (Number(jaTem.valor) !== Number(o.valor_particular) || Number(jaTem.entrada) !== Number(o.entrada_valor)) {
        await supabase.from('plano_tratamento').update({ valor: o.valor_particular, entrada: o.entrada_valor, atualizado_em: new Date().toISOString() }).eq('id', jaTem.id);
      }
      continue;
    }

    // NOVO orçamento aprovado →
    // (a) paciente nasce na Sucesso IMEDIATAMENTE (dedup por estimate_id — mesma lógica do hook antigo)
    const { data: jaSucesso } = await supabase.from('pacientes_sucesso').select('id, excluido_em').eq('clinicorp_estimate_id', estId).limit(1);
    if (jaSucesso?.length && jaSucesso[0].excluido_em) {
      await supabase.from('pacientes_sucesso').update({ excluido_em: null }).eq('id', jaSucesso[0].id);
    } else if (!jaSucesso?.length) {
      await supabase.from('pacientes_sucesso').insert({
        lead_id: o.lead_id || null, clinicorp_estimate_id: estId, nome: o.paciente_nome || '',
        telefone: o.telefone || '', data_venda: o.data_fechamento, valor_fechado: Number(o.valor_particular || 0),
        importado_historico: false,
      });
      criadosSucesso++;
    }

    // (b) plano com triagem + heurística de duplicata + padrão PRÉ-APLICADO
    const precisa = requerPlano(o.itens, padroes);
    const dup = heuristicaDuplicata(o, comItens.filter(x => x.clinicorp_estimate_id !== estId && planosByEst.get(x.clinicorp_estimate_id)?.status !== 'cancelado'));
    const { data: plano, error } = await supabase.from('plano_tratamento').insert({
      clinicorp_estimate_id: estId, paciente_clinicorp_id: o.paciente_clinicorp_id, paciente_nome: o.paciente_nome,
      dentista_avaliador_id: mapa.get(o.profissional_nome) || null,
      status: precisa ? 'aguardando_planejamento' : 'descartado',
      status_motivo: precisa ? null : 'sem_etapas',
      valor: o.valor_particular, entrada: o.entrada_valor,
      possivel_duplicata: dup.suspeito, duplicata_de: dup.de,
    }).select('id').single();
    if (error) { log(`ERRO plano ${estId}: ${error.message}`); continue; }
    criadosPlanos++;

    // itens raiz + etapas do padrão pré-aplicadas (Decisão 4 da spec: dentista CONFIRMA)
    for (const [ordem, item] of o.itens.entries()) {
      const { data: itemRow } = await supabase.from('plano_itens').insert({
        plano_id: plano.id, price_id: item.price_id, procedure_name: item.procedure_name,
        quantidade: item.quantidade, ordem,
      }).select('id').single();
      const padrao = padroes.get(String(item.price_id));
      const etapas = (padrao?.etapas || []).map((e, i) => ({
        item_id: itemRow.id, ordem: i, descricao: e.descricao,
        profissional_executor: e.profissional_sugerido || null,
        tempo_planejado_min: e.tempo_sugerido_min || null,     // sugestão do LOTE — nunca multiplicada
        status: item.executados >= item.quantidade ? 'concluida_retroativa' : 'pendente',
      }));
      if (etapas.length) await supabase.from('plano_etapas').insert(etapas);
    }
  }
  log(`Planejamento: +${criadosSucesso} pacientes_sucesso, +${criadosPlanos} planos, ${resyncs} re-syncs`);
  return { criadosSucesso, criadosPlanos, resyncs };
}

async function executarAcoesResync(plano, acoes, orc) {
  const now = new Date().toISOString();
  for (const a of acoes) {
    if (a.tipo === 'travar') {
      await supabase.from('plano_tratamento').update({ trava_resync: a.motivo, atualizado_em: now }).eq('id', plano.id);
    } else if (a.tipo === 'cancelar') {
      await supabase.from('plano_tratamento').update({ status: 'cancelado', status_motivo: a.motivo, atualizado_em: now }).eq('id', plano.id);
      // espelha na Sucesso: soft-delete NÃO — marca via exclusão suave apenas se política atual permitir; aqui registra sem deletar
    } else if (a.tipo === 'adicionar_item') {
      await supabase.from('plano_itens').insert({ plano_id: plano.id, price_id: a.price_id, procedure_name: a.procedure_name || '', quantidade: a.quantidade || 1, ordem: 99 });
    } else if (a.tipo === 'remover_item') {
      await supabase.from('plano_itens').update({ removido_em: now }).eq('plano_id', plano.id).eq('price_id', a.price_id).is('parent_id', null);
    } else if (a.tipo === 'atualizar_quantidade') {
      await supabase.from('plano_itens').update({ quantidade: a.quantidade }).eq('plano_id', plano.id).eq('price_id', a.price_id).is('parent_id', null);
    } else if (a.tipo === 'regredir' || a.tipo === 'ressuscitar') {
      await supabase.from('plano_tratamento').update({ status: 'aguardando_planejamento', status_motivo: a.tipo === 'ressuscitar' ? 'item novo requer plano' : 'orçamento alterado no Clinicorp', atualizado_em: now }).eq('id', plano.id);
    }
  }
}
```

- [ ] **Step 3: Registrar a fase no `runSync` (após a fase `producao`, ~linha 957) e o gatilho `em_andamento`**

```js
  // Fase 7e: modo de planejamento (deriva de `orcamentos`; zero chamadas à API)
  await step('planejamento', async () => {
    const r = await syncPlanejamento();
    result.steps.planejamento = `${r.criadosPlanos} planos, ${r.criadosSucesso} sucesso`;
  });

  // Fase 7f: planejado → em_andamento no 1º comparecimento APÓS o plano atingir 'planejado'
  // (gatilho por paciente — limitação aceita na spec; preciso de novo na entrega ②)
  await step('planejamento_andamento', async () => {
    const { data: pl } = await supabase.from('plano_tratamento')
      .select('id, paciente_clinicorp_id, planejado_em').eq('status', 'planejado').not('planejado_em', 'is', null);
    let flips = 0;
    for (const p of pl || []) {
      const { data: comp } = await supabase.from('agenda_appointments')
        .select('id').eq('paciente_clinicorp_id', p.paciente_clinicorp_id)
        .eq('compareceu', true).gte('appointment_date', p.planejado_em.slice(0, 10)).limit(1);
      if (comp?.length) {
        await supabase.from('plano_tratamento').update({ status: 'em_andamento', atualizado_em: new Date().toISOString() }).eq('id', p.id);
        flips++;
      }
    }
    result.steps.planejamento_andamento = flips;
  });
```

⚠️ Conferir o nome real da coluna de data em `agenda_appointments` (a spec do Registro Diário usa `appointment_date`) — ajustar se divergir.

- [ ] **Step 4: Desligar o hook antigo (MESMO deploy — regra de cutover da spec)**

Em `server.js`, dentro do `POST /api/comercial/conferencia/:estimateId` (linhas 4966-4998): **remover o bloco inteiro** `(async () => { ... pacientes_sucesso ... })();` e substituir por:

```js
      // CUTOVER (spec Modo de Planejamento 19/07): pacientes_sucesso agora nasce no SYNC
      // (fase 'planejamento'), na aprovação do Clinicorp. Este endpoint segue vivo só até
      // a fila antiga zerar; 'rejeitar' vira insumo da lista de supressão (plano cancelado).
      if (acao === 'rejeitar') {
        await supabase.from('plano_tratamento')
          .upsert({ clinicorp_estimate_id: id, paciente_nome: orc.paciente_nome || '', status: 'cancelado', status_motivo: 'rejeitado_conferencia' }, { onConflict: 'clinicorp_estimate_id' });
      }
```

- [ ] **Step 5: Rodar os testes e o sync em dry-run local** — `npm test` (PASS) e `node -e "require('./sync/clinicorp-sync')"` (carrega sem erro de sintaxe).

- [ ] **Step 6: Commit** — `git commit -am "feat(planejamento): fase de sync (Sucesso na aprovação + planos + re-sync + gatilho em_andamento); cutover do hook da Conferência"`

---

### Task 6: Backfill (populações 1–3) + seed do mapa de dentistas e padrões iniciais

**Files:**
- Create: `scripts/backfill-planejamento.js`

**Interfaces:**
- Consumes: `syncPlanejamento` já cobre a criação (pop. 1 e 2 são só "rodar a fase"); resultados V3 (Task 1).
- Produces: banco populado; lista impressa dos tratamentos longos em curso (pop. 3) para a gestora priorizar.

- [ ] **Step 1: Escrever o script**

```js
// scripts/backfill-planejamento.js — vira a chave do Modo de Planejamento.
// Pop. 1 (conferidos-não-planejados) e Pop. 2 (aprovados-não-conferidos): a própria fase
// syncPlanejamento cria os planos com triagem — basta rodá-la uma vez aqui.
// Pop. 3 (tratamentos longos EM CURSO): imprime a lista priorizada p/ a gestora planejar retroativo.
// Pop. 4 (rejeitados): já semeada na migration.
// Pré-requisito: preencher planejamento_dentistas com o mapa do V3 (seed abaixo) ANTES de rodar.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const MAPA_V3 = [
  // Preencher com o resultado da Task 1 (V3): { profissional_nome: 'NOME COMO VEM NO ORCAMENTO', user_id: 'uuid-do-crm' }
];
const PADROES_INICIAIS = [
  // Semear ao menos os 2 casos-motivo do projeto + o caso de triagem:
  { procedure_name: 'Faceta', requer_plano: true, etapas: [
    { descricao: 'Preparo + moldagem', profissional_sugerido: null, tempo_sugerido_min: 90 },
    { descricao: 'Prova', profissional_sugerido: null, tempo_sugerido_min: 45 },
    { descricao: 'Cimentação / entrega', profissional_sugerido: null, tempo_sugerido_min: 60 } ] },
  { procedure_name: 'Protocolo', requer_plano: true, etapas: [
    { descricao: 'Cirurgia / instalação dos implantes', profissional_sugerido: null, tempo_sugerido_min: 180 },
    { descricao: 'Moldagem do provisório', profissional_sugerido: null, tempo_sugerido_min: 60 },
    { descricao: 'Instalação do provisório', profissional_sugerido: null, tempo_sugerido_min: 90 },
    { descricao: 'Osseointegração (~6 meses)', profissional_sugerido: null, tempo_sugerido_min: 0 },
    { descricao: 'Moldagem do definitivo', profissional_sugerido: null, tempo_sugerido_min: 60 },
    { descricao: 'Prova', profissional_sugerido: null, tempo_sugerido_min: 45 },
    { descricao: 'Instalação do definitivo', profissional_sugerido: null, tempo_sugerido_min: 90 } ] },
  { procedure_name: 'Profilaxia (limpeza)', requer_plano: false, etapas: [] },
];

(async () => {
  // 0) seeds — price_id casado por nome no catálogo (producao_procedimentos.procedure_name)
  for (const m of MAPA_V3) await supabase.from('planejamento_dentistas').upsert(m, { onConflict: 'profissional_nome' });
  for (const p of PADROES_INICIAIS) {
    const { data: cat } = await supabase.from('producao_procedimentos').select('price_id')
      .ilike('procedure_name', `%${p.procedure_name}%`).not('price_id', 'is', null).limit(1);
    await supabase.from('processos_padrao').upsert(
      { ...p, price_id: cat?.[0]?.price_id || null, etapas: JSON.stringify ? p.etapas : p.etapas, status: 'aprovado' },
      { onConflict: 'price_id', ignoreDuplicates: true });
  }
  console.log('Seeds ok. Rodando a fase de planejamento (pop. 1 e 2)...');

  // 1+2) roda a fase do sync (deriva do banco; zero chamadas API)
  const { syncPlanejamento } = require('../sync/clinicorp-sync');
  console.log(await syncPlanejamento());

  // 3) lista dos tratamentos longos em curso p/ planejamento retroativo dirigido
  const { data: longos } = await supabase.from('plano_tratamento')
    .select('clinicorp_estimate_id, paciente_nome, valor, status')
    .eq('status', 'aguardando_planejamento').gte('valor', 5000).order('valor', { ascending: false }).limit(50);
  console.log('\n=== POP. 3 — priorizar retroativo (valor ≥ R$5.000, top 50) ===');
  for (const l of longos || []) console.log(`${l.paciente_nome} — R$${l.valor} — estimate ${l.clinicorp_estimate_id}`);
})();
```

- [ ] **Step 2: Exportar `syncPlanejamento`** — em `sync/clinicorp-sync.js`, adicionar `syncPlanejamento` ao `module.exports` existente.

- [ ] **Step 3: Preencher `MAPA_V3` com o resultado da Task 1** (sem placeholder no ato da execução — o executor copia do doc de verificações).

- [ ] **Step 4: Rodar APÓS o deploy da Task 10** (ordem no checklist da Task 10). Por ora: `node -e "require('./scripts/backfill-planejamento.js')"` NÃO deve ser rodado ainda — apenas `node --check scripts/backfill-planejamento.js` (sintaxe).

- [ ] **Step 5: Commit** — `git add scripts/ sync/ && git commit -m "feat(planejamento): backfill populações 1-3 + seeds (mapa dentistas, padrões faceta/protocolo/limpeza)"`

---

### Task 7: API — rotas `/api/planejamento/*`

**Files:**
- Modify: `server.js` (novo bloco após as rotas de conferência, ~linha 5003; middleware junto dos demais ~linha 509)

**Interfaces:**
- Consumes: `transicaoValida`, `validarSubLotes` (Task 4); tabelas (Task 2); `runGuardedSync` (existente, linha ~5745).
- Produces (contratos p/ a UI da Task 8):
  - `GET  /api/planejamento/fila?aba=planejar|suspeitas|gestora` → `{ planos: [...], config: { prazo_escalonamento_dias } }`
  - `GET  /api/planejamento/plano/:id` → `{ plano, itens: [{...iten, sublotes: [], etapas: []}], padroes_disponiveis }`
  - `PUT  /api/planejamento/plano/:id` body `{ etapasPorItem, subLotes?, orientacao_clinica, recado_sucesso, dentista_avaliador_id }` (salva rascunho)
  - `POST /api/planejamento/plano/:id/concluir` | `/descartar` | `/reativar` | `/destravar`
  - `POST /api/planejamento/plano/:id/veredito` body `{ veredito: 'duplicata'|'nao_venda'|'ok' }` (CRC)
  - `POST /api/planejamento/plano/:id/divergencia` body `{ texto }`
  - `GET/POST /api/planejamento/padroes` (+ `POST /api/planejamento/padroes/:id/aprovar` — gestor)

- [ ] **Step 1: Middleware e helpers (junto dos requireRole existentes, ~linha 509)**

```js
const requirePlanejamento = requireRole('dentista', 'gestor', 'admin', 'mod_planejamento');
const requirePlanejamentoGestor = requireRole('gestor', 'admin');
// veredito CRC reusa requireDashboardAvaliacao (gestor, admin, crc_comercial) já existente
```

- [ ] **Step 2: Escrever as rotas (bloco completo)**

```js
// ═══════════ MODO DE PLANEJAMENTO (Produção ①) ═══════════
const { transicaoValida: planTransicao, validarSubLotes: planValidarSubLotes } = require('./lib/planejamento/estados');

async function planCarregarPlano(id) {
  const { data: plano } = await supabase.from('plano_tratamento').select('*').eq('id', id).maybeSingle();
  if (!plano) return null;
  const { data: itens } = await supabase.from('plano_itens')
    .select('*, plano_etapas(*)').eq('plano_id', id).is('removido_em', null).order('ordem');
  const raizes = (itens || []).filter(i => !i.parent_id).map(r => ({
    ...r, sublotes: (itens || []).filter(i => i.parent_id === r.id),
  }));
  return { plano, itens: raizes };
}

app.get('/api/planejamento/fila', requireAuth, requirePlanejamento, rateLimit, async (req, res) => {
  try {
    const aba = String(req.query.aba || 'planejar');
    const { data: cfg } = await supabase.from('planejamento_config').select('*').eq('id', 1).single();
    const roles = req.user.profile?.roles || [];
    const soDentista = roles.includes('dentista') && !roles.some(r => ['gestor', 'admin', 'mod_planejamento'].includes(r));
    let q = supabase.from('plano_tratamento').select('*').order('criado_em', { ascending: true });
    if (aba === 'planejar') {
      q = q.eq('status', 'aguardando_planejamento');
      if (soDentista) q = q.eq('dentista_avaliador_id', req.user.id);   // dentista vê a própria fila; delegação vê todas
      else q = q.not('dentista_avaliador_id', 'is', null);
    } else if (aba === 'suspeitas') {
      q = q.or('possivel_duplicata.eq.true,divergencia_reportada.eq.true').not('status', 'in', '("cancelado")');
    } else if (aba === 'gestora') {
      q = q.or('dentista_avaliador_id.is.null,trava_resync.not.is.null').eq('status', 'aguardando_planejamento');
    } else return res.status(400).json({ error: 'aba inválida' });
    const { data, error } = await q.limit(500);
    if (error) throw error;
    res.json({ planos: data || [], config: { prazo_escalonamento_dias: cfg?.prazo_escalonamento_dias ?? 7 } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/planejamento/plano/:id', requireAuth, requirePlanejamento, rateLimit, async (req, res) => {
  try {
    const r = await planCarregarPlano(req.params.id);
    if (!r) return res.status(404).json({ error: 'plano não encontrado' });
    const priceIds = r.itens.map(i => i.price_id).filter(Boolean);
    const { data: padroes } = priceIds.length
      ? await supabase.from('processos_padrao').select('*').in('price_id', priceIds)
      : { data: [] };
    const { data: dentistas } = await supabase.from('planejamento_dentistas').select('*').eq('ativo', true);
    res.json({ ...r, padroes: padroes || [], dentistas: dentistas || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Salvar rascunho do plano (etapas, sub-lotes, textos, responsável). Delegação registra planejado_por.
app.put('/api/planejamento/plano/:id', requireAuth, requirePlanejamento, rateLimit, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { data: plano } = await supabase.from('plano_tratamento').select('id, status, dentista_avaliador_id, trocas_responsavel').eq('id', id).maybeSingle();
    if (!plano) return res.status(404).json({ error: 'plano não encontrado' });
    if (['cancelado', 'concluido'].includes(plano.status)) return res.status(409).json({ error: `plano ${plano.status} — reative antes de editar` });
    const b = req.body || {};
    const patch = { atualizado_em: new Date().toISOString(), planejado_por: req.user.id };
    if ('orientacao_clinica' in b) patch.orientacao_clinica = sanitizeStr(b.orientacao_clinica || '', 4000);
    if ('recado_sucesso' in b) patch.recado_sucesso = sanitizeStr(b.recado_sucesso || '', 2000);
    if ('dentista_avaliador_id' in b && b.dentista_avaliador_id !== plano.dentista_avaliador_id) {
      patch.dentista_avaliador_id = b.dentista_avaliador_id || null;   // troca livre (spec) — registra quem trocou
      patch.trocas_responsavel = [...(plano.trocas_responsavel || []),
        { de: plano.dentista_avaliador_id, para: b.dentista_avaliador_id || null, por: req.user.id, em: new Date().toISOString() }];
    }
    const { error } = await supabase.from('plano_tratamento').update(patch).eq('id', id);
    if (error) throw error;

    // sub-lotes: recria filhos do item (conservação validada); etapas: recria por item/sub-lote
    for (const item of b.itens || []) {
      if (Array.isArray(item.sublotes) && item.sublotes.length) {
        const { data: raiz } = await supabase.from('plano_itens').select('id, quantidade').eq('id', item.id).eq('plano_id', id).maybeSingle();
        if (!raiz) continue;
        const v = planValidarSubLotes(raiz.quantidade, item.sublotes);
        if (!v.ok) return res.status(400).json({ error: `sub-lotes de "${item.id}": ${v.erro}` });
        await supabase.from('plano_itens').delete().eq('parent_id', raiz.id);
        for (const [i, sl] of item.sublotes.entries()) {
          const { data: novo } = await supabase.from('plano_itens').insert({
            plano_id: id, parent_id: raiz.id, price_id: null, procedure_name: sl.rotulo || `Sub-lote ${i + 1}`,
            quantidade: sl.quantidade, rotulo: sl.rotulo || null, ordem: i }).select('id').single();
          sl._novoId = novo.id;
        }
      }
      // etapas do item (ou de cada sub-lote): recria as PENDENTES; preserva concluída/retroativa
      const alvos = (item.sublotes || []).length ? item.sublotes.map(s => s._novoId) : [item.id];
      for (const [ai, alvoId] of alvos.entries()) {
        const etapas = ((item.sublotes || []).length ? item.sublotes[ai].etapas : item.etapas) || [];
        await supabase.from('plano_etapas').delete().eq('item_id', alvoId).eq('status', 'pendente');
        const rows = etapas.filter(e => !e.id || e.status === 'pendente').map((e, i) => ({
          item_id: alvoId, ordem: i, descricao: sanitizeStr(e.descricao || '', 300),
          profissional_executor: sanitizeStr(e.profissional_executor || '', 120) || null,
          tempo_planejado_min: Number(e.tempo_planejado_min) || null, status: 'pendente' }));
        if (rows.length) await supabase.from('plano_etapas').insert(rows);
      }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Transições de estado (concluir/descartar/reativar/destravar) — máquina de estados da lib
app.post('/api/planejamento/plano/:id/:acao', requireAuth, requirePlanejamento, rateLimit, async (req, res) => {
  try {
    const { id, acao } = req.params;
    const { data: plano } = await supabase.from('plano_tratamento').select('id, status, trava_resync').eq('id', id).maybeSingle();
    if (!plano) return res.status(404).json({ error: 'plano não encontrado' });
    const now = new Date().toISOString();
    const mapa = {
      concluir:  { para: 'planejado', patch: { planejado_em: now, planejado_por: req.user.id } },
      descartar: { para: 'descartado', patch: { status_motivo: 'sem_etapas' } },
      reativar:  { para: 'aguardando_planejamento', patch: { status_motivo: null } },
    };
    if (acao === 'destravar') {                             // trava do re-sync → só gestor
      const roles = req.user.profile?.roles || [];
      if (!roles.some(r => ['gestor', 'admin'].includes(r))) return res.status(403).json({ error: 'só gestor destrava' });
      await supabase.from('plano_tratamento').update({ trava_resync: null, atualizado_em: now }).eq('id', id);
      return res.json({ ok: true });
    }
    if (acao === 'veredito') {                              // CRC: duplicata / nao_venda / ok
      const roles = req.user.profile?.roles || [];
      if (!roles.some(r => ['gestor', 'admin', 'crc_comercial'].includes(r))) return res.status(403).json({ error: 'sem permissão' });
      const v = String(req.body.veredito || '');
      if (v === 'ok') { await supabase.from('plano_tratamento').update({ possivel_duplicata: false, duplicata_de: null, divergencia_reportada: false, atualizado_em: now }).eq('id', id); return res.json({ ok: true }); }
      if (!['duplicata', 'nao_venda'].includes(v)) return res.status(400).json({ error: 'veredito inválido' });
      // spec: veredito usa CANCELADO (nunca 'descartado'); se plano tem etapas não-pendentes → trava (veredito tardio)
      const { data: exec } = await supabase.from('plano_etapas').select('id, plano_itens!inner(plano_id)').eq('plano_itens.plano_id', id).neq('status', 'pendente').limit(1);
      if (exec?.length) { await supabase.from('plano_tratamento').update({ trava_resync: `veredito ${v} com etapas executadas — decidir manualmente`, atualizado_em: now }).eq('id', id); return res.json({ ok: true, travado: true }); }
      await supabase.from('plano_tratamento').update({ status: 'cancelado', status_motivo: v, atualizado_em: now }).eq('id', id);
      return res.json({ ok: true });
    }
    if (acao === 'divergencia') {
      await supabase.from('plano_tratamento').update({ divergencia_reportada: true, divergencia_texto: sanitizeStr(req.body.texto || '', 500), atualizado_em: now }).eq('id', id);
      return res.json({ ok: true });
    }
    const t = mapa[acao];
    if (!t) return res.status(400).json({ error: 'ação inválida' });
    if (!planTransicao(plano.status, t.para)) return res.status(409).json({ error: `transição ${plano.status} → ${t.para} inválida` });
    const { error } = await supabase.from('plano_tratamento').update({ status: t.para, atualizado_em: now, ...t.patch }).eq('id', id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Banco de processos: listar/criar rascunho (qualquer planejador) + aprovar (gestor)
app.get('/api/planejamento/padroes', requireAuth, requirePlanejamento, rateLimit, async (req, res) => {
  try { const { data, error } = await supabase.from('processos_padrao').select('*').order('procedure_name'); if (error) throw error; res.json(data || []); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/planejamento/padroes', requireAuth, requirePlanejamento, rateLimit, async (req, res) => {
  try {
    const b = req.body || {};
    const { data, error } = await supabase.from('processos_padrao').insert({
      price_id: b.price_id || null, procedure_name: sanitizeStr(b.procedure_name || '', 200),
      requer_plano: b.requer_plano !== false, etapas: Array.isArray(b.etapas) ? b.etapas : [],
      status: 'rascunho', criado_por: req.user.id }).select('id').single();
    if (error) throw error;
    res.json({ ok: true, id: data.id });                     // rascunho é utilizável pelo autor (spec)
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/planejamento/padroes/:id/aprovar', requireAuth, requirePlanejamentoGestor, rateLimit, async (req, res) => {
  try { const { error } = await supabase.from('processos_padrao').update({ status: 'aprovado', atualizado_em: new Date().toISOString() }).eq('id', req.params.id); if (error) throw error; res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
```

⚠️ Nota ao executor: a rota genérica `POST /:id/:acao` engloba veredito/divergência — manter UMA rota só (como acima), não duplicar.

- [ ] **Step 3: Testar sintaxe e subir local** — `node --check server.js` → sem erro.
- [ ] **Step 4: Commit** — `git commit -am "feat(planejamento): rotas /api/planejamento (fila, plano, transições, veredito CRC, padrões)"`

---

### Task 8: UI — nav + registro no módulo de Usuários + página `/planejamento/`

**Files:**
- Modify: `public/js/nav-config.js:99-104` (seção `producao`)
- Modify: `public/index.html` (módulo de Usuários: Perfil Base já tem `dentista`; adicionar Módulos Extras `mod_planejamento` + `_ROLE_LABELS` + `criarUsuario()`)
- Create: `public/planejamento/index.html`
- Create: `public/js/planejamento/app.js`

**Interfaces:**
- Consumes: contratos da Task 7.
- Produces: página com 3 abas (Planejar | Suspeitas | Gestora) filtradas por role.

- [ ] **Step 1: Nav** — em `public/js/nav-config.js`, adicionar ao array `items` da seção `producao` (após `producao-registro`):

```js
      { slug: 'planejamento',       label: 'Planejar',             roles: 'dentista,mod_planejamento,gestor',                          mode: 'link', href: '/planejamento/' },
```

E incluir `mod_planejamento` no `roles` da seção `producao` (linha 99).

- [ ] **Step 2: Módulo de Usuários (padrão obrigatório do CLAUDE.md — 3 lugares)**
  1. Módulos Extras em `public/index.html`: `<label ...><input type="checkbox" id="nu-mod-planejamento"> Planejamento</label>`
  2. `_ROLE_LABELS`: `mod_planejamento: 'Planejamento'`
  3. `criarUsuario()`: `if (document.getElementById('nu-mod-planejamento').checked) roles.push('mod_planejamento');`

- [ ] **Step 3: Página**

```html
<!-- public/planejamento/index.html -->
<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Planejar — Clínica AMA</title>
<link rel="stylesheet" href="/css/base.css">
</head><body>
<script src="/js/shared-nav.js" data-active="planejamento"></script>
<main class="page">
  <h1>Planejamento de Tratamentos</h1>
  <nav class="abas">
    <button data-aba="planejar" class="ativa">Planejar</button>
    <button data-aba="suspeitas">Suspeitas</button>
    <button data-aba="gestora">Gestora</button>
  </nav>
  <section id="fila"></section>
  <dialog id="dlg-plano"></dialog>
</main>
<script src="/js/planejamento/app.js"></script>
</body></html>
```

⚠️ Conferir o css base real das páginas irmãs (`public/producao/registro/index.html`) e copiar o mesmo `<link>`/estrutura de shell — o esqueleto acima segue o padrão mas o executor DEVE espelhar a página irmã.

- [ ] **Step 4: `public/js/planejamento/app.js`** (buscar token pelo padrão `sb-*-auth-token` do CLAUDE.md; retry 5xx 1,5s/3s 2x)

```js
// /js/planejamento/app.js — fila + tela do plano. Requisito de UX (spec): caso típico < 2 min.
(() => {
  const tokenKey = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
  const token = tokenKey ? JSON.parse(localStorage.getItem(tokenKey))?.access_token : null;
  if (!token) { location.href = '/'; return; }
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  async function api(path, opts = {}, tent = 0) {
    const r = await fetch(path, { headers: H, ...opts });
    if (r.status >= 500 && tent < 2) { await new Promise(s => setTimeout(s, tent ? 3000 : 1500)); return api(path, opts, tent + 1); }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return r.json();
  }
  const $ = s => document.querySelector(s);
  const fmtBRL = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  let abaAtual = 'planejar', config = { prazo_escalonamento_dias: 7 };

  async function carregarFila() {
    const { planos, config: cfg } = await api(`/api/planejamento/fila?aba=${abaAtual}`);
    config = cfg;
    const hoje = Date.now();
    $('#fila').innerHTML = planos.length ? `<table><thead><tr>
      <th>Paciente</th><th>Valor</th><th>Entrada</th><th>Aguardando há</th><th></th></tr></thead><tbody>` +
      planos.map(p => {
        const dias = Math.floor((hoje - new Date(p.criado_em).getTime()) / 864e5);
        const atrasado = dias > config.prazo_escalonamento_dias;
        return `<tr class="${atrasado ? 'atrasado' : ''}">
          <td>${p.paciente_nome || '—'} ${p.possivel_duplicata ? '<span class="badge badge-amarelo" title="possível duplicata (renegociação?)">⚠ suspeita</span>' : ''}
              ${p.trava_resync ? `<span class="badge badge-vermelho" title="${p.trava_resync}">🔒 travado</span>` : ''}</td>
          <td>${fmtBRL(p.valor)}</td><td>${fmtBRL(p.entrada)}</td>
          <td>${dias}d ${atrasado ? '🔔' : ''}</td>
          <td><button data-abrir="${p.id}">Abrir</button>
              ${abaAtual === 'suspeitas' ? `<button data-veredito-ok="${p.id}">Não é duplicata</button><button data-veredito-dup="${p.id}">É duplicata</button>` : ''}</td></tr>`;
      }).join('') + '</tbody></table>' : '<p class="vazio">Fila vazia 🎉</p>';
  }

  async function abrirPlano(id) {
    const { plano, itens, dentistas } = await api(`/api/planejamento/plano/${id}`);
    const dlg = $('#dlg-plano');
    dlg.innerHTML = `<h2>${plano.paciente_nome}</h2>
      <p class="espelho">Valor: <b>${fmtBRL(plano.valor)}</b> · Entrada: <b>${fmtBRL(plano.entrada)}</b>
        <small>(espelho do Clinicorp — divergiu? <a href="#" id="lnk-diverg">reportar</a>)</small></p>
      <label>Dentista responsável
        <select id="sel-dentista">${dentistas.map(d =>
          `<option value="${d.user_id}" ${d.user_id === plano.dentista_avaliador_id ? 'selected' : ''}>${d.profissional_nome}</option>`).join('')}</select></label>
      <div id="itens">${itens.map(item => `
        <fieldset data-item="${item.id}"><legend>${item.procedure_name} × ${item.quantidade}</legend>
          <ol class="etapas">${(item.plano_etapas || []).sort((a, b) => a.ordem - b.ordem).map(e => `
            <li data-etapa="${e.id}"><input class="et-desc" value="${e.descricao}">
              <input class="et-prof" placeholder="executor" value="${e.profissional_executor || ''}">
              <input class="et-min" type="number" placeholder="min" value="${e.tempo_planejado_min ?? ''}" style="width:70px"> min
              ${e.status !== 'pendente' ? `<em>(${e.status})</em>` : '<button class="et-rm">×</button>'}</li>`).join('')}
          </ol>
          <button class="add-etapa">+ etapa</button> <button class="dividir">dividir em sub-lotes</button>
        </fieldset>`).join('')}</div>
      <label>Orientação clínica (p/ executor)<textarea id="txt-orientacao">${plano.orientacao_clinica || ''}</textarea></label>
      <label>Recado p/ Sucesso do Cliente<textarea id="txt-recado">${plano.recado_sucesso || ''}</textarea></label>
      <footer><button id="bt-salvar">Salvar rascunho</button>
        <button id="bt-concluir" class="primario">Concluir planejamento ✓</button>
        <button id="bt-descartar">Não precisa de etapas</button>
        <button id="bt-fechar">Fechar</button></footer>`;
    dlg.showModal();
    const coletar = () => ({
      dentista_avaliador_id: $('#sel-dentista').value,
      orientacao_clinica: $('#txt-orientacao').value, recado_sucesso: $('#txt-recado').value,
      itens: [...dlg.querySelectorAll('[data-item]')].map(f => ({
        id: Number(f.dataset.item),
        etapas: [...f.querySelectorAll('[data-etapa], li.nova')].map(li => ({
          id: li.dataset.etapa ? Number(li.dataset.etapa) : null, status: 'pendente',
          descricao: li.querySelector('.et-desc').value,
          profissional_executor: li.querySelector('.et-prof').value,
          tempo_planejado_min: li.querySelector('.et-min').value })) })),
    });
    dlg.onclick = async ev => {
      const b = ev.target;
      try {
        if (b.id === 'bt-fechar') dlg.close();
        if (b.classList.contains('add-etapa')) b.closest('fieldset').querySelector('.etapas').insertAdjacentHTML('beforeend',
          `<li class="nova"><input class="et-desc" placeholder="descrição"><input class="et-prof" placeholder="executor"><input class="et-min" type="number" style="width:70px"> min <button class="et-rm">×</button></li>`);
        if (b.classList.contains('et-rm')) b.closest('li').remove();
        if (b.classList.contains('dividir')) dividirSubLotes(b.closest('fieldset'));
        if (b.id === 'lnk-diverg') { ev.preventDefault(); const t = prompt('Descreva a divergência (será corrigida NO Clinicorp):'); if (t) { await api(`/api/planejamento/plano/${id}/divergencia`, { method: 'POST', body: JSON.stringify({ texto: t }) }); alert('Reportada — a CRC corrige no Clinicorp e o sync atualiza o espelho.'); } }
        if (b.id === 'bt-salvar') { await api(`/api/planejamento/plano/${id}`, { method: 'PUT', body: JSON.stringify(coletar()) }); alert('Salvo.'); }
        if (b.id === 'bt-concluir') { await api(`/api/planejamento/plano/${id}`, { method: 'PUT', body: JSON.stringify(coletar()) }); await api(`/api/planejamento/plano/${id}/concluir`, { method: 'POST' }); dlg.close(); carregarFila(); }
        if (b.id === 'bt-descartar') { if (confirm('Este tratamento não precisa de etapas? (o paciente CONTINUA na Sucesso)')) { await api(`/api/planejamento/plano/${id}/descartar`, { method: 'POST' }); dlg.close(); carregarFila(); } }
      } catch (e) { alert(e.message); }
    };
  }

  function dividirSubLotes(fieldset) {
    const qtd = prompt('Quantidades separadas por vírgula (ex.: 4,2) — a soma deve bater com o total:');
    if (!qtd) return;
    const partes = qtd.split(',').map(n => Number(n.trim())).filter(n => n >= 1);
    fieldset.dataset.sublotes = JSON.stringify(partes.map((quantidade, i) => ({ quantidade, rotulo: `Sub-lote ${i + 1}` })));
    fieldset.querySelector('legend').insertAdjacentHTML('beforeend', ` <em>(dividido: ${partes.join(' + ')})</em>`);
    // as etapas atuais valem para o 1º sub-lote; o PUT recria conforme a spec (validação de conservação no servidor)
  }

  document.querySelector('.abas').onclick = ev => {
    const b = ev.target.closest('[data-aba]'); if (!b) return;
    document.querySelectorAll('.abas button').forEach(x => x.classList.remove('ativa'));
    b.classList.add('ativa'); abaAtual = b.dataset.aba; carregarFila();
  };
  $('#fila').onclick = async ev => {
    const abrir = ev.target.closest('[data-abrir]'); if (abrir) return abrirPlano(abrir.dataset.abrir);
    const ok = ev.target.closest('[data-veredito-ok]');
    const dup = ev.target.closest('[data-veredito-dup]');
    try {
      if (ok) { await api(`/api/planejamento/plano/${ok.dataset.vereditoOk}/veredito`, { method: 'POST', body: JSON.stringify({ veredito: 'ok' }) }); carregarFila(); }
      if (dup && confirm('Marcar como DUPLICATA cancela este plano e o registro na Sucesso. Confirmar?')) {
        await api(`/api/planejamento/plano/${dup.dataset.vereditoDup}/veredito`, { method: 'POST', body: JSON.stringify({ veredito: 'duplicata' }) }); carregarFila();
      }
    } catch (e) { alert(e.message); }
  };
  carregarFila();
})();
```

⚠️ Nota: o PUT do servidor espera `item.sublotes` — o executor deve incluir `sublotes: JSON.parse(f.dataset.sublotes || 'null')` no `coletar()` de cada item quando existir.

- [ ] **Step 5: Testar manual local** — `npm start`, abrir `/planejamento/`, ver a fila carregar (pode estar vazia antes do backfill). `node --check public/js/planejamento/app.js`.
- [ ] **Step 6: Commit** — `git commit -am "feat(planejamento): página /planejamento/ (3 abas), nav e registro no módulo de Usuários"`

---

### Task 9: Auditoria de Registro Diário — "esperada pelo plano"

**Files:**
- Modify: `server.js` — rota `GET /api/producao/auditoria-registro` (localizar por `auditoria-registro`)
- Modify: `public/producao/registro/index.html` (nova seção colapsada)

**Interfaces:**
- Consumes: `plano_tratamento` (status ativo = `{aguardando_planejamento, planejado, em_andamento}` — Global Constraints).
- Produces: resposta da rota ganha grupo `esperada_plano`; itens saem de `sem_registro`.

- [ ] **Step 1: Na rota, após montar `sem_registro`,** buscar os planos ativos dos pacientes pendentes e mover:

```js
    // Modo de Planejamento: sessão intermediária de paciente com plano ATIVO não é pendência —
    // é "esperada pelo plano". Dispensa por PACIENTE (grosseira — documentado na spec; refina na entrega ②).
    const idsPendentes = [...new Set(sem_registro.map(a => a.paciente_clinicorp_id).filter(Boolean))];
    let esperada_plano = [];
    if (idsPendentes.length) {
      const { data: ativos } = await supabase.from('plano_tratamento')
        .select('paciente_clinicorp_id')
        .in('status', ['aguardando_planejamento', 'planejado', 'em_andamento'])
        .in('paciente_clinicorp_id', idsPendentes);
      const setAtivos = new Set((ativos || []).map(p => p.paciente_clinicorp_id));
      esperada_plano = sem_registro.filter(a => setAtivos.has(a.paciente_clinicorp_id));
      sem_registro = sem_registro.filter(a => !setAtivos.has(a.paciente_clinicorp_id));
    }
```

E incluir `esperada_plano` no `res.json`, ajustando o `resumo` (pendentes não contam as esperadas).

- [ ] **Step 2: UI** — em `public/producao/registro/index.html`, nova seção colapsada "Esperadas pelo plano" (mesmo padrão visual da seção Manutenção), renderizando `esperada_plano` com nota: "sessão intermediária de tratamento planejado — não é pendência".
- [ ] **Step 3: Teste manual local** — com um plano ativo criado à mão via SQL, conferir que o paciente migra de Pendentes → Esperadas.
- [ ] **Step 4: Commit** — `git commit -am "feat(planejamento): auditoria diária reconhece sessão esperada pelo plano (mata falsa pendência)"`

---

### Task 10: Deploy, backfill e validação

**Files:** nenhum novo (execução).

- [ ] **Step 1:** `npm test` completo → PASS; `node --check server.js` → ok.
- [ ] **Step 2:** Migração já aplicada (Task 2). `git push` + deploy imediato (regra do CLAUDE.md): `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`
- [ ] **Step 3:** Backfill (ordem da spec): preencher `MAPA_V3` → `node scripts/backfill-planejamento.js` → guardar a lista da população 3 impressa (entregar à gestora).
- [ ] **Step 4: Validação manual (roteiro da spec):**
  1. Rodar sync manual (botão existente / `runGuardedSync`) → conferir que aprovados novos criam `pacientes_sucesso` + plano na fila.
  2. Abrir `/planejamento/` como gestor: fila Planejar populada SEM limpezas (triagem); abrir um caso típico e **cronometrar o fluxo confirmar < 2 min** (requisito de aceitação).
  3. Aba Suspeitas: conferir duplicatas flagadas; veredito "É duplicata" → plano `cancelado` (nunca `descartado`).
  4. Reportar divergência num plano → flag aparece na aba Suspeitas.
  5. Registro Diário: paciente com plano ativo aparece em "Esperadas pelo plano", fora de Pendentes.
  6. Conferência antiga: aprovar NÃO cria mais `pacientes_sucesso` (hook desligado — criação agora é do sync); rejeitar cria supressão (`plano_tratamento.cancelado`).
- [ ] **Step 5:** Atualizar `STATUS.md` e a memória do projeto; registrar pendências de validação logada.
- [ ] **Step 6: Commit final** — `git commit -am "docs: STATUS pós-deploy do Modo de Planejamento ①" && git push` + deploy.

---

## Self-review (feito na escrita)

- **Cobertura da spec:** desacoplamento (T5), espelho read-only + divergência (T7/T8), veredito CRC com `cancelado` (T7), triagem + <2min (T5/T8/T10), sub-lotes + conservação (T4/T7), estados + regressão/ressurreição (T4/T5), re-sync tabela completa (T4/T5), 4 populações (T2 pop.4 + T6), delegação Mônica com `planejado_por` (T2/T7), troca de responsável com registro (T7), config única prazo (T2/T7/T8), auditoria "esperada pelo plano" com status enumerados (T9), gatilho em_andamento pós-`planejado` (T5), segurança RLS na criação (T2), V1–V4 (T1; V4 resolvido por arquitetura: zero chamadas novas + `runGuardedSync` existente), cutover mesmo-deploy (T5 + T2), padrões rascunho utilizáveis (T7).
- **Fora do plano (conforme spec):** UI de config custo/margem (③), registro ASB (②), tracker (④), NPS, usuário-robô.
- **Riscos sinalizados ao executor:** nome da coluna de data em `agenda_appointments` (T5); shell CSS da página irmã (T8); `sublotes` no `coletar()` (T8).
