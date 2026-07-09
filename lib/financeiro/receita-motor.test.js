const { test } = require('node:test');
const assert = require('node:assert');
const M = require('./receita-motor');

const HOJE = '2026-07-08';

test('decomposicao12m: entrada = parcela 0, recorrente = 1+, cancelada fora, sem nº → recorrente', () => {
  const items = [
    { InstallmentNumber: 0, ReceivedDate: '2026-06-10', Amount: 100 },
    { InstallmentNumber: 1, ReceivedDate: '2026-06-15T03:00:00Z', Amount: 50 },
    { InstallmentNumber: 2, ReceivedDate: '2026-06-20', Amount: 25, Canceled: 'X' }, // fora
    { ReceivedDate: '2026-06-21', Amount: 7 },                    // sem nº → recorrente
    { InstallmentNumber: 0, DueDate: '2026-06-05', Amount: 999 }, // não recebida — fora
    { InstallmentNumber: 0, ReceivedDate: '2026-07-01', Amount: 30 },
  ];
  const r = M.decomposicao12m(items, HOJE, 3);
  assert.deepEqual(r.map(x => x.mes), ['2026-05', '2026-06', '2026-07']);
  assert.deepEqual(r[1], { mes: '2026-06', entrada: 100, recorrente: 57 });
  assert.deepEqual(r[2], { mes: '2026-07', entrada: 30, recorrente: 0 });
});

test('taxaRealizacao: só parcelas 1+ de meses fechados; pagou no próprio mês = realizada', () => {
  const items = [
    { InstallmentNumber: 1, DueDate: '2026-06-10', ReceivedDate: '2026-06-12', Amount: 80, PaymentForm: 'Boleto' },  // realizada
    { InstallmentNumber: 2, DueDate: '2026-06-10', ReceivedDate: '2026-07-02', Amount: 20, PaymentForm: 'Boleto' },  // atrasada → não realizada
    { InstallmentNumber: 3, DueDate: '2026-05-10', Amount: 100, PaymentForm: 'Cartão de Crédito' },                  // nunca paga
    { InstallmentNumber: 0, DueDate: '2026-06-10', ReceivedDate: '2026-06-10', Amount: 999 },                        // entrada — fora
    { InstallmentNumber: 1, DueDate: '2026-07-05', ReceivedDate: '2026-07-06', Amount: 999 },                        // mês corrente — fora
  ];
  const r = M.taxaRealizacao(items, HOJE, 6);
  assert.equal(r.geral.base, 200);
  assert.equal(r.geral.realizado, 80);
  assert.equal(r.geral.taxa, 0.4);
  assert.equal(r['Boleto'].taxa, 0.8);
  assert.equal(r['Cartão de Crédito'].taxa, 0);
  assert.equal(r.outras.taxa, null);
});

test('realizacaoPorMes: fração por forma, mês sem base → null', () => {
  const items = [
    { InstallmentNumber: 1, DueDate: '2026-06-10', ReceivedDate: '2026-06-12', Amount: 75, PaymentForm: 'Boleto' },
    { InstallmentNumber: 2, DueDate: '2026-06-15', Amount: 25, PaymentForm: 'Boleto' },
  ];
  const r = M.realizacaoPorMes(items, HOJE, 2);
  assert.deepEqual(r.map(x => x.mes), ['2026-05', '2026-06']);
  assert.equal(r[1].boleto, 0.75);
  assert.equal(r[1].cartao, null);
  assert.equal(r[0].boleto, null);
});

test('mesCorrente: previsto = a vencer no mês × taxa da forma; recebidos separados', () => {
  const realizacao = { geral: { taxa: 0.5 }, 'Boleto': { taxa: 0.8 },
    'Cartão de Crédito': { taxa: null }, outras: { taxa: null } };
  const items = [
    { InstallmentNumber: 1, DueDate: '2026-07-20', Amount: 100, PaymentForm: 'Boleto' },       // 100×0.8
    { InstallmentNumber: 2, DueDate: '2026-07-25', Amount: 100, PaymentForm: 'Pix' },          // outras null → geral 0.5
    { InstallmentNumber: 1, DueDate: '2026-07-05', ReceivedDate: '2026-07-05', Amount: 40, PaymentForm: 'Boleto' }, // vencida no mês E recebida: cru + recebido
    { InstallmentNumber: 0, ReceivedDate: '2026-07-03', Amount: 70 },                          // entrada recebida
    { InstallmentNumber: 1, DueDate: '2026-08-10', Amount: 999 },                              // mês seguinte — fora
    { InstallmentNumber: 1, DueDate: '2026-07-10', Amount: 999, Canceled: 'X' },               // cancelada — fora
  ];
  const r = M.mesCorrente(items, HOJE, realizacao);
  assert.equal(r.recorrenteCru, 240);                 // 100+100+40
  assert.equal(r.recorrentePrevisto, 100 * 0.8 + 100 * 0.5 + 40 * 0.8);
  assert.equal(r.recorrenteRecebido, 40);
  assert.equal(r.entradaRecebida, 70);
});

test('colchao: só parcelas 1+ futuras não recebidas, a partir do mês seguinte, × taxa', () => {
  const items = [
    { InstallmentNumber: 1, DueDate: '2026-08-10', Amount: 200 },
    { InstallmentNumber: 2, DueDate: '2026-09-10', Amount: 200 },
    { InstallmentNumber: 3, DueDate: '2026-10-10', Amount: 50 },
    { InstallmentNumber: 0, DueDate: '2026-08-15', Amount: 999 },                              // entrada futura — fora
    { InstallmentNumber: 1, DueDate: '2026-08-20', ReceivedDate: '2026-07-01', Amount: 999 },  // já recebida — fora
    { InstallmentNumber: 1, DueDate: '2026-07-20', Amount: 999 },                              // mês corrente — fora
  ];
  const r = M.colchao(items, HOJE, 0.5, 90, 3);
  assert.deepEqual(r.meses, [
    { mes: '2026-08', cru: 200, previsto: 100 },
    { mes: '2026-09', cru: 200, previsto: 100 },
    { mes: '2026-10', cru: 50, previsto: 25 },
  ]);
  assert.equal(r.mesesCobertos, 2);                   // ago e set ≥ 90; out não
});

test('colchao: sem régua → mesesCobertos null', () => {
  assert.equal(M.colchao([], HOJE, 0.5, null, 2).mesesCobertos, null);
});

test('rumoAoDegrau: série crescente cruza a régua na data certa', () => {
  // recorrente fechado: 100, 110, ..., 150 (6 meses, +10/mês); corrente = 2026-07 (fora)
  const dec = [
    { mes: '2026-01', recorrente: 100, entrada: 0 }, { mes: '2026-02', recorrente: 110, entrada: 0 },
    { mes: '2026-03', recorrente: 120, entrada: 0 }, { mes: '2026-04', recorrente: 130, entrada: 0 },
    { mes: '2026-05', recorrente: 140, entrada: 0 }, { mes: '2026-06', recorrente: 150, entrada: 0 },
    { mes: '2026-07', recorrente: 5, entrada: 0 },
  ];
  const r = M.rumoAoDegrau(dec, HOJE, { fixas: 130, saidaTotal: 200 });
  assert.equal(r.fixas.status, 'cruzou');            // média últimos 3 = 140 ≥ 130
  assert.equal(r.total.status, 'a_caminho');         // reta 100+10x cruza 200 em x=10 → 5 meses após jun
  assert.equal(r.total.meses, 5);
  assert.equal(r.total.mesAlvo, '2026-11');
});

test('rumoAoDegrau: inclinação ≤ 0 abaixo da régua → nao_cruza; régua nula → null', () => {
  const dec = [
    { mes: '2026-04', recorrente: 100, entrada: 0 }, { mes: '2026-05', recorrente: 90, entrada: 0 },
    { mes: '2026-06', recorrente: 80, entrada: 0 },
  ];
  const r = M.rumoAoDegrau(dec, HOJE, { fixas: 500, saidaTotal: null });
  assert.equal(r.fixas.status, 'nao_cruza');
  assert.equal(r.total, null);
});

test('razaoEntradaVenda: Σ entrada ÷ Σ vendas nos meses fechados', () => {
  const dec = [
    { mes: '2026-05', entrada: 100, recorrente: 0 }, { mes: '2026-06', entrada: 200, recorrente: 0 },
    { mes: '2026-07', entrada: 999, recorrente: 0 },  // corrente — fora
  ];
  const vendas = [{ mes: '2026-05', vendas: 400 }, { mes: '2026-06', vendas: 600 }, { mes: '2026-07', vendas: 999 }];
  const r = M.razaoEntradaVenda(dec, vendas, HOJE, 6);
  assert.equal(r.razao, 0.3);                        // 300 / 1000
  assert.equal(M.razaoEntradaVenda(dec, [], HOJE).razao, null);
});

test('calculadoraMes: réplica da planilha do Luiz (400k/15%/193,5k líq/280k)', () => {
  const r = M.calculadoraMes({ metaFaturamento: 400000, lucroPct: 0.15,
    recebiveisLiquidos: 193500, contasAPagar: 280000,
    entradaRecebida: 0, razaoHistorica: 0.303, ticket: 9000 });
  assert.equal(r.breakEven.entrada, 86500);
  assert.equal(r.breakEven.pctFat, 0.216);                       // 21,63% na planilha
  assert.ok(Math.abs(r.comLucro.fluxoNecessario - 329411.76) < 0.01);
  assert.ok(Math.abs(r.comLucro.lucroProjetado - 49411.76) < 0.01);
  assert.ok(Math.abs(r.comLucro.entrada - 135911.76) < 0.01);
  assert.equal(r.comLucro.pctFat, 0.34);                          // 33,98% na planilha
  assert.equal(r.viabilidade.status, 'apertado');                 // 0,34 > 1,1×0,303
  assert.equal(r.progresso.alvo, r.comLucro.entrada);
  assert.equal(r.progresso.fechamentos, Math.ceil(135911.76 / 0.303 / 9000));
});

test('calculadoraMes: lucro em R$, viabilidade justa/confortável, batida, erros', () => {
  const base = { recebiveisLiquidos: 100, contasAPagar: 200, entradaRecebida: 0,
    razaoHistorica: 0.5, ticket: 10 };
  const r = M.calculadoraMes({ ...base, metaFaturamento: 1000, lucroReais: 50 });
  assert.equal(r.comLucro.entrada, 150);                          // 200+50−100
  assert.equal(r.comLucro.pctFat, 0.15);
  assert.equal(r.viabilidade.status, 'confortavel');              // 0,15 ≤ 0,9×0,5
  const j = M.calculadoraMes({ ...base, metaFaturamento: 300, lucroReais: 50 });
  assert.equal(j.viabilidade.status, 'justo');                    // 0,5 ≤ 1,1×0,5
  const b = M.calculadoraMes({ ...base, entradaRecebida: 500 });
  assert.equal(b.progresso.batida, true);
  assert.equal(b.progresso.restante, 0);
  assert.equal(M.calculadoraMes({ ...base, contasAPagar: null }).erro, 'contas a pagar indisponiveis');
  const semFat = M.calculadoraMes(base);                          // sem meta de faturamento
  assert.equal(semFat.breakEven.pctFat, null);
  assert.equal(semFat.viabilidade, null);
  assert.equal(semFat.comLucro, null);                            // sem lucro definido
  assert.equal(semFat.progresso.alvo, semFat.breakEven.entrada);  // alvo cai pro empate
});

test('diasUteisRestantes: seg–sex 1, sábado 0,5, de hoje ao fim do mês', () => {
  // 2026-07-08 (qua) → 08–31/jul: 17 dias úteis seg–sex + 4 sábados (11,18,25) = 3×0,5… conferir:
  // qua08 qui09 sex10 =3; sem 13–17 =5; 20–24 =5; 27–31 =5 → 18; sáb 11,18,25 → +1,5 = 19,5
  assert.equal(M.diasUteisRestantes('2026-07-08'), 19.5);
  assert.equal(M.diasUteisRestantes('2026-07-31'), 1); // sexta
});

test('safras: coorte por PostDate, prazos ponderados por valor, emCurso', () => {
  const items = [
    // safra 2026-01 (madura): 2 parcelas de 100, vencendo +1m e +3m; ambas pagas no venc.
    { PostDate: '2026-01-10', DueDate: '2026-02-09', ReceivedDate: '2026-02-09', Amount: 100 },
    { PostDate: '2026-01-10', DueDate: '2026-04-10', ReceivedDate: '2026-04-10', Amount: 100 },
    // safra 2026-06 (jovem): 200 vence +2m, não paga; 100 à vista paga no dia
    { PostDate: '2026-06-05', DueDate: '2026-08-04', Amount: 200 },
    { PostDate: '2026-06-05', DueDate: '2026-06-05', ReceivedDate: '2026-06-05', Amount: 100 },
    { PostDate: '2026-06-05', DueDate: '2026-07-05', Amount: 999, Canceled: 'X' },   // fora
    { PostDate: '2024-01-01', DueDate: '2024-02-01', Amount: 999 },                   // fora da janela
  ];
  const r = M.safras(items, HOJE, 12);
  assert.equal(r.length, 12);
  const jan = r.find(s => s.safra === '2026-01');
  // prazo contratado: (100×~1m + 100×~3m)/200 ≈ 2,0 ; real igual (pagou no vencimento)
  assert.equal(jan.aprovado, 200);
  assert.ok(Math.abs(jan.prazoContratado - 2.0) <= 0.1);
  assert.ok(Math.abs(jan.prazoReal - jan.prazoContratado) < 0.01);
  assert.equal(jan.pctRecebido, 1);
  assert.equal(jan.emCurso, false);          // idade 6 meses → não é < 6
  const jun = r.find(s => s.safra === '2026-06');
  assert.equal(jun.aprovado, 300);
  assert.equal(jun.recebido, 100);
  assert.ok(Math.abs(jun.pctRecebido - 0.333) < 0.001);
  assert.equal(jun.prazoReal, 0);            // só o à vista caiu
  assert.equal(jun.emCurso, true);
});

test('safras: sem recebimento → prazoReal null; safra vazia → aprovado 0', () => {
  const r = M.safras([{ PostDate: '2026-05-01', DueDate: '2026-06-01', Amount: 50 }], HOJE, 3);
  const mai = r.find(s => s.safra === '2026-05');
  assert.equal(mai.prazoReal, null);
  assert.equal(r.find(s => s.safra === '2026-07').aprovado, 0);
});

test('curvaSafra: acumulado por idade com censura à direita', () => {
  const items = [
    // safra 2026-04 (idade 3): 100 recebida no mês 0, 100 no mês 2, 200 em aberto
    { PostDate: '2026-04-10', DueDate: '2026-04-10', ReceivedDate: '2026-04-15', Amount: 100 },
    { PostDate: '2026-04-10', DueDate: '2026-06-10', ReceivedDate: '2026-06-12', Amount: 100 },
    { PostDate: '2026-04-10', DueDate: '2026-09-10', Amount: 200 },
    { PostDate: '2026-04-10', DueDate: '2026-05-10', Amount: 999, Canceled: 'X' },  // fora
  ];
  const r = M.curvaSafra(items, HOJE, 12);
  const abr = r.find(s => s.safra === '2026-04');
  assert.equal(abr.curva.length, 4);                     // idades 0..3 (jul = idade 3)
  assert.deepEqual(abr.curva, [0.25, 0.25, 0.5, 0.5]);   // 100/400, +0, +100/400, +0
  const jul = r.find(s => s.safra === '2026-07');
  assert.equal(jul.curva.length, 1);                     // só idade 0
});

test('curvaSafra: idade negativa (dado sujo) conta na idade 0; safra vazia → curva de zeros', () => {
  const items = [
    { PostDate: '2026-06-20', DueDate: '2026-06-20', ReceivedDate: '2026-05-01', Amount: 50 }, // recebida "antes" → idade 0
    { PostDate: '2026-06-20', DueDate: '2026-08-20', Amount: 50 },
  ];
  const r = M.curvaSafra(items, HOJE, 3);
  const jun = r.find(s => s.safra === '2026-06');
  assert.deepEqual(jun.curva, [0.5, 0.5]);
  const mai = r.find(s => s.safra === '2026-05');
  assert.deepEqual(mai.curva, [0, 0, 0]);                // aprovado 0 → zeros até a idade
});
