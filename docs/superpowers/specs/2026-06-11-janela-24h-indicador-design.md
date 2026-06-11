# Indicador da Janela de 24h no módulo WhatsApp — Design

**Data:** 2026-06-11
**Contexto:** Em 2026-06-10 descobrimos que 91 mensagens de 70 leads foram descartadas pela Meta por envio fora da janela de 24h. O servidor já bloqueia envio livre fora da janela (`janela24hAberta()` em `server.js`, commit 44192ae) e a política de números é fixa: conversa livre sempre pelo SDR 2873, template sempre pelo 8700 (commit 0b41bdb). Falta a CRC **ver** o estado da janela antes de tentar — este design resolve isso.

## Objetivo

A CRC deve saber, sem tentar enviar:
1. Se o lead ainda recebe mensagem livre (janela aberta) e **quanto tempo falta** para fechar.
2. Quando a janela fechou, que a única ação possível é **template**.
3. Na lista/kanban, **quais conversas estão vencendo**, para priorizar resposta.

## A regra (única, espelhada do servidor)

Janela aberta = existe mensagem `direcao='recebida'` com `wa_number_id` ∈ {2873 (defaultPhoneId), `''`, `null`} há menos de 24h. É a mesma regra de `janela24hAberta()` no `server.js` — o front replica apenas para exibição; **o servidor continua sendo a autoridade no envio** (rede de segurança se o front divergir).

Estados:

| Estado | Condição | Visual |
|---|---|---|
| 🟢 `aberta` | restam > 6h | verde discreto |
| 🟡 `fechando` | restam ≤ 6h | amarelo, destaque |
| 🔴 `fechada` | sem inbound há ≥ 24h, ou lead nunca respondeu | vermelho |

Formato do tempo: `23h`, `5h 32min`, `47min` (sem segundos). Corte do amarelo (6h) definido como constante única no front para ajuste fácil.

## Componentes

### 1. Função compartilhada no front (`public/index.html`)

```js
// estadoJanela(ultimaRecebidaEm) → { estado: 'aberta'|'fechando'|'fechada', restanteMs, label }
```
Função pura: recebe o timestamp da última mensagem recebida (já filtrada pelo número SDR) e devolve estado + label formatado. Usada pelo chat, pela lista e pelo kanban — formatação num lugar só.

No chat, o timestamp vem das próprias mensagens carregadas (filtra `direcao==='recebida' && (!wa_number_id || wa_number_id === _waDefaultId)`). Na lista/kanban vem da nova coluna da RPC.

### 2. Dentro da conversa

Faixa fina entre `#chat-msgs` e a área de digitação (novo elemento `#chat-janela-bar`), sempre visível:

- 🟢 `Janela aberta — fecha em 22h`
- 🟡 `⏳ Janela fecha em 2h 15min — responda logo`
- 🔴 área de digitação inteira desabilitada (input, microfone, anexo, emoji, agendar) e em seu lugar: faixa vermelha `Janela de 24h fechada — este número não recebe mensagem livre` + botão **📢 Enviar template** (chama `abrirModalTemplate()`, que já existe).

Atualização: recalcula a cada poll do chat (4s, já existente) + `setInterval` de 60s só para o texto do contador. Quando o lead responde, o webhook insere a mensagem → próximo poll reabre o campo automaticamente. Ao trocar de conversa (`abrirChat`), o estado é recalculado do zero.

### 3. Lista de conversas + kanban

**Backend:** a RPC `conversas_com_preview` ganha parâmetro `sdr_phone text default null` e a coluna `ultima_recebida_em` (LATERAL: última `recebida` do lead com `wa_number_id` igual a `sdr_phone`, vazio ou null). O `server.js` passa `whatsapp.defaultPhoneId()` na chamada. Nova migration versionada (CREATE OR REPLACE; a assinatura antiga sem parâmetro é substituída — `DROP FUNCTION` da versão sem argumento se necessário).

**Lista (`renderChatList`):** verde não mostra nada (evita poluição). Chips só quando requer atenção:
- 🟡 `⏳ 2h` ao lado do horário — janela fechando
- 🔴 `fechada` (chip discreto cinza-avermelhado)

**Kanban (`renderKanban`):** mesmos chips no rodapé do card.

### 4. Filtro "⏳ Vencendo" (pedido do Luiz)

Botão de filtro na barra da lista, ao lado do filtro de não lidas (`toggleFiltroNaoLidas`, padrão visual idêntico): quando ativo, `filtrarChats()` mostra **apenas conversas com estado `fechando`** (🟡). Toggle simples, estado em variável local (`_filtroVencendo`), combinável com busca/CRC/não-lidas.

## Casos de borda

- **Lead nunca respondeu** (importação, formulário): 🔴 fechada — correto, nunca houve janela.
- **Números de família com 0 à esquerda** (estratégia intencional, ver memória): 🔴 sempre — correto, não recebem mesmo.
- **Template não abre janela**: enviar template não muda o indicador; só **resposta do lead** abre.
- **Modos CRC Comercial / API Oficial**: mesma regra (2873), porque toda mensagem livre sai pelo 2873 independentemente da tela.
- **Divergência front/servidor**: o bloqueio do servidor (HTTP 400 + toast) permanece como fallback.
- **Relógio do cliente errado**: o cálculo usa `Date.now()` do navegador; desvio de minutos é tolerável porque o servidor é a autoridade.

## Fora de escopo (YAGNI)

- Notificação push quando a janela estiver para fechar.
- Indicador de janela do número 8700 (broadcast) — templates não dependem de janela.
- Persistir estado do filtro entre sessões.

## Validação

Teste manual com 3 leads reais:
1. Lead que respondeu há pouco → 🟢 com tempo correto; chip ausente na lista.
2. Lead com janela ≤ 6h → 🟡 no chat, chip `⏳` na lista/kanban; filtro "Vencendo" o exibe.
3. Lead da lista de não-entregues → 🔴, campo bloqueado, botão template abre o modal; após o lead responder (teste com número próprio), campo reabre sozinho em ≤ 8s.
