// Análise da DRE v2 — funções puras, compartilhadas entre browser (window.DREAnalise)
// e testes Node (module.exports). Formato de entrada: DRE do montarDRE
// { ym, receita, grupos:[{codigo,titulo,total,contas:[{codigo,nome,total}]}], resultado }
// Saídas têm total NEGATIVO (sinal já aplicado no montarDRE).
(function (global) {
  const VARIAVEIS = ['2', '3.0', '3.1', '3.2', '3.3']; // impostos + custos (premissa do spec §2.5)
  const FIXAS = ['4'];
  const ZERO = 0.005; // abaixo disso, trata como zero (evita divisão instável)

  const somaGrupos = (dre, codigos) =>
    (dre.grupos || []).filter(g => codigos.includes(g.codigo)).reduce((s, g) => s + g.total, 0);

  function subtotais(dre) {
    const receitaBruta = somaGrupos(dre, ['1']);
    const receitaLiquida = receitaBruta + somaGrupos(dre, ['2']);
    const lucroBruto = receitaLiquida + somaGrupos(dre, ['3.0', '3.1', '3.2', '3.3']);
    const resultadoOperacional = lucroBruto + somaGrupos(dre, ['4']);
    const resultadoFinal = resultadoOperacional + somaGrupos(dre, ['5', '7']);
    return { receitaBruta, receitaLiquida, lucroBruto, resultadoOperacional, resultadoFinal };
  }

  function av(valor, receitaBruta) {
    return Math.abs(receitaBruta) < ZERO ? null : valor / receitaBruta;
  }

  // entrada: variação com sinal (pega resultado cruzando de prejuízo p/ lucro);
  // saída: variação do MÓDULO (gastou mais/menos), pra leitura intuitiva.
  function variacao(natureza, atual, anterior) {
    if (anterior == null || Math.abs(anterior) < ZERO) return null;
    if (natureza === 'entrada') return (atual - anterior) / Math.abs(anterior);
    return (Math.abs(atual) - Math.abs(anterior)) / Math.abs(anterior);
  }

  function classeVariacao(natureza, pct) {
    if (pct == null || pct === 0) return null;
    if (natureza === 'entrada') return pct > 0 ? 'melhor' : 'pior';
    return pct > 0 ? 'pior' : 'melhor';
  }

  // Mês corrente nunca é completo (o dia de hoje ainda não acabou).
  function mesCompleto(ym, hoje) {
    const corrente = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    return ym < corrente;
  }

  function media(valores) {
    if (!valores.length) return null;
    return valores.reduce((s, v) => s + v, 0) / valores.length;
  }

  function nivelAnomalia(valor, mediaVal, nMesesCompletos) {
    if (nMesesCompletos < 3 || mediaVal == null || Math.abs(mediaVal) < ZERO) return null;
    const razao = Math.abs(valor) / Math.abs(mediaVal);
    if (razao > 1.5) return 'vermelho';
    if (razao > 1.25) return 'ambar';
    return null;
  }

  // mesesCompletos: DREs de meses completos. PE = fixas médias mensais / margem de contribuição.
  function pontoEquilibrio(mesesCompletos) {
    if (!mesesCompletos.length) return { erro: 'sem meses completos no período' };
    let receita = 0, variaveis = 0, fixas = 0;
    for (const m of mesesCompletos) {
      receita += somaGrupos(m, ['1']);
      variaveis += somaGrupos(m, VARIAVEIS);
      fixas += somaGrupos(m, FIXAS);
    }
    if (receita <= ZERO) return { erro: 'sem receita no período' };
    const mcPct = 1 - Math.abs(variaveis) / receita;
    if (mcPct <= 0) return { erro: 'margem de contribuição não positiva no período' };
    const fixasMediaMes = Math.abs(fixas) / mesesCompletos.length;
    return { pe: fixasMediaMes / mcPct, mcPct, fixasMediaMes };
  }

  // Projeção do mês corrente. Receita linear por dia corrido; variáveis pelo % histórico;
  // fixas pela média histórica (fallback linear, marcado fixasAproximada).
  function projecaoMes(mesParcial, mesesCompletos, hoje) {
    const diasMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
    const diasCorridos = hoje.getDate();
    if (diasCorridos < 1) return null;
    const receitaAtual = somaGrupos(mesParcial, ['1']);
    const receitaProj = receitaAtual / diasCorridos * diasMes;
    let pctVar, fixasProj, fixasAproximada = false;
    if (mesesCompletos.length) {
      const receitaHist = mesesCompletos.reduce((s, m) => s + somaGrupos(m, ['1']), 0);
      const varHist = mesesCompletos.reduce((s, m) => s + somaGrupos(m, VARIAVEIS), 0);
      pctVar = receitaHist > ZERO ? Math.abs(varHist) / receitaHist : 0;
      fixasProj = Math.abs(mesesCompletos.reduce((s, m) => s + somaGrupos(m, FIXAS), 0)) / mesesCompletos.length;
    } else {
      pctVar = receitaAtual > ZERO ? Math.abs(somaGrupos(mesParcial, VARIAVEIS)) / receitaAtual : 0;
      fixasProj = Math.abs(somaGrupos(mesParcial, FIXAS)) / diasCorridos * diasMes;
      fixasAproximada = true;
    }
    const variaveisProj = receitaProj * pctVar;
    return { receitaProj, variaveisProj, fixasProj, resultadoProj: receitaProj - variaveisProj - fixasProj, fixasAproximada };
  }

  // Conta de saída com maior estouro % (último mês completo vs média dos completos).
  function maiorDesvio(mesesCompletos) {
    if (mesesCompletos.length < 3) return null;
    const ultimo = mesesCompletos[mesesCompletos.length - 1];
    const porConta = new Map(); // codigo → { nome, porMes: {ym: total} }
    for (const m of mesesCompletos) for (const g of (m.grupos || [])) {
      if (g.codigo === '1') continue;
      for (const c of (g.contas || [])) {
        if (!porConta.has(c.codigo)) porConta.set(c.codigo, { nome: c.nome, porMes: {} });
        porConta.get(c.codigo).porMes[m.ym] = c.total;
      }
    }
    let top = null;
    for (const [codigo, info] of porConta) {
      const valores = mesesCompletos.map(m => info.porMes[m.ym] || 0);
      const med = media(valores);
      if (med == null || Math.abs(med) < ZERO) continue;
      const atual = info.porMes[ultimo.ym] || 0;
      const pct = (Math.abs(atual) - Math.abs(med)) / Math.abs(med);
      if (pct > 0 && (!top || pct > top.pct)) {
        top = { codigo, nome: info.nome, pct, ym: ultimo.ym, valor: atual, media: med };
      }
    }
    return top;
  }

  const api = { VARIAVEIS, FIXAS, somaGrupos, subtotais, av, variacao, classeVariacao,
    mesCompleto, media, nivelAnomalia, pontoEquilibrio, projecaoMes, maiorDesvio };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DREAnalise = api;
})(typeof window !== 'undefined' ? window : globalThis);
