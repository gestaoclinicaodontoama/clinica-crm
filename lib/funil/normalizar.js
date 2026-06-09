// lib/funil/normalizar.js
// Adaptador da Etapa 3 (dashboard unificado): traduz os DOIS vocabulários de evento
// (CRM Antigo = historico_*, CRM Novo = lead_criado/status_mudou) para as 5 etapas canônicas.
// DECISÃO (Luiz): UNIÃO de etapas + 4 regras (ver spec Etapa 3 §4.2):
//   1) etapas = união deduplicada por (lead, etapa)
//   2) data da etapa = PRIMEIRA ocorrência (mais antiga)
//   3) funil = "chegou na etapa" (não desconta reabertura)
//   4) Venda = UMA fonte por lead (planilha tem precedência; senão leads.valor)
// Puro e testável.

const HISTORICO_ETAPA = {
  historico_lead_criado: 'leads',
  historico_agendado: 'agendou',
  historico_compareceu: 'compareceu',
  historico_orcamento: 'orcou',
  historico_fechou: 'fechou',
};
// CRM Novo: status_mudou.metadata.para → etapa. ("Orçou" será adicionado no CRM Novo — ver §6.)
const STATUS_NOVO_ETAPA = { Agendado: 'agendou', Compareceu: 'compareceu', 'Orçado': 'orcou', Fechou: 'fechou' };

function etapaDeEvento(e) {
  if (HISTORICO_ETAPA[e.tipo]) return HISTORICO_ETAPA[e.tipo];
  if (e.tipo === 'lead_criado') return 'leads';
  if (e.tipo === 'status_mudou') return STATUS_NOVO_ETAPA[e.metadata?.para] || null;
  return null;
}

// Era do lead: se tem qualquer evento historico_* → CRM Antigo; senão → CRM Novo. (helper)
function eraDoLead(eventosDoLead) {
  return eventosDoLead.some(e => String(e.tipo).startsWith('historico_')) ? 'antigo' : 'novo';
}

// Recebe TODOS os eventos (2 eras, vários leads) + leadValor(Map id→valor).
// Devolve eventos canônicos {lead_id, etapa, criado_em, origem} — UNIÃO das duas eras,
// deduplicada por (lead, etapa) com a data da PRIMEIRA ocorrência — e vendaPorLead (1 fonte).
function normalizarEventos(eventos, leadValor = new Map()) {
  const porLead = new Map();
  for (const e of eventos) {
    if (!porLead.has(e.lead_id)) porLead.set(e.lead_id, []);
    porLead.get(e.lead_id).push(e);
  }

  const eventosCanonicos = [];
  const vendaPorLead = new Map();
  const entradaPorLead = new Map();

  for (const [leadId, evs] of porLead) {
    const porEtapa = new Map(); // etapa → { criado_em, origem }  (primeira ocorrência)
    let vendaAntigo = 0, entradaAntigo = 0, fechouAntigo = false, fechouNovo = false;

    for (const e of evs) {
      const etapa = etapaDeEvento(e);
      if (!etapa) continue;

      // regra 2: mantém a data mais antiga; origem da própria etapa (fallback à anterior)
      const cur = porEtapa.get(etapa);
      if (!cur || new Date(e.criado_em) < new Date(cur.criado_em)) {
        porEtapa.set(etapa, { criado_em: e.criado_em, origem: e.metadata?.origem ?? cur?.origem });
      }

      if (etapa === 'fechou') {
        if (String(e.tipo).startsWith('historico_')) {
          fechouAntigo = true;
          vendaAntigo += Number(e.metadata?.valor || 0);
          entradaAntigo += Number(e.metadata?.entrada || 0);
        } else {
          fechouNovo = true;
        }
      }
    }

    // regra 1: emite cada etapa uma vez (união deduplicada)
    for (const [etapa, info] of porEtapa) {
      eventosCanonicos.push({ lead_id: leadId, etapa, criado_em: info.criado_em, origem: info.origem });
    }

    // regra 4: Venda/entrada de UMA fonte — planilha (era antiga) tem precedência; senão leads.valor.
    // (CRM Novo não tem conceito de entrada → 0.)
    if (fechouAntigo) { vendaPorLead.set(leadId, vendaAntigo); entradaPorLead.set(leadId, entradaAntigo); }
    else if (fechouNovo) { vendaPorLead.set(leadId, Number(leadValor.get(leadId) || 0)); entradaPorLead.set(leadId, 0); }
  }

  return { eventosCanonicos, vendaPorLead, entradaPorLead };
}

module.exports = { etapaDeEvento, eraDoLead, normalizarEventos, HISTORICO_ETAPA, STATUS_NOVO_ETAPA };
