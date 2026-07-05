// Diagnóstico da saúde financeira — regras puras sobre os números que a página
// A Receber / A Pagar já carrega. Sem IA, sem custo: dá um semáforo (verde/amarelo/
// vermelho) + a frase do porquê pra cada indicador, e um resumo com as prioridades.
// Compartilhado browser (window.DiagnosticoSaude) e testes Node.
(function (global) {
  const TITULOS = {
    vencido: 'Vencido a receber',
    diferenca: 'Diferença (receber − pagar)',
    taxaPerda: 'Taxa de calote',
    agingAntigo: 'Vencido antigo (+180 dias)',
    concentracao: 'Concentração de pagadores',
    renovacao: 'Renovação da carteira',
    tendencia: 'Tendência da carteira',
    crescimento: 'Crescimento projetado',
  };
  const ACOES = {
    vencido: 'Régua de cobrança e 2ª via por WhatsApp nos primeiros 30 dias.',
    diferenca: 'Puxar vendas novas (ver a projeção) e adiantar recebíveis nos meses apertados.',
    taxaPerda: 'Cobrar cedo: quase todo calote vem de parcela que passou dos 180 dias.',
    agingAntigo: 'Renegociar o que está parado há meses antes que vire perda total.',
    concentracao: 'Reduzir dependência de poucos pagadores diversificando a base.',
    renovacao: 'Manter a entrada de novos contratos acima do que sai recebido.',
    tendencia: 'Sustentar o ritmo de fechamento para a carteira seguir crescendo.',
    crescimento: 'Manter o ritmo de vendas que vem sustentando o crescimento.',
  };
  const pct = (x) => Math.round(x * 100);

  function diagnosticoSaude(d) {
    const secoes = {};
    const add = (chave, nivel, frase) =>
      { secoes[chave] = { nivel, frase, titulo: TITULOS[chave], acao: ACOES[chave] }; };

    // menor é melhor: verde < bom, amarelo <= atencao, senão vermelho
    const nivelMenorMelhor = (v, bom, atencao) => v < bom ? 'verde' : v <= atencao ? 'amarelo' : 'vermelho';

    if (d.aReceber > 0 && d.vencido != null) {
      const p = d.vencido / d.aReceber;
      const n = nivelMenorMelhor(p, 0.05, 0.10);
      add('vencido', n, `${n === 'verde' ? 'Sob controle' : n === 'amarelo' ? 'Atenção' : 'Alto'}: ${pct(p)}% da carteira já venceu (ideal abaixo de 5%).`);
    }

    if (d.aReceber > 0 && d.diferenca != null) {
      const r = d.diferenca / d.aReceber;
      const n = d.diferenca >= 0 ? 'verde' : r >= -0.25 ? 'amarelo' : 'vermelho';
      add('diferenca', n, n === 'verde'
        ? 'Os contratos já fechados cobrem as contas lançadas no período.'
        : `Os contratos já fechados ficam ${pct(-r)}% abaixo das contas lançadas — mas isso não inclui as vendas novas que ainda vêm.`);
    }

    if (d.taxaPerda != null) {
      const n = nivelMenorMelhor(d.taxaPerda, 0.05, 0.10);
      add('taxaPerda', n, `${pct(d.taxaPerda)}% das parcelas vencidas nunca foram recebidas (ideal abaixo de 5%).`);
    }

    if (d.agingFaixas && d.agingFaixas.length) {
      const total = d.agingFaixas.reduce((s, f) => s + Number(f.valor || 0), 0);
      // "180+" é a faixa antiga — startsWith evita casar "91–180" (que também contém 180)
      const antigo = Number((d.agingFaixas.find(f => String(f.faixa).replace(/\s/g, '').startsWith('180')) || {}).valor || 0);
      if (total > 0) {
        const p = antigo / total;
        const n = nivelMenorMelhor(p, 0.25, 0.50);
        add('agingAntigo', n, `${pct(p)}% do vencido está parado há mais de 6 meses (quanto mais velho, menos se recupera).`);
      }
    }

    if (d.aReceber > 0 && d.maiorPagador != null) {
      const p = d.maiorPagador / d.aReceber;
      const n = nivelMenorMelhor(p, 0.10, 0.20);
      add('concentracao', n, `O maior pagador é ${pct(p)}% da carteira (acima de 20% vira risco de concentração).`);
    }

    if (d.renovacao && d.renovacao.length) {
      const novas = d.renovacao.reduce((s, r) => s + Number(r.novas || 0), 0);
      const receb = d.renovacao.reduce((s, r) => s + Number(r.recebidas || 0), 0);
      if (receb > 0) {
        const ratio = novas / receb;
        const n = ratio >= 1 ? 'verde' : ratio >= 0.8 ? 'amarelo' : 'vermelho';
        add('renovacao', n, n === 'verde'
          ? `Entra mais contrato novo do que sai recebido (${pct(ratio - 1) >= 0 ? '+' : ''}${pct(ratio - 1)}%) — a carteira se repõe.`
          : `Entra menos contrato novo do que sai recebido (${pct(ratio - 1)}%) — a carteira está encolhendo.`);
      }
    }

    if (d.tendenciaPct != null) {
      const t = d.tendenciaPct;
      const n = t > 0.02 ? 'verde' : t >= -0.02 ? 'amarelo' : 'vermelho';
      add('tendencia', n, n === 'verde' ? `A carteira cresceu ${pct(t)}% nos últimos 3 meses.`
        : n === 'amarelo' ? 'A carteira ficou praticamente estável nos últimos 3 meses.'
        : `A carteira encolheu ${pct(-t)}% nos últimos 3 meses.`);
    }

    if (d.crescimentoCaixa != null) {
      const g = d.crescimentoCaixa;
      const n = g > 0.05 ? 'verde' : g >= -0.05 ? 'amarelo' : 'vermelho';
      add('crescimento', n, n === 'verde' ? `O caixa vem crescendo ${pct(g)}% ao ano no seu histórico.`
        : n === 'amarelo' ? 'O caixa está praticamente estável no seu histórico.'
        : `O caixa vem encolhendo ${pct(-g)}% ao ano no seu histórico.`);
    }

    const entradas = Object.entries(secoes);
    const conta = (nv) => entradas.filter(([, s]) => s.nivel === nv).length;
    const ordem = { vermelho: 0, amarelo: 1 };
    const prioridades = entradas
      .filter(([, s]) => s.nivel !== 'verde')
      .sort((a, b) => ordem[a[1].nivel] - ordem[b[1].nivel])
      .map(([chave, s]) => ({ chave, nivel: s.nivel, titulo: s.titulo, acao: s.acao }));

    return {
      resumo: { vermelhos: conta('vermelho'), amarelos: conta('amarelo'), verdes: conta('verde'), prioridades },
      secoes,
    };
  }

  const api = { diagnosticoSaude, TITULOS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DiagnosticoSaude = api;
})(typeof window !== 'undefined' ? window : globalThis);
