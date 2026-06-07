const { test } = require('node:test');
const assert = require('node:assert');
const { serieTemporal, porDiaSemana } = require('./series');

const eventos = [
  { tipo: 'historico_lead_criado', criado_em: '2026-06-01T12:00:00-03:00' }, // segunda
  { tipo: 'historico_lead_criado', criado_em: '2026-06-01T15:00:00-03:00' },
  { tipo: 'historico_compareceu',  criado_em: '2026-06-02T10:00:00-03:00' }, // terça
  { tipo: 'historico_fechou',      criado_em: '2026-06-02T11:00:00-03:00' },
];

test('serieTemporal agrupa por dia contando leads/comparecimentos/fechamentos', () => {
  const pts = serieTemporal(eventos, 'dia');
  const d1 = pts.find(p => p.data === '2026-06-01');
  const d2 = pts.find(p => p.data === '2026-06-02');
  assert.strictEqual(d1.leads, 2);
  assert.strictEqual(d2.comparecimentos, 1);
  assert.strictEqual(d2.fechamentos, 1);
});

test('porDiaSemana soma leads e fechamentos por dia da semana (seg..dom)', () => {
  const dows = porDiaSemana(eventos);
  assert.strictEqual(dows.find(d => d.dia === 'seg').leads, 2);
  assert.strictEqual(dows.find(d => d.dia === 'ter').fechamentos, 1);
});
