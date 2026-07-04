const { test } = require('node:test');
const assert = require('node:assert');
const A = require('../../public/js/financeiro/dre-analise.js');

// helper: DRE mínima a partir de {codigoGrupo: total} (+ contas opcionais)
function dre(ym, totais, contas = {}) {
  const grupos = Object.entries(totais).map(([codigo, total]) => ({
    codigo, titulo: codigo, total,
    contas: (contas[codigo] || []).map(c => ({ ...c })),
  }));
  const receita = totais['1'] || 0;
  return { ym, receita, grupos, resultado: Object.values(totais).reduce((s, v) => s + v, 0) };
}

test('subtotais: cascata bate com o resultado final', () => {
  const d = dre('2026-05', { '1': 1000, '2': -100, '3.1': -200, '4': -300, '5': -50 });
  const s = A.subtotais(d);
  assert.equal(s.receitaBruta, 1000);
  assert.equal(s.receitaLiquida, 900);
  assert.equal(s.lucroBruto, 700);
  assert.equal(s.resultadoOperacional, 400);
  assert.equal(s.resultadoFinal, 350);
  assert.equal(s.resultadoFinal, d.resultado);
});

test('subtotais: grupo 6 fica fora do Resultado Final e entra só no pós-distribuição', () => {
  const d = dre('2026-04', { '1': 1000, '4': -300, '6': -200 });
  const s = A.subtotais(d);
  assert.equal(s.resultadoFinal, 700);                 // distribuição NÃO é custo
  assert.equal(s.resultadoAposDistribuicoes, 500);
  assert.equal(s.resultadoAposDistribuicoes, d.resultado);
});

test('pontoEquilibrio e projeção ignoram o grupo 6', () => {
  const sem6 = [dre('2026-04', { '1': 1000, '2': -100, '3.1': -300, '4': -250 })];
  const com6 = [dre('2026-04', { '1': 1000, '2': -100, '3.1': -300, '4': -250, '6': -200 })];
  assert.deepEqual(A.pontoEquilibrio(com6), A.pontoEquilibrio(sem6));
  const hoje = new Date(2026, 3, 10);
  assert.deepEqual(A.projecaoMes(com6[0], sem6, hoje), A.projecaoMes(sem6[0], sem6, hoje));
});

test('av: fração da receita bruta; null com receita 0', () => {
  assert.equal(A.av(-200, 1000), -0.2);
  assert.equal(A.av(500, 0), null);
});

test('variacao entrada usa sinal; saida usa módulo', () => {
  assert.equal(A.variacao('entrada', 1200, 1000), 0.2);
  assert.equal(A.variacao('entrada', 50, -10), 6);           // virou de prejuízo p/ lucro
  assert.ok(Math.abs(A.variacao('saida', -120, -100) - 0.2) < 1e-9); // gastou 20% a mais
  assert.equal(A.variacao('saida', -120, 0), null);
});

test('classeVariacao: despesa subir é pior, receita subir é melhor', () => {
  assert.equal(A.classeVariacao('entrada', 0.2), 'melhor');
  assert.equal(A.classeVariacao('saida', 0.2), 'pior');
  assert.equal(A.classeVariacao('saida', -0.2), 'melhor');
  assert.equal(A.classeVariacao('saida', null), null);
});

test('mesCompleto: mês corrente nunca é completo', () => {
  const hoje = new Date(2026, 6, 15); // 2026-07-15
  assert.equal(A.mesCompleto('2026-06', hoje), true);
  assert.equal(A.mesCompleto('2026-07', hoje), false);
  assert.equal(A.mesCompleto('2026-07', new Date(2026, 6, 31)), false);
});

test('nivelAnomalia: limiares 125%/150%, exige 3 meses e média não-zero', () => {
  assert.equal(A.nivelAnomalia(-130, -100, 3), 'ambar');
  assert.equal(A.nivelAnomalia(-160, -100, 3), 'vermelho');
  assert.equal(A.nivelAnomalia(-120, -100, 3), null);
  assert.equal(A.nivelAnomalia(-160, -100, 2), null);
  assert.equal(A.nivelAnomalia(-160, 0, 3), null);
});

test('pontoEquilibrio: PE = fixas médias / MC%', () => {
  const meses = [
    dre('2026-04', { '1': 1000, '2': -100, '3.1': -300, '4': -240 }),
    dre('2026-05', { '1': 1000, '2': -100, '3.1': -300, '4': -260 }),
  ];
  const r = A.pontoEquilibrio(meses);
  // variáveis 40% → MC 60%; fixas médias 250 → PE = 416,67
  assert.ok(Math.abs(r.mcPct - 0.6) < 1e-9);
  assert.ok(Math.abs(r.pe - 250 / 0.6) < 0.01);
});

test('pontoEquilibrio: guardas de erro', () => {
  assert.ok(A.pontoEquilibrio([]).erro);
  assert.ok(A.pontoEquilibrio([dre('2026-05', { '1': 0, '4': -100 })]).erro);
  assert.ok(A.pontoEquilibrio([dre('2026-05', { '1': 100, '2': -150, '4': -10 })]).erro); // MC negativa
});

test('projecaoMes: linear na receita, fixas pela média histórica', () => {
  const parcial = dre('2026-07', { '1': 500, '2': -50, '4': -100 });
  const hist = [dre('2026-06', { '1': 1000, '2': -100, '3.1': -300, '4': -240 })];
  const p = A.projecaoMes(parcial, hist, new Date(2026, 6, 10)); // dia 10 de 31
  assert.ok(Math.abs(p.receitaProj - 500 / 10 * 31) < 0.01);
  assert.ok(Math.abs(p.variaveisProj - p.receitaProj * 0.4) < 0.01);
  assert.equal(p.fixasProj, 240);
  assert.equal(p.fixasAproximada, false);
});

test('projecaoMes: sem histórico usa o próprio mês parcial (fixas lineares, aproximadas)', () => {
  const parcial = dre('2026-07', { '1': 500, '2': -100, '4': -100 });
  const p = A.projecaoMes(parcial, [], new Date(2026, 6, 10));
  assert.equal(p.fixasAproximada, true);
  assert.ok(Math.abs(p.fixasProj - 100 / 10 * 31) < 0.01);
});

test('maiorDesvio: acha a conta de saída que mais estourou no último mês completo', () => {
  const contas = (v) => ({ '3.1': [{ codigo: '3.1.3', nome: 'Dentais', total: v }] });
  const meses = [
    dre('2026-04', { '1': 1000, '3.1': -100 }, contas(-100)),
    dre('2026-05', { '1': 1000, '3.1': -100 }, contas(-100)),
    dre('2026-06', { '1': 1000, '3.1': -400 }, contas(-400)),
  ];
  const d = A.maiorDesvio(meses);
  assert.equal(d.codigo, '3.1.3');
  assert.equal(d.ym, '2026-06');
  assert.ok(d.pct > 0.9); // -400 vs média -200 → +100%
  assert.equal(A.maiorDesvio(meses.slice(0, 2)), null); // <3 meses
});

test('maiorDesvio ignora o grupo 6 (distribuição é decisão, não estouro)', () => {
  const contas = (v) => ({ '6': [{ codigo: '6.1', nome: 'Distribuição de lucro — sócios', total: v }] });
  const meses = [
    dre('2026-04', { '1': 1000, '6': -100 }, contas(-100)),
    dre('2026-05', { '1': 1000, '6': -100 }, contas(-100)),
    dre('2026-06', { '1': 1000, '6': -900 }, contas(-900)),
  ];
  assert.equal(A.maiorDesvio(meses), null);
});
