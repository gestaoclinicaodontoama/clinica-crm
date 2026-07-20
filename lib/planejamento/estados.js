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

/**
 * Novo status do plano após um registro de sessão da ASB.
 * @param statusAtual - status corrente do plano_tratamento
 * @param etapasStatus - array com o status de TODAS as etapas do plano (após o registro atual)
 * Regras (respeitam o FLUXO de transicaoValida — nunca "pula" estado):
 *   - se todas as etapas estão concluídas (concluida/concluida_retroativa) E o plano já está
 *     'em_andamento' (única origem com transição direta válida p/ 'concluido') → 'concluido';
 *   - senão, se o plano estava 'planejado' ou 'aguardando_planejamento' → 'em_andamento'
 *     (mesmo que todas as etapas já estejam concluídas: 'concluido' não é destino direto
 *     válido a partir desses estados, então avança um degrau por vez);
 *   - senão mantém o status atual. Nunca rebaixa um 'concluido' nem toca laterais (descartado/cancelado).
 * @param temItemSemEtapa - true quando algum item raiz ativo do plano não tem NENHUMA etapa
 *   (própria nem de sub-lote filho): trabalho ainda não detalhado → o plano NUNCA conclui
 *   automaticamente (senão executar o único procedimento com etapas fecharia o plano inteiro —
 *   caso real Jeysa 20/07). Ainda sobe para 'em_andamento' normalmente.
 * Retorna null quando não há mudança (o chamador não faz update).
 */
function avancarPorRegistro(statusAtual, etapasStatus, temItemSemEtapa = false) {
  if (['descartado', 'cancelado'].includes(statusAtual)) return null;
  const etapas = etapasStatus || [];
  const todasConcluidas = !temItemSemEtapa && etapas.length > 0 && etapas.every(s => s === 'concluida' || s === 'concluida_retroativa');
  if (todasConcluidas && statusAtual === 'em_andamento') return 'concluido';
  if (statusAtual === 'planejado' || statusAtual === 'aguardando_planejamento') return 'em_andamento';
  return null;
}

/**
 * Status final do plano após um registro (aplica avancarPorRegistro até 2 degraus:
 * aguardando/planejado → em_andamento → concluido na mesma chamada). Sempre retorna
 * um status (o próprio statusAtual quando nada muda) — o chamador compara p/ decidir o update.
 */
function statusAposRegistro(statusAtual, etapasStatus, temItemSemEtapa = false) {
  let s = statusAtual;
  const n1 = avancarPorRegistro(s, etapasStatus, temItemSemEtapa);
  if (n1) {
    s = n1;
    const n2 = avancarPorRegistro(s, etapasStatus, temItemSemEtapa);
    if (n2) s = n2;
  }
  return s;
}

module.exports = { transicaoValida, validarSubLotes, aplicarResync, avancarPorRegistro, statusAposRegistro };
