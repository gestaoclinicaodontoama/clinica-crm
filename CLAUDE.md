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
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

## Padrão de novo módulo — sidebar

Todo módulo novo **deve ser adicionado ao nav lateral** de `public/index.html`.

**Antes de adicionar, perguntar:**
> "Este módulo faz parte de um módulo existente (ex.: 'Pós Tratamento') ou é um módulo independente?"

### Módulo independente (link direto)
Adicionar antes do botão "Usuários" em `public/index.html`:
```html
<a class="nav-btn" href="/nome-do-modulo/" data-roles="roles,separados,por,virgula">
  <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><!-- ícone --></svg>
  Nome do Módulo
</a>
```
- `data-roles`: roles que podem ver o link. `admin` sempre tem acesso implícito.
- O link navega para uma página separada (`/nome-do-modulo/index.html`).

**Sidebar obrigatória em páginas separadas:**
Toda página fora do `index.html` deve incluir o shared-nav para manter a sidebar visível:
1. Incluir o script antes do script do módulo: `<script src="/js/shared-nav.js" data-active="slug-da-pagina"></script>`
2. Também adicionar a entrada correspondente em `public/js/shared-nav.js` (lista de links do nav)
3. O `data-active` deve ser o slug que identifica a página no menu (ex: `avaliacao-dentista`)

### Submódulo (dentro de seção existente, ex.: "Pós Tratamento")
Adicionar dentro do `<div class="nav-submenu">` da seção pai:
```html
<a href="/pos-tratamento/nome.html" class="nav-subitem">Nome do Submódulo</a>
```

### Filtragem por roles
O JS em `index.html` filtra automaticamente os itens com `data-roles`:
- `.nav-btn[data-roles]` — botões e links de nível superior
- `.nav-section[data-roles]` — seções com submenu (ex.: Pós Tratamento)

## Auth em páginas separadas

Módulos em páginas separadas (fora de `index.html`) usam `public/js/<modulo>/api.js`.
O token Supabase no localStorage usa o formato: `sb-{project-ref}-auth-token`.
Buscar com: `k.startsWith('sb-') && k.endsWith('-auth-token')`.
**Não usar** `k.includes('supabase')` — não encontra a chave correta.

## Migrações Supabase
Project ID: `mtqdpjhhqzvuklnlfpvi`
Aplicar via MCP Supabase em ordem crescente de timestamp.
Após aplicar, verificar com `list_migrations`.
