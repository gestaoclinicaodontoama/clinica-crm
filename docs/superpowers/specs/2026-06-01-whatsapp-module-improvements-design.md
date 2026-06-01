# Melhorias do módulo WhatsApp — Design

**Data:** 2026-06-01
**Status:** Aprovado para planejamento

## Contexto

O chat de WhatsApp do CRM é uma única página (`#page-conversas` em `public/index.html`)
compartilhada por **CRC Lead** (`conv-agendamentos`) e **CRC Comercial** (`conv-avaliacao`).
Backend em `server.js` + `whatsapp.js` (Cloud API da Meta, número 1 / SDR).
Toda melhoria aqui vale automaticamente para os dois módulos e deve ser escrita de forma
**reutilizável** (funções/CSS compartilhados, nunca copiados) para servir de padrão a módulos
de WhatsApp futuros.

## Objetivos

1. Remover o aviso "Melhor no computador" no desktop.
2. Fazer áudio (recebido do paciente e enviado por nós) **tocar** no chat.
3. Adicionar seletor de emoji ao campo de mensagem.
4. Mostrar o anúncio de origem (com imagem) num banner no topo do chat.
5. Corrigir o "Erro ao carregar trajeto: Erro 502" no perfil do lead.

### Melhorias adjacentes incorporadas (mesma causa raiz / pré-requisito)
- Render idempotente das mensagens (pré-requisito do áudio — sem isso o poll de 4s
  reinicia a reprodução).
- Renderização de **imagem** e **documento** recebidos/enviados (mesma infraestrutura de mídia).

### Não-objetivos (escopo maior, ficam de fora)
- Status de entrega/leitura (✓✓) das mensagens — exige tratar webhooks de `statuses`.
- Armazenamento permanente de mídia (optou-se por proxy via Meta).
- Reações, respostas/threads, encaminhamento.

## Decisões tomadas
- **Áudio/mídia:** proxy via Meta. Guardamos `media_id` na mensagem; um endpoint do CRM
  baixa da Graph API sob demanda. Sem bucket. Limitação aceita: mídia enviada por nós
  expira ~30 dias no servidor da Meta.
- **Anúncio:** banner no topo do chat, além de manter na aba de perfil.

---

## 1. Aviso "Melhor no computador"

**Causa:** a regra `.mnav-desktop-only { display:none; ... }` (index.html ~511) está
**dentro** do `@media (max-width:768px)`. No desktop, o `<div>` volta ao default `block`
e aparece. O JS (`setPage`) só ajusta o display inline em mobile.

**Correção:** mover `.mnav-desktop-only { display:none }` para regra **base** (fora do media
query), mantendo os estilos de aparência (padding/cor/text-align). O JS continua mostrando o
aviso (`display:block` inline) apenas em mobile, nas telas `DESKTOP_ONLY`.

**Resultado:** oculto no computador, preservado no celular.

---

## 2. Áudio (e imagem/documento) tocando no chat

### 2.1 Banco — tabela `mensagens`
Migration Supabase (projeto `mtqdpjhhqzvuklnlfpvi`), colunas novas, todas nullable:
- `tipo` text — `'text' | 'audio' | 'image' | 'video' | 'document' | 'sticker'` (default `'text'`)
- `media_id` text — id da mídia na Meta
- `mime` text — content-type
- `media_filename` text — nome original (documentos)

Mensagens antigas ficam com `tipo` nulo → tratadas como texto no render (retrocompatível).

### 2.2 Recebimento (paciente) — `whatsapp.js` + webhook
`parseMensagemRecebida` hoje só lê `msg.text?.body`. Estender para, conforme `msg.type`,
capturar a mídia:
- `audio`  → `{ media_id: msg.audio.id, mime: msg.audio.mime_type }`
- `image`  → `media_id`, `mime`, `texto = msg.image.caption || ''`
- `video`  → idem image
- `document` → `media_id`, `mime`, `media_filename = msg.document.filename`, `texto = caption`
- `sticker` → `media_id`, `mime`

Retornar campos `tipo`, `media_id`, `mime`, `media_filename` no objeto.
O webhook (`POST /webhooks/whatsapp`) grava esses campos no insert de `mensagens`.

### 2.3 Envio (nós) — `POST /api/leads/:id/whatsapp/midia`
Hoje grava `texto: '[audio: arquivo.ogg]'`. Passa a gravar:
`tipo`, `media_id` (o id retornado pelo upload), `mime`; `texto` recebe só o caption (ou vazio).

### 2.4 Servir a mídia — endpoint + helper
- `whatsapp.js`: `baixarMidia(mediaId)` → faz `GET /{mediaId}` na Graph API (com `WA_TOKEN`)
  para obter a `url` temporária, baixa essa url com o token e retorna `{ buffer, contentType }`.
- `server.js`: `GET /api/leads/:id/midia/:msgId` (`requireAuth` + `rateLimit`).
  Busca a mensagem, valida que pertence ao lead, chama `baixarMidia(media_id)` e faz stream
  com o `Content-Type` correto e `Cache-Control: private, max-age=86400`.

### 2.5 Render no front — `carregarMensagensChat`
Ramificar por `m.tipo`:
- `text`/nulo → bolha de texto (comportamento atual).
- `audio` → bolha com `<audio controls>`.
- `image`/`sticker` → `<img>` clicável (abre em nova aba/lightbox simples).
- `video` → `<video controls>`.
- `document` → ícone + nome + botão de download.
- Se houver `texto` (caption) junto da mídia, mostrar abaixo.

**Autenticação da mídia (sem token na URL):** o front busca a mídia via `fetch` com header
`Authorization: Bearer`, gera `URL.createObjectURL(blob)` e atribui ao `src`. Cache de object
URLs por `msgId` em um `Map` para não re-baixar.

### 2.6 Render idempotente (pré-requisito do poll de 4s)
`abrirChat` faz poll a cada 4s chamando `carregarMensagensChat(..., silencioso=true)`, que hoje
reconstrói todo o `innerHTML`. Com `<audio>`/`<video>` isso reiniciaria a reprodução.

Correção: calcular uma **assinatura** da lista (ex.: `qtd + último id + último status`). Se a
assinatura não mudou desde o último render, **não** reconstruir o DOM. Só reconstrói quando há
mensagem nova. Mantém o cache de blobs entre renders.

---

## 3. Seletor de emoji

Componente leve, **sem biblioteca externa**, reutilizável:
- Botão 😊 ao lado dos botões de mídia no rodapé do chat.
- Ao clicar, abre um popover com grade de emojis frequentes (algumas categorias: rostos,
  gestos, corações, símbolos comuns de atendimento). Inserir no cursor do `#chat-input`.
- Fechar ao clicar fora ou ao escolher.
- Implementar como função/registro único reaproveitável por qualquer textarea de WhatsApp.

---

## 4. Banner do anúncio no topo do chat

**Bug atual:** no painel de perfil, o HTML do criativo é montado **dentro** do `.then()` de
`/api/anuncios`, que exige role `admin`/`gestor`. Usuários CRC recebem 403 → cai no `.catch`
→ **a imagem nunca aparece** para a equipe CRC. A imagem (`lead.referral_data.image_url`)
já está no lead e é uma URL `https` da CDN da Meta, usável direto em `<img>`.

**Solução:**
- Extrair a montagem do criativo (imagem + headline + body + link) para uma função
  compartilhada `renderCriativoAnuncio(referralData, opts)` que **não depende** de
  `/api/anuncios`.
- Em `abrirChat`, logo abaixo do `#chat-header`, inserir um container de banner preenchido a
  partir de `chatLeadAtual.referral_data` quando houver imagem/headline/body. Compacto
  (imagem com altura limitada), recolhível.
- O painel de perfil passa a usar a mesma função (o nome do catálogo de `/api/anuncios`
  continua como enriquecimento opcional, mas a imagem deixa de depender dele).

---

## 5. Trajeto "Erro 502"

502 é erro de **gateway** (proxy do Easypanel), não o 500 que o endpoint retornaria em
exceção própria — então o handler não está estourando sozinho; a requisição não completou na
camada da aplicação (timeout, restart ou crash de processo).

**Plano de diagnóstico/correção:**
1. Conferir logs do Easypanel/Supabase no momento da chamada de `/api/leads/:id/trajeto`.
2. Hipótese principal: `count: 'exact'` em `lead_eventos` fica caro para leads com muitos
   eventos (agravado pela migração histórica), estourando o timeout do proxy → 502.
3. Mitigação: tornar a contagem barata — usar `{ count: 'planned' }` ou `{ count: 'estimated' }`,
   ou remover o count exato e paginar por "carregar mais" sem total exato.
4. Confirmar pelos logs antes de fechar o item; se for outra causa (ex.: OOM/restart),
   tratar conforme o log.

---

## Estratégia de reuso (resumo)

| Peça | Onde vive | Reutilizada por |
|------|-----------|-----------------|
| Render de mídia + cache de blobs | função no `index.html` (chat) | CRC Lead, Comercial, futuros |
| Endpoint `GET /…/midia/:msgId` + `baixarMidia` | `server.js` / `whatsapp.js` | qualquer canal |
| `parseMensagemRecebida` estendido | `whatsapp.js` | qualquer número/canal |
| Seletor de emoji | função única | qualquer textarea |
| `renderCriativoAnuncio` | função no `index.html` | chat + painel de perfil |

## Testes / verificação
- Áudio recebido: enviar um áudio real de um número de teste → aparece player e toca.
- Áudio enviado: gravar/anexar → aparece player no histórico e toca.
- Imagem/documento: idem.
- Poll: com um áudio tocando, esperar >4s → não reinicia.
- Emoji: inserir no meio do texto, enviar, conferir no WhatsApp do destinatário.
- Banner: abrir lead com `referral_data` (ex.: lead com tag "anúncio") como usuário CRC →
  imagem aparece.
- Desktop warning: abrir no computador → sumiu; no celular nas telas desktop-only → continua.
- Trajeto: abrir aba Trajeto de um lead com muitos eventos → carrega sem 502.

## Deploy
Após `git push`: deploy do CRM via Easypanel (token em CLAUDE.md). `whatsapp.js`/`server.js`
são do CRM Node — não exigem deploy do nf-agente.
