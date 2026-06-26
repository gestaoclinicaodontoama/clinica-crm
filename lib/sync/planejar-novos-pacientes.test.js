const { test } = require('node:test');
const assert = require('node:assert');
const { planejarNovosPacientes } = require('./planejar-novos-pacientes');

test('paciente já existente não é planejado', () => {
  const r = planejarNovosPacientes(
    { 100: { nome: 'A', telefone: '31999990000' } },
    {},
    new Set(['100']));
  assert.deepEqual(r.viaPagamento, []);
  assert.deepEqual(r.viaAgendamento, []);
});

test('novo pagador entra em viaPagamento', () => {
  const r = planejarNovosPacientes(
    { 200: { nome: 'B', telefone: '31988887777' } },
    {},
    new Set());
  assert.deepEqual(r.viaPagamento, ['200']);
  assert.deepEqual(r.viaAgendamento, []);
});

test('paciente só de agendamento (sem pagar) entra em viaAgendamento com nome+telefone', () => {
  const r = planejarNovosPacientes(
    {},
    { 300: { nome: 'Carmelita', telefone: '31 99888-1234', ultima_visita: '2026-06-10' } },
    new Set());
  assert.deepEqual(r.viaPagamento, []);
  assert.deepEqual(r.viaAgendamento, [{ clinicorp_id: 300, nome: 'Carmelita', telefone: '31 99888-1234' }]);
});

test('id em pagamento E agendamento (novo) vai só para viaPagamento (sem duplicar)', () => {
  const r = planejarNovosPacientes(
    { 400: { nome: 'D', telefone: '31000' } },
    { 400: { nome: 'D', telefone: '31000' }, 500: { nome: 'E', telefone: '32000' } },
    new Set());
  assert.deepEqual(r.viaPagamento, ['400']);
  assert.deepEqual(r.viaAgendamento, [{ clinicorp_id: 500, nome: 'E', telefone: '32000' }]);
});

test('agendamento de paciente já existente é ignorado', () => {
  const r = planejarNovosPacientes(
    {},
    { 600: { nome: 'F', telefone: '33000' } },
    new Set(['600']));
  assert.deepEqual(r.viaAgendamento, []);
});

test('ids comparados como string (number no map vs string no Set)', () => {
  const r = planejarNovosPacientes(
    { 700: { nome: 'G', telefone: '34000' } },
    {},
    new Set(['700']));
  assert.deepEqual(r.viaPagamento, []);
});
