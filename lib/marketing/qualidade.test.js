const { test } = require('node:test');
const assert = require('node:assert');
const { METRICAS, metricaPorKey, valorDaMetrica, rankCampanhas } = require('./qualidade');

const CAMPS = [
  { campanha_id: 'A', campanha_nome: 'Camp A', total: 10, por_status: { 'Perdido': 6, 'Não tem Interesse': 2, 'Fechou': 1 } },
  { campanha_id: 'B', campanha_nome: 'Camp B', total: 4,  por_status: { 'Perdido': 3, 'Fechou': 1 } },
  { campanha_id: 'C', campanha_nome: 'Camp C', total: 20, por_status: { 'Fechou': 5 } },
];

test('METRICAS começa em sem_interesse e tem as 7 etapas', () => {
  assert.strictEqual(METRICAS[0].key, 'sem_interesse');
  assert.deepStrictEqual(METRICAS[0].status, ['Perdido', 'Não tem Interesse']);
  assert.strictEqual(METRICAS.length, 7);
});

test('metricaPorKey cai em sem_interesse quando key é desconhecida', () => {
  assert.strictEqual(metricaPorKey('xpto').key, 'sem_interesse');
  assert.strictEqual(metricaPorKey('fechou').key, 'fechou');
});

test('valorDaMetrica soma os status da métrica', () => {
  assert.strictEqual(valorDaMetrica({ 'Perdido': 6, 'Não tem Interesse': 2 }, metricaPorKey('sem_interesse')), 8);
  assert.strictEqual(valorDaMetrica({ 'Fechou': 1 }, metricaPorKey('sem_interesse')), 0);
});

test('rankCampanhas por volume (default) ordena por valor desc e filtra valor 0', () => {
  const r = rankCampanhas(CAMPS, 'sem_interesse');
  assert.deepStrictEqual(r.map(c => c.campanha_id), ['A', 'B']); // C tem valor 0 → fora
  assert.strictEqual(r[0].valor, 8);
  assert.strictEqual(r[0].taxa, 0.8);
});

test('rankCampanhas por taxa aplica minLeads', () => {
  const r = rankCampanhas(CAMPS, 'sem_interesse', { ordenarPor: 'taxa', minLeads: 5 });
  assert.deepStrictEqual(r.map(c => c.campanha_id), ['A']); // B total 4 < 5 → fora
});

test('rankCampanhas por etapa boa (fechou) muda o ranking', () => {
  const r = rankCampanhas(CAMPS, 'fechou');
  assert.deepStrictEqual(r.map(c => c.campanha_id), ['C', 'A', 'B']);
});
