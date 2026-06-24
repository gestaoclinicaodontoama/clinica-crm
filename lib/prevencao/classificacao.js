'use strict';

function normalizarNome(s) {
  if (!s) return '';
  let n = String(s).replace(/^\s*[\d.\-]+\s*-\s*/, '');      // tira "84000090 - " / "84.00.009-0 - "
  n = n.normalize('NFD').replace(/[̀-ͯ]/g, '');     // tira acentos (combining marks)
  n = n.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();     // só alfanumérico + espaço
  return n.replace(/\s+/g, ' ');
}

// Chave (substring no nome normalizado) → categoria base.
// 'condicionamento' nasce infantil; o resto adulto (pode virar infantil por especialidade/profissional).
const REGRAS_PADRAO = [
  ['profilaxia', 'adulto'], ['polimento coronario', 'adulto'],
  ['aplicacao topica de fluor', 'adulto'], ['verniz fluoretado', 'adulto'], ['fluor verniz', 'adulto'],
  ['remineraliz', 'adulto'], ['fluorterapia', 'adulto'],
  ['controle de biofilme', 'adulto'], ['controle de placa', 'adulto'],
  ['remocao dos fatores de retencao do biofilme', 'adulto'],
  ['atividade educativa', 'adulto'], ['orientacao de higiene', 'adulto'],
  ['raspagem supra', 'adulto'],
  ['aplicacao de selante', 'adulto'], ['aplicacao de cariostatico', 'adulto'],
  ['condicionamento', 'infantil'],
  ['pacote de prevencao', 'adulto'], ['pacote de atendimento', 'adulto'], ['pacote atendimento preventivo', 'adulto'],
  ['prevencao', 'adulto'],
];

function classificar({ nome, expertise, profissional } = {}, regras = REGRAS_PADRAO) {
  const n = normalizarNome(nome);
  if (!n) return null;
  if (n.includes('sub') && n.includes('gengiv')) return null;   // raspagem sub-gengival = tratamento
  if (n.startsWith('consulta')) return null;                    // consulta não dispara sozinha

  let categoria = null;
  for (const [chave, cat] of regras) {
    if (n.includes(chave)) { categoria = cat; break; }
  }
  if (!categoria) return null;

  const prof = (profissional || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (expertise === 'Odontopediatria' || prof.startsWith('ana luiza')) categoria = 'infantil';
  return categoria;
}

module.exports = { normalizarNome, classificar, REGRAS_PADRAO };
