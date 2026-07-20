// Classifica os atendimentos de um dia em: com registro de procedimento
// executado, sem registro (pendência de documentação) e manutenção (visita
// sem procedimento cobrável esperado — informativa, fora da contagem).
// Categorias "Avalia%" ficam fora: esse funil já é auditado no Dashboard
// Comercial (orçamento criado, não procedimento executado).
'use strict';

const isAvaliacao  = c => /^avalia/i.test(String(c || '').trim());
const isManutencao = c => /^manuten/i.test(String(c || '').trim());

function classificarDia({ atendimentos, producao, pacientesRegistradosHoje }) {
  // paciente → procedimentos executados no dia
  const procsPorPaciente = new Map();
  for (const p of (producao || [])) {
    const id = String(p.paciente_clinicorp_id || '');
    if (!id) continue;
    if (!procsPorPaciente.has(id)) procsPorPaciente.set(id, []);
    procsPorPaciente.get(id).push(p.procedure_name || '');
  }

  // Registro por Sessão (ASB): paciente com etapa concluída no dia OU sessao_avulsa no dia.
  // Só esses são dispensados de "sem_registro" — plano ativo sozinho (sem sessão registrada
  // naquele dia) NÃO dispensa mais: vira pendência real (substitui a dispensa grosseira antiga).
  const registradosHoje = pacientesRegistradosHoje || new Set();

  const sem_registro = [], com_registro = [], manutencao = [], esperada_plano = [];
  const porDent = new Map();

  for (const a of (atendimentos || [])) {
    if (a.compareceu !== true) continue;
    if (isAvaliacao(a.category)) continue;

    const pid    = String(a.paciente_clinicorp_id || '');
    const procs  = pid ? (procsPorPaciente.get(pid) || []) : [];
    const item = {
      paciente:              a.patient_name || '',
      paciente_clinicorp_id: pid || null,
      dentista:              a.dentist_name || '',
      horario:               [a.from_time, a.to_time].filter(Boolean).join('–'),
      categoria:             a.category || null,
      registrado:            procs.length > 0,
      sem_id:                !pid,
      procedimentos:         procs,
    };

    if (isManutencao(a.category)) { manutencao.push(item); continue; }

    // Modo de Planejamento: sessão sem registro de procedimento cujo paciente já teve
    // REGISTRO POR SESSÃO no dia (etapa concluída ou sessao_avulsa) é "esperada pelo
    // plano" — intermediária, não pendência. Fora da contagem de atendidos/pendentes,
    // igual à Manutenção.
    if (!item.registrado && pid && registradosHoje.has(pid)) { esperada_plano.push(item); continue; }

    (item.registrado ? com_registro : sem_registro).push(item);
    const d = porDent.get(item.dentista) || { dentista: item.dentista, atendidos: 0, registrados: 0, pendentes: 0 };
    d.atendidos++;
    if (item.registrado) d.registrados++; else d.pendentes++;
    porDent.set(item.dentista, d);
  }

  const byDentHora = (x, y) =>
    x.dentista.localeCompare(y.dentista, 'pt-BR') || x.horario.localeCompare(y.horario);
  sem_registro.sort(byDentHora); com_registro.sort(byDentHora); manutencao.sort(byDentHora); esperada_plano.sort(byDentHora);

  const por_dentista = [...porDent.values()]
    .sort((x, y) => y.pendentes - x.pendentes || x.dentista.localeCompare(y.dentista, 'pt-BR'));

  return {
    resumo: {
      atendidos:   com_registro.length + sem_registro.length,
      registrados: com_registro.length,
      pendentes:   sem_registro.length,
      por_dentista,
    },
    sem_registro, com_registro, manutencao, esperada_plano,
  };
}

module.exports = { classificarDia };
