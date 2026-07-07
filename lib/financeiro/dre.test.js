const { test } = require('node:test');
const assert = require('node:assert');
const { montarDRE } = require('./dre');

// lançamentos já com conta (codigo) e valor positivo
const lancs = [
  { fluxo: 'entra', valor: 72985.41, conta_codigo: '1.1' }, // Convênio
  { fluxo: 'entra', valor: 294466.02, conta_codigo: '1.2' }, // Particular
  { fluxo: 'sai',   valor: 6364.62,  conta_codigo: '2.1' }, // SIMPLES
  { fluxo: 'sai',   valor: 26201.51, conta_codigo: '3.1.7' }, // Invisalign
];

test('soma receita e subtrai despesa, resultado correto', () => {
  const dre = montarDRE(lancs);
  assert.equal(dre.receita, 367451.43);
  const grupo2 = dre.grupos.find(g => g.codigo === '2');
  assert.equal(grupo2.total, -6364.62);
  assert.equal(dre.resultado, 367451.43 - 6364.62 - 26201.51);
});

test('agrupa por grupo da conta', () => {
  const dre = montarDRE(lancs);
  const g31 = dre.grupos.find(g => g.codigo === '3.1');
  assert.equal(g31.total, -26201.51);
  assert.equal(g31.contas[0].nome, 'Invisalign');
});

test('provisões (grupo 9) aparecem mas NÃO mexem no resultado', () => {
  const comProvisao = montarDRE([...lancs,
    { fluxo: 'sai', valor: 30610, conta_codigo: '9.1' }]); // provisão
  const semProvisao = montarDRE(lancs);
  // grupo 9 existe e soma a provisão
  const g9 = comProvisao.grupos.find(g => g.codigo === '9');
  assert.equal(g9.total, -30610);
  // mas o resultado é idêntico ao de sem provisão (reserva não afeta o caixa)
  assert.equal(comProvisao.resultado, semProvisao.resultado);
});
