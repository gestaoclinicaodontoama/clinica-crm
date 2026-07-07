const { test } = require('node:test');
const assert = require('node:assert');
const { CONTAS, byCodigo, GRUPOS_DRE } = require('./taxonomia');

test('tem 34 contas com codigo unico', () => {
  assert.equal(CONTAS.length, 34);
  const cods = new Set(CONTAS.map(c => c.codigo));
  assert.equal(cods.size, 34);
});

test('pró-labore sócios (3.2.3) existe no grupo 3.2', () => {
  const c = byCodigo('3.2.3');
  assert.equal(c.nome, 'Dentistas — fixo mensal');
  assert.equal(c.grupo, '3.2 - MÃO DE OBRA DENTISTA');
});

test('distribuição de lucro: conta 8.1 no grupo 8', () => {
  const c = byCodigo('8.1');
  assert.equal(c.nome, 'Distribuição de lucro — sócios');
  assert.equal(c.grupo, '8 - DISTRIBUIÇÃO DE LUCRO');
  assert.equal(c.tipo, 'distribuicao');
});

test('provisões: conta 9.1 no grupo 9, tipo provisao', () => {
  const c = byCodigo('9.1');
  assert.equal(c.nome, 'Provisões');
  assert.equal(c.grupo, '9 - PROVISÕES');
  assert.equal(c.tipo, 'provisao');
});

test('receita tem Convênio e Particular', () => {
  const rec = CONTAS.filter(c => c.tipo === 'receita').map(c => c.nome);
  assert.ok(rec.includes('Convênio'));
  assert.ok(rec.includes('Particular'));
});

test('byCodigo encontra Invisalign', () => {
  assert.equal(byCodigo('3.1.7').nome, 'Invisalign');
});

test('cascata DRE na ordem certa (8 e 9 por último: abaixo do Resultado Final)', () => {
  assert.deepEqual(GRUPOS_DRE.map(g => g.codigo), ['1','2','3.0','3.1','3.2','3.3','4','5','7','8','9']);
});
