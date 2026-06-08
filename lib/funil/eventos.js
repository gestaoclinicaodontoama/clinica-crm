// lib/funil/eventos.js
// Lê lead_eventos historico_* (IO paginada, com timeout) e monta o coorte do período (puro/testável).
const ETAPAS = [
  { id: 'leads', rotulo: 'Leads', tipo: 'historico_lead_criado' },
  { id: 'agendados', rotulo: 'Agendados', tipo: 'historico_agendado' },
  { id: 'compareceram', rotulo: 'Compareceram', tipo: 'historico_compareceu' },
  { id: 'orcaram', rotulo: 'Orçaram', tipo: 'historico_orcamento' },
  { id: 'fecharam', rotulo: 'Fecharam', tipo: 'historico_fechou' },
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

module.exports = { buscarCoorte, montarCoorte, buscarTodos, withTimeout, ETAPAS, QUERY_TIMEOUT_MS };
