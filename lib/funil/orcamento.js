// lib/funil/orcamento.js
// Classifica um estimate da Clinicorp em valor particular (não-convênio) e flag de convênio.
function classificarOrcamento(o) {
  const procs = Array.isArray(o.ProcedureList) ? o.ProcedureList : [];
  if (procs.length === 0) {
    // Sem detalhe de procedimentos: assume particular pelo Amount total.
    return { valorParticular: Number(o.Amount || 0), ehConvenio: false };
  }
  let valorParticular = 0;
  for (const p of procs) {
    const convenio = p.BillType === 'CLAIM' || (p.ClaimNumber != null && p.ClaimNumber !== '');
    if (!convenio) valorParticular += Number(p.FinalAmount ?? p.Amount ?? 0);
  }
  valorParticular = Math.round(valorParticular * 100) / 100;
  const ehConvenio = valorParticular === 0;
  return { valorParticular, ehConvenio };
}

module.exports = { classificarOrcamento };
