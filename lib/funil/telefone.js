// Normaliza telefones brasileiros para "DDD + número" só com dígitos.
function normalizarTelefone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55')) d = d.slice(2); // remove DDI
  if (d.length === 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length < 10) return null;
  return d;
}

// Chave de comparação: DDD + 8 dígitos (remove DDI e o 9º dígito).
// Necessária para casar números em formatos mistos — a base tem leads sem DDI
// e a Meta pode entregar o remetente do WhatsApp sem o 9º dígito.
function chaveTelefone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.length === 11) d = d.slice(0, 2) + d.slice(3);
  return d.length === 10 ? d : '';
}

module.exports = { normalizarTelefone, chaveTelefone };
