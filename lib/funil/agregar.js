// Agrega o funil comercial em duas visões a partir de arrays já filtrados por período.
function pct(num, den) { return den > 0 ? num / den : 0; }

// Calcula uma "view" (12 cards) a partir de avaliações/orçamentos de uma coorte.
// base = { leads_criados, leads_agendados } na visão leads, ou null na visão clínica.
function computeView(avaliacoes, orcamentos, base) {
  const agendamentos    = avaliacoes.length;
  const comparecimentos = avaliacoes.filter(a => a.compareceu).length;

  const coorte = new Set(avaliacoes.map(a => a.paciente_clinicorp_id));
  const orcCoorte = orcamentos.filter(o => coorte.has(o.paciente_clinicorp_id));
  const aprovados = orcCoorte.filter(o => o.status === 'APPROVED');

  const pacientesFechados = new Set(aprovados.map(o => o.paciente_clinicorp_id));
  const fechamentos       = pacientesFechados.size;
  const valor_fechamentos = aprovados.reduce((s, o) => s + Number(o.valor || 0), 0);
  const valor_oportunidades = orcCoorte
    .filter(o => o.status === 'APPROVED' || o.status === 'OPEN')
    .reduce((s, o) => s + Number(o.valor || 0), 0);

  const leads_criados   = base ? base.leads_criados   : null;
  const leads_agendados = base ? base.leads_agendados : null;

  // Denominadores: visão leads é ancorada em leads; visão clínica em atividade.
  const denAgendamento    = base ? leads_criados   : agendamentos;
  const denComparecimento = base ? leads_agendados : agendamentos;

  return {
    leads_criados,
    agendamentos,
    pct_agendamentos:     pct(agendamentos, denAgendamento),
    leads_agendados,
    pct_leads_agendados:  base ? pct(leads_agendados, leads_criados) : null,
    comparecimentos,
    pct_comparecimentos:  pct(comparecimentos, denComparecimento),
    fechamentos,
    pct_fechamentos:      pct(fechamentos, comparecimentos),
    valor_oportunidades,
    valor_fechamentos,
    ticket_medio:         pct(valor_fechamentos, fechamentos),
    taxa_conversao:       pct(valor_fechamentos, valor_oportunidades),
  };
}

function agregarFunil({ leads = [], avaliacoes = [], orcamentos = [], origem = null }) {
  // ----- Visão clínica: tudo -----
  const clinica = computeView(avaliacoes, orcamentos, null);

  // ----- Visão leads: só linhas com lead_id, filtradas por origem -----
  const leadById = new Map(leads.map(l => [l.id, l]));
  const origemOf = (lead_id) => (leadById.get(lead_id) || {}).origem;

  let leadsArr = leads;
  let avalLeads = avaliacoes.filter(a => a.lead_id != null);
  let orcLeads  = orcamentos.filter(o => o.lead_id != null);

  if (origem) {
    leadsArr  = leadsArr.filter(l => l.origem === origem);
    avalLeads = avalLeads.filter(a => origemOf(a.lead_id) === origem);
    orcLeads  = orcLeads.filter(o => origemOf(o.lead_id) === origem);
  }

  const leadsComAvaliacao = new Set(avalLeads.map(a => a.lead_id));
  const base = {
    leads_criados:   leadsArr.length,
    leads_agendados: leadsComAvaliacao.size,
  };
  const leadsView = computeView(avalLeads, orcLeads, base);

  return { clinica, leads: leadsView };
}

module.exports = { agregarFunil, computeView };
