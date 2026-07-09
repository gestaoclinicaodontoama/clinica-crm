// lib/financeiro/inadimplencia.js
// Puras: agregam o /payment/list por paciente para cobrança e classificam os grupos
// por EXPOSIÇÃO REAL (entregue vs. pago) + engajamento (vem à clínica).
// Datas dos itens podem vir com hora — normalizar com slice(0,10).

const dia = s => (s || '').slice(0, 10);
const valorItem = it => Number(it.Amount || it.TotalPostAmount || it.AmountWithDiscounts || 0) || 0;
function recebida(it) {
  return it.PaymentReceived === 'X' ||
    !!(it.ReceivedDate && it.ReceivedDate !== '' && dia(it.ReceivedDate) !== '0001-01-01');
}
const limpaNome = n => String(n || '').replace(/\s*\(\d+\)\s*$/, '');

// Agrega por paciente; só devolve quem tem parcela vencida em aberto.
function agregarPorPaciente(items, today) {
  today = (today || '').slice(0, 10);
  const m = {};
  for (const it of (items || [])) {
    const id = String(it.PatientId || it.patientId || it.Patient_PersonId || '').trim();
    if (!id) continue;
    const paid = recebida(it);
    const due = dia(it.DueDate || it.due_date || it.PostDate || it.ScheduledDate || '');
    const v = valorItem(it);
    if (!m[id]) m[id] = {
      id, name: limpaNome(it.PatientName || it.patientName || it.Patient_PersonName || 'Paciente ' + id),
      phone: String(it.Phone || it.MobilePhone || it.phone || it.PayerPhone || ''),
      payerName: '', payerPhone: '', boletoUrl: '', boletoLinha: '', paymentForm: '',
      overdueAmount: 0, futureAmount: 0, overdueCount: 0, pago: 0,
      oldestDueDate: null, nextDueDate: null, _boletoDue: null, _payerDue: null, _formDue: null,
    };
    const p = m[id];
    if (paid) { p.pago += v; continue; }
    if (!due) continue;
    if (due < today) {
      p.overdueAmount += v; p.overdueCount++;
      if (!p.oldestDueDate || due < p.oldestDueDate) p.oldestDueDate = due;
      // pagador/boleto da vencida em aberto MAIS ANTIGA que tenha boleto
      if (it.BoletoUrl && (!p._boletoDue || due < p._boletoDue)) {
        p._boletoDue = due;
        p.boletoUrl = String(it.BoletoUrl || '');
        p.boletoLinha = String(it.BoletoDigitalLine || '');
      }
      // pagador/forma de pagamento da vencida em aberto MAIS ANTIGA que os carregue (array não é garantido em ordem de data)
      if (it.PayerName && (!p._payerDue || due < p._payerDue)) {
        p._payerDue = due;
        p.payerName = String(it.PayerName);
        p.payerPhone = String(it.PayerPhone || '');
      }
      if (it.PaymentForm && (!p._formDue || due < p._formDue)) {
        p._formDue = due;
        p.paymentForm = String(it.PaymentForm);
      }
    } else {
      p.futureAmount += v;
      if (!p.nextDueDate || due < p.nextDueDate) p.nextDueDate = due;
    }
  }
  const td = new Date(today);
  return Object.values(m).filter(p => p.overdueCount > 0).map(p => {
    delete p._boletoDue;
    delete p._payerDue;
    delete p._formDue;
    p.overdueAmount = Math.round(p.overdueAmount * 100) / 100;
    p.futureAmount = Math.round(p.futureAmount * 100) / 100;
    p.pago = Math.round(p.pago * 100) / 100;
    p.diasDeAtraso = p.oldestDueDate ? Math.floor((td - new Date(p.oldestDueDate)) / 86400000) : 0;
    p.diasParaProximo = p.nextDueDate ? Math.floor((new Date(p.nextDueDate) - td) / 86400000) : null;
    return p;
  });
}

function classificarESepararGrupos(pacientes, { entregueMap, consultaFuturaSet, veioRecenteSet }) {
  const em = entregueMap || new Map();
  const cf = consultaFuturaSet || new Set();
  const vr = veioRecenteSet || new Set();
  for (const p of pacientes) {
    const entregue = Math.round((em.get(String(p.id)) || 0) * 100) / 100;
    const temFutura = p.futureAmount > 0;
    const temConsulta = cf.has(String(p.id));
    p.entregue = entregue;
    p.exposicao = entregue > (p.pago || 0) ? 'vermelho' : 'verde';
    p.engajamento = temConsulta ? 'futuro' : (vr.has(String(p.id)) ? 'recente' : 'sumiu');
    // Crítico = exposição real E parado (sem futura E sem consulta futura).
    if (entregue > (p.pago || 0) && !temFutura && !temConsulta) p.grupo = 3;
    else if (p.overdueCount === 1) p.grupo = 1;
    else p.grupo = 2;
  }
  const byOverdue = (a, b) =>
    ((b.quebrouReneg ? 1 : 0) - (a.quebrouReneg ? 1 : 0)) || (b.overdueAmount - a.overdueAmount);
  const grupo1 = pacientes.filter(p => p.grupo === 1).sort(byOverdue);
  const grupo2 = pacientes.filter(p => p.grupo === 2).sort(byOverdue);
  const grupo3 = pacientes.filter(p => p.grupo === 3).sort(byOverdue);
  return {
    grupo1, grupo2, grupo3,
    totais: {
      pacientes: pacientes.length,
      valorTotal: Math.round(pacientes.reduce((s, p) => s + p.overdueAmount, 0) * 100) / 100,
      emCobranca: grupo1.length, renegociacao: grupo2.length, criticos: grupo3.length,
    },
  };
}

// ── Renegociação por SNAPSHOT (Fase 3) ─────────────────────────────────────
// O /payment/list NÃO devolve canceladas (fato medido 08/07): parcela
// cancelada/renegociada SOME do payload. Detecção = diff entre a foto de ontem
// (fin_parcelas_abertas_snapshot) e o payload de hoje.
// Guardas: tratamento precisa seguir no payload (janela de 24m desliza);
// sumidas > 20% do snapshot = anomalia → aborta sem gravar.
function diffSnapshotParcelas(anterior, items, hojeISO) {
  const atuais = new Map();
  const treatmentsNoPayload = new Set();
  const posicoesNoPayload = new Set();
  for (const it of (items || [])) {
    const t = String(it.TreatmentId || ''), n = Number(it.InstallmentNumber);
    if (!t || Number.isNaN(n)) continue;
    treatmentsNoPayload.add(t);
    const k = t + '|' + n;
    posicoesNoPayload.add(k);              // inclui recebidas: recebida ≠ sumida
    if (recebida(it)) continue;
    let x = atuais.get(k);
    if (!x) {
      x = { posicao: k, treatment_id: t, installment: n,
        patient_id: String(it.PatientId || '').trim(),
        patient_name: limpaNome(it.PatientName || ''),
        due_date: dia(it.DueDate) || null, valor: 0 };
      atuais.set(k, x);
    }
    x.valor += valorItem(it);
    const due = dia(it.DueDate);
    if (due && (!x.due_date || due < x.due_date)) x.due_date = due;   // agrega: menor due
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  const abertasAtuais = [...atuais.values()].map(x => ({ ...x, valor: r2(x.valor) }));
  if (!(anterior || []).length) return { eventos: [], abertasAtuais, abortado: null };

  const sumidas = anterior.filter(s =>
    !posicoesNoPayload.has(s.posicao) && treatmentsNoPayload.has(String(s.treatment_id)));
  // Freio de anomalia: piso absoluto de 50 evita abortar renegociação legítima em
  // snapshot pequeno (2 de 3 = 67%, mas é evento real); anomalia real = centenas.
  if (sumidas.length > Math.max(50, anterior.length * 0.2))
    return { eventos: [], abertasAtuais, abortado: `${sumidas.length} sumidas de ${anterior.length}` };

  const posAnterior = new Set(anterior.map(s => s.posicao));
  const novasPorTreatment = new Map();
  for (const x of abertasAtuais) {
    if (posAnterior.has(x.posicao)) continue;
    const arr = novasPorTreatment.get(x.treatment_id) || [];
    arr.push(x);
    novasPorTreatment.set(x.treatment_id, arr);
  }
  const sumidasPorTreatment = new Map();
  for (const s of sumidas) {
    const t = String(s.treatment_id);
    const arr = sumidasPorTreatment.get(t) || [];
    arr.push(s);
    sumidasPorTreatment.set(t, arr);
  }
  const eventos = [];
  for (const [t, sum] of sumidasPorTreatment) {
    const novas = novasPorTreatment.get(t) || [];
    eventos.push({
      tipo: novas.length ? 'renegociacao' : 'cancelamento',
      treatment_id: t,
      patient_id: String(sum[0].patient_id || (novas[0] && novas[0].patient_id) || ''),
      patient_name: String(sum[0].patient_name || (novas[0] && novas[0].patient_name) || ''),
      valor_antigo: r2(sum.reduce((a, b) => a + (Number(b.valor) || 0), 0)),
      valor_novo: r2(novas.reduce((a, b) => a + (Number(b.valor) || 0), 0)),
      detalhes: { sumidas: sum.map(s => s.posicao), novas: novas.map(x => x.posicao) },
    });
  }
  return { eventos, abertasAtuais, abortado: null };
}

// Agrega os eventos de fin_renegociacoes p/ o card + flags de cobrança.
// Reincidente = renegociação cujo tratamento tem vencida ABERTA hoje.
function agregarRenegociacoes(eventos, items, hojeISO) {
  const today = dia(hojeISO);
  const vencidoAberto = new Set();
  for (const it of (items || [])) {
    const t = String(it.TreatmentId || '');
    if (t && !recebida(it) && dia(it.DueDate) && dia(it.DueDate) < today) vencidoAberto.add(t);
  }
  const ren = (eventos || []).filter(e => e.tipo === 'renegociacao');
  const datas = (eventos || []).map(e => dia(e.data)).filter(Boolean).sort();
  const desde = datas[0] || null;
  let total = 0, reincidente = 0;
  const porMes = new Map(), pacientes = new Set(), flags = new Map();
  for (const e of ren) {
    const v = Number(e.valor_novo) || 0;
    total += v;
    const quebrou = vencidoAberto.has(String(e.treatment_id));
    if (quebrou) reincidente += v;
    const m = dia(e.data).slice(0, 7);
    const pm = porMes.get(m) || { mes: m, valor: 0, n: 0 };
    pm.valor += v; pm.n++; porMes.set(m, pm);
    const id = String(e.patient_id || '');
    if (id) {
      pacientes.add(id);
      const f = flags.get(id) || { renegociou: true, quebrouReneg: false };
      if (quebrou) f.quebrouReneg = true;
      flags.set(id, f);
    }
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  return { desde, total: r2(total), reincidente: r2(reincidente),
    pctReincidencia: total ? Math.round(reincidente / total * 1000) / 1000 : null,
    nPacientes: pacientes.size,
    porMes: [...porMes.values()].sort((a, b) => a.mes.localeCompare(b.mes))
      .map(x => ({ mes: x.mes, valor: r2(x.valor), n: x.n })),
    flags };
}

// Inadimplência REAL (régua do mentor, 08/07/26): parou de pagar (todos aqui têm
// vencido) E parou de vir (sumiu) E fez mais do que pagou. Quem pagou mais do que
// fez é CREDOR da clínica. Muta os pacientes (classeReal/semProducao) e agrega.
function inadimplenciaReal(pacientes) {
  const agg = { real: { n: 0, vencidoA: 0, exposicaoB: 0 },
    exposto_vem: { n: 0, vencidoA: 0 }, credor: { n: 0, vencidoA: 0 }, semProducao: 0 };
  for (const p of (pacientes || [])) {
    const entregue = Number(p.entregue || 0), pago = Number(p.pago || 0);
    p.semProducao = entregue === 0;
    if (p.semProducao) agg.semProducao++;
    if (entregue > pago && p.engajamento === 'sumiu') {
      p.classeReal = 'real';
      agg.real.n++; agg.real.vencidoA += p.overdueAmount; agg.real.exposicaoB += entregue - pago;
    } else if (entregue > pago) {
      p.classeReal = 'exposto_vem'; agg.exposto_vem.n++; agg.exposto_vem.vencidoA += p.overdueAmount;
    } else {
      p.classeReal = 'credor'; agg.credor.n++; agg.credor.vencidoA += p.overdueAmount;
    }
  }
  const r = (v) => Math.round(v * 100) / 100;
  agg.real.vencidoA = r(agg.real.vencidoA); agg.real.exposicaoB = r(agg.real.exposicaoB);
  agg.exposto_vem.vencidoA = r(agg.exposto_vem.vencidoA); agg.credor.vencidoA = r(agg.credor.vencidoA);
  return agg;
}

module.exports = { agregarPorPaciente, classificarESepararGrupos, inadimplenciaReal, diffSnapshotParcelas, agregarRenegociacoes };
