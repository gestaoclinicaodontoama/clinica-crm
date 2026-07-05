// lib/recuperacao/cadencia.test.js
const test = require('node:test');
const assert = require('node:assert');
const { diasDesde, toqueDevido, podeAutoPerder } = require('./cadencia');

test('diasDesde conta dias inteiros', () => {
  assert.strictEqual(diasDesde('2026-07-01', '2026-07-01'), 0);
  assert.strictEqual(diasDesde('2026-07-01', '2026-07-04'), 3);
  assert.strictEqual(diasDesde('2026-07-01', '2026-07-11'), 10);
});

test('toqueDevido retorna o marco ainda não enviado', () => {
  // 0 toques enviados, dia da falta → D+0 devido
  assert.strictEqual(toqueDevido('2026-07-01', '2026-07-01', 0), 0);
  // D+0 já enviado (1), 3 dias depois → D+3 devido
  assert.strictEqual(toqueDevido('2026-07-01', '2026-07-04', 1), 3);
  // 3 dias mas D+3 já enviado (2) → nada devido ainda
  assert.strictEqual(toqueDevido('2026-07-01', '2026-07-04', 2), null);
  // 7 dias, 2 enviados → D+7 devido
  assert.strictEqual(toqueDevido('2026-07-01', '2026-07-08', 2), 7);
  // 10 dias, 3 enviados → D+10 (auto-Perdido) devido
  assert.strictEqual(toqueDevido('2026-07-01', '2026-07-11', 3), 10);
  // 1 dia só, D+0 enviado → nada ainda
  assert.strictEqual(toqueDevido('2026-07-01', '2026-07-02', 1), null);
});

test('podeAutoPerder exige todas as travas', () => {
  const ok = { leadEncontrado: true, statusLead: 'Avaliação agendada', temConsultaFutura: false, tarefaConcluida: false };
  assert.strictEqual(podeAutoPerder(ok), true);
  assert.strictEqual(podeAutoPerder({ ...ok, leadEncontrado: false }), false); // sem lead
  assert.strictEqual(podeAutoPerder({ ...ok, statusLead: 'Fechou' }), false);   // já cliente
  assert.strictEqual(podeAutoPerder({ ...ok, statusLead: 'Perdido' }), false);
  assert.strictEqual(podeAutoPerder({ ...ok, temConsultaFutura: true }), false); // remarcou
  assert.strictEqual(podeAutoPerder({ ...ok, tarefaConcluida: true }), false);   // CRC já trabalhou
});
