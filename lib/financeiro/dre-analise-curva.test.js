const { test } = require('node:test');
const assert = require('node:assert');
const A = require('../../public/js/financeiro/dre-analise.js');

// 2 meses: receita uniforme; saída carregada no início do mês
const ROWS = [];
for (const ym of ['2026-05', '2026-06']) {
  for (let d = 1; d <= 30; d++) {
    ROWS.push({ ym, dia: d, receita: 100, saida: d <= 3 ? 800 : 25 }); // saída: 2400 nos 3 primeiros dias, 675 no resto
  }
}

test('curvaDiaria: fração acumulada média por dia', () => {
  const c = A.curvaDiaria(ROWS);
  assert.equal(c.meses, 2);
  assert.ok(Math.abs(c.receita[1] - 2 / 30) < 1e-9);            // dia 2: 2/30 da receita
  assert.ok(Math.abs(c.saida[1] - 1600 / 3075) < 1e-9);          // dia 2: 1600 de 3075 já saiu (~52%)
  assert.ok(Math.abs(c.receita[30] - 1) < 1e-9);                 // dia 31: 100%
  assert.ok(Math.abs(c.saida[30] - 1) < 1e-9);
});

test('curvaDiaria: vazio → null', () => {
  assert.equal(A.curvaDiaria([]), null);
  assert.equal(A.curvaDiaria(null), null);
});

test('projecaoMesCurva corrige o front-loading que explodia a projeção linear', () => {
  const c = A.curvaDiaria(ROWS);
  // dia 2 do mês: recebeu 200 (2 dias × 100), pagou 1600 (2 dias × 800)
  const mesParcial = { ym: '2026-07', receita: 200, grupos: [
    { codigo: '1', total: 200, contas: [] },
    { codigo: '4', total: -1600, contas: [] },
  ], resultado: -1400 };
  const p = A.projecaoMesCurva(mesParcial, c, new Date(2026, 6, 2));
  assert.ok(Math.abs(p.receitaProj - 3000) < 1);                 // 200 ÷ (2/30) = mês cheio
  assert.ok(Math.abs(p.saidaProj - 3075) < 1);                   // 1600 ÷ 52% = saída do mês cheio
  assert.ok(Math.abs(p.resultadoProj - -75) < 1);                // ≈ resultado real do padrão (3000-3075)
  assert.equal(p.confianca, 'baixa');                            // dia 2
  // a linear daria: saída 1600/2×31 = 24.800 → resultado -21.700 (o "543k louco")
});

test('projecaoMesCurva: confiança alta com mês andado', () => {
  const c = A.curvaDiaria(ROWS);
  const mesParcial = { ym: '2026-07', receita: 1500, grupos: [
    { codigo: '1', total: 1500, contas: [] },
    { codigo: '4', total: -2725, contas: [] },
  ], resultado: -1225 };
  const p = A.projecaoMesCurva(mesParcial, c, new Date(2026, 6, 15));
  assert.equal(p.confianca, 'alta');
  assert.ok(Math.abs(p.receitaProj - 3000) < 1);
});

test('projecaoMesCurva: sem curva → null (cai no método antigo)', () => {
  assert.equal(A.projecaoMesCurva({ grupos: [] }, null, new Date()), null);
});
