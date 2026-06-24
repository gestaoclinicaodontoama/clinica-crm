const { test } = require('node:test');
const assert = require('node:assert');
const { montarCsv } = require('./csv');

test('cabeçalho + linha simples', () => {
  const csv = montarCsv([{ nome: 'Ana', telefone: '553199990000', status: 'Novo', origem: 'Google' }]);
  assert.strictEqual(csv.split('\n')[0], 'nome,telefone,telefone_wa,status,origem');
  assert.strictEqual(csv.split('\n')[1], 'Ana,553199990000,553199990000,Novo,Google');
});

test('telefone sem 55 ganha 55 só no telefone_wa', () => {
  const linha = montarCsv([{ nome: 'B', telefone: '31988887777', status: 'Novo', origem: '' }]).split('\n')[1];
  assert.strictEqual(linha, 'B,31988887777,5531988887777,Novo,');
});

test('telefone de família (0 à esquerda) fica intacto', () => {
  const linha = montarCsv([{ nome: 'Fam', telefone: '031991148016', status: 'Novo', origem: '' }]).split('\n')[1];
  assert.strictEqual(linha, 'Fam,031991148016,031991148016,Novo,');
});

test('escapa vírgula e aspas no nome', () => {
  const linha = montarCsv([{ nome: 'Silva, "Jr"', telefone: '5531999990000', status: 'Novo', origem: '' }]).split('\n')[1];
  assert.strictEqual(linha, '"Silva, ""Jr""",5531999990000,5531999990000,Novo,');
});
