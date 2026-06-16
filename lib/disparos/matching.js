// Matching de telefone para casar contato do CSV com lead existente.
// NUNCA carrega a tabela inteira de leads (cliente Supabase trunca em 1000 linhas).
// Estrategia: pre-filtrar no banco pelos ultimos 8 digitos (invariantes a DDI e ao
// 9o digito) e confirmar com chaveTelefone na lista pequena de candidatos.
const { chaveTelefone } = require('../funil/telefone');

function ultimos8(telefone) {
  const d = String(telefone || '').replace(/\D/g, '');
  return d.slice(-8);
}

function confirmarMatch(telefone, candidatos) {
  const alvo = chaveTelefone(telefone);
  if (!alvo) return null;
  return (candidatos || []).find(c => chaveTelefone(c.telefone) === alvo) || null;
}

// Resolve o lead_id de um contato. Recebe o client supabase.
// Retorna { lead_id, criado: boolean }.
async function resolverLead(supabase, contato, nomeCampanha, criarLeadLeve) {
  const ult8 = ultimos8(contato.telefone);
  let candidatos = [];
  if (ult8.length === 8) {
    const { data } = await supabase
      .from('leads').select('id, telefone')
      .ilike('telefone', '%' + ult8 + '%').limit(50);
    candidatos = data || [];
  }
  const match = confirmarMatch(contato.telefone, candidatos);
  if (match) return { lead_id: match.id, criado: false };
  const novo = await criarLeadLeve(contato, nomeCampanha);
  return { lead_id: novo.id, criado: true };
}

module.exports = { ultimos8, confirmarMatch, resolverLead };
