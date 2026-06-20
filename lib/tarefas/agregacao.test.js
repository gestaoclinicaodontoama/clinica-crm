const { test } = require('node:test');
const assert = require('node:assert');
const { somarLista, calcularConversoes } = require('./agregacao');

test('somarLista: dobra linhas {chave,total} num objeto', () => {
  const obj = somarLista([
    { chave: 'ligacoes', total: 20 },
    { chave: 'agendados', total: 5 },
  ]);
  assert.deepStrictEqual(obj, { ligacoes: 20, agendados: 5 });
});

test('somarLista: lista vazia vira objeto vazio', () => {
  assert.deepStrictEqual(somarLista([]), {});
});

test('calcularConversoes: taxa = para / de', () => {
  const somas = { ligacoes: 100, agendados: 25 };
  const conv = [{ de: 'ligacoes', para: 'agendados', rotulo: 'Taxa de agendamento' }];
  const out = calcularConversoes(somas, conv);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].rotulo, 'Taxa de agendamento');
  assert.strictEqual(out[0].valor_de, 100);
  assert.strictEqual(out[0].valor_para, 25);
  assert.strictEqual(out[0].taxa, 0.25);
});

test('calcularConversoes: divisao por zero retorna taxa null', () => {
  const out = calcularConversoes({ ligacoes: 0, agendados: 0 },
    [{ de: 'ligacoes', para: 'agendados', rotulo: 'x' }]);
  assert.strictEqual(out[0].taxa, null);
});

test('calcularConversoes: chave ausente conta como 0', () => {
  const out = calcularConversoes({ ligacoes: 10 },
    [{ de: 'ligacoes', para: 'agendados', rotulo: 'x' }]);
  assert.strictEqual(out[0].valor_para, 0);
  assert.strictEqual(out[0].taxa, 0);
});

test('calcularConversoes: sem conversoes retorna vazio', () => {
  assert.deepStrictEqual(calcularConversoes({ a: 1 }, []), []);
  assert.deepStrictEqual(calcularConversoes({ a: 1 }, null), []);
});
