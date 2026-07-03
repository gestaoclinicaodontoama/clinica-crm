# Fila ⏰ Aguardando + ingestão de ecos (IA/app) + claim-first — Design

**Data:** 2026-07-03
**Contexto:** Item 1 da fila de melhorias do CRM (análise de pontas soltas 03/07). Problema medido em produção: mediana de 1ª resposta 8,6h e centenas de conversas "sem resposta" — mas parte delas foi respondida pela IA da Meta ou pela equipe via aplicativo WhatsApp Business (coexistência), respostas que **não entram** na tabela `mensagens` (o webhook só trata `field='messages'`; os ecos `smb_message_echoes` caem na tabela de diagnóstico `webhook_wa_debug` — 486 eventos desde 29/06, payload completo com `to`, `from`, `text.body`, `type`, `timestamp`, `wamid`).

**Decisões do Luiz:** claim-first (sem round-robin); alerta = filtro ⏰ na lista de conversas + varredura individual fim de dia (17:30 Maria Eduarda, 18:00 Paola); limite 30 minutos; conversa atendida pela IA NÃO é "sem resposta" — resolvido na raiz ingerindo os ecos (dado real, não heurística).

## Objetivo

1. Toda resposta enviada pela IA da Meta ou pelo app (coexistência) aparece na thread do CRM.
2. A CRC vê, na própria lista de conversas, quais leads estão esperando resposta há 30+ min — número que **bate** com os demais indicadores.
3. Lead novo ganha dono automaticamente quando alguém responde pelo CRM (claim-first).
4. Maria (17:30) e Paola (18:00) recebem varredura de fim de dia com o que ficou aguardando.

## Componente 1 — Ingestão dos ecos (fundação)

No `POST /webhooks/whatsapp` (server.js), além do fluxo atual de `messages`, processar changes com `field` = `smb_message_echoes` (e `message_echoes`, mesmo shape):

- Para cada item de `value.message_echoes[]`: achar o lead pelo telefone `to` usando a **mesma lógica de match** do fluxo de recebidas (exato → sufixo 8 dígitos/`chaveTelefone`).
- Inserir em `mensagens`: `direcao='enviada'`, `canal='app'` (novo valor, hoje o campo é livre), `texto=text.body` (ou rótulo por tipo p/ mídia: `[imagem]`, `[áudio]`…), `wa_id=wamid`, `wa_number_id=value.metadata.phone_number_id`, `criada_em=timestamp` do payload.
- **Dedup por `wa_id`**: antes de inserir, pular se já existe mensagem com o mesmo `wa_id` (protege contra echo de mensagem enviada via API e reentrega de webhook).
- Echo cujo `to` não casa nenhum lead → **ignorar** (ex.: conversa com paciente no app). Logar contagem no console, sem criar lead.
- UI: balão de enviada com selo discreto **"via app/IA"** quando `canal='app'` (verificar na implementação que o render de bolhas decide só por `direcao` hoje; o selo é aditivo).
- **Backfill one-shot**: script que percorre `webhook_wa_debug` (486 eventos desde 29/06) e ingere pelos mesmos critérios (idempotente via dedup por `wa_id`).
- A coleta em `webhook_wa_debug` continua ligada por enquanto (remoção é decisão do item 8 da fila).

Efeitos colaterais desejados (é isso que faz os indicadores "baterem"): preview da lista, 🔔 não-lida, janela 24h e a fila ⏰ derivam todos de `mensagens` — quando a IA/app responde, a última mensagem vira `enviada`, a conversa sai da fila ⏰ e deixa de parecer não-lida **ao mesmo tempo**. Documentado: conversas que hoje parecem "não lidas" podem sumir do alerta ao ingerir o eco — é o comportamento correto.

Nota: a janela de 24h (`janela24hAberta`, `ultima_recebida_em`) usa só `direcao='recebida'` — ecos não a afetam. O split oficial/lead por `ultima_wa_number_id` continua funcionando porque o eco grava `wa_number_id`.

## Componente 2 — Fila ⏰ "Aguardando"

**Regra canônica de "aguardando"** (definida em UM lugar — função SQL `conversas_aguardando(minutos int default 30)`; o filtro do cliente espelha a mesma regra):

> Lead com `status` em (`Novo`, `Em qualificação`, `Avaliação agendada`, `Compareceu`, `Em negociação`), sem `nao_ligar`, cuja **última mensagem** da conversa tem `direcao='recebida'` e `criada_em` ≥ N minutos atrás.

**UI (client-side, coerente por construção):**
- 4º botão-filtro **⏰** ao lado dos existentes 🔔/⏳/sem-CRC em `index.html` (`toggleFiltroAguardando`, mesmo padrão dos outros três).
- O filtro roda dentro do mesmo `filtrarChats()` sobre o mesmo array `chatLeads` (a RPC `conversas_com_preview` não tem LIMIT — carrega tudo), usando campos que **já vêm** na resposta: `ultima_mensagem_direcao==='recebida'` e `now − ultima_mensagem_em ≥ 30min`. Vale nos dois modos de visualização (lista e kanban) sem código extra.
- **Badge de contagem no próprio botão ⏰**, calculado no cliente a partir da mesma base pós-`_filtrarParaModo` — nunca diverge do que a lista mostra ao clicar.
- Com o filtro ativo, ordenar por espera (mais antiga primeiro) e mostrar chip "aguarda 1h40" no card.

## Componente 3 — Claim-first (dono)

- No(s) endpoint(s) de envio de mensagem pelo CRM (texto, mídia, template): se o lead não tem `crc_agendamento_id`, gravar `crc_agendamento_id/nome` = usuário autenticado + `logEvento('conversa_assumida')`.
- Resposta via app/eco **não** vira claim (o payload não identifica quem digitou).
- Chip discreto "sem dono" no card da lista quando `!crc_agendamento_id && !crc_comercial_id` (o filtro "sem CRC" já existe e passa a refletir o claim automaticamente). "Trazer para mim" continua para troca manual.
- O set automático existente no agendamento (status → Avaliação agendada) permanece; o claim só preenche quando vazio, nunca sobrescreve.

## Componente 4 — Varredura fim de dia

- Agendador interno no server (mesmo mecanismo do resumo 18:30 já existente), horário América/São_Paulo.
- Config em `app_config`: `varredura_aguardando = [{"usuario_id":"<uuid Maria Eduarda>","hora":"17:30"},{"usuario_id":"<uuid Paola>","hora":"18:00"}]` (editável sem deploy).
- No horário de cada pessoa: chama `conversas_aguardando(30)`; se houver itens, cria **notificação in-app** (tabela `notificacoes`) para aquele usuário: "⏰ X conversas aguardando resposta — mais antigas: Fulana (3h10), Sicrano (1h40)…" com link `/?page=conversas&filtro=aguardando` (o index lê o parâmetro e liga o filtro ⏰). Enviar push também quando as chaves VAPID forem restauradas (pendência conhecida de env).
- Sem itens → não notifica (sem ruído).

## Fora do escopo

Round-robin; SLA de estagnação de funil (item 4 da fila); remoção da coleta de debug (item 8); distinção IA × humano-no-app (payload não diferencia; selo único "via app/IA"); ingestão de mídia dos ecos (só rótulo do tipo, sem baixar arquivo).

## Erros e bordas

- Reentrega de webhook / echo duplicado → dedup por `wa_id`.
- Echo sem `text.body` (mídia/sticker/reaction) → rótulo `[tipo]`; reaction ignorada.
- Telefone com 0 à esquerda (família) → `chaveTelefone` já preserva a separação intencional; nenhum merge.
- Telefone duplicado na base → mesmo comportamento do fluxo atual (menor id); não piora nada.
- `timestamp` do echo em epoch segundos → converter; se ausente, `now()`.
- Falha na ingestão de um echo não pode derrubar o processamento do webhook (try/catch por item, padrão do handler atual).
- `.catch()` direto em builder Supabase é PROIBIDO (já derrubou o CRM) — try/catch no await.

## Testes

- `node:test` para o parser de echo (payload real de `webhook_wa_debug` como fixture): extração de campos, dedup, echo sem lead, echo de mídia.
- Teste da regra `conversas_aguardando` via SQL com dados sintéticos (última recebida antiga = entra; respondida via eco = sai).
- Validação manual pós-deploy: mandar mensagem de um celular de teste, responder pelo app, ver o balão "via app/IA" e a conversa sair da fila ⏰.

## Critérios de sucesso

1. Resposta dada pelo app/IA aparece na thread em segundos e remove a conversa da fila ⏰.
2. O número no badge ⏰ = quantidade de cards exibidos ao clicar no filtro, sempre.
3. Lead novo respondido pelo CRM ganha dono na hora (visível no chip da lista).
4. Maria e Paola recebem a varredura nos horários certos com deep-link funcionando.
5. Backfill ingere os ecos desde 29/06 sem duplicar mensagens enviadas via API.
