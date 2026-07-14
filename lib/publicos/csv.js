// CSV de um público. Helpers de escape/telefone em lib/csv-helpers.js.
const { esc: _esc, telefoneWa: _wa } = require('../csv-helpers');

function montarCsv(rows) {
  const head = 'nome,telefone,telefone_wa,status,origem';
  const linhas = (rows || []).map(r =>
    [_esc(r.nome), _esc(r.telefone), _esc(_wa(r.telefone)), _esc(r.status), _esc(r.origem)].join(','));
  return [head, ...linhas].join('\n');
}

module.exports = { montarCsv };
