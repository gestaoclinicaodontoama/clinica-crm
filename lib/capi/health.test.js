const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./health');

function ev(over = {}) {
  return {
    criado_em: over.criado_em || '2026-06-22T12:00:00-03:00',
    metadata: {
      evento: over.evento || 'LeadSubmitted',
      sucesso: over.sucesso === undefined ? 'true' : String(over.sucesso),
      http_status: over.http || '200',
      action_source: over.action_source || 'business_messaging',
      payload_enviado: { user_data: over.user_data || { ph: ['x'], page_id: '1204513262736152', ctwa_clid: 'c' } },
      resposta_meta: over.subcode ? { error: { error_subcode: over.subcode } } : { events_received: 1 },
    },
  };
}

test('normalizar extrai os campos', () => {
  const n = h.normalizar(ev({ evento: 'Schedule', sucesso: false, http: '400', subcode: '2804065' }));
  assert.equal(n.evento, 'Schedule');
  assert.equal(n.sucesso, false);
  assert.equal(n.subcode, '2804065');
  assert.equal(n.pageId, '1204513262736152');
  assert.equal(n.has.telefone, true);
  assert.equal(n.has.email, false);
});

test('contagensPorSemana separa atual x anterior e soma sucesso/falha', () => {
  const agora = new Date('2026-06-24T12:00:00-03:00'); // quarta — semana de 22 a 28
  const rows = [
    h.normalizar(ev({ criado_em: '2026-06-23T10:00:00-03:00', evento: 'LeadSubmitted', sucesso: true })),
    h.normalizar(ev({ criado_em: '2026-06-23T11:00:00-03:00', evento: 'LeadSubmitted', sucesso: false, subcode: '2804065' })),
    h.normalizar(ev({ criado_em: '2026-06-18T11:00:00-03:00', evento: 'LeadSubmitted', sucesso: true })), // semana anterior
  ];
  const c = h.contagensPorSemana(rows, agora);
  assert.equal(c.atual.LeadSubmitted.enviados, 2);
  assert.equal(c.atual.LeadSubmitted.sucesso, 1);
  assert.equal(c.atual.LeadSubmitted.falha, 1);
  assert.equal(c.anterior.LeadSubmitted.sucesso, 1);
});

test('coberturaMatch: ctwa_clid/page_id só sobre CTWA; telefone sobre todos', () => {
  const rows = [
    h.normalizar(ev({ user_data: { ph: ['x'], page_id: 'p', ctwa_clid: 'c' }, action_source: 'business_messaging' })),
    h.normalizar(ev({ user_data: { ph: ['x'] }, action_source: 'website' })), // não-CTWA, sem page_id
  ];
  const cov = h.coberturaMatch(rows);
  assert.equal(cov.telefone, 100);     // 2/2
  assert.equal(cov.page_id, 100);      // 1/1 dos CTWA
});

const N = (over) => h.normalizar(ev(over));
function serie(n, over) { return Array.from({ length: n }, () => N(over)); }

test('gatilho taxa_falha: >30% com >=10 tentativas dispara', () => {
  const agora = new Date('2026-06-22T18:00:00-03:00');
  const t = (s) => ({ criado_em: '2026-06-22T15:00:00-03:00', sucesso: s, subcode: s ? null : '2804065', http: s ? '200' : '400' });
  const rows = [...serie(6, t(true)), ...serie(4, t(false))]; // 10 tentativas, 40% falha
  const g = h.avaliarGatilhos(rows, agora).find(x => x.gatilho === 'taxa_falha');
  assert.equal(g.status, 'ruim');
});

test('gatilho taxa_falha: <10 tentativas não dispara (guarda de volume)', () => {
  const agora = new Date('2026-06-22T18:00:00-03:00');
  const rows = serie(3, { criado_em: '2026-06-22T15:00:00-03:00', sucesso: false, subcode: '2804065', http: '400' });
  const g = h.avaliarGatilhos(rows, agora).find(x => x.gatilho === 'taxa_falha');
  assert.equal(g.status, 'ok');
});

test('gatilho silencio: página ativa 18h sem sucesso dispara', () => {
  const agora = new Date('2026-06-22T20:00:00-03:00');
  const baseline = [];
  for (let d = 2; d <= 8; d++) for (let i = 0; i < 4; i++)
    baseline.push(N({ criado_em: `2026-06-${String(22 - d).padStart(2, '0')}T10:00:00-03:00`, sucesso: true, user_data: { ph: ['x'], page_id: 'P', ctwa_clid: 'c' } }));
  const g = h.avaliarGatilhos(baseline, agora).filter(x => x.gatilho === 'silencio' && x.escopo === 'P');
  assert.equal(g.length, 1);
  assert.equal(g[0].status, 'ruim');
});

test('gatilho erro_novo: subcode inédito nas últimas 24h dispara', () => {
  const agora = new Date('2026-06-22T18:00:00-03:00');
  const rows = [
    N({ criado_em: '2026-06-10T10:00:00-03:00', sucesso: false, subcode: '2804065', http: '400' }), // histórico
    N({ criado_em: '2026-06-22T10:00:00-03:00', sucesso: false, subcode: '9999999', http: '400' }), // novo
  ];
  const g = h.avaliarGatilhos(rows, agora).find(x => x.gatilho === 'erro_novo');
  assert.equal(g.status, 'ruim');
  assert.ok(JSON.stringify(g.detalhe).includes('9999999'));
});
