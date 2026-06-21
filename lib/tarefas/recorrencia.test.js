// lib/tarefas/recorrencia.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { moldeValeNoDia, periodosDoDia } = require('./recorrencia');

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

const COLETA = {
  tipo: 'coleta',
  periodos: [
    { chave: 'manha', rotulo: 'Manhã',      dias_semana: [1,2,3,4,5,6] },
    { chave: 'tarde', rotulo: 'Fim do dia', dias_semana: [1,2,3,4,5] },
  ],
};

test('periodosDoDia: sexta retorna manha e tarde', () => {
  // 2026-06-19 é sexta-feira
  const ps = periodosDoDia(COLETA, '2026-06-19');
  assert.deepStrictEqual(ps.map(p => p.chave), ['manha', 'tarde']);
});

test('periodosDoDia: sabado retorna so manha', () => {
  // 2026-06-20 é sábado
  const ps = periodosDoDia(COLETA, '2026-06-20');
  assert.deepStrictEqual(ps.map(p => p.chave), ['manha']);
});

test('periodosDoDia: domingo retorna vazio', () => {
  // 2026-06-21 é domingo
  const ps = periodosDoDia(COLETA, '2026-06-21');
  assert.deepStrictEqual(ps, []);
});

test('periodosDoDia: template que nao e coleta retorna vazio', () => {
  const ps = periodosDoDia({ tipo: 'tarefa', frequencia: 'diaria' }, '2026-06-19');
  assert.deepStrictEqual(ps, []);
});
