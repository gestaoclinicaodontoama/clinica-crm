// Coleta o conjunto de lead_id de uma campanha paginando (evita o corte de 1000
// linhas do cliente Supabase). fetchPage(offset, limit) -> array de { lead_id }.
const PAGINA = 1000;

async function coletarLeadIds(fetchPage) {
  const ids = new Set();
  for (let offset = 0; ; offset += PAGINA) {
    const linhas = await fetchPage(offset, PAGINA);
    for (const r of linhas) if (r.lead_id != null) ids.add(r.lead_id);
    if (linhas.length < PAGINA) break;
  }
  return ids;
}

module.exports = { coletarLeadIds, PAGINA };
