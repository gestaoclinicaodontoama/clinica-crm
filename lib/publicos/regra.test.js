const { test } = require('node:test');
const assert = require('node:assert');
const { normalizarRegra } = require('./regra');

test('regra vazia/sujeira vira objeto vazio', () => {
  assert.deepStrictEqual(normalizarRegra(null), {});
  assert.deepStrictEqual(normalizarRegra({ lixo: 1, foo: 'bar' }), {});
});

test('interesse: termo sem fontes assume as 3 fontes', () => {
  assert.deepStrictEqual(normalizarRegra({ interesse: { termo: ' invisalign ' } }),
    { interesse: { termo: 'invisalign', em: ['origem', 'conversa', 'anuncio'] } });
});

test('interesse: fontes inválidas são filtradas; sem termo descarta interesse', () => {
  assert.deepStrictEqual(normalizarRegra({ interesse: { termo: 'x', em: ['conversa', 'xpto'] } }),
    { interesse: { termo: 'x', em: ['conversa'] } });
  assert.deepStrictEqual(normalizarRegra({ interesse: { termo: '   ' } }), {});
});

test('status/origem só strings; arrays vazios somem', () => {
  assert.deepStrictEqual(normalizarRegra({ status: ['Novo', 2, null], origem: [] }),
    { status: ['Novo'] });
});

test('periodo: dias inteiro positivo; senão some', () => {
  assert.deepStrictEqual(normalizarRegra({ periodo: { dias: '30' } }),
    { periodo: { campo: 'criado_em', dias: 30 } });
  assert.deepStrictEqual(normalizarRegra({ periodo: { dias: 0 } }), {});
});

test('ddd: só 2 dígitos', () => {
  assert.deepStrictEqual(normalizarRegra({ ddd: ['31', 5, 'abc', '331'] }), { ddd: ['31'] });
});

test('engajamento: booleans e inteiros positivos; chaves inválidas somem', () => {
  assert.deepStrictEqual(
    normalizarRegra({ engajamento: { respondeu: true, ultima_interacao_dias: '15', janela24h: false, recebeu_campanha_id: 7, xpto: 1 } }),
    { engajamento: { respondeu: true, ultima_interacao_dias: 15, janela24h: false, recebeu_campanha_id: 7 } });
  assert.deepStrictEqual(normalizarRegra({ engajamento: { respondeu: 'sim' } }), {});
});
