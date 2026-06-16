const { test } = require('node:test');
const assert = require('node:assert');
const { ultimos8, confirmarMatch } = require('./matching');

test('ultimos8 pega os 8 ultimos digitos ignorando mascara', () => {
  assert.strictEqual(ultimos8('5531998059819'), '98059819');
  assert.strictEqual(ultimos8('(31) 99805-9819'), '98059819');
});

test('confirmarMatch casa numero com 9 contra lead sem 9', () => {
  const cands = [{ id: 7, telefone: '553198059819' }]; // sem o 9 extra
  const m = confirmarMatch('5531998059819', cands);
  assert.strictEqual(m.id, 7);
});

test('confirmarMatch casa formatos com e sem DDI', () => {
  const cands = [{ id: 9, telefone: '31998059819' }];
  const m = confirmarMatch('5531998059819', cands);
  assert.strictEqual(m.id, 9);
});

test('confirmarMatch retorna null quando ninguem casa', () => {
  const cands = [{ id: 1, telefone: '5531911112222' }];
  assert.strictEqual(confirmarMatch('5531998059819', cands), null);
});

test('confirmarMatch nao casa familiares com 3o digito diferente de 9', () => {
  // 4475089 vs 4495089 sao pessoas diferentes (ver telefone.js)
  const cands = [{ id: 2, telefone: '553144750890' }];
  assert.strictEqual(confirmarMatch('553144950890', cands), null);
});
