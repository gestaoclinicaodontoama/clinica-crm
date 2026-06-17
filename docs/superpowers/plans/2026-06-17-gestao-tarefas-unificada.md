# Gestão de Tarefas Unificada — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unificar as abas "Atribuir" e "Moldes por cargo" em uma única aba "Criar" com toggle Demanda/Rotina, reduzindo a Gestão de 4 para 3 abas.

**Architecture:** Frontend recebe um toggle Demanda/Rotina no topo do formulário; Rotina pode ir para cargo OU pessoas específicas; Painel ganha seção "Rotinas ativas" colapsável no topo com modal de confirmação para exclusão.

**Tech Stack:** Node.js/Express, Supabase Postgres, HTML/CSS/JS vanilla.

---

## Mapa de arquivos

| Arquivo | Tipo | O que muda |
|---|---|---|
| `supabase/migrations/20260617000001_tarefas_escopo_usuarios.sql` | Criar | Adiciona `assignee_ids` jsonb + atualiza check constraints |
| `lib/tarefas/geracao.test.js` | Modificar | fakeRepo suporta `escopo: 'usuarios'`; 2 novos testes |
| `server.js` | Modificar | `repoTarefas()`, `GET/POST/DELETE /api/tarefas/templates` |
| `public/tarefas/gestao.html` | Modificar | 3 abas; CSS para `.tipo-btn`; remove div atribuir+moldes; adiciona div criar |
| `public/js/tarefas/gestao.js` | Modificar | Remove funções antigas; adiciona renderCriarForm e helpers; atualiza Painel |

---

## Task 1 — Migration: escopo 'usuarios' em task_templates

**Files:**
- Criar: `supabase/migrations/20260617000001_tarefas_escopo_usuarios.sql`

- [ ] **Criar arquivo de migração**

```sql
-- supabase/migrations/20260617000001_tarefas_escopo_usuarios.sql
-- Adiciona suporte a rotinas por pessoas específicas

alter table public.task_templates
  add column if not exists assignee_ids jsonb;

-- Atualiza constraint de escopo
alter table public.task_templates
  drop constraint if exists task_templates_escopo_check;

alter table public.task_templates
  add constraint task_templates_escopo_check
  check (escopo in ('role', 'pessoal', 'usuarios'));

-- Atualiza constraint composta
alter table public.task_templates
  drop constraint if exists task_templates_check;

alter table public.task_templates
  add constraint task_templates_check
  check (
    (escopo = 'role'     and role          is not null) or
    (escopo = 'pessoal'  and owner_id      is not null) or
    (escopo = 'usuarios' and assignee_ids  is not null)
  );
```

- [ ] **Aplicar via MCP Supabase** (project `mtqdpjhhqzvuklnlfpvi`)

Chamar `apply_migration` com o conteúdo acima.

- [ ] **Verificar com `list_migrations`** — deve aparecer `20260617000001_tarefas_escopo_usuarios`

- [ ] **Commit**

```bash
git add supabase/migrations/20260617000001_tarefas_escopo_usuarios.sql
git commit -m "feat(tarefas): migration escopo usuarios em task_templates"
```

---

## Task 2 — Testes e gerador: suporte a escopo 'usuarios'

**Files:**
- Modificar: `lib/tarefas/geracao.test.js`

A função `gerarTarefasDoDia` em `geracao.js` **não muda**: o gerador já faz fan-out por `assignee_id` individualmente. A mudança é no `fakeRepo` (para testes) e no `repoTarefas()` real (Task 3).

- [ ] **Adicionar suporte a `escopo: 'usuarios'` no fakeRepo**

Em `lib/tarefas/geracao.test.js`, atualizar a função `fakeRepo` — substituir a função `templatesDoUsuario` de:

```js
async templatesDoUsuario(userId, roles) {
  return templates.filter(t =>
    (t.escopo === 'pessoal' && t.owner_id === userId) ||
    (t.escopo === 'role' && roles.includes(t.role))
  );
},
```

Para:

```js
async templatesDoUsuario(userId, roles) {
  return templates.filter(t =>
    (t.escopo === 'pessoal' && t.owner_id === userId) ||
    (t.escopo === 'role' && roles.includes(t.role)) ||
    (t.escopo === 'usuarios' && Array.isArray(t.assignee_ids) && t.assignee_ids.includes(userId))
  );
},
```

- [ ] **Adicionar 2 novos testes ao final do arquivo**

```js
test('gera tarefa para usuario em assignee_ids', async () => {
  const tpl = { id: 't3', escopo: 'usuarios', assignee_ids: ['u1', 'u2'],
    frequencia: 'diaria', dias_semana: null, titulo: 'Tarefa rotina p/ pessoas',
    arrasta: false, tipo_resultado: 'check', prioridade: 'normal' };
  const repo = fakeRepo([tpl]);
  await gerarTarefasDoDia(repo, 'u1', [], '2026-06-17');
  assert.strictEqual(repo._tasks.length, 1);
  assert.strictEqual(repo._tasks[0].assignee_id, 'u1');
});

test('nao gera para usuario fora de assignee_ids', async () => {
  const tpl = { id: 't4', escopo: 'usuarios', assignee_ids: ['u2'],
    frequencia: 'diaria', dias_semana: null, titulo: 'Tarefa so p/ u2',
    arrasta: false, tipo_resultado: 'check', prioridade: 'normal' };
  const repo = fakeRepo([tpl]);
  await gerarTarefasDoDia(repo, 'u1', [], '2026-06-17');
  assert.strictEqual(repo._tasks.length, 0);
});
```

- [ ] **Rodar testes**

```bash
node --test lib/tarefas/geracao.test.js
```

Esperado: 6 testes PASS (4 existentes + 2 novos).

- [ ] **Commit**

```bash
git add lib/tarefas/geracao.test.js
git commit -m "test(tarefas): cobertura de escopo usuarios no gerador"
```

---

## Task 3 — Backend: server.js

**Files:**
- Modificar: `server.js` (linhas 5482–5657)

### 3a — repoTarefas() inclui escopo 'usuarios'

- [ ] **Substituir `templatesDoUsuario` em `repoTarefas()`**

Localizar (linha ~5484):
```js
async templatesDoUsuario(userId, roles) {
  const orParts = [`and(escopo.eq.pessoal,owner_id.eq.${userId})`];
  if (roles.length) orParts.push(`and(escopo.eq.role,role.in.(${roles.join(',')}))`);
  const { data } = await supabase.from('task_templates')
    .select('*').eq('ativo', true).or(orParts.join(','));
  return data || [];
},
```

Substituir por:
```js
async templatesDoUsuario(userId, roles) {
  const orParts = [`and(escopo.eq.pessoal,owner_id.eq.${userId})`];
  if (roles.length) orParts.push(`and(escopo.eq.role,role.in.(${roles.join(',')}))`);
  const { data: byRoleOrPersonal } = await supabase.from('task_templates')
    .select('*').eq('ativo', true).or(orParts.join(','));
  const { data: byUsuarios } = await supabase.from('task_templates')
    .select('*').eq('ativo', true).eq('escopo', 'usuarios')
    .filter('assignee_ids', 'cs', JSON.stringify([userId]));
  return [...(byRoleOrPersonal || []), ...(byUsuarios || [])];
},
```

### 3b — GET /api/tarefas/templates com ?gestao=1

- [ ] **Atualizar endpoint GET** (linha ~5583)

Substituir o handler inteiro por:
```js
app.get('/api/tarefas/templates', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = await loadProfile(req);
    const roles = profile.roles || [];
    const isGestor = roles.some(r => r === 'admin' || r === 'gestor');

    if (req.query.gestao === '1' && isGestor) {
      const { data, error } = await supabase.from('task_templates')
        .select('*').eq('ativo', true)
        .in('escopo', ['role', 'usuarios'])
        .order('created_at');
      if (error) throw error;
      return res.json({ templates: data || [] });
    }

    const orParts = [`and(escopo.eq.pessoal,owner_id.eq.${userId})`];
    if (roles.length) orParts.push(`and(escopo.eq.role,role.in.(${roles.join(',')}))`);
    const { data, error } = await supabase.from('task_templates')
      .select('*').or(orParts.join(',')).order('created_at');
    if (error) throw error;
    res.json({ templates: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

### 3c — POST /api/tarefas/templates aceita escopo 'usuarios'

- [ ] **Atualizar endpoint POST** (linha ~5597)

Substituir o handler inteiro por:
```js
app.post('/api/tarefas/templates', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = await loadProfile(req);
    const isGestor = (profile.roles || []).some(r => r === 'admin' || r === 'gestor');
    const b = req.body || {};
    if (!b.titulo) return res.status(400).json({ error: 'titulo obrigatório' });
    const escopo = ['role', 'usuarios'].includes(b.escopo) ? b.escopo : 'pessoal';
    if (escopo !== 'pessoal' && !isGestor)
      return res.status(403).json({ error: 'Só gestor/admin cria rotina por cargo ou usuários' });
    const row = {
      titulo: b.titulo, descricao: b.descricao || null, escopo,
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
    };
    const { data, error } = await supabase.from('task_templates').insert(row).select().single();
    if (error) throw error;
    res.json({ template: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

### 3d — DELETE /api/tarefas/templates/:id com fechar_instancias

- [ ] **Atualizar endpoint DELETE** (linha ~5645)

Substituir o handler inteiro por:
```js
app.delete('/api/tarefas/templates/:id', requireAuth, async (req, res) => {
  try {
    const profile = await loadProfile(req);
    const isGestor = (profile.roles || []).some(r => r === 'admin' || r === 'gestor');
    const { data: tpl } = await supabase.from('task_templates')
      .select('*').eq('id', req.params.id).maybeSingle();
    if (!tpl) return res.status(404).json({ error: 'Molde não encontrado' });
    const pode = (tpl.escopo === 'pessoal' && tpl.owner_id === req.user.id) ||
                 ((tpl.escopo === 'role' || tpl.escopo === 'usuarios') && isGestor);
    if (!pode) return res.status(403).json({ error: 'Sem permissão' });
    if (req.body && req.body.fechar_instancias) {
      await supabase.from('tasks')
        .delete()
        .eq('template_id', tpl.id)
        .eq('status', 'pendente');
    }
    const { error } = await supabase.from('task_templates').delete().eq('id', tpl.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Commit**

```bash
git add server.js
git commit -m "feat(tarefas): escopo usuarios + fechar_instancias no delete + gestao=1"
```

---

## Task 4 — Frontend HTML: 3 abas

**Files:**
- Modificar: `public/tarefas/gestao.html`

- [ ] **Substituir os 4 tabs por 3 tabs** — localizar o `<nav class="mod-tabs">` e substituir pelo bloco abaixo:

```html
<nav class="mod-tabs" role="tablist" aria-label="Abas de Gestão de Tarefas">
  <button class="mod-tab active" id="tab-btn-painel" role="tab" aria-selected="true" aria-controls="tab-painel" data-tab="painel">
    Painel
  </button>
  <button class="mod-tab" id="tab-btn-criar" role="tab" aria-selected="false" aria-controls="tab-criar" data-tab="criar">
    Criar
  </button>
  <button class="mod-tab" id="tab-btn-historico" role="tab" aria-selected="false" aria-controls="tab-historico" data-tab="historico">
    Histórico
  </button>
</nav>
```

- [ ] **Substituir os 4 divs de pane pelos 3 novos** — localizar os `<div id="tab-*">` e substituir por:

```html
<div id="tab-painel" class="mod-pane active" role="tabpanel" aria-labelledby="tab-btn-painel">
  <div id="painel-root"><p class="loading-msg">Carregando...</p></div>
</div>

<div id="tab-criar" class="mod-pane" role="tabpanel" aria-labelledby="tab-btn-criar">
  <div id="criar-root"></div>
</div>

<div id="tab-historico" class="mod-pane" role="tabpanel" aria-labelledby="tab-btn-historico">
  <div id="historico-root"><p class="loading-msg">Carregando...</p></div>
</div>
```

- [ ] **Adicionar CSS para `.tipo-btn`** — dentro do `<style>`, antes de `</style>`:

```css
/* TIPO TOGGLE (Demanda / Rotina) */
.tipo-toggle {
  display: flex; gap: 4px; margin-bottom: 24px;
  background: var(--bg3); border: 1px solid var(--border);
  border-radius: 10px; padding: 4px; width: fit-content;
}
.tipo-btn {
  padding: 7px 22px; border-radius: 7px; font-size: 13px; font-weight: 600;
  cursor: pointer; border: none; background: transparent; color: var(--muted);
  font-family: inherit; transition: all .15s;
}
.tipo-btn.active {
  background: var(--bg2); color: var(--text);
  box-shadow: 0 1px 4px rgba(0,0,0,.15);
}
```

- [ ] **Atualizar subtítulo da página** — mudar:

```html
<div class="page-subtitle">Painel da equipe, atribuição e moldes por cargo</div>
```

Para:

```html
<div class="page-subtitle">Painel da equipe, criação de tarefas e histórico</div>
```

- [ ] **Commit**

```bash
git add public/tarefas/gestao.html
git commit -m "feat(tarefas): html - 3 abas unificadas (Painel/Criar/Historico)"
```

---

## Task 5 — gestao.js: limpar código antigo e adicionar formulário unificado

**Files:**
- Modificar: `public/js/tarefas/gestao.js`

### 5a — Remover código das abas antigas

- [ ] **Atualizar comment no topo do arquivo** — linha 2, mudar para:

```js
// Gestão de Tarefas — Painel / Criar / Histórico
```

- [ ] **Atualizar `initTabs()`** — localizar as linhas:

```js
if (btn.dataset.tab === 'atribuir')  renderAtribuirForm();
if (btn.dataset.tab === 'moldes')    loadMoldes();
```

Substituir por:

```js
if (btn.dataset.tab === 'criar')     renderCriarForm();
```

- [ ] **Atualizar `init()`** — localizar:

```js
async function init() {
  initTabs();
  await loadPessoas();
  renderPainelFilters();
  renderAtribuirForm();
}
```

Substituir por:

```js
async function init() {
  initTabs();
  await loadPessoas();
  renderPainelFilters();
}
```

- [ ] **Remover bloco "ATRIBUIR TAB"** — apagar tudo entre os comentários `// ── ATRIBUIR TAB` e `// ── MOLDES TAB` (inclusive as funções `renderAtribuirForm`, `_atSelectAll`, `_onAtNumeroChange`, `_salvarAtribuicao`, `_limparAtribuirForm`)

- [ ] **Remover bloco "MOLDES TAB"** — apagar tudo entre `// ── MOLDES TAB` e `// ── HISTÓRICO TAB` (inclusive `loadMoldes`, `_deletarMolde`, `_openNovoMolde`, `_onMoldeFreqChange`, `_onMoldeNumeroChange`, `_toggleMoldeDia`, `_salvarMolde`)

### 5b — Adicionar formulário unificado

- [ ] **Adicionar seção "CRIAR TAB"** — inserir antes de `// ── HISTÓRICO TAB` o bloco completo abaixo:

```js
// ── CRIAR TAB ────────────────────────────────────────────────────────────────
function renderCriarForm() {
  const root = document.getElementById('criar-root');
  if (!root) return;

  const pessoasHtmlDem = _pessoas.length === 0
    ? '<p style="font-size:13px;color:var(--muted);padding:8px 12px">Nenhuma pessoa ativa encontrada.</p>'
    : _pessoas.map(function (p) {
        return `<label class="pessoa-check">
          <input type="checkbox" class="cr-pessoa-dem-cb" value="${esc(p.id)}">
          ${esc(p.nome)}
        </label>`;
      }).join('');

  const pessoasHtmlRot = _pessoas.length === 0
    ? '<p style="font-size:13px;color:var(--muted);padding:8px 12px">Nenhuma pessoa ativa encontrada.</p>'
    : _pessoas.map(function (p) {
        return `<label class="pessoa-check">
          <input type="checkbox" class="cr-pessoa-rot-cb" value="${esc(p.id)}">
          ${esc(p.nome)}
        </label>`;
      }).join('');

  const diasHtml = DIAS_LABELS.map(function (d, i) {
    return '<label class="dia-btn" id="cr-dia-label-' + i + '"><input type="checkbox" id="cr-dia-' + i + '" value="' + i + '" onchange="_toggleCriarDia(' + i + ')"> ' + d + '</label>';
  }).join('');

  const cargosHtml = ROLES_CARGO.map(function (r) {
    return '<option value="' + esc(r) + '">' + esc(r) + '</option>';
  }).join('');

  const catsHtml = CATEGORIAS.map(function (c) {
    return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
  }).join('');

  root.innerHTML = `
    <div style="max-width:560px">

      <div class="tipo-toggle">
        <button class="tipo-btn active" id="cr-btn-demanda" onclick="_onTipoAtividade('demanda')">Demanda</button>
        <button class="tipo-btn"        id="cr-btn-rotina"  onclick="_onTipoAtividade('rotina')">Rotina</button>
      </div>

      <!-- Campos comuns -->
      <div class="form-row">
        <label class="form-label">Título *</label>
        <input class="form-input" id="cr-titulo" type="text" placeholder="Ex: Ligar para leads pendentes" autocomplete="off">
      </div>
      <div class="form-row">
        <label class="form-label">Descrição</label>
        <textarea class="form-textarea" id="cr-desc" placeholder="Detalhes opcionais..."></textarea>
      </div>
      <div class="form-row-2">
        <div>
          <label class="form-label">Prioridade</label>
          <select class="form-select" id="cr-prio">
            <option value="normal">Normal</option>
            <option value="alta">Alta</option>
            <option value="baixa">Baixa</option>
          </select>
        </div>
        <div>
          <label class="form-label">Categoria</label>
          <select class="form-select" id="cr-cat">
            <option value="">Nenhuma</option>
            ${catsHtml}
          </select>
        </div>
      </div>
      <div class="form-row-2">
        <div>
          <label class="form-label">Tipo de resultado</label>
          <select class="form-select" id="cr-tipo-resultado" onchange="_onCriarNumeroChange()">
            <option value="check">Check (feito/não feito)</option>
            <option value="numero">Número (valor numérico)</option>
          </select>
        </div>
        <div></div>
      </div>
      <div id="cr-numero-wrap" style="display:none" class="form-row-2">
        <div>
          <label class="form-label">Unidade</label>
          <input class="form-input" id="cr-unidade" type="text" placeholder="Ex: ligações, R$">
        </div>
        <div>
          <label class="form-label">Meta</label>
          <input class="form-input" id="cr-meta" type="number" step="any" placeholder="Ex: 10">
        </div>
      </div>
      <div class="form-row">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
          <input type="checkbox" id="cr-arrasta">
          <span><strong>Arrasta</strong> — se não concluída hoje, aparece amanhã</span>
        </label>
      </div>

      <!-- Seção DEMANDA -->
      <div id="cr-demanda-section">
        <div class="form-row">
          <label class="form-label">Prazo (opcional)</label>
          <input class="form-input" id="cr-prazo" type="datetime-local" style="max-width:260px">
        </div>
        <div class="form-row">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <label class="form-label" style="margin:0">Para quem *</label>
            <button class="btn btn-ghost btn-sm" onclick="_criarSelectAll('dem')">Selecionar todos</button>
          </div>
          <div class="pessoas-list">${pessoasHtmlDem}</div>
        </div>
      </div>

      <!-- Seção ROTINA -->
      <div id="cr-rotina-section" style="display:none">
        <div class="form-row-2">
          <div>
            <label class="form-label">Frequência</label>
            <select class="form-select" id="cr-freq" onchange="_onRotinaFreqChange()">
              <option value="diaria">Diária</option>
              <option value="semanal">Semanal</option>
              <option value="mensal">Mensal</option>
            </select>
          </div>
          <div></div>
        </div>
        <div id="cr-dias-wrap" style="display:none" class="form-row">
          <label class="form-label">Dias da semana</label>
          <div class="dias-grid">${diasHtml}</div>
        </div>
        <div id="cr-diames-wrap" style="display:none" class="form-row">
          <label class="form-label">Dia do mês (1–31)</label>
          <input class="form-input" id="cr-diames" type="number" min="1" max="31" placeholder="Ex: 1" style="max-width:120px">
        </div>
        <div class="form-row">
          <label class="form-label">Destino</label>
          <div style="display:flex;gap:20px;margin-top:4px">
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
              <input type="radio" name="cr-destino" id="cr-destino-cargo" value="cargo" checked onchange="_onRotinaDestinoChange()">
              Por cargo
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
              <input type="radio" name="cr-destino" id="cr-destino-pessoas" value="pessoas" onchange="_onRotinaDestinoChange()">
              Pessoas específicas
            </label>
          </div>
        </div>
        <div id="cr-cargo-wrap" class="form-row">
          <label class="form-label">Cargo</label>
          <select class="form-select" id="cr-role" style="max-width:260px">
            <option value="">Selecione</option>
            ${cargosHtml}
          </select>
        </div>
        <div id="cr-pessoas-rotina-wrap" style="display:none" class="form-row">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <label class="form-label" style="margin:0">Para quem *</label>
            <button class="btn btn-ghost btn-sm" onclick="_criarSelectAll('rot')">Selecionar todos</button>
          </div>
          <div class="pessoas-list">${pessoasHtmlRot}</div>
        </div>
      </div>

      <div class="form-actions" style="justify-content:flex-start;margin-top:20px">
        <button class="btn btn-primary" onclick="_salvarCriar()">Criar tarefa(s)</button>
        <button class="btn btn-ghost" onclick="_limparCriar()">Limpar</button>
      </div>
    </div>`;
}

window._onTipoAtividade = function (tipo) {
  const btnDem = document.getElementById('cr-btn-demanda');
  const btnRot = document.getElementById('cr-btn-rotina');
  const secDem = document.getElementById('cr-demanda-section');
  const secRot = document.getElementById('cr-rotina-section');
  if (!btnDem) return;
  const isDemanda = tipo === 'demanda';
  btnDem.classList.toggle('active', isDemanda);
  btnRot.classList.toggle('active', !isDemanda);
  secDem.style.display = isDemanda ? '' : 'none';
  secRot.style.display = isDemanda ? 'none' : '';
};

window._onCriarNumeroChange = function () {
  const tipo = document.getElementById('cr-tipo-resultado').value;
  const wrap = document.getElementById('cr-numero-wrap');
  if (wrap) wrap.style.display = tipo === 'numero' ? '' : 'none';
};

window._onRotinaFreqChange = function () {
  const freq      = document.getElementById('cr-freq').value;
  const diasWrap  = document.getElementById('cr-dias-wrap');
  const diaMWrap  = document.getElementById('cr-diames-wrap');
  if (diasWrap)  diasWrap.style.display  = freq === 'semanal' ? '' : 'none';
  if (diaMWrap)  diaMWrap.style.display  = freq === 'mensal'  ? '' : 'none';
};

window._onRotinaDestinoChange = function () {
  const checked     = document.querySelector('input[name="cr-destino"]:checked');
  const cargoWrap   = document.getElementById('cr-cargo-wrap');
  const pessoasWrap = document.getElementById('cr-pessoas-rotina-wrap');
  if (!checked) return;
  const isCargo = checked.value === 'cargo';
  if (cargoWrap)   cargoWrap.style.display   = isCargo ? '' : 'none';
  if (pessoasWrap) pessoasWrap.style.display = isCargo ? 'none' : '';
};

window._toggleCriarDia = function (i) {
  const label = document.getElementById('cr-dia-label-' + i);
  const cb    = document.getElementById('cr-dia-' + i);
  if (label && cb) label.classList.toggle('checked', cb.checked);
};

window._criarSelectAll = function (scope) {
  document.querySelectorAll('.cr-pessoa-' + scope + '-cb').forEach(function (cb) { cb.checked = true; });
};

window._salvarCriar = async function () {
  const titulo   = (document.getElementById('cr-titulo').value || '').trim();
  if (!titulo) { toast('Informe o título.', 'warning'); return; }

  const desc     = (document.getElementById('cr-desc').value || '').trim();
  const prio     = document.getElementById('cr-prio').value;
  const cat      = document.getElementById('cr-cat').value;
  const tipoRes  = document.getElementById('cr-tipo-resultado').value;
  const arrasta  = document.getElementById('cr-arrasta').checked;
  const isDemanda = document.getElementById('cr-btn-demanda').classList.contains('active');

  const commonBody = { titulo, prioridade: prio, tipo_resultado: tipoRes, arrasta };
  if (desc) commonBody.descricao = desc;
  if (cat)  commonBody.categoria = cat;
  if (tipoRes === 'numero') {
    const un   = (document.getElementById('cr-unidade').value || '').trim();
    const meta = document.getElementById('cr-meta').value;
    if (un)   commonBody.unidade = un;
    if (meta) commonBody.meta = Number(meta);
  }

  if (isDemanda) {
    const prazo = document.getElementById('cr-prazo').value;
    const assignee_ids = [];
    document.querySelectorAll('.cr-pessoa-dem-cb:checked').forEach(function (cb) { assignee_ids.push(cb.value); });
    if (assignee_ids.length === 0) { toast('Selecione ao menos uma pessoa.', 'warning'); return; }
    const body = Object.assign({}, commonBody, { assignee_ids });
    if (prazo) body.prazo = new Date(prazo).toISOString();
    try {
      await tarefasApi('/api/tarefas', { method: 'POST', body: JSON.stringify(body) });
      toast('Demanda criada para ' + assignee_ids.length + ' pessoa(s)!', 'success');
      _limparCriar();
    } catch (e) { toast(e.message, 'error'); }

  } else {
    const freq    = document.getElementById('cr-freq').value;
    const checked = document.querySelector('input[name="cr-destino"]:checked');
    const destino = checked ? checked.value : 'cargo';
    const body    = Object.assign({}, commonBody, { frequencia: freq });

    if (freq === 'semanal') {
      const dias = [];
      for (let i = 0; i < 7; i++) {
        const cb = document.getElementById('cr-dia-' + i);
        if (cb && cb.checked) dias.push(i);
      }
      if (dias.length === 0) { toast('Selecione ao menos um dia da semana.', 'warning'); return; }
      body.dias_semana = dias;
    }
    if (freq === 'mensal') {
      const dm = parseInt(document.getElementById('cr-diames').value, 10);
      if (!dm || dm < 1 || dm > 31) { toast('Informe o dia do mês (1–31).', 'warning'); return; }
      body.dia_mes = dm;
    }

    if (destino === 'cargo') {
      const role = document.getElementById('cr-role').value;
      if (!role) { toast('Selecione o cargo.', 'warning'); return; }
      body.escopo = 'role';
      body.role   = role;
    } else {
      const assignee_ids = [];
      document.querySelectorAll('.cr-pessoa-rot-cb:checked').forEach(function (cb) { assignee_ids.push(cb.value); });
      if (assignee_ids.length === 0) { toast('Selecione ao menos uma pessoa.', 'warning'); return; }
      body.escopo       = 'usuarios';
      body.assignee_ids = assignee_ids;
    }

    try {
      await tarefasApi('/api/tarefas/templates', { method: 'POST', body: JSON.stringify(body) });
      toast('Rotina criada!', 'success');
      _limparCriar();
    } catch (e) { toast(e.message, 'error'); }
  }
};

window._limparCriar = function () {
  ['cr-titulo','cr-desc','cr-prazo','cr-unidade','cr-meta','cr-diames'].forEach(function (id) {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const prio    = document.getElementById('cr-prio');          if (prio)    prio.value    = 'normal';
  const cat     = document.getElementById('cr-cat');           if (cat)     cat.value     = '';
  const tipoRes = document.getElementById('cr-tipo-resultado');if (tipoRes) tipoRes.value = 'check';
  const freq    = document.getElementById('cr-freq');          if (freq)    freq.value    = 'diaria';
  const role    = document.getElementById('cr-role');          if (role)    role.value    = '';
  const arrasta = document.getElementById('cr-arrasta');       if (arrasta) arrasta.checked = false;
  const numWrap = document.getElementById('cr-numero-wrap');   if (numWrap) numWrap.style.display = 'none';
  const dWrap   = document.getElementById('cr-dias-wrap');     if (dWrap)   dWrap.style.display   = 'none';
  const dmWrap  = document.getElementById('cr-diames-wrap');   if (dmWrap)  dmWrap.style.display  = 'none';
  for (let i = 0; i < 7; i++) {
    const cb    = document.getElementById('cr-dia-' + i);       if (cb)    cb.checked = false;
    const label = document.getElementById('cr-dia-label-' + i); if (label) label.classList.remove('checked');
  }
  document.querySelectorAll('.cr-pessoa-dem-cb, .cr-pessoa-rot-cb').forEach(function (cb) { cb.checked = false; });
  const destCargo = document.getElementById('cr-destino-cargo'); if (destCargo) destCargo.checked = true;
  _onRotinaDestinoChange();
  _onTipoAtividade('demanda');
};
```

- [ ] **Commit**

```bash
git add public/js/tarefas/gestao.js
git commit -m "feat(tarefas): formulario unificado Demanda/Rotina na aba Criar"
```

---

## Task 6 — gestao.js: Painel com Rotinas ativas + modal de exclusão

**Files:**
- Modificar: `public/js/tarefas/gestao.js`

- [ ] **Atualizar `renderPainelFilters()`** — substituir o corpo da função por:

```js
function renderPainelFilters() {
  const root = document.getElementById('painel-root');
  if (!root) return;
  const h = hojeISO();
  root.innerHTML = `
    <div id="rotinas-ativas-wrap" style="margin-bottom:20px"></div>
    <div class="painel-filters">
      <div>
        <label>De</label>
        <input type="date" id="painel-de" value="${esc(h)}">
      </div>
      <div>
        <label>Até</label>
        <input type="date" id="painel-ate" value="${esc(h)}">
      </div>
      <button class="btn btn-primary btn-sm" onclick="_loadPainel()">Atualizar</button>
    </div>
    <div id="painel-table-wrap"><p class="loading-msg">Carregando...</p></div>`;
  loadRotinasAtivas();
  loadPainelData();
}
```

- [ ] **Adicionar função `loadRotinasAtivas()`** — inserir antes de `renderPainelFilters()`:

```js
async function loadRotinasAtivas() {
  const wrap = document.getElementById('rotinas-ativas-wrap');
  if (!wrap) return;
  try {
    const data = await tarefasApi('/api/tarefas/templates?gestao=1');
    const templates = data.templates || [];
    if (templates.length === 0) {
      wrap.innerHTML = '';
      return;
    }
    const itemsHtml = templates.map(function (t) {
      const destino = t.escopo === 'role'
        ? esc(t.role || '')
        : (Array.isArray(t.assignee_ids) ? t.assignee_ids.map(function (id) { return esc(nomePessoa(id)); }).join(', ') : '');
      return `
        <div class="rotina-item">
          <div class="rotina-body">
            <div class="rotina-titulo">🔁 ${esc(t.titulo)}</div>
            <div class="rotina-meta">
              <span class="chip">${esc(fmtFreq(t))}</span>
              <span class="chip">${destino}</span>
              ${t.arrasta ? '<span class="chip" style="color:var(--yellow);border-color:rgba(245,158,11,.3)">arrasta</span>' : ''}
            </div>
          </div>
          <button class="tarefa-del" onclick="_confirmarExcluirRotina('${esc(t.id)}', '${esc(t.titulo)}')" title="Excluir rotina">×</button>
        </div>`;
    }).join('');

    wrap.innerHTML = `
      <div>
        <button onclick="_toggleRotinasAtivas()" style="display:flex;align-items:center;gap:6px;font-size:13.5px;font-weight:600;background:none;border:none;cursor:pointer;color:var(--text);padding:0;margin-bottom:10px;font-family:inherit">
          <span id="rotinas-chevron">▼</span> Rotinas ativas (${templates.length})
        </button>
        <div id="rotinas-lista">${itemsHtml}</div>
      </div>`;
  } catch (e) {
    const wrap2 = document.getElementById('rotinas-ativas-wrap');
    if (wrap2) wrap2.innerHTML = '';
  }
}
```

- [ ] **Adicionar handlers de toggle e exclusão** — inserir logo após `loadRotinasAtivas()`:

```js
window._toggleRotinasAtivas = function () {
  const lista   = document.getElementById('rotinas-lista');
  const chevron = document.getElementById('rotinas-chevron');
  if (!lista) return;
  const hidden = lista.style.display === 'none';
  lista.style.display  = hidden ? '' : 'none';
  if (chevron) chevron.textContent = hidden ? '▼' : '▶';
};

window._confirmarExcluirRotina = function (id, titulo) {
  const modal = document.getElementById('tarefas-modal');
  const bg    = document.getElementById('tarefas-modal-bg');
  if (!modal || !bg) return;
  modal.innerHTML = `
    <h2>Excluir rotina?</h2>
    <p style="font-size:13.5px;color:var(--muted);margin-bottom:20px">"${esc(titulo)}"</p>
    <div style="display:flex;flex-direction:column;gap:14px;margin-bottom:24px">
      <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13.5px">
        <input type="radio" name="del-modo" id="del-so-molde" value="molde" checked style="margin-top:3px">
        <span><strong>Excluir só o molde</strong><br><span style="font-size:12px;color:var(--muted)">Tarefas abertas de hoje continuam nas Centrais da equipe</span></span>
      </label>
      <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13.5px">
        <input type="radio" name="del-modo" id="del-com-instancias" value="instancias" style="margin-top:3px">
        <span><strong>Excluir molde + fechar instâncias abertas</strong><br><span style="font-size:12px;color:var(--muted)">Remove também as tarefas pendentes desta rotina de todos</span></span>
      </label>
    </div>
    <div class="form-actions">
      <button class="btn btn-ghost" onclick="_closeModal()">Cancelar</button>
      <button class="btn btn-danger" onclick="_executarExcluirRotina('${esc(id)}')">Excluir</button>
    </div>`;
  bg.classList.add('open');
};

window._executarExcluirRotina = async function (id) {
  const fecharEl = document.getElementById('del-com-instancias');
  const fecharInstancias = fecharEl && fecharEl.checked;
  try {
    await tarefasApi('/api/tarefas/templates/' + id, {
      method: 'DELETE',
      body: JSON.stringify({ fechar_instancias: !!fecharInstancias }),
    });
    window._closeModal();
    toast('Rotina excluída.', 'info');
    loadRotinasAtivas();
  } catch (e) {
    toast(e.message, 'error');
  }
};
```

- [ ] **Commit**

```bash
git add public/js/tarefas/gestao.js
git commit -m "feat(tarefas): painel com rotinas ativas + modal exclusao com opcoes"
```

---

## Task 7 — Deploy e validação

- [ ] **Push e deploy**

```bash
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

- [ ] **Validar critério 1** — Abrir `/tarefas/gestao.html` → 3 abas (Painel, Criar, Histórico). Clicar "Criar" → toggle Demanda/Rotina aparece, formulário mostra seção correta ao alternar.

- [ ] **Validar critério 2** — No modo Demanda: preencher título, selecionar 2 pessoas → "Criar tarefa(s)" → toast "Demanda criada para 2 pessoa(s)". Logar como uma das pessoas → `/tarefas/` → tarefa aparece como pontual.

- [ ] **Validar critério 3** — No modo Rotina, destino "Por cargo": preencher título, diária, cargo crc_leads → criar → Painel lista rotina em "Rotinas ativas". Na Central de uma CRC Lead, tarefa aparece no próximo cron ou ao recarregar.

- [ ] **Validar critério 4** — No modo Rotina, destino "Pessoas específicas": selecionar 2 pessoas → criar → Painel lista rotina com nomes.

- [ ] **Validar critério 5** — Clicar × numa rotina → modal com duas opções aparece. Selecionar "Excluir só o molde" → rotina some da lista; tarefas pendentes da equipe permanecem.

- [ ] **Validar critério 6** — Clicar × noutra rotina → selecionar "Excluir molde + fechar instâncias" → rotina some; tarefas pendentes desta rotina somem das Centrais.
