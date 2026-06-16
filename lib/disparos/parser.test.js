const { test } = require('node:test');
const assert = require('node:assert');
const { parseCsv, normalizarTelefoneEnvio } = require('./parser');

test('normaliza telefone de 11 digitos prefixando 55', () => {
  assert.strictEqual(normalizarTelefoneEnvio('31998059819'), '5531998059819');
});

test('normaliza telefone de 10 digitos (sem 9) prefixando 55', () => {
  assert.strictEqual(normalizarTelefoneEnvio('3132249419'), '553132249419');
});

test('mantem telefone que ja vem com 55', () => {
  assert.strictEqual(normalizarTelefoneEnvio('5531998059819'), '5531998059819');
});

test('limpa mascara e simbolos', () => {
  assert.strictEqual(normalizarTelefoneEnvio('(31) 99805-9819'), '5531998059819');
});

test('telefone curto demais e invalido', () => {
  assert.strictEqual(normalizarTelefoneEnvio('99819'), null);
});

test('parseia CSV real wa_3 com cabecalho completo', () => {
  const csv = [
    'nome_completo,primeiro_nome,telefone,tratamento,valor_orcamento',
    'Antonio Augusto de Padua Mendes (20594),Antonio,31998059819,Invisalign,17500',
    'Giuseppe Rafaelle Meireles Rosa (20720),Giuseppe,31985566017,Invisalign,17100',
  ].join('\n');
  const r = parseCsv(csv);
  assert.strictEqual(r.contatos.length, 2);
  assert.strictEqual(r.invalidos, 0);
  assert.deepStrictEqual(r.contatos[0], {
    nome: 'Antonio Augusto de Padua Mendes',
    primeiro_nome: 'Antonio',
    telefone: '5531998059819',
  });
});

test('parseia CSV simples nome,telefone e deriva primeiro_nome', () => {
  const csv = 'Maria Silva, 5531999990001\nJoao Souza, 31988887777';
  const r = parseCsv(csv);
  assert.strictEqual(r.contatos.length, 2);
  assert.strictEqual(r.contatos[0].primeiro_nome, 'Maria');
  assert.strictEqual(r.contatos[0].telefone, '5531999990001');
  assert.strictEqual(r.contatos[1].telefone, '5531988887777');
});

test('aceita separador ponto-e-virgula', () => {
  const csv = 'nome;telefone\nAna Paula;31977776666';
  const r = parseCsv(csv);
  assert.strictEqual(r.contatos.length, 1);
  assert.strictEqual(r.contatos[0].primeiro_nome, 'Ana');
});

test('linha sem telefone valido conta como invalido e nao entra', () => {
  const csv = 'nome,telefone\nFulano,abc\nBeltrano,31955554444';
  const r = parseCsv(csv);
  assert.strictEqual(r.contatos.length, 1);
  assert.strictEqual(r.invalidos, 1);
});

test('primeiro_nome vazio cai para fallback generico', () => {
  const csv = 'nome_completo,primeiro_nome,telefone\n,,31944443333';
  const r = parseCsv(csv);
  assert.strictEqual(r.contatos[0].primeiro_nome, 'tudo bem');
});
