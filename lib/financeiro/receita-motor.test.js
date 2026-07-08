const { test } = require('node:test');
const assert = require('node:assert');
const M = require('./receita-motor');

const HOJE = '2026-07-08';

test('decomposicao12m: entrada = parcela 0, recorrente = 1+, cancelada fora, sem nº → recorrente', () => {
  const items = [
    { InstallmentNumber: 0, ReceivedDate: '2026-06-10', Amount: 100 },
    { InstallmentNumber: 1, ReceivedDate: '2026-06-15T03:00:00Z', Amount: 50 },
    { InstallmentNumber: 2, ReceivedDate: '2026-06-20', Amount: 25, Canceled: 'X' }, // fora
    { ReceivedDate: '2026-06-21', Amount: 7 },                    // sem nº → recorrente
    { InstallmentNumber: 0, DueDate: '2026-06-05', Amount: 999 }, // não recebida — fora
    { InstallmentNumber: 0, ReceivedDate: '2026-07-01', Amount: 30 },
  ];
  const r = M.decomposicao12m(items, HOJE, 3);
  assert.deepEqual(r.map(x => x.mes), ['2026-05', '2026-06', '2026-07']);
  assert.deepEqual(r[1], { mes: '2026-06', entrada: 100, recorrente: 57 });
  assert.deepEqual(r[2], { mes: '2026-07', entrada: 30, recorrente: 0 });
});

test('taxaRealizacao: só parcelas 1+ de meses fechados; pagou no próprio mês = realizada', () => {
  const items = [
    { InstallmentNumber: 1, DueDate: '2026-06-10', ReceivedDate: '2026-06-12', Amount: 80, PaymentForm: 'Boleto' },  // realizada
    { InstallmentNumber: 2, DueDate: '2026-06-10', ReceivedDate: '2026-07-02', Amount: 20, PaymentForm: 'Boleto' },  // atrasada → não realizada
    { InstallmentNumber: 3, DueDate: '2026-05-10', Amount: 100, PaymentForm: 'Cartão de Crédito' },                  // nunca paga
    { InstallmentNumber: 0, DueDate: '2026-06-10', ReceivedDate: '2026-06-10', Amount: 999 },                        // entrada — fora
    { InstallmentNumber: 1, DueDate: '2026-07-05', ReceivedDate: '2026-07-06', Amount: 999 },                        // mês corrente — fora
  ];
  const r = M.taxaRealizacao(items, HOJE, 6);
  assert.equal(r.geral.base, 200);
  assert.equal(r.geral.realizado, 80);
  assert.equal(r.geral.taxa, 0.4);
  assert.equal(r['Boleto'].taxa, 0.8);
  assert.equal(r['Cartão de Crédito'].taxa, 0);
  assert.equal(r.outras.taxa, null);
});

test('realizacaoPorMes: fração por forma, mês sem base → null', () => {
  const items = [
    { InstallmentNumber: 1, DueDate: '2026-06-10', ReceivedDate: '2026-06-12', Amount: 75, PaymentForm: 'Boleto' },
    { InstallmentNumber: 2, DueDate: '2026-06-15', Amount: 25, PaymentForm: 'Boleto' },
  ];
  const r = M.realizacaoPorMes(items, HOJE, 2);
  assert.deepEqual(r.map(x => x.mes), ['2026-05', '2026-06']);
  assert.equal(r[1].boleto, 0.75);
  assert.equal(r[1].cartao, null);
  assert.equal(r[0].boleto, null);
});

test('mesCorrente: previsto = a vencer no mês × taxa da forma; recebidos separados', () => {
  const realizacao = { geral: { taxa: 0.5 }, 'Boleto': { taxa: 0.8 },
    'Cartão de Crédito': { taxa: null }, outras: { taxa: null } };
  const items = [
    { InstallmentNumber: 1, DueDate: '2026-07-20', Amount: 100, PaymentForm: 'Boleto' },       // 100×0.8
    { InstallmentNumber: 2, DueDate: '2026-07-25', Amount: 100, PaymentForm: 'Pix' },          // outras null → geral 0.5
    { InstallmentNumber: 1, DueDate: '2026-07-05', ReceivedDate: '2026-07-05', Amount: 40, PaymentForm: 'Boleto' }, // vencida no mês E recebida: cru + recebido
    { InstallmentNumber: 0, ReceivedDate: '2026-07-03', Amount: 70 },                          // entrada recebida
    { InstallmentNumber: 1, DueDate: '2026-08-10', Amount: 999 },                              // mês seguinte — fora
    { InstallmentNumber: 1, DueDate: '2026-07-10', Amount: 999, Canceled: 'X' },               // cancelada — fora
  ];
  const r = M.mesCorrente(items, HOJE, realizacao);
  assert.equal(r.recorrenteCru, 240);                 // 100+100+40
  assert.equal(r.recorrentePrevisto, 100 * 0.8 + 100 * 0.5 + 40 * 0.8);
  assert.equal(r.recorrenteRecebido, 40);
  assert.equal(r.entradaRecebida, 70);
});

test('colchao: só parcelas 1+ futuras não recebidas, a partir do mês seguinte, × taxa', () => {
  const items = [
    { InstallmentNumber: 1, DueDate: '2026-08-10', Amount: 200 },
    { InstallmentNumber: 2, DueDate: '2026-09-10', Amount: 200 },
    { InstallmentNumber: 3, DueDate: '2026-10-10', Amount: 50 },
    { InstallmentNumber: 0, DueDate: '2026-08-15', Amount: 999 },                              // entrada futura — fora
    { InstallmentNumber: 1, DueDate: '2026-08-20', ReceivedDate: '2026-07-01', Amount: 999 },  // já recebida — fora
    { InstallmentNumber: 1, DueDate: '2026-07-20', Amount: 999 },                              // mês corrente — fora
  ];
  const r = M.colchao(items, HOJE, 0.5, 90, 3);
  assert.deepEqual(r.meses, [
    { mes: '2026-08', cru: 200, previsto: 100 },
    { mes: '2026-09', cru: 200, previsto: 100 },
    { mes: '2026-10', cru: 50, previsto: 25 },
  ]);
  assert.equal(r.mesesCobertos, 2);                   // ago e set ≥ 90; out não
});

test('colchao: sem régua → mesesCobertos null', () => {
  assert.equal(M.colchao([], HOJE, 0.5, null, 2).mesesCobertos, null);
});
