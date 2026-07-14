# Exportar Leads para Discador (CSV) — Design

**Data:** 2026-07-14
**Autor:** Luiz + Claude
**Status:** aprovado (aguardando revisão final do spec)

## Problema

A CRC precisa baixar os leads do board para carregar em um discador. Hoje o CRM
**dispara campanha 3cplus direto pela API** (`/api/campanhas/lancar`), mas com 3
limitações que motivaram o pedido:

1. Só **1 campanha ativa por vez** (`campanhas_discagem`).
2. Tipos de mailing **fixos** (ABC / preventivo / etc.).
3. Sobe só **nome + telefone** — sem status/origem/anúncio para a CRC segmentar.

Um **download de CSV** livre resolve os três: a CRC filtra/marca os leads que quer
e baixa a lista com as colunas de contexto, para importar em qualquer discador.

## Decisões (do brainstorm)

| Tema | Decisão |
|---|---|
| Seleção | **Duas vias claras**: marcou cards → exporta os marcados; não marcou nada → escolhe a coluna no modal e exporta a **coluna inteira do banco**. Sem "selecionar todos" no header (revisão 14/07: colunas são paginadas — select-all marcaria só os carregados e enganaria a CRC). |
| Permissão | **Mesmas roles do board de Leads** (`requireKanbanLeads`: `crc_leads`, `crc_comercial`, `crc` legado, `mod_kanban_leads`, gestor, admin). Revisão 14/07: `crc_sucesso` não acessa o board onde o botão mora — permissão de API sem porta de entrada seria fantasma. |
| Coluna "anúncio" | **Nome legível** resolvido pela tabela `anuncios` (sem chamar a Meta) |
| Auditoria | **Sim** — registrar quem exportou, quantos leads, quando |
| Cabeçalho CSV | Padrão `nome,telefone,telefone_wa,status,origem,anuncio` (com **BOM** `﻿` — a CRC abre no Excel; sem BOM os acentos quebram) |
| Sem telefone | Leads sem telefone **ficam fora do CSV** (linha inútil pro discador); o modal avisa quantos ficaram de fora |

## Reuso (nada greenfield)

| Peça | Onde já existe |
|---|---|
| Consulta filtrada por coluna (status/origem/CRC/busca) | `buildLeadsColFilter()` — `server.js:932` |
| Gerar CSV + `telefone_wa` + escape | `lib/publicos/csv.js` (`montarCsv`) |
| Padrão de rota de export (Content-Disposition, paginação >1000) | `/api/publicos/exportar` — `server.js:1695` |
| ID do anúncio → nome | tabela `anuncios (chave,nome,fonte,ativo)`, usada em `/api/atribuicao` — `server.js:6889` |
| Board onde a CRC filtra | `public/kanban-leads/index.html` (`renderCard` L253, filtros `_searchQ/_crcQ/_origemQ`, header `.kb-header`) |

## Arquitetura

### 1. Novo helper de CSV — `lib/leads/exportCsv.js`

`montarCsvDiscador(rows, anunciosMap)` → `{ csv, descartados }` (string CSV +
nº de linhas descartadas por falta de telefone).

- Cabeçalho: `nome,telefone,telefone_wa,status,origem,anuncio`
- **BOM**: a string começa com `﻿` — a CRC abre no Excel do Windows, que sem
  BOM renderiza UTF-8 como "JoÃ£o". (O CSV de Públicos não tem BOM porque o
  consumidor é a Meta; aqui o consumidor é humano + discador.)
- **Filtra linhas sem telefone**: `rows.filter(r => r.telefone?.trim())` — linha
  sem telefone é inútil no discador e pode quebrar o import. Mesmo critério do
  fluxo 3cplus (`/api/campanhas/lancar`). A função retorna também `descartados`
  (quantos caíram) para o modal avisar.
- Reutiliza os helpers de escape (`_esc`) e de WhatsApp (`_wa`, prefixa `55` só
  quando faltar; respeita telefones de família com 0 à esquerda — ver
  `feedback_telefone_zero_familia`) já provados em `lib/publicos/csv.js`. Extrair
  esses dois helpers para não duplicar (ou importar de um módulo compartilhado
  `lib/csv-helpers.js`; decidir no plano — preferir extração leve).
- `anuncio`: `anunciosMap[String(lead.campanha).toLowerCase()] || ''`
  (vazio quando o lead não tem `campanha` ou não está no catálogo).

### 2. Nova rota — `POST /api/leads/exportar`

```
app.post('/api/leads/exportar', requireAuth, requireExportLeads, rateLimit, handler)
```

- **Middleware:** reusar o **`requireKanbanLeads`** existente (`server.js:443`) —
  mesmas roles do board onde o botão mora. Não criar middleware novo.
- **Body (dois modos, mutuamente exclusivos):**
  - `{ ids: [<leadId>...] }` → exporta exatamente os leads marcados (o que a CRC
    desmarcou não vem). Validar: array de números, limite defensivo de 5000.
    **Buscar em lotes de ~500 ids** (`.in('id', lote)`) — `.in()` vira query
    string no PostgREST; milhares de ids estouram o limite de URL.
  - `{ coluna, filtros: { q, crc, origem } }` → exporta **tudo** que casa o
    filtro daquela coluna, reusando `buildLeadsColFilter` e **paginando** (range
    de 1000) até esvaziar — mesmo padrão de `/api/publicos/exportar` (nunca
    somar/cortar no client — ver `feedback_supabase_1000_limit`).
    ⚠️ Refactor pequeno necessário: `buildLeadsColFilter` hardcoda `CARD_FIELDS`;
    adicionar parâmetro opcional `fields` (default `CARD_FIELDS`) para o export
    pedir `id,nome,telefone,status,origem,campanha` sem duplicar a query.
- **Resolução do anúncio:** uma consulta `from('anuncios').select('chave,nome').eq('ativo',true)`
  → monta `anunciosMap` em memória (catálogo é pequeno). Sem chamada à Meta.
- **Resposta:**
  - `Content-Type: text/csv; charset=utf-8`
  - `Content-Disposition: attachment; filename="leads-discador-YYYY-MM-DD.csv"`
  - corpo = `montarCsvDiscador(rows, anunciosMap)`
- **Erros:** try/catch no await (nunca `.catch()` no builder — ver
  `reference_supabase_catch_builder`); 400 se body inválido; 500 com `e.message`.

### 3. Auditoria (LGPD)

Nova tabela `leads_export_log`:

```sql
create table public.leads_export_log (
  id bigint generated always as identity primary key,
  usuario_id uuid,
  usuario_nome text,
  modo text,              -- 'ids' | 'filtro'
  qtd int not null,
  filtros jsonb,          -- {coluna,q,crc,origem} quando modo='filtro'
  criado_em timestamptz not null default now()
);
alter table public.leads_export_log enable row level security;
-- sem policy: só o servidor (service_role) grava/le. Front não toca direto.
```

- O handler insere **1 linha por exportação** (usuario_id/nome de `req.user`,
  `qtd` = nº de linhas, `modo`, `filtros`). Insert best-effort: não derruba o
  download se o log falhar (loga warn).
- Segue a regra de segurança do `CLAUDE.md`: tabela nova nasce com RLS ligado e
  **sem** policy (só service_role acessa).

### 4. Frontend — `public/kanban-leads/index.html`

**Regra de ouro de UX: duas vias, impossível de errar.** A CRC nunca precisa
entender paginação. Ou ela marcou cards (leva exatamente os marcados), ou não
marcou nada (escolhe uma coluna e leva a coluna **inteira**, direto do banco).
**Não existe "selecionar todos" no header de coluna** — as colunas são paginadas
(`loadColCards`/`loadMore`) e um select-all marcaria só os ~30 carregados,
enganando a CRC silenciosamente.

- **Checkbox por card:** em `renderCard()` (L253), um `<input type=checkbox>` no
  canto do card, guardando o `lead.id`. Estado em memória: `Set` de ids marcados.
  Clicar no checkbox **não** abre a ficha nem inicia drag (stopPropagation no
  clique e `draggable=false`/guard no dragstart do input).
- **Contador visível:** chip no `.kb-header` — "🗹 12 selecionados · limpar" —
  aparece só quando há seleção. "Limpar" zera o `Set` e re-renderiza.
- **Botão "Exportar CSV"** no `.kb-header` (ao lado dos filtros):
  - **Com cards marcados** → modal: "Exportar **12 leads marcados**" (contagem =
    tamanho do `Set`, local, sem chamada extra) → `POST {ids}`.
  - **Sem nada marcado** → modal: "Exportar uma coluna inteira" com **dropdown de
    coluna** (Novo / Em qualificação / Agendado / Faltou / Nutrir 30-180-365… —
    as `LEADS_COLUNAS`, com os mesmos rótulos do board) → contagem exibida vem do
    **`/api/kanban/leads/counts`** (endpoint que já existe e respeita os mesmos
    filtros `q/crc/origem` — sem endpoint novo de contagem) → texto explícito:
    "Vai baixar os **512** leads de *Nutrir 30-180* (filtros atuais aplicados)"
    → `POST {coluna, filtros:{_searchQ,_crcQ,_origemQ}}`.
    (MVP: **uma coluna por exportação**; multi-coluna é evolução futura.)
  - Após o download, o modal informa quantos leads **ficaram de fora por não ter
    telefone** (header `X-Descartados-Sem-Telefone` na resposta, lido pelo front).
  - Download via `fetch` autenticado + `Blob` + `<a download>` (a página usa
    Bearer token — link direto não autentica).
- Retry 5xx padrão das páginas do CRM (1.5s/3s, 2x — ver `feedback_502_retry_pattern`).

## Fluxo de dados

```
CRC no board de Leads
   ├── filtra (busca/CRC/origem)  ── e/ou ──  marca cards (checkbox)
   └── clica "Exportar CSV"
        → modal mostra contagem (Set local | /api/kanban/leads/counts)
        → POST /api/leads/exportar  {ids}  ou  {coluna, filtros}
             → requireKanbanLeads (mesmas roles do board)
             → busca leads (ids em lotes de 500 | buildLeadsColFilter paginado)
             → carrega anunciosMap (tabela anuncios)
             → monta CSV com BOM, descartando linhas sem telefone
             → grava leads_export_log (best-effort)
             → responde text/csv attachment + X-Descartados-Sem-Telefone
        → browser baixa leads-discador-AAAA-MM-DD.csv
        → modal confirma: "512 baixados, 3 sem telefone ficaram de fora"
```

## Não-objetivos (YAGNI)

- Não integrar o download com a API do 3cplus (isso já existe em `/api/campanhas/*`).
- Não exportar campos clínicos/financeiros — só os 6 combinados.
- Não fazer multi-coluna no MVP (uma coluna por vez; evolução futura).
- Não chamar a Meta em tempo real (anúncio vem do catálogo `anuncios`).

## Riscos / bordas

- **Anúncio vazio:** lead sem `campanha` ou fora do catálogo → coluna vazia (ok).
- **Telefone de família (0 à esquerda):** preservar intacto — reusar `_wa` de Públicos.
- **Volume:** paginação obrigatória no modo filtro (limite 1000 do client
  Supabase); modo ids busca em lotes de 500 (limite de URL do PostgREST).
- **Seleção × recarregar página:** o `Set` de marcados vive em memória — F5 perde
  a seleção. Aceitável no MVP (comportamento padrão de checkbox em lista).
- **PII saindo do sistema:** mitigado pela `leads_export_log`; roles = as mesmas
  do board (`crc_sucesso` fora — não acessa o board).

## Teste

- Unit: `montarCsvDiscador` — cabeçalho, **BOM presente**, escape de
  vírgula/aspas, `telefone_wa` com/sem 55, telefone de família intacto,
  **linha sem telefone descartada + contagem de descartados**, anúncio
  resolvido e vazio.
- Integração (manual, logado): exportar por ids (marcando/desmarcando); exportar
  coluna inteira com filtros ativos e conferir que a contagem do modal bate com o
  nº de linhas do arquivo; conferir a linha em `leads_export_log`; abrir o CSV no
  **Excel** (acentos ok) e importar no discador.
