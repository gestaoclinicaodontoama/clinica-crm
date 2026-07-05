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
