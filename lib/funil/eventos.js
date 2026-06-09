// lib/funil/eventos.js
// Lê lead_eventos (IO paginada, com timeout) e monta o coorte do período (puro/testável).
// Etapa 1: só historico_* (buscarCoorte/montarCoorte). Etapa 3: as 2 eras via normalizar
// (buscarCoorteUnificado/montarCoorteUnificado).
const { normalizarEventos } = require('./normalizar');

const ETAPAS = [
  { id: 'leads', rotulo: 'Leads', tipo: 'historico_lead_criado' },
  { id: 'agendados', rotulo: 'Agendados', tipo: 'historico_agendado' },
  { id: 'compareceram', rotulo: 'Compareceram', tipo: 'historico_compareceu' },
  { id: 'orcaram', rotulo: 'Orçaram', tipo: 'historico_orcamento' },
  { id: 'fecharam', rotulo: 'Fecharam', tipo: 'historico_fechou' },
];

// Etapa canônica (id/rotulo do funil) ← etapa do normalizar.
const ETAPAS_CANON = [
  { canon: 'leads', id: 'leads', rotulo: 'Leads' },
  { canon: 'agendou', id: 'agendados', rotulo: 'Agendados' },
  { canon: 'compareceu', id: 'compareceram', rotulo: 'Compareceram' },
  { canon: 'orcou', id: 'orcaram', rotulo: 'Orçaram' },
  { canon: 'fechou', id: 'fecharam', rotulo: 'Fecharam' },
];

const TODOS_TIPOS = [
  'historico_lead_criado', 'historico_agendado', 'historico_compareceu', 'historico_orcamento', 'historico_fechou',
  'lead_criado', 'status_mudou',
];

const QUERY_TIMEOUT_MS = 15000;

// Falha rápido em vez de pendurar quando o Supabase/rede não responde.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label}: timeout após ${ms}ms (rede/Supabase indisponível)`)),
      ms,
    );
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// Paginação real (contorna o teto de 1000 do PostgREST). queryFn() devolve uma query NOVA por página.
async function buscarTodos(queryFn, timeoutMs = QUERY_TIMEOUT_MS) {
  const page = 1000;
  let from = 0, out = [];
  for (;;) {
    const { data, error } = await withTimeout(queryFn().range(from, from + page - 1), timeoutMs, 'consulta lead_eventos');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < page) break;
    from += page;
  }
  return out;
}

// IO: busca os leads criados no período + todos os eventos historico_* desses leads.
async function buscarCoorte(sb, fromISO, toISO) {
  // Paginação ordenada por `id` (único) — criado_em tem timestamps repetidos e instabiliza o range().
  const criados = await buscarTodos(() =>
    sb.from('lead_eventos').select('lead_id, tipo, criado_em, metadata')
      .eq('tipo', 'historico_lead_criado').gte('criado_em', fromISO).lte('criado_em', toISO)
      .order('id', { ascending: true })
  );
  const leadIds = [...new Set(criados.map(e => e.lead_id))];
  const eventos = [];
  for (let i = 0; i < leadIds.length; i += 500) {
    const chunk = leadIds.slice(i, i + 500);
    const evs = await buscarTodos(() =>
      sb.from('lead_eventos').select('lead_id, tipo, criado_em, metadata')
        .in('lead_id', chunk).like('tipo', 'historico_%')
        .order('id', { ascending: true })
    );
    eventos.push(...evs);
  }
  // mapa de origem
  const origemPorLead = new Map();
  for (let i = 0; i < leadIds.length; i += 500) {
    const chunk = leadIds.slice(i, i + 500);
    const { data, error } = await withTimeout(
      sb.from('leads').select('id, origem').in('id', chunk), QUERY_TIMEOUT_MS, 'consulta leads',
    );
    if (error) throw new Error(error.message);
    // origem já é um rótulo (ex.: "WhatsApp Direto", "Meta Ads"); agrupa como está, só com trim.
    // NÃO aplicar normalizarOrigem() do server.js — aquele é pra derivar de UTM na criação.
    for (const l of (data || [])) origemPorLead.set(l.id, (l.origem || 'Sem origem').trim());
  }
  return { criados, eventos, origemPorLead };
}

// Atividade por DATA DE EVENTO no período (pra série temporal / dia-da-semana).
// Diferente do coorte: aqui conta todo evento historico_* de criação/comparecimento/fechamento
// cujo criado_em cai na janela — independente de quando o lead foi criado.
async function buscarAtividade(sb, fromISO, toISO) {
  return buscarTodos(() =>
    sb.from('lead_eventos').select('tipo, criado_em')
      .in('tipo', ['historico_lead_criado', 'historico_compareceu', 'historico_fechou'])
      .gte('criado_em', fromISO).lte('criado_em', toISO)
      .order('id', { ascending: true })
  );
}

// Puro: monta etapas (leads distintos) + KPIs. Filtro de origem opcional.
function montarCoorte(criados, eventos, origemPorLead, origem) {
  const naOrigem = (leadId) => !origem || origemPorLead.get(leadId) === origem;
  const coorte = new Set(criados.map(e => e.lead_id).filter(naOrigem));

  const porEtapa = new Map(ETAPAS.map(e => [e.tipo, new Set()]));
  let venda = 0, entrada = 0;
  for (const e of eventos) {
    if (!coorte.has(e.lead_id)) continue;
    if (porEtapa.has(e.tipo)) porEtapa.get(e.tipo).add(e.lead_id);
    if (e.tipo === 'historico_fechou') {
      venda += Number(e.metadata?.valor || 0);
      entrada += Number(e.metadata?.entrada || 0);
    }
  }

  const etapas = ETAPAS.map(e => ({ id: e.id, rotulo: e.rotulo, n: porEtapa.get(e.tipo).size }));
  etapas[0].n = coorte.size; // topo = leads do coorte
  const fechamentos = porEtapa.get('historico_fechou').size;

  return {
    etapas,
    kpis: {
      leads: coorte.size,
      agendamentos: porEtapa.get('historico_agendado').size,
      comparecimentos: porEtapa.get('historico_compareceu').size,
      orcamentos: porEtapa.get('historico_orcamento').size,
      fechamentos,
      venda,
      entrada,
      ticket_medio: fechamentos ? Math.round((venda / fechamentos) * 100) / 100 : 0,
    },
  };
}

// ===== Etapa 3 (unificado: CRM Antigo + CRM Novo via normalizar) =====

// IO: coorte = leads criados no período em QUALQUER era + todos os eventos das 2 eras + origem/valor.
async function buscarCoorteUnificado(sb, fromISO, toISO) {
  const criados = await buscarTodos(() =>
    sb.from('lead_eventos').select('lead_id, criado_em')
      .in('tipo', ['historico_lead_criado', 'lead_criado'])
      .gte('criado_em', fromISO).lte('criado_em', toISO)
      .order('id', { ascending: true })
  );
  const leadIds = [...new Set(criados.map(e => e.lead_id))];
  const eventos = [];
  for (let i = 0; i < leadIds.length; i += 500) {
    const chunk = leadIds.slice(i, i + 500);
    const evs = await buscarTodos(() =>
      sb.from('lead_eventos').select('lead_id, tipo, criado_em, metadata')
        .in('lead_id', chunk).in('tipo', TODOS_TIPOS)
        .order('id', { ascending: true })
    );
    eventos.push(...evs);
  }
  const origemPorLead = new Map();
  const leadValor = new Map();
  for (let i = 0; i < leadIds.length; i += 500) {
    const chunk = leadIds.slice(i, i + 500);
    const { data, error } = await withTimeout(
      sb.from('leads').select('id, origem, valor').in('id', chunk), QUERY_TIMEOUT_MS, 'consulta leads',
    );
    if (error) throw new Error(error.message);
    for (const l of (data || [])) {
      origemPorLead.set(l.id, (l.origem || 'Sem origem').trim());
      leadValor.set(l.id, Number(l.valor || 0));
    }
  }
  return { criados, eventos, origemPorLead, leadValor };
}

// Puro: aplica normalizar (regra UNIÃO) e monta etapas/KPIs do coorte unificado.
function montarCoorteUnificado(criados, eventos, origemPorLead, leadValor, origem) {
  const { eventosCanonicos, vendaPorLead, entradaPorLead } = normalizarEventos(eventos, leadValor);
  const naOrigem = (id) => !origem || origemPorLead.get(id) === origem;
  const coorte = new Set(criados.map(e => e.lead_id).filter(naOrigem));

  const porEtapa = new Map(ETAPAS_CANON.map(e => [e.canon, new Set()]));
  for (const ce of eventosCanonicos) {
    if (!coorte.has(ce.lead_id)) continue;
    if (porEtapa.has(ce.etapa)) porEtapa.get(ce.etapa).add(ce.lead_id);
  }

  const etapas = ETAPAS_CANON.map(e => ({ id: e.id, rotulo: e.rotulo, n: porEtapa.get(e.canon).size }));
  etapas[0].n = coorte.size; // topo = leads do coorte

  const fechamentos = porEtapa.get('fechou').size;
  let venda = 0, entrada = 0;
  for (const id of coorte) {
    venda += Number(vendaPorLead.get(id) || 0);
    entrada += Number(entradaPorLead.get(id) || 0);
  }

  return {
    etapas,
    kpis: {
      leads: coorte.size,
      agendamentos: porEtapa.get('agendou').size,
      comparecimentos: porEtapa.get('compareceu').size,
      orcamentos: porEtapa.get('orcou').size,
      fechamentos, venda, entrada,
      ticket_medio: fechamentos ? Math.round((venda / fechamentos) * 100) / 100 : 0,
    },
  };
}

module.exports = {
  buscarCoorte, buscarAtividade, montarCoorte,
  buscarCoorteUnificado, montarCoorteUnificado, ETAPAS_CANON,
  buscarTodos, withTimeout, ETAPAS, QUERY_TIMEOUT_MS,
};
