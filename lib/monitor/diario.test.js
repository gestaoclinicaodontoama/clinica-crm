const { test } = require('node:test');
const assert = require('node:assert');
const { montarMonitor } = require('./diario');

const eventos = [
  // dia 01: 2 leads (1 sem origem), lead 1 agenda e comparece
  { lead_id: 1, tipo: 'lead_criado', criado_em: '2026-06-01T09:00:00-03:00', metadata: { origem: 'Meta Ads' } },
  { lead_id: 2, tipo: 'lead_criado', criado_em: '2026-06-01T10:00:00-03:00', metadata: { origem: '' } },
  { lead_id: 1, tipo: 'status_mudou', criado_em: '2026-06-01T11:00:00-03:00', metadata: { de: 'Lead', para: 'Agendado' } },
  { lead_id: 1, tipo: 'status_mudou', criado_em: '2026-06-01T15:00:00-03:00', metadata: { de: 'Agendado', para: 'Compareceu' } },
  // dia 02: lead 1 fecha (com valor); lead 3 fecha sem ter comparecido (órfã) e sem valor
  { lead_id: 1, tipo: 'status_mudou', criado_em: '2026-06-02T10:00:00-03:00', metadata: { de: 'Compareceu', para: 'Fechou' } },
  { lead_id: 3, tipo: 'lead_criado', criado_em: '2026-06-02T08:00:00-03:00', metadata: { origem: 'Indicação' } },
  { lead_id: 3, tipo: 'status_mudou', criado_em: '2026-06-02T09:00:00-03:00', metadata: { de: 'Lead', para: 'Fechou' } },
  // status fora do mapa (Nutrir) → ignorado
  { lead_id: 2, tipo: 'status_mudou', criado_em: '2026-06-02T12:00:00-03:00', metadata: { de: 'Lead', para: 'Nutrir' } },
];
const leadValor = new Map([[1, 18000]]); // lead 3 não tem valor

test('atividade por dia conta leads e transições por etapa', () => {
  const r = montarMonitor(eventos, leadValor);
  const d1 = r.dias.find(d => d.data === '2026-06-01');
  const d2 = r.dias.find(d => d.data === '2026-06-02');
  assert.strictEqual(d1.leads, 2);
  assert.strictEqual(d1.agendou, 1);
  assert.strictEqual(d1.compareceu, 1);
  assert.strictEqual(d2.fechou, 2);
});

test('Venda do dia soma leads.valor dos que fecharam', () => {
  const r = montarMonitor(eventos, leadValor);
  const d2 = r.dias.find(d => d.data === '2026-06-02');
  assert.strictEqual(d2.venda, 18000); // só o lead 1 tem valor
});

test('saúde: leads sem origem e fechamentos sem valor', () => {
  const r = montarMonitor(eventos, leadValor);
  assert.strictEqual(r.saude.leads_sem_origem.n, 1);     // lead 2
  assert.strictEqual(r.saude.leads_sem_origem.total, 3);
  assert.strictEqual(r.saude.fechamentos_sem_valor.n, 1); // lead 3
  assert.strictEqual(r.saude.fechamentos_sem_valor.total, 2);
});

test('detecta transição órfã (fechou sem ter comparecido)', () => {
  const r = montarMonitor(eventos, leadValor);
  assert.strictEqual(r.saude.transicoes_orfas.fechou_sem_compareceu, 1); // lead 3
  assert.strictEqual(r.saude.transicoes_orfas.compareceu_sem_agendou, 0);
});

test('cobertura: orçou fica false (lacuna do CRM Novo exposta)', () => {
  const r = montarMonitor(eventos, leadValor);
  assert.strictEqual(r.cobertura.leads, true);
  assert.strictEqual(r.cobertura.agendou, true);
  assert.strictEqual(r.cobertura.compareceu, true);
  assert.strictEqual(r.cobertura.fechou, true);
  assert.strictEqual(r.cobertura.orcou, false); // sem evento 'Orçado' nestes dados
});

test('status Orçado mapeia para a etapa orcou (cobertura + atividade)', () => {
  const evs = [
    { lead_id: 9, tipo: 'lead_criado', criado_em: '2026-06-01T09:00:00-03:00', metadata: { origem: 'Meta Ads' } },
    { lead_id: 9, tipo: 'status_mudou', criado_em: '2026-06-02T10:00:00-03:00', metadata: { de: 'Compareceu', para: 'Orçado' } },
  ];
  const r = montarMonitor(evs, new Map());
  assert.strictEqual(r.cobertura.orcou, true);
  assert.strictEqual(r.dias.find(d => d.data === '2026-06-02').orcou, 1);
});

test('lista vazia não quebra (sem divisão por zero)', () => {
  const r = montarMonitor([], new Map());
  assert.deepStrictEqual(r.dias, []);
  assert.strictEqual(r.saude.leads_sem_origem.pct, 0);
  assert.strictEqual(r.cobertura.orcou, false);
});

test('janela: atividade conta só o período; órfã usa histórico completo (sem falso positivo)', () => {
  const evs = [
    // lead 5 agendou ANTES da janela (maio) e compareceu DENTRO (junho) — NÃO é órfã
    { lead_id: 5, tipo: 'lead_criado', criado_em: '2026-05-20T10:00:00-03:00', metadata: { origem: 'Meta Ads' } },
    { lead_id: 5, tipo: 'status_mudou', criado_em: '2026-05-25T10:00:00-03:00', metadata: { para: 'Agendado' } },
    { lead_id: 5, tipo: 'status_mudou', criado_em: '2026-06-02T10:00:00-03:00', metadata: { para: 'Compareceu' } },
  ];
  const periodo = { from: '2026-06-01T00:00:00-03:00', to: '2026-06-30T23:59:59-03:00' };
  const r = montarMonitor(evs, new Map(), periodo);
  assert.strictEqual(r.dias.length, 1);            // só o comparecimento de junho
  assert.strictEqual(r.dias[0].data, '2026-06-02');
  assert.strictEqual(r.dias[0].compareceu, 1);
  assert.strictEqual(r.saude.transicoes_orfas.compareceu_sem_agendou, 0); // agendou existe no histórico
});
