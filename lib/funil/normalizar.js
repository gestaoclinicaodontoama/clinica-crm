// lib/funil/normalizar.js
// Adaptador da Etapa 3 (dashboard unificado): traduz os DOIS vocabulários de evento
// (CRM Antigo = historico_*, CRM Novo = lead_criado/status_mudou) para as 5 etapas canônicas,
// aplicando a REGRA DE ERA POR LEAD (evita dupla contagem na transição). Puro e testável.

const HISTORICO_ETAPA = {
  historico_lead_criado: 'leads',
  historico_agendado: 'agendou',
  historico_compareceu: 'compareceu',
  historico_orcamento: 'orcou',
  historico_fechou: 'fechou',
};
// CRM Novo: status_mudou.metadata.para → etapa. (Não há sinal de "orçou" ainda — lacuna conhecida.)
const STATUS_NOVO_ETAPA = { Agendado: 'agendou', Compareceu: 'compareceu', Fechou: 'fechou' };

function etapaDeEvento(e) {
  if (HISTORICO_ETAPA[e.tipo]) return HISTORICO_ETAPA[e.tipo];
  if (e.tipo === 'lead_criado') return 'leads';
  if (e.tipo === 'status_mudou') return STATUS_NOVO_ETAPA[e.metadata?.para] || null;
  return null;
}

// Era do lead: se tem qualquer evento historico_* → CRM Antigo; senão → CRM Novo.
function eraDoLead(eventosDoLead) {
  return eventosDoLead.some(e => String(e.tipo).startsWith('historico_')) ? 'antigo' : 'novo';
}

// Recebe TODOS os eventos (2 eras, vários leads) + leadValor(Map id→valor).
// Devolve eventos canônicos {lead_id, etapa, criado_em, origem} — já filtrados pela era de
// cada lead (1 vocabulário por lead, sem sobreposição) — e vendaPorLead.
//
// ⚠️ DECISÃO EM ABERTO (Etapa 3): esta versão usa "1 era por lead". Isso evita dupla contagem,
// MAS um lead histórico trabalhado de novo no CRM Novo (julho) não tem o avanço novo contado.
// Alternativa a avaliar na fiação: contar a UNIÃO das etapas (montarCoorte deduplica por Set de
// lead/etapa, então não dobra) e aplicar a regra de era só na VENDA. Ver spec Etapa 3 §7.
function normalizarEventos(eventos, leadValor = new Map()) {
  const porLead = new Map();
  for (const e of eventos) {
    if (!porLead.has(e.lead_id)) porLead.set(e.lead_id, []);
    porLead.get(e.lead_id).push(e);
  }

  const eventosCanonicos = [];
  const vendaPorLead = new Map();

  for (const [leadId, evs] of porLead) {
    const era = eraDoLead(evs);
    const ehDaEra = (e) => era === 'antigo'
      ? String(e.tipo).startsWith('historico_')
      : (e.tipo === 'lead_criado' || e.tipo === 'status_mudou');

    let venda = 0, fechou = false;
    for (const e of evs) {
      if (!ehDaEra(e)) continue;
      const etapa = etapaDeEvento(e);
      if (!etapa) continue;
      eventosCanonicos.push({ lead_id: leadId, etapa, criado_em: e.criado_em, origem: e.metadata?.origem });
      if (etapa === 'fechou') {
        fechou = true;
        if (era === 'antigo') venda += Number(e.metadata?.valor || 0); // valor por evento (planilha)
      }
    }
    if (fechou) {
      if (era === 'novo') venda = Number(leadValor.get(leadId) || 0); // valor por lead (leads.valor)
      vendaPorLead.set(leadId, venda);
    }
  }

  return { eventosCanonicos, vendaPorLead };
}

module.exports = { etapaDeEvento, eraDoLead, normalizarEventos, HISTORICO_ETAPA, STATUS_NOVO_ETAPA };
