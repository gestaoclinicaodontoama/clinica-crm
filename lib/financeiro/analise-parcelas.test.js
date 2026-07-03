const { test } = require('node:test');
const assert = require('node:assert');
const { agingVencido, taxaPerda, novasERecebidasPorMes, carteiraRetroativa, topPagadores } =
  require('./analise-parcelas');

// hoje fixo p/ todos os testes
const HOJE = '2026-07-02';

test('agingVencido: só não-recebidas vencidas, nas faixas certas', () => {
  const items = [
    { DueDate: '2026-06-20', Amount: 100 },                          // 12d → 1–30
    { DueDate: '2026-05-10', Amount: 200 },                          // 53d → 31–60
    { DueDate: '2026-04-10', Amount: 300 },                          // 83d → 61–90
    { DueDate: '2026-02-01', Amount: 400 },                          // 151d → 91–180
    { DueDate: '2025-01-01', Amount: 500 },                          // 547d → 180+
    { DueDate: '2026-06-20', Amount: 999, PaymentReceived: 'X' },    // recebida — fora
    { DueDate: '2026-08-01', Amount: 999 },                          // futura — fora
  ];
  const r = agingVencido(items, HOJE);
  assert.deepEqual(r.faixas.map(f => f.valor), [100, 200, 300, 400, 500]);
  assert.equal(r.total, 1500);
  assert.deepEqual(r.faixas.map(f => f.faixa), ['1–30', '31–60', '61–90', '91–180', '180+']);
});

test('taxaPerda: parcelas maduras (vencidas há 180+ dias) nunca recebidas / total delas', () => {
  const items = [
    { DueDate: '2025-06-01', Amount: 300 },                              // madura, perdida
    { DueDate: '2025-06-01', Amount: 700, ReceivedDate: '2025-09-01' },  // madura, recebida (atrasada)
    { DueDate: '2026-06-01', Amount: 999 },                              // recente — fora da base
  ];
  const r = taxaPerda(items, HOJE);
  assert.equal(r.base, 1000);
  assert.equal(r.perdido, 300);
  assert.equal(r.taxa, 0.3);
});

test('taxaPerda: base vazia → taxa 0', () => {
  assert.deepEqual(taxaPerda([], HOJE), { taxa: 0, base: 0, perdido: 0 });
});

test('novasERecebidasPorMes: novas por PostDate, recebidas por ReceivedDate, últimos N meses', () => {
  const items = [
    { PostDate: '2026-06-10T12:00:00.000Z', Amount: 100 },
    { PostDate: '2026-06-20', Amount: 50 },
    { PostDate: '2026-05-01', Amount: 30, ReceivedDate: '2026-06-15' },
    { PostDate: '2024-01-01', Amount: 999 },   // fora da janela de novas
  ];
  const r = novasERecebidasPorMes(items, HOJE, 3);
  assert.deepEqual(r.map(x => x.mes), ['2026-05', '2026-06', '2026-07']);
  assert.equal(r[1].novas, 150);
  assert.equal(r[1].recebidas, 30);
  assert.equal(r[0].novas, 30);
  assert.equal(r[2].novas, 0);
});

test('carteiraRetroativa: parcelas lançadas e ainda a vencer/não recebidas no fim de cada mês', () => {
  const items = [
    // lançada em jan, vence em mai, recebida em jun: conta na carteira de jan–abr (due>X, received>X)
    { PostDate: '2026-01-10', DueDate: '2026-05-10', Amount: 100, ReceivedDate: '2026-06-05' },
    // lançada em mar, vence em ago, nunca recebida: conta de mar em diante
    { PostDate: '2026-03-15', DueDate: '2026-08-15', Amount: 200 },
  ];
  const r = carteiraRetroativa(items, HOJE, 6); // jan..jun/2026
  assert.deepEqual(r.map(x => x.mes), ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
  assert.equal(r[0].receber, 100);  // fim de jan: só a 1ª
  assert.equal(r[2].receber, 300);  // fim de mar: as duas
  assert.equal(r[3].receber, 300);  // fim de abr: as duas ainda a vencer
  assert.equal(r[4].receber, 200);  // fim de mai: 1ª venceu (foi p/ "vencido", sai da carteira a vencer)
  assert.equal(r[5].receber, 200);  // fim de jun: 1ª recebida; 2ª segue
});

test('topPagadores: soma o futuro por pagador e ordena', () => {
  const items = [
    { PatientId: 1, PayerName: 'Ana', DueDate: '2026-08-01', Amount: 500 },
    { PatientId: 1, PayerName: 'Ana', DueDate: '2026-09-01', Amount: 300 },
    { PatientId: 2, PayerName: 'Beto', DueDate: '2026-08-01', Amount: 600 },
    { PatientId: 3, PayerName: 'Caio', DueDate: '2026-06-01', Amount: 999 },  // vencida — fora
    { PatientId: 2, PayerName: 'Beto', DueDate: '2026-08-02', Amount: 100, PaymentReceived: 'X' }, // recebida — fora
  ];
  const r = topPagadores(items, HOJE, 2);
  assert.deepEqual(r, [
    { nome: 'Ana', valor: 800 },
    { nome: 'Beto', valor: 600 },
  ]);
});
