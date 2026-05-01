// ============================================================
//  INTEGRAÇÃO WHATSAPP CLOUD API (Meta)
//  Envio de mensagens, recepção via webhook, templates
// ============================================================

const WA_TOKEN = process.env.WHATSAPP_CLOUD_TOKEN || '';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const WA_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'meu_token_secreto_clinica_2026';
const WA_API_VERSION = 'v21.0';

function temToken() {
  return WA_TOKEN && WA_PHONE_ID && WA_TOKEN !== 'SEU_TOKEN_AQUI';
}

function limparNumero(num) {
  return String(num || '').replace(/\D/g, '');
}

// --------- ENVIAR MENSAGEM DE TEXTO ----------
async function enviarTexto({ para, texto }) {
  if (!temToken()) throw new Error('WhatsApp Cloud API não configurada');
  const numero = limparNumero(para);
  const url = `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to: numero,
    type: 'text',
    text: { body: texto },
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WA_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (data.error) throw new Error(`WA API: ${data.error.message}`);
  return data;
}

// --------- ENVIAR TEMPLATE (mensagem proativa para leads frios) ----------
// Templates devem ser pré-aprovados no Meta Business Manager.
async function enviarTemplate({ para, templateName, lang = 'pt_BR', variaveis = [] }) {
  if (!temToken()) throw new Error('WhatsApp Cloud API não configurada');
  const numero = limparNumero(para);
  const payload = {
    messaging_product: 'whatsapp',
    to: numero,
    type: 'template',
    template: {
      name: templateName,
      language: { code: lang },
      ...(variaveis.length > 0 && {
        components: [{
          type: 'body',
          parameters: variaveis.map(v => ({ type: 'text', text: String(v) })),
        }],
      }),
    },
  };
  const r = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (data.error) throw new Error(`WA Template: ${data.error.message}`);
  return data;
}

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
  temToken,
  verifyToken,
  parseMensagemRecebida,
  limparNumero,
};
