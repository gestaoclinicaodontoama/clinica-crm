# Sistema de Funções (RBAC) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar um sistema de Funções (cargos) que agrupa roles, permitindo gerenciar acesso de um cargo inteiro editando apenas a Função, sem tocar em cada usuário individualmente.

**Architecture:** Duas novas tabelas (`funcoes`, `user_funcoes`) + coluna `profiles.roles_extra`. Triggers no Postgres recalculam `profiles.roles` automaticamente toda vez que uma função é editada ou atribuída/removida de um usuário. Todo o resto do sistema (requireRole, nav, RLS) continua funcionando sem mudança.

**Tech Stack:** Node.js + Express, Supabase (Postgres + Auth + RLS), HTML/JS vanilla, MCP Supabase para migrations.

## Global Constraints

- Supabase Project ID: `mtqdpjhhqzvuklnlfpvi` — aplicar migrations via MCP `apply_migration`
- Deploy após cada task: `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`
- Auth em páginas standalone: token via `localStorage` key `sb-*-auth-token`, header `Authorization: Bearer <token>`
- `profiles.roles` nunca escrito diretamente no novo código — sempre pelo trigger
- NUNCA usar `.catch()` diretamente no builder Supabase — usar `try/catch` no `await`
- Spec: `docs/superpowers/specs/2026-06-17-funcoes-rbac-design.md`

---

## File Map

**Criar:**
- `supabase/migrations/20260617100000_funcoes_rbac.sql`
- `public/admin/funcoes/index.html`

**Modificar:**
- `server.js` — rotas admin funcoes (após linha 450) + rotas de usuários (linhas 389–436)
- `public/index.html` — nav (linha 714), modal novo usuário (linhas 1185–1202), modal editar usuário (linhas 1464–1482), JS funções (linhas 5543–5748)
- `public/js/shared-nav.js` — seção config (linha 190–193)

---

## Task 1: DB Migration — Tabelas, Triggers e RPC

**Files:**
- Create: `supabase/migrations/20260617100000_funcoes_rbac.sql`

**Interfaces:**
- Produces: tabela `funcoes(id uuid, nome text, roles text[])`, tabela `user_funcoes(user_id, funcao_id)`, coluna `profiles.roles_extra text[]`, função `admin_update_user_funcoes(p_admin_id, p_user_id, p_funcao_ids, p_roles_extra, p_nome)`, trigger automático de recálculo em `profiles.roles`

---

- [ ] **Step 1: Escrever o arquivo de migration**

Criar `supabase/migrations/20260617100000_funcoes_rbac.sql` com o conteúdo:

```sql
-- ====== SISTEMA DE FUNÇÕES (RBAC) ======

-- 1. Tabela de funções (cargos)
CREATE TABLE funcoes (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome  text NOT NULL,
  roles text[] NOT NULL DEFAULT '{}'
);

-- 2. Atribuição usuário ↔ funções (N:N)
CREATE TABLE user_funcoes (
  user_id   uuid REFERENCES profiles(id) ON DELETE CASCADE,
  funcao_id uuid REFERENCES funcoes(id)  ON DELETE CASCADE,
  PRIMARY KEY (user_id, funcao_id)
);

-- 3. Permissões individuais por usuário (além das funções)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS roles_extra text[] NOT NULL DEFAULT '{}';

-- 4. Migração: preservar roles existentes em roles_extra
--    (antes dos triggers, para não disparar recálculo desnecessário)
UPDATE profiles SET roles_extra = roles
WHERE roles IS NOT NULL AND array_length(roles, 1) > 0;

-- 5. Função de recálculo: profiles.roles = union(funcoes.roles) ∪ roles_extra
CREATE OR REPLACE FUNCTION recalculate_user_roles(p_user_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE profiles SET roles = (
    SELECT COALESCE(ARRAY_AGG(DISTINCT r), '{}')
    FROM (
      SELECT UNNEST(f.roles) AS r
      FROM funcoes f
      JOIN user_funcoes uf ON uf.funcao_id = f.id
      WHERE uf.user_id = p_user_id
      UNION
      SELECT UNNEST(p.roles_extra)
      FROM profiles p WHERE p.id = p_user_id
    ) sub
  )
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. Trigger: atribuição de função ao usuário mudou
CREATE OR REPLACE FUNCTION trg_user_funcoes_changed()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM recalculate_user_roles(OLD.user_id);
  ELSE
    PERFORM recalculate_user_roles(NEW.user_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_user_funcoes
AFTER INSERT OR UPDATE OR DELETE ON user_funcoes
FOR EACH ROW EXECUTE FUNCTION trg_user_funcoes_changed();

-- 7. Trigger: roles de uma função foram editadas → atualiza TODOS os usuários dela
CREATE OR REPLACE FUNCTION trg_funcao_roles_changed()
RETURNS trigger AS $$
DECLARE
  uid uuid;
BEGIN
  FOR uid IN
    SELECT user_id FROM user_funcoes WHERE funcao_id = NEW.id
  LOOP
    PERFORM recalculate_user_roles(uid);
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_funcao_roles
AFTER UPDATE OF roles ON funcoes
FOR EACH ROW EXECUTE FUNCTION trg_funcao_roles_changed();

-- 8. Trigger: roles_extra de um usuário foi editado → recalcula
CREATE OR REPLACE FUNCTION trg_profile_roles_extra_changed()
RETURNS trigger AS $$
BEGIN
  PERFORM recalculate_user_roles(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profile_roles_extra
AFTER UPDATE OF roles_extra ON profiles
FOR EACH ROW EXECUTE FUNCTION trg_profile_roles_extra_changed();

-- 9. RPC para admin atualizar funcoes + roles_extra de um usuário (em transação)
CREATE OR REPLACE FUNCTION admin_update_user_funcoes(
  p_admin_id    uuid,
  p_user_id     uuid,
  p_funcao_ids  uuid[],
  p_roles_extra text[],
  p_nome        text DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_admin_id AND roles @> ARRAY['admin']
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Atualiza nome se fornecido
  IF p_nome IS NOT NULL THEN
    UPDATE profiles SET nome = p_nome WHERE id = p_user_id;
  END IF;

  -- Substitui funções do usuário
  DELETE FROM user_funcoes WHERE user_id = p_user_id;
  IF p_funcao_ids IS NOT NULL AND array_length(p_funcao_ids, 1) > 0 THEN
    INSERT INTO user_funcoes (user_id, funcao_id)
    SELECT p_user_id, UNNEST(p_funcao_ids);
  END IF;

  -- Atualiza roles_extra → trigger recalcula profiles.roles automaticamente
  UPDATE profiles
  SET roles_extra = COALESCE(p_roles_extra, '{}')
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 10. RLS para funcoes
ALTER TABLE funcoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "funcoes_select_authenticated" ON funcoes
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "funcoes_admin_write" ON funcoes
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles @> ARRAY['admin']))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles @> ARRAY['admin']));

-- 11. RLS para user_funcoes
ALTER TABLE user_funcoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_funcoes_select_authenticated" ON user_funcoes
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "user_funcoes_admin_write" ON user_funcoes
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles @> ARRAY['admin']))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles @> ARRAY['admin']));
```

- [ ] **Step 2: Aplicar via MCP Supabase**

Usar a tool `mcp__plugin_supabase_supabase__apply_migration` com:
- `project_id: "mtqdpjhhqzvuklnlfpvi"`
- `name: "funcoes_rbac"`
- `query: <conteúdo completo do arquivo acima>`

- [ ] **Step 3: Verificar migration aplicada**

Usar `mcp__plugin_supabase_supabase__list_migrations` e confirmar que `funcoes_rbac` aparece.

- [ ] **Step 4: Verificar dados migrados**

Usar `mcp__plugin_supabase_supabase__execute_sql` com:
```sql
SELECT id, nome, array_length(roles,1) as n_roles, array_length(roles_extra,1) as n_extra
FROM profiles
LIMIT 5;
```
Esperado: `roles_extra` igual a `roles` para todos os usuários existentes.

- [ ] **Step 5: Testar trigger manualmente**

```sql
-- Criar funcao de teste
INSERT INTO funcoes (nome, roles) VALUES ('Teste', ARRAY['gestor']) RETURNING id;
-- Anote o UUID retornado como <funcao_id>

-- Atribuir a um usuário existente (use qualquer id real)
INSERT INTO user_funcoes (user_id, funcao_id)
SELECT id, '<funcao_id>' FROM profiles LIMIT 1;

-- Verificar que roles do usuário inclui 'gestor'
SELECT p.id, p.roles, p.roles_extra FROM profiles p
JOIN user_funcoes uf ON uf.user_id = p.id
JOIN funcoes f ON f.id = uf.funcao_id
WHERE f.nome = 'Teste';

-- Limpar teste
DELETE FROM funcoes WHERE nome = 'Teste';
```
Esperado: `roles` do usuário contém `'gestor'` + todos seus `roles_extra` anteriores.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260617100000_funcoes_rbac.sql
git commit -m "feat: migration funcoes RBAC — tabelas, triggers e RPC"
```

---

## Task 2: Backend API — Rotas de Funções + Usuários Atualizados

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `admin_update_user_funcoes(p_admin_id, p_user_id, p_funcao_ids, p_roles_extra, p_nome)` da Task 1
- Produces:
  - `GET /api/admin/funcoes` → `[{id, nome, roles}]`
  - `POST /api/admin/funcoes` → `{id, nome, roles}`
  - `PATCH /api/admin/funcoes/:id` → `{id, nome, roles}`
  - `DELETE /api/admin/funcoes/:id` → `{ok: true}`
  - `GET /api/admin/users` → `[{id, nome, email, roles, funcoes: [{id, nome}], roles_extra}]`
  - `POST /api/admin/users` aceita `{nome, email, senha, funcoes: [uuid], roles_extra: [string]}`
  - `PATCH /api/admin/users/:id` aceita `{nome, funcoes: [uuid], roles_extra: [string]}`

---

- [ ] **Step 1: Adicionar rotas CRUD de funcoes em `server.js`**

Localizar a linha `// ========== CAPTURAR LEAD ==========` (linha ~451) e inserir **antes** dela:

```js
// ========== ADMIN: FUNÇÕES ==========
app.get('/api/admin/funcoes', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('funcoes').select('*').order('nome');
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/funcoes', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nome, roles } = req.body;
    if (!nome) return res.status(400).json({ error: 'nome obrigatório' });
    const { data, error } = await supabase
      .from('funcoes').insert({ nome, roles: Array.isArray(roles) ? roles : [] })
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/funcoes/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nome, roles } = req.body;
    const updates = {};
    if (nome !== undefined) updates.nome = nome;
    if (roles !== undefined) updates.roles = Array.isArray(roles) ? roles : [];
    const { data, error } = await supabase
      .from('funcoes').update(updates).eq('id', req.params.id)
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/funcoes/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('funcoes').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 2: Atualizar `GET /api/admin/users` para retornar funcoes e roles_extra**

Substituir o handler existente (linhas 389–397):

```js
// ANTES (remover):
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('admin_list_users', { p_admin_id: req.user.id });
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DEPOIS (inserir):
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: users, error } = await supabase.rpc('admin_list_users', { p_admin_id: req.user.id });
    if (error) throw error;
    if (!users?.length) return res.json([]);

    const userIds = users.map(u => u.id);

    const [{ data: uf }, { data: profiles }] = await Promise.all([
      supabase.from('user_funcoes').select('user_id, funcao:funcao_id(id, nome)').in('user_id', userIds),
      supabase.from('profiles').select('id, roles_extra').in('id', userIds),
    ]);

    const funcoesByUser = {};
    (uf || []).forEach(row => {
      if (!funcoesByUser[row.user_id]) funcoesByUser[row.user_id] = [];
      funcoesByUser[row.user_id].push(row.funcao);
    });
    const extrasByUser = {};
    (profiles || []).forEach(p => { extrasByUser[p.id] = p.roles_extra || []; });

    res.json(users.map(u => ({
      ...u,
      funcoes: funcoesByUser[u.id] || [],
      roles_extra: extrasByUser[u.id] || [],
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 3: Atualizar `POST /api/admin/users` para aceitar funcoes + roles_extra**

Substituir o handler existente (linhas 399–418):

```js
// ANTES (remover):
app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nome, email, senha, roles } = req.body;
    if (!email || !senha) return res.status(400).json({ error: 'email e senha são obrigatórios' });
    const { data, error } = await supabase.rpc('admin_create_user', {
      p_admin_id: req.user.id,
      p_email: email,
      p_password: senha,
      p_nome: nome || email,
      p_roles: Array.isArray(roles) ? roles : ['crc_leads'],
    });
    if (error) throw error;
    if (data?.error) return res.status(400).json({ error: data.error });
    await supabase.rpc('admin_confirm_user', { p_admin_id: req.user.id, p_email: email });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DEPOIS (inserir):
app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nome, email, senha, funcoes = [], roles_extra = [] } = req.body;
    if (!email || !senha) return res.status(400).json({ error: 'email e senha são obrigatórios' });

    // Cria usuário com roles vazias — trigger preencherá ao atribuir funcoes
    const { data, error } = await supabase.rpc('admin_create_user', {
      p_admin_id: req.user.id,
      p_email:    email,
      p_password: senha,
      p_nome:     nome || email,
      p_roles:    [],
    });
    if (error) throw error;
    if (data?.error) return res.status(400).json({ error: data.error });

    await supabase.rpc('admin_confirm_user', { p_admin_id: req.user.id, p_email: email });

    // Atribui funcoes + roles_extra (se fornecidos)
    const userId = data?.id;
    if (userId && (funcoes.length || roles_extra.length)) {
      await supabase.rpc('admin_update_user_funcoes', {
        p_admin_id:    req.user.id,
        p_user_id:     userId,
        p_funcao_ids:  funcoes,
        p_roles_extra: roles_extra,
        p_nome:        null,
      });
    }

    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 4: Atualizar `PATCH /api/admin/users/:id` para usar nova RPC**

Substituir o handler existente (linhas 420–436):

```js
// ANTES (remover):
app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { roles, nome } = req.body;
    if (!Array.isArray(roles)) return res.status(400).json({ error: 'roles deve ser array' });
    const { data, error } = await supabase.rpc('admin_update_user_roles', {
      p_admin_id: req.user.id,
      p_user_id:  req.params.id,
      p_roles:    roles,
      p_nome:     nome || null,
    });
    if (error) throw error;
    if (data?.error) return res.status(400).json({ error: data.error });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DEPOIS (inserir):
app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nome, funcoes, roles_extra } = req.body;
    const { data, error } = await supabase.rpc('admin_update_user_funcoes', {
      p_admin_id:    req.user.id,
      p_user_id:     req.params.id,
      p_funcao_ids:  Array.isArray(funcoes)     ? funcoes     : [],
      p_roles_extra: Array.isArray(roles_extra) ? roles_extra : [],
      p_nome:        nome || null,
    });
    if (error) throw error;
    if (data?.error) return res.status(400).json({ error: data.error });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 5: Verificar rotas no servidor**

```bash
cd clinica-crm
node -e "require('./server.js')" 2>&1 | head -5
```
Esperado: sem erros de sintaxe (servidor inicia ou falha apenas por falta de env vars, o que é normal em dev).

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: API funcoes CRUD + users route aceita funcoes/roles_extra"
```

---

## Task 3: Página Admin de Funções + Shared Nav

**Files:**
- Create: `public/admin/funcoes/index.html`
- Modify: `public/js/shared-nav.js`

**Interfaces:**
- Consumes: `GET/POST/PATCH/DELETE /api/admin/funcoes` da Task 2
- Consumes: `GET /api/me` para verificar role admin
- Produces: página `/admin/funcoes/` acessível apenas para admin

---

- [ ] **Step 1: Criar diretório e página**

```bash
mkdir -p "public/admin/funcoes"
```

Criar `public/admin/funcoes/index.html`:

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Funções — CRM AMA</title>
  <link rel="stylesheet" href="/css/main.css">
</head>
<body>
<script src="/js/shared-nav.js" data-active="funcoes"></script>

<div style="padding:32px;max-width:860px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;flex-wrap:wrap;gap:12px">
    <h1 style="margin:0">Funções</h1>
    <button class="btn btn-primary" onclick="abrirModalNova()">+ Nova Função</button>
  </div>
  <p style="color:var(--muted);font-size:13px;margin-top:-12px;margin-bottom:20px">
    Funções agrupam permissões. Atribuir uma função ao usuário concede todas as suas permissões automaticamente.
  </p>
  <div id="funcoes-lista"><p style="color:var(--muted)">Carregando...</p></div>
</div>

<!-- Modal criar/editar função -->
<div class="modal-bg" id="funcao-modal-bg" onclick="if(event.target===this)fecharModal()">
  <div class="modal" style="width:480px;max-height:80vh;overflow-y:auto">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
      <h2 id="fm-titulo" style="margin:0">Nova Função</h2>
      <button class="btn btn-ghost" style="font-size:18px;padding:2px 8px" onclick="fecharModal()">×</button>
    </div>
    <input type="hidden" id="fm-id">
    <div class="form-group">
      <label>Nome da Função</label>
      <input id="fm-nome" placeholder="Ex: Recepção, Gestor, Dentista">
    </div>
    <div class="form-group">
      <label>Permissões desta função</label>
      <p style="color:var(--muted);font-size:12px;margin:4px 0 8px">Todos os usuários com esta função receberão estas permissões automaticamente.</p>
      <div id="fm-roles-list" style="display:flex;flex-direction:column;gap:6px;margin-top:4px"></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-primary" id="fm-btn" onclick="salvarFuncao()" style="flex:1">Salvar</button>
      <button class="btn btn-ghost" onclick="fecharModal()">Cancelar</button>
    </div>
    <div id="fm-msg" style="font-size:12px;margin-top:8px;text-align:center"></div>
  </div>
</div>

<script src="/js/tarefas/api.js"></script>
<script>
const _esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

const _ALL_ROLES = [
  {role:'admin',              label:'Admin'},
  {role:'gestor',             label:'Gestor'},
  {role:'auxiliar_adm',       label:'Auxiliar Adm'},
  {role:'crc_leads',          label:'CRC Leads'},
  {role:'crc_comercial',      label:'CRC Comercial'},
  {role:'crc_sucesso',        label:'CRC Sucesso'},
  {role:'crc_pos_tratamento', label:'CRC Pós Tratamento'},
  {role:'dentista',           label:'Dentista'},
  {role:'mod_notas_fiscais',      label:'Notas Fiscais'},
  {role:'mod_inadimplentes',      label:'Inadimplentes'},
  {role:'mod_avaliacao_dentista', label:'Avaliação Dentista'},
  {role:'mod_kanban_leads',       label:'Kanban Leads'},
  {role:'mod_kanban_comercial',   label:'Kanban Comercial'},
  {role:'mod_financeiro',         label:'Financeiro'},
];

const _ROLE_LABELS = Object.fromEntries(_ALL_ROLES.map(({role,label}) => [role, label]));

function _roleBadge(r) {
  const color = r==='admin'?'#6366f1':r==='gestor'?'#0ea5e9':r.startsWith('mod_')?'#059669':'#64748b';
  return `<span style="background:${color};color:#fff;border-radius:4px;padding:1px 7px;font-size:11px;font-weight:600;margin:1px 2px 1px 0;display:inline-block">${_ROLE_LABELS[r]||r}</span>`;
}

// Auth check — redireciona para / se não for admin
(async () => {
  try {
    const me = await api('/api/me');
    if (!Array.isArray(me.roles) || !me.roles.includes('admin')) {
      window.location.href = '/'; return;
    }
    loadFuncoes();
  } catch { window.location.href = '/'; }
})();

async function loadFuncoes() {
  const el = document.getElementById('funcoes-lista');
  el.innerHTML = '<p style="color:var(--muted)">Carregando...</p>';
  try {
    const funcoes = await api('/api/admin/funcoes');
    if (!funcoes.length) {
      el.innerHTML = '<p style="color:var(--muted)">Nenhuma função cadastrada. Crie a primeira clicando em "+ Nova Função".</p>';
      return;
    }
    el.innerHTML = funcoes.map(f => `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px 18px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div style="min-width:0">
          <div style="font-weight:700;font-size:15px;margin-bottom:8px">${_esc(f.nome)}</div>
          <div style="display:flex;flex-wrap:wrap;align-items:center">
            ${f.roles.length ? f.roles.map(_roleBadge).join('') : '<span style="color:var(--muted);font-size:12px">Sem permissões atribuídas</span>'}
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;margin-top:2px">
          <button class="btn btn-ghost" style="font-size:11px" onclick='abrirModalEditar(${JSON.stringify(f)})'>Editar</button>
          <button class="btn btn-ghost" style="font-size:11px;color:var(--red)" onclick="excluirFuncao('${f.id}','${_esc(f.nome)}')">Excluir</button>
        </div>
      </div>
    `).join('');
  } catch(e) {
    el.innerHTML = `<p style="color:var(--red)">Erro: ${_esc(e.message)}</p>`;
  }
}

function _renderRoleCheckboxes(checkedRoles = []) {
  document.getElementById('fm-roles-list').innerHTML = _ALL_ROLES.map(({role, label}) => `
    <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px;cursor:pointer">
      <input type="checkbox" value="${role}" ${checkedRoles.includes(role) ? 'checked' : ''}>
      ${label}
    </label>
  `).join('');
}

function abrirModalNova() {
  document.getElementById('fm-id').value = '';
  document.getElementById('fm-nome').value = '';
  document.getElementById('fm-titulo').textContent = 'Nova Função';
  document.getElementById('fm-msg').textContent = '';
  _renderRoleCheckboxes([]);
  document.getElementById('funcao-modal-bg').classList.add('open');
  document.getElementById('fm-nome').focus();
}

function abrirModalEditar(f) {
  document.getElementById('fm-id').value = f.id;
  document.getElementById('fm-nome').value = f.nome;
  document.getElementById('fm-titulo').textContent = 'Editar Função';
  document.getElementById('fm-msg').textContent = '';
  _renderRoleCheckboxes(f.roles || []);
  document.getElementById('funcao-modal-bg').classList.add('open');
  document.getElementById('fm-nome').focus();
}

function fecharModal() {
  document.getElementById('funcao-modal-bg').classList.remove('open');
}

async function salvarFuncao() {
  const id   = document.getElementById('fm-id').value;
  const nome = document.getElementById('fm-nome').value.trim();
  const msg  = document.getElementById('fm-msg');
  const btn  = document.getElementById('fm-btn');
  if (!nome) { msg.style.color='var(--red)'; msg.textContent='Nome obrigatório'; return; }
  const roles = [...document.querySelectorAll('#fm-roles-list input:checked')].map(el => el.value);
  btn.disabled = true; btn.textContent = 'Salvando...'; msg.textContent = '';
  try {
    if (id) {
      await api('/api/admin/funcoes/' + id, { method:'PATCH', body: JSON.stringify({nome, roles}) });
    } else {
      await api('/api/admin/funcoes', { method:'POST', body: JSON.stringify({nome, roles}) });
    }
    fecharModal();
    loadFuncoes();
  } catch(e) { msg.style.color='var(--red)'; msg.textContent=e.message; }
  finally { btn.disabled=false; btn.textContent='Salvar'; }
}

async function excluirFuncao(id, nome) {
  if (!confirm(`Excluir a função "${nome}"?\n\nOs usuários mantêm as permissões individuais (roles_extra), mas perdem as permissões que vinham desta função.`)) return;
  try {
    await api('/api/admin/funcoes/' + id, { method:'DELETE' });
    loadFuncoes();
  } catch(e) { alert('Erro: ' + e.message); }
}
</script>
</body>
</html>
```

- [ ] **Step 2: Adicionar link "Funções" na seção config do `shared-nav.js`**

Localizar em `public/js/shared-nav.js` (linhas ~190–193):

```js
// ANTES:
    ${section('config','admin,gestor',IC.config,'Configurações Gerais',
      link('/','admin,gestor','config',IC.config,'Configurações') +
      link('/','admin','usuarios',`<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,'Usuários')
    )}
```

```js
// DEPOIS:
    ${section('config','admin,gestor',IC.config,'Configurações Gerais',
      link('/','admin,gestor','config',IC.config,'Configurações') +
      link('/','admin','usuarios',`<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,'Usuários') +
      link('/admin/funcoes/','admin','funcoes',`<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,'Funções')
    )}
```

- [ ] **Step 3: Commit**

```bash
git add public/admin/funcoes/index.html public/js/shared-nav.js
git commit -m "feat: página /admin/funcoes/ para gerenciar funções + link no shared-nav"
```

---

## Task 4: index.html — Modal Usuários + Nav + Redirect Pós-Login

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `GET /api/admin/funcoes`, `GET/POST/PATCH /api/admin/users` da Task 2
- Produces: modal de novo usuário e edição com bloco "Funções" + "Permissões extras" com gray-out; redirect pós-login para `/tarefas/`; link "Funções" no nav

---

- [ ] **Step 1: Adicionar link "Funções" no nav de `index.html`**

Localizar em `public/index.html` (linhas ~712–715):

```html
<!-- ANTES: -->
    <div class="nav-submenu" id="submenu-config-geral" style="display:none">
      <button class="nav-subitem" data-page="config" data-roles="admin,gestor" onclick="setPage('config',this)">Configurações</button>
      <button class="nav-subitem" data-page="usuarios" data-roles="admin" id="nav-usuarios" onclick="setPage('usuarios',this)">Usuários</button>
    </div>
```

```html
<!-- DEPOIS: -->
    <div class="nav-submenu" id="submenu-config-geral" style="display:none">
      <button class="nav-subitem" data-page="config" data-roles="admin,gestor" onclick="setPage('config',this)">Configurações</button>
      <button class="nav-subitem" data-page="usuarios" data-roles="admin" id="nav-usuarios" onclick="setPage('usuarios',this)">Usuários</button>
      <a href="/admin/funcoes/" class="nav-subitem" data-roles="admin">Funções</a>
    </div>
```

- [ ] **Step 2: Substituir HTML do form "Novo Usuário" por blocos Funções + Permissões extras**

Localizar em `public/index.html` (linhas ~1185–1202, dentro de `#page-usuarios`):

```html
<!-- ANTES (remover este bloco inteiro): -->
      <div class="form-group"><label>Perfil Base</label><div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="nu-role-admin"> Admin</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="nu-role-gestor"> Gestor</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="nu-role-auxiliar_adm"> Auxiliar Adm</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="nu-role-crc_leads"> CRC Leads</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="nu-role-crc_comercial"> CRC Comercial</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="nu-role-crc_sucesso"> CRC Sucesso</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="nu-role-crc_pos_tratamento"> CRC P&#243;s Tratamento</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="nu-role-dentista"> Dentista</label>
      </div></div>
      <div class="form-group"><label>M&#243;dulos Extras</label><div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="nu-mod-notas_fiscais"> Notas Fiscais</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="nu-mod-inadimplentes"> Inadimplentes</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="nu-mod-avaliacao_dentista"> Avalia&#231;&#227;o Dentista</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="nu-mod-kanban_leads"> Kanban Leads</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="nu-mod-kanban_comercial"> Kanban Comercial</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="nu-mod-financeiro"> Financeiro</label>
      </div></div>
```

```html
<!-- DEPOIS (inserir no lugar): -->
      <div class="form-group"><label>Fun&#231;&#245;es</label>
        <p style="color:var(--muted);font-size:11px;margin:2px 0 6px">Selecione uma ou mais fun&#231;&#245;es do cargo.</p>
        <div id="nu-funcoes-list" style="display:flex;flex-direction:column;gap:6px;margin-top:4px">
          <p style="color:var(--muted);font-size:12px">Carregando...</p>
        </div>
      </div>
      <div class="form-group"><label>Permiss&#245;es extras</label>
        <p style="color:var(--muted);font-size:11px;margin:2px 0 6px">Permiss&#245;es em cinza j&#225; est&#227;o cobertas pelas fun&#231;&#245;es selecionadas.</p>
        <div id="nu-extras-list" style="display:flex;flex-direction:column;gap:6px;margin-top:4px"></div>
      </div>
```

- [ ] **Step 3: Substituir HTML do modal "Editar Usuário" pelos novos blocos**

Localizar em `public/index.html` (linhas ~1464–1482):

```html
<!-- ANTES (remover): -->
    <div class="form-group"><label>Perfil Base</label>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="eu-role-admin"> Admin</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="eu-role-gestor"> Gestor</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="eu-role-auxiliar_adm"> Auxiliar Adm</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="eu-role-crc_leads"> CRC Leads</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="eu-role-crc_comercial"> CRC Comercial</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="eu-role-crc_sucesso"> CRC Sucesso</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="eu-role-crc_pos_tratamento"> CRC Pós Tratamento</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="eu-role-dentista"> Dentista</label>
      </div>
    </div>
    <div class="form-group"><label>Módulos Extras</label>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="eu-mod-notas_fiscais"> Notas Fiscais</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="eu-mod-inadimplentes"> Inadimplentes</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="eu-mod-avaliacao_dentista"> Avaliação Dentista</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px"><input type="checkbox" id="eu-mod-financeiro"> Financeiro</label>
      </div>
    </div>
```

```html
<!-- DEPOIS (inserir no lugar): -->
    <div class="form-group"><label>Fun&#231;&#245;es</label>
      <p style="color:var(--muted);font-size:11px;margin:2px 0 6px">Fun&#231;&#245;es atribu&#237;das a este usu&#225;rio.</p>
      <div id="eu-funcoes-list" style="display:flex;flex-direction:column;gap:6px;margin-top:4px"></div>
    </div>
    <div class="form-group"><label>Permiss&#245;es extras</label>
      <p style="color:var(--muted);font-size:11px;margin:2px 0 6px">Permiss&#245;es em cinza j&#225; est&#227;o cobertas pelas fun&#231;&#245;es selecionadas.</p>
      <div id="eu-extras-list" style="display:flex;flex-direction:column;gap:6px;margin-top:4px"></div>
    </div>
```

- [ ] **Step 4: Substituir o bloco de JS de Usuários (linhas 5609–5748)**

Localizar em `public/index.html`:

```js
// ANTES — remover todo o bloco de:
const _ROLE_LABELS = {
  // ...
};
function _renderRoles(roles) { ... }
async function loadUsuarios() { ... }
async function criarUsuario() { ... }
async function excluirUsuario(id) { ... }
const _EU_ROLES = [...];
const _EU_MODS  = [...];
let _usuariosCache = [];
function abrirEdicaoUsuario(id) { ... }
function fecharEdicaoUsuario() { ... }
async function salvarEdicaoUsuario() { ... }
```

```js
// DEPOIS — inserir no lugar:
const _ROLE_LABELS = {
  admin:'Admin', gestor:'Gestor', auxiliar_adm:'Auxiliar Adm',
  crc_leads:'CRC Leads', crc_comercial:'CRC Comercial',
  crc_sucesso:'CRC Sucesso', crc_pos_tratamento:'CRC Pós Tratamento',
  dentista:'Dentista',
  mod_notas_fiscais:'Notas Fiscais', mod_inadimplentes:'Inadimplentes',
  mod_avaliacao_dentista:'Avaliação Dentista',
  mod_kanban_leads:'Kanban Leads', mod_kanban_comercial:'Kanban Comercial',
  mod_financeiro:'Financeiro'
};

const _ALL_ROLES_DEF = [
  {role:'admin',              label:'Admin'},
  {role:'gestor',             label:'Gestor'},
  {role:'auxiliar_adm',       label:'Auxiliar Adm'},
  {role:'crc_leads',          label:'CRC Leads'},
  {role:'crc_comercial',      label:'CRC Comercial'},
  {role:'crc_sucesso',        label:'CRC Sucesso'},
  {role:'crc_pos_tratamento', label:'CRC Pós Tratamento'},
  {role:'dentista',           label:'Dentista'},
  {role:'mod_notas_fiscais',      label:'Notas Fiscais'},
  {role:'mod_inadimplentes',      label:'Inadimplentes'},
  {role:'mod_avaliacao_dentista', label:'Avaliação Dentista'},
  {role:'mod_kanban_leads',       label:'Kanban Leads'},
  {role:'mod_kanban_comercial',   label:'Kanban Comercial'},
  {role:'mod_financeiro',         label:'Financeiro'},
];

function _renderRoles(roles) {
  const base = [], mods = [];
  (roles||[]).forEach(r => r.startsWith('mod_') ? mods.push(r) : base.push(r));
  const fmt = (r, color) => `<span style="background:${color};color:#fff;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:600">${_ROLE_LABELS[r]||r}</span>`;
  return [
    ...base.map(r => fmt(r, r==='admin'?'#6366f1':r==='gestor'?'#0ea5e9':'#64748b')),
    ...mods.map(r => fmt(r, '#059669'))
  ].join(' ');
}

function _renderExtras(prefix, checkedExtras) {
  const container = document.getElementById(prefix + '-extras-list');
  if (!container) return;
  container.innerHTML = _ALL_ROLES_DEF.map(({role, label}) => `
    <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px;cursor:pointer">
      <input type="checkbox" data-role="${role}" ${checkedExtras.includes(role) ? 'checked' : ''}>
      ${label}
    </label>
  `).join('');
}

function _updateExtrasGrayout(prefix) {
  const covered = new Set();
  document.querySelectorAll('#' + prefix + '-funcoes-list input[type="checkbox"]:checked').forEach(cb => {
    const f = _funcoesCache.find(f => f.id === cb.value);
    if (f) f.roles.forEach(r => covered.add(r));
  });
  document.querySelectorAll('#' + prefix + '-extras-list input[type="checkbox"]').forEach(el => {
    const role = el.dataset.role;
    const lbl = el.closest('label');
    if (covered.has(role)) {
      el.disabled = true; el.checked = true;
      if (lbl) lbl.style.opacity = '0.45';
    } else {
      el.disabled = false;
      if (lbl) lbl.style.opacity = '';
    }
  });
}

let _usuariosCache = [];
let _funcoesCache  = [];

function _renderFuncoesCheckboxes(prefix, checkedIds = []) {
  const container = document.getElementById(prefix + '-funcoes-list');
  if (!container) return;
  if (!_funcoesCache.length) {
    container.innerHTML = '<p style="color:var(--muted);font-size:12px">Nenhuma função cadastrada. <a href="/admin/funcoes/" style="color:var(--accent)">Criar funções</a></p>';
    return;
  }
  container.innerHTML = _funcoesCache.map(f => `
    <label style="display:flex;align-items:center;gap:8px;font-weight:normal;font-size:13px;cursor:pointer">
      <input type="checkbox" value="${f.id}" ${checkedIds.includes(f.id) ? 'checked' : ''}
             onchange="_updateExtrasGrayout('${prefix}')">
      ${(f.nome||'').replace(/</g,'&lt;')}
    </label>
  `).join('');
}

async function loadUsuarios() {
  const el = document.getElementById('usuarios-lista');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--muted)">Carregando...</p>';
  try {
    const [users, funcoes] = await Promise.all([
      api('/api/admin/users'),
      api('/api/admin/funcoes'),
    ]);
    _funcoesCache = funcoes || [];
    _usuariosCache = users || [];

    // Inicializa form de novo usuário
    _renderFuncoesCheckboxes('nu', []);
    _renderExtras('nu', []);

    const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    if (!_usuariosCache.length) {
      el.innerHTML = '<p style="color:var(--muted)">Nenhum usuario cadastrado.</p>'; return;
    }
    el.innerHTML = _usuariosCache.map(u => `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:12px">
        <div style="min-width:0">
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(u.nome)||'—'}</div>
          <div style="font-size:12px;color:var(--muted)">${esc(u.email)}</div>
          ${(u.funcoes||[]).length ? `<div style="margin-top:4px">${(u.funcoes).map(f=>`<span style="background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:1px 7px;font-size:11px;margin-right:3px">${esc(f.nome)}</span>`).join('')}</div>` : ''}
          <div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:4px">${_renderRoles(u.roles)}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn btn-ghost" style="font-size:11px;white-space:nowrap" onclick="abrirEdicaoUsuario('${u.id}')">Editar</button>
          <button class="btn btn-ghost" style="font-size:11px;color:var(--red);white-space:nowrap" onclick="excluirUsuario('${u.id}')">Excluir</button>
        </div>
      </div>
    `).join('');
  } catch(e) { el.innerHTML = `<p style="color:var(--red)">${e.message}</p>`; }
}

async function criarUsuario() {
  const nome  = document.getElementById('nu-nome').value.trim();
  const email = document.getElementById('nu-email').value.trim();
  const senha = document.getElementById('nu-senha').value;
  const msg   = document.getElementById('nu-msg');
  const btn   = document.getElementById('nu-btn');
  if (!nome || !email || !senha) { msg.style.color='var(--red)'; msg.textContent='Preencha todos os campos'; return; }
  if (senha.length < 6) { msg.style.color='var(--red)'; msg.textContent='Senha mínima: 6 caracteres'; return; }
  const funcoes = [...document.querySelectorAll('#nu-funcoes-list input[type="checkbox"]:checked')].map(cb => cb.value);
  const roles_extra = [...document.querySelectorAll('#nu-extras-list input[type="checkbox"]:not(:disabled):checked')].map(cb => cb.dataset.role);
  if (!funcoes.length && !roles_extra.length) {
    msg.style.color='var(--red)'; msg.textContent='Selecione ao menos uma função ou permissão'; return;
  }
  btn.disabled = true; btn.textContent = 'Criando...'; msg.textContent = '';
  try {
    await api('/api/admin/users', { method:'POST', body: JSON.stringify({nome, email, senha, funcoes, roles_extra}) });
    msg.style.color='var(--green)'; msg.textContent='Usuário criado!';
    document.getElementById('nu-nome').value  = '';
    document.getElementById('nu-email').value = '';
    document.getElementById('nu-senha').value = '';
    _renderFuncoesCheckboxes('nu', []);
    _renderExtras('nu', []);
    loadUsuarios();
  } catch(e) { msg.style.color='var(--red)'; msg.textContent=e.message; }
  finally { btn.disabled=false; btn.textContent='Criar Usuário'; }
}

async function excluirUsuario(id) {
  const u = _usuariosCache.find(u => u.id === id);
  const label = u ? (u.nome || u.email) : id;
  if (!confirm('Excluir usuário ' + label + '?')) return;
  try {
    await api('/api/admin/users/' + id, {method:'DELETE'});
    toast('Usuário ' + label + ' excluído');
    loadUsuarios();
  } catch(e) { toast('Erro: ' + e.message); }
}

function abrirEdicaoUsuario(id) {
  const u = _usuariosCache.find(u => u.id === id);
  if (!u) return;
  document.getElementById('eu-id').value = id;
  document.getElementById('eu-nome').value = u.nome || '';
  document.getElementById('eu-msg').textContent = '';
  const checkedFuncaoIds = (u.funcoes || []).map(f => f.id);
  _renderFuncoesCheckboxes('eu', checkedFuncaoIds);
  _renderExtras('eu', u.roles_extra || []);
  _updateExtrasGrayout('eu');
  document.getElementById('eu-modal-bg').classList.add('open');
}

function fecharEdicaoUsuario() {
  document.getElementById('eu-modal-bg').classList.remove('open');
}

async function salvarEdicaoUsuario() {
  const id   = document.getElementById('eu-id').value;
  const nome = document.getElementById('eu-nome').value.trim();
  const msg  = document.getElementById('eu-msg');
  const btn  = document.getElementById('eu-btn');
  const funcoes = [...document.querySelectorAll('#eu-funcoes-list input[type="checkbox"]:checked')].map(cb => cb.value);
  const roles_extra = [...document.querySelectorAll('#eu-extras-list input[type="checkbox"]:not(:disabled):checked')].map(cb => cb.dataset.role);
  btn.disabled = true; btn.textContent = 'Salvando...'; msg.textContent = '';
  try {
    await api('/api/admin/users/' + id, { method:'PATCH', body: JSON.stringify({nome, funcoes, roles_extra}) });
    msg.style.color='var(--green)'; msg.textContent='Salvo!';
    loadUsuarios();
    setTimeout(fecharEdicaoUsuario, 800);
  } catch(e) { msg.style.color='var(--red)'; msg.textContent=e.message; }
  finally { btn.disabled=false; btn.textContent='Salvar'; }
}
```

- [ ] **Step 5: Alterar redirect pós-login em `iniciarApp()` (linha ~5543)**

Localizar em `public/index.html`:

```js
// ANTES (linhas 5543–5545):
  const btn = document.querySelector('.nav-btn[onclick*="dashboard"]');
  if (btn) setPage('dashboard', btn);
  else loadDash();
}
```

```js
// DEPOIS:
  // Redireciona para tarefas após login
  window.location.href = '/tarefas/';
}
```

**Importante:** esta linha está dentro de `function iniciarApp()`. Após a mudança, o fluxo será: login → `handleLogin()` chama `iniciarApp()` → `iniciarApp()` redireciona para `/tarefas/`. A sessão Supabase já está salva no `localStorage`, então `/tarefas/` abrirá autenticado normalmente.

- [ ] **Step 6: Verificar que `handleLogin()` ainda chama `iniciarApp()`**

Confirmar que as linhas ~5495–5496 ainda contêm:
```js
  _showApp();
  iniciarApp();
```
Não alterar essas linhas — o `_showApp()` antes do redirect é desnecessário mas inofensivo.

- [ ] **Step 7: Commit e deploy**

```bash
git add public/index.html
git commit -m "feat: modais usuário com Funções+Extras, link nav Funções, redirect pós-login para tarefas"
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

---

## Self-Review — Spec Coverage

| Requisito da Spec | Task |
|---|---|
| Tabela `funcoes` + `user_funcoes` | Task 1 |
| `profiles.roles_extra` | Task 1 |
| Trigger recalcula `roles` ao mudar função | Task 1 |
| Trigger atualiza TODOS usuários ao editar função | Task 1 |
| Migração de dados existentes (roles → roles_extra) | Task 1 |
| RLS para novas tabelas | Task 1 |
| RPC `admin_update_user_funcoes` | Task 1 |
| GET/POST/PATCH/DELETE /api/admin/funcoes | Task 2 |
| GET /api/admin/users retorna funcoes + roles_extra | Task 2 |
| POST /api/admin/users aceita funcoes + roles_extra | Task 2 |
| PATCH /api/admin/users/:id usa nova RPC | Task 2 |
| Página /admin/funcoes/ com CRUD | Task 3 |
| Link "Funções" no shared-nav | Task 3 |
| Link "Funções" no nav do index.html | Task 4 |
| Modal novo usuário com bloco Funções + Extras | Task 4 |
| Modal editar usuário com bloco Funções + Extras | Task 4 |
| Bug fix: kanban_leads + kanban_comercial no editar | Task 4 ✓ (extras agora são dinâmicos, inclui todos os 14) |
| Gray-out de permissões cobertas pelas funções | Task 4 |
| Redirect pós-login para /tarefas/ | Task 4 |
