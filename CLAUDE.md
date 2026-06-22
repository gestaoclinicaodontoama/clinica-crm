# CLAUDE.md — Clínica CRM

## Stack
- **Backend:** Node.js + Express (`server.js`)
- **Frontend:** HTML/CSS/JS vanilla (sem framework)
- **Banco:** Supabase (Postgres + Auth + RLS)
- **Deploy:** Easypanel — `http://2.24.94.120:3000`
- **URL pública:** `https://plataformaama-plataforma.uc5as5.easypanel.host`

## Fluxo de deploy
Após `git push`, executar imediatamente (sem perguntar):
```
# CRM (Node.js)
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"

# nf-agente (Python/Docker) — só quando arquivos em nf-automation/ foram alterados
curl -s -X POST "http://2.24.94.120:3000/api/deploy/a03d084c1fe9b98fa7aba9c4bfb76a8aaf5ec1ff980e8ca7"
```

## Padrão de novo módulo — sidebar

⚠️ **FONTE ÚNICA: `public/js/nav-config.js`.** O menu é definido UMA vez no array
`CRM_NAV` desse arquivo. Tanto o `index.html` (SPA, via `setPage`) quanto as
páginas separadas (`shared-nav.js`, via links) renderizam a partir dele. **Não
edite itens de menu direto no `index.html` nem no `shared-nav.js`** — eles só
contêm o "chrome" (logo, sino, tema, versão) e a lógica de cada contexto.

Para adicionar/alterar um item, edite **apenas** `CRM_NAV` em `nav-config.js`.

### Campos de um item (`CRM_NAV`)
```js
{ slug:'meu-modulo', label:'Meu Módulo', icon:'comercial',
  roles:'admin,gestor,mod_meu_modulo',
  mode:'link', href:'/meu-modulo/' }        // link → página separada
// ou
{ slug:'minha-aba', label:'Minha Aba', icon:'funil',
  roles:'admin,gestor', mode:'spa' }         // spa → aba dentro do index (setPage)
```
- `mode:'spa'`  → no index vira `<button data-page>` que chama `setPage(slug)`;
  nas páginas separadas vira link `/?page=slug` (o index lê `?page=` e abre a aba).
- `mode:'link'` → âncora com `href` em todos os contextos.
- `icon`: nome de um ícone definido em `PATHS` no topo do `nav-config.js`
  (use ícones distintos por área). Subitens não têm ícone.
- `roles`: CSV de roles que veem o item. `admin` sempre vê.
- `badge`: opcional `{ id, cls }` cria o `<span>` (atualizado pelo JS do index).

### Submódulo (dentro de uma seção, ex.: "Pós Tratamento")
Adicione um objeto ao array `items:[...]` da seção correspondente em `CRM_NAV`.
Seções colapsáveis têm `{ id, label, icon, roles, items:[...] }`.

### Sidebar em páginas separadas
Toda página fora do `index.html` inclui:
`<script src="/js/shared-nav.js" data-active="slug-da-pagina"></script>`
(o `shared-nav.js` carrega o `nav-config.js` sozinho). O `data-active` deve
bater com o `slug` do item no `CRM_NAV`.

### Filtragem por roles
Itens recebem `data-roles` automaticamente a partir do `CRM_NAV`. O filtro roda
em runtime (loadCurrentUser no index; applyRoles no shared-nav) escondendo o que
o usuário não pode ver. A sidebar só aparece após esse filtro (evita FOUC).

## Auth em páginas separadas

Módulos em páginas separadas (fora de `index.html`) usam `public/js/<modulo>/api.js`.
O token Supabase no localStorage usa o formato: `sb-{project-ref}-auth-token`.
Buscar com: `k.startsWith('sb-') && k.endsWith('-auth-token')`.
**Não usar** `k.includes('supabase')` — não encontra a chave correta.

## Módulo de Usuários — padrão obrigatório ao criar novo módulo

Todo módulo novo deve ser registrado no módulo de Usuários (`public/index.html`) em **3 lugares**:

### 1. Perfil Base (se o módulo cria um novo tipo de usuário)
Adicionar checkbox em `#nu-role-{role}` na seção "Perfil Base":
```html
<label ...><input type="checkbox" id="nu-role-novorole"> Novo Role</label>
```

### 2. Módulos Extras (acesso granular ao módulo sem perfil base)
Adicionar checkbox em `#nu-mod-{modulo}` na seção "Módulos Extras":
```html
<label ...><input type="checkbox" id="nu-mod-novo_modulo"> Nome do Módulo</label>
```

### 3. `_ROLE_LABELS` + `criarUsuario()`
- Adicionar ao `_ROLE_LABELS`: `mod_novo_modulo: 'Nome do Módulo'`
- Adicionar ao `criarUsuario()`: `if (document.getElementById('nu-mod-novo_modulo').checked) roles.push('mod_novo_modulo');`

### 4. Servidor (`server.js`)
Atualizar o middleware de acesso para aceitar o role mod_:
```js
const requireAlgoDoModulo = requireRole('role_base', 'admin', 'mod_novo_modulo');
```

### 5. Nav (`data-roles`)
Incluir o novo role no `roles` do item em `public/js/nav-config.js` (fonte única).

**Resumo por módulo existente:**
- Avaliação Dentista → Perfil Base: `dentista` | Módulos Extras: `mod_avaliacao_dentista`
- Notas Fiscais → Módulos Extras: `mod_notas_fiscais`
- Inadimplentes → Módulos Extras: `mod_inadimplentes`

## Migrações Supabase
Project ID: `mtqdpjhhqzvuklnlfpvi`
Aplicar via MCP Supabase em ordem crescente de timestamp.
Após aplicar, verificar com `list_migrations`.
