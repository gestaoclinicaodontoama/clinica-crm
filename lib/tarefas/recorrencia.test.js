// lib/tarefas/recorrencia.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { moldeValeNoDia } = require('./recorrencia');

// 2026-06-17 é uma quarta-feira (getDay()=3). 2026-06-15 = segunda (1).
test('diaria sem dias_semana vale todo dia', () => {
  const m = { frequencia: 'diaria', dias_semana: null };
  assert.strictEqual(moldeValeNoDia(m, '2026-06-17'), true);
});

test('diaria com dias_semana so vale nos dias listados', () => {
  const m = { frequencia: 'diaria', dias_semana: [1, 2, 3, 4, 5] }; // seg-sex
  assert.strictEqual(moldeValeNoDia(m, '2026-06-17'), true);  // quarta
  assert.strictEqual(moldeValeNoDia(m, '2026-06-13'), false); // sabado
});

test('semanal vale so no(s) dia(s) da semana', () => {
  const m = { frequencia: 'semanal', dias_semana: [1] }; // toda segunda
  assert.strictEqual(moldeValeNoDia(m, '2026-06-15'), true);  // segunda
  assert.strictEqual(moldeValeNoDia(m, '2026-06-17'), false); // quarta
});

test('mensal vale no dia_mes', () => {
  const m = { frequencia: 'mensal', dia_mes: 17 };
  assert.strictEqual(moldeValeNoDia(m, '2026-06-17'), true);
  assert.strictEqual(moldeValeNoDia(m, '2026-06-18'), false);
});

test('mensal com dia_mes > ultimo dia do mes cai no ultimo dia', () => {
  const m = { frequencia: 'mensal', dia_mes: 31 };
  assert.strictEqual(moldeValeNoDia(m, '2026-02-28'), true);  // fev nao tem 31
  assert.strictEqual(moldeValeNoDia(m, '2026-02-27'), false);
});
