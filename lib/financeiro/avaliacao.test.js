const { test } = require('node:test');
const assert = require('node:assert');
const { montarFatos, topDesvios, contasDetalhadas } = require('./avaliacao');

const mes = (ym, receita, salarios, materiais) => ({
  ym, receita,
  grupos: [
    { codigo: '1', total: receita, contas: [] },
    { codigo: '3.1', total: -materiais, contas: [{ codigo: '3.1.1', nome: 'Dentais', total: -materiais }] },
    { codigo: '4', total: -salarios, contas: [{ codigo: '4.1', nome: 'Salários', total: -salarios }] },
  ],
  resultado: receita - salarios - materiais,
});

test('montarFatos: básicos + comparações com contexto e ano anterior', () => {
  const periodo = [mes('2026-06', 100000, 40000, 20000)];
  const contexto = [mes('2026-04', 80000, 40000, 16000), mes('2026-05', 90000, 40000, 18000)];
  const anoAnterior = [mes('2025-06', 70000, 35000, 14000)];
  const f = montarFatos({ periodo, contexto, anoAnterior });
  assert.equal(f.receita, 100000);
  assert.equal(f.resultado, 40000);
  assert.equal(f.margem, 0.4);
  assert.equal(f.contexto.receitaMediaMes, 85000);
  assert.ok(Math.abs(f.vsContexto.receitaMediaMesPct - 0.176) < 0.001); // 100k vs 85k
  assert.equal(f.anoAnterior.crescimentoReceitaPct, 0.429);             // 100k vs 70k
  assert.equal(f.fixasMediaMes, 40000);
  assert.ok(f.pontoEquilibrio.receitaNecessariaMes > 0);
});

test('topDesvios: maior estouro absoluto primeiro, ruído filtrado', () => {
  const periodo = [mes('2026-06', 100000, 55000, 20000)];   // salários +15k vs contexto
  const contexto = [mes('2026-04', 100000, 40000, 20000), mes('2026-05', 100000, 40000, 20000)];
  const d = topDesvios(periodo, contexto, 3);
  assert.equal(d[0].nome, 'Salários');
  assert.equal(d[0].deltaMes, 15000);
  assert.ok(Math.abs(d[0].deltaPct - 0.375) < 0.001);
});

test('montarFatos: sem contexto/AA não quebra', () => {
  const f = montarFatos({ periodo: [mes('2026-06', 1000, 400, 100)] });
  assert.equal(f.receita, 1000);
  assert.equal(f.contexto, undefined);
  assert.equal(f.anoAnterior, undefined);
});

test('contasDetalhadas: média mensal por conta com delta vs contexto', () => {
  const periodo = [mes('2026-06', 100000, 55000, 24000)];
  const contexto = [mes('2026-04', 100000, 40000, 20000), mes('2026-05', 100000, 40000, 20000)];
  const c = contasDetalhadas(periodo, contexto);
  const salarios = c.find(x => x.nome === 'Salários');
  assert.equal(salarios.mediaMesPeriodo, -55000);
  assert.equal(salarios.mediaMesContexto, -40000);
  assert.ok(Math.abs(salarios.deltaPct - 0.375) < 0.001);
  const dentais = c.find(x => x.nome === 'Dentais');
  assert.ok(Math.abs(dentais.deltaPct - 0.2) < 0.001);
});

test('contasDetalhadas: sem contexto → delta null', () => {
  const c = contasDetalhadas([mes('2026-06', 1000, 400, 100)]);
  assert.equal(c.find(x => x.nome === 'Salários').deltaPct, null);
});
