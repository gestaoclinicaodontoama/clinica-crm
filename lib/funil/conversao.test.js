const { test } = require('node:test');
const assert = require('node:assert');
const { calcularFunil } = require('./conversao');

test('calcula pct do topo, conversão da etapa anterior e gargalo', () => {
  const r = calcularFunil([
    { id: 'leads', rotulo: 'Leads', n: 100 },
    { id: 'agendados', rotulo: 'Agendados', n: 60 },
    { id: 'compareceram', rotulo: 'Compareceram', n: 45 },
    { id: 'orcaram', rotulo: 'Orçaram', n: 40 },
    { id: 'fecharam', rotulo: 'Fecharam', n: 12 },
  ]);
  assert.strictEqual(r.etapas[0].pct_do_topo, 1);
  assert.ok(Math.abs(r.etapas[1].conv_etapa_anterior - 0.6) < 1e-9);
  assert.ok(Math.abs(r.etapas[4].conv_etapa_anterior - 0.3) < 1e-9);
  assert.strictEqual(r.gargalo.id, 'fecharam');
  assert.ok(r.etapas.every(e => !e.cobertura_suspeita));
});

test('marca cobertura_suspeita quando uma etapa tem mais leads que a anterior', () => {
  const r = calcularFunil([
    { id: 'leads', rotulo: 'Leads', n: 100 },
    { id: 'orcaram', rotulo: 'Orçaram', n: 5 },
    { id: 'fecharam', rotulo: 'Fecharam', n: 8 },
  ]);
  assert.strictEqual(r.etapas[2].cobertura_suspeita, true);
  assert.strictEqual(r.etapas[2].conv_etapa_anterior, 1);
});

test('não divide por zero quando etapa anterior é 0', () => {
  const r = calcularFunil([
    { id: 'leads', rotulo: 'Leads', n: 0 },
    { id: 'agendados', rotulo: 'Agendados', n: 0 },
  ]);
  assert.strictEqual(r.etapas[1].conv_etapa_anterior, 0);
  assert.strictEqual(r.etapas[1].pct_do_topo, 0);
});
