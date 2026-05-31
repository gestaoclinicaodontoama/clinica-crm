// Normaliza telefones brasileiros para "DDD + número" só com dígitos.
function normalizarTelefone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55')) d = d.slice(2); // remove DDI
  if (d.length === 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length < 10) return null;
  return d;
}

module.exports = { normalizarTelefone };
