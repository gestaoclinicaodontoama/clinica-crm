// lib/funil/comparacao.js
// Compara KPIs do período atual com o anterior. delta_pct = (atual-anterior)/anterior.
function compararKpis(atual, anterior) {
  const out = {};
  for (const k of Object.keys(atual)) {
    const a = Number(atual[k] || 0);
    const b = Number(anterior?.[k] || 0);
    out[k] = { atual: a, anterior: b, delta_pct: b > 0 ? (a - b) / b : null };
  }
  return out;
}

module.exports = { compararKpis };
