# Sistema de Funções (RBAC) — Design

**Data:** 2026-06-17
**Status:** Aprovado

---

## Objetivo

Substituir o gerenciamento manual de checkboxes por usuário por um sistema de **Funções** (cargos): o admin define uma vez quais módulos cada cargo acessa, e ao cadastrar um usuário só escolhe a(s) função(ões). Trocar o acesso de um cargo inteiro = editar a função uma vez, vale para todos os usuários com aquela função.

---

## Regras de negócio

1. Um usuário pode ter **uma ou mais funções** simultaneamente.
2. Além das funções, é possível adicionar **permissões extras individuais** por usuário.
3. As permissões efetivas do usuário = union de todas as roles das funções atribuídas + roles_extra individuais.
4. Quando uma função é editada, **todos os usuários com aquela função** têm suas permissões atualizadas automaticamente.
5. Após o login, **todos os usuários são redirecionados para `/tarefas/`** como página inicial.

---

## Banco de dados

### Novas tabelas

```sql
CREATE TABLE funcoes (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome    text NOT NULL,
  roles   text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE user_funcoes (
  user_id   uuid REFERENCES profiles(id) ON DELETE CASCADE,
  funcao_id uuid REFERENCES funcoes(id)  ON DELETE CASCADE,
  PRIMARY KEY (user_id, funcao_id)
);
```

### Alteração em `profiles`

```sql
ALTER TABLE profiles ADD COLUMN roles_extra text[] NOT NULL DEFAULT '{}';
```

`roles_extra` armazena apenas as permissões individuais além das funções.
`profiles.roles` permanece como a coluna efetiva, mantida automaticamente pelo trigger.

### Função de recálculo

```sql
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
```

### Triggers

**Trigger 1 — mudança na atribuição de funções:**
Dispara em INSERT/UPDATE/DELETE em `user_funcoes` → chama `recalculate_user_roles(user_id)`.

**Trigger 2 — edição de uma função:**
Dispara em UPDATE de `roles` em `funcoes` → chama `recalculate_user_roles` para **todos** os usuários que têm aquela função (loop em `user_funcoes WHERE funcao_id = NEW.id`).

**Trigger 3 — edição de extras individuais:**
Dispara em UPDATE de `roles_extra` em `profiles` → chama `recalculate_user_roles(NEW.id)`.

### Migração de dados existentes

Ao aplicar a migration:
```sql
UPDATE profiles SET roles_extra = roles WHERE roles IS NOT NULL;
```
Preserva as permissões de todos os usuários existentes em `roles_extra` até que funções sejam atribuídas a eles.

### RLS

- `funcoes`: SELECT para todos autenticados; INSERT/UPDATE/DELETE apenas para `admin`.
- `user_funcoes`: SELECT para todos autenticados; INSERT/UPDATE/DELETE apenas para `admin`.

---

## API

### Novas rotas — Funções

| Método | Rota                      | Acesso | Descrição                        |
|--------|---------------------------|--------|----------------------------------|
| GET    | /api/admin/funcoes        | admin  | Lista todas as funções           |
| POST   | /api/admin/funcoes        | admin  | Cria nova função                 |
| PATCH  | /api/admin/funcoes/:id    | admin  | Edita nome/roles de uma função   |
| DELETE | /api/admin/funcoes/:id    | admin  | Remove função (não afeta usuários — roles_extra preserva) |

### Alterações em rotas existentes de usuários

**GET /api/admin/users** — passa a retornar também `funcoes` (array de `{id, nome}`) e `roles_extra` por usuário.

**POST /api/admin/users** — passa a aceitar `funcoes` (array de UUIDs) e `roles_extra` (array de strings) em vez de `roles`.

**PATCH /api/admin/users/:id** — passa a aceitar `funcoes` (array de UUIDs) e `roles_extra` (array de strings). A RPC `admin_update_user_roles` atual (que grava `roles` diretamente) deve ser substituída por uma nova RPC `admin_update_user_funcoes` que: (1) remove todas as `user_funcoes` do usuário, (2) insere as novas, (3) atualiza `roles_extra` em `profiles`. O trigger recalcula `roles` automaticamente em seguida.

---

## Permissões disponíveis (checkboxes)

As 14 permissões existentes aparecem tanto na tela de Funções quanto nas "permissões extras" do modal de usuário:

**Funções base (8):**
- `admin` — Admin
- `gestor` — Gestor
- `auxiliar_adm` — Auxiliar Adm
- `crc_leads` — CRC Leads
- `crc_comercial` — CRC Comercial
- `crc_sucesso` — CRC Sucesso
- `crc_pos_tratamento` — CRC Pós Tratamento
- `dentista` — Dentista

**Módulos extras (6):**
- `mod_notas_fiscais` — Notas Fiscais
- `mod_inadimplentes` — Inadimplentes
- `mod_avaliacao_dentista` — Avaliação Dentista
- `mod_kanban_leads` — Kanban Leads
- `mod_kanban_comercial` — Kanban Comercial
- `mod_financeiro` — Financeiro

> Tarefas não aparece como permissão separada — acesso já está embutido em todas as roles operacionais.

---

## Interface

### Nova tela `/admin/funcoes/`

- Link próprio no menu admin: **"Funções"** (ao lado de "Usuários")
- Lista todas as funções com nome e badges das roles que cada uma inclui
- Botão **"Nova Função"** → modal com:
  - Campo nome
  - Checkboxes de todas as 14 permissões
- Botão editar por função → mesmo modal preenchido
- Botão excluir → confirmação

### Modal de usuário — o que muda

**Bloco 1 — Funções:**
- Checkboxes com todas as funções cadastradas (múltipla seleção)

**Bloco 2 — Permissões extras:**
- Checkboxes das 14 permissões
- As que já estão cobertas pelas funções selecionadas aparecem **desabilitadas e marcadas em cinza** (informativo — não editável)
- As não cobertas ficam disponíveis para marcar individualmente

**Correção incluída:** modal de editar usuário ganha `mod_kanban_leads` e `mod_kanban_comercial`, que estavam faltando (presentes só no modal de criar).

---

## Página inicial pós-login

Após autenticação bem-sucedida, todos os usuários são redirecionados para `/tarefas/` como primeira tela, independente da função.

Implementação: em `public/index.html`, no handler `_sb.auth.onAuthStateChange`, quando `event === 'SIGNED_IN'`, substituir a chamada `setPage('dashboard', btn)` por `window.location.href = '/tarefas/'`. O redirect ocorre apenas no evento de login, não em toda visita à página.

---

## Fora de escopo

- Hierarquia entre funções (uma função herdar de outra)
- Permissões negativas (bloquear algo que a função dá)
- Auditoria de quem mudou qual função
