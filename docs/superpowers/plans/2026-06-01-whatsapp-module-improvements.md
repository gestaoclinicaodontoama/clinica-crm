# Melhorias do módulo WhatsApp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o chat de WhatsApp do CRM (CRC Lead + Comercial) utilizável: áudio/imagem/documento tocam de verdade, emoji disponível, banner do anúncio de origem visível, aviso "Melhor no computador" só no celular, e trajeto sem erro 502.

**Architecture:** Chat único (`#page-conversas` em `public/index.html`) servido por `server.js` + `whatsapp.js` (Meta Cloud API, número SDR). Mídia via **proxy**: grava-se `media_id` na tabela `mensagens` e um endpoint autenticado baixa da Graph API sob demanda; o front busca como blob (com Bearer) e usa object URL. Funções de render são compartilhadas para servir os dois módulos e futuros.

**Tech Stack:** Node 18 + Express, Supabase (Postgres), HTML/CSS/JS vanilla, `node:test` para lógica pura.

**Spec:** `docs/superpowers/specs/2026-06-01-whatsapp-module-improvements-design.md`

**Convenções do projeto:**
- Branch de trabalho: `main` (convenção do projeto — push + deploy direto).
- Deploy após push: `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"` (só CRM; não mexe no nf-agente).
- Migrations Supabase via MCP, projeto `mtqdpjhhqzvuklnlfpvi`.
- Testes de lógica pura: `node --test <arquivo>`.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `public/index.html` | CSS do aviso desktop; render de mensagens/mídia; emoji; banner de anúncio | Modify |
| `whatsapp.js` | `parseMensagemRecebida` (extrai mídia) + `baixarMidia` | Modify |
| `whatsapp.test.js` | testes de `parseMensagemRecebida` (mídia) | Create |
| `server.js` | webhook grava mídia; endpoint de envio grava mídia; proxy de mídia; count do trajeto | Modify |
| `supabase/migrations/` | colunas de mídia em `mensagens` | Create (via MCP) |

---

## Task 1: Aviso "Melhor no computador" some no desktop

**Files:**
- Modify: `public/index.html:511` e `public/index.html:523`

- [ ] **Step 1: Remover a regra de dentro do media query**

Em `public/index.html`, dentro do bloco `@media (max-width: 768px)`, a linha 511 hoje é:

```css
  .mnav-desktop-only { display: none; text-align: center; padding: 48px 20px; color: var(--muted); }
```

Substituir por (mantém só os ajustes que fazem sentido no mobile quando o JS o exibe — aparência; o display passa a ser controlado pela regra base + inline do JS):

```css
  /* aparência do aviso quando exibido (JS controla o display) */
  .mnav-desktop-only { text-align: center; padding: 48px 20px; color: var(--muted); }
```

- [ ] **Step 2: Adicionar regra base que esconde por padrão**

A linha 523 hoje é:

```css
.mnav-desktop-only-card { max-width: 340px; margin: 0 auto; background: var(--bg2); border: 1px solid var(--border); border-radius: 14px; padding: 28px 22px; }
```

Inserir **antes** dela uma regra base que esconde o aviso em qualquer viewport (o JS em `setPage` só faz `display:block` inline em mobile nas telas desktop-only):

```css
.mnav-desktop-only { display: none; }
.mnav-desktop-only-card { max-width: 340px; margin: 0 auto; background: var(--bg2); border: 1px solid var(--border); border-radius: 14px; padding: 28px 22px; }
```

- [ ] **Step 3: Verificação manual**

Abrir `https://plataformaama-plataforma.uc5as5.easypanel.host` no computador → o card "Melhor no computador" **não** aparece em nenhuma página. Reduzir a janela para <768px e navegar para "Leads"/"Notas" (telas desktop-only) → o aviso **aparece**.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "fix(whatsapp): aviso 'Melhor no computador' so aparece no mobile"
```

---

## Task 2: Migration — colunas de mídia em `mensagens`

**Files:**
- Create (via MCP Supabase): migration `add_media_cols_mensagens`

- [ ] **Step 1: Conferir estrutura atual**

Via MCP Supabase, rodar `list_tables` (schema `public`) e confirmar que `mensagens` tem ao menos `id, lead_id, direcao, canal, texto, wa_id, criada_em` e **não** tem `tipo/media_id/mime/media_filename`.

- [ ] **Step 2: Aplicar migration**

Via MCP `apply_migration`, name `add_media_cols_mensagens`:

```sql
alter table public.mensagens
  add column if not exists tipo text not null default 'text',
  add column if not exists media_id text,
  add column if not exists mime text,
  add column if not exists media_filename text;

comment on column public.mensagens.tipo is 'text | audio | image | video | document | sticker';
comment on column public.mensagens.media_id is 'ID da midia na Meta Cloud API (proxy sob demanda)';
```

- [ ] **Step 3: Verificar**

Via MCP `list_migrations` confirmar a migration aplicada. Via `execute_sql`:

```sql
select column_name, data_type from information_schema.columns
where table_schema='public' and table_name='mensagens'
  and column_name in ('tipo','media_id','mime','media_filename') order by column_name;
```

Esperado: 4 linhas.

- [ ] **Step 4: Commit** (registro do SQL no repo, se houver pasta de migrations versionada)

Se `supabase/migrations/` versiona SQL localmente, salvar o mesmo SQL em
`supabase/migrations/<timestamp>_add_media_cols_mensagens.sql` e:

```bash
git add supabase/migrations/
git commit -m "feat(whatsapp): colunas de midia em mensagens (tipo/media_id/mime/media_filename)"
```

Se não houver versionamento local de migrations, pular o commit (a migration já está no Supabase).

---

## Task 3: `parseMensagemRecebida` extrai mídia (TDD)

**Files:**
- Modify: `whatsapp.js:98-135`
- Test: `whatsapp.test.js` (Create)

- [ ] **Step 1: Escrever o teste que falha**

Criar `whatsapp.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseMensagemRecebida } = require('./whatsapp');

function body(msg, contact = { profile: { name: 'Paciente' }, wa_id: '5531999990000' }) {
  return { entry: [{ changes: [{ field: 'messages', value: { contacts: [contact], messages: [msg] } }] }] };
}

test('texto continua funcionando', () => {
  const r = parseMensagemRecebida(body({ from: '5531999990000', id: 'wamid.1', type: 'text', timestamp: '1', text: { body: 'oi' } }));
  assert.strictEqual(r.tipo, 'text');
  assert.strictEqual(r.texto, 'oi');
  assert.strictEqual(r.media_id, '');
});

test('audio extrai media_id e mime', () => {
  const r = parseMensagemRecebida(body({ from: '5531999990000', id: 'wamid.2', type: 'audio', timestamp: '2', audio: { id: 'MEDIA_AUD', mime_type: 'audio/ogg; codecs=opus' } }));
  assert.strictEqual(r.tipo, 'audio');
  assert.strictEqual(r.media_id, 'MEDIA_AUD');
  assert.strictEqual(r.mime, 'audio/ogg; codecs=opus');
  assert.strictEqual(r.texto, '');
});

test('image extrai media_id e usa caption como texto', () => {
  const r = parseMensagemRecebida(body({ from: '5531999990000', id: 'wamid.3', type: 'image', timestamp: '3', image: { id: 'MEDIA_IMG', mime_type: 'image/jpeg', caption: 'minha foto' } }));
  assert.strictEqual(r.tipo, 'image');
  assert.strictEqual(r.media_id, 'MEDIA_IMG');
  assert.strictEqual(r.texto, 'minha foto');
});

test('document extrai filename', () => {
  const r = parseMensagemRecebida(body({ from: '5531999990000', id: 'wamid.4', type: 'document', timestamp: '4', document: { id: 'MEDIA_DOC', mime_type: 'application/pdf', filename: 'exame.pdf' } }));
  assert.strictEqual(r.tipo, 'document');
  assert.strictEqual(r.media_id, 'MEDIA_DOC');
  assert.strictEqual(r.media_filename, 'exame.pdf');
});

test('sticker extrai media_id', () => {
  const r = parseMensagemRecebida(body({ from: '5531999990000', id: 'wamid.5', type: 'sticker', timestamp: '5', sticker: { id: 'MEDIA_STK', mime_type: 'image/webp' } }));
  assert.strictEqual(r.tipo, 'sticker');
  assert.strictEqual(r.media_id, 'MEDIA_STK');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test whatsapp.test.js`
Esperado: FAIL (os campos `tipo/media_id/mime/media_filename` ainda não existem no retorno).

- [ ] **Step 3: Implementar a extração de mídia**

Em `whatsapp.js`, dentro de `parseMensagemRecebida`, **após** a linha
`const referral = msg.referral || null;` e **antes** do `return {`, inserir:

```js
    // Mídia: WhatsApp manda o conteúdo conforme msg.type (audio/image/video/document/sticker)
    const tipo = msg.type || 'text';
    const midiaObj = (tipo !== 'text' && msg[tipo]) ? msg[tipo] : null;
    const media_id = midiaObj?.id || '';
    const mime = midiaObj?.mime_type || '';
    const media_filename = msg.document?.filename || '';
    const caption = msg.image?.caption || msg.video?.caption || msg.document?.caption || '';
```

Depois, no objeto retornado, alterar a linha do `texto` e acrescentar os campos. A linha atual:

```js
      texto: msg.text?.body || msg.button?.text || '',
      tipo: msg.type,
```

passa a ser:

```js
      texto: msg.text?.body || msg.button?.text || caption || '',
      tipo,
      media_id,
      mime,
      media_filename,
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test whatsapp.test.js`
Esperado: PASS (5 testes).

- [ ] **Step 5: Garantir que nada quebrou nos testes existentes**

Run: `node --test lib/funil/*.test.js whatsapp.test.js`
Esperado: todos PASS.

- [ ] **Step 6: Commit**

```bash
git add whatsapp.js whatsapp.test.js
git commit -m "feat(whatsapp): parseMensagemRecebida extrai midia (audio/image/video/document/sticker)"
```

---

## Task 4: Webhook grava campos de mídia

**Files:**
- Modify: `server.js:1608-1611`

- [ ] **Step 1: Incluir os campos no insert do webhook**

Em `server.js`, no handler `POST /webhooks/whatsapp`, o insert atual é:

```js
      await supabase.from('mensagens').insert({
        lead_id: lead.id, direcao: 'recebida', canal: 'sdr',
        texto: sanitizeStr(m.texto, 4000), wa_id: m.id || '',
      });
```

Substituir por:

```js
      await supabase.from('mensagens').insert({
        lead_id: lead.id, direcao: 'recebida', canal: 'sdr',
        texto: sanitizeStr(m.texto, 4000), wa_id: m.id || '',
        tipo: m.tipo || 'text',
        media_id: m.media_id || null,
        mime: m.mime ? sanitizeStr(m.mime, 120) : null,
        media_filename: m.media_filename ? sanitizeStr(m.media_filename, 200) : null,
      });
```

- [ ] **Step 2: Verificação (estática)**

Run: `node -e "require('./server.js')" ` **NÃO** — `server.js` sobe servidor. Em vez disso, conferir sintaxe:
Run: `node --check server.js`
Esperado: sem erro (exit 0).

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(whatsapp): webhook grava tipo/media_id/mime das mensagens recebidas"
```

---

## Task 5: Endpoint de envio grava mídia em vez de texto-placeholder

**Files:**
- Modify: `server.js:1234-1238`

- [ ] **Step 1: Gravar tipo/media_id/mime no insert de envio**

Em `server.js`, no handler `POST /api/leads/:id/whatsapp/midia`, o trecho atual é:

```js
    const textoLog = caption || `[${tipo}: ${sanitizeStr(originalname, 100)}]`;
    await supabase.from('mensagens').insert({
      lead_id: lead.id, direcao: 'enviada', canal: 'sdr',
      texto: textoLog, wa_id: resultado.messages?.[0]?.id || '',
    });
```

Substituir por:

```js
    await supabase.from('mensagens').insert({
      lead_id: lead.id, direcao: 'enviada', canal: 'sdr',
      texto: caption || '', wa_id: resultado.messages?.[0]?.id || '',
      tipo, media_id: mediaId, mime: sanitizeStr(mimetype, 120),
      media_filename: tipo === 'document' ? sanitizeStr(originalname, 200) : null,
    });
```

- [ ] **Step 2: Verificação (estática)**

Run: `node --check server.js`
Esperado: exit 0.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(whatsapp): envio de midia grava media_id/tipo em vez de texto-placeholder"
```

---

## Task 6: `baixarMidia` + proxy `GET /api/leads/:id/midia/:msgId`

**Files:**
- Modify: `whatsapp.js` (nova função + export)
- Modify: `server.js` (novo endpoint, perto de `GET /api/leads/:id/mensagens` ~1249)

- [ ] **Step 1: Helper `baixarMidia` no `whatsapp.js`**

Em `whatsapp.js`, antes de `// --------- VERIFY TOKEN`, adicionar:

```js
// Baixa mídia recebida/enviada pelo media_id (proxy sob demanda).
// Passo 1: GET /{mediaId} → retorna { url, mime_type }. Passo 2: baixar a url com o token.
async function baixarMidia(mediaId) {
  if (!temToken()) throw new Error('WhatsApp Cloud API não configurada');
  const meta = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${WA_TOKEN}` },
  });
  const info = await meta.json();
  if (info.error) throw new Error(info.error.message);
  if (!info.url) throw new Error('Mídia sem URL (expirada?)');
  const bin = await fetch(info.url, { headers: { 'Authorization': `Bearer ${WA_TOKEN}` } });
  if (!bin.ok) throw new Error('Falha ao baixar mídia: HTTP ' + bin.status);
  const arrayBuf = await bin.arrayBuffer();
  return { buffer: Buffer.from(arrayBuf), contentType: info.mime_type || bin.headers.get('content-type') || 'application/octet-stream' };
}
```

E no `module.exports`, adicionar `baixarMidia,`.

- [ ] **Step 2: Endpoint proxy no `server.js`**

Em `server.js`, logo **após** o handler `GET /api/leads/:id/mensagens` (termina ~1258), inserir:

```js
app.get('/api/leads/:id/midia/:msgId', requireAuth, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const msgId = parseInt(req.params.msgId, 10);
    if (Number.isNaN(id) || Number.isNaN(msgId)) return res.status(400).json({ error: 'ID inválido' });
    const { data: msg } = await supabase.from('mensagens')
      .select('id, lead_id, media_id, mime').eq('id', msgId).maybeSingle();
    if (!msg || msg.lead_id !== id) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (!msg.media_id) return res.status(404).json({ error: 'Mensagem sem mídia' });
    const { buffer, contentType } = await whatsapp.baixarMidia(msg.media_id);
    res.set('Content-Type', msg.mime || contentType);
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(buffer);
  } catch (e) {
    console.error('❌ wa midia download:', e.message);
    res.status(502).json({ error: e.message });
  }
});
```

- [ ] **Step 3: Verificação (estática)**

Run: `node --check server.js && node --check whatsapp.js`
Esperado: exit 0 em ambos.

- [ ] **Step 4: Commit**

```bash
git add whatsapp.js server.js
git commit -m "feat(whatsapp): proxy de midia (baixarMidia + GET /api/leads/:id/midia/:msgId)"
```

---

## Task 7: Front — render de mídia + cache de blobs + poll idempotente

**Files:**
- Modify: `public/index.html` — função `carregarMensagensChat` (2889-2908) e variáveis de estado do chat (perto de `chatLeadAtual` ~2351)

- [ ] **Step 1: Adicionar estado de cache e helpers de mídia**

Perto da declaração `let chatLeadAtual = null;` (linha ~2351), adicionar:

```js
let _chatMsgsSig = '';        // assinatura do último render (idempotência do poll)
const _midiaCache = new Map(); // msgId -> objectURL já baixado
```

E adicionar, logo antes de `async function carregarMensagensChat`, dois helpers:

```js
// Baixa a mídia da mensagem com Bearer e devolve um objectURL (com cache por msgId).
async function _midiaUrlChat(leadId, msgId) {
  if (_midiaCache.has(msgId)) return _midiaCache.get(msgId);
  const token = (_sbSession && _sbSession.access_token) || '';
  const r = await fetch(`/api/leads/${leadId}/midia/${msgId}`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const url = URL.createObjectURL(await r.blob());
  _midiaCache.set(msgId, url);
  return url;
}

// Monta o HTML interno de uma mensagem conforme o tipo. Mídia carrega depois (lazy) via data-midia.
function _bolhaMsgHtml(m) {
  const caption = m.texto ? `<div style="margin-top:4px">${escHtml(m.texto).replace(/\n/g,'<br>')}</div>` : '';
  const t = m.tipo || 'text';
  if (t === 'audio') return `<audio controls preload="none" data-midia="${m.id}" style="width:230px;max-width:100%"></audio>${caption}`;
  if (t === 'image' || t === 'sticker') return `<img data-midia="${m.id}" alt="imagem" style="max-width:220px;max-height:240px;border-radius:8px;cursor:pointer;display:block" onclick="if(this.src)window.open(this.src,'_blank')">${caption}`;
  if (t === 'video') return `<video controls preload="none" data-midia="${m.id}" style="max-width:240px;max-height:260px;border-radius:8px;display:block"></video>${caption}`;
  if (t === 'document') return `<a href="#" data-midia="${m.id}" data-fname="${escHtml(m.media_filename||'arquivo')}" style="display:inline-flex;align-items:center;gap:8px;color:inherit;text-decoration:none">📎 <span style="text-decoration:underline">${escHtml(m.media_filename||'arquivo')}</span></a>${caption}`;
  // texto / desconhecido
  return `${escHtml(m.texto).replace(/\n/g,'<br>')}`;
}
```

- [ ] **Step 2: Reescrever `carregarMensagensChat` (idempotente + mídia)**

Substituir a função inteira (2889-2908) por:

```js
async function carregarMensagensChat(leadId, silencioso = false) {
  try {
    const msgs = await api(`/api/leads/${leadId}/mensagens`);
    const el = document.getElementById('chat-msgs');
    // Assinatura: se nada mudou, não reconstrói (não interrompe áudio/vídeo tocando).
    const sig = leadId + ':' + msgs.length + ':' + (msgs[msgs.length-1]?.id || 0);
    if (silencioso && sig === _chatMsgsSig) return;
    _chatMsgsSig = sig;
    const atFundo = el.scrollHeight - el.scrollTop <= el.clientHeight + 60;
    if (!msgs.length) {
      el.innerHTML = '<div class="empty-small" style="text-align:center;padding:30px">Nenhuma mensagem ainda.<br>Digite abaixo para iniciar a conversa.</div>';
      return;
    }
    el.innerHTML = msgs.map(m => `
      <div class="msg-wrap ${m.direcao === 'recebida' ? 'in' : 'out'}">
        <div class="msg-bubble ${m.direcao === 'recebida' ? 'in' : 'out'}">${_bolhaMsgHtml(m)}</div>
        <div class="msg-time">${_brt(m.criada_em)}</div>
      </div>
    `).join('');
    // Carrega as mídias (lazy) após inserir o HTML.
    el.querySelectorAll('[data-midia]').forEach(node => {
      const mid = node.getAttribute('data-midia');
      _midiaUrlChat(leadId, mid).then(url => {
        if (node.tagName === 'A') { node.href = url; node.setAttribute('download', node.getAttribute('data-fname') || 'arquivo'); }
        else { node.src = url; }
      }).catch(() => {
        if (node.tagName === 'A') node.innerHTML = '⚠️ mídia indisponível';
        else node.outerHTML = '<span style="font-size:12px;color:var(--muted)">⚠️ mídia indisponível</span>';
      });
    });
    if (!silencioso || atFundo) el.scrollTop = el.scrollHeight;
  } catch(e) {
    if (!silencioso) toast('❌ Erro ao carregar mensagens: ' + e.message, true);
  }
}
```

- [ ] **Step 3: Resetar assinatura ao trocar de conversa**

Em `abrirChat` (linha ~2856), logo após `chatLeadAtual = chatLeads.find(...)`, adicionar para forçar render ao abrir:

```js
  _chatMsgsSig = '';
```

- [ ] **Step 4: Verificação manual (após deploy — ver Task 11)**

1. Paciente envia áudio → aparece player e toca.
2. Gravar/anexar áudio nosso → aparece player no histórico.
3. Imagem/documento (enviado e recebido) → imagem mostra, documento baixa.
4. Com um áudio tocando, aguardar >4s (poll) → **não** reinicia.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(whatsapp): render de audio/imagem/documento no chat + poll idempotente com cache de midia"
```

---

## Task 8: Seletor de emoji

**Files:**
- Modify: `public/index.html` — botão no rodapé (~804) + função do picker (perto de `enviarMensagemChat` ~2910)

- [ ] **Step 1: Adicionar o botão de emoji no rodapé do chat**

Em `public/index.html`, na barra de botões do chat, **antes** do botão `🖼️` (linha ~804), inserir:

```html
                <button class="btn btn-ghost" id="btn-emoji" onclick="toggleEmojiPicker(event)" style="height:34px;font-size:16px;padding:0 10px;position:relative" title="Emoji">😊</button>
```

- [ ] **Step 2: Implementar o picker (vanilla, reutilizável)**

Perto de `async function enviarMensagemChat()` (linha ~2910), adicionar:

```js
const _EMOJIS = ['😀','😁','😂','🤣','😊','😍','😘','😅','😉','🙂','😎','🤩','🥳','🤗','🤔','😐','😴','😢','😭','😡','👍','👎','👏','🙏','🙌','💪','👋','🤝','✌️','🤞','❤️','🧡','💛','💚','💙','💜','🔥','✨','⭐','🎉','✅','❌','⚠️','📌','📅','📞','💬','💰','🦷','😬','🥰'];
let _emojiPickerEl = null;

function toggleEmojiPicker(ev) {
  ev.stopPropagation();
  if (_emojiPickerEl) { _emojiPickerEl.remove(); _emojiPickerEl = null; return; }
  const btn = document.getElementById('btn-emoji');
  const box = document.createElement('div');
  box.id = 'emoji-picker';
  box.style.cssText = 'position:absolute;bottom:42px;left:0;z-index:200;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,.25);display:grid;grid-template-columns:repeat(8,1fr);gap:2px;width:300px;max-height:200px;overflow-y:auto';
  box.innerHTML = _EMOJIS.map(e => `<button type="button" style="background:none;border:none;font-size:20px;cursor:pointer;padding:4px;border-radius:6px" onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background='none'" onclick="inserirEmoji('${e}')">${e}</button>`).join('');
  btn.appendChild(box);
  _emojiPickerEl = box;
  // Fecha ao clicar fora
  setTimeout(() => document.addEventListener('click', _fecharEmojiFora), 0);
}

function _fecharEmojiFora(e) {
  if (_emojiPickerEl && !_emojiPickerEl.contains(e.target) && e.target.id !== 'btn-emoji') {
    _emojiPickerEl.remove(); _emojiPickerEl = null;
    document.removeEventListener('click', _fecharEmojiFora);
  }
}

function inserirEmoji(e) {
  const input = document.getElementById('chat-input');
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + e + input.value.slice(end);
  input.focus();
  const pos = start + e.length;
  input.setSelectionRange(pos, pos);
  if (typeof autoResizeChat === 'function') autoResizeChat(input);
}
```

- [ ] **Step 3: Verificação manual (após deploy)**

Abrir uma conversa → clicar 😊 → escolher emoji no meio de um texto → ele entra na posição do cursor → enviar → conferir no WhatsApp do destinatário. Clicar fora fecha o picker.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(whatsapp): seletor de emoji no campo de mensagem"
```

---

## Task 9: Banner do anúncio no topo do chat + `renderCriativoAnuncio` compartilhada

**Files:**
- Modify: `public/index.html` — container do banner (~793), função compartilhada, uso em `abrirChat` (~2877) e no painel de perfil (~2660-2690)

- [ ] **Step 1: Adicionar o container do banner abaixo do header**

Em `public/index.html`, logo **após** a linha 793 (`<div class="chat-header" id="chat-header"></div>`), inserir:

```html
        <div id="chat-anuncio-banner" style="display:none"></div>
```

- [ ] **Step 2: Criar a função compartilhada `renderCriativoAnuncio`**

Perto do `_initPainel` (a lógica do painel-anuncio ~2633), adicionar uma função pura que monta o criativo **sem** depender de `/api/anuncios`:

```js
// Monta o HTML do criativo do anúncio a partir de referral_data (CTWA). Compartilhado: chat + perfil.
function renderCriativoAnuncio(referralData, opts = {}) {
  const rd = referralData || {};
  const _esc = s => String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const _safeUrl = u => (typeof u === 'string' && /^https?:\/\//i.test(u)) ? u : '';
  const img = _safeUrl(rd.image_url) || _safeUrl(rd.thumbnail_url) || '';
  if (!img && !rd.headline && !rd.body) return '';
  const link = _safeUrl(rd.source_url);
  const maxH = opts.compact ? 120 : 160;
  return `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin:${opts.compact?'8px 12px':'0 0 8px'}">
    ${img ? `<img src="${_esc(img)}" alt="anúncio" style="width:100%;display:block;max-height:${maxH}px;object-fit:cover" loading="lazy">` : ''}
    ${(rd.headline || rd.body) ? `<div style="padding:8px">
      ${opts.compact ? '<div style="font-size:10px;color:var(--muted);font-weight:600;margin-bottom:2px">📍 VEIO DESTE ANÚNCIO</div>' : ''}
      ${rd.headline ? `<div style="font-size:11.5px;font-weight:600;line-height:1.3;margin-bottom:2px">${_esc(rd.headline)}</div>` : ''}
      ${rd.body ? `<div style="font-size:11px;color:var(--muted);line-height:1.35">${_esc(rd.body).slice(0,140)}</div>` : ''}
    </div>` : ''}
    ${link ? `<a href="${_esc(link)}" target="_blank" rel="noopener" style="display:block;padding:6px 8px;font-size:10.5px;color:var(--accent);border-top:1px solid var(--border)">🔗 ver anúncio original ↗</a>` : ''}
  </div>`;
}
```

- [ ] **Step 3: Preencher o banner em `abrirChat`**

Em `abrirChat`, após `_initPainel(chatLeadAtual);` (linha ~2880), inserir:

```js
  const _bannerEl = document.getElementById('chat-anuncio-banner');
  if (_bannerEl) {
    const _bannerHtml = renderCriativoAnuncio(chatLeadAtual.referral_data, { compact: true });
    _bannerEl.innerHTML = _bannerHtml;
    _bannerEl.style.display = _bannerHtml ? 'block' : 'none';
  }
```

- [ ] **Step 4: Reaproveitar a função no painel de perfil (corrige imagem some p/ CRC)**

No bloco do painel-anuncio (~2660-2677), o criativo hoje é montado **dentro** do `.then(/api/anuncios)`. Mover a montagem da imagem para fora dessa dependência: substituir o trecho que começa em
`const rd = lead.referral_data || {};` e vai até o fechamento de `criativoHtml` (a linha
`el.innerHTML = criativoHtml + ...`) de modo que `criativoHtml` use a função nova **antes** do `.then`:

Trocar (dentro do `if (el && temAnuncio) {`, **antes** do `api('/api/anuncios')`):

```js
    const criativoHtmlBase = renderCriativoAnuncio(lead.referral_data, { compact: false });
```

E dentro do `.then`, substituir a construção de `criativoHtml` por uso de `criativoHtmlBase`:

```js
      el.innerHTML = criativoHtmlBase + `<div id="painel-anuncio-thumb"></div>` + linkHtml + badge;
```

E no `.catch` final do `/api/anuncios`, garantir que a imagem ainda apareça:

```js
    }).catch(() => {
      el.innerHTML = criativoHtmlBase + `<span style="word-break:break-all">${_esc(lead.campanha || 'Anúncio')}</span>` + badge;
    });
```

(Remover a antiga construção inline de `criativoHtml`/`imgReferral`/`_safeUrl` que vivia dentro do `.then`, já coberta por `renderCriativoAnuncio`.)

- [ ] **Step 5: Resetar o banner ao fechar conversa**

Em `voltarListaChat` (buscar a função; ela esconde `chat-window`), adicionar:

```js
  const _b = document.getElementById('chat-anuncio-banner'); if (_b) _b.style.display = 'none';
```

- [ ] **Step 6: Verificação manual (após deploy)**

Como usuário **CRC** (não admin), abrir um lead com tag "anúncio" (ex.: "Luiz Martins Tutuka") → banner com imagem do criativo aparece no topo do chat. Abrir a aba de perfil → imagem também aparece (antes não aparecia para CRC). Abrir um lead sem anúncio → sem banner.

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "feat(whatsapp): banner do anuncio no topo do chat + renderCriativoAnuncio compartilhada (corrige imagem oculta p/ CRC)"
```

---

## Task 10: Trajeto — eliminar o 502

**Files:**
- Modify: `server.js:3895-3899`

- [ ] **Step 1: Diagnóstico via logs**

Reproduzir abrindo a aba "Trajeto" de um lead com muitos eventos. Em paralelo, via MCP Supabase `get_logs` (service `api`/`postgres`) e/ou logs do Easypanel, observar o que ocorre na chamada `GET /api/leads/:id/trajeto`. Registrar a causa observada (timeout do count, restart/OOM, etc.).

- [ ] **Step 2: Tornar a contagem barata (mitigação principal)**

Em `server.js`, no handler `/api/leads/:id/trajeto`, a query atual:

```js
    const { data, error, count } = await supabase.from('lead_eventos')
      .select('*', { count: 'exact' })
      .eq('lead_id', id)
      .order('criado_em', { ascending: false })
      .range(offset, offset + limit - 1);
```

Substituir `count: 'exact'` por `count: 'planned'` (estimativa do planner, não varre a tabela):

```js
    const { data, error, count } = await supabase.from('lead_eventos')
      .select('*', { count: 'planned' })
      .eq('lead_id', id)
      .order('criado_em', { ascending: false })
      .range(offset, offset + limit - 1);
```

O front usa `total` só para decidir mostrar "Carregar mais"; uma estimativa serve. Se o log do Step 1 indicar outra causa (ex.: restart por memória), tratar conforme o log e anotar aqui.

- [ ] **Step 3: Verificação (estática)**

Run: `node --check server.js`
Esperado: exit 0.

- [ ] **Step 4: Verificação manual (após deploy)**

Abrir a aba "Trajeto" no perfil de um lead com muitos eventos → carrega a timeline sem "Erro 502". "Carregar mais" continua funcionando.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "fix(whatsapp): trajeto usa count planned para evitar timeout/502 em leads com muitos eventos"
```

---

## Task 11: Deploy e verificação ponta a ponta

**Files:** nenhum (operacional)

- [ ] **Step 1: Push**

```bash
git push origin main
```

- [ ] **Step 2: Deploy do CRM no Easypanel**

```bash
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

Aguardar o redeploy concluir.

- [ ] **Step 3: Checklist de verificação no app (logado)**

- [ ] Desktop: aviso "Melhor no computador" sumiu; mobile (telas desktop-only) ainda mostra.
- [ ] Áudio recebido do paciente: player aparece e toca.
- [ ] Áudio enviado (gravado e anexado): player aparece e toca.
- [ ] Imagem recebida/enviada: aparece; documento: baixa.
- [ ] Áudio tocando + esperar >4s: não reinicia.
- [ ] Emoji: insere no cursor; envia ok; fecha ao clicar fora.
- [ ] Banner do anúncio (como usuário CRC): imagem no topo do chat + na aba de perfil.
- [ ] Trajeto: abre sem 502, "Carregar mais" funciona.

- [ ] **Step 4: Atualizar memória**

Atualizar `pending_tests.md` (memória) removendo itens resolvidos e registrando o que ficou pendente de validação no celular/produção.

---

## Self-Review (resultado)

- **Cobertura do spec:** itens 1–5 cobertos (Tasks 1, 2–7, 8, 9, 10); adjacências (poll idempotente, imagem/documento) em Task 7. Não-objetivos respeitados (sem status ✓✓, sem bucket).
- **Sem placeholders:** todos os steps com código/comando reais.
- **Consistência de tipos/nomes:** `tipo/media_id/mime/media_filename` idênticos em migration, parse, webhook, envio, proxy e render; `_midiaUrlChat`, `_bolhaMsgHtml`, `renderCriativoAnuncio`, `_chatMsgsSig`, `_midiaCache` usados de forma consistente.
- **Ordem:** migration (Task 2) antes de gravar/ler colunas; `baixarMidia` (Task 6) antes do render (Task 7).
