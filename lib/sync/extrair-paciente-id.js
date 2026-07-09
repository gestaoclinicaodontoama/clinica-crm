// Extrai o id do paciente do sufixo "(1234)" do nome — padrão da Clinicorp
// (estimates/list às vezes vem sem PatientId, mas o nome sempre carrega o id).
function extrairPacienteId(nome) {
  const m = String(nome || '').match(/\((\d+)\)\s*$/);
  return m ? m[1] : '';
}
module.exports = { extrairPacienteId };
