// lib/social-media/desempenho.test.js
const test = require('node:test');
const assert = require('node:assert');
const { mediana, montarSelos, agregarPorChave, bucketHorarioBRT, gerarDestaques, FORMATO_LABEL } = require('./desempenho');

test('mediana: ímpar, par, vazio e não-finitos', () => {
  assert.equal(mediana([1, 5, 3]), 3);
  assert.equal(mediana([1, 2, 3, 4]), 2.5);
  assert.equal(mediana([]), null);
  assert.equal(mediana([null, undefined, 7]), 7);
});

test('montarSelos: só métricas >= 1,5x a mediana, razão com 1 decimal', () => {
  const medianas = { reach: 600, total_interactions: 30, shares: 4, saved: 1 };
  const post = { reach: 1380, total_interactions: 31, shares: 33, saved: 0 };
  const selos = montarSelos(post, medianas);
  assert.equal(selos.reach, 2.3);       // 1380/600
  assert.equal(selos.shares, 8.3);      // 33/4 = 8.25 -> 8.3
  assert.equal(selos.total_interactions, undefined); // 31/30 < 1.5
  assert.equal(selos.saved, undefined);
});

test('montarSelos: mediana 0 ou null nunca gera selo', () => {
  assert.deepEqual(montarSelos({ reach: 100, saved: 5 }, { reach: 0, saved: null }), {});
});

test('agregarPorChave: agrega com mediana, marca poucos_dados < minimo, ignora chave nula', () => {
  const posts = [
    { media_type: 'VIDEO', reach: 100, total_interactions: 10 },
    { media_type: 'VIDEO', reach: 300, total_interactions: 20 },
    { media_type: 'VIDEO', reach: 200, total_interactions: 30 },
    { media_type: 'IMAGE', reach: 50, total_interactions: 5 },
    { media_type: null, reach: 999, total_interactions: 99 },
  ];
  const ag = agregarPorChave(posts, p => p.media_type);
  assert.equal(ag.length, 2);
  const video = ag.find(a => a.chave === 'VIDEO');
  assert.equal(video.qtd, 3);
  assert.equal(video.reach_mediano, 200);
  assert.equal(video.poucos_dados, false);
  const img = ag.find(a => a.chave === 'IMAGE');
  assert.equal(img.poucos_dados, true);
  assert.equal(ag[0].chave, 'VIDEO'); // ordenado por reach_mediano desc
});

test('bucketHorarioBRT: converte UTC pra BRT e classifica faixa', () => {
  // 2026-07-13T21:30Z = 18:30 BRT (segunda) -> noite
  assert.deepEqual(bucketHorarioBRT('2026-07-13T21:30:00+0000'), { dia: 'seg', faixa: 'noite' });
  // 2026-07-13T01:00Z = 22:00 BRT do DOMINGO 12 -> noite
  assert.deepEqual(bucketHorarioBRT('2026-07-13T01:00:00+0000'), { dia: 'dom', faixa: 'noite' });
  // 12:00Z = 09:00 BRT -> manha
  assert.equal(bucketHorarioBRT('2026-07-15T12:00:00+0000').faixa, 'manha');
});

test('gerarDestaques: melhor post, formato dominante, compartilhado/salvo; máx 3; vazio sem condição', () => {
  const medianas = { reach: 100, total_interactions: 10, shares: 2, saved: 1 };
  const posts15 = [
    { caption: 'Post campeão de alcance', reach: 250, shares: 1, saved: 0 },
    { caption: 'Post muito salvo', reach: 90, shares: 4, saved: 3 }, // shares+saved=7 >= 2*(2+1)=6
  ];
  const formatos = [
    { chave: 'VIDEO', qtd: 5, reach_mediano: 300, poucos_dados: false },
    { chave: 'IMAGE', qtd: 4, reach_mediano: 100, poucos_dados: false },
  ];
  const d = gerarDestaques(posts15, medianas, formatos);
  assert.ok(d.length >= 1 && d.length <= 3);
  assert.ok(d[0].includes('Post campeão de alcance') && d[0].includes('2,5×'));
  assert.ok(d.some(x => x.includes('Reels/vídeos') && x.includes('3,0×')));
  assert.ok(d.some(x => x.includes('Post muito salvo')));
  // sem condição -> vazio
  assert.deepEqual(gerarDestaques([{ caption: 'x', reach: 100, shares: 0, saved: 0 }], medianas, [formatos[1]]), []);
});

test('FORMATO_LABEL cobre os 3 tipos', () => {
  assert.equal(FORMATO_LABEL.VIDEO, 'Reels/vídeos');
  assert.equal(FORMATO_LABEL.IMAGE, 'Imagens');
  assert.equal(FORMATO_LABEL.CAROUSEL_ALBUM, 'Carrosséis');
});
