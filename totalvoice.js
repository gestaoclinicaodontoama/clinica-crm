// ============================================================
//  INTEGRAÇÃO TOTALVOICE / NVOIP
//  Click-to-call + gravação automática
// ============================================================

const TOTALVOICE_TOKEN = process.env.TOTALVOICE_TOKEN || '';
const TOTALVOICE_BASE = 'https://api.totalvoice.com.br';

// --------- HELPERS ----------
function limparNumero(num) {
  // Remove tudo que não for dígito
  return String(num || '').replace(/\D/g, '');
}

function temToken() {
  return TOTALVOICE_TOKEN && TOTALVOICE_TOKEN !== 'SEU_TOKEN_AQUI';
}

// --------- LIGAR (CLICK-TO-CALL) ----------
// Como funciona: a API liga PRIMEIRO para o ramal/celular da SDR.
// Quando ela atende, conecta com o número do lead.
// Isso evita que a SDR precise de softphone instalado.
async function ligar({ numeroSdr, numeroLead, gravar = true, bina }) {
  if (!temToken()) {
    throw new Error('TotalVoice não configurada — preencha TOTALVOICE_TOKEN no .env');
  }

  const payload = {
    numero_origem: limparNumero(numeroSdr),
    numero_destino: limparNumero(numeroLead),
    gravar_audio: gravar,
  };

  // Bina = número que aparece para o lead (deve ser um DID seu na conta TotalVoice)
  if (bina) payload.bina = limparNumero(bina);

  const r = await fetch(`${TOTALVOICE_BASE}/chamada`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Access-Token': TOTALVOICE_TOKEN,
    },
    body: JSON.stringify(payload),
  });

  const data = await r.json();
  if (!data.sucesso) {
    throw new Error(`TotalVoice erro: ${data.mensagem || 'desconhecido'}`);
  }
  return data.dados; // { id, status, ... }
}

// --------- BUSCAR DETALHES DE UMA CHAMADA ----------
async function buscarChamada(chamadaId) {
  if (!temToken()) throw new Error('TotalVoice não configurada');

  const r = await fetch(`${TOTALVOICE_BASE}/chamada/${chamadaId}`, {
    headers: { 'Access-Token': TOTALVOICE_TOKEN },
  });
  const data = await r.json();
  if (!data.sucesso) {
    throw new Error(`TotalVoice erro: ${data.mensagem || 'desconhecido'}`);
  }
  return data.dados;
}

// --------- ENCERRAR CHAMADA EM ANDAMENTO ----------
async function encerrarChamada(chamadaId) {
  if (!temToken()) throw new Error('TotalVoice não configurada');

  const r = await fetch(`${TOTALVOICE_BASE}/chamada/encerra/${chamadaId}`, {
    method: 'DELETE',
    headers: { 'Access-Token': TOTALVOICE_TOKEN },
  });
  return r.json();
}

module.exports = {
  ligar,
  buscarChamada,
  encerrarChamada,
  temToken,
  limparNumero,
};
