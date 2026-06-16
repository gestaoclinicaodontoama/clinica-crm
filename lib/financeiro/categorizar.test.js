const { test } = require('node:test');
const assert = require('node:assert');
const { criarCategorizador } = require('./categorizar');

const regras = [
  { metodo: 'exato',   padrao: 'simples', conta_codigo: '2.1' },
  { metodo: 'keyword', padrao: 'invisalign', conta_codigo: '3.1.7' },
  { metodo: 'keyword', padrao: 'neodent', conta_codigo: '3.1.6' },
];
const pessoas = [{ nome: 'Amanda', conta_codigo: '3.2.2' }];

test('camada exata vence', () => {
  const cat = criarCategorizador({ regras, pessoas });
  const r = cat('Pagamento de Conta: Simples - AMA');
  assert.equal(r.conta_codigo, '2.1'); assert.equal(r.metodo, 'exato');
});

test('pessoa vem antes de keyword', () => {
  // "Pagamento Amanda" não tem keyword, mas pessoa resolve
  const cat = criarCategorizador({ regras, pessoas });
  const r = cat('Pagamento de Conta: Pagamento Amanda - MAR 3/12');
  assert.equal(r.conta_codigo, '3.2.2'); assert.equal(r.metodo, 'pessoa');
});

test('keyword resolve fornecedor', () => {
  const cat = criarCategorizador({ regras, pessoas });
  assert.equal(cat('Pagamento de Conta: NFe 12 - Invisalign - PF').conta_codigo, '3.1.7');
});

test('sem match → null (a categorizar)', () => {
  const cat = criarCategorizador({ regras, pessoas });
  const r = cat('Pagamento de Conta: Fornecedor Desconhecido XYZ - AMA');
  assert.equal(r.conta_codigo, null); assert.equal(r.metodo, null);
});
