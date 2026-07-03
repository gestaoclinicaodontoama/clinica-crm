// Análises da carteira de parcelas (/payment/list) p/ a página A Receber / A Pagar.
// Puras: recebem os itens crus e datas 'YYYY-MM-DD'; datas dos itens podem vir
// com hora ('...T03:00Z') — tudo normalizado com slice(0,10).
function recebida(it) {
  return it.PaymentReceived === 'X' ||
    !!(it.ReceivedDate && it.ReceivedDate !== '' && it.ReceivedDate.slice(0, 10) !== '0001-01-01');
}
const valor = (it) => Number(it.AmountWithDiscounts || it.Amount || it.TotalPostAmount || 0) || 0;
const dia = (s) => (s || '').slice(0, 10);
const diasEntre = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
const fimDoMes = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // m 1-based

// Vencido em aberto por idade (dias desde o vencimento).
function agingVencido(items, hojeISO) {
  const FAIXAS = [['1–30', 30], ['31–60', 60], ['61–90', 90], ['91–180', 180], ['180+', Infinity]];
  const faixas = FAIXAS.map(([faixa]) => ({ faixa, valor: 0 }));
  let total = 0;
  for (const it of (items || [])) {
    if (recebida(it)) continue;
    const due = dia(it.DueDate);
    if (!due || due >= hojeISO) continue;
    const dias = diasEntre(hojeISO, due);
    const i = FAIXAS.findIndex(([, lim]) => dias <= lim);
    faixas[i].valor += valor(it);
    total += valor(it);
  }
  const arred = (v) => Math.round(v * 100) / 100;
  return { faixas: faixas.map(f => ({ faixa: f.faixa, valor: arred(f.valor) })), total: arred(total) };
}

// Taxa histórica de não-recebimento: das parcelas MADURAS (vencidas há 180+ dias),
// que fração do valor nunca foi recebida. Recebida atrasada conta como recebida.
function taxaPerda(items, hojeISO) {
  let base = 0, perdido = 0;
  for (const it of (items || [])) {
    const due = dia(it.DueDate);
    if (!due || diasEntre(hojeISO, due) <= 180) continue;
    base += valor(it);
    if (!recebida(it)) perdido += valor(it);
  }
  const arred = (v) => Math.round(v * 100) / 100;
  return { taxa: base ? Math.round((perdido / base) * 1000) / 1000 : 0, base: arred(base), perdido: arred(perdido) };
}

// Renovação da carteira: valor lançado (PostDate) × recebido (ReceivedDate) por mês.
function novasERecebidasPorMes(items, hojeISO, nMeses = 12) {
  let [y, m] = hojeISO.slice(0, 7).split('-').map(Number);
  const porMes = new Map();
  const ordem = [];
  for (let i = nMeses - 1; i >= 0; i--) {
    let ym = m - i, yy = y;
    while (ym < 1) { ym += 12; yy--; }
    const k = `${yy}-${String(ym).padStart(2, '0')}`;
    porMes.set(k, { mes: k, novas: 0, recebidas: 0 });
    ordem.push(k);
  }
  for (const it of (items || [])) {
    const post = dia(it.PostDate).slice(0, 7);
    if (porMes.has(post)) porMes.get(post).novas += valor(it);
    if (recebida(it)) {
      const rec = dia(it.ReceivedDate).slice(0, 7);
      if (porMes.has(rec)) porMes.get(rec).recebidas += valor(it);
    }
  }
  return ordem.map(k => { const x = porMes.get(k);
    return { mes: k, novas: Math.round(x.novas * 100) / 100, recebidas: Math.round(x.recebidas * 100) / 100 }; });
}

// Carteira A VENCER no fim de cada mês passado: lançada até X, vencimento depois
// de X e ainda não recebida em X. Aproximação (parcelas canceladas/renegociadas
// não aparecem mais no /payment/list de hoje).
function carteiraRetroativa(items, hojeISO, nMeses = 24) {
  let [y, m] = hojeISO.slice(0, 7).split('-').map(Number);
  const pontos = [];
  for (let i = nMeses; i >= 1; i--) {
    let ym = m - i, yy = y;
    while (ym < 1) { ym += 12; yy--; }
    pontos.push({ mes: `${yy}-${String(ym).padStart(2, '0')}`, X: fimDoMes(yy, ym), receber: 0 });
  }
  for (const it of (items || [])) {
    const post = dia(it.PostDate), due = dia(it.DueDate);
    if (!post || !due) continue;
    const rec = recebida(it) ? dia(it.ReceivedDate) : null;
    for (const p of pontos) {
      if (post <= p.X && due > p.X && (!rec || rec > p.X)) p.receber += valor(it);
    }
  }
  return pontos.map(p => ({ mes: p.mes, receber: Math.round(p.receber * 100) / 100 }));
}

// Concentração: futuro a vencer somado por pagador (PayerName), top N.
function topPagadores(items, hojeISO, n = 10) {
  const por = new Map();
  for (const it of (items || [])) {
    if (recebida(it)) continue;
    const due = dia(it.DueDate);
    if (!due || due < hojeISO) continue;
    const k = String(it.PatientId || it.PayerName || '?');
    if (!por.has(k)) por.set(k, { nome: it.PayerName || `Paciente ${k}`, valor: 0 });
    por.get(k).valor += valor(it);
  }
  return [...por.values()].sort((a, b) => b.valor - a.valor).slice(0, n)
    .map(x => ({ nome: x.nome, valor: Math.round(x.valor * 100) / 100 }));
}

module.exports = { agingVencido, taxaPerda, novasERecebidasPorMes, carteiraRetroativa, topPagadores };
