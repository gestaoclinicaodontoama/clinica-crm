// lib/monitor/diario.js
// Monitor de Validação Diária do CRM Novo (Etapa 2) — agregação PURA e testável.
// Recebe eventos da era nova (lead_criado, status_mudou) + mapa leadId→valor (de leads.valor),
// e devolve: atividade por dia, saúde do dado e cobertura das 5 etapas.
// Fonte: NÃO usa historico_* (CRM Antigo) nem Clinicorp.

// Status do CRM atual (server.js FUNIL) → etapa do funil canônico.
// 'Orçou' NÃO existe na taxonomia atual → cobertura.orcou fica false de propósito (lacuna a expor).
const STATUS_ETAPA = { Agendado: 'agendou', Compareceu: 'compareceu', Fechou: 'fechou' };
const ETAPAS_ORDEM = ['leads', 'agendou', 'compareceu', 'orcou', 'fechou'];

function diaLocal(iso) { return String(iso).slice(0, 10); }

function addEtapa(map, leadId, etapa) {
  if (!map.has(leadId)) map.set(leadId, new Set());
  map.get(leadId).add(etapa);
}

function montarMonitor(eventos, leadValor = new Map()) {
  const dias = new Map();
  const dia = (k) => {
    if (!dias.has(k)) dias.set(k, { data: k, leads: 0, agendou: 0, compareceu: 0, orcou: 0, fechou: 0, venda: 0 });
    return dias.get(k);
  };

  let leadsSemOrigem = 0, totalLeads = 0;
  let fechSemValor = 0, totalFech = 0;
  const etapasPorLead = new Map(); // leadId → Set de etapas (pra detectar transições órfãs)
  const cobertura = { leads: false, agendou: false, compareceu: false, orcou: false, fechou: false };

  for (const e of eventos) {
    const k = diaLocal(e.criado_em);
    if (e.tipo === 'lead_criado') {
      dia(k).leads++;
      totalLeads++;
      cobertura.leads = true;
      addEtapa(etapasPorLead, e.lead_id, 'leads');
      const org = (e.metadata?.origem || '').trim();
      if (!org) leadsSemOrigem++;
    } else if (e.tipo === 'status_mudou') {
      const etapa = STATUS_ETAPA[e.metadata?.para];
      if (!etapa) continue;
      dia(k)[etapa]++;
      cobertura[etapa] = true;
      addEtapa(etapasPorLead, e.lead_id, etapa);
      if (etapa === 'fechou') {
        totalFech++;
        const v = Number(leadValor.get(e.lead_id) || 0);
        dia(k).venda += v;
        if (!v) fechSemValor++;
      }
    }
  }

  // ⚠️ Órfãs só são corretas se `eventos` trouxer o HISTÓRICO COMPLETO de cada lead.
  // Se vier só a fatia do período, um lead que agendou ANTES da janela e compareceu
  // DENTRO dela apareceria como órfão falso. O queries.js (IO) deve buscar todos os
  // eventos dos leads que aparecem na janela — não só os do período. (Ver spec Etapa 2.)
  const orfas = { compareceu_sem_agendou: 0, fechou_sem_compareceu: 0 };
  for (const [, set] of etapasPorLead) {
    if (set.has('compareceu') && !set.has('agendou')) orfas.compareceu_sem_agendou++;
    if (set.has('fechou') && !set.has('compareceu')) orfas.fechou_sem_compareceu++;
  }

  return {
    dias: [...dias.values()].sort((a, b) => (a.data < b.data ? -1 : 1)),
    saude: {
      leads_sem_origem: { n: leadsSemOrigem, total: totalLeads, pct: totalLeads ? leadsSemOrigem / totalLeads : 0 },
      fechamentos_sem_valor: { n: fechSemValor, total: totalFech },
      transicoes_orfas: orfas,
    },
    cobertura,
  };
}

module.exports = { montarMonitor, STATUS_ETAPA, ETAPAS_ORDEM };
