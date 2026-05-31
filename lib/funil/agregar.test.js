const { test } = require('node:test');
const assert = require('node:assert');
const { agregarFunil } = require('./agregar');

// Cenário: 2 leads, ambos viraram avaliação (1 compareceu), 1 fechou.
const leads = [
  { id: 1, telefone: '31999990001', origem: 'invisalign', created_at: '2026-05-02' },
  { id: 2, telefone: '31999990002', origem: 'protocolo',  created_at: '2026-05-03' },
];
const avaliacoes = [
  { paciente_clinicorp_id: 'A', telefone: '31999990001', data: '2026-05-05', compareceu: true,  lead_id: 1 },
  { paciente_clinicorp_id: 'B', telefone: '31999990002', data: '2026-05-06', compareceu: false, lead_id: 2 },
  // avaliação sem lead (walk-in) — entra só na visão clínica
  { paciente_clinicorp_id: 'C', telefone: '31988880003', data: '2026-05-07', compareceu: true,  lead_id: null },
];
const orcamentos = [
  { paciente_clinicorp_id: 'A', telefone: '31999990001', valor: 10000, status: 'APPROVED', data_criacao: '2026-05-05', lead_id: 1 },
  { paciente_clinicorp_id: 'B', telefone: '31999990002', valor: 8000,  status: 'OPEN',     data_criacao: '2026-05-06', lead_id: 2 },
  { paciente_clinicorp_id: 'C', telefone: '31988880003', valor: 5000,  status: 'OPEN',     data_criacao: '2026-05-07', lead_id: null },
];

test('visão leads: contagens e percentuais', () => {
  const r = agregarFunil({ leads, avaliacoes, orcamentos });
  const v = r.leads;
  assert.strictEqual(v.leads_criados, 2);
  assert.strictEqual(v.agendamentos, 2);
  assert.strictEqual(v.leads_agendados, 2);
  assert.strictEqual(v.comparecimentos, 1);
  assert.strictEqual(v.fechamentos, 1);            // só paciente A aprovado
  assert.strictEqual(v.valor_oportunidades, 18000); // 10000 + 8000 (coorte de leads)
  assert.strictEqual(v.valor_fechamentos, 10000);
  assert.strictEqual(v.ticket_medio, 10000);
  assert.ok(Math.abs(v.taxa_conversao - (10000 / 18000)) < 1e-9);
});

test('visão clínica inclui walk-in e zera cards de lead', () => {
  const r = agregarFunil({ leads, avaliacoes, orcamentos });
  const v = r.clinica;
  assert.strictEqual(v.agendamentos, 3);     // inclui paciente C
  assert.strictEqual(v.comparecimentos, 2);  // A e C
  assert.strictEqual(v.valor_oportunidades, 23000); // 10000+8000+5000
  assert.strictEqual(v.leads_criados, null);
  assert.strictEqual(v.leads_agendados, null);
});

test('filtro de origem restringe a visão leads', () => {
  const r = agregarFunil({ leads, avaliacoes, orcamentos, origem: 'invisalign' });
  assert.strictEqual(r.leads.leads_criados, 1);
  assert.strictEqual(r.leads.fechamentos, 1);
  assert.strictEqual(r.leads.valor_oportunidades, 10000);
});
