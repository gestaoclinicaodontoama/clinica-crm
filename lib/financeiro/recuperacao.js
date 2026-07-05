// lib/financeiro/recuperacao.js
// Análises de RESULTADO da cobrança (/payment/list) p/ a aba Inadimplência.
// Puras: recebem itens crus + data 'YYYY-MM-DD'; datas podem vir com hora → slice(0,10).

const dia = s => (s || '').slice(0, 10);
const valor = it => Number(it.AmountWithDiscounts || it.Amount || it.TotalPostAmount || 0) || 0;
function recebida(it) {
  return it.PaymentReceived === 'X' ||
    !!(it.ReceivedDate && it.ReceivedDate !== '' && dia(it.ReceivedDate) !== '0001-01-01');
}
const arred = v => Math.round(v * 100) / 100;

// Meses 'YYYY-MM' dos últimos n (mais antigo → mês atual).
function ultimosMeses(hojeISO, n) {
  let [y, m] = hojeISO.slice(0, 7).split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    let ym = m - i, yy = y;
    while (ym < 1) { ym += 12; yy--; }
    out.push(`${yy}-${String(ym).padStart(2, '0')}`);
  }
  return out;
}

// Recuperação por COORTE do mês de vencimento.
function recuperacaoPorMes(items, hojeISO, nMeses = 12) {
  const hoje = dia(hojeISO);
  const meses = ultimosMeses(hojeISO, nMeses);
  const set = new Set(meses);
  const map = new Map(meses.map(mes => [mes, { atrasou: 0, recuperado: 0 }]));
  for (const it of (items || [])) {
    const due = dia(it.DueDate);
    if (!due) continue;
    const mes = due.slice(0, 7);
    if (!set.has(mes)) continue;
    const rec = recebida(it);
    const recDate = rec ? dia(it.ReceivedDate) : null;
    const atrasou = due <= hoje && (!rec || (recDate && recDate > due)); // venceu, e não paga ou paga depois do vencimento
    if (!atrasou) continue;
    const v = valor(it);
    const o = map.get(mes);
    o.atrasou += v;
    if (rec) o.recuperado += v;
  }
  return meses.map(mes => {
    const o = map.get(mes);
    const a = arred(o.atrasou), r = arred(o.recuperado);
    return { mes, atrasou: a, recuperado: r, taxa: a > 0 ? Math.round((r / a) * 1000) / 1000 : null };
  });
}

// Saldo VENCIDO em aberto no fim de cada mês (retroativo). Mês corrente cortado em hoje.
function vencidoRetroativo(items, hojeISO, nMeses = 24) {
  const hoje = dia(hojeISO);
  const fimMes = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
  const meses = ultimosMeses(hoje, nMeses);
  const pontos = meses.map(mes => { const fm = fimMes(mes); return { mes, X: fm > hoje ? hoje : fm, vencido: 0 }; });
  for (const it of (items || [])) {
    const due = dia(it.DueDate);
    if (!due) continue;
    const rec = recebida(it) ? dia(it.ReceivedDate) : null;
    const v = valor(it);
    for (const p of pontos) {
      if (due <= p.X && (!rec || rec > p.X)) p.vencido += v;
    }
  }
  return pontos.map(p => ({ mes: p.mes, vencido: arred(p.vencido) }));
}

module.exports = { recuperacaoPorMes, vencidoRetroativo };
