// lib/financeiro/recuperacao.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { recuperacaoPorMes, vencidoRetroativo } = require('./recuperacao');

const HOJE = '2026-07-15';

test('recuperacaoPorMes: coorte por mês de vencimento; atrasada=não paga ou paga após vencimento', () => {
  const items = [
    { DueDate: '2026-05-10', Amount: 100 },                                 // maio, não paga → atrasou
    { DueDate: '2026-05-20', Amount: 200, ReceivedDate: '2026-06-01' },     // maio, paga atrasada → atrasou+recuperado
    { DueDate: '2026-06-10', Amount: 50,  ReceivedDate: '2026-06-05' },     // junho, paga adiantada → fora
    { DueDate: '2026-06-15', Amount: 80 },                                  // junho, não paga → atrasou
    { DueDate: '2026-07-01', Amount: 300, ReceivedDate: '2026-07-01' },     // julho, paga no dia → fora
  ];
  const r = recuperacaoPorMes(items, HOJE, 3); // maio, junho, julho
  assert.deepEqual(r.map(x => x.mes), ['2026-05', '2026-06', '2026-07']);
  assert.deepEqual(r[0], { mes: '2026-05', atrasou: 300, recuperado: 200, taxa: 0.667 });
  assert.deepEqual(r[1], { mes: '2026-06', atrasou: 80,  recuperado: 0,   taxa: 0 });
  assert.deepEqual(r[2], { mes: '2026-07', atrasou: 0,   recuperado: 0,   taxa: null });
});

test('recuperacaoPorMes: parcela do mês corrente que ainda não venceu não conta como atrasou', () => {
  const items = [
    { DueDate: '2026-07-10', Amount: 300 },   // julho, já venceu (hoje=15), não paga → atrasou
    { DueDate: '2026-07-20', Amount: 500 },   // julho, ainda não venceu, não paga → NÃO deve contar
  ];
  const r = recuperacaoPorMes(items, HOJE, 1); // só julho
  assert.deepEqual(r[0], { mes: '2026-07', atrasou: 300, recuperado: 0, taxa: 0 });
});

test('vencidoRetroativo: saldo vencido no fim de cada mês; paga em dia não conta; mês atual corta em hoje', () => {
  const items = [
    { DueDate: '2026-04-10', Amount: 100 },                                 // não paga → vencida em todos
    { DueDate: '2026-05-20', Amount: 200, ReceivedDate: '2026-06-10' },     // vencida só em maio (paga em jun/10)
    { DueDate: '2026-06-05', Amount: 50,  ReceivedDate: '2026-06-04' },     // paga (rec<=due-ish) → nunca vencida
    { DueDate: '2026-07-10', Amount: 400 },                                 // não paga; entra só em julho (due<=15/07)
  ];
  const r = vencidoRetroativo(items, HOJE, 3); // fins: maio-31, junho-30, julho-15(hoje)
  assert.deepEqual(r, [
    { mes: '2026-05', vencido: 300 },  // 100 + 200
    { mes: '2026-06', vencido: 100 },  // 100
    { mes: '2026-07', vencido: 500 },  // 100 + 400
  ]);
});

const { pontoDesistencia } = require('./recuperacao');

test('pontoDesistencia: parou na parcela N e faltando pro fim (plano que travou)', () => {
  const items = [
    { TreatmentId: 'A', InstallmentNumber: 0, ReceivedDate: '2026-01-01' },
    { TreatmentId: 'A', InstallmentNumber: 1, ReceivedDate: '2026-02-01' },
    { TreatmentId: 'A', InstallmentNumber: 2, ReceivedDate: '2026-03-01' },
    { TreatmentId: 'A', InstallmentNumber: 3, DueDate: '2026-04-01' }, // não paga, vencida
  ];
  const r = pontoDesistencia(items, '2026-07-15');
  assert.equal(r.totalTravados, 1);
  assert.deepEqual(r.parouEm, [{ parcela: 3, planos: 1 }]);   // planLen 4, ultimaPaga 2 → parou na 3
  assert.deepEqual(r.faltando, [{ faltam: 1, planos: 1 }]);   // 4 - 3 = 1
  assert.equal(r.modaParouEm, 3);
});

test('pontoDesistencia: ignora Canceled + dedup por posição (renegociação)', () => {
  const items = [
    { TreatmentId: 'B', InstallmentNumber: 0, ReceivedDate: '2026-01-01' },
    { TreatmentId: 'B', InstallmentNumber: 1, Canceled: 'X', DueDate: '2026-02-01' }, // cancelada → ignora
    { TreatmentId: 'B', InstallmentNumber: 1, ReceivedDate: '2026-02-05' },           // renegociada, paga
    { TreatmentId: 'B', InstallmentNumber: 2, DueDate: '2026-03-01' },                // não paga, vencida
  ];
  const r = pontoDesistencia(items, '2026-07-15');
  assert.equal(r.totalTravados, 1);
  assert.deepEqual(r.parouEm, [{ parcela: 2, planos: 1 }]);   // planLen 3, ultimaPaga 1 (dedup paga) → parou na 2
  assert.deepEqual(r.faltando, [{ faltam: 1, planos: 1 }]);
});

test('pontoDesistencia: exclui quitado e em-dia; entrada nunca paga = parcela 0; faltando 10+', () => {
  const items = [
    // C: quitado (tudo pago) → fora
    { TreatmentId: 'C', InstallmentNumber: 0, ReceivedDate: '2026-01-01' },
    { TreatmentId: 'C', InstallmentNumber: 1, ReceivedDate: '2026-02-01' },
    // D: em-dia (próxima ainda não venceu) → fora
    { TreatmentId: 'D', InstallmentNumber: 0, ReceivedDate: '2026-01-01' },
    { TreatmentId: 'D', InstallmentNumber: 1, DueDate: '2026-12-01' }, // futura
    // E: nunca pagou, entrada vencida, plano de 12 → parou na 0, faltando 12 → bucket 10
    ...Array.from({ length: 12 }, (_, i) => ({ TreatmentId: 'E', InstallmentNumber: i, DueDate: '2026-04-01' })),
  ];
  const r = pontoDesistencia(items, '2026-07-15');
  assert.equal(r.totalTravados, 1);                          // só E
  assert.deepEqual(r.parouEm, [{ parcela: 0, planos: 1 }]);
  assert.deepEqual(r.faltando, [{ faltam: 10, planos: 1 }]); // 12 → "10+"
  assert.equal(r.modaParouEm, 0);
});
