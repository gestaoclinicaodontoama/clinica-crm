# Disparo em Massa via WhatsApp — Design (Fase 1)

**Data:** 2026-06-16
**Autor:** Luiz + Claude
**Status:** Aprovado (aguardando revisão da spec)

## Problema

Hoje a página **Disparos** tem dois painéis independentes: "Templates WhatsApp" e
"Importar Pacientes". Não existe forma de **enviar um template para uma lista
inteira de uma vez** com controle e registro. Para disparar, é preciso abrir cada
conversa e clicar "📢 Template" manualmente. Além disso, não fica claro o que foi
disparado, para quem, nem quando — e nada disso aparece de forma organizada no
perfil do lead.

O usuário tem CSVs já gerados (ex.: `wa_3_orcamento_invisalign_ortodontia.csv`,
245 contatos) e quer disparar **hoje**, com:

1. Controle dos disparos feitos (quantos, status, quando).
2. Registro do disparo no histórico do lead (perfil).
3. Sem criar leads duplicados desnecessariamente.

## Escopo

**Fase 1 (este documento):** Disparo em massa a partir de **upload de CSV**, com
runner controlado, relatório de campanha e registro no perfil do lead.

**Fora de escopo (Fase 2, projeto próprio):** Segmentação dos destinatários a
partir da própria base do CRM (ex.: "veio e não fechou, orçamento era do produto
X"; "veio e fechou o produto Y"), no estilo Pipefy (cards ligados a registros de
uma database). A reorganização do lado dos leads também é Fase 2.

## Decisões (definidas no brainstorm)

| Tema | Decisão |
|------|---------|
| Fonte da lista (hoje) | Upload de CSV |
| Telefone que **não** casa com lead existente | **Criar lead leve** (`origem='disparo-csv'`, etiqueta = nome da campanha) e disparar — começa a organizar a base sozinha |
| Onde aparece no perfil do lead | **Nova aba "📢 Disparos"** ao lado de "📞 Chamadas" **+** entrada na timeline de Histórico |
| Ritmo de envio | Devagar e seguro: ~1 envio a cada ~2,5s (≈24/min); 245 contatos ≈ 10 min |
| Painel "Importar Pacientes" atual | **Mantido** (usado para enviar a poucas pessoas via CSV de outro sistema) |

## Fluxo

```
Página Disparos → aba "Disparar"
  1. Upload CSV  → parser lê cabeçalho e normaliza
  2. Preview     → "X casam com lead existente · Y serão criados como lead novo · Z sem telefone válido (ignorados)"
  3. Escolher template (apenas APROVADOS na Meta) + nome da campanha
  4. Confirmar   → cria campanha + grava contatos como `pendente` (NÃO envia ainda)
  5. Iniciar     → runner em background, ~24/min
  6. Progresso   → barra com enviados / falhas / restantes (polling)
  7. Relatório   → totais + lista de falhas com motivo
```

## Modelo de dados (2 tabelas novas)

### `disparos_campanhas`
| Coluna | Tipo | Notas |
|--------|------|-------|
| id | bigserial PK | |
| nome | text | nome da campanha (vira etiqueta dos leads novos) |
| template_nome | text | nome do template (API) usado |
| lang | text | default `pt_BR` |
| total | int | total de contatos válidos |
| enviados | int | atualizado pelo runner |
| falhas | int | atualizado pelo runner |
| status | text | `rascunho` / `enviando` / `pausada` / `concluida` |
| criado_por | uuid | id do usuário |
| criado_em | timestamptz | default now() |
| iniciada_em | timestamptz | null até iniciar |
| concluida_em | timestamptz | null até concluir |

### `disparos_contatos`
| Coluna | Tipo | Notas |
|--------|------|-------|
| id | bigserial PK | |
| campanha_id | bigint FK → disparos_campanhas | |
| lead_id | bigint FK → leads (nullable até casar/criar) | |
| nome | text | nome exibível (sem o `(id)`) |
| primeiro_nome | text | usado em `{{1}}` |
| telefone | text | normalizado `55`+DDD+número |
| variaveis | jsonb | variáveis do template (default `[primeiro_nome]`) |
| status | text | `pendente` / `enviado` / `falha` |
| wa_id | text | id da mensagem na Meta (para casar status de entrega) |
| erro | text | motivo da falha |
| enviado_em | timestamptz | |

O **status de entrega/leitura (✓ / ✓✓ / lido)** NÃO é duplicado aqui: sai da
tabela `mensagens` existente (já atualizada pelo webhook de status), casando por
`wa_id`. Sem alterar o webhook.

## Backend (novos endpoints em `server.js`)

Todos protegidos por `requireAuth` + role (admin/gestor/crc_comercial — mesmo
`data-roles` do link Disparos) + `rateLimit`.

- `POST /api/disparos/preview` — body: `{ contatos: [...] }` (CSV já parseado no
  front). Para cada um normaliza telefone e marca se casa com lead existente
  (via `chaveTelefone`). Retorna contagens `{ casam, novos, invalidos }` +
  amostra. **Não grava nada.**
- `POST /api/disparos/criar` — body: `{ nome, template_nome, lang, contatos }`.
  Cria `disparos_campanhas` (status `rascunho`) + grava todos os contatos válidos
  como `pendente`. Retorna `{ campanha_id, total }`.
- `POST /api/disparos/:id/iniciar` — marca `enviando`, dispara o **runner em
  background** (in-process). Retorna imediatamente `{ ok: true }`.
- `GET /api/disparos/:id/progresso` — `{ status, total, enviados, falhas, restantes }`.
- `POST /api/disparos/:id/pausar` — runner para após o envio atual; status `pausada`.
- `POST /api/disparos/:id/retomar` — re-dispara o runner para os `pendente`.
- `GET /api/disparos` — lista de campanhas (histórico).
- `GET /api/disparos/:id` — detalhe + lista de contatos (para relatório/falhas).

### Runner (`lib/disparos/runner.js`)
Loop sobre contatos `pendente` da campanha:
1. Resolve o lead: casa por `chaveTelefone`; se não existe, cria lead leve
   (`{ nome, telefone, origem:'disparo-csv', status:'Lead', etiquetas:[nome_campanha] }`).
   Grava `lead_id` no contato.
2. `whatsapp.enviarBroadcast({ para: telefone, templateName, variaveis, lang })`.
3. Em sucesso: grava `mensagens` (canal `broadcast`, com `wa_id`), `lead_eventos`
   (`disparo_massa` para a timeline), atualiza `disparos_contatos` (`enviado`,
   `wa_id`) e `leads.ultimo_contato`. Incrementa `enviados`.
4. Em erro: grava `erro`, status `falha`, incrementa `falhas`. **Não aborta** a
   campanha — segue para o próximo.
5. Pausa ~2,5s entre envios.
6. Ao fim (sem `pendente`): status `concluida`, `concluida_em`.

**Resiliência:** estado vive no banco. Se o processo reiniciar (deploy Easypanel)
no meio, a campanha fica `enviando` órfã. Na inicialização do servidor, campanhas
`enviando` são marcadas `pausada` (não auto-retomam, para evitar reenvio
surpresa). O usuário clica **Retomar** e o runner processa só os `pendente` —
quem já recebeu (`enviado`) nunca é reenviado. Idempotência garantida pelo status
por contato.

## Frontend

### Página Disparos (`public/index.html` — `#page-disparos`)
Reorganizar em 3 áreas (abas internas ou seções):
- **Disparar** (novo): upload CSV → preview → template + nome → confirmar →
  progresso. Botão "📎 Upload CSV" + textarea de colar (reaproveita parser).
- **Campanhas** (novo): tabela com nome, template, total, enviados, falhas,
  status, data; ações Retomar / Ver relatório.
- **Templates** (existente): inalterado.
- **Importar Pacientes** (existente): **mantido** (cria leads, fluxo separado).

### Parser de CSV (`public/` JS)
Lê o cabeçalho e mapeia colunas conhecidas:
- `primeiro_nome` → `{{1}}` (fallback: 1º token de `nome`/`nome_completo`).
- `nome_completo`/`nome` → nome do lead, removendo sufixo `(12345)`.
- `telefone` → só dígitos; se não começa com `55` e tem 10–11 dígitos, prefixa `55`.
- Ignora linhas sem telefone válido. Aceita também o formato simples `nome, telefone`.
- Separador vírgula ou ponto-e-vírgula; primeira linha cabeçalho ignorada.

### Perfil do lead (`public/index.html` — modal)
- Nova aba **"📢 Disparos"** ao lado de "📞 Chamadas": lista os
  `disparos_contatos` daquele `lead_id` (join na campanha p/ template + data; join
  em `mensagens` por `wa_id` p/ status de entrega). Endpoint
  `GET /api/leads/:id/disparos`.
- Timeline de **Histórico**: cada disparo já gera evento `disparo_massa`, então
  aparece junto dos demais eventos.

## Tratamento de erros e bordas

- **Template não aprovado:** dropdown só lista templates com `status='aprovado'`.
  ⚠️ Pré-voo manual: confirmar na Meta que os templates Invisalign saíram de
  PENDING antes do disparo de hoje.
- **Telefone inválido / vazio:** ignorado no preview (contado em `invalidos`).
- **Falha de envio Meta (ex.: code 2 transitório):** contato marcado `falha` com
  motivo; campanha segue. Falhas podem ser reprocessadas via Retomar (opcional:
  botão "Reenviar falhas" numa iteração futura — não bloqueia Fase 1).
- **Janela de 24h:** não se aplica — template/broadcast abre conversa.
- **Lead duplicado:** evitado pelo casamento `chaveTelefone` antes de criar.
- **Deploy no meio:** ver "Resiliência" acima.

## Migração Supabase

`supabase/migrations/2026XXXXXXXXXX_disparos_em_massa.sql` — cria as 2 tabelas +
índices (`disparos_contatos(campanha_id, status)`, `disparos_contatos(lead_id)`).
Aplicar via MCP Supabase (project `mtqdpjhhqzvuklnlfpvi`).

## Testes

- Parser: CSV real `wa_3_*` (cabeçalho completo) e CSV simples `nome,telefone`;
  remoção do `(id)`; normalização de telefone com/sem 55.
- Resolução de lead: casa existente (não duplica) vs cria novo leve.
- Runner: pendente→enviado, falha não aborta, pausar/retomar não reenvia.
- Endpoint do perfil retorna disparos do lead com status correto.

## Plano de deploy

Branch próprio → migração Supabase → `git push` → deploy Easypanel (CRM) conforme
CLAUDE.md. Pré-voo dos templates Invisalign antes do disparo real.
