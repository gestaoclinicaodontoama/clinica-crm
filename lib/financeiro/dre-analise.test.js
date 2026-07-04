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

test('subtotais: grupo 8 fica fora do Resultado Final e entra só no pós-distribuição', () => {
  const d = dre('2026-04', { '1': 1000, '4': -300, '8': -200 });
  const s = A.subtotais(d);
  assert.equal(s.resultadoFinal, 700);                 // distribuição NÃO é custo
  assert.equal(s.resultadoAposDistribuicoes, 500);
  assert.equal(s.resultadoAposDistribuicoes, d.resultado);
});

test('pontoEquilibrio e projeção ignoram o grupo 8', () => {
  const sem6 = [dre('2026-04', { '1': 1000, '2': -100, '3.1': -300, '4': -250 })];
  const com6 = [dre('2026-04', { '1': 1000, '2': -100, '3.1': -300, '4': -250, '8': -200 })];
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

test('fixo×variável: conta 3.2.3 (pró-labore sócios) é FIXA apesar de morar no grupo 3.2', () => {
  const d = dre('2026-05', { '1': 1000, '2': -100, '3.2': -300, '4': -240 },
    { '3.2': [{ codigo: '3.2.1', nome: 'Sócios', total: -100 },
              { codigo: '3.2.3', nome: 'Pró-labore sócios — fixo', total: -200 }] });
  assert.equal(A.variaveisDe(d), -200); // 2 (-100) + 3.2.1 (-100)
  assert.equal(A.fixasDe(d), -440);     // 4 (-240) + 3.2.3 (-200)
});

test('pontoEquilibrio: 3.2.3 entra nas fixas, sai das variáveis', () => {
  const m = dre('2026-05', { '1': 1000, '2': -100, '3.2': -300, '4': -240 },
    { '3.2': [{ codigo: '3.2.1', nome: 'Sócios', total: -100 },
              { codigo: '3.2.3', nome: 'Pró-labore sócios — fixo', total: -200 }] });
  const r = A.pontoEquilibrio([m]);
  assert.ok(Math.abs(r.mcPct - 0.8) < 1e-9);      // variáveis 200/1000 → MC 80%
  assert.ok(Math.abs(r.pe - 440 / 0.8) < 0.01);   // fixas 440 → PE 550
});

test('resumoSaidas e variaveisPctReceita respeitam a exceção 3.2.3', () => {
  const d = dre('total', { '1': 1000, '2': -100, '3.2': -300, '4': -240 },
    { '3.2': [{ codigo: '3.2.1', nome: 'Sócios', total: -100 },
              { codigo: '3.2.3', nome: 'Pró-labore sócios — fixo', total: -200 }] });
  const r = A.resumoSaidas(d, 1);
  assert.equal(r.variaveis, 200);
  assert.equal(r.fixas, 440);
  assert.equal(r.total, 640);
  assert.equal(A.variaveisPctReceita(d), 0.2);
});

test('resumoSaidas: total operacional (sem grupo 8) quebrado em variáveis/fixas/outras', () => {
  const d = dre('total', { '1': 100000, '2': -15000, '3.1': -20000, '4': -30000, '5': -5000, '7': -2000, '8': -10000 });
  const r = A.resumoSaidas(d, 2);
  assert.equal(r.variaveis, 35000);   // 2 + 3.x
  assert.equal(r.fixas, 30000);       // 4
  assert.equal(r.outras, 7000);       // 5 + 7
  assert.equal(r.total, 72000);       // distribuição (8) fora
  assert.equal(r.mediaMes, 36000);
});

test('margemSeguranca: quanto a receita pode cair antes do prejuízo', () => {
  const meses = [
    dre('2026-04', { '1': 1000, '2': -100, '3.1': -300, '4': -240 }),
    dre('2026-05', { '1': 1000, '2': -100, '3.1': -300, '4': -260 }),
  ];
  const r = A.margemSeguranca(meses);
  // PE = 250/0.6 = 416,67; receita média 1000 → pode cair (1000-416,67)/1000 = 58,3%
  assert.ok(Math.abs(r.pct - 0.5833) < 0.001);
  assert.equal(r.receitaMediaMes, 1000);
  assert.ok(Math.abs(r.pe - 416.67) < 0.01);
  assert.equal(A.margemSeguranca([]), null); // sem meses completos → sem card
});

test('variaveisPctReceita: fração da receita consumida pelos variáveis', () => {
  const d = dre('total', { '1': 100000, '2': -15000, '3.1': -25000, '4': -30000 });
  assert.equal(A.variaveisPctReceita(d), 0.4);
  assert.equal(A.variaveisPctReceita(dre('x', { '1': 0, '4': -10 })), null);
});

test('resumoDistribuicoes: total distribuído e resultado retido', () => {
  const d = dre('total', { '1': 100000, '4': -60000, '8': -30000 });
  const r = A.resumoDistribuicoes(d);
  assert.equal(r.total, 30000);
  assert.equal(r.retido, 10000);      // 40000 de resultado − 30000 distribuídos
  assert.equal(A.resumoDistribuicoes(dre('x', { '1': 100, '4': -50 })).total, 0);
});

test('agruparLancamentos: parcelas e sufixo de empresa viram UMA linha, com total por mês', () => {
  const lancs = [
    { data: '2026-04-01', descricao: 'Pagamento de Conta: Aluguel 1/12 - AMA', valor: 8000, fluxo: 'sai' },
    { data: '2026-05-04', descricao: 'Pagamento de Conta: Aluguel 2/12 - AMA', valor: 8000, fluxo: 'sai' },
    { data: '2026-05-10', descricao: 'Pagamento de Conta: CEMIG - AMA', valor: 500, fluxo: 'sai' },
    { data: '2026-05-12', descricao: 'Pagamento de Conta: Estorno fornecedor - AMA', valor: 300, fluxo: 'entra' },
  ];
  const rows = A.agruparLancamentos(lancs);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].label, 'Aluguel');            // maior valor absoluto primeiro
  assert.equal(rows[0].porMes['2026-04'], -8000);
  assert.equal(rows[0].porMes['2026-05'], -8000);
  assert.equal(rows[0].total, -16000);
  assert.equal(rows[1].label, 'CEMIG');
  assert.equal(rows[2].total, 300);                  // entrada (estorno) mantém sinal positivo
});

test('agruparLancamentos: acentos e caixa não separam grupos; label é a forma mais recente', () => {
  const lancs = [
    { data: '2026-04-02', descricao: 'Pagamento de Conta: manutencao predial - AMA', valor: 100, fluxo: 'sai' },
    { data: '2026-05-02', descricao: 'Pagamento de Conta: Manutenção Predial - AMA', valor: 150, fluxo: 'sai' },
  ];
  const rows = A.agruparLancamentos(lancs);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'Manutenção Predial');
  assert.equal(rows[0].total, -250);
});

test('maiorDesvio: acha a conta de saída que mais estourou no último mês completo', () => {
  const contas = (v) => ({ '3.1': [{ codigo: '3.1.3', nome: 'Dentais', total: v }] });
  const meses = [
    dre('2026-04', { '1': 10000, '3.1': -1000 }, contas(-1000)),
    dre('2026-05', { '1': 10000, '3.1': -1000 }, contas(-1000)),
    dre('2026-06', { '1': 10000, '3.1': -4000 }, contas(-4000)),
  ];
  const d = A.maiorDesvio(meses);
  assert.equal(d.codigo, '3.1.3');
  assert.equal(d.ym, '2026-06');
  assert.ok(d.pct > 0.9); // -4000 vs média -2000 → +100%
  assert.equal(A.maiorDesvio(meses.slice(0, 2)), null); // <3 meses
});

test('maiorDesvio: conta miúda não vira KPI mesmo com % alto (caso moto taxi)', () => {
  const contas = (v) => ({ '3.3': [{ codigo: '3.3.2', nome: 'Moto taxi (Transporte)', total: v }] });
  const meses = [
    dre('2026-04', { '1': 10000, '3.3': -78 }, contas(-78)),
    dre('2026-05', { '1': 10000, '3.3': -78 }, contas(-78)),
    dre('2026-06', { '1': 10000, '3.3': -104 }, contas(-104)), // +33%, mas só R$26
  ];
  assert.equal(A.maiorDesvio(meses), null);
});

test('maiorDesvio: estouro % pequeno não vira KPI mesmo com R$ alto (variação normal)', () => {
  const contas = (v) => ({ '4': [{ codigo: '4.1.1', nome: 'RH', total: v }] });
  const meses = [
    dre('2026-04', { '1': 100000, '4': -10000 }, contas(-10000)),
    dre('2026-05', { '1': 100000, '4': -10000 }, contas(-10000)),
    dre('2026-06', { '1': 100000, '4': -11000 }, contas(-11000)), // +10% só
  ];
  assert.equal(A.maiorDesvio(meses), null);
});

test('maiorDesvio: ignora impostos (grupo 2) — seguem a receita, não são estouro de gasto', () => {
  const contas = (v) => ({ '2': [{ codigo: '2.1', nome: 'SIMPLES', total: v }] });
  const meses = [
    dre('2026-04', { '1': 100000, '2': -15000 }, contas(-15000)),
    dre('2026-05', { '1': 100000, '2': -15000 }, contas(-15000)),
    dre('2026-06', { '1': 130000, '2': -22000 }, contas(-22000)), // +R$7k, +47%
  ];
  assert.equal(A.maiorDesvio(meses), null);
});

test('maiorDesvio: entre dois estouros relevantes, ganha o maior em R$ (não em %)', () => {
  const contas = (a, b) => ({
    '3.1': [{ codigo: '3.1.3', nome: 'Dentais', total: a }],
    '3.3': [{ codigo: '3.3.2', nome: 'Moto taxi (Transporte)', total: b }],
  });
  const meses = [
    dre('2026-04', { '1': 100000, '3.1': -10000, '3.3': -500 }, contas(-10000, -500)),
    dre('2026-05', { '1': 100000, '3.1': -10000, '3.3': -500 }, contas(-10000, -500)),
    // Dentais +R$4.000 (+40%) vs Moto taxi +R$2.100 (+420%): Dentais dói mais no caixa
    dre('2026-06', { '1': 100000, '3.1': -14000, '3.3': -2600 }, contas(-14000, -2600)),
  ];
  assert.equal(A.maiorDesvio(meses).codigo, '3.1.3');
});

test('maiorDesvio ignora o grupo 8 (distribuição é decisão, não estouro)', () => {
  const contas = (v) => ({ '8': [{ codigo: '8.1', nome: 'Distribuição de lucro — sócios', total: v }] });
  const meses = [
    dre('2026-04', { '1': 1000, '8': -100 }, contas(-100)),
    dre('2026-05', { '1': 1000, '8': -100 }, contas(-100)),
    dre('2026-06', { '1': 1000, '8': -900 }, contas(-900)),
  ];
  assert.equal(A.maiorDesvio(meses), null);
});
