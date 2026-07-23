'use strict';
// Unifica as grafias de dentista que cada laboratório usa ("AMANDA FERREIRA MOLICA",
// "Dra. Amanda Molica", "MARCOS", "Dr. MATHEUS G."...) num nome canônico único.
// Nome que não casa com ninguém do mapa passa limpo (trim) — lab pode citar dentista novo.

const { norm } = require('./categoria');

const MAPA = [
  { chave: 'amanda', nome: 'Dra. Amanda Molica' },
  { chave: 'matheus', nome: 'Dr. Matheus' },
  { chave: 'joaquim', nome: 'Dr. Joaquim' },
  { chave: 'ligia', nome: 'Dra. Lígia' },
  { chave: 'raissa', nome: 'Dra. Raissa Alves' },
  { chave: 'marcos', nome: 'Dr. Marcos Vinicius' },
];

function normalizarDentista(nome) {
  const limpo = String(nome || '').trim();
  if (!limpo) return null;
  const n = norm(limpo);
  for (const m of MAPA) if (n.includes(m.chave)) return m.nome;
  return limpo;
}

module.exports = { normalizarDentista, MAPA_DENTISTAS: MAPA };
