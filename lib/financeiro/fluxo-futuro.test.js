// lib/financeiro/fluxo-futuro.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseCashFlow, janela24m, janelasDe12m, totais, agruparParcelasPorMes } = require('./fluxo-futuro');

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

test('janelasDe12m: fatia os 25 meses em chamadas de ≤12 meses (API trunca por chamada)', () => {
  assert.deepEqual(janelasDe12m('2026-07-02'), [
    { from: '2026-07-02', to: '2027-06-30' },
    { from: '2027-07-01', to: '2028-06-30' },
    { from: '2028-07-01', to: '2028-07-31' },
  ]);
  assert.deepEqual(janelasDe12m('2026-01-15'), [
    { from: '2026-01-15', to: '2026-12-31' },
    { from: '2027-01-01', to: '2027-12-31' },
    { from: '2028-01-01', to: '2028-01-31' },
  ]);
  // a última janela termina onde a janela24m terminava
  assert.equal(janelasDe12m('2026-07-02')[2].to, janela24m('2026-07-02').to);
});

test('agruparParcelasPorMes: agrupa não-recebidas por mês de vencimento, range completo com zeros', () => {
  const items = [
    { PatientId: 1, DueDate: '2026-07-15', Amount: 100 },                            // futuro, jul
    { PatientId: 1, DueDate: '2026-07-20', AmountWithDiscounts: 50, Amount: 60 },    // usa WithDiscounts
    { PatientId: 2, DueDate: '2026-09-01', Amount: 200 },                            // futuro, set (pula ago)
    { PatientId: 2, DueDate: '2026-07-01', Amount: 999 },                            // VENCIDA (antes de hoje) — fora
    { PatientId: 3, DueDate: '2026-08-10', Amount: 300, PaymentReceived: 'X' },      // recebida — fora
    { PatientId: 3, DueDate: '2026-08-11', Amount: 70, ReceivedDate: '2026-06-01' }, // recebida — fora
    { PatientId: 3, DueDate: '2026-08-12', Amount: 40, ReceivedDate: '0001-01-01' }, // NÃO recebida (data nula)
    { PatientId: 4, DueDate: '2029-01-01', Amount: 500 },                            // além dos 24m — fora
    { PatientId: 5, Amount: 500 },                                                   // sem DueDate — fora
  ];
  const meses = agruparParcelasPorMes(items, '2026-07-02');
  assert.equal(meses.length, 25); // mês corrente + 24
  assert.deepEqual(meses[0], { mes: '2026-07', valor: 150 });
  assert.deepEqual(meses[1], { mes: '2026-08', valor: 40 });
  assert.deepEqual(meses[2], { mes: '2026-09', valor: 200 });
  assert.equal(meses[24].mes, '2028-07');
  assert.equal(meses[24].valor, 0);
});

test('agruparParcelasPorMes: vazio/nulo → range zerado', () => {
  const meses = agruparParcelasPorMes(null, '2026-01-15');
  assert.equal(meses.length, 25);
  assert.deepEqual(meses[0], { mes: '2026-01', valor: 0 });
  assert.equal(meses[12].mes, '2027-01');
  assert.equal(meses.every(m => m.valor === 0), true);
});

test('totais soma e calcula diferença', () => {
  assert.deepEqual(totais([{ a_receber: 100, a_pagar: 40 }, { a_receber: 50, a_pagar: 200 }]),
    { receber: 150, pagar: 240, diferenca: -90 });
});
