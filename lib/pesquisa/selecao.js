// Seleção de destinatários da Pesquisa de Satisfação (spec 2026-07-17).
// Lógica PURA (sem IO) — o job em server.js busca os dados e chama esta função.
const { chaveTelefone } = require('../funil/telefone');

// ⚠️ from/to do /estimates/list filtra pela data do ORÇAMENTO, não da execução —
// por isso o chamador busca 90 dias e aqui filtramos item a item por ExecutedDate.
function montarDestinatarios({ estimates, appointments, avaliadores, statusCompareceu, telefonePorPaciente, chavesRecentes, hoje }) {
  const pulados = [];
  const candidatos = []; // ordem importa: tratamentos primeiro (vencem no dedup)

  // 1) Tratamentos executados HOJE (itens Executed='X' com ExecutedDate=hoje)
  const vistosTrat = new Set();
  for (const est of estimates || []) {
    const pacId = String(est.PatientId || '');
    for (const p of est.ProcedureList || est.procedureList || []) {
      if (p.Executed !== 'X') continue;
      if (String(p.ExecutedDate || '').slice(0, 10) !== hoje) continue;
      if (vistosTrat.has(pacId)) continue;
      vistosTrat.add(pacId);
      candidatos.push({
        paciente_clinicorp_id: pacId,
        paciente_nome: est.PatientName || '',
        telefone: telefonePorPaciente.get(pacId) || '',
        dentista_nome: p.ProfessionalName || p.DentistName || '',
        origem: 'tratamento',
      });
    }
  }

  // Fallback de telefone dos tratamentos: agendamento de hoje do mesmo paciente
  const telPorApptPaciente = new Map();
  for (const a of appointments || []) {
    if ((a.Deleted || '') === 'X') continue;
    const tel = a.MobilePhone || a.Phone || '';
    const pid = String(a.Patient_PersonId || '');
    if (tel && pid && !telPorApptPaciente.has(pid)) telPorApptPaciente.set(pid, tel);
  }
  for (const c of candidatos) {
    if (!c.telefone) c.telefone = telPorApptPaciente.get(c.paciente_clinicorp_id) || '';
  }

  // 2) Avaliações de HOJE dos avaliadores que compareceram
  // (mesma regra do syncAvaliacoes: CheckinTime OU StatusId em config_status_compareceu)
  const vistosAval = new Set();
  for (const a of appointments || []) {
    if ((a.Deleted || '') === 'X') continue;
    const dentId = String(a.Dentist_PersonId || '');
    const schedId = String(a.ScheduleToId || '');
    if (!avaliadores.has(dentId) && !avaliadores.has(schedId)) continue;
    const compareceu = !!a.CheckinTime || statusCompareceu.has(String(a.StatusId || ''));
    if (!compareceu) continue;
    const pacId = String(a.Patient_PersonId || '');
    if (vistosAval.has(pacId) || vistosTrat.has(pacId)) continue;
    vistosAval.add(pacId);
    candidatos.push({
      paciente_clinicorp_id: pacId,
      paciente_nome: a.PatientName || '',
      telefone: a.MobilePhone || a.Phone || '',
      dentista_nome: '',
      origem: 'avaliacao',
    });
  }

  // 3) Dedup por telefone: dentro do lote + últimos 3 meses (chavesRecentes)
  const destinatarios = [];
  const chavesLote = new Set();
  for (const c of candidatos) {
    const chave = chaveTelefone(c.telefone);
    if (!chave) { pulados.push({ paciente_nome: c.paciente_nome, motivo: 'sem telefone' }); continue; }
    if (chavesLote.has(chave)) { pulados.push({ paciente_nome: c.paciente_nome, motivo: 'telefone repetido no lote' }); continue; }
    if (chavesRecentes.has(chave)) { pulados.push({ paciente_nome: c.paciente_nome, motivo: 'já recebeu nos últimos 3 meses' }); continue; }
    chavesLote.add(chave);
    destinatarios.push(c);
  }

  return { destinatarios, pulados };
}

module.exports = { montarDestinatarios };
