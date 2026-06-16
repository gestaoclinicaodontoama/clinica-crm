const { test } = require('node:test');
const assert = require('node:assert');
const { dataLocal, mesLocal } = require('./data');

test('UTC tarde da noite cai no dia certo em BR', () => {
  // 31/03 22h BRT = 01:00Z do dia 01/04
  assert.equal(dataLocal('2026-04-01T01:00:00.000Z'), '2026-03-31');
  assert.equal(mesLocal('2026-04-01T01:00:00.000Z'), '2026-03');
});

test('manhã UTC permanece no mesmo dia', () => {
  assert.equal(dataLocal('2026-05-18T14:00:00.000Z'), '2026-05-18');
});
