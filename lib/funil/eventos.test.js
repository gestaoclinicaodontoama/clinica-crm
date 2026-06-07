const { test } = require('node:test');
const assert = require('node:assert');
const { montarCoorte } = require('./eventos');

const origemPorLead = new Map([[1, 'Meta Ads'], [2, 'Meta Ads'], [3, 'Indicação']]);

const criadosNoPeriodo = [
  { lead_id: 1, tipo: 'historico_lead_criado', criado_em: '2026-05-02T10:00:00-03:00' },
  { lead_id: 2, tipo: 'historico_lead_criado', criado_em: '2026-05-03T10:00:00-03:00' },
  { lead_id: 3, tipo: 'historico_lead_criado', criado_em: '2026-05-04T10:00:00-03:00' },
];
const eventosDoCoorte = [
  ...criadosNoPeriodo,
  { lead_id: 1, tipo: 'historico_agendado', criado_em: '2026-05-05T10:00:00-03:00' },
  { lead_id: 1, tipo: 'historico_compareceu', criado_em: '2026-05-06T10:00:00-03:00' },
  { lead_id: 1, tipo: 'historico_orcamento', criado_em: '2026-05-07T10:00:00-03:00' },
  { lead_id: 1, tipo: 'historico_fechou', criado_em: '2026-05-10T10:00:00-03:00', metadata: { valor: 20000, entrada: 5000 } },
  { lead_id: 2, tipo: 'historico_agendado', criado_em: '2026-05-06T10:00:00-03:00' },
];

test('conta as 5 etapas em leads distintos', () => {
  const r = montarCoorte(criadosNoPeriodo, eventosDoCoorte, origemPorLead, null);
  const n = Object.fromEntries(r.etapas.map(e => [e.id, e.n]));
  assert.strictEqual(n.leads, 3);
  assert.strictEqual(n.agendados, 2);
  assert.strictEqual(n.compareceram, 1);
  assert.strictEqual(n.orcaram, 1);
  assert.strictEqual(n.fecharam, 1);
});

test('soma Venda e entrada do historico_fechou', () => {
  const r = montarCoorte(criadosNoPeriodo, eventosDoCoorte, origemPorLead, null);
  assert.strictEqual(r.kpis.venda, 20000);
  assert.strictEqual(r.kpis.entrada, 5000);
  assert.strictEqual(r.kpis.fechamentos, 1);
});

test('filtra por origem usando o mapa leadId→origem', () => {
  const r = montarCoorte(criadosNoPeriodo, eventosDoCoorte, origemPorLead, 'Indicação');
  const n = Object.fromEntries(r.etapas.map(e => [e.id, e.n]));
  assert.strictEqual(n.leads, 1);
  assert.strictEqual(n.agendados, 0);
});
