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

  // Exceção fixo×variável (Luiz, 04/07/26): remuneração fixa de dentistas (3.2.3) fica no
  // grupo 3.2 na CASCATA (é mão de obra de dentista), mas é despesa FIXA nas fórmulas
  // de PE/projeção/cards. Só o pagamento do Joaquim (3.2.1) varia com a produção.
  const FIXAS_CONTAS = ['3.2.3'];
  const somaConta = (dre, codigo) => {
    let s = 0;
    for (const g of (dre.grupos || [])) for (const c of (g.contas || [])) {
      if (c.codigo === codigo) s += c.total;
    }
    return s;
  };
  const fixasExtra = (dre) => FIXAS_CONTAS.reduce((s, cod) => s + somaConta(dre, cod), 0);
  const variaveisDe = (dre) => somaGrupos(dre, VARIAVEIS) - fixasExtra(dre);
  const fixasDe = (dre) => somaGrupos(dre, FIXAS) + fixasExtra(dre);

  function subtotais(dre) {
    const receitaBruta = somaGrupos(dre, ['1']);
    const receitaLiquida = receitaBruta + somaGrupos(dre, ['2']);
    const lucroBruto = receitaLiquida + somaGrupos(dre, ['3.0', '3.1', '3.2', '3.3']);
    const resultadoOperacional = lucroBruto + somaGrupos(dre, ['4']);
    const resultadoFinal = resultadoOperacional + somaGrupos(dre, ['5', '7']);
    const resultadoAposDistribuicoes = resultadoFinal + somaGrupos(dre, ['8']);
    return { receitaBruta, receitaLiquida, lucroBruto, resultadoOperacional, resultadoFinal, resultadoAposDistribuicoes };
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
      variaveis += variaveisDe(m);
      fixas += fixasDe(m);
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
      const varHist = mesesCompletos.reduce((s, m) => s + variaveisDe(m), 0);
      pctVar = receitaHist > ZERO ? Math.abs(varHist) / receitaHist : 0;
      fixasProj = Math.abs(mesesCompletos.reduce((s, m) => s + fixasDe(m), 0)) / mesesCompletos.length;
    } else {
      pctVar = receitaAtual > ZERO ? Math.abs(variaveisDe(mesParcial)) / receitaAtual : 0;
      fixasProj = Math.abs(fixasDe(mesParcial)) / diasCorridos * diasMes;
      fixasAproximada = true;
    }
    const variaveisProj = receitaProj * pctVar;
    return { receitaProj, variaveisProj, fixasProj, resultadoProj: receitaProj - variaveisProj - fixasProj, fixasAproximada };
  }

  // Saídas operacionais do período (grupo 8 = distribuição fica fora: é destino do
  // lucro, não custo de rodar). Valores positivos p/ exibição.
  function resumoSaidas(dreTotal, nMeses) {
    const variaveis = Math.abs(variaveisDe(dreTotal));
    const fixas = Math.abs(fixasDe(dreTotal));
    const outras = Math.abs(somaGrupos(dreTotal, ['5', '7']));
    const total = variaveis + fixas + outras;
    return { total, mediaMes: nMeses > 0 ? total / nMeses : null, variaveis, fixas, outras };
  }

  // Quanto a receita pode CAIR antes do prejuízo: (receita média − PE) / receita média.
  function margemSeguranca(mesesCompletos) {
    const pe = pontoEquilibrio(mesesCompletos);
    if (pe.erro) return null;
    const receitaMediaMes = mesesCompletos.reduce((s, m) => s + somaGrupos(m, ['1']), 0) / mesesCompletos.length;
    if (receitaMediaMes <= ZERO) return null;
    return { pct: (receitaMediaMes - pe.pe) / receitaMediaMes, receitaMediaMes, pe: pe.pe };
  }

  // Fração da receita consumida pelos custos variáveis (impostos + custos 3.x).
  function variaveisPctReceita(dreTotal) {
    const receita = somaGrupos(dreTotal, ['1']);
    if (receita <= ZERO) return null;
    return Math.abs(variaveisDe(dreTotal)) / receita;
  }

  // Distribuição de lucro do período e o que sobrou retido na clínica.
  function resumoDistribuicoes(dreTotal) {
    const total = Math.abs(somaGrupos(dreTotal, ['8']));
    return { total, retido: subtotais(dreTotal).resultadoAposDistribuicoes };
  }

  // Conta de saída com maior estouro em R$ (último mês completo vs média dos completos).
  // Materialidade: só vira KPI se estourou ≥ R$1.000 E ≥ 25% acima da média — sem isso
  // uma conta miúda (ex.: moto taxi +33% = R$26) ou a variação normal de uma conta grande
  // ocupavam o card. Entre estouros relevantes, ganha o que mais dói no caixa (R$, não %).
  const DESVIO_MIN_REAIS = 1000;
  const DESVIO_MIN_PCT = 0.25;
  function maiorDesvio(mesesCompletos) {
    if (mesesCompletos.length < 3) return null;
    const ultimo = mesesCompletos[mesesCompletos.length - 1];
    const porConta = new Map(); // codigo → { nome, porMes: {ym: total} }
    for (const m of mesesCompletos) for (const g of (m.grupos || [])) {
      // 2 = imposto segue a receita (subir junto não é estouro); 8 = distribuição é decisão
      if (g.codigo === '1' || g.codigo === '2' || g.codigo === '8') continue;
      for (const c of (g.contas || [])) {
        if (!porConta.has(c.codigo)) porConta.set(c.codigo, { nome: c.nome, porMes: {} });
        porConta.get(c.codigo).porMes[m.ym] = c.total;
      }
    }
    let top = null;
    for (const [codigo, info] of porConta) {
      // Base = meses ANTERIORES ao último; incluir o próprio mês do estouro diluía o sinal.
      const valores = mesesCompletos.slice(0, -1).map(m => info.porMes[m.ym] || 0);
      const med = media(valores);
      if (med == null || Math.abs(med) < ZERO) continue;
      const atual = info.porMes[ultimo.ym] || 0;
      const delta = Math.abs(atual) - Math.abs(med);
      const pct = delta / Math.abs(med);
      if (delta >= DESVIO_MIN_REAIS && pct >= DESVIO_MIN_PCT && (!top || delta > top.delta)) {
        top = { codigo, nome: info.nome, pct, delta, ym: ultimo.ym, valor: atual, media: med };
      }
    }
    return top;
  }

  // Curva média dos meses completos: fração ACUMULADA da receita/saída do mês
  // já realizada até cada dia (1..31). rows = saída da RPC fin_agg_diario.
  // Corrige o front-loading (despesas concentradas no início do mês) que fazia
  // a projeção linear explodir nos primeiros dias.
  function curvaDiaria(rows) {
    const porMes = new Map();
    for (const r of (rows || [])) {
      if (!porMes.has(r.ym)) porMes.set(r.ym, []);
      porMes.get(r.ym).push({ dia: Number(r.dia), receita: Number(r.receita), saida: Number(r.saida) });
    }
    const listasR = [], listasS = [];
    let meses = 0;
    for (const dias of porMes.values()) {
      const totR = dias.reduce((s, d) => s + d.receita, 0);
      const totS = dias.reduce((s, d) => s + d.saida, 0);
      if (totR <= ZERO && totS <= ZERO) continue;
      meses++;
      const byDia = new Map(dias.map(d => [d.dia, d]));
      let accR = 0, accS = 0;
      for (let d = 1; d <= 31; d++) {
        const x = byDia.get(d);
        if (x) { accR += x.receita; accS += x.saida; }
        if (totR > ZERO) (listasR[d - 1] = listasR[d - 1] || []).push(accR / totR);
        if (totS > ZERO) (listasS[d - 1] = listasS[d - 1] || []).push(accS / totS);
      }
    }
    if (!meses) return null;
    const avg = (listas) => Array.from({ length: 31 }, (_, i) =>
      (listas[i] && listas[i].length) ? listas[i].reduce((s, v) => s + v, 0) / listas[i].length : null);
    return { receita: avg(listasR), saida: avg(listasS), meses };
  }

  // Projeção calibrada: realizado ÷ fração histórica até o dia D (cada lado com
  // a sua curva). Confiança baixa nos primeiros dias / frações minúsculas.
  function projecaoMesCurva(mesParcial, curva, hoje) {
    if (!curva) return null;
    const d = Math.min(hoje.getDate(), 31);
    const fr = curva.receita[d - 1], fs = curva.saida[d - 1];
    if (fr == null || fs == null) return null;
    const MIN = 0.03; // piso: fração ínfima multiplicaria o realizado por >33x
    const receitaAtual = somaGrupos(mesParcial, ['1']);
    const saidaAtual = Math.abs(variaveisDe(mesParcial)) + Math.abs(fixasDe(mesParcial));
    const receitaProj = receitaAtual / Math.max(fr, MIN);
    const saidaProj = saidaAtual / Math.max(fs, MIN);
    const confianca = (d <= 5 || fr < 0.15 || fs < 0.15) ? 'baixa' : 'alta';
    return { receitaProj, saidaProj, resultadoProj: receitaProj - saidaProj,
      confianca, fracReceita: fr, fracSaida: fs, metodo: 'curva' };
  }

  const api = { VARIAVEIS, FIXAS, somaGrupos, subtotais, av, variacao, classeVariacao,
    mesCompleto, media, nivelAnomalia, pontoEquilibrio, projecaoMes, maiorDesvio,
    curvaDiaria, projecaoMesCurva, variaveisDe, fixasDe,
    resumoSaidas, margemSeguranca, variaveisPctReceita, resumoDistribuicoes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DREAnalise = api;
})(typeof window !== 'undefined' ? window : globalThis);
