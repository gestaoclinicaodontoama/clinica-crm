const { test } = require('node:test');
const assert = require('node:assert');
const { classificarDia } = require('./registro');

const at = (over = {}) => ({
  paciente_clinicorp_id: 'P1', patient_name: 'Ana', dentist_name: 'Dr. A',
  from_time: '09:00', to_time: '10:00', category: null, compareceu: true, ...over,
});

test('atendido com procedimento no dia → com_registro, com lista de procedimentos', () => {
  const r = classificarDia({
    atendimentos: [at()],
    producao: [{ paciente_clinicorp_id: 'P1', procedure_name: 'Restauração', dentist_name: 'Dr. A' }],
  });
  assert.strictEqual(r.com_registro.length, 1);
  assert.strictEqual(r.sem_registro.length, 0);
  assert.deepStrictEqual(r.com_registro[0].procedimentos, ['Restauração']);
  assert.deepStrictEqual(r.resumo, {
    atendidos: 1, registrados: 1, pendentes: 0,
    por_dentista: [{ dentista: 'Dr. A', atendidos: 1, registrados: 1, pendentes: 0 }],
  });
});

test('atendido sem procedimento → sem_registro (pendente)', () => {
  const r = classificarDia({ atendimentos: [at()], producao: [] });
  assert.strictEqual(r.sem_registro.length, 1);
  assert.strictEqual(r.sem_registro[0].registrado, false);
  assert.strictEqual(r.resumo.pendentes, 1);
});

test('não compareceu → fora de tudo', () => {
  const r = classificarDia({ atendimentos: [at({ compareceu: false })], producao: [] });
  assert.strictEqual(r.resumo.atendidos, 0);
  assert.strictEqual(r.sem_registro.length, 0);
});

test('compareceu null (linha pré-deploy) → fora de tudo', () => {
  const r = classificarDia({ atendimentos: [at({ compareceu: null })], producao: [] });
  assert.strictEqual(r.resumo.atendidos, 0);
});

test('categoria Avaliação → excluída (auditada no Dashboard Comercial)', () => {
  const r = classificarDia({
    atendimentos: [at({ category: 'Avaliação leads internet' }), at({ category: 'avaliação CRC Pós ' })],
    producao: [],
  });
  assert.strictEqual(r.resumo.atendidos, 0);
  assert.strictEqual(r.sem_registro.length, 0);
});

test('categoria Manutenção → seção própria, fora da contagem de pendência', () => {
  const r = classificarDia({ atendimentos: [at({ category: 'Manutenção' })], producao: [] });
  assert.strictEqual(r.manutencao.length, 1);
  assert.strictEqual(r.manutencao[0].registrado, false);
  assert.strictEqual(r.resumo.atendidos, 0);
  assert.strictEqual(r.resumo.pendentes, 0);
});

test('sem paciente_clinicorp_id → pendente com flag sem_id', () => {
  const r = classificarDia({ atendimentos: [at({ paciente_clinicorp_id: '' })], producao: [] });
  assert.strictEqual(r.sem_registro.length, 1);
  assert.strictEqual(r.sem_registro[0].sem_id, true);
});

test('pendentes ordenados por dentista e horário', () => {
  const r = classificarDia({
    atendimentos: [
      at({ patient_name: 'C', dentist_name: 'Dr. B', from_time: '11:00' }),
      at({ patient_name: 'B', dentist_name: 'Dr. A', from_time: '14:00', paciente_clinicorp_id: 'P2' }),
      at({ patient_name: 'A', dentist_name: 'Dr. A', from_time: '08:00', paciente_clinicorp_id: 'P3' }),
    ],
    producao: [],
  });
  assert.deepStrictEqual(r.sem_registro.map(x => x.paciente), ['A', 'B', 'C']);
});

test('dia vazio → tudo zerado', () => {
  const r = classificarDia({ atendimentos: [], producao: [] });
  assert.deepStrictEqual(r.resumo, { atendidos: 0, registrados: 0, pendentes: 0, por_dentista: [] });
});
