// lib/financeiro/inadimplencia.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { agregarPorPaciente, classificarESepararGrupos, detectarRenegociados, inadimplenciaReal } = require('./inadimplencia');

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

test('agregarPorPaciente: payer/paymentForm vêm da parcela vencida MAIS ANTIGA, não da primeira do array', () => {
  const items = [
    // Mais NOVA aparece PRIMEIRO no array — não deve vencer.
    { PatientId: 'A', PatientName: 'Ana', DueDate: '2026-06-20', Amount: 100, PayerName: 'Novo Pagador', PayerPhone: '31900000', PaymentForm: 'Pix' },
    // Mais ANTIGA aparece DEPOIS — deve ser a fonte de payer/paymentForm.
    { PatientId: 'A', DueDate: '2026-05-10', Amount: 80, PayerName: 'Pagador Antigo', PayerPhone: '31911111', PaymentForm: 'Boleto' },
  ];
  const pac = agregarPorPaciente(items, HOJE);
  assert.equal(pac.length, 1);
  const a = pac[0];
  assert.equal(a.payerName, 'Pagador Antigo');
  assert.equal(a.payerPhone, '31911111');
  assert.equal(a.paymentForm, 'Boleto');
});

test('agregarPorPaciente: diasDeAtraso e diasParaProximo calculados corretamente', () => {
  const items = [
    { PatientId: 'D', DueDate: '2026-06-25', Amount: 100 }, // 10 dias de atraso (HOJE=2026-07-05)
    { PatientId: 'D', DueDate: '2026-07-15', Amount: 200 }, // 10 dias até a próxima
  ];
  const pac = agregarPorPaciente(items, HOJE);
  const d = pac[0];
  assert.equal(d.diasDeAtraso, 10);
  assert.equal(d.diasParaProximo, 10);
});

test('classificar: exposicao verde quando pago >= entregue', () => {
  const pacientes = [
    { id: 'V1', overdueAmount: 100, overdueCount: 1, futureAmount: 0, pago: 500 },
  ];
  const r = classificarESepararGrupos(pacientes, {
    entregueMap: new Map([['V1', 300]]),
    consultaFuturaSet: new Set(),
    veioRecenteSet: new Set(),
  });
  const v = r.grupo1.find(p => p.id === 'V1');
  assert.equal(v.exposicao, 'verde');
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

test('detectarRenegociados: posição cancelada+reemitida; reincidente = ativa vencida', () => {
  const items = [
    { TreatmentId: 'T1', InstallmentNumber: 1, Canceled: 'X', Amount: 100, PatientId: 'A' },
    { TreatmentId: 'T1', InstallmentNumber: 1, Amount: 100, DueDate: '2026-06-01', PatientId: 'A' },  // reemitida, vencida → quebrou
    { TreatmentId: 'T2', InstallmentNumber: 0, Canceled: 'X', Amount: 50, PatientId: 'B' },
    { TreatmentId: 'T2', InstallmentNumber: 0, Amount: 50, DueDate: '2026-08-01', PatientId: 'B' },   // reemitida, a vencer → em dia
    { TreatmentId: 'T3', InstallmentNumber: 2, Canceled: 'X', Amount: 999, PatientId: 'C' },          // cancelada SEM reemissão → não conta
    { TreatmentId: 'T4', InstallmentNumber: 1, Amount: 999, DueDate: '2026-06-01', PatientId: 'D' },  // ativa sem cancelada → não conta
  ];
  const r = detectarRenegociados(items, '2026-07-08');
  assert.equal(r.total, 150);
  assert.equal(r.reincidente, 100);
  assert.equal(r.emDia, 50);
  assert.ok(Math.abs(r.pctReincidencia - 0.667) < 0.001);
  assert.equal(r.nPacientes, 2);
  assert.equal(r.porPaciente.get('A').quebrouReneg, true);
  assert.equal(r.porPaciente.get('B').quebrouReneg, false);
});

test('inadimplenciaReal: 3 classes, agregados A/B, semProducao', () => {
  const pacientes = [
    { id: '1', overdueAmount: 100, pago: 50, entregue: 300, engajamento: 'sumiu' },   // real: B=250
    { id: '2', overdueAmount: 80, pago: 50, entregue: 200, engajamento: 'futuro' },   // exposto_vem
    { id: '3', overdueAmount: 60, pago: 500, entregue: 100, engajamento: 'sumiu' },   // credor
    { id: '4', overdueAmount: 40, pago: 10, entregue: 0, engajamento: 'sumiu' },      // credor + semProducao
  ];
  const agg = inadimplenciaReal(pacientes);
  assert.equal(agg.real.n, 1);
  assert.equal(agg.real.vencidoA, 100);
  assert.equal(agg.real.exposicaoB, 250);
  assert.equal(agg.exposto_vem.vencidoA, 80);
  assert.equal(agg.credor.n, 2);
  assert.equal(agg.semProducao, 1);
  assert.equal(pacientes[0].classeReal, 'real');
  assert.equal(pacientes[3].semProducao, true);
});

test('classificarESepararGrupos: quem quebrou renegociação vai pro topo do grupo', () => {
  const pacientes = [
    { id: 'x', overdueCount: 2, overdueAmount: 900, futureAmount: 0, pago: 0, quebrouReneg: false },
    { id: 'y', overdueCount: 2, overdueAmount: 100, futureAmount: 0, pago: 0, quebrouReneg: true },
  ];
  const r = classificarESepararGrupos(pacientes, {});
  assert.equal(r.grupo2[0].id, 'y');   // reincidente primeiro, mesmo com vencido menor
});
