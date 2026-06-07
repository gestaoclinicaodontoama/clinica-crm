const { test } = require('node:test');
const assert = require('node:assert');
const { compararKpis } = require('./comparacao');

test('calcula delta percentual por KPI', () => {
  const r = compararKpis(
    { leads: 320, fechamentos: 42, venda: 410000 },
    { leads: 280, fechamentos: 38, venda: 365000 },
  );
  assert.strictEqual(r.leads.atual, 320);
  assert.strictEqual(r.leads.anterior, 280);
  assert.ok(Math.abs(r.leads.delta_pct - 0.142857) < 1e-4);
});

test('delta null quando anterior é 0 (evita divisão por zero)', () => {
  const r = compararKpis({ leads: 10 }, { leads: 0 });
  assert.strictEqual(r.leads.delta_pct, null);
});
