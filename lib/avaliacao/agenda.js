// lib/avaliacao/agenda.js
// Lógica pura: dado o array de /appointment/list do Clinicorp, filtra os
// agendamentos de um dentista num dia e normaliza para a agenda do copiloto.

function parseAgendaDia(appointments, clinicorpPersonId, _hojeISODate) {
  if (!Array.isArray(appointments)) return [];
  const alvo = String(clinicorpPersonId);

  const itens = appointments
    .filter(a => a && !a.Deleted)
    .filter(a => String(a.Dentist_PersonId) === alvo || String(a.DoctorId) === alvo)
    .map(a => {
      const fromTime = a.FromTime || a.fromTime || '';
      const toTime   = a.ToTime   || a.toTime   || '';
      return {
        appointment_id:      a.id != null ? String(a.id) : null,
        clinicorp_patient_id: a.Patient_PersonId != null ? String(a.Patient_PersonId) : null,
        paciente_nome:       a.PatientName || a.Name || 'Paciente sem nome',
        from_time:           fromTime,
        to_time:             toTime,
        presente:            !!a.CheckinTime,
      };
    });

  // presentes primeiro; dentro de cada grupo, por horário de início
  itens.sort((x, y) => {
    if (x.presente !== y.presente) return x.presente ? -1 : 1;
    return String(x.from_time).localeCompare(String(y.from_time));
  });

  return itens;
}

module.exports = { parseAgendaDia };
