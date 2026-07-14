// Helpers compartilhados de CSV (Públicos + export de leads p/ discador).
// telefoneWa prefixa 55 só quando faltar (10–11 dígitos); telefones de família
// (0 à esquerda, >11 dígitos) e já-com-55 ficam intactos.
function telefoneWa(tel) {
  const n = String(tel == null ? '' : tel).replace(/\D/g, '');
  if ((n.length === 10 || n.length === 11) && !n.startsWith('55')) return '55' + n;
  return n;
}

function esc(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

module.exports = { esc, telefoneWa };
