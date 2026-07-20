// lib/planejamento/fiscalizacao.test.js
const test = require('node:test');
const assert = require('node:assert');
const { resumoPlano } = require('./fiscalizacao');

test('resumoPlano: dentro do planejado (real < planejado) → ok', () => {
  const r = resumoPlano({ tempo_planejado_min: 120, tempo_real_min: 90, valor: 1000 }, 180, 20);
  assert.equal(r.planejado_min, 120);
  assert.equal(r.real_min, 90);
  assert.equal(r.delta_min, -30);
  assert.equal(r.estouro, false);
  assert.equal(r.custo_cadeira, 270); // (90/60)*180
  assert.equal(r.pct_receita_cadeira, 0.27);
  assert.equal(r.severidade, 'ok');
});

test('resumoPlano: estouro (real > planejado) mas custo de cadeira ainda dentro da margem-alvo → atencao', () => {
  // valor 2000, custoHora 180, real 130min → custo 390; teto = 2000*(1-0.20)=1600 → não crítico
  const r = resumoPlano({ tempo_planejado_min: 120, tempo_real_min: 130, valor: 2000 }, 180, 20);
  assert.equal(r.delta_min, 10);
  assert.equal(r.estouro, true);
  assert.equal(r.severidade, 'atencao');
});

test('resumoPlano: critico quando o custo de cadeira sozinho já passa do teto da margem-alvo', () => {
  // valor 100, custoHora 180, real 60min → custo 180; teto = 100*(1-0.20)=80 → 180 > 80 → critico
  const r = resumoPlano({ tempo_planejado_min: 60, tempo_real_min: 60, valor: 100 }, 180, 20);
  assert.equal(r.custo_cadeira, 180);
  assert.equal(r.severidade, 'critico');
});

test('resumoPlano: valor 0 → pct_receita_cadeira null e severidade nunca critico (sem receita p/ comparar)', () => {
  const r = resumoPlano({ tempo_planejado_min: 60, tempo_real_min: 90, valor: 0 }, 180, 20);
  assert.equal(r.pct_receita_cadeira, null);
  assert.notEqual(r.severidade, 'critico');
  assert.equal(r.estouro, true);
  assert.equal(r.severidade, 'atencao');
});

test('resumoPlano: tempos zerados/ausentes → tudo 0 e ok (sem estouro, sem crítico)', () => {
  const r = resumoPlano({ tempo_planejado_min: null, tempo_real_min: null, valor: 500 }, 180, 20);
  assert.equal(r.planejado_min, 0);
  assert.equal(r.real_min, 0);
  assert.equal(r.delta_min, 0);
  assert.equal(r.estouro, false);
  assert.equal(r.custo_cadeira, 0);
  assert.equal(r.pct_receita_cadeira, 0);
  assert.equal(r.severidade, 'ok');
});

test('resumoPlano: campos ausentes/objeto vazio não quebram', () => {
  const r = resumoPlano({}, 180, 20);
  assert.equal(r.planejado_min, 0);
  assert.equal(r.real_min, 0);
  assert.equal(r.severidade, 'ok');
});
