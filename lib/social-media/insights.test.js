const test = require('node:test');
const assert = require('node:assert');
const { extrairMetricas, montarLinhaIgPost, METRICAS_BASE } = require('./insights');

test('extrairMetricas converte o formato data[].values[0].value', () => {
  const json = { data: [
    { name: 'reach', values: [{ value: 3488 }] },
    { name: 'shares', values: [{ value: 21 }] },
  ]};
  assert.deepEqual(extrairMetricas(json), { reach: 3488, shares: 21 });
});
test('extrairMetricas tolera json vazio/malformado', () => {
  assert.deepEqual(extrairMetricas({}), {});
  assert.deepEqual(extrairMetricas(null), {});
});
test('montarLinhaIgPost normaliza campos e corta caption', () => {
  const media = { id: '999', timestamp: '2026-05-31T20:00:00+0000', caption: 'x'.repeat(3000), media_type: 'VIDEO', permalink: 'https://insta/p/1' };
  const row = montarLinhaIgPost('dr_marcos', media, { reach: 10, plays: 50 });
  assert.equal(row.media_id, '999');
  assert.equal(row.perfil, 'dr_marcos');
  assert.equal(row.caption.length, 2000);
  assert.equal(row.reach, 10);
  assert.equal(row.plays, 50);
  assert.equal(row.likes, null);
});
test('METRICAS_BASE tem as 6 métricas da spec', () => {
  assert.deepEqual(METRICAS_BASE, ['reach','likes','comments','shares','saved','total_interactions']);
});
