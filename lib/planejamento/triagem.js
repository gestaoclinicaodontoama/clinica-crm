// lib/planejamento/triagem.js — lógica pura da triagem e da heurística de duplicata.
// Spec: docs/superpowers/specs/2026-07-19-modo-planejamento-design.md

/** Agrupa a ProcedureList crua por PriceId: N linhas iguais = quantidade N. */
function agruparItens(procedureList) {
  const by = new Map();
  for (const p of procedureList || []) {
    const pid = p.PriceId != null ? String(p.PriceId) : `nome:${p.ProcedureName || ''}`;
    const cur = by.get(pid) || { price_id: p.PriceId != null ? String(p.PriceId) : null,
      procedure_name: p.ProcedureName || p.Name || '', quantidade: 0, executados: 0 };
    cur.quantidade += 1;
    if (p.Executed === 'X') cur.executados += 1;
    by.set(pid, cur);
  }
  return [...by.values()];
}

/** false só se TODOS os itens têm padrão com requer_plano=false (item sem padrão → requer). */
function requerPlano(itens, padroesByPriceId) {
  if (!itens || !itens.length) return true;
  return !itens.every(i => padroesByPriceId.get(String(i.price_id))?.requer_plano === false);
}

const JANELA_DUP_DIAS = 30;
/** Mesmo paciente + outro APPROVED em ≤30d + ≥1 price_id em comum → possível duplicata (renegociação). */
function heuristicaDuplicata(orc, outros) {
  const meus = new Set((orc.itens || []).map(i => String(i.price_id)));
  const d0 = orc.data_fechamento ? new Date(orc.data_fechamento).getTime() : null;
  for (const o of outros || []) {
    if (o.clinicorp_estimate_id === orc.clinicorp_estimate_id) continue;
    if (!o.paciente_clinicorp_id || o.paciente_clinicorp_id !== orc.paciente_clinicorp_id) continue;
    if (d0 == null || !o.data_fechamento) continue;
    const dias = Math.abs(d0 - new Date(o.data_fechamento).getTime()) / 864e5;
    if (dias > JANELA_DUP_DIAS) continue;
    if ((o.itens || []).some(i => meus.has(String(i.price_id)))) return { suspeito: true, de: o.clinicorp_estimate_id };
  }
  return { suspeito: false, de: null };
}

/** Classifica o pagamento de um orçamento: particular / convenio / misto. null se sem valor. */
function tipoPagamento(input) {
  const { valor, valor_particular } = input || {};
  const v = Number(valor);
  if (!v || v <= 0) return null;
  const vp = Number(valor_particular) || 0;
  if (vp <= 0) return 'convenio';
  if (vp >= v) return 'particular';
  return 'misto';
}

module.exports = { agruparItens, requerPlano, heuristicaDuplicata, JANELA_DUP_DIAS, tipoPagamento };
