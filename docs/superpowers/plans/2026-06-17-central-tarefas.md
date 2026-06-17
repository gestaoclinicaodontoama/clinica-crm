# Central de Tarefas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar a cada usuário do CRM uma Central de Tarefas com rotinas (diária/semanal/mensal por cargo + pessoais), tarefas pontuais atribuíveis, conclusão com check ou número, notificações e histórico, mais um painel de acompanhamento pro gestor.

**Architecture:** Tabelas `task_templates` e `tasks` no Supabase. A lógica pura de recorrência e geração de tarefas vive em `lib/tarefas/` (testável com `node:test`). As rotas REST ficam inline em `server.js` (padrão do projeto), delegando à lib. As telas são páginas vanilla em `public/tarefas/`. Notificações **reusam** a infra existente (`push_subscriptions`, `notificacoes`, `sendPushToUser`, `criarNotificacao`, `/api/push/subscribe`).

**Tech Stack:** Node.js + Express, Supabase (Postgres, service-role key bypassa RLS), HTML/CSS/JS vanilla, `web-push`, testes `node --test "lib/**/*.test.js"`.

**Spec:** `docs/superpowers/specs/2026-06-17-central-tarefas-design.md`

---

## File Structure

- **Create** `supabase/migrations/20260617000000_central_tarefas.sql` — tabelas + RLS + extensão do check de `notificacoes.tipo`.
- **Create** `lib/tarefas/recorrencia.js` — funções puras: `moldeValeNoDia(template, dataRefISO)`, `diaSemanaLocal(dataRefISO)`, `ultimoDiaDoMes(ano, mes)`.
- **Create** `lib/tarefas/recorrencia.test.js` — testes das funções puras.
- **Create** `lib/tarefas/geracao.js` — `gerarTarefasDoDia({ supabase, nowLocal }, userId, roles, dataRef)` (idempotente, regra de arrasta).
- **Create** `lib/tarefas/geracao.test.js` — testes de idempotência e arrasta (com supabase fake em memória).
- **Modify** `server.js` — registra rotas `/api/tarefas*` e o cron (na seção `// ====== NOTIFICAÇÕES + PUSH + TAREFAS ======`, a partir da linha ~5379).
- **Create** `public/tarefas/index.html` — Central (Hoje, Nova tarefa, Minha rotina).
- **Create** `public/tarefas/gestao.html` — painel/atribuir/moldes/histórico (admin/gestor).
- **Create** `public/js/tarefas/api.js` — helper de token/fetch (padrão CLAUDE.md).
- **Create** `public/js/tarefas/central.js` — lógica da Central.
- **Create** `public/js/tarefas/gestao.js` — lógica da gestão.
- **Modify** `public/index.html` — link no nav + registro no módulo Usuários.
- **Modify** `public/js/shared-nav.js` — entrada do nav pra páginas separadas.

**Convenções confirmadas no código:**
- `requireAuth(req,res,next)` injeta `req.user` (server.js:93). `requireRole(...roles)` usa `loadProfile` (server.js:327).
- `nowLocal()` devolve horário de Brasília (usado no projeto).
- Notificação: `criarNotificacao(usuarioId, tipo, titulo, corpo, metadata)` grava em `notificacoes` + push (server.js:5400).
- `leads.id` é `bigint`. Paciente referenciado por `paciente_clinicorp_id text` (sem FK).
- Migrations aplicadas via MCP Supabase, project `mtqdpjhhqzvuklnlfpvi`, em ordem crescente de timestamp.

---

## Task 1: Migração do banco

**Files:**
- Create: `supabase/migrations/20260617000000_central_tarefas.sql`

- [ ] **Step 1: Escrever a migração**

```sql
-- Central de Tarefas: moldes de rotina + ocorrências
create table if not exists public.task_templates (
  id            uuid primary key default gen_random_uuid(),
  titulo        text not null,
  descricao     text,
  escopo        text not null check (escopo in ('role','pessoal')),
  role          text,
  owner_id      uuid references auth.users(id) on delete cascade,
  frequencia    text not null check (frequencia in ('diaria','semanal','mensal')),
  dias_semana   int[],
  dia_mes       int check (dia_mes between 1 and 31),
  hora_sugerida time,
  prioridade    text not null default 'normal' check (prioridade in ('alta','normal','baixa')),
  categoria     text,
  tipo_resultado text not null default 'check' check (tipo_resultado in ('check','numero')),
  unidade       text,
  meta          numeric,
  arrasta       boolean not null default false,
  ativo         boolean not null default true,
  created_by    uuid not null,
  created_at    timestamptz not null default now(),
  -- escopo=role exige role; escopo=pessoal exige owner_id
  check ((escopo = 'role' and role is not null) or (escopo = 'pessoal' and owner_id is not null))
);

create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  titulo        text not null,
  descricao     text,
  tipo          text not null check (tipo in ('rotina','pontual')),
  template_id   uuid references public.task_templates(id) on delete set null,
  data_ref      date not null,
  assignee_id   uuid not null,
  created_by    uuid not null,
  prioridade    text not null default 'normal' check (prioridade in ('alta','normal','baixa')),
  categoria     text,
  tipo_resultado text not null default 'check' check (tipo_resultado in ('check','numero')),
  unidade       text,
  meta          numeric,
  valor_resultado numeric,
  prazo         timestamptz,
  lead_id       bigint references public.leads(id) on delete set null,
  paciente_clinicorp_id text,
  arrasta       boolean not null default false,
  status        text not null default 'pendente' check (status in ('pendente','concluida')),
  concluida_em  timestamptz,
  concluida_por uuid,
  obs_conclusao text,
  visto_em      timestamptz,
  prazo_avisado_em timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists idx_tasks_assignee_dataref on public.tasks(assignee_id, data_ref, status);
create index if not exists idx_tasks_status_prazo on public.tasks(status, prazo);
create index if not exists idx_tasks_template_open on public.tasks(template_id, assignee_id, status);

alter table public.task_templates enable row level security;
alter table public.tasks          enable row level security;

-- Permite o tipo de notificação de resumo diário (sininho)
alter table public.notificacoes drop constraint if exists notificacoes_tipo_check;
alter table public.notificacoes add constraint notificacoes_tipo_check
  check (tipo = any (array['visita_lead','tarefa_atribuida','tarefa_vencendo','tarefa_resumo','sistema','conferencia_pendente']));
```

- [ ] **Step 2: Aplicar via MCP Supabase**

Aplicar `apply_migration` (name: `central_tarefas`) com o SQL acima no project `mtqdpjhhqzvuklnlfpvi`. Depois `list_migrations` e confirmar que `20260617000000_central_tarefas` aparece.
Expected: migração listada; `list_tables` mostra `task_templates` e `tasks`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260617000000_central_tarefas.sql
git commit -m "feat(tarefas): migracao task_templates + tasks"
```

---

## Task 2: Lógica pura de recorrência

**Files:**
- Create: `lib/tarefas/recorrencia.js`
- Test: `lib/tarefas/recorrencia.test.js`

- [ ] **Step 1: Escrever os testes que falham**

```js
// lib/tarefas/recorrencia.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { moldeValeNoDia } = require('./recorrencia');

// 2026-06-17 é uma quarta-feira (getDay()=3). 2026-06-15 = segunda (1).
test('diaria sem dias_semana vale todo dia', () => {
  const m = { frequencia: 'diaria', dias_semana: null };
  assert.strictEqual(moldeValeNoDia(m, '2026-06-17'), true);
});

test('diaria com dias_semana so vale nos dias listados', () => {
  const m = { frequencia: 'diaria', dias_semana: [1, 2, 3, 4, 5] }; // seg-sex
  assert.strictEqual(moldeValeNoDia(m, '2026-06-17'), true);  // quarta
  assert.strictEqual(moldeValeNoDia(m, '2026-06-13'), false); // sabado
});

test('semanal vale so no(s) dia(s) da semana', () => {
  const m = { frequencia: 'semanal', dias_semana: [1] }; // toda segunda
  assert.strictEqual(moldeValeNoDia(m, '2026-06-15'), true);  // segunda
  assert.strictEqual(moldeValeNoDia(m, '2026-06-17'), false); // quarta
});

test('mensal vale no dia_mes', () => {
  const m = { frequencia: 'mensal', dia_mes: 17 };
  assert.strictEqual(moldeValeNoDia(m, '2026-06-17'), true);
  assert.strictEqual(moldeValeNoDia(m, '2026-06-18'), false);
});

test('mensal com dia_mes > ultimo dia do mes cai no ultimo dia', () => {
  const m = { frequencia: 'mensal', dia_mes: 31 };
  assert.strictEqual(moldeValeNoDia(m, '2026-02-28'), true);  // fev nao tem 31
  assert.strictEqual(moldeValeNoDia(m, '2026-02-27'), false);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — `Cannot find module './recorrencia'`.

- [ ] **Step 3: Implementar**

```js
// lib/tarefas/recorrencia.js
// Avalia se um molde de rotina vale para uma data (string 'YYYY-MM-DD', no fuso já resolvido).

function diaSemanaLocal(dataRefISO) {
  const [a, m, d] = dataRefISO.split('-').map(Number);
  return new Date(a, m - 1, d).getDay(); // 0=domingo ... 6=sabado
}

function ultimoDiaDoMes(ano, mes /* 1-12 */) {
  return new Date(ano, mes, 0).getDate();
}

function moldeValeNoDia(template, dataRefISO) {
  const dow = diaSemanaLocal(dataRefISO);
  if (template.frequencia === 'diaria') {
    if (!template.dias_semana || template.dias_semana.length === 0) return true;
    return template.dias_semana.includes(dow);
  }
  if (template.frequencia === 'semanal') {
    return Array.isArray(template.dias_semana) && template.dias_semana.includes(dow);
  }
  if (template.frequencia === 'mensal') {
    const [ano, mes, dia] = dataRefISO.split('-').map(Number);
    const alvo = Math.min(template.dia_mes, ultimoDiaDoMes(ano, mes));
    return dia === alvo;
  }
  return false;
}

module.exports = { moldeValeNoDia, diaSemanaLocal, ultimoDiaDoMes };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS — todos os testes de recorrência verdes.

- [ ] **Step 5: Commit**

```bash
git add lib/tarefas/recorrencia.js lib/tarefas/recorrencia.test.js
git commit -m "feat(tarefas): logica pura de recorrencia + testes"
```

---

## Task 3: Geração de tarefas do dia (idempotente + arrasta)

**Files:**
- Create: `lib/tarefas/geracao.js`
- Test: `lib/tarefas/geracao.test.js`

A função recebe um "repositório" injetado para ser testável sem banco real. No server, o repositório é uma fina camada sobre `supabase`.

- [ ] **Step 1: Escrever os testes que falham**

```js
// lib/tarefas/geracao.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { gerarTarefasDoDia } = require('./geracao');

// Repositório fake em memória
function fakeRepo(templates, tasks = []) {
  return {
    _tasks: tasks,
    async templatesDoUsuario(userId, roles) {
      return templates.filter(t =>
        (t.escopo === 'pessoal' && t.owner_id === userId) ||
        (t.escopo === 'role' && roles.includes(t.role))
      );
    },
    async taskExisteNoDia(templateId, userId, dataRef) {
      return this._tasks.some(t => t.template_id === templateId && t.assignee_id === userId && t.data_ref === dataRef);
    },
    async taskAbertaDoTemplate(templateId, userId) {
      return this._tasks.some(t => t.template_id === templateId && t.assignee_id === userId && t.status === 'pendente');
    },
    async inserir(task) { this._tasks.push({ ...task, id: 'gen-' + this._tasks.length }); },
  };
}

const T_DIARIA = { id: 't1', escopo: 'role', role: 'crc_leads', frequencia: 'diaria', dias_semana: null, titulo: 'Responder leads', arrasta: false, tipo_resultado: 'check', prioridade: 'normal' };

test('gera tarefa de rotina quando nao existe', async () => {
  const repo = fakeRepo([T_DIARIA]);
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-17');
  assert.strictEqual(repo._tasks.length, 1);
  assert.strictEqual(repo._tasks[0].titulo, 'Responder leads');
  assert.strictEqual(repo._tasks[0].data_ref, '2026-06-17');
});

test('idempotente: rodar 2x nao duplica', async () => {
  const repo = fakeRepo([T_DIARIA]);
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-17');
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-17');
  assert.strictEqual(repo._tasks.length, 1);
});

test('molde que arrasta com tarefa aberta de ontem NAO gera nova hoje', async () => {
  const arrastaTpl = { ...T_DIARIA, id: 't2', arrasta: true };
  const repo = fakeRepo([arrastaTpl], [
    { template_id: 't2', assignee_id: 'u1', data_ref: '2026-06-16', status: 'pendente' },
  ]);
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-17');
  assert.strictEqual(repo._tasks.length, 1); // continua so a de ontem
});

test('molde que nao se aplica hoje nao gera', async () => {
  const semFds = { ...T_DIARIA, dias_semana: [6] }; // so sabado
  const repo = fakeRepo([semFds]);
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-17'); // quarta
  assert.strictEqual(repo._tasks.length, 0);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — `Cannot find module './geracao'`.

- [ ] **Step 3: Implementar**

```js
// lib/tarefas/geracao.js
const { moldeValeNoDia } = require('./recorrencia');

// repo: { templatesDoUsuario, taskExisteNoDia, taskAbertaDoTemplate, inserir }
async function gerarTarefasDoDia(repo, userId, roles, dataRef) {
  const templates = await repo.templatesDoUsuario(userId, roles);
  for (const t of templates) {
    if (t.ativo === false) continue;
    if (!moldeValeNoDia(t, dataRef)) continue;

    if (t.arrasta) {
      // só uma ocorrência aberta por vez
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

module.exports = { gerarTarefasDoDia };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS — 4 testes de geração verdes.

- [ ] **Step 5: Commit**

```bash
git add lib/tarefas/geracao.js lib/tarefas/geracao.test.js
git commit -m "feat(tarefas): geracao idempotente do dia com regra de arrasta"
```

---

## Task 4: Repositório Supabase + `GET /api/tarefas`

**Files:**
- Modify: `server.js` (seção de tarefas, ~linha 5411 após `/api/push/vapid-public`)

- [ ] **Step 1: Adicionar o repositório Supabase e a rota**

Inserir após a rota `/api/push/vapid-public` em `server.js`:

```js
// ===================== CENTRAL DE TAREFAS =====================
const { gerarTarefasDoDia } = require('./lib/tarefas/geracao');

function hojeISO() {
  // nowLocal() devolve STRING "YYYY-MM-DD HH:MM:SS" no fuso de Brasília (server.js:126)
  return nowLocal().slice(0, 10);
}

function repoTarefas() {
  return {
    async templatesDoUsuario(userId, roles) {
      const orParts = [`and(escopo.eq.pessoal,owner_id.eq.${userId})`];
      if (roles.length) orParts.push(`and(escopo.eq.role,role.in.(${roles.join(',')}))`);
      const { data } = await supabase.from('task_templates')
        .select('*').eq('ativo', true).or(orParts.join(','));
      return data || [];
    },
    async taskExisteNoDia(templateId, userId, dataRef) {
      const { count } = await supabase.from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('template_id', templateId).eq('assignee_id', userId).eq('data_ref', dataRef);
      return (count || 0) > 0;
    },
    async taskAbertaDoTemplate(templateId, userId) {
      const { count } = await supabase.from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('template_id', templateId).eq('assignee_id', userId).eq('status', 'pendente');
      return (count || 0) > 0;
    },
    async inserir(task) { await supabase.from('tasks').insert(task); },
  };
}

// GET /api/tarefas?data=hoje  → gera sob demanda + retorna tarefas do dia, marca visto_em
app.get('/api/tarefas', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = await loadProfile(req);
    const roles = profile.roles || [];
    const hoje = hojeISO();
    try { await gerarTarefasDoDia(repoTarefas(), userId, roles, hoje); }
    catch (e) { console.error('[tarefas] geracao on-demand', e.message); }

    // tarefas de hoje + atrasadas (pendentes de dias anteriores)
    const { data, error } = await supabase.from('tasks')
      .select('*')
      .eq('assignee_id', userId)
      .or(`data_ref.eq.${hoje},and(status.eq.pendente,data_ref.lt.${hoje})`)
      .order('data_ref', { ascending: true });
    if (error) throw error;

    // marca como visto as pendentes ainda nao vistas
    const naoVistas = (data || []).filter(t => t.status === 'pendente' && !t.visto_em).map(t => t.id);
    if (naoVistas.length) {
      await supabase.from('tasks').update({ visto_em: new Date().toISOString() }).in('id', naoVistas);
    }
    res.json({ tarefas: data || [], hoje });
  } catch (e) {
    console.error('[GET /api/tarefas]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Verificar manualmente (servidor sobe sem erro)**

Run: `node -e "require('./server.js')"` — então Ctrl-C.
Expected: sobe sem erro de sintaxe nem `Cannot find module`. (Se reclamar de env vars, ok — o que importa é não haver erro de require/sintaxe; alternativamente rodar `node --check server.js`.)

Run: `node --check server.js`
Expected: sem saída (sintaxe ok).

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(tarefas): GET /api/tarefas com geracao sob demanda + visto_em"
```

---

## Task 5: `POST /api/tarefas` (pontual + fan-out + notificação)

**Files:**
- Modify: `server.js` (após o `GET /api/tarefas`)

- [ ] **Step 1: Adicionar a rota**

```js
// POST /api/tarefas  → cria tarefa(s) pontual(is). assignee_ids[] permite fan-out.
app.post('/api/tarefas', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = await loadProfile(req);
    const isGestor = (profile.roles || []).some(r => r === 'admin' || r === 'gestor');
    const b = req.body || {};
    if (!b.titulo || !String(b.titulo).trim()) return res.status(400).json({ error: 'titulo obrigatório' });

    let assignees = Array.isArray(b.assignee_ids) && b.assignee_ids.length ? b.assignee_ids : [userId];
    // só gestor/admin atribui a terceiros
    const paraTerceiros = assignees.some(a => a !== userId);
    if (paraTerceiros && !isGestor) return res.status(403).json({ error: 'Sem permissão para atribuir a outros' });

    const base = {
      titulo: String(b.titulo).trim(),
      descricao: b.descricao || null,
      tipo: 'pontual',
      template_id: null,
      data_ref: b.data_ref || hojeISO(),
      created_by: userId,
      prioridade: ['alta','normal','baixa'].includes(b.prioridade) ? b.prioridade : 'normal',
      categoria: b.categoria || null,
      tipo_resultado: b.tipo_resultado === 'numero' ? 'numero' : 'check',
      unidade: b.unidade || null,
      meta: b.meta ?? null,
      prazo: b.prazo || null,
      lead_id: b.lead_id || null,
      paciente_clinicorp_id: b.paciente_clinicorp_id || null,
      arrasta: !!b.arrasta,
      status: 'pendente',
    };
    const rows = assignees.map(a => ({ ...base, assignee_id: a }));
    const { data, error } = await supabase.from('tasks').insert(rows).select();
    if (error) throw error;

    // notifica quem recebeu de terceiro
    for (const t of data) {
      if (t.assignee_id !== userId) {
        await criarNotificacao(t.assignee_id, 'tarefa_atribuida', 'Nova tarefa', t.titulo, { url: '/tarefas/', task_id: t.id });
      }
    }
    res.json({ tarefas: data });
  } catch (e) {
    console.error('[POST /api/tarefas]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem saída.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(tarefas): POST /api/tarefas com fan-out e notificacao"
```

---

## Task 6: `PATCH /api/tarefas/:id` (concluir/reabrir/editar)

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Adicionar a rota**

```js
// PATCH /api/tarefas/:id  → concluir (com valor_resultado se numero), reabrir, editar
app.patch('/api/tarefas/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = await loadProfile(req);
    const isGestor = (profile.roles || []).some(r => r === 'admin' || r === 'gestor');
    const { data: tarefa, error: e0 } = await supabase.from('tasks').select('*').eq('id', req.params.id).maybeSingle();
    if (e0) throw e0;
    if (!tarefa) return res.status(404).json({ error: 'Tarefa não encontrada' });

    const b = req.body || {};
    const ehAssignee = tarefa.assignee_id === userId;
    const ehCriador = tarefa.created_by === userId;

    // CONCLUIR
    if (b.acao === 'concluir') {
      if (!ehAssignee && !isGestor) return res.status(403).json({ error: 'Sem permissão' });
      if (tarefa.tipo_resultado === 'numero' && (b.valor_resultado === undefined || b.valor_resultado === null || b.valor_resultado === ''))
        return res.status(400).json({ error: 'Informe o valor para concluir esta tarefa' });
      const patch = {
        status: 'concluida',
        concluida_em: new Date().toISOString(),
        concluida_por: userId,
        obs_conclusao: b.obs_conclusao || null,
        valor_resultado: tarefa.tipo_resultado === 'numero' ? Number(b.valor_resultado) : null,
      };
      const { data, error } = await supabase.from('tasks').update(patch).eq('id', tarefa.id).select().single();
      if (error) throw error;
      return res.json({ tarefa: data });
    }

    // REABRIR
    if (b.acao === 'reabrir') {
      if (!ehAssignee && !isGestor) return res.status(403).json({ error: 'Sem permissão' });
      const { data, error } = await supabase.from('tasks')
        .update({ status: 'pendente', concluida_em: null, concluida_por: null, valor_resultado: null, obs_conclusao: null })
        .eq('id', tarefa.id).select().single();
      if (error) throw error;
      return res.json({ tarefa: data });
    }

    // EDITAR (só criador)
    if (!ehCriador) return res.status(403).json({ error: 'Só quem criou pode editar' });
    const patch = {};
    for (const k of ['titulo','descricao','prioridade','categoria','prazo','lead_id','paciente_clinicorp_id','arrasta']) {
      if (k in b) patch[k] = b[k];
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada para atualizar' });
    const { data, error } = await supabase.from('tasks').update(patch).eq('id', tarefa.id).select().single();
    if (error) throw error;
    res.json({ tarefa: data });
  } catch (e) {
    console.error('[PATCH /api/tarefas/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem saída.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(tarefas): PATCH concluir/reabrir/editar com permissoes"
```

---

## Task 7: `DELETE /api/tarefas/:id` (só criador, só pendente)

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Adicionar a rota**

```js
// DELETE /api/tarefas/:id  → só created_by e só se pendente (preserva histórico)
app.delete('/api/tarefas/:id', requireAuth, async (req, res) => {
  try {
    const { data: tarefa } = await supabase.from('tasks').select('created_by,status').eq('id', req.params.id).maybeSingle();
    if (!tarefa) return res.status(404).json({ error: 'Tarefa não encontrada' });
    if (tarefa.created_by !== req.user.id) return res.status(403).json({ error: 'Só quem criou pode excluir' });
    if (tarefa.status === 'concluida') return res.status(400).json({ error: 'Não é possível excluir tarefa concluída' });
    const { error } = await supabase.from('tasks').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/tarefas/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem saída.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(tarefas): DELETE restrito a criador e pendente"
```

---

## Task 8: CRUD de moldes (`/api/tarefas/templates`)

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Adicionar as rotas**

```js
// GET templates: pessoais do usuário + de role (todos podem ler os seus)
app.get('/api/tarefas/templates', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = await loadProfile(req);
    const roles = profile.roles || [];
    const orParts = [`and(escopo.eq.pessoal,owner_id.eq.${userId})`];
    if (roles.length) orParts.push(`and(escopo.eq.role,role.in.(${roles.join(',')}))`);
    const { data, error } = await supabase.from('task_templates').select('*').or(orParts.join(',')).order('created_at');
    if (error) throw error;
    res.json({ templates: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST template: role => só gestor/admin; pessoal => qualquer um (owner = ele)
app.post('/api/tarefas/templates', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = await loadProfile(req);
    const isGestor = (profile.roles || []).some(r => r === 'admin' || r === 'gestor');
    const b = req.body || {};
    if (!b.titulo) return res.status(400).json({ error: 'titulo obrigatório' });
    const escopo = b.escopo === 'role' ? 'role' : 'pessoal';
    if (escopo === 'role' && !isGestor) return res.status(403).json({ error: 'Só gestor/admin cria molde por cargo' });
    const row = {
      titulo: b.titulo, descricao: b.descricao || null, escopo,
      role: escopo === 'role' ? b.role : null,
      owner_id: escopo === 'pessoal' ? userId : null,
      frequencia: ['diaria','semanal','mensal'].includes(b.frequencia) ? b.frequencia : 'diaria',
      dias_semana: b.dias_semana || null, dia_mes: b.dia_mes || null,
      hora_sugerida: b.hora_sugerida || null,
      prioridade: ['alta','normal','baixa'].includes(b.prioridade) ? b.prioridade : 'normal',
      categoria: b.categoria || null,
      tipo_resultado: b.tipo_resultado === 'numero' ? 'numero' : 'check',
      unidade: b.unidade || null, meta: b.meta ?? null,
      arrasta: !!b.arrasta, created_by: userId,
    };
    const { data, error } = await supabase.from('task_templates').insert(row).select().single();
    if (error) throw error;
    res.json({ template: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH template: dono (pessoal) ou gestor/admin (role)
app.patch('/api/tarefas/templates/:id', requireAuth, async (req, res) => {
  try {
    const profile = await loadProfile(req);
    const isGestor = (profile.roles || []).some(r => r === 'admin' || r === 'gestor');
    const { data: tpl } = await supabase.from('task_templates').select('*').eq('id', req.params.id).maybeSingle();
    if (!tpl) return res.status(404).json({ error: 'Molde não encontrado' });
    const podeEditar = (tpl.escopo === 'pessoal' && tpl.owner_id === req.user.id) || (tpl.escopo === 'role' && isGestor);
    if (!podeEditar) return res.status(403).json({ error: 'Sem permissão' });
    const patch = {};
    for (const k of ['titulo','descricao','frequencia','dias_semana','dia_mes','hora_sugerida','prioridade','categoria','tipo_resultado','unidade','meta','arrasta','ativo']) {
      if (k in req.body) patch[k] = req.body[k];
    }
    const { data, error } = await supabase.from('task_templates').update(patch).eq('id', tpl.id).select().single();
    if (error) throw error;
    res.json({ template: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE template: mesmas regras do PATCH
app.delete('/api/tarefas/templates/:id', requireAuth, async (req, res) => {
  try {
    const profile = await loadProfile(req);
    const isGestor = (profile.roles || []).some(r => r === 'admin' || r === 'gestor');
    const { data: tpl } = await supabase.from('task_templates').select('*').eq('id', req.params.id).maybeSingle();
    if (!tpl) return res.status(404).json({ error: 'Molde não encontrado' });
    const pode = (tpl.escopo === 'pessoal' && tpl.owner_id === req.user.id) || (tpl.escopo === 'role' && isGestor);
    if (!pode) return res.status(403).json({ error: 'Sem permissão' });
    const { error } = await supabase.from('task_templates').delete().eq('id', tpl.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem saída.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(tarefas): CRUD de moldes de rotina"
```

---

## Task 9: `GET /api/tarefas/historico` (próprio, por período)

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Adicionar a rota**

```js
// GET /api/tarefas/historico?de=YYYY-MM-DD&ate=YYYY-MM-DD  → histórico do próprio usuário
app.get('/api/tarefas/historico', requireAuth, async (req, res) => {
  try {
    const de = req.query.de || hojeISO();
    const ate = req.query.ate || hojeISO();
    const { data, error } = await supabase.from('tasks')
      .select('*').eq('assignee_id', req.user.id)
      .gte('data_ref', de).lte('data_ref', ate)
      .order('data_ref', { ascending: false });
    if (error) throw error;
    res.json({ tarefas: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem saída.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(tarefas): historico proprio por periodo"
```

---

## Task 10: `GET /api/tarefas/gestao` (painel + histórico da equipe)

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Adicionar a rota**

```js
const requireTarefasGestao = requireRole('admin', 'gestor');

// GET /api/tarefas/gestao?de=&ate=&pessoa=&categoria=  → painel da equipe + histórico filtrado
app.get('/api/tarefas/gestao', requireAuth, requireTarefasGestao, async (req, res) => {
  try {
    const de = req.query.de || hojeISO();
    const ate = req.query.ate || hojeISO();
    let q = supabase.from('tasks').select('*').gte('data_ref', de).lte('data_ref', ate);
    if (req.query.pessoa) q = q.eq('assignee_id', req.query.pessoa);
    if (req.query.categoria) q = q.eq('categoria', req.query.categoria);
    const { data: tarefas, error } = await q.order('data_ref', { ascending: false });
    if (error) throw error;

    // resumo por pessoa
    const porPessoa = {};
    for (const t of (tarefas || [])) {
      const p = porPessoa[t.assignee_id] || (porPessoa[t.assignee_id] = { total: 0, concluidas: 0, atrasadas: 0, soma_valor: 0, n_valor: 0 });
      p.total++;
      if (t.status === 'concluida') p.concluidas++;
      if (t.status === 'pendente' && t.data_ref < hojeISO()) p.atrasadas++;
      if (t.tipo_resultado === 'numero' && t.valor_resultado != null) { p.soma_valor += Number(t.valor_resultado); p.n_valor++; }
    }
    res.json({ tarefas: tarefas || [], resumo: porPessoa });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem saída.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(tarefas): painel/historico da equipe para gestor"
```

---

## Task 11: Cron (geração matinal + push de resumo + push de prazo)

**Files:**
- Modify: `server.js`

Reusa o padrão `setInterval` já presente no projeto. Roda a cada 15 min; só age uma vez por dia para a geração/resumo (controlado por flag em memória + verificação de horário Brasília).

- [ ] **Step 1: Adicionar o cron**

```js
// CRON Central de Tarefas: geração matinal de todos + push resumo + push de prazo
let _ultimaGeracaoMatinal = null; // 'YYYY-MM-DD'

async function cronTarefas() {
  try {
    const agora = nowLocal();            // "YYYY-MM-DD HH:MM:SS" (string, fuso BR)
    const hoje = agora.slice(0, 10);
    const hora = Number(agora.slice(11, 13));

    // 1) Geração matinal (entre 6h e 7h, uma vez/dia) para TODOS os usuários ativos
    if (hora >= 6 && _ultimaGeracaoMatinal !== hoje) {
      const { data: usuarios } = await supabase.from('profiles').select('id, roles').eq('ativo', true);
      for (const u of (usuarios || [])) {
        try {
          await gerarTarefasDoDia(repoTarefas(), u.id, u.roles || [], hoje);
          const { count } = await supabase.from('tasks').select('id', { count: 'exact', head: true })
            .eq('assignee_id', u.id).eq('data_ref', hoje).eq('status', 'pendente');
          if ((count || 0) > 0) {
            await criarNotificacao(u.id, 'tarefa_resumo', 'Tarefas de hoje', `Você tem ${count} tarefa(s) hoje.`, { url: '/tarefas/' });
          }
        } catch (e) { console.error('[cronTarefas] usuario', u.id, e.message); }
      }
      _ultimaGeracaoMatinal = hoje;
    }

    // 2) Push de prazo: pendentes com prazo vencido e ainda não avisadas
    const agoraISO = new Date().toISOString();
    const { data: vencendo } = await supabase.from('tasks')
      .select('id, assignee_id, titulo')
      .eq('status', 'pendente').is('prazo_avisado_em', null)
      .lte('prazo', agoraISO).not('prazo', 'is', null);
    for (const t of (vencendo || [])) {
      await criarNotificacao(t.assignee_id, 'tarefa_vencendo', 'Tarefa no prazo', t.titulo, { url: '/tarefas/', task_id: t.id });
      await supabase.from('tasks').update({ prazo_avisado_em: agoraISO }).eq('id', t.id);
    }
  } catch (e) { console.error('[cronTarefas]', e.message); }
}
setInterval(cronTarefas, 15 * 60 * 1000);
```

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem saída.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(tarefas): cron geracao matinal + push resumo/prazo"
```

---

## Task 12: Helper de API + esqueleto da Central + nav

**Files:**
- Create: `public/js/tarefas/api.js`
- Create: `public/tarefas/index.html`
- Modify: `public/index.html` (link no nav)
- Modify: `public/js/shared-nav.js` (entrada do nav)

- [ ] **Step 1: Criar o helper de API** (padrão CLAUDE.md de token)

```js
// public/js/tarefas/api.js
function _token() {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
      try { return JSON.parse(localStorage.getItem(k)).access_token; } catch {}
    }
  }
  return null;
}
async function api(path, opts = {}) {
  const t = _token();
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t, ...(opts.headers || {}) },
  });
  if (r.status === 401) { location.href = '/'; return; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('Erro ' + r.status));
  return j;
}
window.tarefasApi = api;
```

- [ ] **Step 2: Criar a página da Central** (esqueleto com sidebar compartilhada)

```html
<!-- public/tarefas/index.html -->
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Central de Tarefas — CRM AMA</title>
  <link rel="stylesheet" href="/css/app.css" />
</head>
<body>
  <div id="app">
    <main class="conteudo">
      <h1>Central de Tarefas</h1>
      <div class="tabs">
        <button class="tab ativa" data-tab="hoje">Hoje</button>
        <button class="tab" data-tab="rotina">Minha rotina</button>
        <button class="tab" id="btn-nova">+ Nova tarefa</button>
      </div>
      <section id="painel-hoje"><div id="lista-tarefas">Carregando…</div></section>
      <section id="painel-rotina" hidden></section>
    </main>
  </div>
  <script src="/js/shared-nav.js" data-active="tarefas"></script>
  <script src="/js/tarefas/api.js"></script>
  <script src="/js/tarefas/central.js"></script>
</body>
</html>
```

(Reutilize a folha de estilo que os outros módulos separados usam; confirme o caminho real do CSS em `public/css/` e ajuste o `<link>` se necessário, seguindo `public/avaliacao-dentista/index.html` como referência.)

- [ ] **Step 3: Registrar no nav** — em `public/index.html`, adicionar antes do botão "Usuários":

```html
<a class="nav-btn" href="/tarefas/" data-roles="admin,gestor,crc_leads,crc_comercial,crc_sucesso,crc_pos_tratamento">
  <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
  Tarefas
</a>
```

- [ ] **Step 4: Registrar em `public/js/shared-nav.js`** — adicionar a entrada `{ href: '/tarefas/', slug: 'tarefas', label: 'Tarefas', roles: [...] }` na lista de links, no mesmo formato das entradas existentes (abra o arquivo e siga o padrão das demais).

- [ ] **Step 5: Verificar no navegador**

Subir o app local (ou usar o deploy). Logar, abrir `/tarefas/`. Expected: a página carrega com a sidebar e o título "Central de Tarefas" e "Carregando…" (sem JS de lista ainda).

- [ ] **Step 6: Commit**

```bash
git add public/js/tarefas/api.js public/tarefas/index.html public/index.html public/js/shared-nav.js
git commit -m "feat(tarefas): esqueleto da Central + nav + helper api"
```

---

## Task 13: Central — lista "Hoje", concluir, número, vínculos

**Files:**
- Create: `public/js/tarefas/central.js`

- [ ] **Step 1: Implementar a renderização e ações**

```js
// public/js/tarefas/central.js
const api = window.tarefasApi;
let HOJE = null;

function badgePrioridade(p) {
  return `<span class="badge prio-${p}">${p}</span>`;
}
function linkVinculo(t) {
  if (t.lead_id) return `<a class="vinc" href="/kanban-leads/?lead=${t.lead_id}">↗ lead</a>`;
  if (t.paciente_clinicorp_id) return `<a class="vinc" href="/pacientes/?cid=${encodeURIComponent(t.paciente_clinicorp_id)}">↗ paciente</a>`;
  return '';
}
function ehAtrasada(t) {
  return t.status === 'pendente' && (t.data_ref < HOJE || (t.prazo && new Date(t.prazo) < new Date()));
}

function itemHTML(t) {
  const concl = t.status === 'concluida';
  const meta = (t.tipo_resultado === 'numero' && t.meta != null)
    ? ` <small>(meta ${t.meta}${t.unidade ? ' ' + t.unidade : ''})</small>` : '';
  const valor = (concl && t.valor_resultado != null) ? ` — <b>${t.valor_resultado}${t.unidade ? ' ' + t.unidade : ''}</b>` : '';
  return `<div class="tarefa ${concl ? 'concluida' : ''} ${ehAtrasada(t) ? 'atrasada' : ''}" data-id="${t.id}">
    <input type="checkbox" class="chk" ${concl ? 'checked' : ''} ${concl ? 'data-reabrir="1"' : ''}/>
    <span class="titulo">${t.titulo}${meta}${valor}</span>
    ${t.categoria ? `<span class="cat">${t.categoria}</span>` : ''}
    ${badgePrioridade(t.prioridade)}
    ${linkVinculo(t)}
  </div>`;
}

async function carregar() {
  const r = await api('/api/tarefas?data=hoje');
  HOJE = r.hoje;
  const atrasadas = r.tarefas.filter(ehAtrasada);
  const pendentes = r.tarefas.filter(t => t.status === 'pendente' && !ehAtrasada(t));
  const concluidas = r.tarefas.filter(t => t.status === 'concluida');
  const ordena = arr => arr.sort((a, b) => ({alta:0,normal:1,baixa:2}[a.prioridade] - {alta:0,normal:1,baixa:2}[b.prioridade]));
  const sec = (titulo, arr) => arr.length ? `<h3>${titulo}</h3>${ordena(arr).map(itemHTML).join('')}` : '';
  document.getElementById('lista-tarefas').innerHTML =
    sec('Atrasadas', atrasadas) + sec('Pendentes', pendentes) +
    (concluidas.length ? `<details><summary>Concluídas (${concluidas.length})</summary>${concluidas.map(itemHTML).join('')}</details>` : '')
    || '<p>Nenhuma tarefa hoje 🎉</p>';
}

async function concluir(id, tarefaEl) {
  const t = window._tarefasCache?.[id];
  let body = { acao: 'concluir' };
  // número exige valor
  const numero = tarefaEl.querySelector('.titulo small'); // heurística simples; preferir cache
  const precisaValor = tarefaEl.dataset.numero === '1';
  if (precisaValor) {
    const v = prompt('Informe o valor:');
    if (v === null) return carregar(); // cancelou
    body.valor_resultado = v;
  }
  const obs = prompt('Observação (opcional):') || '';
  if (obs) body.obs_conclusao = obs;
  await api('/api/tarefas/' + id, { method: 'PATCH', body: JSON.stringify(body) });
  carregar();
}

document.getElementById('lista-tarefas').addEventListener('change', (e) => {
  if (!e.target.classList.contains('chk')) return;
  const el = e.target.closest('.tarefa');
  const id = el.dataset.id;
  if (e.target.dataset.reabrir) {
    api('/api/tarefas/' + id, { method: 'PATCH', body: JSON.stringify({ acao: 'reabrir' }) }).then(carregar);
  } else {
    concluir(id, el);
  }
});

carregar();
```

> Nota de implementação: para tornar `tipo_resultado=numero` confiável, marque no `itemHTML` um `data-numero="1"` quando `t.tipo_resultado==='numero'` e cacheie as tarefas (`window._tarefasCache`) por id ao renderizar. Ajuste `itemHTML`/`carregar` para preencher esses dois pontos (o esqueleto acima já referencia `dataset.numero` e o cache).

- [ ] **Step 2: Verificar no navegador**

Abrir `/tarefas/`. Criar um molde de teste pelo SQL/MCP ou aguardar Task 14/15. Expected: tarefas pendentes aparecem; marcar o check conclui (pede observação); concluída vai pra seção recolhida; desmarcar reabre.

- [ ] **Step 3: Commit**

```bash
git add public/js/tarefas/central.js
git commit -m "feat(tarefas): Central Hoje com concluir/reabrir/numero/vinculo"
```

---

## Task 14: Central — "Nova tarefa" e "Minha rotina"

**Files:**
- Modify: `public/js/tarefas/central.js`
- Modify: `public/tarefas/index.html` (modais/painéis)

- [ ] **Step 1: Adicionar formulário de nova tarefa pontual**

Adicionar em `central.js` um handler para `#btn-nova` que abre um formulário (modal simples) com campos: título, descrição, prioridade, categoria (select da lista fixa), prazo (datetime-local opcional), tipo_resultado (check/número) + unidade/meta quando número, e vínculo opcional (lead_id/paciente). Ao salvar:

```js
async function salvarNova(form) {
  const body = {
    titulo: form.titulo.value.trim(),
    descricao: form.descricao.value || null,
    prioridade: form.prioridade.value,
    categoria: form.categoria.value || null,
    prazo: form.prazo.value ? new Date(form.prazo.value).toISOString() : null,
    tipo_resultado: form.tipo_resultado.value,
    unidade: form.unidade.value || null,
    meta: form.meta.value ? Number(form.meta.value) : null,
  };
  await api('/api/tarefas', { method: 'POST', body: JSON.stringify(body) });
  carregar();
}
```

(Para a própria pessoa, não enviar `assignee_ids` — o back-end usa o próprio usuário.)

- [ ] **Step 2: Adicionar a aba "Minha rotina"** — lista os templates `escopo=pessoal` do usuário (`GET /api/tarefas/templates`, filtrando `escopo==='pessoal'`), com botão de criar (`POST`), editar (`PATCH`) e excluir (`DELETE`). Formulário com: título, frequência (diária/semanal/mensal), dias_semana (checkboxes seg–dom), dia_mes (quando mensal), prioridade, categoria, tipo_resultado/unidade/meta, arrasta.

```js
async function carregarRotina() {
  const r = await api('/api/tarefas/templates');
  const pessoais = r.templates.filter(t => t.escopo === 'pessoal');
  document.getElementById('painel-rotina').innerHTML =
    `<button id="nova-rotina">+ Nova rotina</button>` +
    (pessoais.map(t => `<div class="rotina" data-id="${t.id}">${t.titulo} <small>(${t.frequencia})</small>
       <button class="del-rotina">excluir</button></div>`).join('') || '<p>Sem rotinas pessoais.</p>');
}
```

- [ ] **Step 3: Verificar no navegador**

Criar uma rotina pessoal diária; recarregar `/tarefas/`; ela deve gerar uma tarefa de hoje. Criar uma tarefa pontual pra si mesma; deve aparecer em Pendentes.

- [ ] **Step 4: Commit**

```bash
git add public/js/tarefas/central.js public/tarefas/index.html
git commit -m "feat(tarefas): nova tarefa pontual + gestao da rotina pessoal"
```

---

## Task 15: Página de gestão (painel, atribuir, moldes por cargo, histórico)

**Files:**
- Create: `public/tarefas/gestao.html`
- Create: `public/js/tarefas/gestao.js`
- Modify: `public/js/shared-nav.js` (entrada `tarefas-gestao`, roles admin,gestor)

- [ ] **Step 1: Criar `gestao.html`** seguindo o mesmo esqueleto do `index.html` da Task 12 (sidebar + `data-active="tarefas-gestao"`), com 4 abas: Painel, Atribuir, Moldes por cargo, Histórico. Scripts: `api.js` + `gestao.js`.

- [ ] **Step 2: Implementar `gestao.js`**

```js
// public/js/tarefas/gestao.js
const api = window.tarefasApi;

async function carregarPainel(de, ate) {
  const q = new URLSearchParams({ de: de || '', ate: ate || '' }).toString();
  const r = await api('/api/tarefas/gestao?' + q);
  const linhas = Object.entries(r.resumo).map(([pid, p]) => {
    const pct = p.total ? Math.round(100 * p.concluidas / p.total) : 0;
    const num = p.n_valor ? ` | soma: ${p.soma_valor} (média ${(p.soma_valor / p.n_valor).toFixed(1)})` : '';
    return `<tr><td>${pid}</td><td>${pct}%</td><td>${p.atrasadas}</td><td>${p.total}</td><td>${num}</td></tr>`;
  }).join('');
  document.getElementById('painel').innerHTML =
    `<table><thead><tr><th>Pessoa</th><th>% dia</th><th>Atrasadas</th><th>Total</th><th>Número</th></tr></thead><tbody>${linhas}</tbody></table>`;
}

async function atribuir(form) {
  const assignee_ids = Array.from(form.querySelectorAll('input[name=pessoa]:checked')).map(c => c.value);
  await api('/api/tarefas', { method: 'POST', body: JSON.stringify({
    titulo: form.titulo.value.trim(), descricao: form.descricao.value || null,
    prioridade: form.prioridade.value, categoria: form.categoria.value || null,
    prazo: form.prazo.value ? new Date(form.prazo.value).toISOString() : null,
    assignee_ids,
  }) });
  alert('Tarefa atribuída a ' + assignee_ids.length + ' pessoa(s).');
}
```

(Para listar pessoas no "Atribuir", reusar o endpoint de usuários já existente — `admin_list_users` via a tela de Usuários, ou um GET de profiles ativos. Confirme qual endpoint a tela de Usuários usa e reaproveite.)

- [ ] **Step 3: Implementar "Moldes por cargo"** — CRUD de `task_templates` com `escopo='role'`: select de role (crc_leads, crc_comercial, crc_sucesso, crc_pos_tratamento, gestor), frequência, dias, prioridade, categoria, tipo_resultado. Usa `POST/PATCH/DELETE /api/tarefas/templates`.

- [ ] **Step 4: Implementar "Histórico"** — filtros de período/pessoa/categoria chamando `GET /api/tarefas/gestao` e listando as tarefas (com data_ref, status, concluida_em, valor_resultado).

- [ ] **Step 5: Registrar no nav** — link `/tarefas/gestao/` com `data-roles="admin,gestor"` (como submenu de "Tarefas" ou item próprio) em `public/index.html` e `shared-nav.js`.

- [ ] **Step 6: Verificar no navegador**

Como gestor: criar um molde por cargo `crc_leads` diária; logar como um CRC Lead e confirmar que a tarefa aparece. Atribuir uma pontual a 2 pessoas; confirmar fan-out (cada uma vê a sua) e que receberam notificação no sininho.

- [ ] **Step 7: Commit**

```bash
git add public/tarefas/gestao.html public/js/tarefas/gestao.js public/index.html public/js/shared-nav.js
git commit -m "feat(tarefas): pagina de gestao (painel/atribuir/moldes/historico)"
```

---

## Task 16: Registro no módulo Usuários + tabbar mobile

**Files:**
- Modify: `public/index.html` (módulo Usuários — Módulos Extras, `_ROLE_LABELS`, `criarUsuario()`)
- Modify: `public/js/mobile-nav.js` (candidata na tabbar)

- [ ] **Step 1: Acesso granular (Módulos Extras)** — A Central é aberta a todas as roles operacionais, então não precisa de role nova. Apenas garanta que o `data-roles` do link (Task 12) cobre todos os perfis. **Pular** criação de `mod_tarefas` (a gestão usa `admin`/`gestor`).

- [ ] **Step 2: Adicionar "Tarefas" como candidata da tabbar mobile** — em `public/js/mobile-nav.js`, incluir `/tarefas/` na lista de itens disponíveis para a barra inferior personalizável (siga o formato das entradas existentes: label, href/slug, ícone).

- [ ] **Step 3: Verificar no celular/responsivo**

Abrir em viewport mobile, personalizar a tabbar, adicionar "Tarefas", confirmar que o atalho abre `/tarefas/`.

- [ ] **Step 4: Commit + deploy**

```bash
git add public/js/mobile-nav.js public/index.html
git commit -m "feat(tarefas): tarefas na tabbar mobile"
git push
# deploy CRM (CLAUDE.md):
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

---

## Self-Review (coberto)

- **Modelo de dados** → Task 1 (tabelas + RLS + tipo de notificação).
- **Recorrência (diária/semanal/mensal, arrasta, idempotência)** → Tasks 2–3 (com testes).
- **Geração sob demanda + visto_em** → Task 4.
- **Pontuais + fan-out + notificação de atribuição** → Task 5.
- **Concluir (check/número) + reabrir + editar + permissões** → Task 6.
- **DELETE só criador/pendente** → Task 7.
- **Moldes (role: gestor; pessoal: dono)** → Task 8.
- **Histórico próprio** → Task 9. **Painel/histórico equipe** → Task 10.
- **Cron matinal (gera p/ todos) + push resumo + push prazo (dedup prazo_avisado_em)** → Task 11.
- **Telas Central (Hoje/Nova/Rotina)** → Tasks 12–14. **Gestão** → Task 15.
- **Mobile tabbar** → Task 16.
- **Reuso de push/notificações** → Tasks 5, 11 (sem tabela nova).

**Pontos que exigem confirmação durante a execução (não bloqueiam):**
- Caminho real do CSS dos módulos separados (Task 12, Step 2) — espelhar `avaliacao-dentista`.
- Formato exato das entradas em `shared-nav.js` e `mobile-nav.js` — seguir o padrão do arquivo.
- Endpoint de listagem de pessoas para "Atribuir" (Task 15) — reusar o da tela de Usuários.

**Confirmado no código:** `nowLocal()` retorna string `"YYYY-MM-DD HH:MM:SS"` (server.js:126); `profiles.ativo` existe e é usado com `.eq('ativo', true)` (server.js:226); infra de push/notificação reusada (server.js:5381–5411).
