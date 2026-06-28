// ============================================================
//  INTEGRAÇÃO WHATSAPP CLOUD API (Meta)
//  Número 1 (conversas/SDR): WHATSAPP_API_TOKEN + WHATSAPP_PHONE_NUMBER_ID
//  Número 2 (broadcast/templates): WHATSAPP_BROADCAST_TOKEN + WHATSAPP_BROADCAST_PHONE_ID
// ============================================================

// Número 1 — conversas livres da SDR
const WA_TOKEN    = process.env.WHATSAPP_API_TOKEN || process.env.WHATSAPP_CLOUD_TOKEN || '';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';

// Número 2 — disparos de templates (se não configurado, usa o número 1 como fallback)
const WA_BROADCAST_TOKEN    = process.env.WHATSAPP_BROADCAST_TOKEN || WA_TOKEN;
const WA_BROADCAST_PHONE_ID = process.env.WHATSAPP_BROADCAST_PHONE_ID || WA_PHONE_ID;

const WA_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const WA_API_VERSION  = 'v21.0';

function temToken()      { return !!(WA_TOKEN && WA_PHONE_ID); }
function temBroadcast()  { return !!(WA_BROADCAST_TOKEN && WA_BROADCAST_PHONE_ID); }

// Token correto para cada número: o número de broadcast pode ter token próprio
function _tokenForPhone(phoneId) {
  return phoneId === WA_BROADCAST_PHONE_ID ? WA_BROADCAST_TOKEN : WA_TOKEN;
}

function limparNumero(num) {
  let n = String(num || '').replace(/\D/g, '');
  // Números brasileiros sem DDI: 10 dígitos (DDD+8) ou 11 dígitos (DDD+9)
  // WhatsApp Cloud API exige formato internacional: 553XXXXXXXXX ou 5531XXXXXXXXX
  if ((n.length === 10 || n.length === 11) && !n.startsWith('55')) n = '55' + n;
  return n;
}

// Erros transitórios da Meta: code 1 (unknown), 2 (service temporarily unavailable),
// 130429 (throughput) e HTTP 5xx. Ex.: "An unexpected error has occurred. Please retry
// your request later." (code 2) — falha do lado da Meta, reenviar resolve.
const _TRANSIENT_CODES = new Set([1, 2, 130429]);
const _RETRY_DELAYS_MS = [1000, 3000];
const MSG_META_INSTAVEL = 'Instabilidade temporária no WhatsApp (Meta) — tente novamente em instantes.';

function _erroMeta(error, httpStatus) {
  const transient = _TRANSIENT_CODES.has(error.code) || httpStatus >= 500;
  const e = new Error(transient ? MSG_META_INSTAVEL : error.message);
  e.code = error.code;
  e.transient = transient;
  e.metaMessage = error.message;
  return e;
}

async function _comRetry(fn) {
  for (let tentativa = 0; ; tentativa++) {
    try { return await fn(); }
    catch (e) {
      if (!e.transient || tentativa >= _RETRY_DELAYS_MS.length) throw e;
      console.warn(`⚠️ Meta transitório (code ${e.code}), retry ${tentativa + 1}/${_RETRY_DELAYS_MS.length}: ${e.metaMessage}`);
      await new Promise(r => setTimeout(r, _RETRY_DELAYS_MS[tentativa]));
    }
  }
}

async function _post(phoneId, token, payload) {
  return _comRetry(async () => {
    const r = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (data.error) throw _erroMeta(data.error, r.status);
    if (!r.ok) throw _erroMeta({ message: 'HTTP ' + r.status }, r.status);
    return data;
  });
}

// Número 1 — texto livre (SDR, janela de 24h)
// phoneNumberId opcional: usa o número que recebeu a mensagem do lead (multi-número)
// contextWaId opcional: wamid da mensagem sendo respondida (reply)
async function enviarTexto({ para, texto, phoneNumberId, contextWaId }) {
  if (!temToken()) throw new Error('WhatsApp Cloud API não configurada');
  const pid = phoneNumberId || WA_PHONE_ID;
  const payload = {
    messaging_product: 'whatsapp', to: limparNumero(para),
    type: 'text', text: { body: texto },
  };
  if (contextWaId) payload.context = { message_id: contextWaId };
  return _post(pid, _tokenForPhone(pid), payload);
}

// Número 2 — template aprovado (broadcast, fora da janela)
// phoneNumberId opcional: dispara por outro número configurado (ex.: 2873).
// Sem ele, usa o número de broadcast padrão (8700).
async function enviarBroadcast({ para, templateName, lang = 'pt_BR', variaveis = [], phoneNumberId }) {
  const pid = phoneNumberId || WA_BROADCAST_PHONE_ID;
  const token = _tokenForPhone(pid);
  if (!pid || !token) throw new Error('Número de envio (template) não configurado');
  const numero = limparNumero(para);
  return _post(pid, token, {
    messaging_product: 'whatsapp', to: numero,
    type: 'template',
    template: {
      name: templateName,
      language: { code: lang },
      ...(variaveis.length > 0 && {
        components: [{ type: 'body', parameters: variaveis.map(v => ({ type: 'text', text: String(v) })) }],
      }),
    },
  });
}

// Mantém compatibilidade — enviarTemplate usa o número 2 (broadcast)
async function enviarTemplate(opts) { return enviarBroadcast(opts); }

// Apaga mensagem para todos (dentro da janela permitida pela Meta)
async function deletarMensagem({ phoneNumberId, waId }) {
  if (!temToken()) throw new Error('WhatsApp Cloud API não configurada');
  const pid = phoneNumberId || WA_PHONE_ID;
  const r = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${pid}/messages`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${_tokenForPhone(pid)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', message_id: waId }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

// Upload de mídia → retorna media_id
// phoneNumberId: deve ser o MESMO número usado para enviar a mídia (media_id é vinculado ao phone)
async function uploadMidia({ buffer, mimetype, filename, phoneNumberId }) {
  if (!temToken()) throw new Error('WhatsApp Cloud API não configurada');
  const pid = phoneNumberId || WA_PHONE_ID;
  return _comRetry(async () => {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([buffer], { type: mimetype }), filename);
    const r = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${pid}/media`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${_tokenForPhone(pid)}` },
      body: form,
    });
    const data = await r.json().catch(() => ({}));
    if (data.error) throw _erroMeta(data.error, r.status);
    if (!r.ok) throw _erroMeta({ message: 'HTTP ' + r.status }, r.status);
    return data.id;
  });
}

// Envio de mensagem com mídia já carregada (media_id)
async function enviarMidia({ para, mediaId, tipo, caption, phoneNumberId }) {
  const pid = phoneNumberId || WA_PHONE_ID;
  const payload = {
    messaging_product: 'whatsapp', to: limparNumero(para),
    type: tipo,
    [tipo]: { id: mediaId, ...(caption ? { caption } : {}) },
  };
  return _post(pid, _tokenForPhone(pid), payload);
}

// Baixa mídia recebida/enviada pelo media_id (proxy sob demanda).
// Passo 1: GET /{mediaId} → retorna { url, mime_type }. Passo 2: baixar a url com o token.
async function baixarMidia(mediaId) {
  if (!temToken()) throw new Error('WhatsApp Cloud API não configurada');
  const timeout = () => AbortSignal.timeout(10_000);
  const meta = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${WA_TOKEN}` },
    signal: timeout(),
  });
  const info = await meta.json();
  if (info.error) throw new Error(info.error.message);
  if (!info.url) throw new Error('Mídia sem URL (expirada?)');
  const bin = await fetch(info.url, { headers: { 'Authorization': `Bearer ${WA_TOKEN}` }, signal: timeout() });
  if (!bin.ok) throw new Error('Falha ao baixar mídia: HTTP ' + bin.status);
  const arrayBuf = await bin.arrayBuffer();
  return { buffer: Buffer.from(arrayBuf), contentType: info.mime_type || bin.headers.get('content-type') || 'application/octet-stream' };
}

// --------- VERIFY TOKEN para webhook ----------
function verifyToken() {
  if (!WA_VERIFY_TOKEN) console.warn('⚠️  WHATSAPP_VERIFY_TOKEN não configurado — configure esta variável de ambiente');
  return WA_VERIFY_TOKEN;
}

// --------- PARSE de mensagem recebida via webhook ----------
function parseMensagemRecebida(body) {
  try {
    const change = body?.entry?.[0]?.changes?.[0];
    if (change?.field !== 'messages') return null;
    const v = change.value;
    const msg = v?.messages?.[0];
    if (!msg) return null;
    const contato = v?.contacts?.[0];
    // Anúncios CTWA (Click-to-WhatsApp): Meta inclui referral com ctwa_clid
    const referral = msg.referral || null;
    // Mídia: WhatsApp manda o conteúdo conforme msg.type (audio/image/video/document/sticker)
    const tipo = msg.type || 'text';
    const midiaObj = (tipo !== 'text' && msg[tipo]) ? msg[tipo] : null;
    const media_id = midiaObj?.id || '';
    const mime = midiaObj?.mime_type || '';
    const media_filename = msg.document?.filename || '';
    const caption = msg.image?.caption || msg.video?.caption || msg.document?.caption || '';
    return {
      from: msg.from,
      nome: contato?.profile?.name || '',
      texto: msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || caption || '',
      tipo,
      media_id,
      mime,
      media_filename,
      timestamp: msg.timestamp,
      id: msg.id,
      phone_number_id: v?.metadata?.phone_number_id || '',
      ctwa_clid:   referral?.ctwa_clid  || '',
      ad_id:       referral?.source_id  || '',   // ID do anúncio no Meta Ads
      source_type: referral?.source_type || '',  // 'ad' | 'post' | etc
      // Criativo do anúncio que o lead viu antes de clicar (CTWA traz tudo isso)
      referral_data: referral ? {
        source_url:    referral.source_url    || '',
        source_id:     referral.source_id     || '',
        source_type:   referral.source_type   || '',
        headline:      referral.headline      || '',
        body:          referral.body          || '',
        media_type:    referral.media_type    || '',
        image_url:     referral.image_url     || '',
        video_url:     referral.video_url     || '',
        thumbnail_url: referral.thumbnail_url || '',
        capturado_em:  new Date().toISOString(),
      } : null,
    };
  } catch (e) {
    return null;
  }
}

// --------- PARSE de status de entrega via webhook ----------
// A Meta envia statuses (sent/delivered/read/failed) no mesmo webhook de messages.
// "failed" é a ÚNICA forma de saber que uma mensagem aceita pela API foi descartada
// (ex.: erro 131047 — fora da janela de 24h; 131026 — número sem WhatsApp).
function parseStatuses(body) {
  try {
    const change = body?.entry?.[0]?.changes?.[0];
    if (change?.field !== 'messages') return [];
    const sts = change.value?.statuses;
    if (!Array.isArray(sts)) return [];
    return sts.map(s => {
      const e = s.errors?.[0];
      const erro = e ? [(e.code ? String(e.code) : ''), (e.title || e.message || ''), (e.error_data?.details || '')]
        .filter(Boolean).join(' — ') : '';
      return { wa_id: s.id || '', status: s.status || '', erro };
    }).filter(s => s.wa_id && ['sent', 'delivered', 'read', 'failed'].includes(s.status));
  } catch {
    return [];
  }
}

// --------- DIAGNÓSTICO: eventos de webhook hoje descartados ----------
// A rota só trata mensagem recebida (value.messages) e status (value.statuses).
// Qualquer outro change cai aqui: é onde a Meta entrega os ECOS do agente/app
// (smb_message_echoes / message_echoes) e eventos do Meta Business Agent. Coleta
// esses changes p/ descobrir, empiricamente, se a IA já chega no webhook.
// TEMPORÁRIO (jun/2026) — remover junto com a tabela webhook_wa_debug.
function coletarEventosDebug(body) {
  const out = [];
  try {
    const entries = Array.isArray(body?.entry) ? body.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const v = change?.value || {};
        const temMsg = Array.isArray(v.messages) && v.messages.length > 0;
        const temStatus = Array.isArray(v.statuses) && v.statuses.length > 0;
        if (temMsg || temStatus) continue; // tráfego normal, já tratado
        out.push({
          field: change?.field || '',
          value_keys: Object.keys(v),
          phone_number_id: v?.metadata?.phone_number_id || '',
          payload: change,
        });
      }
    }
  } catch { /* nunca quebra o webhook */ }
  return out;
}

// --------- Info dos números configurados (cache 1h) ----------
let _phoneCache = null;
let _phoneCacheTime = 0;

// Retorna phone_number_id padrão de conversas (Número 1 — SDR)
function defaultPhoneId() { return WA_PHONE_ID; }

// Retorna phone_number_id do número de broadcast/templates (Número 2)
function broadcastPhoneId() { return WA_BROADCAST_PHONE_ID; }

async function getPhoneNumbers() {
  if (_phoneCache && Date.now() - _phoneCacheTime < 3_600_000) return _phoneCache;
  const pairs = [
    { id: WA_PHONE_ID, token: WA_TOKEN },
    { id: WA_BROADCAST_PHONE_ID, token: WA_BROADCAST_TOKEN },
  ].filter(p => p.id);
  const seen = new Set();
  const result = {};
  for (const { id, token } of pairs) {
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const r = await fetch(
        `https://graph.facebook.com/${WA_API_VERSION}/${id}?fields=display_phone_number&access_token=${token}`
      );
      const data = await r.json();
      if (data.display_phone_number) {
        const digits = data.display_phone_number.replace(/\D/g, '');
        // Retorna últimos 8 dígitos formatados como "9730-2393"
        const last8 = digits.slice(-8);
        result[id] = last8.length === 8 ? last8.slice(0, 4) + '-' + last8.slice(4) : digits.slice(-4);
      } else {
        result[id] = '...' + id.slice(-4);
      }
    } catch {
      result[id] = '...' + id.slice(-4);
    }
  }
  _phoneCache = result;
  _phoneCacheTime = Date.now();
  return result;
}

module.exports = {
  enviarTexto,
  enviarTemplate,
  enviarBroadcast,
  uploadMidia,
  enviarMidia,
  baixarMidia,
  deletarMensagem,
  temToken,
  temBroadcast,
  verifyToken,
  parseMensagemRecebida,
  parseStatuses,
  coletarEventosDebug,
  limparNumero,
  getPhoneNumbers,
  defaultPhoneId,
  broadcastPhoneId,
  _RETRY_DELAYS_MS, // exposto p/ testes acelerarem o backoff
};
