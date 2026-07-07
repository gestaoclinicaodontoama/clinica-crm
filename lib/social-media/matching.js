// Sugestão de vínculo calendário ↔ post real do IG (spec: auto-SUGESTÃO, nunca auto-vínculo).
const JANELA_H = 36;

function sugerirVinculos(posts, medias) {
  const cand = [];
  for (const p of posts) {
    const tP = Date.parse(p.data_hora);
    for (const m of medias) {
      if (m.perfil !== p.perfil || !m.ig_timestamp) continue;
      const deltaH = Math.abs(Date.parse(m.ig_timestamp) - tP) / 3600e3;
      if (deltaH <= JANELA_H) cand.push({ post_id: p.id, media_id: m.media_id, delta_horas: Math.round(deltaH * 10) / 10 });
    }
  }
  cand.sort((a, b) => a.delta_horas - b.delta_horas);
  const usadoPost = new Set(), usadoMedia = new Set(), out = [];
  for (const c of cand) {
    if (usadoPost.has(c.post_id) || usadoMedia.has(c.media_id)) continue;
    usadoPost.add(c.post_id); usadoMedia.add(c.media_id); out.push(c);
  }
  return out;
}

module.exports = { sugerirVinculos, JANELA_H };
