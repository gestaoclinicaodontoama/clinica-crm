// CSV p/ discador — spec docs/superpowers/specs/2026-07-14-export-leads-discador-design.md
// BOM no início: a CRC abre no Excel, que sem BOM quebra os acentos.
// Linhas sem telefone ficam fora (inúteis no discador) e contam em `descartados`.
const { esc, telefoneWa } = require('../csv-helpers');

const BOM = String.fromCharCode(0xFEFF);

function montarCsvDiscador(rows, anunciosMap = {}) {
  const todas = rows || [];
  const validas = todas.filter(r => r.telefone && String(r.telefone).trim());
  const head = 'nome,telefone,telefone_wa,status,origem,anuncio';
  const linhas = validas.map(r => [
    esc(r.nome), esc(r.telefone), esc(telefoneWa(r.telefone)), esc(r.status), esc(r.origem),
    esc(r.campanha ? (anunciosMap[String(r.campanha).toLowerCase()] || '') : ''),
  ].join(','));
  return { csv: BOM + [head, ...linhas].join('\n'), descartados: todas.length - validas.length };
}

module.exports = { montarCsvDiscador };
