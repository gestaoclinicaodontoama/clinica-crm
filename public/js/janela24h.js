// Janela de atendimento da Meta (24h após a última mensagem RECEBIDA do lead).
// Mesma regra de janela24hAberta() no server.js — aqui é só exibição; o
// servidor continua bloqueando o envio se o front divergir.
const JANELA_TOTAL_MS = 24 * 3600 * 1000;
const JANELA_AVISO_MS = 6 * 3600 * 1000; // 'fechando' quando restar menos que isso

function _fmtRestante(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  // >= 10h: granularidade de horas basta para o aviso de janela
  if (h >= 10) return h + 'h';
  if (h >= 1) return m > 0 ? h + 'h ' + m + 'min' : h + 'h';
  return m + 'min';
}

// ultimaRecebidaEm: ISO string da última mensagem recebida (já filtrada pelo
// número SDR) ou null. agora: epoch ms (injetável p/ teste; default Date.now()).
function estadoJanela(ultimaRecebidaEm, agora) {
  const now = typeof agora === 'number' ? agora : Date.now();
  if (!ultimaRecebidaEm) return { estado: 'fechada', restanteMs: 0, label: 'Janela de 24h fechada' };
  const ts = new Date(ultimaRecebidaEm).getTime();
  if (isNaN(ts)) return { estado: 'fechada', restanteMs: 0, label: 'Janela de 24h fechada' };
  const restanteMs = ts + JANELA_TOTAL_MS - now;
  if (restanteMs <= 0) return { estado: 'fechada', restanteMs: 0, label: 'Janela de 24h fechada' };
  if (restanteMs <= JANELA_AVISO_MS) {
    return { estado: 'fechando', restanteMs, label: '⏳ Janela fecha em ' + _fmtRestante(restanteMs) + ' — responda logo' };
  }
  return { estado: 'aberta', restanteMs, label: 'Janela aberta — fecha em ' + _fmtRestante(restanteMs) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { estadoJanela, _fmtRestante, JANELA_TOTAL_MS, JANELA_AVISO_MS };
}
