const { test } = require('node:test');
const assert = require('node:assert');
const { estadoJanela, _fmtRestante } = require('../public/js/janela24h');

const H = 3600 * 1000;

test('sem mensagem recebida = fechada', () => {
  const j = estadoJanela(null, Date.now());
  assert.strictEqual(j.estado, 'fechada');
  assert.strictEqual(j.restanteMs, 0);
});

test('recebida ha 2h = aberta com ~22h restantes', () => {
  const agora = Date.now();
  const j = estadoJanela(new Date(agora - 2 * H).toISOString(), agora);
  assert.strictEqual(j.estado, 'aberta');
  assert.ok(j.restanteMs > 21 * H && j.restanteMs <= 22 * H);
  assert.match(j.label, /fecha em 21h|fecha em 22h/);
});

test('recebida ha 20h = fechando (resta menos que o aviso de 6h)', () => {
  const agora = Date.now();
  const j = estadoJanela(new Date(agora - 20 * H).toISOString(), agora);
  assert.strictEqual(j.estado, 'fechando');
  assert.match(j.label, /responda logo/);
});

test('recebida ha 25h = fechada', () => {
  const agora = Date.now();
  const j = estadoJanela(new Date(agora - 25 * H).toISOString(), agora);
  assert.strictEqual(j.estado, 'fechada');
});

test('_fmtRestante: 23h / 5h 32min / 47min / 4h em ponto sem "0min"', () => {
  assert.strictEqual(_fmtRestante(23 * H + 10 * 60000), '23h');
  assert.strictEqual(_fmtRestante(5 * H + 32 * 60000), '5h 32min');
  assert.strictEqual(_fmtRestante(47 * 60000), '47min');
  assert.strictEqual(_fmtRestante(4 * H), '4h');
});
