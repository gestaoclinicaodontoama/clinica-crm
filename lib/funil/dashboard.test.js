const { test } = require('node:test');
const assert = require('node:assert');
const { montarDashboard } = require('./dashboard');

// stub de buscarCoorte injetável: devolve coorte fixo conforme o intervalo
function fakeCoorte(tag) {
  const lead = (id) => ({ lead_id: id, tipo: 'historico_lead_criado', criado_em: '2026-05-02T10:00:00-03:00' });
  if (tag === 'atual') {
    return {
      criados: [lead(1), lead(2)],
      eventos: [lead(1), lead(2), { lead_id: 1, tipo: 'historico_fechou', criado_em: '2026-05-10T10:00:00-03:00', metadata: { valor: 1000, entrada: 200 } }],
      origemPorLead: new Map([[1, 'Meta Ads'], [2, 'Meta Ads']]),
    };
  }
  return { criados: [lead(9)], eventos: [lead(9)], origemPorLead: new Map([[9, 'Meta Ads']]) };
}

test('monta payload com funil, kpis, comparacao, serie e periodo', async () => {
  const deps = { buscarCoorte: async (_sb, from) => fakeCoorte(from.includes('2026-04') ? 'anterior' : 'atual') };
  const periodo = {
    from: '2026-05-01T00:00:00-03:00', to: '2026-05-31T23:59:59-03:00',
    anterior: { from: '2026-04-01T00:00:00-03:00', to: '2026-04-30T23:59:59-03:00' },
    granularidade: 'dia', preset: 'mes',
  };
  const out = await montarDashboard({}, periodo, null, deps);
  assert.strictEqual(out.funil.etapas[0].n, 2);
  assert.strictEqual(out.kpis.venda, 1000);
  assert.strictEqual(out.comparacao.leads.anterior, 1);
  assert.ok(out.funil.gargalo !== undefined && out.funil.gargalo !== null);
  assert.strictEqual(out.serie.granularidade, 'dia');
  assert.strictEqual(out.periodo.preset, 'mes');
});
