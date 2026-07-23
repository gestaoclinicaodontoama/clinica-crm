'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { prepararNota } = require('./notas');
const { PADROES_SEED } = require('./categoria');

function notaBase(over = {}) {
  return {
    laboratorio: 'LAPROTEC',
    referencia: 'Nota 686',
    emitida_em: '2026-02-04',
    total_informado: 525,
    origem: 'import',
    itens: [
      { paciente_nome: 'EDUARDO DE FARIA CASTRO', dentista_nome: 'Dr. Joaquim', descricao_original: 'PLACA BRUXISMO', quantidade: 1, valor_total: 215, data_entrada: '2025-12-16', data_entrega: '2026-01-14' },
      { paciente_nome: 'JOSE LOURIVAL', dentista_nome: null, descricao_original: 'PT IMEDIATA SUPERIOR', quantidade: 1, valor_total: 310, data_entrada: '2026-01-05', data_entrega: '2026-01-26' },
    ],
    ...over,
  };
}

test('nota válida: categorias derivadas, sem avisos quando total bate', () => {
  const { nota, itens, avisos } = prepararNota({ ...notaBase(), padroes: PADROES_SEED });
  assert.strictEqual(nota.laboratorio, 'LAPROTEC');
  assert.strictEqual(itens[0].categoria, 'Placa de bruxismo');
  assert.strictEqual(itens[1].categoria, 'Prótese total');
  assert.strictEqual(itens[0].reparo, false);
  assert.deepStrictEqual(avisos, []);
});

test('atrasado: true quando entrega > prevista, false quando <=, null sem prevista', () => {
  const n = notaBase({ total_informado: null, itens: [
    { paciente_nome: 'A', descricao_original: 'CMC AMA', quantidade: 1, valor_total: 297, data_prevista: '2026-02-20', data_entrega: '2026-03-09' },
    { paciente_nome: 'B', descricao_original: 'CMC AMA', quantidade: 1, valor_total: 297, data_prevista: '2026-04-02', data_entrega: '2026-03-30' },
    { paciente_nome: 'C', descricao_original: 'CMC AMA', quantidade: 1, valor_total: 297, data_entrega: '2026-03-30' },
  ] });
  const { itens } = prepararNota({ ...n, padroes: PADROES_SEED });
  assert.strictEqual(itens[0].atrasado, true);
  assert.strictEqual(itens[1].atrasado, false);
  assert.strictEqual(itens[2].atrasado, null);
});

test('reparo derivado da categoria; divergência de total vira aviso, não erro', () => {
  const n = notaBase({ total_informado: 1000, itens: [
    { paciente_nome: 'X', descricao_original: 'Zirconia - Reparo', quantidade: 3, valor_total: 0 },
  ] });
  const { itens, avisos } = prepararNota({ ...n, padroes: PADROES_SEED });
  assert.strictEqual(itens[0].reparo, true);
  assert.strictEqual(avisos.length, 1);
  assert.match(avisos[0], /diverge/i);
});

test('payloads inválidos dão erro 400 com mensagem pt-BR', () => {
  const casos = [
    [{ ...notaBase(), laboratorio: '' }, /laborat/i],
    [{ ...notaBase(), referencia: '  ' }, /refer/i],
    [{ ...notaBase(), itens: [{ descricao_original: 'X', quantidade: 1, valor_total: 10 }] }, /paciente/i],
    [{ ...notaBase(), itens: [{ paciente_nome: 'A', quantidade: 1, valor_total: 10 }] }, /descri/i],
    [{ ...notaBase(), itens: [{ paciente_nome: 'A', descricao_original: 'X', quantidade: 1, valor_total: 'abc' }] }, /valor/i],
    [{ ...notaBase(), itens: [{ paciente_nome: 'A', descricao_original: 'X', quantidade: 0, valor_total: 10 }] }, /quantidade/i],
    [{ ...notaBase(), itens: [{ paciente_nome: 'A', descricao_original: 'X', quantidade: 1, valor_total: 10, data_entrada: '16/12/2025' }] }, /data/i],
    [{ ...notaBase(), itens: [] }, /item/i],
  ];
  for (const [payload, re] of casos) {
    assert.throws(() => prepararNota({ ...payload, padroes: PADROES_SEED }), (err) => {
      assert.strictEqual(err.status, 400, JSON.stringify(payload).slice(0, 80));
      assert.match(err.message, re);
      return true;
    });
  }
});

test('datas nulas ok (caderno manuscrito) e valores com string numérica aceitos', () => {
  const n = notaBase({ total_informado: null, itens: [
    { paciente_nome: 'Sueli Costa', descricao_original: '01 c/EMAX 45', quantidade: 1, valor_total: '430.10', conferir: true },
  ] });
  const { itens } = prepararNota({ ...n, padroes: PADROES_SEED });
  assert.strictEqual(itens[0].valor_total, 430.10);
  assert.strictEqual(itens[0].conferir, true);
  assert.strictEqual(itens[0].atrasado, null);
});
