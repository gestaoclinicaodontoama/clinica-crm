const { test } = require('node:test');
const assert = require('node:assert');
const D = require('../../public/js/financeiro/diagnostico-saude.js');

const base = {
  aReceber: 1000000, diferenca: 100000, vencido: 30000, taxaPerda: 0.03,
  agingFaixas: [{ faixa: '1–30', valor: 500 }, { faixa: '180+', valor: 100 }],
  maiorPagador: 50000,
  renovacao: [{ mes: '2026-05', novas: 300, recebidas: 200 }, { mes: '2026-06', novas: 300, recebidas: 200 }],
  tendenciaPct: 0.11, crescimentoCaixa: 0.32,
};

test('vencido: limiares 5% e 10% da carteira', () => {
  assert.equal(D.diagnosticoSaude({ ...base, vencido: 40000 }).secoes.vencido.nivel, 'verde');   // 4%
  assert.equal(D.diagnosticoSaude({ ...base, vencido: 80000 }).secoes.vencido.nivel, 'amarelo'); // 8%
  assert.equal(D.diagnosticoSaude({ ...base, vencido: 150000 }).secoes.vencido.nivel, 'vermelho'); // 15%
});

test('diferença: positiva=verde, levemente negativa=amarelo, muito negativa=vermelho', () => {
  assert.equal(D.diagnosticoSaude({ ...base, diferenca: 50000 }).secoes.diferenca.nivel, 'verde');
  assert.equal(D.diagnosticoSaude({ ...base, diferenca: -100000 }).secoes.diferenca.nivel, 'amarelo'); // -10%
  assert.equal(D.diagnosticoSaude({ ...base, diferenca: -400000 }).secoes.diferenca.nivel, 'vermelho'); // -40%
});

test('taxa de calote: limiares 5% e 10%', () => {
  assert.equal(D.diagnosticoSaude({ ...base, taxaPerda: 0.037 }).secoes.taxaPerda.nivel, 'verde');
  assert.equal(D.diagnosticoSaude({ ...base, taxaPerda: 0.08 }).secoes.taxaPerda.nivel, 'amarelo');
  assert.equal(D.diagnosticoSaude({ ...base, taxaPerda: 0.15 }).secoes.taxaPerda.nivel, 'vermelho');
});

test('vencido antigo: % parado há +180 dias, limiares 25% e 50%', () => {
  const faixas = (antigo, resto) => [{ faixa: '1–30', valor: resto }, { faixa: '180+', valor: antigo }];
  assert.equal(D.diagnosticoSaude({ ...base, agingFaixas: faixas(10, 90) }).secoes.agingAntigo.nivel, 'verde');   // 10%
  assert.equal(D.diagnosticoSaude({ ...base, agingFaixas: faixas(40, 60) }).secoes.agingAntigo.nivel, 'amarelo'); // 40%
  assert.equal(D.diagnosticoSaude({ ...base, agingFaixas: faixas(70, 30) }).secoes.agingAntigo.nivel, 'vermelho'); // 70%
});

test('vencido antigo: NÃO confunde a faixa "91–180" com a "180+"', () => {
  // as 5 faixas reais: só "180+" (100) conta como antigo, não "91–180" (100). Total 300.
  const faixas = [{ faixa: '1–30', valor: 50 }, { faixa: '31–60', valor: 30 },
    { faixa: '61–90', valor: 20 }, { faixa: '91–180', valor: 50 }, { faixa: '180+', valor: 100 }];
  const r = D.diagnosticoSaude({ ...base, agingFaixas: faixas });
  // só "180+"=100 conta. total 250 → 40% amarelo. Se pegar "91–180"=50 daria 20% (verde) = bug.
  assert.equal(r.secoes.agingAntigo.nivel, 'amarelo');
  assert.ok(/40%/.test(r.secoes.agingAntigo.frase));
});

test('concentração do maior pagador: limiares 10% e 20%', () => {
  assert.equal(D.diagnosticoSaude({ ...base, maiorPagador: 50000 }).secoes.concentracao.nivel, 'verde');   // 5%
  assert.equal(D.diagnosticoSaude({ ...base, maiorPagador: 150000 }).secoes.concentracao.nivel, 'amarelo'); // 15%
  assert.equal(D.diagnosticoSaude({ ...base, maiorPagador: 300000 }).secoes.concentracao.nivel, 'vermelho'); // 30%
});

test('renovação: entra mais que recebe = verde; encolhendo = vermelho', () => {
  const ren = (n, r) => [{ mes: '2026-06', novas: n, recebidas: r }];
  assert.equal(D.diagnosticoSaude({ ...base, renovacao: ren(300, 200) }).secoes.renovacao.nivel, 'verde');    // 1.5x
  assert.equal(D.diagnosticoSaude({ ...base, renovacao: ren(180, 200) }).secoes.renovacao.nivel, 'amarelo');  // 0.9x
  assert.equal(D.diagnosticoSaude({ ...base, renovacao: ren(100, 200) }).secoes.renovacao.nivel, 'vermelho'); // 0.5x
});

test('tendência e crescimento nulos são omitidos (sem meses/projeção)', () => {
  const r = D.diagnosticoSaude({ ...base, tendenciaPct: null, crescimentoCaixa: null });
  assert.equal(r.secoes.tendencia, undefined);
  assert.equal(r.secoes.crescimento, undefined);
});

test('resumo conta os níveis e lista prioridades com vermelho antes do amarelo', () => {
  const r = D.diagnosticoSaude({ ...base, vencido: 150000, diferenca: -100000 }); // vencido vermelho, diferença amarela
  assert.equal(r.resumo.vermelhos, 1);
  assert.equal(r.resumo.amarelos, 1);
  assert.ok(r.resumo.verdes >= 4);
  assert.equal(r.resumo.prioridades[0].chave, 'vencido');     // vermelho primeiro
  assert.equal(r.resumo.prioridades[1].chave, 'diferenca');   // depois amarelo
  assert.ok(r.resumo.prioridades[0].acao.length > 0);
});

test('cada seção traz título e frase preenchidos', () => {
  const r = D.diagnosticoSaude(base);
  for (const s of Object.values(r.secoes)) {
    assert.ok(s.titulo && s.titulo.length > 0);
    assert.ok(s.frase && s.frase.length > 0);
    assert.ok(['verde', 'amarelo', 'vermelho'].includes(s.nivel));
  }
});
