// lib/monitor/queries.js
// IO do Monitor de Validação Diária (Etapa 2). Lê eventos da era NOVA (lead_criado, status_mudou).
// Para órfãs corretas: pega os leads ATIVOS no período e o HISTÓRICO COMPLETO deles (não só a janela).
// Reusa paginação + timeout de lib/funil/eventos.js. NÃO usa historico_* (CRM Antigo) nem Clinicorp.
const { buscarTodos, withTimeout, QUERY_TIMEOUT_MS } = require('../funil/eventos');

const TIPOS_NOVOS = ['lead_criado', 'status_mudou'];

async function buscarEventosNovos(sb, fromISO, toISO) {
  // 1) leads que tiveram algum evento novo dentro da janela (ordena por id — paginação estável)
  const ativos = await buscarTodos(() =>
    sb.from('lead_eventos').select('lead_id, id')
      .in('tipo', TIPOS_NOVOS).gte('criado_em', fromISO).lte('criado_em', toISO)
      .order('id', { ascending: true })
  );
  const leadIds = [...new Set(ativos.map(e => e.lead_id))];

  // 2) histórico completo (lead_criado + status_mudou) desses leads
  const eventos = [];
  for (let i = 0; i < leadIds.length; i += 500) {
    const chunk = leadIds.slice(i, i + 500);
    const evs = await buscarTodos(() =>
      sb.from('lead_eventos').select('lead_id, tipo, criado_em, metadata')
        .in('lead_id', chunk).in('tipo', TIPOS_NOVOS)
        .order('id', { ascending: true })
    );
    eventos.push(...evs);
  }

  // 3) valor de cada lead (pra Venda do dia + detectar fechamento sem valor)
  const leadValor = new Map();
  for (let i = 0; i < leadIds.length; i += 500) {
    const chunk = leadIds.slice(i, i + 500);
    const { data, error } = await withTimeout(
      sb.from('leads').select('id, valor').in('id', chunk), QUERY_TIMEOUT_MS, 'consulta leads (valor)',
    );
    if (error) throw new Error(error.message);
    for (const l of (data || [])) leadValor.set(l.id, Number(l.valor || 0));
  }

  return { eventos, leadValor };
}

module.exports = { buscarEventosNovos, TIPOS_NOVOS };
