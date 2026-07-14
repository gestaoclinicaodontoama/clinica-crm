const { test } = require('node:test');
const assert = require('node:assert');
const { montarCsvDiscador } = require('./exportCsv');

test('cabeçalho com BOM e 6 colunas', () => {
  const { csv, descartados } = montarCsvDiscador([], {});
  assert.strictEqual(csv.charCodeAt(0), 0xFEFF);
  assert.strictEqual(csv.slice(1), 'nome,telefone,telefone_wa,status,origem,anuncio');
  assert.strictEqual(descartados, 0);
});

test('linha completa com anúncio resolvido pelo catálogo', () => {
  const rows = [{ nome: 'Maria', telefone: '31988887777', status: 'Novo', origem: 'Meta Ads', campanha: '120212345678900000' }];
  const map = { '120212345678900000': 'Invisalign Julho' };
  const { csv } = montarCsvDiscador(rows, map);
  assert.strictEqual(csv.split('\n')[1], 'Maria,31988887777,5531988887777,Novo,Meta Ads,Invisalign Julho');
});

test('anúncio vazio quando campanha é nula ou fora do catálogo', () => {
  const rows = [
    { nome: 'A', telefone: '3198888777', status: 'Novo', origem: 'Google', campanha: null },
    { nome: 'B', telefone: '31988887771', status: 'Novo', origem: 'Meta Ads', campanha: '999' },
  ];
  const { csv } = montarCsvDiscador(rows, {});
  const linhas = csv.split('\n');
  assert.ok(linhas[1].endsWith(','), 'campanha null -> anuncio vazio');
  assert.ok(linhas[2].endsWith(','), 'fora do catálogo -> anuncio vazio');
});

test('descarta linhas sem telefone e conta', () => {
  const rows = [
    { nome: 'Com', telefone: '31988887777', status: 'Novo', origem: 'X' },
    { nome: 'Vazio', telefone: '', status: 'Novo', origem: 'X' },
    { nome: 'Nulo', telefone: null, status: 'Novo', origem: 'X' },
    { nome: 'Espaço', telefone: '   ', status: 'Novo', origem: 'X' },
  ];
  const { csv, descartados } = montarCsvDiscador(rows, {});
  assert.strictEqual(descartados, 3);
  assert.strictEqual(csv.split('\n').length, 2); // cabeçalho + 1 linha
});

test('escapa vírgula e aspas no nome', () => {
  const rows = [{ nome: 'Silva, "Zé"', telefone: '31988887777', status: 'Novo', origem: 'X' }];
  const { csv } = montarCsvDiscador(rows, {});
  assert.ok(csv.includes('"Silva, ""Zé"""'));
});

test('telefone de família (0 à esquerda, 12 dígitos) fica intacto', () => {
  const rows = [{ nome: 'Fam', telefone: '031988887777', status: 'Novo', origem: 'X' }];
  const cols = montarCsvDiscador(rows, {}).csv.split('\n')[1].split(',');
  assert.strictEqual(cols[1], '031988887777');
  assert.strictEqual(cols[2], '031988887777'); // não prefixa 55
});

test('telefone já com 55 não duplica prefixo', () => {
  const rows = [{ nome: 'C', telefone: '5531988887777', status: 'Novo', origem: 'X' }];
  assert.strictEqual(montarCsvDiscador(rows, {}).csv.split('\n')[1].split(',')[2], '5531988887777');
});
