const { test } = require('node:test');
const assert = require('node:assert');
const { montarDestinatarios } = require('./selecao');

const HOJE = '2026-07-17';

function estimate(patientId, nome, procs) {
  return { id: '900' + patientId, PatientId: patientId, PatientName: nome, ProcedureList: procs };
}
function procExecHoje(dentista) {
  return { Executed: 'X', ExecutedDate: HOJE + 'T10:00:00', Amount: 100, ProfessionalName: dentista };
}
function base(extra = {}) {
  return {
    estimates: [], appointments: [],
    avaliadores: new Set(), statusCompareceu: new Set(),
    telefonePorPaciente: new Map(), chavesRecentes: new Set(), hoje: HOJE,
    ...extra,
  };
}

test('tratamento executado hoje entra; executado ontem não', () => {
  const r = montarDestinatarios(base({
    estimates: [
      estimate('11', 'Ana', [procExecHoje('Dra. X')]),
      estimate('22', 'Beto', [{ Executed: 'X', ExecutedDate: '2026-07-16T09:00:00', Amount: 50 }]),
      estimate('33', 'Caio', [{ Executed: '', ExecutedDate: HOJE + 'T11:00:00', Amount: 80 }]),
    ],
    telefonePorPaciente: new Map([['11', '5531988887777'], ['22', '5531977776666'], ['33', '5531966665555']]),
  }));
  assert.strictEqual(r.destinatarios.length, 1);
  assert.strictEqual(r.destinatarios[0].paciente_clinicorp_id, '11');
  assert.strictEqual(r.destinatarios[0].origem, 'tratamento');
  assert.strictEqual(r.destinatarios[0].dentista_nome, 'Dra. X');
});

test('avaliação de avaliador com CheckinTime entra; sem comparecimento não', () => {
  const r = montarDestinatarios(base({
    avaliadores: new Set(['5757301300985856']),
    statusCompareceu: new Set(['777']),
    appointments: [
      { id: 'a1', Dentist_PersonId: '5757301300985856', Patient_PersonId: '44', PatientName: 'Dani',
        MobilePhone: '31 98888-1111', CheckinTime: 1721230000000, date: HOJE },
      { id: 'a2', ScheduleToId: '5757301300985856', Patient_PersonId: '55', PatientName: 'Edu',
        MobilePhone: '31 98888-2222', StatusId: '777', date: HOJE },
      { id: 'a3', Dentist_PersonId: '5757301300985856', Patient_PersonId: '66', PatientName: 'Fabi',
        MobilePhone: '31 98888-3333', StatusId: '1', date: HOJE },
      { id: 'a4', Dentist_PersonId: '999', Patient_PersonId: '77', PatientName: 'Gil',
        MobilePhone: '31 98888-4444', CheckinTime: 1721230000000, date: HOJE },
      { id: 'a5', Deleted: 'X', Dentist_PersonId: '5757301300985856', Patient_PersonId: '88',
        PatientName: 'Hugo', MobilePhone: '31 98888-5555', CheckinTime: 1721230000000, date: HOJE },
    ],
  }));
  const nomes = r.destinatarios.map(d => d.paciente_nome).sort();
  assert.deepStrictEqual(nomes, ['Dani', 'Edu']);
  assert.strictEqual(r.destinatarios[0].origem, 'avaliacao');
});

test('dedup: mesmo telefone no lote e telefone recente (3 meses) saem', () => {
  const r = montarDestinatarios(base({
    estimates: [estimate('11', 'Ana', [procExecHoje('Dra. X')])],
    avaliadores: new Set(['10']),
    appointments: [
      // familiar com o MESMO telefone da Ana (sufixo igual, formato diferente)
      { id: 'a1', Dentist_PersonId: '10', Patient_PersonId: '99', PatientName: 'Filho da Ana',
        MobilePhone: '(31) 98888-7777', CheckinTime: 1, date: HOJE },
      // paciente que já recebeu há 1 mês
      { id: 'a2', Dentist_PersonId: '10', Patient_PersonId: '98', PatientName: 'Já Recebeu',
        MobilePhone: '31 97777-0000', CheckinTime: 1, date: HOJE },
    ],
    telefonePorPaciente: new Map([['11', '5531988887777']]),
    chavesRecentes: new Set([require('../funil/telefone').chaveTelefone('31 97777-0000')]),
  }));
  assert.strictEqual(r.destinatarios.length, 1);
  assert.strictEqual(r.destinatarios[0].paciente_nome, 'Ana');
  assert.strictEqual(r.pulados.length, 2);
});

test('tratamento sem telefone: usa fallback do appointment do dia; sem nada → pulado', () => {
  const r = montarDestinatarios(base({
    estimates: [
      estimate('11', 'Ana', [procExecHoje('Dra. X')]),
      estimate('22', 'Beto', [procExecHoje('Dr. Y')]),
    ],
    // Ana não está na tabela pacientes, mas tem agendamento hoje com telefone
    appointments: [{ id: 'a1', Dentist_PersonId: '999', Patient_PersonId: '11', PatientName: 'Ana',
      MobilePhone: '31 96666-1234', date: HOJE }],
  }));
  assert.strictEqual(r.destinatarios.length, 1);
  assert.strictEqual(r.destinatarios[0].telefone, '31 96666-1234');
  assert.strictEqual(r.pulados.length, 1);
  assert.strictEqual(r.pulados[0].motivo, 'sem telefone');
});

test('mesmo paciente em tratamento e avaliação → 1 envio (origem tratamento)', () => {
  const r = montarDestinatarios(base({
    estimates: [estimate('11', 'Ana', [procExecHoje('Dra. X')])],
    avaliadores: new Set(['10']),
    appointments: [{ id: 'a1', Dentist_PersonId: '10', Patient_PersonId: '11', PatientName: 'Ana',
      MobilePhone: '31 98888-7777', CheckinTime: 1, date: HOJE }],
    telefonePorPaciente: new Map([['11', '31 98888-7777']]),
  }));
  assert.strictEqual(r.destinatarios.length, 1);
  assert.strictEqual(r.destinatarios[0].origem, 'tratamento');
});

test('tratamento sem PatientId: cai para extrairPacienteId(PatientName)', () => {
  const r = montarDestinatarios(base({
    estimates: [
      { id: '900', PatientId: '', PatientName: 'Fulano (77)', ProcedureList: [procExecHoje('Dra. X')] },
    ],
    telefonePorPaciente: new Map([['77', '5531988887777']]),
  }));
  assert.strictEqual(r.destinatarios.length, 1);
  assert.strictEqual(r.destinatarios[0].paciente_clinicorp_id, '77');
});
