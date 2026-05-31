const { test } = require('node:test');
const assert = require('node:assert');
const { normalizarTelefone } = require('./telefone');

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
