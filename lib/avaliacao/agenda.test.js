const { test } = require('node:test');
const assert = require('node:assert');
const { parseAgendaDia } = require('./agenda');

const PERSON = 5757301300985856;

test('filtra só os agendamentos do dentista informado', () => {
  const appts = [
    { id: '1', Dentist_PersonId: PERSON, PatientName: 'Ana',  Patient_PersonId: 'p1', fromTime: '08:00', toTime: '08:30' },
    { id: '2', Dentist_PersonId: 999,    PatientName: 'Beto', Patient_PersonId: 'p2', fromTime: '09:00', toTime: '09:30' },
  ];
  const out = parseAgendaDia(appts, PERSON, '2026-06-12');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].paciente_nome, 'Ana');
  assert.strictEqual(out[0].appointment_id, '1');
});

test('aceita match por DoctorId quando Dentist_PersonId ausente', () => {
  const appts = [{ id: '3', DoctorId: PERSON, Name: 'Caio', fromTime: '10:00', toTime: '10:30' }];
  const out = parseAgendaDia(appts, PERSON, '2026-06-12');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].paciente_nome, 'Caio');
});

test('marca presente quando há CheckinTime', () => {
  const appts = [
    { id: '4', Dentist_PersonId: PERSON, PatientName: 'Dora', fromTime: '08:00', toTime: '08:30', CheckinTime: 1749700000000 },
    { id: '5', Dentist_PersonId: PERSON, PatientName: 'Eva',  fromTime: '09:00', toTime: '09:30' },
  ];
  const out = parseAgendaDia(appts, PERSON, '2026-06-12');
  const dora = out.find(o => o.paciente_nome === 'Dora');
  const eva  = out.find(o => o.paciente_nome === 'Eva');
  assert.strictEqual(dora.presente, true);
  assert.strictEqual(eva.presente, false);
});

test('ignora agendamentos deletados', () => {
  const appts = [{ id: '6', Dentist_PersonId: PERSON, PatientName: 'Fred', fromTime: '08:00', toTime: '08:30', Deleted: true }];
  assert.strictEqual(parseAgendaDia(appts, PERSON, '2026-06-12').length, 0);
});

test('ordena presentes primeiro, depois por horário', () => {
  const appts = [
    { id: '7', Dentist_PersonId: PERSON, PatientName: 'Gil',  fromTime: '11:00', toTime: '11:30' },
    { id: '8', Dentist_PersonId: PERSON, PatientName: 'Hugo', fromTime: '08:00', toTime: '08:30', CheckinTime: 1749700000000 },
    { id: '9', Dentist_PersonId: PERSON, PatientName: 'Ivo',  fromTime: '09:00', toTime: '09:30' },
  ];
  const out = parseAgendaDia(appts, PERSON, '2026-06-12');
  assert.deepStrictEqual(out.map(o => o.paciente_nome), ['Hugo', 'Ivo', 'Gil']);
});

test('aceita string ou number como clinicorpPersonId', () => {
  const appts = [{ id: '10', Dentist_PersonId: PERSON, PatientName: 'Ana', fromTime: '08:00', toTime: '08:30' }];
  assert.strictEqual(parseAgendaDia(appts, String(PERSON), '2026-06-12').length, 1);
});

test('lista vazia ou null retorna []', () => {
  assert.deepStrictEqual(parseAgendaDia(null, PERSON, '2026-06-12'), []);
  assert.deepStrictEqual(parseAgendaDia([], PERSON, '2026-06-12'), []);
});
