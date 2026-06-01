// lib/funil/fechamentos.js
// Agregações de fechamento por mês de fechamento + tempos por fase (puras).
function media(arr) { return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null; }
function diasEntre(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
function mesDe(d) { return String(d).slice(0, 7); }

// orcamentos: já filtrados a particulares aprovados com data_fechamento no período.
function agregarFechamentos({ orcamentos = [], avaliacoesPorPaciente = new Map() }) {
  // agrega por paciente (1 paciente = 1 fechamento)
  const porPaciente = new Map();
  for (const o of orcamentos) {
    const p = o.paciente_clinicorp_id;
    if (!porPaciente.has(p)) porPaciente.set(p, { valor: 0, entrada: 0, data_fechamento: o.data_fechamento });
    const acc = porPaciente.get(p);
    acc.valor   += Number(o.valor_particular || 0);
    acc.entrada = Math.max(acc.entrada, Number(o.entrada_valor || 0));
    if (o.data_fechamento > acc.data_fechamento) acc.data_fechamento = o.data_fechamento;
  }

  const fechamentos = porPaciente.size;
  let valor_fechado = 0, entradas_recebidas = 0;
  const tempos = [];
  let mesmo_mes = 0, meses_anteriores = 0;

  for (const [p, acc] of porPaciente) {
    valor_fechado      += acc.valor;
    entradas_recebidas += acc.entrada;
    const avals = (avaliacoesPorPaciente.get(p) || [])
      .filter(a => a.data && a.data <= acc.data_fechamento)
      .sort((x, y) => (x.data < y.data ? 1 : -1)); // mais recente primeiro
    const aval = avals[0];
    if (aval) {
      tempos.push(diasEntre(aval.data, acc.data_fechamento));
      if (mesDe(aval.data) === mesDe(acc.data_fechamento)) mesmo_mes++; else meses_anteriores++;
    }
  }

  const comAval = mesmo_mes + meses_anteriores;
  return {
    fechamentos,
    valor_fechado,
    entradas_recebidas,
    ticket_medio: fechamentos ? Math.round((valor_fechado / fechamentos) * 100) / 100 : 0,
    tempo_medio_ate_fechar: media(tempos),
    origem_fechamento: {
      mesmo_mes,
      meses_anteriores,
      pct_mesmo_mes: comAval ? mesmo_mes / comAval : null,
    },
  };
}

// Média de dias por transição; ignora pares sem ambas as pontas.
function temposPorFase({ avaliacoes = [], fechamentoPorPaciente = new Map(), leads = [], fechamentoPorLead = new Map() }) {
  const mediaPares = (pares) => media(pares.filter(([a, b]) => a && b).map(([a, b]) => diasEntre(a, b)));

  const clinica = {
    agendou_compareceu: mediaPares(avaliacoes.map(a => [a.agendado_em, a.comparecimento_em])),
    compareceu_fechou:  mediaPares(avaliacoes
      .map(a => [a.comparecimento_em, fechamentoPorPaciente.get(a.paciente_clinicorp_id)])),
  };

  const leadsView = {
    lead_agendou:       mediaPares(leads.map(l => [l.data_lead, l.data_agendamento])),
    agendou_compareceu: mediaPares(leads.map(l => [l.data_agendamento, l.data_comparecimento])),
    compareceu_fechou:  mediaPares(leads.map(l => [l.data_comparecimento, fechamentoPorLead.get(l.id)])),
  };

  return { clinica, leads: leadsView };
}

module.exports = { agregarFechamentos, temposPorFase, media, diasEntre, mesDe };
