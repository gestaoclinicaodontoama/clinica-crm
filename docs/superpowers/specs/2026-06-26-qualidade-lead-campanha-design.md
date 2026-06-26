# Qualidade de Lead por Campanha + Restyle do Agente de Marketing

**Data:** 2026-06-26
**Módulo:** `public/marketing-agente/` + rota `/api/marketing/*` em `server.js`
**Status:** Design aprovado (aguardando revisão do spec)

## Problema

O Luiz quer **visualizar onde aparecem mais os leads "sem interesse"**. Investigação dos
dados reais (Supabase, projeto `mtqdpjhhqzvuklnlfpvi`) revelou dois fatos que moldam o design:

1. **O status literal "Não tem Interesse" é quase inexistente** — só 3 leads no total. Filtrar
   apenas por ele deixaria o painel vazio. O sinal real de lead ruim mora em **"Perdido"**
   (187 total / 164 nos últimos 90d) + "Não tem Interesse".
2. **O campo `leads.campanha` guarda o ID numérico da campanha Meta** (ex.: `120247232763550629`),
   não um nome legível. Cobertura: 113/190 (≈59%) dos leads sem interesse têm campanha
   preenchida; `origem` tem 100%. Há sinal claro — ex.: campanha `...3550629` = 80% de leads
   ruins (8/10); outra = 32%.

Além disso, a página do Agente de Marketing **destoa visualmente do resto do sistema**: usa
cores fixas (`#fff`, `#e2e8f0`) em vez dos tokens de tema (`var(--bg)`, `var(--border)`...).
Todas as outras páginas (ex.: Saúde CAPI) definem um bloco `:root` + `[data-theme="light"]` e o
`shared-nav.js` aplica `data-theme` no `<html>` — a página de Marketing simplesmente não tem
esse bloco, por isso não respeita tema claro/escuro.

## Decisões (acordadas com o Luiz)

| Decisão | Escolha |
|---|---|
| O que conta como "sem interesse" | `status IN ('Perdido','Não tem Interesse')` (etapa **padrão**) |
| Etapa de qualificação | **Selecionável** — o ranking pode ser ordenado por qualquer etapa do funil (Sem interesse, Perdido, Em qualificação, Avaliação agendada, Compareceu, Em negociação, Fechou), não só "sem interesse" |
| Dimensão do "onde" | **Por campanha** (resolvendo ID Meta → nome legível) |
| Onde fica | Dentro do **Agente de Marketing**, em abas |
| Métrica de destaque | **Volume (qtd)** da etapa selecionada como ordenação padrão; **taxa (% da campanha)** visível e reordenável |
| Escopo do restyle | Reskin (tokens de tema) **+ pequenas melhorias de UX** |

### Etapas selecionáveis (status → rótulo do funil)

| Métrica no seletor | `status` contados | 90d | com campanha (90d) |
|---|---|---|---|
| **Sem interesse** *(padrão)* | `Perdido` + `Não tem Interesse` | 168 | 100 |
| Perdido | `Perdido` | 165 | 97 |
| Em qualificação *(lead qualified)* | `Em qualificação` | 78 | 44 |
| Avaliação agendada *(scheduled)* | `Avaliação agendada` | 55 | 28 |
| Compareceu *(contato/compareceu)* | `Compareceu` | 42 | 8 |
| Em negociação | `Em negociação` | 2 | 2 |
| Fechou *(purchase)* | `Fechou` | 39 | 4 |

⚠️ **A cobertura de campanha cai nas etapas avançadas** (ex.: Fechou = 4/39, Compareceu = 8/42),
porque `leads.campanha` só é gravado na criação (lead vindo do Meta) e muitos leads avançados são
antigos/orgânicos. O painel mostra a cobertura por etapa para deixar isso explícito; etapas
avançadas devem ser lidas como sinal direcional, não censo.

## Arquitetura

A página de Marketing passa a ter **duas abas**:

- **Aba "ROAS"** — a funcionalidade atual (gasto Meta × faturamento/caixa por campanha, drill
  até paciente). Comportamento preservado; só reskin + melhorias de UX.
- **Aba "Qualidade de Lead"** — ranking de campanhas pela **etapa de qualificação selecionada**
  (padrão: sem interesse), com drill até os leads reais.

**Princípio:** o backend devolve o **breakdown completo por status** de cada campanha em uma
única chamada; o seletor de etapa reordena/recalcula **no front**, sem novo round-trip. Só o
drill (lista de leads de uma campanha numa etapa) volta ao servidor.

### Componente 1 — Backend: `GET /api/marketing/qualidade-lead`

**Arquivo:** `server.js` (junto das outras rotas `/api/marketing/*`, ~linha 6007).
**Auth:** `requireAuth, requireRole('admin','gestor'), rateLimit` (mesmo padrão das rotas vizinhas).

**Query string:** `periodo=30|90|365` (default 30); aceita `desde`/`ate` explícitos como as
outras rotas de marketing.

**O que faz:**
1. Lógica SQL via RPC nova `marketing_qualidade_lead(p_desde, p_ate)` (Postgres function,
   aplicada por migração). Por que RPC e não query no cliente JS: o cliente Supabase trunca em
   1000 linhas e queremos agregação correta no banco (lição registrada no projeto). A função
   agrupa `leads` (filtradas por `criado_em` no período) por `campanha` e retorna por grupo o
   **breakdown completo por status** (não só sem-interesse), para o front poder ranquear por
   qualquer etapa sem novo round-trip:
   - `campanha_id` (o valor cru de `leads.campanha`, ou `NULL` → balde "(sem campanha)")
   - `total` = `COUNT(*)` da campanha no período
   - `por_status` = objeto `{ "<status>": <count> }` (ex.: `{"Perdido":6,"Não tem Interesse":2,"Fechou":1,...}`),
     via `jsonb_object_agg`. O front deriva cada métrica do funil somando os status que ela
     agrupa (ex.: Sem interesse = `Perdido + Não tem Interesse`).
   - Retorna todos os grupos com `total > 0` (o front filtra por métrica > 0 ao exibir).
2. **Resolve `campanha_id` → nome** chamando `GET act_<AD_ACCOUNT>/campaigns?fields=id,name&limit=500`
   (Graph API, `META_API_VERSION`), usando `META_ADS_TOKEN || META_ACCESS_TOKEN` (mesmo
   fallback da rota de ROAS). Monta um mapa `{id: name}`. IDs não resolvidos (campanha
   arquivada/fora da conta) caem de volta para mostrar o próprio ID. Se não houver token,
   retorna `sem_token: true` e mostra IDs.
3. Retorna:
   ```json
   {
     "desde": "2026-05-27", "ate": "2026-06-26",
     "sem_token": false,
     "metricas": [
       { "key": "sem_interesse", "label": "Sem interesse", "status": ["Perdido","Não tem Interesse"] },
       { "key": "perdido", "label": "Perdido", "status": ["Perdido"] },
       { "key": "qualificacao", "label": "Em qualificação", "status": ["Em qualificação"] },
       { "key": "agendada", "label": "Avaliação agendada", "status": ["Avaliação agendada"] },
       { "key": "compareceu", "label": "Compareceu", "status": ["Compareceu"] },
       { "key": "negociacao", "label": "Em negociação", "status": ["Em negociação"] },
       { "key": "fechou", "label": "Fechou", "status": ["Fechou"] }
     ],
     "campanhas": [
       { "campanha_id": "120247232763550629", "campanha_nome": "Invisalign — Frio 03",
         "resolvido": true, "total": 10,
         "por_status": { "Perdido": 6, "Não tem Interesse": 2, "Avaliação agendada": 1, "Fechou": 1 } }
     ],
     "sem_campanha": { "total": 1746, "por_status": { "Perdido": 65, "Não tem Interesse": 2, "Fechou": 30 } }
   }
   ```
   O front aplica a **métrica selecionada** (default `sem_interesse`), calcula
   `valor = soma dos status da métrica` e `taxa = valor / total`, filtra `valor > 0` e **ordena por
   `valor` desc** (ou por `taxa` se o usuário trocar). A definição das métricas vem do backend
   (`metricas[]`) para servidor e cliente compartilharem a mesma fonte de verdade do mapeamento
   status→etapa. O balde "(sem campanha)" vai num campo separado (`sem_campanha`), nunca no
   ranking principal.

### Componente 2 — Backend: `GET /api/marketing/qualidade-lead/drill`

Lista os leads reais de uma campanha **na etapa selecionada**. **Query:**
`campanha_id=<id>&metrica=<key>&periodo=...` (ou `desde`/`ate`). `metrica` é a `key` de uma das
métricas (default `sem_interesse`); o servidor traduz para o conjunto de status correspondente
(mesma definição que alimenta `metricas[]`, validando contra a lista conhecida — nunca
interpola status cru vindo do cliente no SQL). `campanha_id=__none__` busca o balde sem campanha
(`campanha IS NULL`). Retorna `{ leads: [{ lead_id, nome, status, criado_em }] }`, limitado
(ex.: 200) e ordenado por `criado_em` desc. O front linka cada lead para sua ficha
(`/?page=...&lead=<id>` — confirmar o padrão de deep-link de lead já usado no CRM durante a
implementação).

### Componente 3 — Frontend: aba "Qualidade de Lead"

`public/js/marketing-agente/app.js` + `index.html`.

- Controles: seletor de **Etapa** (`metricas[]` vindas do backend, default "Sem interesse") +
  seletor de **Período** (reusa o existente) + toggle de **ordenação** (Volume ⇄ Taxa). Ao
  ordenar por **Taxa**, aplica um **mínimo de leads** (default 5) para não deixar campanha de 1
  lead = 100% poluir o topo; o mínimo é exposto como filtrinho.
- Lista de cards/linhas: **nome da campanha · Nº na etapa · % da campanha**. O cabeçalho da
  coluna reflete a etapa selecionada (ex.: "Sem interesse" → "Fechou"). Realce visual (pill) para
  campanhas com **alto volume E alta taxa**; cor da pill conforme a etapa ser ruim
  (`var(--red)`, ex.: sem interesse/perdido) ou boa (`var(--green)`, ex.: fechou/agendada).
- **Drill** ao clicar: expande e lista os leads daquela etapa (nome + status + data), cada um
  linkando para a ficha do lead.
- **Nota de cobertura** no topo, recalculada por etapa: "X% dos leads de *<etapa>* têm campanha
  identificada (Y de Z)" — torna explícito que etapas avançadas têm cobertura baixa. Card discreto
  do balde "(sem campanha)" no rodapé da lista, de-enfatizado.
- Escapar toda string externa (nome de campanha do Meta, nome do lead) com o `esc()` que já
  existe no `app.js` — anti-XSS.

### Componente 4 — Restyle (reskin + UX)

**Reskin (obrigatório):**
- Adicionar ao `index.html` o bloco de tokens **idêntico** ao do `capi-saude/index.html`:
  `:root { --bg... }` e `[data-theme="light"] { ... }`, e `data-theme="dark"` no `<html>`.
- Trocar todas as cores fixas do `<style>` por `var(--...)`. Reusar as convenções de classe do
  Saúde CAPI: `.card`, `.btn`, `.pill`, `table/th/td`, `h1/.sub/h2`. Os selos atuais
  (escalar/cortar/observar) viram `pill` com as cores via `var(--green/--red/--yellow)`.
- Resultado: a página passa a respeitar tema claro/escuro automaticamente (o `shared-nav.js`
  já aplica `data-theme`; hoje a página simplesmente ignorava por usar cor fixa).

**Pequenas melhorias de UX (acordadas):**
- Substituir os 4 `prompt()` de Parâmetros (`btn-config`) por um **modal** com inputs
  (meta_roas, gasto_minimo, maturacao_dias, cobertura_minima) + botões Salvar/Cancelar.
- Polir o drill da aba ROAS visualmente (mesmas classes de card/pill), sem mudar a lógica de
  dados nem os endpoints.

## Fluxo de dados

```
[Aba Qualidade de Lead]
  app.js --GET /api/marketing/qualidade-lead?periodo=N-->
    server.js: RPC marketing_qualidade_lead(desde,ate)  ── breakdown por status de cada campanha
             + Graph act_<id>/campaigns?fields=id,name   ── resolve id→nome (cacheável)
    <-- { campanhas[{por_status}], sem_campanha, metricas[], sem_token }
  troca de etapa/ordenação -> recalcula e reordena NO FRONT (sem round-trip)
  click campanha --GET /api/marketing/qualidade-lead/drill?campanha_id=X&metrica=K-->
    server.js: traduz metrica K -> conjunto de status -> SELECT leads da campanha nessa etapa
    <-- { leads[] }  --> linka para ficha do lead
```

## Tratamento de erros

- Sem `META_ADS_TOKEN`/`META_ACCESS_TOKEN` → `sem_token:true`, mostra IDs crus (não quebra).
- Chamada ao Graph com timeout (`AbortController`, ~25s, como a rota de ROAS); se falhar,
  segue com IDs crus em vez de derrubar a resposta.
- Período inválido → 400 (reusa o `_parseDate` da rota de ROAS).
- Erros do RPC → 500 com mensagem, capturados pelo `try/catch` padrão das rotas.

## Testes

- **Unit (lib):** extrair a lógica de ranking para um helper em `lib/marketing/` (ex.:
  `qualidade.js`) e testar: cálculo de `valor`/`taxa` por métrica a partir de `por_status`;
  ordenação por volume; ordenação por taxa com mínimo de leads; troca de etapa (sem interesse →
  fechou) muda o ranking; balde "(sem campanha)" nunca no ranking principal; tradução
  `metrica key → status[]` rejeita key desconhecida.
- **RPC:** validar `marketing_qualidade_lead` direto no SQL contra os números já conhecidos
  (ex.: campanha `...3550629` = 8 sem-interesse / 10 total; Perdido 90d = 165).
- **Manual:** abrir a página em tema claro e escuro e conferir alinhamento com o resto do
  sistema; trocar etapa no seletor; drill listando leads da etapa e linkando para a ficha.

## Fora de escopo (YAGNI)

- Quebra por **origem** ou por **anúncio** (decidido: só campanha agora). Origem tem 100% de
  cobertura e pode ser uma fase 2 fácil se o Luiz quiser.
- Reescrever a lógica de ROAS/atribuição (RPC `marketing_campanhas`) — intocada.
- Backfill/normalização de `leads.campanha`.

## Deploy

Após implementar: aplicar migração da RPC via MCP Supabase (`apply_migration`, projeto
`mtqdpjhhqzvuklnlfpvi`), `git push` na `main` e deploy Easypanel do CRM (token em CLAUDE.md).
Atenção ao working dir concorrente — conferir branch antes de commitar.
