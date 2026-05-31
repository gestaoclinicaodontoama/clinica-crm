# CRM Responsivo no Celular + Barra Inferior Personalizável

**Data:** 2026-05-31
**Status:** Design aprovado (aguardando revisão da spec)

## Objetivo

Tornar o CRM (`clinica-crm`) usável no celular. Foco principal: o **gestor** consultando o **Dashboard** e telas leves de qualquer lugar. Hoje o app tem ~0 responsividade (1 media query), a sidebar fixa de 220px ocupa metade da tela e as tabelas estouram horizontalmente.

## Escopo

### Em escopo
- Modo mobile (`@media max-width: 768px`) no app principal (`public/index.html`) e nas páginas separadas (`/avaliacao-dentista/`, `/atribuicao/`, `/ligacoes`).
- Substituir a sidebar por: **topo fino** (logo + título da tela) + **barra inferior fixa** (tab bar) de 4 itens + "Mais".
- Barra inferior **personalizável por usuário** (quais itens e ordem), salva na conta (Supabase).
- Telas mobile-friendly renderizando bem empilhadas: Dashboard, Funil, Conversas, Tarefas, Atribuição, Avaliação Dentista.
- Telas "descritivas" mostram **aviso de desktop-only** no celular em vez de tabela quebrada.

### Fora de escopo (YAGNI)
- Converter tabelas grandes em cartões empilhados.
- Redesenhar métricas/conteúdo do Dashboard (só fazer o conteúdo atual renderizar bem).
- Reordenação por arrastar-e-soltar (decidido: setas ↑↓ + liga/desliga).
- Mudanças no layout desktop (acima de 768px fica intocado).

## Decisões tomadas

| Tema | Decisão |
|---|---|
| Menu mobile | Barra inferior fixa (tab bar), não hambúrguer |
| Itens da barra | 4 itens + "Mais" fixo no 5º slot |
| Default da barra | 4 primeiros itens visíveis do perfil (ordem atual do menu) |
| Personalização | Liga/desliga + setas ↑↓ (sem arrastar) |
| Persistência | Conta do usuário — `profiles.nav_prefs` (Supabase) |
| Tabelas grandes | Não responsivizar; telas viram "desktop-only" no mobile |
| Breakpoint | `max-width: 768px` = mobile |

## Arquitetura

### Componentes novos

1. **Topo fino mobile** (`.mobile-topbar`) — barra fixa no topo, só visível < 768px. Mostra logo "CRM AMA" e o título da tela atual. O título é atualizado pelo `setPage()` (index) e estático nas páginas separadas.

2. **Barra inferior** (`.mobile-tabbar`) — barra fixa no rodapé, só visível < 768px. 5 slots: 4 itens configuráveis + "Mais" (☰) fixo. Cada slot = ícone (SVG reaproveitado do nav) + rótulo curto. Slot ativo destacado com `--accent`.

3. **Bottom sheet "Mais"** (`.mobile-sheet`) — gaveta que sobe de baixo ao tocar "Mais". Lista **todos** os itens visíveis do perfil (incluindo submenus, ex. Pós-Tratamento) + alternar tema + sair + botão "Personalizar barra".

4. **Tela "Personalizar barra"** — dentro do sheet. Lista todos os itens do perfil, cada um com:
   - checkbox/toggle "mostrar na barra" (máx. 4 ligados; ao tentar o 5º, bloqueia com aviso),
   - setas ↑ e ↓ para reordenar (reordena só entre os itens ligados),
   - botão "Salvar" → persiste no servidor.

5. **Guard desktop-only** — função que, em viewport mobile, ao abrir uma tela marcada como desktop-only, esconde o conteúdo da página e mostra um card centralizado: *"📊 Esta tela tem muita informação e fica melhor no computador. Abra no notebook para ver em detalhe."*

### Onde mora a lógica
- A lógica da tab bar (render, default, personalização, sheet) é implementada **uma vez** de forma reutilizável e usada nos dois contextos:
  - `public/index.html` (nav inline, SPA com `setPage`),
  - `public/js/shared-nav.js` (páginas separadas).
- Para evitar duplicação, extrair a lógica comum para um módulo `public/js/mobile-nav.js` carregado por ambos. O `index.html` e o `shared-nav.js` fornecem a lista de itens (slug, label, ícone, href/handler, roles) e o módulo monta a UI.

## Modelo de dados

### Migração Supabase (projeto `mtqdpjhhqzvuklnlfpvi`)
```sql
alter table profiles add column if not exists nav_prefs jsonb default null;
```
- `nav_prefs` = `{ "tabbar": ["dashboard","funil","conversas","tarefas-gestor"] }` (array ordenado de slugs; máx. 4).
- `null` = usar o default automático.

### Slugs canônicos dos itens de nav
Cada item de menu ganha um slug estável usado em `nav_prefs` e no guard:
- SPA (`data-page`): `dashboard`, `leads`, `funil`, `conv-agendamentos`, `conv-avaliacao`, `disparos`, `notas-fiscais`, `inadimplentes`, `usuarios`, `tarefas-gestor`, `config`, submenus de Pós-Tratamento.
- Links externos (`href`): `avaliacao-dentista`, `atribuicao`, `ligacoes`.

### Lista desktop-only (default, ajustável)
`leads`, `inadimplentes`, `notas-fiscais`, `disparos`, `usuarios`, `config`, `ligacoes`.

Mobile-friendly: `dashboard`, `funil`, `conv-agendamentos`, `conv-avaliacao`, `tarefas-gestor`, `atribuicao`, `avaliacao-dentista`.

**Regra:** só os slugs da lista desktop-only acionam o guard. Qualquer tela não listada (incl. submenus de Pós-Tratamento) é tratada como mobile-friendly por padrão.

## API

### `GET /api/me` (existente — alteração)
Adicionar `nav_prefs: profile?.nav_prefs || null` à resposta. (O `select('*')` já traz a coluna.)

### `PATCH /api/me/nav-prefs` (novo)
- Auth: `requireAuth`.
- Body: `{ tabbar: string[] }`.
- Validação: array de 1–4 strings; cada uma ∈ conjunto de slugs conhecidos (lista no servidor). Rejeita desconhecidos/duplicados.
- Ação: `supabase.from('profiles').update({ nav_prefs: { tabbar } }).eq('id', req.user.id)`.
- Resposta: `{ ok: true }`.
- Segue o padrão dos endpoints `/api/me/*` já existentes (linhas ~157–197 do `server.js`).

## Fluxo de dados (carregamento da barra)

1. Front chama `GET /api/me` → recebe `roles` e `nav_prefs`.
2. Calcula a lista de itens **visíveis** (filtra `data-roles` pelos roles do usuário) — lógica que já existe em `applyRoles()`.
3. Resolve a barra:
   - Se `nav_prefs.tabbar` existe: filtra pelos itens ainda visíveis (defensivo contra mudança de role), mantém a ordem; se sobrarem < 4, completa com os próximos itens visíveis do default.
   - Senão: pega os 4 primeiros itens visíveis na ordem do menu.
4. Renderiza os 4 + "Mais".
5. Ao salvar personalização: `PATCH /api/me/nav-prefs`, atualiza estado local e re-renderiza sem reload.

## Comportamento responsivo por área

- **Shell:** `<nav>` sidebar → `display:none` < 768px; `.mobile-topbar` e `.mobile-tabbar` → `display:flex`. `<main>` recebe `padding: 16px` + `padding-bottom` = altura da tab bar + safe-area (`env(safe-area-inset-bottom)`), e `padding-top` = altura do topo.
- **Grids de cards** (`.cards`, grids `auto-fit/minmax`): conferir/ajustar `minmax` para empilhar em 1–2 colunas no celular.
- **Dashboard:** cards empilham; `funil-row` rola horizontalmente se não couber; gráfico de origem ocupa largura total; tabela "Últimos Leads" em container com scroll horizontal (é pequena/chave, fica).
- **Tabelas grandes:** não recebem tratamento — as telas correspondentes caem no guard desktop-only.
- **Modais:** < 768px viram quase tela cheia / bottom-sheet com `overflow-y:auto` e largura 100%.
- **Filtros/toolbars:** garantir `flex-wrap`.
- **Conversas/Chat (kanban):** colunas com scroll horizontal; vista de chat em altura cheia (descontando topo + tab bar). Objetivo: funcional, não redesenho.

## Tratamento de erros / edge cases

- `PATCH /api/me/nav-prefs` com slug inválido → 400, front mantém estado anterior e mostra aviso.
- `nav_prefs` apontando para item que o role perdeu → filtrado no carregamento, completado pelo default.
- Usuário com < 4 itens visíveis → barra mostra os que existem + "Mais" (sem slots vazios).
- Falha ao salvar (rede) → mantém UI local, mostra "não foi possível salvar".
- Rotação/resize cruzando 768px → CSS resolve via media query; a barra é renderizada uma vez no load (sem necessidade de re-render no resize).

## Testes

- **Playwright (MCP)** em viewport mobile (390×844):
  - Carrega `/` logado como gestor → confirma topo + tab bar com 4 itens + "Mais", sidebar oculta.
  - Verifica ausência de overflow horizontal (`document.body.scrollWidth <= innerWidth`) no Dashboard.
  - Abre "Mais" → sheet lista itens + tema + sair + personalizar.
  - Personaliza: liga/desliga + setas, salva → recarrega e confirma persistência (mock/real do `PATCH`).
  - Abre uma tela desktop-only → confirma o card de aviso (não a tabela).
  - Abre um modal → confirma largura cheia.
- **Validação real** no celular do usuário após deploy.

## Plano de entrega (push único — opção B)

1. Migração Supabase (`nav_prefs`).
2. `server.js`: `GET /api/me` + `PATCH /api/me/nav-prefs` + lista de slugs válidos.
3. `public/js/mobile-nav.js`: módulo da tab bar (render, default, sheet, personalização, guard).
4. CSS responsivo (`@media max-width:768px`) no `index.html` e páginas separadas.
5. Integração no `index.html` (fornecer itens + título no `setPage`).
6. Integração no `shared-nav.js` (páginas separadas).
7. Testes Playwright + ajustes.
8. Commit, push, deploy Easypanel.
