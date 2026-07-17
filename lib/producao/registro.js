// Classifica os atendimentos de um dia em: com registro de procedimento
// executado, sem registro (pendência de documentação) e manutenção (visita
// sem procedimento cobrável esperado — informativa, fora da contagem).
// Categorias "Avalia%" ficam fora: esse funil já é auditado no Dashboard
// Comercial (orçamento criado, não procedimento executado).
'use strict';

const isAvaliacao  = c => /^avalia/i.test(String(c || '').trim());
const isManutencao = c => /^manuten/i.test(String(c || '').trim());

function classificarDia({ atendimentos, producao }) {
  // paciente → procedimentos executados no dia
  const procsPorPaciente = new Map();
  for (const p of (producao || [])) {
    const id = String(p.paciente_clinicorp_id || '');
    if (!id) continue;
    if (!procsPorPaciente.has(id)) procsPorPaciente.set(id, []);
    procsPorPaciente.get(id).push(p.procedure_name || '');
  }

  const sem_registro = [], com_registro = [], manutencao = [];
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

    (item.registrado ? com_registro : sem_registro).push(item);
    const d = porDent.get(item.dentista) || { dentista: item.dentista, atendidos: 0, registrados: 0, pendentes: 0 };
    d.atendidos++;
    if (item.registrado) d.registrados++; else d.pendentes++;
    porDent.set(item.dentista, d);
  }

  const byDentHora = (x, y) =>
    x.dentista.localeCompare(y.dentista, 'pt-BR') || x.horario.localeCompare(y.horario);
  sem_registro.sort(byDentHora); com_registro.sort(byDentHora); manutencao.sort(byDentHora);

  const por_dentista = [...porDent.values()]
    .sort((x, y) => y.pendentes - x.pendentes || x.dentista.localeCompare(y.dentista, 'pt-BR'));

  return {
    resumo: {
      atendidos:   com_registro.length + sem_registro.length,
      registrados: com_registro.length,
      pendentes:   sem_registro.length,
      por_dentista,
    },
    sem_registro, com_registro, manutencao,
  };
}

module.exports = { classificarDia };
