'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizarDentista } = require('./dentistas');

// Variações reais vindas das notas dos 5 laboratórios (23/07/2026)
const casos = [
  ['AMANDA FERREIRA MOLICA', 'Dra. Amanda Molica'],
  ['Dra. Amanda Molica', 'Dra. Amanda Molica'],
  ['Amanda Ferreira Molica', 'Dra. Amanda Molica'],
  ['MARCOS', 'Dr. Marcos Vinicius'],
  ['Dr. Marcos Vinicius', 'Dr. Marcos Vinicius'],
  ['MATHEUS', 'Dr. Matheus'],
  ['Dr. MATHEUS G.', 'Dr. Matheus'],
  ['Matheus', 'Dr. Matheus'],
  ['Joaquim Vidigal Martins Filho', 'Dr. Joaquim'],
  ['Dr. Joaquim', 'Dr. Joaquim'],
  ['LIGIA', 'Dra. Lígia'],
  ['Dr. RAISSA ALVES', 'Dra. Raissa Alves'],
];

test('normalizarDentista unifica as grafias reais dos labs', () => {
  for (const [entrada, esperado] of casos) assert.strictEqual(normalizarDentista(entrada), esperado, entrada);
});

test('nome desconhecido passa limpo (trim), vazio vira null', () => {
  assert.strictEqual(normalizarDentista('  Dra. Fulana Nova  '), 'Dra. Fulana Nova');
  assert.strictEqual(normalizarDentista(''), null);
  assert.strictEqual(normalizarDentista(null), null);
});
