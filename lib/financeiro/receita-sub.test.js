const { test } = require('node:test');
const assert = require('node:assert');
const { marcarEntradaParcelas } = require('./receita-sub');

// Recebe TODA a receita particular do paciente (histórico completo), ordena por data.
test('primeiro pagamento do paciente = entrada; resto = parcelas', () => {
  const lancs = [
    { paciente_id: '1', data: '2026-02-10', valor: 500, forma_pgto: 'pix' },
    { paciente_id: '1', data: '2026-01-05', valor: 1000, forma_pgto: 'pix' }, // mais antigo
    { paciente_id: '1', data: '2026-03-10', valor: 500, forma_pgto: 'boleto' },
    { paciente_id: '2', data: '2026-02-01', valor: 200, forma_pgto: 'pix' },
  ];
  const out = marcarEntradaParcelas(lancs);
  const p1 = out.filter(l => l.paciente_id === '1').sort((a,b)=>a.data.localeCompare(b.data));
  assert.equal(p1[0].receita_sub, 'entrada');   // 05/01
  assert.equal(p1[1].receita_sub, 'parcelas');  // 10/02
  assert.equal(p1[2].receita_sub, 'parcelas');  // 10/03
  assert.equal(out.find(l => l.paciente_id === '2').receita_sub, 'entrada');
});

test('sem paciente_id → receita_sub null', () => {
  const out = marcarEntradaParcelas([{ paciente_id: null, data: '2026-01-01', valor: 10 }]);
  assert.equal(out[0].receita_sub, null);
});
