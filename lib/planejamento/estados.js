// lib/planejamento/estados.js — máquina de estados e regras de re-sync (tabela da spec).
const FLUXO = { aguardando_planejamento: ['planejado'], planejado: ['em_andamento'], em_andamento: ['concluido'], concluido: [] };
const LATERAIS = ['descartado', 'cancelado'];

function transicaoValida(de, para) {
  if (LATERAIS.includes(para)) return !LATERAIS.includes(de);                 // qualquer ativo → lateral
  if (para === 'aguardando_planejamento') return de !== 'aguardando_planejamento'; // regressão/ressurreição/maleabilidade
  return (FLUXO[de] || []).includes(para);
}

function validarSubLotes(quantidadeItem, subLotes) {
  const soma = (subLotes || []).reduce((s, l) => s + (Number(l.quantidade) || 0), 0);
  if (!subLotes || !subLotes.length) return { ok: false, erro: 'nenhum sub-lote' };
  if (soma !== Number(quantidadeItem)) return { ok: false, erro: `soma dos sub-lotes (${soma}) ≠ quantidade do item (${quantidadeItem})` };
  return { ok: true };
}

/** Tabela de re-sync da spec. plano travado → nenhuma ação nova até humano destravar. */
function aplicarResync({ plano, itensPlano, itensNovos, statusClinicorp }) {
  const acoes = [];
  if (plano.trava_resync) return { acoes };
  if (statusClinicorp && statusClinicorp !== 'APPROVED') {
    acoes.push({ tipo: 'cancelar', motivo: 'venda_desfeita', statusClinicorp });
    return { acoes };
  }
  const atuais = new Map((itensPlano || []).map(i => [String(i.price_id), i]));
  const novos  = new Map((itensNovos || []).map(i => [String(i.price_id), i]));
  let regride = false, ressuscita = false;

  for (const [pid, novo] of novos) {
    const cur = atuais.get(pid);
    if (!cur) {
      acoes.push({ tipo: 'adicionar_item', price_id: pid, quantidade: novo.quantidade, procedure_name: novo.procedure_name });
      if (plano.status === 'descartado') ressuscita = true; else regride = true;
    } else if (Number(cur.quantidade) !== Number(novo.quantidade)) {
      if (cur.etapas_executadas) acoes.push({ tipo: 'travar', motivo: `quantidade de ${pid} mudou (${cur.quantidade}→${novo.quantidade}) com etapas executadas` });
      else { acoes.push({ tipo: 'atualizar_quantidade', price_id: pid, quantidade: novo.quantidade }); regride = true; }
    }
  }
  for (const [pid, cur] of atuais) {
    if (!novos.has(pid)) {
      if (cur.etapas_executadas) acoes.push({ tipo: 'travar', motivo: `item ${pid} removido no Clinicorp com etapas executadas` });
      else acoes.push({ tipo: 'remover_item', price_id: pid });
    }
  }
  if (acoes.some(a => a.tipo === 'travar')) return { acoes: acoes.filter(a => a.tipo === 'travar') };
  if (ressuscita) acoes.push({ tipo: 'ressuscitar' });
  else if (regride && ['planejado', 'em_andamento', 'concluido'].includes(plano.status)) acoes.push({ tipo: 'regredir' });
  return { acoes };
}

module.exports = { transicaoValida, validarSubLotes, aplicarResync };
