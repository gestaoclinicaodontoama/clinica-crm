// Motor da Análise de Receita: separa o caixa recebido em ENTRADA NOVA
// (1ª parcela do contrato, InstallmentNumber 0) × BASE RECORRENTE (parcelas 1+)
// e deriva réguas, meta e colchão. Funções puras sobre os itens crus do
// /payment/list; datas podem vir com hora — tudo normalizado com slice.
// Convênio não passa pelo /payment/list — tudo aqui é particular.
const dia = (s) => (s || '').slice(0, 10);
const ym = (s) => dia(s).slice(0, 7);
const recebida = (it) => it.PaymentReceived === 'X' ||
  !!(it.ReceivedDate && dia(it.ReceivedDate) !== '' && dia(it.ReceivedDate) !== '0001-01-01');
const valor = (it) => Number(it.AmountWithDiscounts || it.Amount || it.TotalPostAmount) || 0;
const cancelada = (it) => it.Canceled === 'X' || it.Canceled === true;
// Entrada = parcela 0. Sem número de parcela → recorrente (conservador:
// nunca superestimar o dinheiro novo).
const ehEntrada = (it) => Number(it.InstallmentNumber) === 0;
const arred = (v) => Math.round(v * 100) / 100;
const FORMAS = ['Boleto', 'Cartão de Crédito'];
const formaDe = (it) => FORMAS.includes(it.PaymentForm) ? it.PaymentForm : 'outras';

// ['YYYY-MM', ...] do mais antigo ao mês corrente (n itens).
function mesesAtras(hojeISO, n) {
  let [y, m] = hojeISO.slice(0, 7).split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    let mm = m - i, yy = y;
    while (mm < 1) { mm += 12; yy--; }
    out.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  return out;
}

// Recebido por mês de ReceivedDate, separado entrada × recorrente.
// Inclui o mês corrente (parcial). Canceladas fora.
function decomposicao12m(items, hojeISO, nMeses = 12) {
  const ordem = mesesAtras(hojeISO, nMeses);
  const porMes = new Map(ordem.map(k => [k, { entrada: 0, recorrente: 0 }]));
  for (const it of (items || [])) {
    if (cancelada(it) || !recebida(it)) continue;
    const x = porMes.get(ym(it.ReceivedDate));
    if (!x) continue;
    if (ehEntrada(it)) x.entrada += valor(it); else x.recorrente += valor(it);
  }
  return ordem.map(k => { const x = porMes.get(k);
    return { mes: k, entrada: arred(x.entrada), recorrente: arred(x.recorrente) }; });
}

// Dos últimos N meses FECHADOS: do que venceu de parcela 1+, quanto caiu
// DENTRO do próprio mês (pagou atrasado = recuperação, não realização).
function taxaRealizacao(items, hojeISO, nMeses = 6) {
  const fechados = new Set(mesesAtras(hojeISO, nMeses + 1).slice(0, nMeses));
  const acc = { geral: { base: 0, realizado: 0 } };
  for (const f of [...FORMAS, 'outras']) acc[f] = { base: 0, realizado: 0 };
  for (const it of (items || [])) {
    if (cancelada(it) || ehEntrada(it)) continue;
    const mDue = ym(it.DueDate);
    if (!fechados.has(mDue)) continue;
    const v = valor(it);
    const ok = recebida(it) && ym(it.ReceivedDate) === mDue;
    for (const k of ['geral', formaDe(it)]) {
      acc[k].base += v;
      if (ok) acc[k].realizado += v;
    }
  }
  const out = {};
  for (const k of Object.keys(acc)) out[k] = {
    taxa: acc[k].base ? Math.round(acc[k].realizado / acc[k].base * 1000) / 1000 : null,
    base: arred(acc[k].base), realizado: arred(acc[k].realizado),
  };
  return out;
}

// Realização mês a mês (últimos N fechados), por forma. Fração 0–1 ou null.
function realizacaoPorMes(items, hojeISO, nMeses = 6) {
  const ordem = mesesAtras(hojeISO, nMeses + 1).slice(0, nMeses);
  const acc = new Map(ordem.map(k => [k,
    { Boleto: { b: 0, r: 0 }, 'Cartão de Crédito': { b: 0, r: 0 }, outras: { b: 0, r: 0 } }]));
  for (const it of (items || [])) {
    if (cancelada(it) || ehEntrada(it)) continue;
    const x = acc.get(ym(it.DueDate));
    if (!x) continue;
    const f = x[formaDe(it)];
    f.b += valor(it);
    if (recebida(it) && ym(it.ReceivedDate) === ym(it.DueDate)) f.r += valor(it);
  }
  const pct = (f) => f.b ? Math.round(f.r / f.b * 1000) / 1000 : null;
  return ordem.map(k => { const x = acc.get(k);
    return { mes: k, boleto: pct(x.Boleto), cartao: pct(x['Cartão de Crédito']), outras: pct(x.outras) }; });
}

module.exports = { decomposicao12m, taxaRealizacao, realizacaoPorMes,
  _interno: { mesesAtras, formaDe, ehEntrada, recebida, valor, cancelada, arred, dia, ym } };
