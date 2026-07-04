const { test } = require('node:test');
const assert = require('node:assert');
const P = require('../../public/js/financeiro/projecao-crescimento.js');

// Constrói histórico de N meses a partir de 'YYYY-MM', mesmo valor por métrica.
function hist(inicioYm, valores) {
  // valores = [{ faturamento, caixa, saidas }, ...] um por mês
  let [y, m] = inicioYm.split('-').map(Number);
  return valores.map(v => {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    m++; if (m > 12) { m = 1; y++; }
    return { ym, ...v };
  });
}
const rep = (n, v) => Array.from({ length: n }, () => ({ ...v }));

test('crescimento medido: ano-a-ano dos 12 meses recentes vs os 12 anteriores', () => {
  // 12 meses a 100, depois 12 meses a 120 → +20% de caixa
  const h = hist('2024-01', [...rep(12, { faturamento: 200, caixa: 100, saidas: 90 }),
                             ...rep(12, { faturamento: 240, caixa: 120, saidas: 99 })]);
  const r = P.projecaoCrescimento(h);
  assert.ok(Math.abs(r.gCaixa - 0.2) < 1e-9);
  assert.ok(Math.abs(r.gFaturamento - 0.2) < 1e-9);
  assert.ok(Math.abs(r.gSaidas - 0.1) < 1e-9);
});

test('provável: cada mês futuro = mesmo mês do ano anterior × (1 + crescimento)', () => {
  const h = hist('2024-01', [...rep(12, { faturamento: 200, caixa: 100, saidas: 90 }),
                             ...rep(12, { faturamento: 240, caixa: 120, saidas: 99 })]);
  const r = P.projecaoCrescimento(h);
  const jan27 = r.projecao.provavel.caixa.find(p => p.ym === '2026-01');
  // baseline jan/2025 = 120; g ano1 = 0.2 → 120 × 1.2 = 144
  assert.ok(Math.abs(jan27.val - 144) < 1e-6);
});

test('provável ano 2: compõe sobre a projeção do ano 1, com desaceleração (×0.6)', () => {
  const h = hist('2024-01', [...rep(12, { faturamento: 200, caixa: 100, saidas: 90 }),
                             ...rep(12, { faturamento: 240, caixa: 120, saidas: 99 })]);
  const r = P.projecaoCrescimento(h);
  const jan28 = r.projecao.provavel.caixa.find(p => p.ym === '2027-01');
  // baseline = projeção jan/2026 = 144; g ano2 = 0.2 × 0.6 = 0.12 → 144 × 1.12 = 161.28
  assert.ok(Math.abs(jan28.val - 161.28) < 1e-6);
});

test('três cenários divergem: conservador < provável < otimista', () => {
  const h = hist('2024-01', [...rep(12, { faturamento: 200, caixa: 100, saidas: 90 }),
                             ...rep(12, { faturamento: 240, caixa: 120, saidas: 99 })]);
  const r = P.projecaoCrescimento(h);
  const val = (cen) => r.projecao[cen].caixa.find(p => p.ym === '2026-01').val;
  assert.ok(Math.abs(val('conservador') - 132) < 1e-6);  // 120 × (1 + 0.2×0.5)
  assert.ok(Math.abs(val('provavel') - 144) < 1e-6);      // 120 × (1 + 0.2×1.0)
  assert.ok(Math.abs(val('otimista') - 148.8) < 1e-6);    // 120 × (1 + 0.2×1.2)
  assert.ok(val('conservador') < val('provavel') && val('provavel') < val('otimista'));
});

test('lucro projetado = caixa projetado − saídas projetadas', () => {
  const h = hist('2024-01', [...rep(12, { faturamento: 200, caixa: 100, saidas: 90 }),
                             ...rep(12, { faturamento: 240, caixa: 120, saidas: 99 })]);
  const r = P.projecaoCrescimento(h);
  const caixa = r.projecao.provavel.caixa.find(p => p.ym === '2026-01').val;
  const saidas = r.projecao.provavel.saidas.find(p => p.ym === '2026-01').val;
  const lucro = r.projecao.provavel.lucro.find(p => p.ym === '2026-01').val;
  assert.ok(Math.abs(lucro - (caixa - saidas)) < 1e-6);
});

test('sazonalidade preservada: mês forte projeta forte', () => {
  // dezembro dobra; resto = 100. recente = mesma forma × 1.0 (sem crescimento)
  const padrao = (mult) => Array.from({ length: 12 }, (_, i) =>
    ({ faturamento: 0, caixa: (i === 11 ? 200 : 100) * mult, saidas: 0 }));
  const h = hist('2024-01', [...padrao(1), ...padrao(1)]);
  const r = P.projecaoCrescimento(h);
  const dez = r.projecao.provavel.caixa.find(p => p.ym === '2026-12').val;
  const jul = r.projecao.provavel.caixa.find(p => p.ym === '2026-07').val;
  assert.ok(Math.abs(dez - 2 * jul) < 1e-6); // dezembro segue o dobro de julho
});

test('resumo: soma dos próximos 12 e 24 meses por cenário', () => {
  const h = hist('2024-01', [...rep(12, { faturamento: 200, caixa: 100, saidas: 90 }),
                             ...rep(12, { faturamento: 240, caixa: 120, saidas: 99 })]);
  const r = P.projecaoCrescimento(h);
  // provável ano1: todo mês = 120 × 1.2 = 144 → 12 meses = 1728
  assert.ok(Math.abs(r.resumo.provavel.caixa.m12 - 1728) < 1e-6);
  assert.equal(r.projecao.provavel.caixa.length, 24);
  assert.ok(r.resumo.provavel.caixa.m24 > r.resumo.provavel.caixa.m12);
});

test('histórico insuficiente (<24 meses) devolve erro, não projeção', () => {
  const h = hist('2025-01', rep(12, { faturamento: 200, caixa: 100, saidas: 90 }));
  const r = P.projecaoCrescimento(h);
  assert.ok(r.erro);
  assert.equal(r.projecao, undefined);
});

test('horizonte configurável', () => {
  const h = hist('2024-01', [...rep(12, { faturamento: 200, caixa: 100, saidas: 90 }),
                             ...rep(12, { faturamento: 240, caixa: 120, saidas: 99 })]);
  const r = P.projecaoCrescimento(h, { horizonte: 6 });
  assert.equal(r.projecao.provavel.caixa.length, 6);
});
