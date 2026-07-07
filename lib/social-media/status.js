// lib/social-media/status.js
// Regras de transição do calendário. Aprovação: quando exigirAprovacao=true,
// entrar em 'aprovado' é privilégio de gestor/admin (fase inicial do Ricardo).
const TRANSICOES = {
  rascunho: ['aguardando_aprovacao', 'aprovado', 'cancelado'],
  aguardando_aprovacao: ['aprovado', 'rascunho', 'cancelado'],
  aprovado: ['publicado', 'rascunho', 'cancelado'],
  publicado: [],
  cancelado: ['rascunho'],
};
const STATUS_VALIDOS = Object.keys(TRANSICOES);

function podeTransicionar({ de, para, roles = [], exigirAprovacao = true }) {
  const dests = TRANSICOES[de];
  if (!dests || !dests.includes(para)) return { ok: false, motivo: 'transição inválida' };
  if (para === 'aprovado' && exigirAprovacao) {
    const gestor = roles.includes('admin') || roles.includes('gestor');
    if (!gestor) return { ok: false, motivo: 'aprovação exige gestor/admin' };
  }
  return { ok: true };
}

module.exports = { podeTransicionar, STATUS_VALIDOS, TRANSICOES };
