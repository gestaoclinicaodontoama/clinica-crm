// lib/social-media/ia.test.js
const test = require('node:test');
const assert = require('node:assert');
const { montarCobertura, rankRadar, dia18hBRT, validarSugestoes, montarFatosPauta, TEMAS, FORMATOS_SUGESTAO, PERFIS_INFO } = require('./ia');

test('montarCobertura gera avisos honestos', () => {
  const c = montarCobertura({ snapshotDias: 2, amaAtiva: false, postsComTema: 0, totalPosts: 30, radarColetados: 0 });
  assert.equal(c.avisos.length, 4);
  assert.ok(c.avisos[0].includes('2 dia'));
  const ok = montarCobertura({ snapshotDias: 30, amaAtiva: true, postsComTema: 5, totalPosts: 30, radarColetados: 3 });
  assert.deepEqual(ok.avisos, []);
});

test('rankRadar: engajamento relativo, fallback sem likes, filtra followers inválido, ordena', () => {
  const rows = [
    { username: 'a', caption: 'post A', like_count: 100, comments_count: 10, followers_no_dia: 1000, permalink: 'https://x/1', ig_timestamp: '2026-07-01T00:00:00Z' },
    { username: 'b', caption: '', like_count: null, comments_count: 30, followers_no_dia: 1000, ig_timestamp: '2026-07-02T00:00:00Z' },
    { username: 'c', caption: 'zero seguidores', like_count: 5, comments_count: 1, followers_no_dia: 0 },
  ];
  const r = rankRadar(rows);
  assert.equal(r.length, 2);
  assert.equal(r[0].username, 'a');            // 110/1000 = 11%
  assert.equal(r[0].engajamento_pct, 11);
  assert.equal(r[1].sem_likes, true);          // 30/1000 = 3%
  assert.equal(r[1].engajamento_pct, 3);
  assert.equal(r[1].caption60, 'post sem legenda');
});

test('dia18hBRT converte pra 21h UTC', () => {
  assert.equal(dia18hBRT('2026-07-13'), '2026-07-13T21:00:00.000Z');
});

test('validarSugestoes: aceita válida, rejeita tema/formato/dia/título ruins e quantidade errada', () => {
  const boa = { perfil: 'ama', tema: 'depoimento', formato: 'reel', titulo: 'T', gancho: 'ideia do conteúdo', dia_sugerido: '2026-07-15', justificativa: 'x' };
  assert.equal(validarSugestoes([boa, boa, boa], '2026-07-08').ok, true);
  assert.equal(validarSugestoes([boa, boa], '2026-07-08').ok, false); // só 2
  const v = validarSugestoes([{ ...boa, tema: 'meme' }, { ...boa, formato: 'story' }, { ...boa, dia_sugerido: '2026-07-01' }], '2026-07-08');
  assert.equal(v.ok, false);
  assert.equal(v.erros.length, 3);
});

test('montarFatosPauta inclui perfil, top5 por alcance e cobertura (e nada financeiro)', () => {
  const posts30 = [
    { caption: 'maior', media_type: 'IMAGE', reach: 900, total_interactions: 30, shares: 3, saved: 1, ig_timestamp: '2026-06-01T12:00:00Z' },
    { caption: '', media_type: 'VIDEO', reach: 100, total_interactions: 5, shares: 0, saved: 0, ig_timestamp: '2026-06-02T12:00:00Z' },
  ];
  const f = montarFatosPauta({ perfil: 'dr_marcos', posts30, medianas: { reach: 500 }, formatos: [], temas: [], semTema: 2, horarios: [], destaques: [], radarTop: [], cobertura: { avisos: [] } });
  assert.equal(f.perfil.chave, 'dr_marcos');
  assert.ok(f.perfil.foco.toLowerCase().includes('invisalign'));
  assert.equal(f.resumo_ultimos_30_posts.top5_por_alcance[0].reach, 900);
  assert.equal(f.resumo_ultimos_30_posts.top5_por_alcance[1].legenda, 'post sem legenda');
  assert.equal(JSON.stringify(f).includes('faturamento'), false);
  assert.equal(JSON.stringify(f).includes('gasto'), false);
});

test('consts exportadas', () => {
  assert.equal(TEMAS.length, 5);
  assert.deepEqual(FORMATOS_SUGESTAO, ['reel', 'carrossel', 'foto']);
  assert.ok(PERFIS_INFO.ama && PERFIS_INFO.dr_marcos);
});
