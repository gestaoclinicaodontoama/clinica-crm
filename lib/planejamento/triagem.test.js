// lib/planejamento/triagem.test.js
const test = require('node:test');
const assert = require('node:assert');
const { agruparItens, requerPlano, heuristicaDuplicata, tipoPagamento } = require('./triagem');

test('agruparItens: N linhas do mesmo PriceId viram quantidade N', () => {
  const lista = [
    { PriceId: 10, ProcedureName: 'Faceta', Executed: '' },
    { PriceId: 10, ProcedureName: 'Faceta', Executed: '' },
    { PriceId: 10, ProcedureName: 'Faceta', Executed: 'X' },
    { PriceId: 22, ProcedureName: 'Clareamento', Executed: '' },
  ];
  const r = agruparItens(lista);
  assert.equal(r.length, 2);
  const faceta = r.find(i => i.price_id === '10');
  assert.equal(faceta.quantidade, 3);
  assert.equal(faceta.executados, 1);
});

test('agruparItens: lista vazia/nula → []', () => {
  assert.deepEqual(agruparItens(null), []);
  assert.deepEqual(agruparItens([]), []);
});

test('requerPlano: false só quando TODOS os itens dispensam', () => {
  const padroes = new Map([['10', { requer_plano: false }], ['22', { requer_plano: true }]]);
  assert.equal(requerPlano([{ price_id: '10' }], padroes), false);
  assert.equal(requerPlano([{ price_id: '10' }, { price_id: '22' }], padroes), true);
  // item SEM padrão cadastrado → requer plano (default conservador da spec)
  assert.equal(requerPlano([{ price_id: '99' }], padroes), true);
});

test('heuristicaDuplicata: mesmo paciente + item em comum + janela 30d → suspeito', () => {
  const orc = { clinicorp_estimate_id: 'B', paciente_clinicorp_id: 'P1', data_fechamento: '2026-07-10',
                itens: [{ price_id: '10' }] };
  const outros = [
    { clinicorp_estimate_id: 'A', paciente_clinicorp_id: 'P1', data_fechamento: '2026-06-25',
      itens: [{ price_id: '10' }, { price_id: '22' }] },
  ];
  const r = heuristicaDuplicata(orc, outros);
  assert.equal(r.suspeito, true);
  assert.equal(r.de, 'A');
});

test('heuristicaDuplicata: fora da janela OU sem item em comum OU outro paciente → não suspeito', () => {
  const orc = { clinicorp_estimate_id: 'B', paciente_clinicorp_id: 'P1', data_fechamento: '2026-07-10', itens: [{ price_id: '10' }] };
  assert.equal(heuristicaDuplicata(orc, [{ clinicorp_estimate_id: 'A', paciente_clinicorp_id: 'P1', data_fechamento: '2026-01-01', itens: [{ price_id: '10' }] }]).suspeito, false);
  assert.equal(heuristicaDuplicata(orc, [{ clinicorp_estimate_id: 'A', paciente_clinicorp_id: 'P1', data_fechamento: '2026-07-01', itens: [{ price_id: '22' }] }]).suspeito, false);
  assert.equal(heuristicaDuplicata(orc, [{ clinicorp_estimate_id: 'A', paciente_clinicorp_id: 'P2', data_fechamento: '2026-07-01', itens: [{ price_id: '10' }] }]).suspeito, false);
  // não compara consigo mesmo
  assert.equal(heuristicaDuplicata(orc, [orc]).suspeito, false);
});

test('tipoPagamento: particular puro (valor 1000, valor_particular 1000 → "particular")', () => {
  const r = tipoPagamento({ valor: 1000, valor_particular: 1000 });
  assert.equal(r, 'particular');
});

test('tipoPagamento: convênio puro (valor 500, valor_particular 0 → "convenio")', () => {
  const r = tipoPagamento({ valor: 500, valor_particular: 0 });
  assert.equal(r, 'convenio');
});

test('tipoPagamento: misto (valor 1000, valor_particular 600 → "misto")', () => {
  const r = tipoPagamento({ valor: 1000, valor_particular: 600 });
  assert.equal(r, 'misto');
});

test('tipoPagamento: valor null/0/undefined → null', () => {
  assert.equal(tipoPagamento(null), null);
  assert.equal(tipoPagamento({}), null);
  assert.equal(tipoPagamento({ valor: 0 }), null);
  assert.equal(tipoPagamento({ valor: -100 }), null);
});
