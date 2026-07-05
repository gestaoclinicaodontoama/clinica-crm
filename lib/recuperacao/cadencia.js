// lib/recuperacao/cadencia.js
// Timing puro da cadência de recuperação de falta (spec 2026-07-05).
const MARCOS = [0, 3, 7, 10]; // D+0, D+3, D+7, D+10(auto-Perdido)
const PRE_FECHAMENTO_BLOQUEIA = new Set(['Fechou', 'Perdido']);

function diasDesde(dataFalta, hoje) {
  const a = new Date(dataFalta + 'T00:00:00Z');
  const b = new Date(hoje + 'T00:00:00Z');
  return Math.floor((b - a) / 86400000);
}

// Qual marco está devido agora e ainda não foi enviado (toquesEnviados = quantos
// marcos já disparados, em ordem). Retorna o marco (0/3/7/10) ou null.
function toqueDevido(dataFalta, hoje, toquesEnviados) {
  const d = diasDesde(dataFalta, hoje);
  const proximo = MARCOS[toquesEnviados];         // próximo marco a disparar
  if (proximo === undefined) return null;          // já disparou todos
  return d >= proximo ? proximo : null;
}

function podeAutoPerder({ leadEncontrado, statusLead, temConsultaFutura, tarefaConcluida }) {
  return !!leadEncontrado
    && !PRE_FECHAMENTO_BLOQUEIA.has(statusLead)
    && !temConsultaFutura
    && !tarefaConcluida;
}

module.exports = { diasDesde, toqueDevido, podeAutoPerder, MARCOS };
