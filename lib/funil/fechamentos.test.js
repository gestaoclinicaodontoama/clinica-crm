// lib/funil/fechamentos.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { agregarFechamentos, temposPorFase } = require('./fechamentos');

// 2 pacientes fecharam em maio. A foi avaliado em maio (mesmo mês), B em abril (anterior).
const orcamentos = [
  { paciente_clinicorp_id: 'A', valor_particular: 10000, entrada_valor: 2000, data_fechamento: '2026-05-10' },
  { paciente_clinicorp_id: 'B', valor_particular: 6000,  entrada_valor: 1000, data_fechamento: '2026-05-20' },
];
const avaliacoesPorPaciente = new Map([
  ['A', [{ data: '2026-05-01' }]],
  ['B', [{ data: '2026-04-15' }]],
]);

test('conta fechamentos, valores, ticket e entradas', () => {
  const r = agregarFechamentos({ orcamentos, avaliacoesPorPaciente });
  assert.strictEqual(r.fechamentos, 2);
  assert.strictEqual(r.valor_fechado, 16000);
  assert.strictEqual(r.entradas_recebidas, 3000);
  assert.strictEqual(r.ticket_medio, 8000);
});

test('tempo médio até fechar e split de origem', () => {
  const r = agregarFechamentos({ orcamentos, avaliacoesPorPaciente });
  // A: 9 dias (01→10), B: 35 dias (04-15→05-20) => média 22
  assert.strictEqual(r.tempo_medio_ate_fechar, 22);
  assert.strictEqual(r.origem_fechamento.mesmo_mes, 1);       // A
  assert.strictEqual(r.origem_fechamento.meses_anteriores, 1); // B
});

test('paciente sem avaliação não entra no tempo nem no split', () => {
  const r = agregarFechamentos({
    orcamentos: [{ paciente_clinicorp_id: 'C', valor_particular: 5000, entrada_valor: 0, data_fechamento: '2026-05-05' }],
    avaliacoesPorPaciente: new Map(),
  });
  assert.strictEqual(r.fechamentos, 1);
  assert.strictEqual(r.tempo_medio_ate_fechar, null);
  assert.strictEqual(r.origem_fechamento.mesmo_mes, 0);
  assert.strictEqual(r.origem_fechamento.meses_anteriores, 0);
});

test('tempos por fase clínica e leads (médias em dias)', () => {
  const avaliacoes = [
    { paciente_clinicorp_id: 'A', agendado_em: '2026-05-01T09:00:00Z', comparecimento_em: '2026-05-03T09:00:00Z' }, // 2d
  ];
  const fechamentoPorPaciente = new Map([['A', '2026-05-13']]); // compareceu 05-03 → fechou 05-13 = 10d
  const leads = [
    { id: 1, data_lead: '2026-05-01', data_agendamento: '2026-05-05', data_comparecimento: '2026-05-08' }, // 4d, 3d
  ];
  const fechamentoPorLead = new Map([[1, '2026-05-18']]); // compareceu 05-08 → fechou 05-18 = 10d

  const r = temposPorFase({ avaliacoes, fechamentoPorPaciente, leads, fechamentoPorLead });
  assert.strictEqual(r.clinica.agendou_compareceu, 2);
  assert.strictEqual(r.clinica.compareceu_fechou, 10);
  assert.strictEqual(r.leads.lead_agendou, 4);
  assert.strictEqual(r.leads.agendou_compareceu, 3);
  assert.strictEqual(r.leads.compareceu_fechou, 10);
});

test('fases sem dados retornam null', () => {
  const r = temposPorFase({ avaliacoes: [], fechamentoPorPaciente: new Map(), leads: [], fechamentoPorLead: new Map() });
  assert.strictEqual(r.clinica.agendou_compareceu, null);
  assert.strictEqual(r.leads.lead_agendou, null);
});
