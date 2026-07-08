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

// Retrato do mês corrente: recorrente a vencer (cru), previsto (cru × taxa
// da forma, cai pra geral e depois 1 se não houver histórico) e já recebidos.
function mesCorrente(items, hojeISO, realizacao) {
  const mesAtual = hojeISO.slice(0, 7);
  const out = { recorrenteCru: 0, recorrentePrevisto: 0, recorrenteRecebido: 0, entradaRecebida: 0 };
  for (const it of (items || [])) {
    if (cancelada(it)) continue;
    if (recebida(it) && ym(it.ReceivedDate) === mesAtual) {
      if (ehEntrada(it)) out.entradaRecebida += valor(it);
      else out.recorrenteRecebido += valor(it);
    }
    if (!ehEntrada(it) && ym(it.DueDate) === mesAtual) {
      const v = valor(it);
      out.recorrenteCru += v;
      const t = realizacao?.[formaDe(it)]?.taxa ?? realizacao?.geral?.taxa ?? 1;
      out.recorrentePrevisto += v * (t == null ? 1 : t);
    }
  }
  for (const k of Object.keys(out)) out[k] = arred(out[k]);
  return out;
}

// Se parar de vender hoje: recorrente já contratado a vencer nos próximos
// nMeses (a partir do mês SEGUINTE), ajustado pela taxa geral de realização.
// mesesCobertos = meses CONSECUTIVOS com previsto ≥ régua das fixas.
function colchao(items, hojeISO, taxaGeral, reguaFixas, nMeses = 24) {
  let [y, m] = hojeISO.slice(0, 7).split('-').map(Number);
  const ordem = [];
  for (let i = 1; i <= nMeses; i++) {
    let mm = m + i, yy = y;
    while (mm > 12) { mm -= 12; yy++; }
    ordem.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  const porMes = new Map(ordem.map(k => [k, 0]));
  for (const it of (items || [])) {
    if (cancelada(it) || ehEntrada(it) || recebida(it)) continue;
    const k = ym(it.DueDate);
    if (porMes.has(k)) porMes.set(k, porMes.get(k) + valor(it));
  }
  const t = taxaGeral == null ? 1 : taxaGeral;
  const meses = ordem.map(k => ({ mes: k, cru: arred(porMes.get(k)), previsto: arred(porMes.get(k) * t) }));
  let cobertos = 0;
  if (reguaFixas > 0) { for (const x of meses) { if (x.previsto >= reguaFixas) cobertos++; else break; } }
  return { meses, mesesCobertos: reguaFixas > 0 ? cobertos : null };
}

// Regressão linear simples sobre o recorrente dos meses FECHADOS.
// Por régua: 'cruzou' (média dos últimos 3 fechados ≥ régua), 'a_caminho'
// (inclinação > 0 → meses até a reta cruzar, contados do último mês fechado)
// ou 'nao_cruza'. Régua nula/≤0 → null.
function rumoAoDegrau(decomposicao, hojeISO, reguas) {
  const mesAtual = hojeISO.slice(0, 7);
  const serie = (decomposicao || []).filter(d => d.mes < mesAtual).map(d => d.recorrente);
  const n = serie.length;
  if (n < 3) return { erro: 'historico insuficiente' };
  const mx = (n - 1) / 2, my = serie.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (i - mx) * (serie[i] - my); sxx += (i - mx) ** 2; }
  const b = sxy / sxx, a = my - b * mx;
  const media3 = serie.slice(-3).reduce((s, v) => s + v, 0) / Math.min(3, n);
  const alvo = (regua) => {
    if (!(regua > 0)) return null;
    if (media3 >= regua) return { status: 'cruzou' };
    if (b <= 0) return { status: 'nao_cruza' };
    const faltam = Math.max(1, Math.ceil((regua - a) / b - (n - 1))); // meses após o último fechado
    let [yy, mm] = mesAtual.split('-').map(Number);
    mm += faltam - 1; // último fechado = mês anterior ao corrente
    while (mm > 12) { mm -= 12; yy++; }
    return { status: 'a_caminho', meses: faltam, mesAlvo: `${yy}-${String(mm).padStart(2, '0')}` };
  };
  return { tendencia: { a: arred(a), b: arred(b) }, media3: arred(media3),
    fixas: alvo(reguas?.fixas), total: alvo(reguas?.saidaTotal) };
}

// Σ entrada recebida ÷ Σ vendas fechadas nos últimos N meses fechados.
function razaoEntradaVenda(decomposicao, vendasPorMes, hojeISO, nMeses = 6) {
  const mesAtual = hojeISO.slice(0, 7);
  const fechados = new Set((decomposicao || [])
    .filter(d => d.mes < mesAtual).map(d => d.mes).slice(-nMeses));
  const entrada = (decomposicao || []).filter(d => fechados.has(d.mes)).reduce((s, d) => s + d.entrada, 0);
  const vendas = (vendasPorMes || []).filter(v => fechados.has(v.mes)).reduce((s, v) => s + v.vendas, 0);
  return { razao: vendas > 0 ? Math.round(entrada / vendas * 1000) / 1000 : null,
    entrada: arred(entrada), vendas: arred(vendas) };
}

// Calculadora do mês (planilha do Luiz, 08/07/26): entrada mínima p/ empatar e
// entrada p/ o lucro-alvo, em R$ e em % da meta de faturamento, + veredito de
// viabilidade contra a razão histórica entrada÷venda. Tudo R$ do mês corrente.
function calculadoraMes(p) {
  const { metaFaturamento, lucroPct, lucroReais, recebiveisLiquidos, contasAPagar,
    entradaRecebida, razaoHistorica, ticket } = p || {};
  if (!(contasAPagar > 0)) return { erro: 'contas a pagar indisponiveis' };
  const rec = recebiveisLiquidos || 0;
  const alvoDe = (fluxo) => {
    const entrada = Math.max(0, arred(fluxo - rec));
    return { entrada, pctFat: metaFaturamento > 0 ? Math.round(entrada / metaFaturamento * 1000) / 1000 : null };
  };
  const breakEven = alvoDe(contasAPagar);
  let comLucro = null;
  if (lucroPct > 0 && lucroPct < 1) {
    const fluxo = contasAPagar / (1 - lucroPct);
    comLucro = { ...alvoDe(fluxo), fluxoNecessario: arred(fluxo), lucroProjetado: arred(fluxo * lucroPct) };
  } else if (lucroReais > 0) {
    comLucro = { ...alvoDe(contasAPagar + lucroReais),
      fluxoNecessario: arred(contasAPagar + lucroReais), lucroProjetado: arred(lucroReais) };
  }
  const alvo = comLucro || breakEven;
  let viabilidade = null;
  if (alvo.pctFat != null && razaoHistorica > 0) {
    const razao = alvo.pctFat / razaoHistorica;
    viabilidade = { necessarioPct: alvo.pctFat, historicoPct: razaoHistorica,
      status: razao <= 0.9 ? 'confortavel' : razao <= 1.1 ? 'justo' : 'apertado' };
  }
  const restante = Math.max(0, arred(alvo.entrada - (entradaRecebida || 0)));
  return { breakEven, comLucro, viabilidade,
    progresso: { alvo: alvo.entrada, restante,
      vendasNecessarias: razaoHistorica > 0 ? arred(restante / razaoHistorica) : null,
      fechamentos: (razaoHistorica > 0 && ticket > 0) ? Math.ceil(restante / razaoHistorica / ticket) : null,
      batida: restante === 0 } };
}

// De hoje (inclusive) ao fim do mês: seg–sex = 1, sábado = 0,5.
function diasUteisRestantes(hojeISO) {
  const [y, m, d] = hojeISO.slice(0, 10).split('-').map(Number);
  const fim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let total = 0;
  for (let dd = d; dd <= fim; dd++) {
    const dow = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
    if (dow >= 1 && dow <= 5) total += 1;
    else if (dow === 6) total += 0.5;
  }
  return total;
}

// Safra = mês do PostDate (contrato lançado). Por safra: quanto foi aprovado,
// prazo médio CONTRATADO (aprovação→vencimento) e prazo médio REAL
// (aprovação→recebimento), ambos ponderados por valor, em meses (dias/30,44).
// emCurso: safra com menos de 6 meses — o prazo real ainda é provisório.
function safras(items, hojeISO, nSafras = 12) {
  const ordem = mesesAtras(hojeISO, nSafras);
  const acc = new Map(ordem.map(k => [k, { aprovado: 0, pesoDue: 0, recebido: 0, pesoRec: 0 }]));
  const mesesEntre = (a, b) => Math.max(0, (Date.parse(dia(b)) - Date.parse(dia(a))) / 86400000 / 30.44);
  for (const it of (items || [])) {
    if (cancelada(it)) continue;
    const s = acc.get(ym(it.PostDate));
    if (!s) continue;
    const v = valor(it);
    s.aprovado += v;
    if (dia(it.DueDate)) s.pesoDue += v * mesesEntre(it.PostDate, it.DueDate);
    if (recebida(it) && dia(it.ReceivedDate) && dia(it.ReceivedDate) !== '0001-01-01') {
      s.recebido += v;
      s.pesoRec += v * mesesEntre(it.PostDate, it.ReceivedDate);
    }
  }
  const mesAtual = hojeISO.slice(0, 7);
  const idade = (k) => { const [y1, m1] = k.split('-').map(Number);
    const [y2, m2] = mesAtual.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1); };
  const r1 = (v) => Math.round(v * 10) / 10;
  return ordem.map(k => { const s = acc.get(k);
    return { safra: k, aprovado: arred(s.aprovado),
      prazoContratado: s.aprovado ? r1(s.pesoDue / s.aprovado) : null,
      recebido: arred(s.recebido),
      pctRecebido: s.aprovado ? Math.round(s.recebido / s.aprovado * 1000) / 1000 : null,
      prazoReal: s.recebido ? r1(s.pesoRec / s.recebido) : null,
      emCurso: idade(k) < 6 };
  });
}

module.exports = { decomposicao12m, taxaRealizacao, realizacaoPorMes, mesCorrente,
  colchao, rumoAoDegrau, razaoEntradaVenda, calculadoraMes, diasUteisRestantes, safras,
  _interno: { mesesAtras, formaDe, ehEntrada, recebida, valor, cancelada, arred, dia, ym } };
