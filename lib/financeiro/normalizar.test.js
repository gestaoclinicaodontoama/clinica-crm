const { test } = require('node:test');
const assert = require('node:assert');
const { nucleo, empresa, tokens } = require('./normalizar');

test('nucleo remove prefixo, empresa, parcela, acento', () => {
  assert.equal(nucleo('Pagamento de Conta: Pró labore Marcos Vinicius - PF 3/12'), 'pro labore marcos vinicius');
  assert.equal(nucleo('Pagamento de Conta: Simples - AMA'), 'simples');
});

test('empresa extrai sufixo', () => {
  assert.equal(empresa('Pagamento de Conta: Salários - AMA'), 'AMA');
  assert.equal(empresa('Pagamento de Conta: IRPF Dorinha - MAR'), 'MAR');
  assert.equal(empresa('Pagamento de Conta: Pagamento Matheus - PF 3/12'), 'PF');
  assert.equal(empresa('Pagamento de Conta: Martins - Martins'), 'MAR'); // alias
  assert.equal(empresa('Pagamento de Conta: Conservação'), null);
});

test('tokens remove stopwords e numeros', () => {
  assert.deepEqual(tokens('Pagamento de Conta: NFe 72 - Atelie Odonto Prótese - PF'),
    ['atelie','odonto','protese']);
});
