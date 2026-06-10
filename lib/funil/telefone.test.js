const { test } = require('node:test');
const assert = require('node:assert');
const { normalizarTelefone, chaveTelefone } = require('./telefone');

test('remove tudo que não é dígito', () => {
  assert.strictEqual(normalizarTelefone('(31) 99669-2011'), '31996692011');
});

test('remove DDI 55 quando presente em número de 13 dígitos', () => {
  assert.strictEqual(normalizarTelefone('5531996692011'), '31996692011');
});

test('mantém 11 dígitos (DDD + 9 dígitos)', () => {
  assert.strictEqual(normalizarTelefone('31996692011'), '31996692011');
});

test('retorna null para vazio ou curto demais', () => {
  assert.strictEqual(normalizarTelefone(''), null);
  assert.strictEqual(normalizarTelefone(null), null);
  assert.strictEqual(normalizarTelefone('1234'), null);
});

test('chaveTelefone: DDD+8, remove DDI e 9º dígito', () => {
  assert.strictEqual(chaveTelefone('5531996692011'), '3196692011');
  assert.strictEqual(chaveTelefone('31996692011'), '3196692011');
  assert.strictEqual(chaveTelefone('553196692011'), '3196692011'); // Meta sem o 9º dígito
  assert.strictEqual(chaveTelefone('3196692011'), '3196692011');   // fixo / base sem DDI
});

test('chaveTelefone: mesma pessoa em formatos diferentes casa; DDDs diferentes não', () => {
  assert.strictEqual(chaveTelefone('5531996692011'), chaveTelefone('31996692011'));
  assert.strictEqual(chaveTelefone('553196692011'), chaveTelefone('31996692011'));
  assert.notStrictEqual(chaveTelefone('5521996692011'), chaveTelefone('5531996692011'));
});

test('chaveTelefone: inválido ou curto retorna vazio (não casa nada)', () => {
  assert.strictEqual(chaveTelefone(''), '');
  assert.strictEqual(chaveTelefone(null), '');
  assert.strictEqual(chaveTelefone('996692011'), '');
});

test('chaveTelefone: só remove o 3º dígito quando é 9 — números reais com 7/8 não colidem', () => {
  // família Gaigher: 44 7 5089-3921 e 44 9 5089-3921 são pessoas DIFERENTES
  assert.strictEqual(chaveTelefone('44750893921'), '44750893921');
  assert.strictEqual(chaveTelefone('44950893921'), '4450893921');
  assert.notStrictEqual(chaveTelefone('44750893921'), chaveTelefone('44950893921'));
  // zero à esquerda (trunk antigo) também não colapsa
  assert.notStrictEqual(chaveTelefone('03191142439'), chaveTelefone('03991142439'));
});
