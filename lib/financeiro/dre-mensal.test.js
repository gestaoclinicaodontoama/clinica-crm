const { test } = require('node:test');
const assert = require('node:assert');
const { montarDREMensal, listarMeses } = require('./dre-mensal');

test('listarMeses cobre o range inclusive, virando o ano', () => {
  assert.deepEqual(listarMeses('2025-11-01', '2026-02-28'),
    ['2025-11', '2025-12', '2026-01', '2026-02']);
});

test('agrupa linhas por mês e roda montarDRE em cada um', () => {
  const rows = [
    { ym: '2026-05', conta_codigo: '1.2', fluxo: 'entra', total: '1000' },
    { ym: '2026-05', conta_codigo: '2.1', fluxo: 'sai', total: '100' },
    { ym: '2026-06', conta_codigo: '1.2', fluxo: 'entra', total: '2000' },
  ];
  const meses = montarDREMensal(rows, '2026-05-01', '2026-06-30');
  assert.equal(meses.length, 2);
  assert.equal(meses[0].ym, '2026-05');
  assert.equal(meses[0].receita, 1000);
  assert.equal(meses[0].resultado, 900);
  assert.equal(meses[1].resultado, 2000);
});

test('mês sem lançamento entra zerado', () => {
  const rows = [{ ym: '2026-04', conta_codigo: '1.2', fluxo: 'entra', total: '500' }];
  const meses = montarDREMensal(rows, '2026-04-01', '2026-06-30');
  assert.equal(meses.length, 3);
  assert.equal(meses[1].ym, '2026-05');
  assert.equal(meses[1].receita, 0);
  assert.equal(meses[1].resultado, 0);
});
