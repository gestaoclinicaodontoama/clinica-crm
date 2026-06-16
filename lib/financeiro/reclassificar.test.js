const { test } = require('node:test');
const assert = require('node:assert');
const { alvosDaRegra } = require('./reclassificar');

test('alvosDaRegra acha lançamentos compatíveis sem override', () => {
  const lancs = [
    { id: 1, descricao: 'Pagamento de Conta: Pagamento Amanda - MAR', override_manual: false },
    { id: 2, descricao: 'Pagamento de Conta: Pagamento Amanda - PF', override_manual: false },
    { id: 3, descricao: 'Pagamento de Conta: Pagamento Amanda - AMA', override_manual: true },
  ];
  const ids = alvosDaRegra(lancs, { metodo: 'pessoa', padrao: 'Amanda' }).map(l => l.id);
  assert.deepEqual(ids, [1, 2]); // exclui o override
});
