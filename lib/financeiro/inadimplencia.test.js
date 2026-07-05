// lib/financeiro/inadimplencia.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { agregarPorPaciente, classificarESepararGrupos } = require('./inadimplencia');

const HOJE = '2026-07-05';

test('agregarPorPaciente: só pacientes com parcela vencida; soma vencido/futuro/pago', () => {
  const items = [
    { PatientId: 'A', PatientName: 'Ana (1)', DueDate: '2026-06-01', Amount: 100, PayerName: 'Mãe A', PayerPhone: '31999', BoletoUrl: 'u1', BoletoDigitalLine: 'l1', PaymentForm: 'Boleto' }, // vencida
    { PatientId: 'A', DueDate: '2026-05-01', Amount: 50 },                                   // vencida mais antiga
    { PatientId: 'A', DueDate: '2026-08-01', Amount: 200 },                                  // futura
    { PatientId: 'A', DueDate: '2026-04-01', Amount: 30, PaymentReceived: 'X' },             // paga
    { PatientId: 'B', DueDate: '2026-09-01', Amount: 500 },                                  // só futura → fora
  ];
  const pac = agregarPorPaciente(items, HOJE);
  assert.equal(pac.length, 1);
  const a = pac[0];
  assert.equal(a.id, 'A');
  assert.equal(a.name, 'Ana');            // sufixo "(1)" removido
  assert.equal(a.overdueAmount, 150);
  assert.equal(a.futureAmount, 200);
  assert.equal(a.overdueCount, 2);
  assert.equal(a.pago, 30);
  assert.equal(a.oldestDueDate, '2026-05-01');
  // boleto/pagador vêm da vencida em aberto MAIS ANTIGA (a de 2026-05-01 não tem boleto → cai p/ a que tem)
  assert.equal(a.payerName, 'Mãe A');
  assert.equal(a.boletoUrl, 'u1');
  assert.equal(a.paymentForm, 'Boleto');
});

test('classificar: Crítico exige exposição (entregue > pago) E parado (sem futura e sem consulta)', () => {
  const pacientes = [
    // C1: sem futura, entregue 1000 > pago 100, sem consulta → CRÍTICO (3)
    { id: 'C1', overdueAmount: 900, overdueCount: 3, futureAmount: 0, pago: 100 },
    // C2: sem futura, mas entregue 0 (não começou) → NÃO é crítico; 1 vencida → grupo 1
    { id: 'C2', overdueAmount: 200, overdueCount: 1, futureAmount: 0, pago: 0 },
    // C3: tem futura, 2 vencidas → Renegociação (2)
    { id: 'C3', overdueAmount: 300, overdueCount: 2, futureAmount: 400, pago: 50 },
    // C4: tem futura, 1 vencida → Em Cobrança (1)
    { id: 'C4', overdueAmount: 80, overdueCount: 1, futureAmount: 400, pago: 50 },
  ];
  const r = classificarESepararGrupos(pacientes, {
    entregueMap: new Map([['C1', 1000], ['C2', 0], ['C3', 0], ['C4', 0]]),
    consultaFuturaSet: new Set(['C4']),
    veioRecenteSet: new Set(['C3']),
  });
  assert.deepEqual(r.grupo3.map(p => p.id), ['C1']);
  assert.deepEqual(r.grupo1.map(p => p.id).sort(), ['C2', 'C4']);
  assert.deepEqual(r.grupo2.map(p => p.id), ['C3']);
  assert.equal(r.totais.criticos, 1);
  // selos
  assert.equal(r.grupo3[0].exposicao, 'vermelho');
  assert.equal(r.grupo3[0].engajamento, 'sumiu');
  assert.equal(r.grupo1.find(p => p.id === 'C4').engajamento, 'futuro');
  assert.equal(r.grupo2[0].engajamento, 'recente');
});

test('classificar: totais somam valorTotal do vencido', () => {
  const r = classificarESepararGrupos(
    [{ id: 'X', overdueAmount: 100, overdueCount: 1, futureAmount: 0, pago: 0 }],
    { entregueMap: new Map(), consultaFuturaSet: new Set(), veioRecenteSet: new Set() });
  assert.equal(r.totais.valorTotal, 100);
  assert.equal(r.totais.pacientes, 1);
});
