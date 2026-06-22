# Monitor de Saúde do CAPI — Design

**Data:** 2026-06-22
**Status:** aprovado (brainstorming) — aguardando revisão do spec

## Objetivo e contexto

O CRM envia eventos de conversão (LeadSubmitted, LeadQualified, Schedule, Contact,
Purchase) para a Meta via Conversions API (`dispararConversaoMeta` em `server.js`),
gravando cada tentativa em `lead_eventos` (tipo `capi_disparado`).

Em jun/2026 descobrimos que os eventos `LeadSubmitted` das páginas Clínica AMA (1204)
e Clínica Odontológica AMA (292) falhavam com erro **2804065** ("página x dataset
incompatíveis") — e isso passou **~13 dias despercebido**, derrubando ~metade do topo
de funil e inviabilizando a meta de 50 leads qualificados/semana.

**Meta deste projeto:** nunca mais ficar dias com o tracking quebrado sem perceber, e
ter visibilidade da contagem de cada evento por semana.

## Decisões (do brainstorming)

- **Entrega:** dashboard + alerta por exceção + resumo diário (os três).
- **Fonte:** nosso log (`lead_eventos`) como verdade primária + cross-check periódico
  com a API da Meta (estatísticas + qualidade do dataset).
- **Gatilhos de alerta:** todos os cinco (taxa de falha, silêncio de página, erro novo,
  queda de volume, divergência enviado-vs-registrado).
- **Resumo diário:** duas vezes — **8h** e **18h**.
- **Qualidade do match:** exibida no dashboard (cobertura de parâmetros + EMQ da Meta);
  por enquanto **sem** gatilho de alerta.
- **Arquitetura:** Abordagem A — dashboard ao vivo (SQL no `lead_eventos`) + cron de
  alerta (~30 min) + cross-check 1x/dia. Reaproveita os padrões existentes do CRM.

## Componentes

1. **`lib/capi/health.js`** — funções puras, sem efeito colateral, testáveis isoladas:
   - agregações do `lead_eventos` (contagens por evento × página × status, por semana);
   - cobertura de parâmetros de match;
   - avaliação dos cinco gatilhos (recebe dados, devolve estado `ok`/`ruim` + detalhe).
2. **`GET /api/admin/capi-saude`** (`requireAuth` + admin/gestor) — devolve o JSON do
   dashboard: contagens 7d, tabela semanal, cobertura de match, estado dos gatilhos e o
   último snapshot do cross-check.
3. **`POST /api/admin/capi-saude/recheck`** (`requireAuth` + admin/gestor) — dispara a
   checagem de gatilhos na hora (botão "Re-checar agora").
4. **`public/capi-saude/`** (página) + **`public/js/capi-saude/`** (`api.js` + lógica) —
   UI do dashboard, seguindo o padrão `shared-nav` + `api.js` de autenticação.
5. **Item no `public/js/nav-config.js`** — `slug:'capi-saude'`, roles `admin,gestor`,
   `mode:'link'`, `href:'/capi-saude/'`.
6. **Cron de alerta** — tick a cada ~30 min no scheduler interno: chama `health.js`,
   compara com `capi_monitor_estado`, dispara push na virada `ok→ruim`.
7. **Cron de resumo diário** — dispara às **8h** e às **18h**: monta o digest e dá push.
8. **Job de cross-check Meta** — 1x/dia de madrugada (ex.: ~6h, **antes do resumo das
   8h**, para o snapshot já entrar fresco no digest): puxa `dataset_stats` e
   `dataset_quality` (EMQ) dos datasets monitorados via Graph API e grava
   `capi_meta_snapshot`.

## Fluxo de dados

- `dispararConversaoMeta` **já grava** cada tentativa em `lead_eventos` — **não é
  alterado**; é a fonte primária.
- **Dashboard:** página → `GET /api/admin/capi-saude` → `health.js` lê `lead_eventos`
  (janela 7d/semana) + último `capi_meta_snapshot` → devolve JSON.
- **Alerta:** cron tick → `health.js` avalia janelas recentes → compara com
  `capi_monitor_estado` → se piorou, `criarNotificacao` (push) + atualiza estado.
- **Resumo diário:** cron 8h/18h → `health.js` monta digest → push aos gestores/admin.
- **Cross-check:** cron diário → Graph API (`/{dataset}/stats` e qualidade) → grava
  snapshot → alimenta a seção "enviamos vs Meta registrou" e o gatilho 5.

**Invariante:** dashboard e gatilhos de volume/silêncio **só dependem do nosso log**.
Se a Meta estiver fora, o cross-check degrada (mostra "desatualizado desde X") sem
quebrar nada e sem gerar alarme falso.

## Gatilhos e limites

Limites ficam como **constantes no topo de `health.js`** (ajustáveis sem migration).

| # | Gatilho | Janela | Guarda | Dispara quando |
|---|---------|--------|--------|----------------|
| 1 | Taxa de falha alta | últimas 6h | ≥ 10 tentativas na janela | falha > **30%** |
| 2 | Página/dataset em silêncio | últimas 18h | página com média ≥ 3 sucessos/dia nos 7d anteriores | **0 sucessos** na página na janela |
| 3 | Erro novo aparecendo | 24h vs 14d anteriores | — | surge subcode/erro inexistente no histórico |
| 4 | Queda de volume | 24h vs média do mesmo dia da semana nas 3 semanas anteriores | ≥ 2 semanas de histórico | sucessos < **50%** da média |
| 5 | Divergência enviado-vs-registrado | snapshot diário | cross-check disponível | Meta registrou < **50%** do que enviamos com sucesso (200) no dataset |

**Antispam (dedup):** cada gatilho tem estado `ok`/`alertado` em `capi_monitor_estado`
(por escopo, ex.: silêncio por `page_id`). Push só na virada `ok→ruim`; no máximo **1
lembrete a cada 12h** enquanto continuar ruim; quando normaliza, reseta para `ok`
silenciosamente (o resumo diário registra "voltou ao normal").

## Tabelas (Supabase)

### `capi_monitor_estado`
Dedup/estado dos alertas.
- `id` bigint PK
- `gatilho` text — ex.: `taxa_falha`, `silencio`, `erro_novo`, `queda_volume`, `divergencia`
- `escopo` text NULL — ex.: `page_id` ou `dataset_id` (para gatilhos por entidade)
- `status` text — `ok` | `alertado`
- `fingerprint` text — assinatura do problema atual (evita repetir alerta idêntico)
- `ultimo_alerta_em` timestamptz NULL
- `detalhe` jsonb — números do gatilho no momento
- `atualizado_em` timestamptz default now()
- UNIQUE(`gatilho`, `escopo`)

### `capi_meta_snapshot`
Resultado do cross-check diário (enviado vs registrado + EMQ).
- `id` bigint PK
- `data` date
- `dataset_id` text
- `evento` text NULL — NULL para a linha de qualidade (EMQ) do dataset
- `enviados_sucesso` int — do nosso log (200/events_received no dia)
- `registrados_meta` int NULL — da API Meta (NULL = indisponível)
- `emq` numeric NULL — Event Match Quality do dataset (NULL = indisponível)
- `criado_em` timestamptz default now()
- UNIQUE(`data`, `dataset_id`, `evento`)

**Datasets monitorados** (constante em `health.js`, fácil de estender):
- `904146029308947` — Pixel WhatsApp CAPI (Página 106, Dr. Marcos Vinicius - AMA)
- `981176104681444` — Pixel WhatsApp CAPI - Clínica AMA (Página 1204)

## Dashboard (`/capi-saude/`)

De cima pra baixo:
1. **Status geral** 🟢/🟡/🔴 + "última checagem há X min" + botão **Re-checar agora**.
2. **Cartões 7d:** total de tentativas, % de sucesso global, e por página (106 vs 1204):
   sucesso/falha.
3. **Tabela "Eventos por semana":** linhas = cada evento (LeadSubmitted, LeadQualified,
   Schedule, Contact, Purchase); colunas = enviados / sucesso / falha / % sucesso;
   semana atual com a anterior ao lado para comparação. **Semana = segunda a domingo**
   (fuso America/Sao_Paulo).
4. **"Enviamos vs Meta registrou"** (do snapshot), por dataset.
5. **"Qualidade do match":** cobertura dos parâmetros (% de eventos com telefone,
   e-mail, nome, ctwa_clid, page_id) do nosso log + EMQ da Meta por dataset (quando
   disponível; senão "indisponível").
6. **"Erros recentes":** subcode + contagem + última vez + mensagem da Meta.
7. **Painel dos 5 gatilhos:** cada um 🟢/🔴 com o detalhe.

## Resumos diários (8h e 18h)

Push (web-push) + notificação no sino, via `criarNotificacao(usuarioId, 'capi_resumo',
titulo, corpo, { url: '/capi-saude/' })`, para todos os usuários com role **gestor** ou
**admin** (mesmo loop do `monitor-crc`). Conteúdo: status geral, totais por evento
(sucesso/falha), gatilhos ativos e itens que "voltaram ao normal".

- **Resumo das 8h:** fecha o **dia anterior** (dia completo) — o gestor começa o dia
  sabendo se o tracking de ontem rodou inteiro.
- **Resumo das 18h:** o **dia corrente até o momento** — pega problemas do dia ainda a
  tempo de agir.

Alertas por exceção usam o tipo `capi_alerta` (mesma função de notificação).

## Tratamento de erro

- **Cross-check Meta falhou ou veio vazio:** `try/catch`; mantém o último snapshot; o
  dashboard mostra "cross-check desatualizado desde X". Resposta vazia/parcial =
  **indisponível**, nunca "zero". Como volume/silêncio usam o nosso log, um cross-check
  falho **não** gera alarme falso.
- **Crons (alerta, resumo, cross-check):** cada tick em `try/catch`, loga e nunca lança;
  estado no banco → tick perdido se recupera (padrão self-healing do `sync_log`).
- **Push:** reaproveita `sendPushToUser` (já remove assinatura morta).
- **Endpoint do dashboard:** sub-query que falha → devolve parcial com flag de erro, não
  500.
- **Auth:** `requireAuth` + role `admin`/`gestor`; página usa `shared-nav` + `api.js`.

## Testes (TDD)

Testes escritos antes da implementação.

- **`health.js` — um teste por gatilho:**
  - taxa de falha > 30% com ≥ 10 tentativas dispara; abaixo de 30% ou < 10 não dispara;
  - silêncio 18h em página ativa dispara; página de baixa média não dispara;
  - subcode novo vs histórico de 14d dispara;
  - volume < 50% da média do mesmo dia da semana dispara; sem ≥ 2 semanas pula;
  - divergência Meta < 50% do enviado dispara.
- **Dedup:** `ok→ruim` dispara 1x; continua ruim → sem repetir antes de 12h; normalizou
  → reseta para `ok`.
- **Agregações:** "eventos por semana" e cobertura de match contra linhas semeadas em
  `lead_eventos`.
- **Cross-check:** parse/compare com respostas Meta mockadas, incluindo o caso de
  falha/vazio → marca indisponível sem falso alarme.
- **Validação manual pós-deploy:** abrir `/capi-saude/`, clicar "Re-checar agora", bater
  os números com um SQL manual.

## Fora de escopo (YAGNI por enquanto)

- Tabela de histórico/tendência com gráficos de série temporal (a Abordagem B). Adicionar
  depois se sentir falta.
- Gatilho de alerta sobre queda de qualidade de match (EMQ/cobertura) — por ora só
  exibido.
- Correção da página 292 (Clínica Odontológica AMA), que depende de transferência de
  propriedade de BM — é um caminho à parte, não deste monitor.
