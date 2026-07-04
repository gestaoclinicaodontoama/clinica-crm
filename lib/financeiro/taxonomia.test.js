const { test } = require('node:test');
const assert = require('node:assert');
const { CONTAS, byCodigo, GRUPOS_DRE } = require('./taxonomia');

test('tem 32 contas com codigo unico', () => {
  assert.equal(CONTAS.length, 32);
  const cods = new Set(CONTAS.map(c => c.codigo));
  assert.equal(cods.size, 32);
});

test('distribuição de lucro: conta 6.1 no grupo 6', () => {
  const c = byCodigo('6.1');
  assert.equal(c.nome, 'Distribuição de lucro — sócios');
  assert.equal(c.grupo, '6 - DISTRIBUIÇÃO DE LUCRO');
  assert.equal(c.tipo, 'distribuicao');
});

test('receita tem Convênio e Particular', () => {
  const rec = CONTAS.filter(c => c.tipo === 'receita').map(c => c.nome);
  assert.ok(rec.includes('Convênio'));
  assert.ok(rec.includes('Particular'));
});

test('byCodigo encontra Invisalign', () => {
  assert.equal(byCodigo('3.1.7').nome, 'Invisalign');
});

test('cascata DRE na ordem certa (6 por último: abaixo do Resultado Final)', () => {
  assert.deepEqual(GRUPOS_DRE.map(g => g.codigo), ['1','2','3.0','3.1','3.2','3.3','4','5','7','6']);
});
