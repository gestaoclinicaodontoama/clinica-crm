// lib/financeiro/inadimplencia.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { agregarPorPaciente, classificarESepararGrupos, inadimplenciaReal, diffSnapshotParcelas, agregarRenegociacoes } = require('./inadimplencia');

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

test('diffSnapshotParcelas: renegociação (sumida+nova), cancelamento (sumida sem nova)', () => {
  const anterior = [
    { posicao: 'T1|2', treatment_id: 'T1', installment: 2, patient_id: 'A', patient_name: 'Ana', due_date: '2026-07-20', valor: 300 },
    { posicao: 'T2|1', treatment_id: 'T2', installment: 1, patient_id: 'B', patient_name: 'Bia', due_date: '2026-07-10', valor: 100 },
    { posicao: 'T3|1', treatment_id: 'T3', installment: 1, patient_id: 'C', patient_name: 'Caio', due_date: '2026-08-01', valor: 50 },
  ];
  const items = [
    // T1: posição 2 sumiu, mas apareceram 2 novas (3 e 4) → renegociação 300→(150+150)
    { TreatmentId: 'T1', InstallmentNumber: 1, ReceivedDate: '2026-06-01', Amount: 100, PatientId: 'A', PatientName: 'Ana (1)' },
    { TreatmentId: 'T1', InstallmentNumber: 3, DueDate: '2026-08-20', Amount: 150, PatientId: 'A', PatientName: 'Ana (1)' },
    { TreatmentId: 'T1', InstallmentNumber: 4, DueDate: '2026-09-20', Amount: 150, PatientId: 'A', PatientName: 'Ana (1)' },
    // T2: posição sumiu SEM nova, treatment ainda presente → cancelamento
    { TreatmentId: 'T2', InstallmentNumber: 0, ReceivedDate: '2026-05-01', Amount: 80, PatientId: 'B', PatientName: 'Bia (2)' },
    // T3: continua aberta, intacta
    { TreatmentId: 'T3', InstallmentNumber: 1, DueDate: '2026-08-01', Amount: 50, PatientId: 'C', PatientName: 'Caio (3)' },
  ];
  const r = diffSnapshotParcelas(anterior, items, '2026-07-08');
  assert.equal(r.abortado, null);
  assert.equal(r.eventos.length, 2);
  const ren = r.eventos.find(e => e.tipo === 'renegociacao');
  assert.equal(ren.treatment_id, 'T1');
  assert.equal(ren.valor_antigo, 300);
  assert.equal(ren.valor_novo, 300);
  assert.deepEqual(ren.detalhes.novas.sort(), ['T1|3', 'T1|4']);
  const canc = r.eventos.find(e => e.tipo === 'cancelamento');
  assert.equal(canc.treatment_id, 'T2');
  assert.equal(canc.valor_novo, 0);
  assert.ok(r.abertasAtuais.find(x => x.posicao === 'T3|1'));
});

test('diffSnapshotParcelas: guardas — janela, recebida entre fotos, snapshot vazio, rodada dupla, freio 20%', () => {
  // janela: T9 sumiu INTEIRO do payload → nada
  const r1 = diffSnapshotParcelas([{ posicao: 'T9|1', treatment_id: 'T9', valor: 100 }], [
    { TreatmentId: 'T8', InstallmentNumber: 1, DueDate: '2026-08-01', Amount: 10 }], '2026-07-08');
  assert.equal(r1.eventos.length, 0);
  // recebida entre as fotos: posição está no payload como RECEBIDA → não é sumida
  const r2 = diffSnapshotParcelas([{ posicao: 'T8|1', treatment_id: 'T8', valor: 10 }], [
    { TreatmentId: 'T8', InstallmentNumber: 1, ReceivedDate: '2026-07-07', Amount: 10 }], '2026-07-08');
  assert.equal(r2.eventos.length, 0);
  // snapshot vazio → sem eventos
  const r3 = diffSnapshotParcelas([], [{ TreatmentId: 'T1', InstallmentNumber: 1, DueDate: '2026-08-01', Amount: 5 }], '2026-07-08');
  assert.equal(r3.eventos.length, 0);
  assert.equal(r3.abertasAtuais.length, 1);
  // rodada dupla: snapshot == payload → nada
  const r4 = diffSnapshotParcelas(r3.abertasAtuais, [{ TreatmentId: 'T1', InstallmentNumber: 1, DueDate: '2026-08-01', Amount: 5 }], '2026-07-08');
  assert.equal(r4.eventos.length, 0);
  // freio: 60 de 100 posições somem (>50 E >20%) com treatments ainda presentes → aborta
  const ant = Array.from({ length: 100 }, (_, i) => ({ posicao: `T${i}|1`, treatment_id: `T${i}`, valor: 10 }));
  const itens5 = Array.from({ length: 100 }, (_, i) =>
    i < 60 ? { TreatmentId: `T${i}`, InstallmentNumber: 9, DueDate: '2026-08-01', Amount: 10 }   // posição 1 sumiu, treatment presente
           : { TreatmentId: `T${i}`, InstallmentNumber: 1, DueDate: '2026-08-01', Amount: 10 }); // intacta
  const r5 = diffSnapshotParcelas(ant, itens5, '2026-07-08');
  assert.ok(r5.abortado);
  assert.equal(r5.eventos.length, 0);
  // abaixo do piso: as MESMAS 2 sumidas de 3 do teste anterior NÃO abortam (67% mas < 50 absolutas)
});

test('agregarRenegociacoes: porMes, reincidente, desde, flags', () => {
  const eventos = [
    { tipo: 'inicio', data: '2026-07-09' },
    { tipo: 'renegociacao', data: '2026-07-15', treatment_id: 'T1', patient_id: 'A', valor_novo: 300 },
    { tipo: 'renegociacao', data: '2026-08-02', treatment_id: 'T2', patient_id: 'B', valor_novo: 100 },
    { tipo: 'cancelamento', data: '2026-07-20', treatment_id: 'T3', patient_id: 'C', valor_novo: 0 },
  ];
  const items = [ // T1 tem vencida aberta hoje → reincidente; T2 em dia
    { TreatmentId: 'T1', InstallmentNumber: 3, DueDate: '2026-08-20', Amount: 150 },
    { TreatmentId: 'T1', InstallmentNumber: 4, DueDate: '2026-09-01', Amount: 150 },
    { TreatmentId: 'T1', InstallmentNumber: 5, DueDate: '2026-07-01', Amount: 50 },   // vencida aberta
    { TreatmentId: 'T2', InstallmentNumber: 1, DueDate: '2026-12-01', Amount: 100 },
  ];
  const r = agregarRenegociacoes(eventos, items, '2026-09-10');
  assert.equal(r.desde, '2026-07-09');
  assert.equal(r.total, 400);
  assert.equal(r.reincidente, 300);
  assert.equal(r.pctReincidencia, 0.75);
  assert.equal(r.nPacientes, 2);
  assert.deepEqual(r.porMes, [{ mes: '2026-07', valor: 300, n: 1 }, { mes: '2026-08', valor: 100, n: 1 }]);
  assert.equal(r.flags.get('A').quebrouReneg, true);
  assert.equal(r.flags.get('B').quebrouReneg, false);
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

test('agregarPorPaciente: anexa parcelas vencidas/futuras que somam exatamente os totais', () => {
  const items = [
    { PatientId: 'A', PatientName: 'Ana (1)', DueDate: '2026-06-01', Amount: 100.55, PaymentForm: 'Boleto' },
    { PatientId: 'A', DueDate: '2026-05-01', Amount: 50, PaymentForm: 'Pix' },
    { PatientId: 'A', DueDate: '2026-08-01', Amount: 70, PaymentForm: 'Cartão de Crédito' },
    { PatientId: 'A', ReceivedDate: '2026-01-10', Amount: 999 },   // paga — fora das listas
  ];
  const [a] = agregarPorPaciente(items, '2026-07-08');
  assert.deepEqual(a.parcelasVencidas.map(x => x.due), ['2026-05-01', '2026-06-01']); // ordenadas
  assert.equal(a.parcelasVencidas[1].forma, 'Boleto');
  const somaV = a.parcelasVencidas.reduce((s, x) => s + x.valor, 0);
  assert.ok(Math.abs(somaV - a.overdueAmount) < 0.011);
  assert.equal(a.parcelasFuturas.length, 1);
  assert.equal(a.parcelasFuturas[0].valor, 70);
  const somaF = a.parcelasFuturas.reduce((s, x) => s + x.valor, 0);
  assert.ok(Math.abs(somaF - a.futureAmount) < 0.011);
});
