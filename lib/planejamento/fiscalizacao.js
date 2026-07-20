// lib/planejamento/fiscalizacao.js — Fiscalização da gestora (planejado × real) — Entrega ③A
// spec: docs/superpowers/specs/2026-07-20-fiscalizacao-planejado-real-design.md

/** Resumo planejado×real de um plano. custoHora em R$/hora. margemAlvo em % (ex.: 20). */
function resumoPlano({ tempo_planejado_min, tempo_real_min, valor } = {}, custoHora, margemAlvo) {
  const plan = Number(tempo_planejado_min) || 0;
  const real = Number(tempo_real_min) || 0;
  const v = Number(valor) || 0;
  const custo_cadeira = (real / 60) * (Number(custoHora) || 0);
  const pct_receita_cadeira = v > 0 ? custo_cadeira / v : null;   // fração 0..1
  const estouro = plan > 0 && real > plan;
  // crítico: o custo de cadeira sozinho já passa do que a margem-alvo permitiria gastar
  const tetoCadeira = v > 0 ? v * (1 - (Number(margemAlvo) || 0) / 100) : null;
  let severidade = 'ok';
  if (v > 0 && custo_cadeira > tetoCadeira) severidade = 'critico';
  else if (estouro) severidade = 'atencao';
  return {
    planejado_min: plan, real_min: real, delta_min: real - plan, estouro,
    custo_cadeira, pct_receita_cadeira, severidade,
  };
}

module.exports = { resumoPlano };
