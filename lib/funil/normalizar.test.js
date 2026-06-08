const { test } = require('node:test');
const assert = require('node:assert');
const { etapaDeEvento, eraDoLead, normalizarEventos } = require('./normalizar');

test('etapaDeEvento mapeia os dois vocabulários', () => {
  assert.strictEqual(etapaDeEvento({ tipo: 'historico_agendado' }), 'agendou');
  assert.strictEqual(etapaDeEvento({ tipo: 'historico_fechou' }), 'fechou');
  assert.strictEqual(etapaDeEvento({ tipo: 'lead_criado' }), 'leads');
  assert.strictEqual(etapaDeEvento({ tipo: 'status_mudou', metadata: { para: 'Compareceu' } }), 'compareceu');
  assert.strictEqual(etapaDeEvento({ tipo: 'status_mudou', metadata: { para: 'Orçado' } }), 'orcou');
  assert.strictEqual(etapaDeEvento({ tipo: 'status_mudou', metadata: { para: 'Nutrir' } }), null);
});

test('eraDoLead: tem historico_ → antigo; só novos → novo; mistura → antigo', () => {
  assert.strictEqual(eraDoLead([{ tipo: 'lead_criado' }, { tipo: 'status_mudou' }]), 'novo');
  assert.strictEqual(eraDoLead([{ tipo: 'historico_lead_criado' }]), 'antigo');
  assert.strictEqual(eraDoLead([{ tipo: 'historico_lead_criado' }, { tipo: 'lead_criado' }]), 'antigo');
});

test('união: lead nas 2 eras conta cada etapa UMA vez (sem dupla contagem)', () => {
  const eventos = [
    { lead_id: 1, tipo: 'historico_lead_criado', criado_em: '2026-06-01T10:00:00-03:00', metadata: { origem: 'Meta Ads' } },
    { lead_id: 1, tipo: 'historico_fechou', criado_em: '2026-06-05T10:00:00-03:00', metadata: { valor: 20000 } },
    { lead_id: 1, tipo: 'lead_criado', criado_em: '2026-06-02T10:00:00-03:00', metadata: { origem: 'X' } },
    { lead_id: 1, tipo: 'status_mudou', criado_em: '2026-06-06T10:00:00-03:00', metadata: { para: 'Fechou' } },
  ];
  const { eventosCanonicos } = normalizarEventos(eventos, new Map([[1, 999]]));
  assert.deepStrictEqual(eventosCanonicos.map(e => e.etapa).sort(), ['fechou', 'leads']); // dedup
});

test('união CAPTA etapa que só existe na era nova (o ganho da regra)', () => {
  const eventos = [
    // histórico parou em "agendou"; o fechamento só aconteceu no CRM Novo
    { lead_id: 7, tipo: 'historico_lead_criado', criado_em: '2026-05-01T10:00:00-03:00', metadata: { origem: 'Meta Ads' } },
    { lead_id: 7, tipo: 'historico_agendado', criado_em: '2026-05-03T10:00:00-03:00' },
    { lead_id: 7, tipo: 'status_mudou', criado_em: '2026-07-10T10:00:00-03:00', metadata: { para: 'Fechou' } },
  ];
  const { eventosCanonicos, vendaPorLead } = normalizarEventos(eventos, new Map([[7, 12000]]));
  assert.deepStrictEqual(eventosCanonicos.map(e => e.etapa).sort(), ['agendou', 'fechou', 'leads']);
  assert.strictEqual(vendaPorLead.get(7), 12000); // fechou só na era nova → leads.valor
});

test('regra 2: etapa repetida nas 2 eras usa a data mais antiga', () => {
  const eventos = [
    { lead_id: 8, tipo: 'historico_compareceu', criado_em: '2026-05-01T10:00:00-03:00' },
    { lead_id: 8, tipo: 'status_mudou', criado_em: '2026-07-01T10:00:00-03:00', metadata: { para: 'Compareceu' } },
  ];
  const { eventosCanonicos } = normalizarEventos(eventos, new Map());
  const comp = eventosCanonicos.filter(e => e.etapa === 'compareceu');
  assert.strictEqual(comp.length, 1);
  assert.strictEqual(comp[0].criado_em, '2026-05-01T10:00:00-03:00'); // primeira ocorrência
});

test('regra 4: Venda NÃO soma as 2 eras (planilha tem precedência)', () => {
  const eventos = [
    { lead_id: 1, tipo: 'historico_fechou', criado_em: '2026-06-05T10:00:00-03:00', metadata: { valor: 20000 } },
    { lead_id: 1, tipo: 'status_mudou', criado_em: '2026-06-06T10:00:00-03:00', metadata: { para: 'Fechou' } },
  ];
  const { vendaPorLead } = normalizarEventos(eventos, new Map([[1, 25000]]));
  assert.strictEqual(vendaPorLead.get(1), 20000); // só a planilha; NÃO 20000+25000
});

test('lead novo usa leads.valor; sem fechamento não entra em vendaPorLead', () => {
  const eventos = [
    { lead_id: 2, tipo: 'lead_criado', criado_em: '2026-07-01T10:00:00-03:00', metadata: { origem: 'Meta Ads' } },
    { lead_id: 2, tipo: 'status_mudou', criado_em: '2026-07-03T10:00:00-03:00', metadata: { para: 'Fechou' } },
    { lead_id: 3, tipo: 'lead_criado', criado_em: '2026-07-01T10:00:00-03:00', metadata: { origem: 'Indicação' } },
    { lead_id: 3, tipo: 'status_mudou', criado_em: '2026-07-02T10:00:00-03:00', metadata: { para: 'Agendado' } },
  ];
  const { vendaPorLead } = normalizarEventos(eventos, new Map([[2, 15000], [3, 5000]]));
  assert.strictEqual(vendaPorLead.get(2), 15000);
  assert.strictEqual(vendaPorLead.has(3), false);
});
