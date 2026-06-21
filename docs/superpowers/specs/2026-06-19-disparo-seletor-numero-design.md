# Disparo em Massa — Seletor de Número + Filtro de Conversas por Campanha — Design

**Data:** 2026-06-19
**Autor:** Luiz + Claude
**Status:** Aprovado (aguardando revisão da spec)
**Base:** estende o módulo Disparo em Massa (spec `2026-06-16-disparo-em-massa-design.md`)

## Problema

Hoje o Disparo em Massa envia **sempre pelo número de broadcast (8700)** — `enviarBroadcast()`
no `whatsapp.js` está fixo em `WA_BROADCAST_PHONE_ID`/`WA_BROADCAST_TOKEN`. Para os leads
quentes (ex.: os 52 de Invisalign, DDD 31), o ideal é disparar pelo **mesmo número com que
eles já conversaram, o 2873**, para a resposta cair no inbox certo e não parecer abordagem fria.

Além disso, depois de disparar não há como **ver nas Conversas quem entrou numa campanha**
de disparo, nem filtrar por uma campanha específica.

## Escopo

1. **Seletor de número** no Disparo em Massa, com **padrão no 2873**, persistido na campanha
   e usado pelo runner (envio + registro em `mensagens`).
2. **Filtro nas Conversas** por **campanha de disparo** (ver só quem recebeu o disparo de
   uma campanha; opção "Todas" limpa o filtro).
3. **Guardrail** que pausa a campanha se o template não existir no número escolhido (WABA
   diferente), preservando os contatos `pendente` para retomar com outro número.

**Fora de escopo:** seletor no envio individual (botão 📢 Template de uma conversa);
filtro por template manual ou por nome de template; criar disparador separado (decidido
contra — duplicaria tabelas/runner/UI e poluiria o menu).

## Decisões (definidas no brainstorm)

| Tema | Decisão |
|------|---------|
| Onde escolher o número | Só no Disparo em Massa |
| Padrão do seletor | **2873** (o `defaultPhoneId` de `/api/config/wa`) |
| Fonte da lista de números | Reaproveita `/api/config/wa` → `getPhoneNumbers()` (sem env nova) |
| Manter o 8700 | Sim — continua disponível no seletor para listas frias (estratégia 2 números) |
| Filtro de Conversas | Baseado em **campanha de disparo** (`disparos_contatos`), granularidade por campanha |
| Arquitetura | **Um disparador só** — estende o existente; nada duplicado |

## Restrição técnica: WABA (conta) do número

Um template do WhatsApp só pode ser disparado por um número se estiver aprovado na **mesma
WABA** desse número. O código usa **uma única** `WA_BUSINESS_ACCOUNT_ID` para sincronizar/
validar templates (`templateAprovado()` checa a tabela local `templates`). Se o 2873 e o 8700
estiverem na mesma WABA, qualquer template aprovado serve para os dois. Se estiverem em WABAs
diferentes, um template aprovado no 8700 **não existe** no 2873 e a Meta recusa o envio.

Não dá para confirmar isso só pelo código (depende dos tokens no Easypanel / Meta). Por isso:
- **Guardrail no runner** (ver abaixo) protege a lista caso a WABA não bata.
- **Verificação prévia recomendada:** antes do disparo real, enviar **1 teste para o próprio
  número** pelo 2873 (a tela aceita lista de 1 linha). Chegou → WABA ok, pode soltar os 52.

## Parte 1 — Seletor de número

### Dados
Nova coluna em `disparos_campanhas`:
| Coluna | Tipo | Notas |
|--------|------|-------|
| wa_number_id | text | phone_number_id escolhido. `NULL`/vazio = comportamento antigo (número de broadcast) |

### Backend
- **`GET /api/config/wa`**: incluir no retorno `sendable` = `Object.keys(getPhoneNumbers())`
  (os números com token), para o front do disparo listar só esses no seletor. Os IDs
  auto-descobertos continuam em `numbers` (usados em outras telas), mas ficam fora de `sendable`.
- **`whatsapp.js` → `enviarBroadcast({ para, templateName, lang, variaveis, phoneNumberId })`**:
  novo parâmetro opcional `phoneNumberId`. Se ausente, usa `WA_BROADCAST_PHONE_ID` (comportamento
  atual preservado). O token é resolvido por `_tokenForPhone(phoneId)` (já existe). Internamente
  passa a usar `_post(pid, _tokenForPhone(pid), payload)` em vez do par fixo de broadcast.
- **`POST /api/disparos/criar`**: recebe `wa_number_id`. Valida contra os números **com token
  configurado** — `Object.keys(await whatsapp.getPhoneNumbers())` (= 2873 e 8700), **não** a
  lista expandida de `/api/config/wa` (que inclui IDs auto-descobertos de mensagens antigas, sem
  token). Regras:
  - **Ausente** (cliente antigo, sem o campo): cai no `defaultPhoneId()` — compatibilidade.
  - **Presente mas sem token** (ex.: um 3º número descoberto): **rejeita com 400** ("Número sem
    credencial de envio configurada"), em vez de fallback silencioso que mandaria pelo número
    errado. `_tokenForPhone()` só resolve token para os dois números de env; qualquer outro cairia
    no `WA_TOKEN` por engano.
  - **Válido:** grava `wa_number_id` na campanha.
- **`runner.js` (`_loop`)**:
  - `enviarBroadcast({ ..., phoneNumberId: camp.wa_number_id || undefined })`.
  - Ao gravar em `mensagens`, usar `wa_number_id: camp.wa_number_id || whatsapp.broadcastPhoneId()`
    (hoje está fixo em `whatsapp.broadcastPhoneId()` na linha 78). É isso que faz a conversa
    nascer no número certo e aparecer no inbox do 2873.

### Frontend (`#page-disparos`)
- Novo `<select id="disp-numero">` ao lado de `#disp-template`, **pré-selecionado no
  `defaultPhoneId`** (2873). Para não oferecer número sem token (que o backend rejeitaria), o
  dropdown lista apenas os números **com token** — `/api/config/wa` deve marcar quais são
  enviáveis (ex.: campo `sendable: [ids]` = chaves de `getPhoneNumbers()`), e o front filtra por
  ele. Label = número formatado, ex.: "9649-2873".
- `dispCriarEIniciar()` inclui `wa_number_id` no corpo do `POST /api/disparos/criar`.
- Enquanto `/api/config/wa` não respondeu, o select mostra "Carregando…" e o botão Iniciar
  espera (ou cai no default no backend).

## Parte 2 — Filtro de Conversas por campanha

### Backend (`GET /api/conversas`)
- Aceita `?campanha_id=N` (além do `mode` atual).
- Com `campanha_id`: busca os `lead_id` de `disparos_contatos` daquela campanha com
  `status='enviado'` (query enxuta, só a coluna `lead_id`), monta um `Set` e filtra as linhas
  de `conversas_com_preview` por `r.id ∈ Set` (o RPC expõe o id do lead na coluna `id`, vinda de
  `l.id`). Sem `campanha_id`: nada muda.
- ⚠️ Uma campanha grande pode ter >1000 contatos; ao buscar os `lead_id`, paginar/`range`
  ou selecionar com `limit` alto explícito para não cair no corte silencioso de 1000 do
  cliente Supabase (ver memória do limite). Para os volumes atuais (dezenas) é trivial, mas
  o código deve paginar para não criar footgun.

### Frontend (aba Conversas)
- Dropdown **"📢 Campanha"** populado por `GET /api/disparos` (já existe): opção "Todas as
  campanhas" (default, sem filtro) + uma por campanha (nome + data).
- Ao escolher, recarrega as conversas com `?campanha_id=N`. Convive com o filtro `mode`
  existente (oficial/lead).

## Guardrail (salvaguarda de WABA)

No `runner.js`, se um envio falhar com erro de **template indisponível no número**
(código Meta `132001` "template does not exist", ou `132007` "template paused/rejected", ou
mensagem contendo "template" + "does not exist"/"not found" — match por código com fallback por
texto, pois a Meta nem sempre preenche o code de forma estável),
o runner **pausa a campanha inteira** (`status='pausada'`, `auto_pausada=true`) com uma
mensagem clara gravada (ex.: em `disparos_contatos.erro` do contato + log), **em vez de
marcar todos os contatos como falha**. Assim os `pendente` ficam intactos: o usuário troca o
número (ou corrige a WABA) e clica **Retomar**. Só esse tipo de erro pausa; falhas normais
(número inválido etc.) continuam não-abortantes, como hoje.

## Tratamento de erros e bordas
- **`wa_number_id` inválido no criar:** cai no `defaultPhoneId()` (não quebra).
- **`enviarBroadcast` sem `phoneNumberId`:** comportamento idêntico ao atual (broadcast).
- **Campanha antiga (sem `wa_number_id`):** `NULL` → usa broadcast, como antes. Sem migração de dados.
- **`/api/config/wa` indisponível no front:** select fica em "Carregando…"; backend aplica default.
- **Filtro de conversas com campanha sem envios:** lista vazia (correto).
- **Template ausente na WABA do número:** ver Guardrail.

## Migração Supabase
`supabase/migrations/20260619000000_disparos_wa_number.sql`:
```sql
ALTER TABLE disparos_campanhas ADD COLUMN IF NOT EXISTS wa_number_id text;
```
Aplicar via MCP Supabase (project `mtqdpjhhqzvuklnlfpvi`); verificar com `list_migrations`.

## Testes
- `enviarBroadcast` sem `phoneNumberId` → usa broadcast (regressão); com `phoneNumberId` →
  usa o número e o token corretos (`_tokenForPhone`).
- Runner usa `camp.wa_number_id` no envio e grava o mesmo `wa_number_id` em `mensagens`.
- `/api/disparos/criar` valida e persiste `wa_number_id`; inválido cai no default.
- `/api/conversas?campanha_id=N` retorna só os leads `enviado` da campanha; paginação >1000.
- Guardrail: erro de template-inexistente pausa a campanha e preserva `pendente`.

## Plano de deploy
Branch próprio → migração Supabase → `git push` → deploy Easypanel (CRM) conforme CLAUDE.md.
Antes de soltar os 52 de Invisalign: enviar 1 teste pelo 2873 para confirmar a WABA.
