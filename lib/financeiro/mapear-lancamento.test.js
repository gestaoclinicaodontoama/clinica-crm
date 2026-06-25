const { test } = require('node:test');
const assert = require('node:assert');
const { mapear } = require('./mapear-lancamento');

const despesa = { id: '5671', PostType: 'EXPENSES', EntryType: 'ACCOUNTS_PAYMENT',
  Description: 'Pagamento de Conta: Salários - AMA', Amount: 26047.0, PostDate: '2026-05-03T05:25:24.934Z' };
const convenio = { id: '99', PostType: 'RECEIVED', EntryType: 'INSURANCE_PLAN_CLAIM',
  Description: 'Reconciliação Plano', Amount: 100.5, PostDate: '2026-05-10T13:00:00Z', RelatedPersonId: 7 };
const pix = { id: '100', PostType: 'RECEIVED', EntryType: '',
  Description: 'Confirmação Pix', Amount: 50.0, PostDate: '2026-05-10T13:00:00Z', RelatedPersonId: 8 };

test('despesa vira fluxo sai, valor positivo, empresa AMA', () => {
  const m = mapear(despesa);
  assert.equal(m.fluxo, 'sai'); assert.equal(m.valor, 26047.0);
  assert.equal(m.empresa, 'AMA'); assert.equal(m.clinicorp_id, '5671');
  assert.equal(m.data, '2026-05-03');
});

test('convênio: fluxo entra, forma_pgto convenio', () => {
  const m = mapear(convenio);
  assert.equal(m.fluxo, 'entra'); assert.equal(m.forma_pgto, 'convenio');
  assert.equal(m.paciente_id, '7');
});

test('pix particular: forma_pgto pix', () => {
  assert.equal(mapear(pix).forma_pgto, 'pix');
});

test('Amount negativo inverte fluxo e vira positivo', () => {
  const m = mapear({ ...despesa, Amount: -10 });
  assert.equal(m.valor, 10); assert.equal(m.fluxo, 'entra');
});

test('REVENUE: paciente_id vem de PersonId quando PersonType=PATIENT', () => {
  const revenue = { id: '200', PostType: 'REVENUE', EntryType: 'INSURANCE_PLAN_CLAIM',
    Description: 'Lançamento de Tratamento', Amount: 50.55, Date: '2024-04-19T16:24:01.000Z',
    PersonId: 5892307496337408, PersonType: 'PATIENT', RelatedPersonId: -1 };
  const m = mapear(revenue);
  assert.equal(m.paciente_id, '5892307496337408');
  assert.equal(m.post_type, 'REVENUE');
});

test('RECEIVED continua usando RelatedPersonId', () => {
  const m = mapear({ id: '99', PostType: 'RECEIVED', EntryType: 'INSURANCE_PLAN_CLAIM',
    Description: 'Reconciliação Plano', Amount: 100.5, PostDate: '2026-05-10T13:00:00Z', RelatedPersonId: 7 });
  assert.equal(m.paciente_id, '7');
});
