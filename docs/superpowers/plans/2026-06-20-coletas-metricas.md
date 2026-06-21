# Coletas de Métricas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que o gestor crie "coletas" (tarefas com vários campos numéricos preenchidos por período no dia) e acompanhe a evolução e o funil de conversão num dashboard.

**Architecture:** Estende o sistema de tarefas existente (`task_templates` + `tasks` + geração diária + cron) com um `tipo='coleta'`. A lógica pura (quais períodos valem hoje, geração de cards, agregação/conversão) vive em `lib/tarefas/*` e é testada com `node:test`. As somas pesadas do dashboard são feitas em funções SQL (Postgres) para nunca trazer todas as linhas ao navegador; o JS só calcula taxas de conversão sobre os totais já agregados. O frontend segue o padrão vanilla existente (funções que montam `innerHTML`).

**Tech Stack:** Node.js/Express (`server.js`), Supabase Postgres (project `mtqdpjhhqzvuklnlfpvi`), HTML/CSS/JS vanilla, Chart.js 4 via CDN (só para o gráfico de evolução), `node:test` para testes.

**Spec:** `docs/superpowers/specs/2026-06-20-coletas-metricas-design.md`

---

## Convenções de tipos (usadas em todo o plano)

**Item de `metricas`** (jsonb em `task_templates.metricas`):
```json
{ "chave": "ligacoes", "rotulo": "Ligações", "tipo_campo": "numero", "unidade": null, "ordem": 1, "meta": null }
```
- `tipo_campo`: `"numero"` | `"decimal"` | `"texto"`.

**Item de `conversoes`** (jsonb em `task_templates.conversoes`):
```json
{ "de": "ligacoes", "para": "agendados", "rotulo": "Taxa de agendamento" }
```

**Item de `periodos`** (jsonb em `task_templates.periodos`):
```json
{ "chave": "manha", "rotulo": "Manhã", "dias_semana": [1,2,3,4,5,6], "hora_aviso": "12:00", "avisos_por_pessoa": {} }
```
- `dias_semana`: 0=domingo … 6=sábado.

**Card de coleta** (linha em `tasks`): tem `periodo` (string, ex.: `"manha"`), `valores` (jsonb, ex.: `{"ligacoes":20}`), `origem` (`"manual"`), `tipo_resultado` setado para `"check"` (só para satisfazer a constraint existente), e `template_id` apontando para o template da coleta.

---

## File Structure

- `supabase/migrations/20260620130000_coletas_metricas.sql` — **criar**: colunas novas, índice único, 3 funções SQL de agregação.
- `lib/tarefas/recorrencia.js` — **modificar**: adicionar `periodosDoDia(template, dataRefISO)`.
- `lib/tarefas/recorrencia.test.js` — **modificar**: testes de `periodosDoDia`.
- `lib/tarefas/geracao.js` — **modificar**: gerar 1 card por período aplicável quando `tipo==='coleta'`.
- `lib/tarefas/geracao.test.js` — **modificar**: testes de geração de coleta.
- `lib/tarefas/agregacao.js` — **criar**: funções puras `somarLista`, `calcularConversoes`.
- `lib/tarefas/agregacao.test.js` — **criar**: testes das funções puras.
- `server.js` — **modificar**: repo (`coletaCardExiste`), POST/PATCH templates (campos de coleta), PATCH `/api/tarefas/:id` (ação `lancar_coleta`), endpoint dashboard, lembrete no cron.
- `public/js/tarefas/central.js` — **modificar**: render do card de coleta + mini-formulário + acumulado do dia.
- `public/js/tarefas/gestao.js` — **modificar**: construtor de coleta + dashboard.
- `public/tarefas/gestao.html` — **modificar**: aba/seção "Coletas" + `<script>` do Chart.js.

---

## Task 1: Migração — colunas, índice único e funções SQL de agregação

**Files:**
- Create: `supabase/migrations/20260620130000_coletas_metricas.sql`

- [ ] **Step 1: Escrever a migração**

Criar `supabase/migrations/20260620130000_coletas_metricas.sql` com:

```sql
-- Coletas de Métricas (Sub-projeto 1)

-- task_templates: tipo + definição da coleta
alter table public.task_templates add column if not exists tipo text not null default 'tarefa';
alter table public.task_templates add column if not exists metricas jsonb;
alter table public.task_templates add column if not exists conversoes jsonb;
alter table public.task_templates add column if not exists periodos jsonb;
alter table public.task_templates add column if not exists ver_proprio boolean not null default false;
alter table public.task_templates drop constraint if exists task_templates_tipo_check;
alter table public.task_templates add constraint task_templates_tipo_check
  check (tipo in ('tarefa', 'coleta'));

-- tasks: valores preenchidos + período + origem
alter table public.tasks add column if not exists valores jsonb;
alter table public.tasks add column if not exists periodo text;
alter table public.tasks add column if not exists origem text;

-- Evita cards de coleta duplicados por período (corrige corrida de geração)
create unique index if not exists tasks_coleta_periodo_uniq
  on public.tasks (template_id, assignee_id, data_ref, periodo)
  where periodo is not null;

-- Soma genérica de campos numéricos do jsonb `valores` (ignora texto via regex).
-- Total geral por métrica, no período, opcionalmente filtrado por pessoa.
create or replace function public.coleta_totais(
  p_template_id uuid, p_de date, p_ate date, p_pessoa uuid default null
) returns table(chave text, total numeric)
language sql stable as $$
  select e.key as chave, sum((e.value)::numeric) as total
  from public.tasks t
  cross join lateral jsonb_each_text(coalesce(t.valores, '{}'::jsonb)) as e(key, value)
  where t.template_id = p_template_id
    and t.data_ref between p_de and p_ate
    and t.periodo is not null
    and (p_pessoa is null or t.assignee_id = p_pessoa)
    and e.value ~ '^-?[0-9]+(\.[0-9]+)?$'
  group by e.key;
$$;

-- Total por pessoa e métrica (para a tabela "por pessoa").
create or replace function public.coleta_por_pessoa(
  p_template_id uuid, p_de date, p_ate date
) returns table(assignee_id uuid, chave text, total numeric)
language sql stable as $$
  select t.assignee_id, e.key as chave, sum((e.value)::numeric) as total
  from public.tasks t
  cross join lateral jsonb_each_text(coalesce(t.valores, '{}'::jsonb)) as e(key, value)
  where t.template_id = p_template_id
    and t.data_ref between p_de and p_ate
    and t.periodo is not null
    and e.value ~ '^-?[0-9]+(\.[0-9]+)?$'
  group by t.assignee_id, e.key;
$$;

-- Série temporal por bucket (dia/semana) e métrica (para o gráfico de evolução).
create or replace function public.coleta_serie(
  p_template_id uuid, p_de date, p_ate date, p_pessoa uuid default null, p_gran text default 'dia'
) returns table(bucket date, chave text, total numeric)
language sql stable as $$
  select date_trunc(case when p_gran = 'semana' then 'week' else 'day' end, t.data_ref)::date as bucket,
         e.key as chave, sum((e.value)::numeric) as total
  from public.tasks t
  cross join lateral jsonb_each_text(coalesce(t.valores, '{}'::jsonb)) as e(key, value)
  where t.template_id = p_template_id
    and t.data_ref between p_de and p_ate
    and t.periodo is not null
    and (p_pessoa is null or t.assignee_id = p_pessoa)
    and e.value ~ '^-?[0-9]+(\.[0-9]+)?$'
  group by 1, e.key
  order by 1;
$$;
```

- [ ] **Step 2: Aplicar a migração via MCP Supabase**

Aplicar o conteúdo do arquivo usando a ferramenta `apply_migration` (project_id `mtqdpjhhqzvuklnlfpvi`, name `coletas_metricas`).

- [ ] **Step 3: Verificar que aplicou**

Rodar via MCP Supabase `execute_sql`:
```sql
select column_name from information_schema.columns
 where table_name='task_templates' and column_name in ('tipo','metricas','conversoes','periodos','ver_proprio');
select column_name from information_schema.columns
 where table_name='tasks' and column_name in ('valores','periodo','origem');
select proname from pg_proc where proname in ('coleta_totais','coleta_por_pessoa','coleta_serie');
```
Esperado: 5 colunas em task_templates, 3 em tasks, 3 funções.

- [ ] **Step 4: Commit**
```bash
git add supabase/migrations/20260620130000_coletas_metricas.sql
git commit -m "feat(coletas): migracao colunas + funcoes SQL de agregacao"
```

---

## Task 2: `periodosDoDia` — quais períodos valem hoje

**Files:**
- Modify: `lib/tarefas/recorrencia.js`
- Test: `lib/tarefas/recorrencia.test.js`

- [ ] **Step 1: Escrever os testes falhando**

Adicionar ao final de `lib/tarefas/recorrencia.test.js` (antes do fim do arquivo; importar `periodosDoDia` no `require` do topo — ver Step 3):

```js
const { periodosDoDia } = require('./recorrencia');

const COLETA = {
  tipo: 'coleta',
  periodos: [
    { chave: 'manha', rotulo: 'Manhã',      dias_semana: [1,2,3,4,5,6] },
    { chave: 'tarde', rotulo: 'Fim do dia', dias_semana: [1,2,3,4,5] },
  ],
};

test('periodosDoDia: sexta retorna manha e tarde', () => {
  // 2026-06-19 é sexta-feira
  const ps = periodosDoDia(COLETA, '2026-06-19');
  assert.deepStrictEqual(ps.map(p => p.chave), ['manha', 'tarde']);
});

test('periodosDoDia: sabado retorna so manha', () => {
  // 2026-06-20 é sábado
  const ps = periodosDoDia(COLETA, '2026-06-20');
  assert.deepStrictEqual(ps.map(p => p.chave), ['manha']);
});

test('periodosDoDia: domingo retorna vazio', () => {
  // 2026-06-21 é domingo
  const ps = periodosDoDia(COLETA, '2026-06-21');
  assert.deepStrictEqual(ps, []);
});

test('periodosDoDia: template que nao e coleta retorna vazio', () => {
  const ps = periodosDoDia({ tipo: 'tarefa', frequencia: 'diaria' }, '2026-06-19');
  assert.deepStrictEqual(ps, []);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — `periodosDoDia is not a function`.

- [ ] **Step 3: Implementar**

Em `lib/tarefas/recorrencia.js`, adicionar a função e exportá-la:

```js
function periodosDoDia(template, dataRefISO) {
  if (!template || template.tipo !== 'coleta' || !Array.isArray(template.periodos)) return [];
  const dow = diaSemanaLocal(dataRefISO);
  return template.periodos.filter(
    p => Array.isArray(p.dias_semana) && p.dias_semana.includes(dow)
  );
}

module.exports = { moldeValeNoDia, diaSemanaLocal, ultimoDiaDoMes, periodosDoDia };
```
(Substituir o `module.exports` existente por este, que inclui `periodosDoDia`.)

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS — todos os testes de recorrência, incluindo os 4 novos.

- [ ] **Step 5: Commit**
```bash
git add lib/tarefas/recorrencia.js lib/tarefas/recorrencia.test.js
git commit -m "feat(coletas): periodosDoDia por dia da semana"
```

---

## Task 3: Geração de cards de coleta

**Files:**
- Modify: `lib/tarefas/geracao.js`
- Test: `lib/tarefas/geracao.test.js`

- [ ] **Step 1: Escrever os testes falhando**

Adicionar ao final de `lib/tarefas/geracao.test.js`:

```js
const COLETA_TPL = {
  id: 'c1', escopo: 'role', role: 'crc_leads', tipo: 'coleta', ativo: true,
  titulo: 'Coleta CRC Leads', categoria: 'Leads', prioridade: 'normal',
  metricas: [
    { chave: 'ligacoes', rotulo: 'Ligações', tipo_campo: 'numero', ordem: 1 },
    { chave: 'agendados', rotulo: 'Agendados', tipo_campo: 'numero', ordem: 2 },
  ],
  periodos: [
    { chave: 'manha', rotulo: 'Manhã',      dias_semana: [1,2,3,4,5,6] },
    { chave: 'tarde', rotulo: 'Fim do dia', dias_semana: [1,2,3,4,5] },
  ],
};

// Estende o fakeRepo: coleta precisa de coletaCardExiste
function fakeRepoColeta(templates, tasks = []) {
  const repo = fakeRepo(templates, tasks);
  repo.coletaCardExiste = async (templateId, userId, dataRef, periodo) =>
    repo._tasks.some(t => t.template_id === templateId && t.assignee_id === userId
      && t.data_ref === dataRef && t.periodo === periodo);
  return repo;
}

test('coleta: sexta gera 2 cards (manha + tarde)', async () => {
  const repo = fakeRepoColeta([COLETA_TPL]);
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-19'); // sexta
  assert.strictEqual(repo._tasks.length, 2);
  assert.deepStrictEqual(repo._tasks.map(t => t.periodo).sort(), ['manha', 'tarde']);
  assert.strictEqual(repo._tasks[0].template_id, 'c1');
  assert.deepStrictEqual(repo._tasks[0].valores, {});
  assert.strictEqual(repo._tasks[0].origem, 'manual');
});

test('coleta: sabado gera so 1 card (manha)', async () => {
  const repo = fakeRepoColeta([COLETA_TPL]);
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-20'); // sabado
  assert.strictEqual(repo._tasks.length, 1);
  assert.strictEqual(repo._tasks[0].periodo, 'manha');
  assert.strictEqual(repo._tasks[0].titulo, 'Coleta CRC Leads — Manhã');
});

test('coleta: idempotente, rodar 2x nao duplica', async () => {
  const repo = fakeRepoColeta([COLETA_TPL]);
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-19');
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-19');
  assert.strictEqual(repo._tasks.length, 2);
});
```

Nota: o `fakeRepo` existente precisa ser exportável/reutilizável dentro do arquivo. Ele já é uma função local no arquivo de teste; `fakeRepoColeta` apenas o estende.

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — gera 0 cards (a lógica de coleta ainda não existe; `moldeValeNoDia` retorna false para coleta sem `frequencia`).

- [ ] **Step 3: Implementar**

Em `lib/tarefas/geracao.js`, importar `periodosDoDia` e ramificar para coleta:

```js
const { moldeValeNoDia, periodosDoDia } = require('./recorrencia');

async function gerarTarefasDoDia(repo, userId, roles, dataRef) {
  const templates = await repo.templatesDoUsuario(userId, roles);
  for (const t of templates) {
    if (t.ativo === false) continue;

    if (t.tipo === 'coleta') {
      const periodos = periodosDoDia(t, dataRef);
      for (const p of periodos) {
        if (await repo.coletaCardExiste(t.id, userId, dataRef, p.chave)) continue;
        await repo.inserir({
          titulo: t.titulo + ' — ' + p.rotulo,
          descricao: t.descricao || null,
          tipo: 'rotina',
          template_id: t.id,
          data_ref: dataRef,
          assignee_id: userId,
          created_by: t.created_by || userId,
          prioridade: t.prioridade || 'normal',
          categoria: t.categoria || null,
          tipo_resultado: 'check',
          periodo: p.chave,
          valores: {},
          origem: 'manual',
          status: 'pendente',
        });
      }
      continue;
    }

    if (!moldeValeNoDia(t, dataRef)) continue;

    if (t.arrasta) {
      if (await repo.taskAbertaDoTemplate(t.id, userId)) continue;
    } else {
      if (await repo.taskExisteNoDia(t.id, userId, dataRef)) continue;
    }

    await repo.inserir({
      titulo: t.titulo,
      descricao: t.descricao || null,
      tipo: 'rotina',
      template_id: t.id,
      data_ref: dataRef,
      assignee_id: userId,
      created_by: t.created_by || userId,
      prioridade: t.prioridade || 'normal',
      categoria: t.categoria || null,
      tipo_resultado: t.tipo_resultado || 'check',
      unidade: t.unidade || null,
      meta: t.meta ?? null,
      arrasta: !!t.arrasta,
      status: 'pendente',
    });
  }
}
```
(O `require` no topo passa a desestruturar também `periodosDoDia`.)

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS — todos, incluindo os 3 novos de coleta e os existentes de rotina/usuarios.

- [ ] **Step 5: Commit**
```bash
git add lib/tarefas/geracao.js lib/tarefas/geracao.test.js
git commit -m "feat(coletas): geracao de cards por periodo"
```

---

## Task 4: Agregação pura (conversões)

**Files:**
- Create: `lib/tarefas/agregacao.js`
- Test: `lib/tarefas/agregacao.test.js`

- [ ] **Step 1: Escrever os testes falhando**

Criar `lib/tarefas/agregacao.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { somarLista, calcularConversoes } = require('./agregacao');

test('somarLista: dobra linhas {chave,total} num objeto', () => {
  const obj = somarLista([
    { chave: 'ligacoes', total: 20 },
    { chave: 'agendados', total: 5 },
  ]);
  assert.deepStrictEqual(obj, { ligacoes: 20, agendados: 5 });
});

test('somarLista: lista vazia vira objeto vazio', () => {
  assert.deepStrictEqual(somarLista([]), {});
});

test('calcularConversoes: taxa = para / de', () => {
  const somas = { ligacoes: 100, agendados: 25 };
  const conv = [{ de: 'ligacoes', para: 'agendados', rotulo: 'Taxa de agendamento' }];
  const out = calcularConversoes(somas, conv);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].rotulo, 'Taxa de agendamento');
  assert.strictEqual(out[0].valor_de, 100);
  assert.strictEqual(out[0].valor_para, 25);
  assert.strictEqual(out[0].taxa, 0.25);
});

test('calcularConversoes: divisao por zero retorna taxa null', () => {
  const out = calcularConversoes({ ligacoes: 0, agendados: 0 },
    [{ de: 'ligacoes', para: 'agendados', rotulo: 'x' }]);
  assert.strictEqual(out[0].taxa, null);
});

test('calcularConversoes: chave ausente conta como 0', () => {
  const out = calcularConversoes({ ligacoes: 10 },
    [{ de: 'ligacoes', para: 'agendados', rotulo: 'x' }]);
  assert.strictEqual(out[0].valor_para, 0);
  assert.strictEqual(out[0].taxa, 0);
});

test('calcularConversoes: sem conversoes retorna vazio', () => {
  assert.deepStrictEqual(calcularConversoes({ a: 1 }, []), []);
  assert.deepStrictEqual(calcularConversoes({ a: 1 }, null), []);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — `Cannot find module './agregacao'`.

- [ ] **Step 3: Implementar**

Criar `lib/tarefas/agregacao.js`:

```js
// lib/tarefas/agregacao.js
// Funções puras de agregação para o dashboard de coletas.
// Recebem dados JÁ somados no SQL (poucas linhas) e calculam taxas/forma.

function somarLista(rows) {
  const obj = {};
  for (const r of (rows || [])) obj[r.chave] = Number(r.total) || 0;
  return obj;
}

function calcularConversoes(somas, conversoes) {
  if (!Array.isArray(conversoes)) return [];
  return conversoes.map(c => {
    const valor_de = Number(somas[c.de]) || 0;
    const valor_para = Number(somas[c.para]) || 0;
    const taxa = valor_de > 0 ? valor_para / valor_de : null;
    return { de: c.de, para: c.para, rotulo: c.rotulo, valor_de, valor_para, taxa };
  });
}

module.exports = { somarLista, calcularConversoes };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS — os 6 novos testes de agregação.

- [ ] **Step 5: Commit**
```bash
git add lib/tarefas/agregacao.js lib/tarefas/agregacao.test.js
git commit -m "feat(coletas): agregacao pura (somas + conversoes)"
```

---

## Task 5: Repo do servidor — `coletaCardExiste`

**Files:**
- Modify: `server.js` (função `repoTarefas`, ~linha 5482-5508)

- [ ] **Step 1: Adicionar o método ao repo**

Em `server.js`, dentro do objeto retornado por `repoTarefas()`, adicionar (após `taskAbertaDoTemplate`):

```js
    async coletaCardExiste(templateId, userId, dataRef, periodo) {
      const { count } = await supabase.from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('template_id', templateId).eq('assignee_id', userId)
        .eq('data_ref', dataRef).eq('periodo', periodo);
      return (count || 0) > 0;
    },
```

- [ ] **Step 2: Verificar que `templatesDoUsuario` já cobre coletas**

Ler `repoTarefas().templatesDoUsuario` (server.js ~5484). Confirmar que ele filtra por `escopo` (`pessoal`/`role`/`usuarios`) e **não** por `tipo` — ou seja, templates de coleta (que usam `escopo='role'` ou `'usuarios'`) já são retornados. Nenhuma mudança necessária aqui; apenas confirmar.

- [ ] **Step 3: Commit**
```bash
git add server.js
git commit -m "feat(coletas): repo coletaCardExiste"
```

---

## Task 6: Endpoints — criar/editar coleta, lançar valores, dashboard

**Files:**
- Modify: `server.js` (handlers de `/api/tarefas/templates` POST/PATCH ~5612-5659; PATCH `/api/tarefas/:id` ~5732; adicionar endpoint dashboard)

- [ ] **Step 1: Aceitar campos de coleta no POST de template**

No handler `app.post('/api/tarefas/templates', ...)`, dentro do objeto `row`, adicionar os campos de coleta. Substituir a construção de `row` por:

```js
    const tipo = b.tipo === 'coleta' ? 'coleta' : 'tarefa';
    const row = {
      titulo: b.titulo, descricao: b.descricao || null, escopo,
      tipo,
      role:         escopo === 'role'     ? b.role         : null,
      owner_id:     escopo === 'pessoal'  ? userId         : null,
      assignee_ids: escopo === 'usuarios' ? (b.assignee_ids || null) : null,
      frequencia: ['diaria','semanal','mensal'].includes(b.frequencia) ? b.frequencia : 'diaria',
      dias_semana: b.dias_semana || null, dia_mes: b.dia_mes || null,
      hora_sugerida: b.hora_sugerida || null,
      prioridade: ['alta','normal','baixa'].includes(b.prioridade) ? b.prioridade : 'normal',
      categoria: b.categoria || null,
      tipo_resultado: b.tipo_resultado === 'numero' ? 'numero' : 'check',
      unidade: b.unidade || null, meta: b.meta ?? null,
      arrasta: !!b.arrasta, created_by: userId,
      metricas:   tipo === 'coleta' ? (Array.isArray(b.metricas)   ? b.metricas   : []) : null,
      conversoes: tipo === 'coleta' ? (Array.isArray(b.conversoes) ? b.conversoes : []) : null,
      periodos:   tipo === 'coleta' ? (Array.isArray(b.periodos)   ? b.periodos   : []) : null,
      ver_proprio: tipo === 'coleta' ? !!b.ver_proprio : false,
    };
```

Adicionar validação após `if (!b.titulo) ...`:
```js
    if (b.tipo === 'coleta') {
      if (!Array.isArray(b.metricas) || b.metricas.length === 0)
        return res.status(400).json({ error: 'Coleta precisa de ao menos um campo' });
      if (!Array.isArray(b.periodos) || b.periodos.length === 0)
        return res.status(400).json({ error: 'Coleta precisa de ao menos um período' });
    }
```

- [ ] **Step 2: Aceitar campos de coleta no PATCH de template**

No handler `app.patch('/api/tarefas/templates/:id', ...)`, adicionar as chaves de coleta à lista de campos editáveis. Trocar o array do `for` por:
```js
    for (const k of ['titulo','descricao','frequencia','dias_semana','dia_mes','hora_sugerida','prioridade','categoria','tipo_resultado','unidade','meta','arrasta','ativo','metricas','conversoes','periodos','ver_proprio']) {
```
E na checagem de permissão, incluir `usuarios` (consistente com o DELETE):
```js
    const podeEditar = (tpl.escopo === 'pessoal' && tpl.owner_id === req.user.id) ||
                       ((tpl.escopo === 'role' || tpl.escopo === 'usuarios') && isGestor);
```

- [ ] **Step 3: Ação `lancar_coleta` no PATCH da tarefa**

No handler `app.patch('/api/tarefas/:id', ...)`, antes do bloco `if (b.acao === 'concluir')`, adicionar:

```js
    if (b.acao === 'lancar_coleta') {
      if (!ehAssignee && !isGestor) return res.status(403).json({ error: 'Sem permissão' });
      const { data: tpl } = await supabase.from('task_templates')
        .select('metricas').eq('id', tarefa.template_id).maybeSingle();
      const metricas = (tpl && Array.isArray(tpl.metricas)) ? tpl.metricas : [];
      const entrada = (b.valores && typeof b.valores === 'object') ? b.valores : {};
      const valores = {};
      for (const m of metricas) {
        const v = entrada[m.chave];
        if (v === undefined || v === null || v === '') continue;
        if (m.tipo_campo === 'texto') valores[m.chave] = String(v).slice(0, 500);
        else { const n = Number(v); if (!Number.isNaN(n)) valores[m.chave] = n; }
      }
      const patch = {
        valores, origem: 'manual', status: 'concluida',
        concluida_em: new Date().toISOString(), concluida_por: userId,
      };
      const { data, error } = await supabase.from('tasks').update(patch).eq('id', tarefa.id).select().single();
      if (error) throw error;
      return res.json({ tarefa: data });
    }
```

- [ ] **Step 4: Endpoint do dashboard**

Adicionar (após o handler `app.get('/api/tarefas/pessoas', ...)`):

```js
// GET /api/coletas/:templateId/dashboard?de=&ate=&pessoa=&gran=
app.get('/api/coletas/:templateId/dashboard', requireAuth, async (req, res) => {
  try {
    const profile = await loadProfile(req);
    const roles = profile.roles || [];
    const isGestor = roles.some(r => r === 'admin' || r === 'gestor');
    const { data: tpl } = await supabase.from('task_templates')
      .select('*').eq('id', req.params.templateId).maybeSingle();
    if (!tpl || tpl.tipo !== 'coleta') return res.status(404).json({ error: 'Coleta não encontrada' });

    const pessoa = req.query.pessoa || null;
    // permissão: gestor vê tudo; não-gestor só o próprio e só se ver_proprio
    if (!isGestor) {
      if (!tpl.ver_proprio || pessoa !== req.user.id)
        return res.status(403).json({ error: 'Sem permissão' });
    }

    const de = req.query.de || hojeISO();
    const ate = req.query.ate || hojeISO();
    const gran = req.query.gran === 'semana' ? 'semana' : 'dia';

    const { somarLista, calcularConversoes } = require('./lib/tarefas/agregacao');

    const totaisRpc = await supabase.rpc('coleta_totais',
      { p_template_id: tpl.id, p_de: de, p_ate: ate, p_pessoa: pessoa });
    const somas = somarLista(totaisRpc.data || []);
    const conversoes = calcularConversoes(somas, tpl.conversoes || []);

    const serieRpc = await supabase.rpc('coleta_serie',
      { p_template_id: tpl.id, p_de: de, p_ate: ate, p_pessoa: pessoa, p_gran: gran });

    const porPessoaRpc = await supabase.rpc('coleta_por_pessoa',
      { p_template_id: tpl.id, p_de: de, p_ate: ate });
    const porPessoa = {};
    for (const r of (porPessoaRpc.data || [])) {
      (porPessoa[r.assignee_id] || (porPessoa[r.assignee_id] = {}))[r.chave] = Number(r.total) || 0;
    }

    res.json({
      template: { id: tpl.id, titulo: tpl.titulo, metricas: tpl.metricas || [], conversoes: tpl.conversoes || [], ver_proprio: tpl.ver_proprio },
      somas, conversoes,
      serie: serieRpc.data || [],
      por_pessoa: porPessoa,
    });
  } catch (e) {
    console.error('[GET /api/coletas/:id/dashboard]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 5: Lembrete de coleta no cron**

No `cronTarefas()`, após o bloco que avisa tarefas vencendo (`for (const t of (vencendo || []))` ...), adicionar o aviso de coleta por horário (reusa `prazo_avisado_em` como marca de "avisado"):

```js
    // Lembrete de coletas: card pendente cujo horário do período já passou
    const horaAgora = agora.slice(11, 16); // "HH:MM"
    const { data: cards } = await supabase.from('tasks')
      .select('id, assignee_id, titulo, periodo, template_id')
      .eq('status', 'pendente').eq('data_ref', hoje)
      .not('periodo', 'is', null).is('prazo_avisado_em', null);
    for (const c of (cards || [])) {
      const { data: tpl } = await supabase.from('task_templates').select('periodos').eq('id', c.template_id).maybeSingle();
      const per = (tpl && Array.isArray(tpl.periodos)) ? tpl.periodos.find(p => p.chave === c.periodo) : null;
      if (!per) continue;
      const horaAviso = (per.avisos_por_pessoa && per.avisos_por_pessoa[c.assignee_id]) || per.hora_aviso;
      if (!horaAviso || horaAgora < horaAviso) continue;
      await criarNotificacao(c.assignee_id, 'coleta_lembrete', 'Hora de preencher', c.titulo, { url: '/tarefas/', task_id: c.id });
      await supabase.from('tasks').update({ prazo_avisado_em: new Date().toISOString() }).eq('id', c.id);
    }
```

- [ ] **Step 6: Smoke test manual dos endpoints**

Rodar `npm start` localmente (ou confiar no deploy) e validar no Step de deploy (Task 10). Aqui apenas garantir que `node -e "require('./server.js')"` não quebra por erro de sintaxe:
Run: `node --check server.js`
Expected: sem saída (sintaxe OK).

- [ ] **Step 7: Commit**
```bash
git add server.js
git commit -m "feat(coletas): endpoints de template, lancamento, dashboard e lembrete"
```

---

## Task 7: Frontend — card de coleta + mini-formulário na Central (CRC)

**Files:**
- Modify: `public/js/tarefas/central.js`

- [ ] **Step 1: Detectar card de coleta no render**

Em `central.js`, na função `renderTarefaItem(t, refHoje)`, logo no início, tratar coleta separadamente. Adicionar, antes do `const atrasada = ...`:

```js
    if (t.periodo) return renderColetaItem(t, refHoje);
```

- [ ] **Step 2: Implementar `renderColetaItem` e helpers**

Adicionar estas funções em `central.js` (antes de `renderTarefaItem`):

```js
  // Cache de metricas por template_id (vem junto nos cards via /api/tarefas? Não —
  // o card não traz metricas. Buscamos as metricas sob demanda e cacheamos.)
  const _coletaMetricas = {}; // template_id -> [metricas]

  async function getMetricas(templateId) {
    if (_coletaMetricas[templateId]) return _coletaMetricas[templateId];
    const data = await tarefasApi('/api/tarefas/templates?gestao=1').catch(() => ({ templates: [] }));
    (data.templates || []).forEach(tp => { if (tp.metricas) _coletaMetricas[tp.id] = tp.metricas; });
    return _coletaMetricas[templateId] || [];
  }

  function renderColetaItem(t, refHoje) {
    const concluida = t.status === 'concluida';
    const atrasada = isAtrasada(t, refHoje);
    const classes = ['tarefa-item', atrasada ? 'atrasada' : '', concluida ? 'concluida' : ''].filter(Boolean).join(' ');
    let resumo = '';
    if (concluida && t.valores) {
      resumo = Object.entries(t.valores)
        .map(([k, v]) => `${esc(k)}: <strong>${esc(v)}</strong>`).join(' · ');
    }
    return `
      <div class="${classes}" data-id="${esc(t.id)}" data-coleta="1" data-tpl="${esc(t.template_id)}">
        <div class="tarefa-body">
          <div class="tarefa-titulo">📊 ${esc(t.titulo)}</div>
          ${resumo ? `<div class="tarefa-meta"><span style="font-size:12px;color:var(--muted)">${resumo}</span></div>` : ''}
          <div id="coleta-form-${esc(t.id)}" class="coleta-form" style="display:none"></div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="_abrirColeta('${esc(t.id)}','${esc(t.template_id)}')">
          ${concluida ? 'Editar' : 'Preencher'}
        </button>
      </div>`;
  }

  window._abrirColeta = async function (id, templateId) {
    const wrap = document.getElementById('coleta-form-' + id);
    if (!wrap) return;
    if (wrap.style.display === 'block') { wrap.style.display = 'none'; return; }
    const metricas = await getMetricas(templateId);
    const item = document.querySelector(`.tarefa-item[data-id="${id}"]`);
    let html = '<div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">';
    metricas.forEach(m => {
      const tipoInput = m.tipo_campo === 'texto' ? 'text' : 'number';
      html += `
        <label style="display:flex;align-items:center;gap:8px;font-size:13px">
          <span style="min-width:120px">${esc(m.rotulo)}${m.unidade ? ' (' + esc(m.unidade) + ')' : ''}</span>
          <input class="form-input cl-field" data-chave="${esc(m.chave)}" type="${tipoInput}"
                 ${tipoInput === 'number' ? 'step="any"' : ''} style="max-width:160px">
        </label>`;
    });
    html += `<div style="display:flex;gap:8px;margin-top:4px">
      <button class="btn btn-primary btn-sm" onclick="_salvarColeta('${esc(id)}')">Salvar lançamento</button>
      <button class="btn btn-ghost btn-sm" onclick="document.getElementById('coleta-form-${esc(id)}').style.display='none'">Cancelar</button>
    </div></div>`;
    wrap.innerHTML = html;
    wrap.style.display = 'block';
  };

  window._salvarColeta = async function (id) {
    const wrap = document.getElementById('coleta-form-' + id);
    if (!wrap) return;
    const valores = {};
    wrap.querySelectorAll('.cl-field').forEach(inp => {
      if (inp.value !== '') valores[inp.dataset.chave] = inp.type === 'number' ? Number(inp.value) : inp.value;
    });
    if (Object.keys(valores).length === 0) { toast('Preencha ao menos um campo.', 'warning'); return; }
    try {
      await tarefasApi('/api/tarefas/' + id, {
        method: 'PATCH',
        body: JSON.stringify({ acao: 'lancar_coleta', valores }),
      });
      toast('Lançamento salvo!', 'success');
      loadHoje();
    } catch (e) { toast(e.message, 'error'); }
  };
```

- [ ] **Step 3: Acumulado do dia**

Em `loadHoje()`, após montar `html` e antes de `root.innerHTML = html;`, inserir o resumo do dia das coletas concluídas. Adicionar:

```js
      // Acumulado de coletas do dia (soma por chave entre cards concluídos)
      const coletasOk = tarefas.filter(t => t.periodo && t.status === 'concluida' && t.valores);
      if (coletasOk.length) {
        const soma = {};
        coletasOk.forEach(t => Object.entries(t.valores).forEach(([k, v]) => {
          if (typeof v === 'number') soma[k] = (soma[k] || 0) + v;
        }));
        const txt = Object.entries(soma).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ');
        if (txt) html = `<div class="empty-msg" style="padding:12px;text-align:left;margin-bottom:12px">Hoje até agora — ${txt}</div>` + html;
      }
```

- [ ] **Step 4: CSS mínimo do formulário inline**

Em `public/tarefas/index.html` (página da Central), confirmar que as classes `form-input`, `btn`, `btn-sm` já existem (existem — mesmo CSS de gestao). Nenhuma classe nova obrigatória; `.coleta-form` é apenas um container. Sem mudança de CSS necessária.

- [ ] **Step 5: Commit**
```bash
git add public/js/tarefas/central.js
git commit -m "feat(coletas): preenchimento de coleta na Central (CRC)"
```

---

## Task 8: Frontend — construtor de coleta (Gestão)

**Files:**
- Modify: `public/js/tarefas/gestao.js`
- Modify: `public/tarefas/gestao.html` (aba "Coletas")

- [ ] **Step 1: Adicionar a aba "Coletas" no HTML**

Em `public/tarefas/gestao.html`, na `<nav class="mod-tabs">`, adicionar um botão antes do de "Histórico":
```html
    <button class="mod-tab" id="tab-btn-coletas" role="tab" aria-selected="false" aria-controls="tab-coletas" data-tab="coletas">
      Coletas
    </button>
```
E adicionar o painel correspondente após o pane `tab-criar`:
```html
  <div id="tab-coletas" class="mod-pane" role="tabpanel" aria-labelledby="tab-btn-coletas">
    <div id="coletas-root"></div>
  </div>
```
E, antes do `<script src="/js/tarefas/gestao.js">`, incluir o Chart.js **com Subresource Integrity** (SRI) — carregar script de CDN sem `integrity` expõe a app a comprometimento do CDN. Primeiro obter o hash oficial:
```bash
curl -s https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js \
  | openssl dgst -sha384 -binary | openssl base64 -A
```
Usar o valor retornado no atributo `integrity` (prefixado por `sha384-`):
```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"
        integrity="sha384-COLE_O_HASH_AQUI"
        crossorigin="anonymous" referrerpolicy="no-referrer"></script>
```
Se o hash não bater, o navegador **bloqueia** o script — então confira que o `curl` e a tag usam exatamente a mesma versão (`4.4.1`). Alternativa, se preferir evitar dependência de CDN: baixar o arquivo para `public/js/vendor/chart.umd.min.js` e servir local (sem `integrity` necessário). O plano assume o CDN com SRI.

- [ ] **Step 2: Roteamento da aba no JS**

Em `gestao.js`, dentro de `initTabs()`, adicionar:
```js
        if (btn.dataset.tab === 'coletas')   renderColetasHome();
```

- [ ] **Step 3: Implementar a home de Coletas (lista + botão criar)**

Adicionar em `gestao.js` (antes de `// ── HISTÓRICO TAB`):

```js
  // ── COLETAS TAB ──────────────────────────────────────────────────────────────
  let _coletas = [];

  async function renderColetasHome() {
    const root = document.getElementById('coletas-root');
    if (!root) return;
    root.innerHTML = '<p class="loading-msg">Carregando...</p>';
    try {
      const data = await tarefasApi('/api/tarefas/templates?gestao=1');
      _coletas = (data.templates || []).filter(t => t.tipo === 'coleta');
      let html = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <div style="font-size:15px;font-weight:600">Coletas de métricas</div>
          <button class="btn btn-primary btn-sm" onclick="_novaColeta()">+ Nova coleta</button>
        </div>`;
      if (_coletas.length === 0) {
        html += `<div class="empty-msg"><div class="empty-icon">📊</div>Nenhuma coleta criada ainda.</div>`;
      } else {
        _coletas.forEach(c => {
          html += `
            <div class="rotina-item" data-tid="${esc(c.id)}">
              <div class="rotina-body">
                <div class="rotina-titulo">${esc(c.titulo)}</div>
                <div class="rotina-meta">
                  <span class="chip">${esc(c.escopo === 'role' ? (c.role || '') : 'pessoas')}</span>
                  ${(c.metricas || []).map(m => '<span class="chip">' + esc(m.rotulo) + '</span>').join('')}
                </div>
              </div>
              <button class="btn btn-ghost btn-sm" onclick="_abrirDashboard('${esc(c.id)}')">Dashboard</button>
              <button class="tarefa-del" onclick="_excluirColeta('${esc(c.id)}')" title="Excluir">×</button>
            </div>`;
        });
      }
      html += '<div id="coleta-builder" style="margin-top:20px"></div>';
      html += '<div id="coleta-dashboard" style="margin-top:20px"></div>';
      root.innerHTML = html;
    } catch (e) {
      root.innerHTML = '<p class="loading-msg" style="color:var(--red)">Erro: ' + esc(e.message) + '</p>';
    }
  }

  window._excluirColeta = async function (id) {
    if (!confirm('Excluir esta coleta? Os lançamentos já feitos não são apagados.')) return;
    try {
      await tarefasApi('/api/tarefas/templates/' + id, { method: 'DELETE' });
      toast('Coleta excluída.', 'info');
      renderColetasHome();
    } catch (e) { toast(e.message, 'error'); }
  };
```

- [ ] **Step 4: Implementar o construtor (`_novaColeta`)**

Adicionar em `gestao.js`:

```js
  window._novaColeta = function () {
    const box = document.getElementById('coleta-builder');
    if (!box) return;
    box.innerHTML = `
      <div style="border:1px solid var(--border);border-radius:12px;padding:16px;max-width:620px">
        <div style="font-weight:600;margin-bottom:12px">Nova coleta</div>
        <div class="form-row"><label class="form-label">Nome *</label>
          <input class="form-input" id="co-titulo" placeholder="Ex: Coleta CRC Leads"></div>

        <div class="form-label">Campos a preencher *</div>
        <div id="co-campos"></div>
        <button class="btn btn-ghost btn-sm" onclick="_coAddCampo()">+ Campo</button>

        <div class="form-label" style="margin-top:14px">Conversões (funil)</div>
        <div id="co-convs"></div>
        <button class="btn btn-ghost btn-sm" onclick="_coAddConv()">+ Conversão</button>

        <div class="form-label" style="margin-top:14px">Períodos de preenchimento *</div>
        <div id="co-periodos"></div>
        <button class="btn btn-ghost btn-sm" onclick="_coAddPeriodo()">+ Período</button>

        <div class="form-row-2" style="margin-top:14px">
          <div><label class="form-label">Atribuir a (cargo)</label>
            <select class="form-select" id="co-role">
              <option value="">— selecione —</option>
              ${ROLES_CARGO.map(r => '<option value="' + esc(r) + '">' + esc(r) + '</option>').join('')}
            </select></div>
          <div><label class="form-label">&nbsp;</label>
            <label style="display:flex;align-items:center;gap:8px;font-size:13px">
              <input type="checkbox" id="co-verproprio"> Pessoa vê o próprio dashboard
            </label></div>
        </div>

        <div class="form-actions" style="justify-content:flex-start">
          <button class="btn btn-primary" onclick="_salvarColetaTemplate()">Criar coleta</button>
          <button class="btn btn-ghost" onclick="document.getElementById('coleta-builder').innerHTML=''">Cancelar</button>
        </div>
      </div>`;
    _coAddCampo(); _coAddPeriodo();
  };

  function _slug(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') || ('campo' + Date.now()); }

  window._coAddCampo = function () {
    const box = document.getElementById('co-campos');
    const div = document.createElement('div');
    div.className = 'co-campo';
    div.style = 'display:flex;gap:8px;margin-bottom:6px;align-items:center';
    div.innerHTML = `
      <input class="form-input co-c-rotulo" placeholder="Rótulo (ex: Ligações)" style="flex:2">
      <select class="form-select co-c-tipo" style="flex:1">
        <option value="numero">Número</option>
        <option value="decimal">Decimal/R$</option>
        <option value="texto">Texto</option>
      </select>
      <input class="form-input co-c-unidade" placeholder="unidade" style="flex:1">
      <button class="tarefa-del" onclick="this.parentNode.remove()">×</button>`;
    box.appendChild(div);
  };

  window._coAddConv = function () {
    const box = document.getElementById('co-convs');
    const div = document.createElement('div');
    div.className = 'co-conv';
    div.style = 'display:flex;gap:8px;margin-bottom:6px;align-items:center';
    div.innerHTML = `
      <input class="form-input co-cv-rotulo" placeholder="Rótulo (ex: Taxa agendamento)" style="flex:2">
      <input class="form-input co-cv-de" placeholder="campo origem (rótulo)" style="flex:1">
      <input class="form-input co-cv-para" placeholder="campo destino (rótulo)" style="flex:1">
      <button class="tarefa-del" onclick="this.parentNode.remove()">×</button>`;
    box.appendChild(div);
  };

  window._coAddPeriodo = function () {
    const box = document.getElementById('co-periodos');
    const div = document.createElement('div');
    div.className = 'co-periodo';
    div.style = 'display:flex;gap:8px;margin-bottom:6px;align-items:center;flex-wrap:wrap';
    div.innerHTML = `
      <input class="form-input co-p-rotulo" placeholder="Rótulo (ex: Manhã)" style="flex:1">
      <input class="form-input co-p-hora" placeholder="aviso HH:MM" style="width:110px">
      <span style="font-size:12px;color:var(--muted)">dias:</span>
      ${DIAS_LABELS.map((d, i) => '<label style="font-size:12px"><input type="checkbox" class="co-p-dia" value="' + i + '" ' + (i >= 1 && i <= 5 ? 'checked' : '') + '>' + d + '</label>').join('')}
      <button class="tarefa-del" onclick="this.parentNode.remove()">×</button>`;
    box.appendChild(div);
  };

  window._salvarColetaTemplate = async function () {
    const titulo = (document.getElementById('co-titulo').value || '').trim();
    if (!titulo) { toast('Informe o nome.', 'warning'); return; }

    const metricas = [];
    document.querySelectorAll('#co-campos .co-campo').forEach((d, i) => {
      const rotulo = d.querySelector('.co-c-rotulo').value.trim();
      if (!rotulo) return;
      metricas.push({ chave: _slug(rotulo), rotulo, tipo_campo: d.querySelector('.co-c-tipo').value,
        unidade: d.querySelector('.co-c-unidade').value.trim() || null, ordem: i + 1, meta: null });
    });
    if (metricas.length === 0) { toast('Adicione ao menos um campo.', 'warning'); return; }
    const rotuloParaChave = {}; metricas.forEach(m => { rotuloParaChave[m.rotulo.toLowerCase()] = m.chave; });

    const conversoes = [];
    document.querySelectorAll('#co-convs .co-conv').forEach(d => {
      const rotulo = d.querySelector('.co-cv-rotulo').value.trim();
      const de = rotuloParaChave[d.querySelector('.co-cv-de').value.trim().toLowerCase()];
      const para = rotuloParaChave[d.querySelector('.co-cv-para').value.trim().toLowerCase()];
      if (rotulo && de && para) conversoes.push({ de, para, rotulo });
    });

    const periodos = [];
    document.querySelectorAll('#co-periodos .co-periodo').forEach(d => {
      const rotulo = d.querySelector('.co-p-rotulo').value.trim();
      if (!rotulo) return;
      const dias = Array.from(d.querySelectorAll('.co-p-dia:checked')).map(c => Number(c.value));
      periodos.push({ chave: _slug(rotulo), rotulo, dias_semana: dias,
        hora_aviso: d.querySelector('.co-p-hora').value.trim() || null, avisos_por_pessoa: {} });
    });
    if (periodos.length === 0) { toast('Adicione ao menos um período.', 'warning'); return; }

    const role = document.getElementById('co-role').value;
    if (!role) { toast('Selecione o cargo.', 'warning'); return; }

    const body = { tipo: 'coleta', titulo, escopo: 'role', role, frequencia: 'diaria',
      metricas, conversoes, periodos, ver_proprio: document.getElementById('co-verproprio').checked };
    try {
      await tarefasApi('/api/tarefas/templates', { method: 'POST', body: JSON.stringify(body) });
      toast('Coleta criada!', 'success');
      renderColetasHome();
    } catch (e) { toast(e.message, 'error'); }
  };
```

- [ ] **Step 4b: Verificar sintaxe**

Run: `node --check public/js/tarefas/gestao.js`
Expected: sem saída.

- [ ] **Step 5: Commit**
```bash
git add public/js/tarefas/gestao.js public/tarefas/gestao.html
git commit -m "feat(coletas): construtor de coleta na Gestao"
```

---

## Task 9: Frontend — dashboard da coleta

**Files:**
- Modify: `public/js/tarefas/gestao.js`

- [ ] **Step 1: Implementar `_abrirDashboard` + render**

Adicionar em `gestao.js`:

```js
  let _chartColeta = null;

  window._abrirDashboard = async function (templateId) {
    const box = document.getElementById('coleta-dashboard');
    if (!box) return;
    const hoje = hojeISO();
    const de = hoje.slice(0, 8) + '01'; // 1º dia do mês corrente
    box.innerHTML = `
      <div style="border:1px solid var(--border);border-radius:12px;padding:16px">
        <div class="painel-filters">
          <div><label>De</label><input type="date" id="cd-de" value="${esc(de)}"></div>
          <div><label>Até</label><input type="date" id="cd-ate" value="${esc(hoje)}"></div>
          <div><label>Quem</label><select id="cd-pessoa"><option value="">Equipe toda</option>
            ${_pessoas.map(p => '<option value="' + esc(p.id) + '">' + esc(p.nome) + '</option>').join('')}</select></div>
          <button class="btn btn-primary btn-sm" onclick="_loadDashboard('${esc(templateId)}')">Atualizar</button>
        </div>
        <div id="cd-conteudo"><p class="loading-msg">Carregando...</p></div>
      </div>`;
    _loadDashboard(templateId);
  };

  window._loadDashboard = async function (templateId) {
    const cont = document.getElementById('cd-conteudo');
    if (!cont) return;
    const de = document.getElementById('cd-de').value;
    const ate = document.getElementById('cd-ate').value;
    const pessoa = document.getElementById('cd-pessoa').value;
    let url = '/api/coletas/' + templateId + '/dashboard?de=' + encodeURIComponent(de) + '&ate=' + encodeURIComponent(ate);
    if (pessoa) url += '&pessoa=' + encodeURIComponent(pessoa);
    cont.innerHTML = '<p class="loading-msg">Carregando...</p>';
    try {
      const d = await tarefasApi(url);
      const metr = d.template.metricas || [];
      const rotulo = {}; metr.forEach(m => { rotulo[m.chave] = m.rotulo; });

      // Totais
      const totais = metr.filter(m => m.tipo_campo !== 'texto')
        .map(m => `<strong>${(d.somas[m.chave] || 0)}</strong> ${esc(m.rotulo)}`).join(' &nbsp;·&nbsp; ');

      // Funil (barras CSS)
      const maxv = Math.max(1, ...Object.values(d.somas));
      let funil = '';
      d.conversoes.forEach(c => {
        const pct = c.taxa == null ? '—' : Math.round(c.taxa * 100) + '%';
        funil += `<div style="margin:4px 0">
          <div style="font-size:12px;color:var(--muted)">${esc(c.rotulo)}: <strong>${pct}</strong>
            (${c.valor_para}/${c.valor_de})</div></div>`;
      });

      // Por pessoa (tabela)
      let linhas = '';
      Object.keys(d.por_pessoa).forEach(pid => {
        const row = d.por_pessoa[pid];
        const cols = metr.filter(m => m.tipo_campo !== 'texto')
          .map(m => '<td>' + (row[m.chave] || 0) + '</td>').join('');
        linhas += `<tr><td style="font-weight:500">${esc(nomePessoa(pid))}</td>${cols}</tr>`;
      });
      const ths = metr.filter(m => m.tipo_campo !== 'texto').map(m => '<th>' + esc(m.rotulo) + '</th>').join('');

      cont.innerHTML = `
        <div style="margin:12px 0;font-size:15px">${totais || 'Sem dados no período.'}</div>
        ${funil ? '<div style="margin:12px 0">' + funil + '</div>' : ''}
        <div style="margin:12px 0"><canvas id="cd-chart" height="120"></canvas></div>
        ${linhas ? `<div class="gestao-table-wrap"><table class="gestao-table">
          <thead><tr><th>Pessoa</th>${ths}</tr></thead><tbody>${linhas}</tbody></table></div>` : ''}`;

      _renderChartColeta(d.serie, rotulo);
    } catch (e) {
      cont.innerHTML = '<p class="loading-msg" style="color:var(--red)">Erro: ' + esc(e.message) + '</p>';
    }
  };

  function _renderChartColeta(serie, rotulo) {
    const ctx = document.getElementById('cd-chart');
    if (!ctx || typeof Chart === 'undefined') return;
    // pivota serie [{bucket,chave,total}] em labels (datas) x datasets (chaves)
    const buckets = [...new Set(serie.map(r => r.bucket))].sort();
    const chaves = [...new Set(serie.map(r => r.chave))];
    const idx = {}; buckets.forEach((b, i) => { idx[b] = i; });
    const cores = ['#4f8ef7', '#22c55e', '#f59e0b', '#ef4444', '#a855f7'];
    const datasets = chaves.map((ch, i) => {
      const arr = new Array(buckets.length).fill(0);
      serie.filter(r => r.chave === ch).forEach(r => { arr[idx[r.bucket]] = Number(r.total) || 0; });
      return { label: rotulo[ch] || ch, data: arr, borderColor: cores[i % cores.length], backgroundColor: cores[i % cores.length], tension: 0.3 };
    });
    if (_chartColeta) _chartColeta.destroy();
    _chartColeta = new Chart(ctx, {
      type: 'line',
      data: { labels: buckets.map(b => b.slice(5)), datasets },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } } },
    });
  }
```

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check public/js/tarefas/gestao.js`
Expected: sem saída.

- [ ] **Step 3: Commit**
```bash
git add public/js/tarefas/gestao.js
git commit -m "feat(coletas): dashboard com totais, funil, evolucao e por pessoa"
```

---

## Task 10: Deploy e validação ponta a ponta

**Files:** nenhum (operacional)

- [ ] **Step 1: Garantir branch e merge para main**

O trabalho deve ir para produção via `main` (deploy do Easypanel observa `main`). Se estiver numa branch de feature, fazer merge/rebase para `main` conforme o fluxo do repo (ver `finishing-a-development-branch`).

- [ ] **Step 2: Rodar a suíte completa**

Run: `npm test`
Expected: PASS em todos os testes de `lib/tarefas/*.test.js`.

- [ ] **Step 3: Push + deploy do CRM**
```bash
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

- [ ] **Step 4: Validação manual (critérios de sucesso do spec)**

1. Como gestor, abrir Gestão de Tarefas → aba **Coletas** → **Nova coleta**; criar "Coleta CRC Leads" com campos Ligações/Agendados/Compareceram, conversões agendados÷ligações e compareceram÷agendados, períodos Manhã (seg–sáb) e Fim do dia (seg–sex), cargo `crc_leads`. Salvar.
2. Como uma CRC de leads, abrir `/tarefas/` → ver os cards **📊 Coleta CRC Leads — Manhã** e **— Fim do dia** (em dia útil). Em sábado, ver só **Manhã**.
3. Preencher um card → ver o card concluir e o **acumulado do dia** aparecer no topo.
4. Voltar ao gestor → **Dashboard** da coleta → ver totais, funil (%), gráfico de evolução e tabela por pessoa.
5. Confirmar que rodar a geração 2x (recarregar a página da CRC) **não duplica** cards.

- [ ] **Step 5: Finalizar**

Anunciar conclusão e usar `superpowers:finishing-a-development-branch` para fechar o trabalho.

---

## Notas de implementação

- **Limite de 1000 linhas do Supabase:** as somas do dashboard vêm das funções SQL (`coleta_totais`, `coleta_por_pessoa`, `coleta_serie`), que retornam dados **já agregados** (poucas linhas). Nunca somar lançamentos crus no navegador.
- **`tipo_resultado` em cards de coleta:** setado para `'check'` apenas para satisfazer a constraint existente; é ignorado no fluxo de coleta (os campos vivem em `metricas`/`valores`).
- **Sinal de "é card de coleta":** `tasks.periodo IS NOT NULL`. Usado tanto no frontend (`renderColetaItem`) quanto nas funções SQL.
- **Origem do lançamento:** sempre `'manual'` no v1; é o gancho para a Fase 2 (puxar do CRM e a CRC só confirmar).
- **Metas:** coluna/campo `meta` existe em cada métrica mas fica `null` no v1 (sem UI nem gráfico de meta).
- **`ver_proprio` (CRC vê o próprio dashboard):** o backend já valida e libera o endpoint para a própria pessoa quando `ver_proprio=true` (Task 6). Porém a *superfície de UI* do dashboard mora em `gestao.html` (acesso de gestor). Expor um dashboard read-only para a CRC dentro de `/tarefas/` (Central) é um **follow-up curto** deste v1 — reusa o endpoint `/api/coletas/:id/dashboard?pessoa=<self>` já pronto, só faltando a tela. Fica registrado para não ser uma lacuna silenciosa.
