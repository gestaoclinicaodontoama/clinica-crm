/**
 * Decide quais pacientes NOVOS inserir no cadastro a partir de pagamentos + agendamentos.
 *
 * Antes, o sync só inseria pacientes vindos de PAGAMENTOS — quem agendou/compareceu mas
 * ainda não pagou nunca entrava no cadastro (e o agente de marketing casa por telefone,
 * então esses leads convertidos ficavam invisíveis). Agora os agendamentos também entram.
 *
 * @param {Object} payMap  - { [clinicorpId]: { nome, telefone, ... } } (de /payment/list)
 * @param {Object} apptMap - { [clinicorpId]: { nome, telefone, ... } } (de /appointment/list)
 * @param {Set<string>} existingIds - clinicorp_ids (string) já presentes em `pacientes`
 * @returns {{ viaPagamento: string[], viaAgendamento: Array<{clinicorp_id:number, nome:string, telefone:string}> }}
 *   viaPagamento   = ids novos vindos de pagamento (o caller enriquece via /patient/get).
 *   viaAgendamento = pacientes novos SÓ de agendamento (insert direto com nome+telefone).
 */
function planejarNovosPacientes(payMap = {}, apptMap = {}, existingIds = new Set()) {
  const has = id => existingIds.has(String(id));

  const viaPagamento = Object.keys(payMap).filter(id => !has(id));
  const jaPlanejado = new Set(viaPagamento.map(String));

  const viaAgendamento = Object.keys(apptMap)
    .filter(id => !has(id) && !jaPlanejado.has(String(id)))
    .map(id => ({
      clinicorp_id: Number(id),
      nome: apptMap[id]?.nome || '',
      telefone: apptMap[id]?.telefone || '',
    }));

  return { viaPagamento, viaAgendamento };
}

module.exports = { planejarNovosPacientes };
