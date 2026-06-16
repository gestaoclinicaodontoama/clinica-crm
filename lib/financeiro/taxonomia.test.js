const { test } = require('node:test');
const assert = require('node:assert');
const { CONTAS, byCodigo, GRUPOS_DRE } = require('./taxonomia');

test('tem 30 contas com codigo unico', () => {
  assert.equal(CONTAS.length, 30);
  const cods = new Set(CONTAS.map(c => c.codigo));
  assert.equal(cods.size, 30);
});

test('receita tem Convênio e Particular', () => {
  const rec = CONTAS.filter(c => c.tipo === 'receita').map(c => c.nome);
  assert.ok(rec.includes('Convênio'));
  assert.ok(rec.includes('Particular'));
});

test('byCodigo encontra Invisalign', () => {
  assert.equal(byCodigo('3.1.7').nome, 'Invisalign');
});

test('cascata DRE na ordem certa', () => {
  assert.deepEqual(GRUPOS_DRE.map(g => g.codigo), ['1','2','3.0','3.1','3.2','3.3','4','5','7']);
});
