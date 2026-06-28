const { test } = require('node:test');
const assert = require('node:assert');
const { normalizarNome, classificar } = require('./classificacao');

test('normalizarNome remove código, acento e caixa', () => {
  assert.strictEqual(normalizarNome('84000090 - Aplicação Tópica de Flúor'), 'aplicacao topica de fluor');
  assert.strictEqual(normalizarNome('84.00.019-8 - Profilaxia: polimento coronário'), 'profilaxia polimento coronario');
});

test('profilaxia e flúor contam como prevenção adulto', () => {
  assert.strictEqual(classificar({ nome: '84000198 - Profilaxia:polimento coronário' }), 'adulto');
  assert.strictEqual(classificar({ nome: 'Aplicação tópica de flúor' }), 'adulto');
  assert.strictEqual(classificar({ nome: '85300047 - Raspagem supra-gengival' }), 'adulto');
  assert.strictEqual(classificar({ nome: '84000139 - Atividade educativa em saúde bucal' }), 'adulto');
});

test('condicionamento é infantil', () => {
  assert.strictEqual(classificar({ nome: '81000014 - Condicionamento em Odontologia' }), 'infantil');
});

test('especialidade Odontopediatria ou Dra. Ana Luiza força infantil', () => {
  assert.strictEqual(classificar({ nome: 'Aplicação tópica de flúor', expertise: 'Odontopediatria' }), 'infantil');
  assert.strictEqual(classificar({ nome: 'Profilaxia', profissional: 'Ana Luiza Rodrigues Coelho' }), 'infantil');
});

test('consulta sozinha, sub-gengival e tratamentos NÃO contam', () => {
  assert.strictEqual(classificar({ nome: '81000065 - Consulta odontológica inicial' }), null);
  assert.strictEqual(classificar({ nome: 'Manutenção periodontal' }), null);
  assert.strictEqual(classificar({ nome: '83000089 - Exodontia simples de decíduo' }), null);
  assert.strictEqual(classificar({ nome: 'Pulpotomia em dente decíduo' }), null);
  assert.strictEqual(classificar({ nome: 'Imobilização dentária em dentes permanentes' }), null);
  assert.strictEqual(classificar({ nome: 'Manutenção mensal de aparelho fixo' }), null);
});

test('sub-gengival/alisamento conta como perio', () => {
  assert.strictEqual(classificar({ nome: '85300039 - Raspagem sub-gengival/alisamento radicular' }), 'perio');
  assert.strictEqual(classificar({ nome: 'Raspagem Subgengival' }), 'perio');
  assert.strictEqual(classificar({ nome: 'Alisamento radicular' }), 'perio');
  // perio não vira infantil mesmo com odontopediatria
  assert.strictEqual(classificar({ nome: 'Raspagem sub-gengival', expertise: 'Odontopediatria' }), 'perio');
  // manutenção periodontal (sem raspagem) segue fora
  assert.strictEqual(classificar({ nome: 'Manutenção periodontal' }), null);
});
