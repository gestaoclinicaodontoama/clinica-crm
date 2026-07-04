// Projeção de crescimento (24 meses) a partir do histórico mensal de caixa,
// faturamento e saídas. Função pura, compartilhada browser (window.ProjecaoCresc)
// e testes Node. Entrada: [{ ym:'YYYY-MM', faturamento, caixa, saidas }, ...] em ordem.
//
// Método (explicável ao dono): cada mês futuro = MESMO mês do ano anterior × (1 +
// crescimento). Isso respeita a sazonalidade sozinho. O crescimento é o observado
// ano-a-ano (soma dos 12 meses recentes ÷ soma dos 12 anteriores). Cada métrica tem
// o seu (faturamento/caixa/saídas). Lucro é derivado: caixa − saídas.
//
// Cenários = multiplicadores sobre o crescimento medido (m1 = 1º ano, m2 = 2º ano):
//   conservador  metade do ritmo, desacelerando        (0.5 / 0.3)
//   provável     ritmo medido, desacelerando no 2º ano  (1.0 / 0.6)
//   otimista     ritmo medido +20%, mantido             (1.2 / 1.2)
(function (global) {
  const CENARIOS = {
    conservador: { m1: 0.5, m2: 0.3 },
    provavel: { m1: 1.0, m2: 0.6 },
    otimista: { m1: 1.2, m2: 1.2 },
  };

  const addMeses = (ym, n) => {
    let [y, m] = ym.split('-').map(Number);
    const idx = (y * 12 + (m - 1)) + n;
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
  };

  const somaJanela = (hist, campo, ini, fim) => // [ini, fim) por índice
    hist.slice(ini, fim).reduce((s, r) => s + (Number(r[campo]) || 0), 0);

  // Crescimento ano-a-ano: 12 meses mais recentes vs os 12 imediatamente anteriores.
  function crescimentoAnual(hist, campo) {
    const n = hist.length;
    const recentes = somaJanela(hist, campo, n - 12, n);
    const anteriores = somaJanela(hist, campo, n - 24, n - 12);
    if (anteriores <= 0) return 0;
    return recentes / anteriores - 1;
  }

  // Projeta uma métrica para `horizonte` meses. baseline de cada mês = mesmo mês do
  // ano anterior (do histórico no 1º ano, da própria projeção no 2º+).
  function projetarMetrica(hist, campo, gBase, mult, horizonte) {
    const porYm = new Map(hist.map(r => [r.ym, Number(r[campo]) || 0]));
    const ultimo = hist[hist.length - 1].ym;
    const proj = [];
    const projPorYm = new Map();
    for (let k = 1; k <= horizonte; k++) {
      const ym = addMeses(ultimo, k);
      const base = addMeses(ym, -12);
      const baseline = porYm.has(base) ? porYm.get(base) : (projPorYm.get(base) || 0);
      const g = gBase * (k <= 12 ? mult.m1 : mult.m2);
      const val = baseline * (1 + g);
      proj.push({ ym, val });
      projPorYm.set(ym, val);
    }
    return proj;
  }

  function projecaoCrescimento(historico, opts = {}) {
    const horizonte = opts.horizonte || 24;
    const hist = (historico || []).slice().sort((a, b) => a.ym < b.ym ? -1 : 1);
    if (hist.length < 24) return { erro: 'histórico insuficiente (precisa de ao menos 24 meses)' };

    const gFaturamento = crescimentoAnual(hist, 'faturamento');
    const gCaixa = crescimentoAnual(hist, 'caixa');
    const gSaidas = crescimentoAnual(hist, 'saidas');

    const projecao = {}, resumo = {};
    for (const [cen, mult] of Object.entries(CENARIOS)) {
      const faturamento = projetarMetrica(hist, 'faturamento', gFaturamento, mult, horizonte);
      const caixa = projetarMetrica(hist, 'caixa', gCaixa, mult, horizonte);
      const saidas = projetarMetrica(hist, 'saidas', gSaidas, mult, horizonte);
      const lucro = caixa.map((c, i) => ({ ym: c.ym, val: c.val - saidas[i].val }));
      projecao[cen] = { faturamento, caixa, saidas, lucro };
      const soma = (arr, ate) => arr.slice(0, ate).reduce((s, p) => s + p.val, 0);
      resumo[cen] = {};
      for (const met of ['faturamento', 'caixa', 'saidas', 'lucro']) {
        resumo[cen][met] = { m12: soma(projecao[cen][met], 12), m24: soma(projecao[cen][met], 24) };
      }
    }

    const historico12mais = hist.map(r => ({
      ym: r.ym, faturamento: Number(r.faturamento) || 0, caixa: Number(r.caixa) || 0,
      saidas: Number(r.saidas) || 0, lucro: (Number(r.caixa) || 0) - (Number(r.saidas) || 0),
    }));

    return { gFaturamento, gCaixa, gSaidas, horizonte, historico: historico12mais, projecao, resumo };
  }

  const api = { projecaoCrescimento, crescimentoAnual, CENARIOS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ProjecaoCresc = api;
})(typeof window !== 'undefined' ? window : globalThis);
