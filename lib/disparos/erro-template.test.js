const { test } = require('node:test');
const assert = require('node:assert');
const { templateIndisponivel } = require('./erro-template');

test('code 132001 (template não existe) é template indisponível', () => {
  assert.strictEqual(templateIndisponivel({ code: 132001, message: 'x' }), true);
});

test('code 132007 (template pausado/rejeitado) é template indisponível', () => {
  assert.strictEqual(templateIndisponivel({ code: 132007 }), true);
});

test('mensagem textual sem code também é detectada', () => {
  assert.strictEqual(templateIndisponivel({ metaMessage: 'Template name does not exist in the translation' }), true);
});

test('erro comum (janela 24h, code 131047) NÃO é template indisponível', () => {
  assert.strictEqual(templateIndisponivel({ code: 131047, message: 'Re-engagement message' }), false);
});

test('erro sem code nem texto relevante NÃO casa', () => {
  assert.strictEqual(templateIndisponivel({ message: 'rede caiu' }), false);
});
