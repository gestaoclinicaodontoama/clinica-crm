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
| Seleção | **Filtro atual + marcar/desmarcar** (checkbox por card) |
| Permissão | **Todos os CRC** (`crc_leads`, `crc_comercial`, `crc_sucesso`) + gestor/admin |
| Coluna "anúncio" | **Nome legível** resolvido pela tabela `anuncios` (sem chamar a Meta) |
| Auditoria | **Sim** — registrar quem exportou, quantos leads, quando |
| Cabeçalho CSV | Padrão `nome,telefone,telefone_wa,status,origem,anuncio` |

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

`montarCsvDiscador(rows, anunciosMap)` → string CSV.

- Cabeçalho: `nome,telefone,telefone_wa,status,origem,anuncio`
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

- **Middleware:** `const requireExportLeads = requireRole('crc_leads','crc_comercial','crc_sucesso','gestor','admin');`
- **Body (dois modos, mutuamente exclusivos):**
  - `{ ids: [<leadId>...] }` → exporta exatamente os leads marcados (o que a CRC
    desmarcou não vem). Limite defensivo (ex.: 5000 ids).
  - `{ coluna, filtros: { q, crc, origem } }` → exporta **tudo** que casa o
    filtro daquela coluna, reusando `buildLeadsColFilter(coluna, q, crc, false, origem)`
    e **paginando** (range de 1000) até esvaziar — mesmo padrão de
    `/api/publicos/exportar` (nunca somar/cortar no client — ver
    `feedback_supabase_1000_limit`).
- **Resolução do anúncio:** uma consulta `from('anuncios').select('chave,nome').eq('ativo',true)`
  → monta `anunciosMap` em memória (catálogo é pequeno). Sem chamada à Meta.
- **Seleção de campos do banco:** precisa de `campanha` além dos `CARD_FIELDS`
  atuais — usar select próprio: `id,nome,telefone,status,origem,campanha`.
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

- **Checkbox por card:** em `renderCard()` (L253), um `<input type=checkbox>` no
  canto do card, guardando o `lead.id`. Estado em memória: `Set` de ids marcados.
  Clicar no checkbox **não** abre a ficha nem inicia drag (stopPropagation).
- **"Selecionar todos da coluna":** um checkbox no header de cada coluna que marca
  os cards já carregados daquela coluna.
- **Botão "Exportar CSV"** no `.kb-header` (ao lado dos filtros):
  - Se houver ids marcados → modal "Exportar N leads marcados" → `POST {ids}`.
  - Se nada marcado → modal "Exportar todos os leads do filtro atual" com um
    **dropdown de coluna** (Novo / Em qualificação / Agendado / Nutrir… — as
    `LEADS_COLUNAS`) e manda `POST {coluna, filtros:{_searchQ,_crcQ,_origemQ}}`.
    (MVP: **uma coluna por exportação**; multi-coluna fica como evolução para não
    inflar o escopo.)
  - O modal mostra a **contagem** antes de baixar (chama a rota; o browser recebe
    o CSV como download via `Blob` + `<a download>` — padrão já usado no front).
- Retry 5xx padrão das páginas do CRM (1.5s/3s, 2x — ver `feedback_502_retry_pattern`).

## Fluxo de dados

```
CRC no board de Leads
   ├── filtra (busca/CRC/origem)  ── e/ou ──  marca cards (checkbox)
   └── clica "Exportar CSV"
        → modal mostra contagem
        → POST /api/leads/exportar  {ids}  ou  {coluna, filtros}
             → requireExportLeads (roles)
             → busca leads (por ids | por buildLeadsColFilter paginado)
             → carrega anunciosMap (tabela anuncios)
             → monta CSV (nome,telefone,telefone_wa,status,origem,anuncio)
             → grava leads_export_log (best-effort)
             → responde text/csv como attachment
        → browser baixa leads-discador-AAAA-MM-DD.csv
```

## Não-objetivos (YAGNI)

- Não integrar o download com a API do 3cplus (isso já existe em `/api/campanhas/*`).
- Não exportar campos clínicos/financeiros — só os 6 combinados.
- Não fazer multi-coluna no MVP (uma coluna por vez; evolução futura).
- Não chamar a Meta em tempo real (anúncio vem do catálogo `anuncios`).

## Riscos / bordas

- **Anúncio vazio:** lead sem `campanha` ou fora do catálogo → coluna vazia (ok).
- **Telefone de família (0 à esquerda):** preservar intacto — reusar `_wa` de Públicos.
- **Volume:** paginação obrigatória no modo filtro (limite 1000 do client Supabase).
- **PII saindo do sistema:** mitigado pela `leads_export_log`; roles restritas a CRC+.

## Teste

- Unit: `montarCsvDiscador` — cabeçalho, escape de vírgula/aspas, `telefone_wa`
  com/sem 55, telefone de família, anúncio resolvido e vazio.
- Integração (manual, logado): exportar por ids; exportar por filtro; conferir a
  linha em `leads_export_log`; abrir o CSV no discador/Excel.
