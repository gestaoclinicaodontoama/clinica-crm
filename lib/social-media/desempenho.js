// lib/social-media/desempenho.js
// Fase 2 — lógica pura do Desempenho: medianas, selos (>=1,5x mediana),
// agregados com regra de amostra mínima e destaques por REGRA FIXA (sem IA).
const METRICAS_SELO = ['reach', 'total_interactions', 'shares', 'saved'];
const FORMATO_LABEL = { VIDEO: 'Reels/vídeos', IMAGE: 'Imagens', CAROUSEL_ALBUM: 'Carrosséis' };
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

function mediana(valores) {
  const v = (valores || []).filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const razao1 = (valor, med) => Math.round((valor / med) * 10) / 10;

function montarSelos(post, medianas) {
  const selos = {};
  for (const k of METRICAS_SELO) {
    const med = medianas[k], val = post[k];
    if (Number.isFinite(med) && med > 0 && Number.isFinite(val) && val >= 1.5 * med) selos[k] = razao1(val, med);
  }
  return selos;
}

function agregarPorChave(posts, extrairChave, minimo = 3) {
  const grupos = {};
  for (const p of posts || []) {
    const chave = extrairChave(p);
    if (chave == null) continue;
    (grupos[chave] = grupos[chave] || []).push(p);
  }
  return Object.entries(grupos).map(([chave, ps]) => ({
    chave,
    qtd: ps.length,
    reach_mediano: mediana(ps.map(p => p.reach)),
    interacoes_medianas: mediana(ps.map(p => p.total_interactions)),
    poucos_dados: ps.length < minimo,
  })).sort((a, b) => (b.reach_mediano || 0) - (a.reach_mediano || 0));
}

function bucketHorarioBRT(iso) {
  const brt = new Date(Date.parse(iso) - 3 * 3600e3);
  const h = brt.getUTCHours();
  const faixa = h < 6 ? 'madrugada' : h < 12 ? 'manha' : h < 18 ? 'tarde' : 'noite';
  return { dia: DIAS[brt.getUTCDay()], faixa };
}

const virgula = (n) => String(n.toFixed(1)).replace('.', ',');
const cap60 = (p) => ((p.caption || '').trim() || 'post sem legenda').slice(0, 60);

function gerarDestaques(posts15, medianas, formatos) {
  const out = [];
  // 1. melhor post recente por razão de alcance
  if (Number.isFinite(medianas.reach) && medianas.reach > 0) {
    let melhor = null, melhorRazao = 0;
    for (const p of posts15 || []) {
      if (!Number.isFinite(p.reach)) continue;
      const r = p.reach / medianas.reach;
      if (r > melhorRazao) { melhorRazao = r; melhor = p; }
    }
    if (melhor && melhorRazao >= 1.5) out.push(`🏆 "${cap60(melhor)}" alcançou ${virgula(razao1(melhor.reach, medianas.reach))}× o normal do perfil`);
  }
  // 2. formato dominante (ambos com amostra)
  const validos = (formatos || []).filter(f => !f.poucos_dados && Number.isFinite(f.reach_mediano) && f.reach_mediano > 0);
  if (validos.length >= 2 && validos[0].reach_mediano >= 1.5 * validos[1].reach_mediano) {
    const r = razao1(validos[0].reach_mediano, validos[1].reach_mediano);
    out.push(`📈 ${FORMATO_LABEL[validos[0].chave] || validos[0].chave} vêm alcançando ~${virgula(r)}× mais que ${(FORMATO_LABEL[validos[1].chave] || validos[1].chave).toLowerCase()}`);
  }
  // 3. sinal de conteúdo forte (compartilhado/salvo)
  const baseCS = (medianas.shares || 0) + (medianas.saved || 0);
  if (baseCS > 0) {
    const forte = (posts15 || []).find(p => ((p.shares || 0) + (p.saved || 0)) >= 2 * baseCS && ((p.shares || 0) + (p.saved || 0)) > 0);
    if (forte) out.push(`🔁 "${cap60(forte)}" foi muito compartilhado/salvo — tema quente`);
  }
  return out.slice(0, 3);
}

module.exports = { mediana, montarSelos, agregarPorChave, bucketHorarioBRT, gerarDestaques, FORMATO_LABEL, METRICAS_SELO };
