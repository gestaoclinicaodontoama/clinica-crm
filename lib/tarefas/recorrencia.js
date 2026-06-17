// lib/tarefas/recorrencia.js
// Avalia se um molde de rotina vale para uma data (string 'YYYY-MM-DD', no fuso já resolvido).

function diaSemanaLocal(dataRefISO) {
  const [a, m, d] = dataRefISO.split('-').map(Number);
  return new Date(a, m - 1, d).getDay(); // 0=domingo ... 6=sabado
}

function ultimoDiaDoMes(ano, mes /* 1-12 */) {
  return new Date(ano, mes, 0).getDate();
}

function moldeValeNoDia(template, dataRefISO) {
  const dow = diaSemanaLocal(dataRefISO);
  if (template.frequencia === 'diaria') {
    if (!template.dias_semana || template.dias_semana.length === 0) return true;
    return template.dias_semana.includes(dow);
  }
  if (template.frequencia === 'semanal') {
    return Array.isArray(template.dias_semana) && template.dias_semana.includes(dow);
  }
  if (template.frequencia === 'mensal') {
    const [ano, mes, dia] = dataRefISO.split('-').map(Number);
    const alvo = Math.min(template.dia_mes, ultimoDiaDoMes(ano, mes));
    return dia === alvo;
  }
  return false;
}

module.exports = { moldeValeNoDia, diaSemanaLocal, ultimoDiaDoMes };
