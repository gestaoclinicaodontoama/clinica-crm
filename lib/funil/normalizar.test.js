const { test } = require('node:test');
const assert = require('node:assert');
const { etapaDeEvento, eraDoLead, normalizarEventos } = require('./normalizar');

test('etapaDeEvento mapeia os dois vocabulários', () => {
  assert.strictEqual(etapaDeEvento({ tipo: 'historico_agendado' }), 'agendou');
  assert.strictEqual(etapaDeEvento({ tipo: 'historico_fechou' }), 'fechou');
  assert.strictEqual(etapaDeEvento({ tipo: 'lead_criado' }), 'leads');
  assert.strictEqual(etapaDeEvento({ tipo: 'status_mudou', metadata: { para: 'Compareceu' } }), 'compareceu');
  assert.strictEqual(etapaDeEvento({ tipo: 'status_mudou', metadata: { para: 'Nutrir' } }), null);
});

test('eraDoLead: tem historico_ → antigo; só novos → novo; mistura → antigo', () => {
  assert.strictEqual(eraDoLead([{ tipo: 'lead_criado' }, { tipo: 'status_mudou' }]), 'novo');
  assert.strictEqual(eraDoLead([{ tipo: 'historico_lead_criado' }]), 'antigo');
  assert.strictEqual(eraDoLead([{ tipo: 'historico_lead_criado' }, { tipo: 'lead_criado' }]), 'antigo');
});

test('lead com 2 eras conta só a antiga (sem dupla contagem)', () => {
  const eventos = [
    { lead_id: 1, tipo: 'historico_lead_criado', criado_em: '2026-06-01T10:00:00-03:00', metadata: { origem: 'Meta Ads' } },
    { lead_id: 1, tipo: 'historico_fechou', criado_em: '2026-06-05T10:00:00-03:00', metadata: { valor: 20000 } },
    // ruído da era nova no mesmo lead (teste em junho) — deve ser IGNORADO
    { lead_id: 1, tipo: 'lead_criado', criado_em: '2026-06-02T10:00:00-03:00', metadata: { origem: 'X' } },
    { lead_id: 1, tipo: 'status_mudou', criado_em: '2026-06-06T10:00:00-03:00', metadata: { para: 'Fechou' } },
  ];
  const { eventosCanonicos, vendaPorLead } = normalizarEventos(eventos, new Map([[1, 999]]));
  assert.deepStrictEqual(eventosCanonicos.map(e => e.etapa).sort(), ['fechou', 'leads']);
  assert.strictEqual(vendaPorLead.get(1), 20000); // valor da era antiga, NÃO o leadValor 999
});

test('lead novo usa leads.valor como Venda', () => {
  const eventos = [
    { lead_id: 2, tipo: 'lead_criado', criado_em: '2026-07-01T10:00:00-03:00', metadata: { origem: 'Meta Ads' } },
    { lead_id: 2, tipo: 'status_mudou', criado_em: '2026-07-03T10:00:00-03:00', metadata: { para: 'Fechou' } },
  ];
  const { eventosCanonicos, vendaPorLead } = normalizarEventos(eventos, new Map([[2, 15000]]));
  assert.deepStrictEqual(eventosCanonicos.map(e => e.etapa).sort(), ['fechou', 'leads']);
  assert.strictEqual(vendaPorLead.get(2), 15000);
});

test('lead novo sem fechamento não entra em vendaPorLead', () => {
  const eventos = [
    { lead_id: 3, tipo: 'lead_criado', criado_em: '2026-07-01T10:00:00-03:00', metadata: { origem: 'Indicação' } },
    { lead_id: 3, tipo: 'status_mudou', criado_em: '2026-07-02T10:00:00-03:00', metadata: { para: 'Agendado' } },
  ];
  const { vendaPorLead } = normalizarEventos(eventos, new Map([[3, 5000]]));
  assert.strictEqual(vendaPorLead.has(3), false);
});
