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

const WA_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'meu_token_secreto_clinica_2026';
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

// --------- VERIFY TOKEN para webhook ----------
function verifyToken() {
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
    return {
      from: msg.from,
      nome: contato?.profile?.name || '',
      texto: msg.text?.body || msg.button?.text || '',
      tipo: msg.type,
      timestamp: msg.timestamp,
      id: msg.id,
    };
  } catch (e) {
    return null;
  }
}

module.exports = {
  enviarTexto,
  enviarTemplate,
  enviarBroadcast,
  temToken,
  temBroadcast,
  verifyToken,
  parseMensagemRecebida,
  limparNumero,
};
