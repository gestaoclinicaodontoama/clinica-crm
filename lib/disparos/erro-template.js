// Detecta erro da Meta de "template indisponível no número" (WABA diferente,
// template inexistente/pausado). Usado pelo runner para pausar a campanha
// inteira em vez de queimar todos os contatos.
const CODES = new Set([132001, 132007]);

function templateIndisponivel(err) {
  if (!err) return false;
  if (CODES.has(err.code)) return true;
  const texto = String(err.metaMessage || err.message || '').toLowerCase();
  return texto.includes('template') && (texto.includes('does not exist') || texto.includes('not found'));
}

module.exports = { templateIndisponivel };
