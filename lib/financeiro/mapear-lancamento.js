const { empresa } = require('./normalizar');
const { dataLocal } = require('./data');

function formaPgto(e) {
  if (e.EntryType === 'INSURANCE_PLAN_CLAIM') return 'convenio';
  const d = (e.Description || '').toLowerCase();
  if (d.includes('plano')) return 'convenio';
  if (d.includes('pix')) return 'pix';
  if (d.includes('cartão') || d.includes('cartao')) return 'cartao';
  if (d.includes('boleto')) return 'boleto';
  if (d.includes('pagamento de tratamento')) return 'dinheiro';
  return null;
}

function mapear(e) {
  const ehDespesa = e.PostType === 'EXPENSES' || e.EntryType === 'ACCOUNTS_PAYMENT';
  let valor = Number(e.Amount) || 0;
  let fluxo = ehDespesa ? 'sai' : 'entra';
  if (valor < 0) { valor = Math.abs(valor); fluxo = fluxo === 'sai' ? 'entra' : 'sai'; }
  return {
    clinicorp_id: String(e.id),
    data: dataLocal(e.Date || e.PostDate),   // Date = data do evento de caixa (reproduz cash_flow); PostDate é postagem/conciliação
    descricao: e.Description || '',
    valor: Math.round(valor * 100) / 100,
    fluxo,
    post_type: e.PostType || null,
    entry_type: e.EntryType || null,
    forma_pgto: ehDespesa ? null : formaPgto(e),
    empresa: empresa(e.Description),
    paciente_id: (e.RelatedPersonId != null && e.RelatedPersonId !== -1) ? String(e.RelatedPersonId) : null,
    raw: e,
  };
}

module.exports = { mapear, formaPgto };
