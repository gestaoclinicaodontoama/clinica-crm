// lib/funil/periodo.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { resolvePeriodo } = require('./periodo');

describe('resolvePeriodo', () => {
  const now = new Date('2026-06-15T10:00:00-03:00');

  it('preset 30d gera intervalo de 30 dias incluindo hoje (hoje − 29)', () => {
    const p = resolvePeriodo('30d', null, null, now);
    assert.strictEqual(p.from, '2026-05-17T00:00:00-03:00');
    assert.strictEqual(p.to, '2026-06-15T23:59:59-03:00');
  });

  it('preset 30d gera período anterior de mesma duração imediatamente antes', () => {
    const p = resolvePeriodo('30d', null, null, now);
    assert.strictEqual(p.anterior.from, '2026-04-17T00:00:00-03:00');
    assert.strictEqual(p.anterior.to, '2026-05-16T23:59:59-03:00');
  });

  it('preset mes gera o mês corrente e anterior = mês passado', () => {
    const p = resolvePeriodo('mes', null, null, now);
    assert.strictEqual(p.from, '2026-06-01T00:00:00-03:00');
    assert.strictEqual(p.to, '2026-06-30T23:59:59-03:00');
    assert.strictEqual(p.anterior.from, '2026-05-01T00:00:00-03:00');
    assert.strictEqual(p.anterior.to, '2026-05-31T23:59:59-03:00');
  });

  it('custom usa as datas recebidas e calcula granularidade', () => {
    const p = resolvePeriodo('custom', '2026-01-01', '2026-06-30', now);
    assert.strictEqual(p.from, '2026-01-01T00:00:00-03:00');
    assert.strictEqual(p.to, '2026-06-30T23:59:59-03:00');
    assert.strictEqual(p.granularidade, 'semana'); // > 60 dias
  });

  it('intervalo curto usa granularidade dia', () => {
    assert.strictEqual(resolvePeriodo('30d', null, null, now).granularidade, 'dia');
  });
});
