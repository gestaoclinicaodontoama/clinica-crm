// lib/funil/orcamento.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { classificarOrcamento } = require('./orcamento');

test('soma só procedimentos particulares (ignora CLAIM/convênio)', () => {
  const o = { Amount: 1000, ProcedureList: [
    { FinalAmount: 800, BillType: 'PRIVATE' },
    { FinalAmount: 200, BillType: 'CLAIM', ClaimNumber: '123' },
  ]};
  const r = classificarOrcamento(o);
  assert.strictEqual(r.valorParticular, 800);
  assert.strictEqual(r.ehConvenio, false);
});

test('orçamento 100% convênio: valorParticular 0 e ehConvenio true', () => {
  const o = { Amount: 200, ProcedureList: [ { FinalAmount: 200, BillType: 'CLAIM', ClaimNumber: '9' } ] };
  const r = classificarOrcamento(o);
  assert.strictEqual(r.valorParticular, 0);
  assert.strictEqual(r.ehConvenio, true);
});

test('sem ProcedureList: usa Amount como particular (fallback)', () => {
  const o = { Amount: 500, ProcedureList: [] };
  const r = classificarOrcamento(o);
  assert.strictEqual(r.valorParticular, 500);
  assert.strictEqual(r.ehConvenio, false);
});
