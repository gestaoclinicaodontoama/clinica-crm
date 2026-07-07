// Mapeia respostas da Graph API (insights de mídia do IG) para linhas de ig_posts.
const METRICAS_BASE = ['reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions'];
const CAMPOS_NUM = [...METRICAS_BASE, 'plays'];

function extrairMetricas(insightsJson) {
  const out = {};
  for (const d of (insightsJson && insightsJson.data) || []) {
    const v = d && d.values && d.values[0] ? d.values[0].value : undefined;
    if (d && d.name && v !== undefined) out[d.name] = v;
  }
  return out;
}

function montarLinhaIgPost(perfil, media, metricas = {}) {
  const row = {
    media_id: String(media.id),
    perfil,
    ig_timestamp: media.timestamp || null,
    caption: (media.caption || '').slice(0, 2000),
    media_type: media.media_type || null,
    permalink: media.permalink || null,
    atualizado_em: new Date().toISOString(),
  };
  for (const k of CAMPOS_NUM) {
    const raw = metricas[k];
    row[k] = (raw === null || raw === undefined || !Number.isFinite(Number(raw))) ? null : Number(raw);
  }
  return row;
}

module.exports = { extrairMetricas, montarLinhaIgPost, METRICAS_BASE };
