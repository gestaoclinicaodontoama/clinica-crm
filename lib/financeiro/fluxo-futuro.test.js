// lib/financeiro/fluxo-futuro.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseCashFlow, janela24m, totais } = require('./fluxo-futuro');

test('parseCashFlow deriva o ano pela ordem, virando o ano', () => {
  const resposta = [
    { month: 'November', in_forecast: 96322.39, out_forecast: 200221.9 },
    { month: 'December', in_forecast: 90672.46, out_forecast: 194379.97 },
    { month: 'January',  in_forecast: 83624.62, out_forecast: 95960.88 },
  ];
  const meses = parseCashFlow(resposta, '2026-11-01');
  assert.deepEqual(meses.map(x => x.mes), ['2026-11', '2026-12', '2027-01']);
  assert.equal(meses[2].a_pagar, 95960.88);
  assert.equal(meses[0].a_receber, 96322.39);
});

test('mês pulado pela API não desloca os seguintes', () => {
  const meses = parseCashFlow([
    { month: 'November', in_forecast: 1, out_forecast: 1 },
    { month: 'January',  in_forecast: 2, out_forecast: 2 },
  ], '2026-11-01');
  assert.deepEqual(meses.map(x => x.mes), ['2026-11', '2027-01']);
});

test('resposta vazia, nula ou com mês desconhecido → ignora', () => {
  assert.deepEqual(parseCashFlow([], '2026-07-01'), []);
  assert.deepEqual(parseCashFlow(null, '2026-07-01'), []);
  assert.deepEqual(parseCashFlow([{ month: 'Julho', in_forecast: 1 }], '2026-07-01'), []);
});

test('forecast ausente vira 0', () => {
  const [m] = parseCashFlow([{ month: 'July' }], '2026-07-01');
  assert.equal(m.a_receber, 0);
  assert.equal(m.a_pagar, 0);
});

test('janela24m: de hoje até o último dia do 24º mês à frente', () => {
  assert.deepEqual(janela24m('2026-07-02'), { from: '2026-07-02', to: '2028-07-31' });
  assert.deepEqual(janela24m('2026-01-15'), { from: '2026-01-15', to: '2028-01-31' });
});

test('totais soma e calcula diferença', () => {
  assert.deepEqual(totais([{ a_receber: 100, a_pagar: 40 }, { a_receber: 50, a_pagar: 200 }]),
    { receber: 150, pagar: 240, diferenca: -90 });
});
