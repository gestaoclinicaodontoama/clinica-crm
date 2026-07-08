const { test } = require('node:test');
const assert = require('node:assert');
const h = require('./health');

test('parseStep: número puro', () => {
  assert.deepEqual(h.parseStep(42), { tipo: 'num', n: 42 });
  assert.deepEqual(h.parseStep(0), { tipo: 'num', n: 0 });
});

test('parseStep: string numérica tipo "50 mídias"', () => {
  assert.deepEqual(h.parseStep('50 mídias'), { tipo: 'num', n: 50 });
});

test('parseStep: erro por prefixo', () => {
  const p = h.parseStep('erro: (#10) Application does not have permission');
  assert.equal(p.tipo, 'erro');
  assert.match(p.msg, /#10/);
});

test('parseStep: textos neutros', () => {
  assert.equal(h.parseStep('ok').tipo, 'neutro');
  assert.equal(h.parseStep('pulado (sem ig_id)').tipo, 'neutro');
  assert.equal(h.parseStep('sem mudança').tipo, 'neutro');
  assert.equal(h.parseStep(null).tipo, 'neutro');
});

test('mediana: ímpar, par, vazia', () => {
  assert.equal(h.mediana([3, 1, 2]), 2);
  assert.equal(h.mediana([1, 2, 3, 4]), 2.5);
  assert.equal(h.mediana([]), null);
});

test('separarPorJob: social-media% separa do resto', () => {
  const rows = [
    { trigger: 'agendado' }, { trigger: 'social-media-diario' },
    { trigger: 'manual' }, { trigger: 'social-media-smoke' },
  ];
  const s = h.separarPorJob(rows);
  assert.equal(s.clinicorp.length, 2);
  assert.equal(s.social.length, 2);
});

test('completa: exige finished_at e steps', () => {
  assert.ok(h.completa({ finished_at: 'x', steps: { a: 1 } }));
  assert.ok(!h.completa({ finished_at: null, steps: { a: 1 } }));
  assert.ok(!h.completa({ finished_at: 'x', steps: null }));
});

test('tipicoPorFase: mediana só dos numéricos', () => {
  const rows = [
    { finished_at: 'x', steps: { agendamentos: 30, entradas: 'erro: X' } },
    { finished_at: 'x', steps: { agendamentos: 40, entradas: 2 } },
    { finished_at: 'x', steps: { agendamentos: 50 } },
  ];
  const t = h.tipicoPorFase(rows);
  assert.equal(t.agendamentos, 40);
  assert.equal(t.entradas, 2); // o 'erro:' não entra na mediana
});

test('classificarFases: erro, zerou, abaixo, ok, neutro por típico pequeno, sumiu', () => {
  const tipico = { agendamentos: 30, pagamentos: 20, leads_fechados: 1, producao: 100, antiga: 10 };
  const ultima = {
    finished_at: 'x',
    steps: {
      agendamentos: 0,                 // zerou (típico 30 >= 3)
      pagamentos: 7,                   // abaixo (7 < 20*0.40=8)
      producao: 41,                    // 41 >= 100*0.40=40 → ok
      leads_fechados: 0,               // típico 1 < 3 → neutro
      entradas: 'erro: Timeout Clinicorp', // erro
      config: 'ok',                    // neutro
      // 'antiga' não veio → sumiu
    },
  };
  const m = Object.fromEntries(h.classificarFases(ultima, tipico).map(f => [f.fase, f]));
  assert.equal(m.agendamentos.status, 'zerou');
  assert.equal(m.pagamentos.status, 'abaixo');
  assert.equal(m.producao.status, 'ok');
  assert.equal(m.leads_fechados.status, 'neutro');
  assert.equal(m.entradas.status, 'erro');
  assert.match(m.entradas.msg, /Timeout/);
  assert.equal(m.config.status, 'neutro');
  assert.equal(m.antiga.status, 'sumiu');
});

test('estadoJob: falhou / travou / não rodou / ok / antes da margem', () => {
  const job = h.JOBS[0]; // clinicorp 02:00, margem 120min
  const agora = new Date('2026-07-07T05:00:00-03:00');
  const ontem = { started_at: '2026-07-06T02:00:05-03:00', finished_at: '2026-07-06T02:03:00-03:00', ok: true, steps: { a: 1 } };

  const hojeOk = { started_at: '2026-07-07T02:00:05-03:00', finished_at: '2026-07-07T02:03:00-03:00', ok: true, steps: { a: 1 } };
  assert.equal(h.estadoJob([hojeOk, ontem], job, agora).status, 'ok');

  const hojeFalha = { ...hojeOk, ok: false, error: 'X' };
  assert.equal(h.estadoJob([hojeFalha, ontem], job, agora).status, 'falhou');

  const travada = { started_at: '2026-07-07T02:00:05-03:00', finished_at: null, ok: null, steps: null };
  assert.equal(h.estadoJob([travada, ontem], job, agora).status, 'travou');

  assert.equal(h.estadoJob([ontem], job, agora).status, 'nao_rodou');

  const cedo = new Date('2026-07-07T03:00:00-03:00');
  assert.equal(h.estadoJob([ontem], job, cedo).status, 'ok');
});

test('estadoJob: rodada manual abandonada (incompleta e velha) não marca travou', () => {
  const job = h.JOBS[0];
  const agora = new Date('2026-07-07T19:00:00-03:00');
  // linha mais recente: manual das 09:32 que nunca terminou (~9,5h atrás > 6h teto)
  const abandonada = { started_at: '2026-07-07T09:32:00-03:00', finished_at: null, ok: null, steps: null };
  // rodada agendada das 05:07 completou OK (dentro da janela de hoje)
  const completaOk = { started_at: '2026-07-07T05:07:00-03:00', finished_at: '2026-07-07T05:10:00-03:00', ok: true, steps: { a: 1 } };
  const est = h.estadoJob([abandonada, completaOk], job, agora);
  assert.equal(est.status, 'ok'); // ignora a abandonada, usa a completa OK
});

test('estadoJob: trava recente (3h) ainda marca travou', () => {
  const job = h.JOBS[0];
  const agora = new Date('2026-07-07T19:00:00-03:00');
  const travadaRecente = { started_at: '2026-07-07T16:00:00-03:00', finished_at: null, ok: null, steps: null };
  const completaOntem = { started_at: '2026-07-06T02:03:00-03:00', finished_at: '2026-07-06T02:06:00-03:00', ok: true, steps: { a: 1 } };
  assert.equal(h.estadoJob([travadaRecente, completaOntem], job, agora).status, 'travou');
});

test('estadoJob: só rodada COMPLETA na janela conta como "rodou hoje"', () => {
  const job = h.JOBS[0];
  const agora = new Date('2026-07-07T19:00:00-03:00'); // muito depois da margem
  // começou na janela mas nunca terminou (e já passou do teto de travou) → não conta
  const incompletaNaJanela = { started_at: '2026-07-07T02:00:05-03:00', finished_at: null, ok: null, steps: null };
  const completaOntem = { started_at: '2026-07-06T02:03:00-03:00', finished_at: '2026-07-06T02:06:00-03:00', ok: true, steps: { a: 1 } };
  assert.equal(h.estadoJob([incompletaNaJanela, completaOntem], job, agora).status, 'nao_rodou');
});

test('avaliarGatilhosSync: falha vira ruim; fase zerada vira ruim; formato do decidirAlertas', () => {
  const agora = new Date('2026-07-07T05:00:00-03:00');
  const rows = [
    { trigger: 'agendado', started_at: '2026-07-07T02:00:05-03:00', finished_at: '2026-07-07T02:03:00-03:00',
      ok: true, duration_s: 180, steps: { agendamentos: 0, pagamentos: 20 } },
    { trigger: 'agendado', started_at: '2026-07-06T02:00:05-03:00', finished_at: '2026-07-06T02:03:00-03:00',
      ok: true, duration_s: 180, steps: { agendamentos: 30, pagamentos: 22 } },
    { trigger: 'agendado', started_at: '2026-07-05T02:00:05-03:00', finished_at: '2026-07-05T02:03:00-03:00',
      ok: true, duration_s: 180, steps: { agendamentos: 28, pagamentos: 19 } },
    { trigger: 'social-media-diario', started_at: '2026-07-06T03:15:05-03:00', finished_at: '2026-07-06T03:16:00-03:00',
      ok: true, duration_s: 55, steps: { midias_dr_marcos: '50 mídias' } },
  ];
  const g = h.avaliarGatilhosSync(rows, agora);
  const porChave = Object.fromEntries(g.map(x => [x.gatilho + '|' + x.escopo, x]));
  assert.equal(porChave['sync_fase|clinicorp:agendamentos'].status, 'ruim');
  assert.equal(porChave['sync_fase|clinicorp:pagamentos'].status, 'ok');
  assert.equal(porChave['sync_falha|clinicorp'].status, 'ok');
  assert.equal(porChave['sync_nao_rodou|clinicorp'].status, 'ok');
  assert.equal(porChave['sync_nao_rodou|social'].status, 'ok');
  for (const x of g) {
    assert.ok('gatilho' in x && 'escopo' in x && ['ok', 'ruim'].includes(x.status) && 'detalhe' in x);
  }
});

test('avaliarGatilhosSync: social não rodou depois da margem', () => {
  const agora = new Date('2026-07-07T06:00:00-03:00'); // 05:15 < 06:00
  const rows = [
    { trigger: 'social-media-diario', started_at: '2026-07-06T03:15:05-03:00', finished_at: '2026-07-06T03:16:00-03:00',
      ok: true, duration_s: 55, steps: { midias_dr_marcos: '50 mídias' } },
  ];
  const g = h.avaliarGatilhosSync(rows, agora);
  const naoRodou = g.find(x => x.gatilho === 'sync_nao_rodou' && x.escopo === 'social');
  assert.equal(naoRodou.status, 'ruim');
});

test('classificarJob: aguardando / falhou / parado / ok', () => {
  const agora = new Date('2026-07-08T12:00:00-03:00');
  const meta = { job: 'x', label: 'X', cadencia_min: 10, margem_min: 50 };
  assert.equal(h.classificarJob({ ...meta, last_run_at: null }, agora).status, 'aguardando');
  assert.equal(h.classificarJob({ ...meta, last_run_at: '2026-07-08T11:58:00-03:00', ok: false, error: 'X' }, agora).status, 'falhou');
  assert.equal(h.classificarJob({ ...meta, last_run_at: '2026-07-08T10:50:00-03:00', ok: true }, agora).status, 'parado');
  assert.equal(h.classificarJob({ ...meta, last_run_at: '2026-07-08T11:55:00-03:00', ok: true }, agora).status, 'ok');
});

test('classificarJob: job diário dentro de 24h+margem é ok', () => {
  const agora = new Date('2026-07-08T12:00:00-03:00');
  const diario = { job: 'financeiro_mes', label: 'Fin', cadencia_min: 1440, margem_min: 180,
                   last_run_at: '2026-07-08T02:05:00-03:00', ok: true };
  assert.equal(h.classificarJob(diario, agora).status, 'ok');
});

test('avaliarGatilhosJobs: parado e falhou viram ruim; aguardando e ok viram ok', () => {
  const agora = new Date('2026-07-08T12:00:00-03:00');
  const rows = [
    { job: 'a', label: 'A', cadencia_min: 10, margem_min: 50, last_run_at: '2026-07-08T10:00:00-03:00', ok: true },
    { job: 'b', label: 'B', cadencia_min: 10, margem_min: 50, last_run_at: '2026-07-08T11:59:00-03:00', ok: false, error: 'x' },
    { job: 'c', label: 'C', cadencia_min: 10, margem_min: 50, last_run_at: '2026-07-08T11:59:00-03:00', ok: true },
    { job: 'd', label: 'D', cadencia_min: 10, margem_min: 50, last_run_at: null },
  ];
  const g = Object.fromEntries(h.avaliarGatilhosJobs(rows, agora).map(x => [x.escopo, x]));
  assert.equal(g.a.status, 'ruim');
  assert.equal(g.b.status, 'ruim');
  assert.equal(g.c.status, 'ok');
  assert.equal(g.d.status, 'ok');
  for (const x of Object.values(g)) {
    assert.equal(x.gatilho, 'sync_job');
    assert.ok(['ok', 'ruim'].includes(x.status) && 'detalhe' in x);
  }
});

test('montarSaude: payload por job com fases, erros 7d e histórico', () => {
  const agora = new Date('2026-07-07T05:00:00-03:00');
  const rows = [
    { trigger: 'agendado', started_at: '2026-07-07T02:00:05-03:00', finished_at: '2026-07-07T02:03:00-03:00',
      ok: false, error: 'entradas: Timeout Clinicorp', duration_s: 180,
      steps: { agendamentos: 30, entradas: 'erro: Timeout Clinicorp' } },
    { trigger: 'agendado', started_at: '2026-07-06T02:00:05-03:00', finished_at: '2026-07-06T02:03:00-03:00',
      ok: true, duration_s: 170, steps: { agendamentos: 28, entradas: 3 } },
  ];
  const s = h.montarSaude(rows, agora);
  const cli = s.jobs.find(j => j.id === 'clinicorp');
  assert.equal(cli.estado, 'falhou');
  assert.equal(cli.ultima.ok, false);
  assert.ok(cli.fases.find(f => f.fase === 'entradas' && f.status === 'erro'));
  assert.equal(cli.erros.length, 1);
  assert.equal(cli.historico.length, 2);
  assert.ok(s.jobs.find(j => j.id === 'social'));
  assert.ok(s.atualizadoEm);
});
