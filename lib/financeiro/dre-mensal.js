const { montarDRE } = require('./dre');

// Range de meses 'YYYY-MM' inclusive, a partir de datas 'YYYY-MM-DD'.
function listarMeses(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const fim = to.slice(0, 7);
  for (;;) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    if (ym > fim) break;
    out.push(ym);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// rows = saída da RPC fin_dre_agg_mensal; meses do range sem lançamento entram zerados.
function montarDREMensal(rows, from, to) {
  const porMes = new Map();
  for (const r of rows) {
    if (!porMes.has(r.ym)) porMes.set(r.ym, []);
    porMes.get(r.ym).push({ fluxo: r.fluxo, valor: Number(r.total), conta_codigo: r.conta_codigo });
  }
  return listarMeses(from, to).map(ym => ({ ym, ...montarDRE(porMes.get(ym) || []) }));
}

module.exports = { montarDREMensal, listarMeses };
