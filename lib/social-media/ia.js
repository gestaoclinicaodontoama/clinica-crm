// lib/social-media/ia.js
// Fase 3 — fatos determinísticos e validações da camada de IA (a IA nunca calcula; só interpreta).
const TEMAS = ['depoimento', 'educativo', 'oferta', 'bastidor', 'institucional'];
const FORMATOS_SUGESTAO = ['reel', 'carrossel', 'foto'];
const PERFIS_INFO = {
  ama: { nome: 'Clínica AMA', publico: '45+ (principalmente idosos)', foco: 'reabilitação: prótese protocolo, implantes, voltar a mastigar/sorrir' },
  dr_marcos: { nome: 'Dr. Marcos Vinicius', publico: '25 a 45 anos', foco: 'Invisalign (alinhador invisível) e estética' },
};
const semLegenda = (s) => ((s || '').trim() || 'post sem legenda');

function montarCobertura({ snapshotDias = 0, amaAtiva = false, postsComTema = 0, totalPosts = 0, radarColetados = 0 }) {
  const avisos = [];
  if (snapshotDias < 28) avisos.push(`série de seguidores com apenas ${snapshotDias} dia(s) — tendência temporal ainda NÃO é confiável`);
  if (!amaAtiva) avisos.push('perfil Clínica AMA sem coleta (acesso pendente) — análise cobre só o Dr. Marcos');
  if (totalPosts > 0 && postsComTema === 0) avisos.push('nenhum post com tema marcado ainda — leitura por tema indisponível');
  if (radarColetados === 0) avisos.push('radar de referência sem perfis coletados');
  return { snapshot_dias: snapshotDias, ama_ativa: amaAtiva, posts_com_tema: postsComTema, total_posts: totalPosts, radar_perfis: radarColetados, avisos };
}

function rankRadar(rows, limite = 5) {
  const itens = (rows || []).filter(r => r && Number.isFinite(r.followers_no_dia) && r.followers_no_dia > 0).map(r => {
    const likes = Number.isFinite(r.like_count) ? r.like_count : null;
    const comments = r.comments_count || 0;
    return {
      username: r.username,
      caption60: semLegenda(r.caption).slice(0, 60),
      likes, comments,
      sem_likes: likes === null,
      engajamento_pct: Math.round((((likes ?? 0) + comments) / r.followers_no_dia) * 10000) / 100,
      permalink: r.permalink || null,
      ig_timestamp: r.ig_timestamp || null,
    };
  });
  return itens.sort((a, b) => b.engajamento_pct - a.engajamento_pct).slice(0, limite);
}

function dia18hBRT(diaISO) {
  return new Date(`${diaISO}T18:00:00-03:00`).toISOString();
}

function validarSugestoes(sugestoes, hojeBRT) {
  const erros = [];
  if (!Array.isArray(sugestoes) || sugestoes.length < 3 || sugestoes.length > 5) erros.push('esperado de 3 a 5 sugestões');
  for (const [i, s] of (Array.isArray(sugestoes) ? sugestoes : []).entries()) {
    const probs = [];
    if (!TEMAS.includes(s.tema)) probs.push(`tema inválido (${s.tema})`);
    if (!FORMATOS_SUGESTAO.includes(s.formato)) probs.push(`formato inválido (${s.formato})`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.dia_sugerido || '') || s.dia_sugerido < hojeBRT) probs.push(`dia inválido (${s.dia_sugerido})`);
    if (!(s.titulo || '').trim()) probs.push('sem título');
    if (!(s.gancho || '').trim()) probs.push('sem gancho');
    if (probs.length) erros.push(`sugestão ${i + 1}: ${probs.join(', ')}`);
  }
  return { ok: erros.length === 0, erros };
}

function montarFatosPauta({ perfil, posts30, medianas, formatos, temas, semTema, horarios, destaques, radarTop, cobertura }) {
  return {
    perfil: { chave: perfil, ...PERFIS_INFO[perfil] },
    cidade: 'Ipatinga-MG (público local; lead de fora da região não serve)',
    resumo_ultimos_30_posts: {
      total: (posts30 || []).length,
      medianas,
      top5_por_alcance: [...(posts30 || [])].sort((a, b) => (b.reach || 0) - (a.reach || 0)).slice(0, 5).map(p => ({
        legenda: semLegenda(p.caption).slice(0, 80), formato: p.media_type,
        reach: p.reach, interacoes: p.total_interactions, shares: p.shares, saved: p.saved,
        data: (p.ig_timestamp || '').slice(0, 10),
      })),
    },
    por_formato: formatos, por_tema: temas, posts_sem_tema: semTema, por_dia_horario: horarios,
    destaques, radar_referencia: radarTop, cobertura,
  };
}

function montarFatosAnalise({ dadosMensais, radarTop, funil, cobertura }) {
  return {
    mes: dadosMensais.mes,
    perfis: dadosMensais.perfis,
    disciplina_calendario: dadosMensais.disciplina,
    pago: dadosMensais.pago,
    funil, radar_referencia: radarTop, cobertura,
  };
}

module.exports = { montarCobertura, rankRadar, dia18hBRT, validarSugestoes, montarFatosPauta, montarFatosAnalise, TEMAS, FORMATOS_SUGESTAO, PERFIS_INFO };
