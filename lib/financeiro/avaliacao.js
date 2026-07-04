// Fatos calculados p/ a "Avaliação do consultor" da DRE — matemática exata aqui;
// a IA só escreve a leitura em cima destes números (nunca calcula nada).
// Entradas: arrays de DREs mensais do montarDREMensal ({ ym, receita, grupos, resultado }).
const A = require('../../public/js/financeiro/dre-analise.js');

const soma = (meses, grupos) => meses.reduce((s, m) => s + A.somaGrupos(m, grupos), 0);
// Resultado ANTES da distribuição de lucro (grupo 8): margem/PE avaliam a operação.
const somaResultado = (meses) => meses.reduce((s, m) => s + A.subtotais(m).resultadoFinal, 0);
const arred = (v) => (v == null ? null : Math.round(v * 100) / 100);
const pct = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

// Top desvios de contas de saída: média mensal do período vs média mensal do contexto.
function topDesvios(periodo, contexto, n = 3) {
  const acumular = (meses) => {
    const por = new Map();
    for (const m of meses) for (const g of (m.grupos || [])) {
      if (g.codigo === '1' || g.codigo === '8') continue; // 8 = distribuição: decisão, não estouro
      for (const c of (g.contas || [])) {
        const cur = por.get(c.codigo) || { nome: c.nome, total: 0 };
        cur.total += Math.abs(c.total);
        por.set(c.codigo, cur);
      }
    }
    return por;
  };
  const per = acumular(periodo), ctx = acumular(contexto);
  const out = [];
  for (const [codigo, p] of per) {
    const mediaMesPeriodo = p.total / periodo.length;
    const mediaMesContexto = (ctx.get(codigo)?.total || 0) / contexto.length;
    if (mediaMesPeriodo < 500 && mediaMesContexto < 500) continue; // ruído
    out.push({ codigo, nome: p.nome,
      mediaMesPeriodo: arred(mediaMesPeriodo), mediaMesContexto: arred(mediaMesContexto),
      deltaMes: arred(mediaMesPeriodo - mediaMesContexto),
      deltaPct: mediaMesContexto > 0 ? pct((mediaMesPeriodo - mediaMesContexto) / mediaMesContexto) : null });
  }
  out.sort((a, b) => Math.abs(b.deltaMes) - Math.abs(a.deltaMes));
  return out.slice(0, n);
}

// periodo = meses selecionados; contexto = até 6 meses completos ANTES do período;
// anoAnterior = mesmos meses do ano anterior. contexto/anoAnterior podem ser [].
function montarFatos({ periodo, contexto = [], anoAnterior = [] }) {
  const receita = soma(periodo, ['1']);
  const resultado = somaResultado(periodo);
  const fatos = {
    meses: periodo.map(m => m.ym),
    receita: arred(receita), resultado: arred(resultado),
    margem: receita > 0 ? pct(resultado / receita) : null,
    variaveisPctReceita: receita > 0 ? pct(Math.abs(soma(periodo, A.VARIAVEIS)) / receita) : null,
    fixasMediaMes: arred(Math.abs(soma(periodo, A.FIXAS)) / periodo.length),
  };
  const distribuicoes = Math.abs(soma(periodo, ['8']));
  if (distribuicoes > 0) fatos.distribuicoes = arred(distribuicoes);
  if (contexto.length) {
    const recCtx = soma(contexto, ['1']);
    const resCtx = somaResultado(contexto);
    fatos.contexto = {
      meses: contexto.map(m => m.ym),
      receitaMediaMes: arred(recCtx / contexto.length),
      resultadoMedioMes: arred(resCtx / contexto.length),
      margemMedia: recCtx > 0 ? pct(resCtx / recCtx) : null,
      variaveisPctReceita: recCtx > 0 ? pct(Math.abs(soma(contexto, A.VARIAVEIS)) / recCtx) : null,
      fixasMediaMes: arred(Math.abs(soma(contexto, A.FIXAS)) / contexto.length),
    };
    const recMes = receita / periodo.length;
    fatos.vsContexto = {
      receitaMediaMesPct: fatos.contexto.receitaMediaMes > 0
        ? pct((recMes - fatos.contexto.receitaMediaMes) / fatos.contexto.receitaMediaMes) : null,
      margemPontosPct: (fatos.margem != null && fatos.contexto.margemMedia != null)
        ? arred((fatos.margem - fatos.contexto.margemMedia) * 100) : null,
    };
    fatos.desvios = topDesvios(periodo, contexto, 3);
    const pe = A.pontoEquilibrio(contexto);
    if (pe && !pe.erro) {
      fatos.pontoEquilibrio = { receitaNecessariaMes: arred(pe.pe),
        receitaMediaMesPeriodo: arred(recMes),
        folgaPct: pe.pe > 0 ? pct((recMes - pe.pe) / pe.pe) : null };
    }
  }
  if (anoAnterior.length) {
    const recAA = soma(anoAnterior, ['1']);
    fatos.anoAnterior = {
      meses: anoAnterior.map(m => m.ym),
      receita: arred(recAA), resultado: arred(somaResultado(anoAnterior)),
      crescimentoReceitaPct: recAA > 0 ? pct((receita - recAA) / recAA) : null,
    };
  }
  return fatos;
}

// Todas as contas (receita e saída) com média mensal do período vs contexto —
// grão necessário p/ perguntas específicas ("por que material subiu?").
function contasDetalhadas(periodo, contexto = []) {
  const acumular = (meses) => {
    const por = new Map();
    for (const m of meses) for (const g of (m.grupos || [])) {
      for (const c of (g.contas || [])) {
        const cur = por.get(c.codigo) || { nome: c.nome, grupo: g.titulo || g.codigo, total: 0 };
        cur.total += c.total;
        por.set(c.codigo, cur);
      }
    }
    return por;
  };
  const per = acumular(periodo), ctx = acumular(contexto);
  const out = [];
  for (const [codigo, p] of per) {
    const mediaMesPeriodo = p.total / periodo.length;
    const mediaMesContexto = contexto.length ? (ctx.get(codigo)?.total || 0) / contexto.length : null;
    if (Math.abs(mediaMesPeriodo) < 1 && (mediaMesContexto == null || Math.abs(mediaMesContexto) < 1)) continue;
    out.push({ codigo, nome: p.nome, grupo: p.grupo,
      totalPeriodo: arred(p.total), mediaMesPeriodo: arred(mediaMesPeriodo),
      mediaMesContexto: arred(mediaMesContexto),
      deltaPct: (mediaMesContexto && Math.abs(mediaMesContexto) > 1)
        ? pct((Math.abs(mediaMesPeriodo) - Math.abs(mediaMesContexto)) / Math.abs(mediaMesContexto)) : null });
  }
  out.sort((a, b) => a.codigo.localeCompare(b.codigo, undefined, { numeric: true }));
  return out;
}

module.exports = { montarFatos, topDesvios, contasDetalhadas };
