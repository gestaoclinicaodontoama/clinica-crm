// CSV de um público. telefone_wa prefixa 55 só quando faltar (10–11 dígitos);
// telefones de família (0 à esquerda, >11 dígitos) e já-com-55 ficam intactos.
function _wa(tel) {
  const n = String(tel == null ? '' : tel).replace(/\D/g, '');
  if ((n.length === 10 || n.length === 11) && !n.startsWith('55')) return '55' + n;
  return n;
}

function _esc(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function montarCsv(rows) {
  const head = 'nome,telefone,telefone_wa,status,origem';
  const linhas = (rows || []).map(r =>
    [_esc(r.nome), _esc(r.telefone), _esc(_wa(r.telefone)), _esc(r.status), _esc(r.origem)].join(','));
  return [head, ...linhas].join('\n');
}

module.exports = { montarCsv };
