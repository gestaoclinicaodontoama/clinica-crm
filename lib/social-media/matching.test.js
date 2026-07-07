// lib/social-media/matching.test.js
const test = require('node:test');
const assert = require('node:assert');
const { sugerirVinculos } = require('./matching');

const T0 = Date.parse('2026-07-13T18:30:00-03:00');
const iso = (ms) => new Date(ms).toISOString();

test('casa post e mídia do mesmo perfil dentro de 36h, pelo menor delta', () => {
  const posts = [{ id: 1, perfil: 'dr_marcos', data_hora: iso(T0) }];
  const medias = [
    { media_id: 'A', perfil: 'dr_marcos', ig_timestamp: iso(T0 + 2 * 3600e3) },
    { media_id: 'B', perfil: 'dr_marcos', ig_timestamp: iso(T0 + 30 * 3600e3) },
  ];
  const s = sugerirVinculos(posts, medias);
  assert.equal(s.length, 1);
  assert.equal(s[0].media_id, 'A');
  assert.equal(s[0].delta_horas, 2);
});
test('não cruza perfis nem passa de 36h', () => {
  const posts = [{ id: 1, perfil: 'ama', data_hora: iso(T0) }];
  const medias = [
    { media_id: 'A', perfil: 'dr_marcos', ig_timestamp: iso(T0) },
    { media_id: 'B', perfil: 'ama', ig_timestamp: iso(T0 + 40 * 3600e3) },
  ];
  assert.deepEqual(sugerirVinculos(posts, medias), []);
});
test('cada mídia atende só 1 post (guloso: menor delta primeiro)', () => {
  const posts = [
    { id: 1, perfil: 'ama', data_hora: iso(T0) },
    { id: 2, perfil: 'ama', data_hora: iso(T0 + 1 * 3600e3) },
  ];
  const medias = [{ media_id: 'A', perfil: 'ama', ig_timestamp: iso(T0 + 1 * 3600e3) }];
  const s = sugerirVinculos(posts, medias);
  assert.equal(s.length, 1);
  assert.equal(s[0].post_id, 2); // delta 0h ganha do delta 1h
});
