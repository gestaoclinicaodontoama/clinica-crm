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

function limparNumero(num) {
  return String(num || '').replace(/\D/g, '');
}

async function _post(phoneId, token, payload) {
  const r = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

// Número 1 — texto livre (SDR, janela de 24h)
async function enviarTexto({ para, texto }) {
  if (!temToken()) throw new Error('WhatsApp Cloud API não configurada');
  return _post(WA_PHONE_ID, WA_TOKEN, {
    messaging_product: 'whatsapp', to: limparNumero(para),
    type: 'text', text: { body: texto },
  });
}

// Número 2 — template aprovado (broadcast, fora da janela)
async function enviarBroadcast({ para, templateName, lang = 'pt_BR', variaveis = [] }) {
  if (!temBroadcast()) throw new Error('Número de broadcast não configurado');
  const numero = limparNumero(para);
  return _post(WA_BROADCAST_PHONE_ID, WA_BROADCAST_TOKEN, {
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

// Upload de mídia → retorna media_id
async function uploadMidia({ buffer, mimetype, filename }) {
  if (!temToken()) throw new Error('WhatsApp Cloud API não configurada');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimetype }), filename);
  const r = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/media`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WA_TOKEN}` },
    body: form,
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.id;
}

// Envio de mensagem com mídia já carregada (media_id)
async function enviarMidia({ para, mediaId, tipo, caption }) {
  const payload = {
    messaging_product: 'whatsapp', to: limparNumero(para),
    type: tipo,
    [tipo]: { id: mediaId, ...(caption ? { caption } : {}) },
  };
  return _post(WA_PHONE_ID, WA_TOKEN, payload);
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
    return {
      from: msg.from,
      nome: contato?.profile?.name || '',
      texto: msg.text?.body || msg.button?.text || '',
      tipo: msg.type,
      timestamp: msg.timestamp,
      id: msg.id,
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

module.exports = {
  enviarTexto,
  enviarTemplate,
  enviarBroadcast,
  uploadMidia,
  enviarMidia,
  temToken,
  temBroadcast,
  verifyToken,
  parseMensagemRecebida,
  limparNumero,
};
