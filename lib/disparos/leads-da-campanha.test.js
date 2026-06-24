const { test } = require('node:test');
const assert = require('node:assert');
const { coletarLeadIds, PAGINA } = require('./leads-da-campanha');

test('coleta ids de uma única página parcial', async () => {
  const set = await coletarLeadIds(async () => [{ lead_id: 1 }, { lead_id: 2 }, { lead_id: 2 }]);
  assert.deepStrictEqual([...set].sort(), [1, 2]);
});

test('ignora lead_id nulo', async () => {
  const set = await coletarLeadIds(async () => [{ lead_id: 5 }, { lead_id: null }]);
  assert.deepStrictEqual([...set], [5]);
});

test('pagina quando a primeira página vem cheia', async () => {
  const p1 = Array.from({ length: PAGINA }, (_, i) => ({ lead_id: i + 1 }));
  const p2 = [{ lead_id: 99999 }];
  const paginas = [p1, p2];
  let chamadas = 0;
  const set = await coletarLeadIds(async () => paginas[chamadas++] || []);
  assert.strictEqual(set.size, PAGINA + 1);
  assert.ok(set.has(99999));
  assert.strictEqual(chamadas, 2);
});
