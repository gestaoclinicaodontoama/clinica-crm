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
      oldestDueDate: null, nextDueDate: null, _boletoDue: null,
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
      if (!p.payerName && it.PayerName) { p.payerName = String(it.PayerName); p.payerPhone = String(it.PayerPhone || ''); }
      if (!p.paymentForm && it.PaymentForm) p.paymentForm = String(it.PaymentForm);
    } else {
      p.futureAmount += v;
      if (!p.nextDueDate || due < p.nextDueDate) p.nextDueDate = due;
    }
  }
  const td = new Date(today);
  return Object.values(m).filter(p => p.overdueCount > 0).map(p => {
    delete p._boletoDue;
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
  const byOverdue = (a, b) => b.overdueAmount - a.overdueAmount;
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

module.exports = { agregarPorPaciente, classificarESepararGrupos };
