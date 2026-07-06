// Painel do Gestor — semáforos dos indicadores-chave. Regras puras, compartilhadas
// backend (require) e browser (window.PainelGestor). Sem IA, sem custo.
(function (global) {
  // faixas "maior é melhor"
  const maiorMelhor = (v, bom, atencao) => v >= bom ? 'verde' : v >= atencao ? 'amarelo' : 'vermelho';
  // faixas "menor é melhor"
  const menorMelhor = (v, bom, atencao) => v < bom ? 'verde' : v <= atencao ? 'amarelo' : 'vermelho';

  const semCrescimento = (g) => g > 0.05 ? 'verde' : g >= -0.05 ? 'amarelo' : 'vermelho';
  const semInadimplencia = (pct) => menorMelhor(pct, 0.05, 0.10);
  const semMargem = (m) => m > 0.15 ? 'verde' : m >= 0.08 ? 'amarelo' : 'vermelho';
  const semFolga = (f) => f > 0.25 ? 'verde' : f >= 0 ? 'amarelo' : 'vermelho';
  const semRoas = (r) => maiorMelhor(r, 3, 1.5);
  const semOcupacao = (o) => maiorMelhor(o, 0.80, 0.60);
  // etapa do funil vs a meta: bate a meta = verde; até 10% abaixo = amarelo; pior = vermelho
  const semFunil = (taxa, meta) => taxa >= meta ? 'verde' : taxa >= meta * 0.9 ? 'amarelo' : 'vermelho';

  function resumo(niveis) {
    const c = (n) => niveis.filter(x => x === n).length;
    return { verdes: c('verde'), amarelos: c('amarelo'), vermelhos: c('vermelho') };
  }

  // Crescimento ano-a-ano de uma métrica: 12 meses recentes vs os 12 anteriores.
  function crescimentoAnual(serie, campo) {
    const s = (serie || []).slice().sort((a, b) => a.ym < b.ym ? -1 : 1);
    if (s.length < 24) return null;
    const soma = (ini, fim) => s.slice(ini, fim).reduce((t, r) => t + (Number(r[campo]) || 0), 0);
    const ant = soma(s.length - 24, s.length - 12);
    if (ant <= 0) return null;
    return soma(s.length - 12, s.length) / ant - 1;
  }

  const api = { semCrescimento, semInadimplencia, semMargem, semFolga, semRoas, semOcupacao,
    semFunil, resumo, crescimentoAnual };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PainelGestor = api;
})(typeof window !== 'undefined' ? window : globalThis);
