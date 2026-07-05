const { test } = require('node:test');
const assert = require('node:assert');
const G = require('../../public/js/painel/gestor.js');

test('semáforo crescimento: >5% verde, entre -5 e 5 amarelo, <-5 vermelho', () => {
  assert.equal(G.semCrescimento(0.30), 'verde');
  assert.equal(G.semCrescimento(0.02), 'amarelo');
  assert.equal(G.semCrescimento(-0.10), 'vermelho');
});

test('semáforo inadimplência: <5% verde, 5-10% amarelo, >10% vermelho', () => {
  assert.equal(G.semInadimplencia(0.04), 'verde');
  assert.equal(G.semInadimplencia(0.08), 'amarelo');
  assert.equal(G.semInadimplencia(0.16), 'vermelho');
});

test('semáforo margem: >15% verde, 8-15% amarelo, <8% vermelho', () => {
  assert.equal(G.semMargem(0.20), 'verde');
  assert.equal(G.semMargem(0.14), 'amarelo');
  assert.equal(G.semMargem(0.05), 'vermelho');
});

test('semáforo folga de segurança: >25% verde, 0-25% amarelo, negativa vermelho', () => {
  assert.equal(G.semFolga(0.40), 'verde');
  assert.equal(G.semFolga(0.22), 'amarelo');
  assert.equal(G.semFolga(-0.05), 'vermelho');
});

test('semáforo retorno do marketing: >=3x verde, 1.5-3x amarelo, <1.5x vermelho', () => {
  assert.equal(G.semRoas(3.4), 'verde');
  assert.equal(G.semRoas(2.2), 'amarelo');
  assert.equal(G.semRoas(1.1), 'vermelho');
});

test('semáforo etapa do funil: bate a meta verde, até 10% abaixo amarelo, pior vermelho', () => {
  assert.equal(G.semFunil(0.52, 0.50), 'verde');   // acima da meta
  assert.equal(G.semFunil(0.47, 0.50), 'amarelo');  // 6% abaixo
  assert.equal(G.semFunil(0.37, 0.45), 'vermelho'); // 18% abaixo
});

test('semáforo ocupação da agenda: >85% verde, 70-85% amarelo, <70% vermelho', () => {
  assert.equal(G.semOcupacao(0.90), 'verde');
  assert.equal(G.semOcupacao(0.75), 'amarelo');
  assert.equal(G.semOcupacao(0.60), 'vermelho');
});

test('resumo conta os níveis (ignora cards sem dado)', () => {
  const r = G.resumo(['verde', 'verde', 'amarelo', 'vermelho', null, 'vermelho']);
  assert.deepEqual(r, { verdes: 2, amarelos: 1, vermelhos: 2 });
});

test('crescimentoAnual: soma dos 12 meses recentes vs os 12 anteriores', () => {
  const serie = [];
  for (let i = 0; i < 12; i++) serie.push({ ym: `2024-${String(i + 1).padStart(2, '0')}`, faturamento: 100 });
  for (let i = 0; i < 12; i++) serie.push({ ym: `2025-${String(i + 1).padStart(2, '0')}`, faturamento: 130 });
  assert.ok(Math.abs(G.crescimentoAnual(serie, 'faturamento') - 0.3) < 1e-9);
  assert.equal(G.crescimentoAnual(serie.slice(0, 12), 'faturamento'), null); // <24 meses
});
