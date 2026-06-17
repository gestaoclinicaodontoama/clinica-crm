// Marca o 1º pagamento (por data) de cada paciente como 'entrada', os demais como 'parcelas'.
// IMPORTANTE: receber o histórico COMPLETO do paciente (rodar só após backfill total).
// O caso "entrada parcelada no cartão" fica em aberto (ver spec §12) — ajuste manual pontual.
function marcarEntradaParcelas(lancs) {
  const primeiroPorPaciente = new Map();
  for (const l of lancs) {
    if (!l.paciente_id) continue;
    const atual = primeiroPorPaciente.get(l.paciente_id);
    if (!atual || l.data < atual) primeiroPorPaciente.set(l.paciente_id, l.data);
  }
  return lancs.map(l => {
    if (!l.paciente_id) return { ...l, receita_sub: null };
    const ehEntrada = l.data === primeiroPorPaciente.get(l.paciente_id);
    return { ...l, receita_sub: ehEntrada ? 'entrada' : 'parcelas' };
  });
}

module.exports = { marcarEntradaParcelas };
