const { test } = require('node:test');
const assert = require('node:assert');
const { extrairPacienteId } = require('./extrair-paciente-id');

test('extrairPacienteId: sufixo (id) no fim do nome', () => {
  assert.equal(extrairPacienteId('Heitor Ferreira De Assis (14834)'), '14834');
  assert.equal(extrairPacienteId('Fulano (99)  '), '99');
  assert.equal(extrairPacienteId('Maria (obs) Silva (123)'), '123'); // só o do FIM
  assert.equal(extrairPacienteId('Sem Sufixo'), '');
  assert.equal(extrairPacienteId(''), '');
  assert.equal(extrairPacienteId(null), '');
});
