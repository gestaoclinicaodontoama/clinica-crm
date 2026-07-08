# Monitor de Saúde dos Syncs (Fase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Página `/sync-saude/` que mostra, por fase do sync (Clinicorp 02h + Social Media 03:15), o que veio vs o típico, com justificativa em português — mais alerta no sino/push em falha, não-rodou ou fase zerada/abaixo.

**Architecture:** Clona o monitor do CAPI: `lib/sync/health.js` (funções puras sobre as linhas do `sync_log`) + endpoints admin + página `shared-nav` + tick de 30 min que reusa `capiHealth.decidirAlertas` e a tabela `capi_monitor_estado` (sem migration).

**Tech Stack:** Node.js/Express (`server.js`), `node --test` (testes em `lib/**/*.test.js`), HTML/JS vanilla, Supabase (`sync_log` já existente).

**Spec:** `docs/superpowers/specs/2026-07-07-sync-saude-monitor-design.md`

## Global Constraints

- Sem tabela/migration nova: estado de alerta na `capi_monitor_estado` existente (`unique(gatilho, escopo)`); gatilhos `sync_falha`, `sync_nao_rodou`, `sync_fase`.
- Limiares: fase alarma só se típico ≥ **3**; 🔴 `zerou` = 0; 🟡 `abaixo` = < **40%** do típico; margem do "não rodou" = **120 min** após a janela (02:00 / 03:15 BRT); "travou" = rodada sem `finished_at` há > **120 min**.
- Rodadas incompletas (`finished_at`/`steps` nulos) ficam FORA do cálculo do típico.
- O típico de uma rodada exclui a própria rodada avaliada.
- Justificativas = dicionário fixo em PT no frontend (sem IA); fase sem verbete ganha texto genérico.
- Auth: `requireAuth` + `requireGestor` (definidos em `server.js:417`); notificação tipo `sync_alerta` para roles admin/gestor.
- Nav: fonte única `public/js/nav-config.js` (item ao lado de `capi-saude`, linha ~77).
- Fuso: BRT via `toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })` + sufixo `-03:00` (padrão do scheduler existente).
- Testes: `npm test` roda `node --test "lib/**/*.test.js"`.
- Deploy: após `git push`, `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`. Push travando → fluxo headless (token via CredRead, `git -c credential.helper= push https://x-access-token:$TOKEN@github.com/gestaoclinicaodontoama/clinica-crm main`).

---

### Task 1: `lib/sync/health.js` — núcleo (parser, mediana, separação por job, típico)

**Files:**
- Create: `lib/sync/health.js`
- Test: `lib/sync/health.test.js`

**Interfaces:**
- Produces (usadas nas Tasks 2–4):
  - `JOBS: [{ id, label, ehDoJob(trigger)→bool, janelaHHMM, margemMin }]`
  - `LIMITES = { tipicoMin:3, fracaoAbaixo:0.40, travadoMin:120, historico:60 }`
  - `parseStep(v) → { tipo:'num', n } | { tipo:'erro', msg } | { tipo:'neutro', msg }`
  - `mediana(nums[]) → number|null`
  - `separarPorJob(rows) → { clinicorp:[...], social:[...] }` (mantém ordem desc)
  - `completa(row) → bool`
  - `tipicoPorFase(rowsCompletas) → { [fase]: mediana }`

- [ ] **Step 1: Escrever os testes que falham**

Criar `lib/sync/health.test.js`:

```js
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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — `Cannot find module './health'`.

- [ ] **Step 3: Implementar o núcleo**

Criar `lib/sync/health.js`:

```js
// Saúde dos syncs — funções puras sobre linhas do sync_log.
// Fase 1: Clinicorp (02h) + Social Media (03:15). Espelha lib/capi/health.js.
const TZ = 'America/Sao_Paulo';

const JOBS = [
  { id: 'clinicorp', label: 'Sync Clinicorp (02h)',
    ehDoJob: t => !String(t || '').startsWith('social-media'),
    janelaHHMM: '02:00', margemMin: 120 },
  { id: 'social', label: 'Social Media (03:15)',
    ehDoJob: t => String(t || '').startsWith('social-media'),
    janelaHHMM: '03:15', margemMin: 120 },
];

const LIMITES = { tipicoMin: 3, fracaoAbaixo: 0.40, travadoMin: 120, historico: 60 };

function parseStep(v) {
  if (typeof v === 'number') return { tipo: 'num', n: v };
  const s = String(v == null ? '' : v).trim();
  if (s.startsWith('erro')) return { tipo: 'erro', msg: s };
  if (/^\d/.test(s)) return { tipo: 'num', n: parseInt(s.match(/\d+/)[0], 10) };
  return { tipo: 'neutro', msg: s };
}

function mediana(nums) {
  if (!nums || !nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// rows chegam em ordem desc por started_at; a ordem é preservada.
function separarPorJob(rows) {
  const porJob = {};
  for (const j of JOBS) porJob[j.id] = [];
  for (const r of rows || []) {
    const j = JOBS.find(j => j.ehDoJob(r.trigger));
    if (j) porJob[j.id].push(r);
  }
  return porJob;
}

const completa = r => !!(r && r.finished_at && r.steps && typeof r.steps === 'object');

function tipicoPorFase(rowsCompletas) {
  const porFase = {};
  for (const r of rowsCompletas || []) {
    for (const [fase, v] of Object.entries(r.steps || {})) {
      const p = parseStep(v);
      if (p.tipo !== 'num') continue;
      (porFase[fase] = porFase[fase] || []).push(p.n);
    }
  }
  const out = {};
  for (const [fase, ns] of Object.entries(porFase)) out[fase] = mediana(ns);
  return out;
}

module.exports = { TZ, JOBS, LIMITES, parseStep, mediana, separarPorJob, completa, tipicoPorFase };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS em todos os testes novos (os testes pré-existentes de outras libs seguem passando).

- [ ] **Step 5: Commit**

```bash
git add lib/sync/health.js lib/sync/health.test.js
git commit -m "feat(sync-saude): núcleo do health — parser de steps, mediana, separação por job"
```

---

### Task 2: classificação de fases + estado do job

**Files:**
- Modify: `lib/sync/health.js` (adicionar funções + exports)
- Test: `lib/sync/health.test.js` (adicionar testes)

**Interfaces:**
- Consumes: `parseStep`, `tipicoPorFase`, `completa`, `LIMITES`, `JOBS` (Task 1).
- Produces (usadas nas Tasks 3–4):
  - `classificarFases(ultimaRow, tipico) → [{ fase, hoje, tipico, status, msg? }]`
    com `status ∈ 'ok'|'erro'|'zerou'|'abaixo'|'neutro'|'sumiu'`
  - `inicioJanelaHoje(hhmm, agora) → Date`
  - `estadoJob(rowsJob, jobDef, agora) → { status:'ok'|'falhou'|'travou'|'nao_rodou', ultima, ultimaCompleta }`

- [ ] **Step 1: Escrever os testes que falham**

Adicionar ao `lib/sync/health.test.js`:

```js
test('classificarFases: erro, zerou, abaixo, ok, neutro por típico pequeno, sumiu', () => {
  const tipico = { agendamentos: 30, pagamentos: 20, leads_fechados: 1, producao: 100, antiga: 10 };
  const ultima = {
    finished_at: 'x',
    steps: {
      agendamentos: 0,                 // zerou (típico 30 >= 3)
      pagamentos: 7,                   // abaixo (7 < 20*0.40=8)
      producao: 41,                    // abaixo? 41 >= 100*0.40=40 → ok
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
  // "agora" = 2026-07-07 05:00 BRT (depois da janela+margem 04:00)
  const agora = new Date('2026-07-07T05:00:00-03:00');
  const ontem = { started_at: '2026-07-06T02:00:05-03:00', finished_at: '2026-07-06T02:03:00-03:00', ok: true, steps: { a: 1 } };

  // ok: rodou hoje e ok=true
  const hojeOk = { started_at: '2026-07-07T02:00:05-03:00', finished_at: '2026-07-07T02:03:00-03:00', ok: true, steps: { a: 1 } };
  assert.equal(h.estadoJob([hojeOk, ontem], job, agora).status, 'ok');

  // falhou: rodou hoje e ok=false
  const hojeFalha = { ...hojeOk, ok: false, error: 'X' };
  assert.equal(h.estadoJob([hojeFalha, ontem], job, agora).status, 'falhou');

  // travou: última linha sem finished_at, started há > 120min
  const travada = { started_at: '2026-07-07T02:00:05-03:00', finished_at: null, ok: null, steps: null };
  assert.equal(h.estadoJob([travada, ontem], job, agora).status, 'travou');

  // não rodou: nenhuma linha de hoje, agora já passou de 04:00
  assert.equal(h.estadoJob([ontem], job, agora).status, 'nao_rodou');

  // antes da margem (03:00 BRT): sem linha de hoje NÃO alarma
  const cedo = new Date('2026-07-07T03:00:00-03:00');
  assert.equal(h.estadoJob([ontem], job, cedo).status, 'ok');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — `h.classificarFases is not a function`.

- [ ] **Step 3: Implementar**

Adicionar ao `lib/sync/health.js` (antes do `module.exports`, que ganha os nomes novos):

```js
function classificarFases(ultima, tipico) {
  const out = [];
  const fases = new Set([...Object.keys((ultima && ultima.steps) || {}), ...Object.keys(tipico || {})]);
  for (const fase of fases) {
    const t = tipico && tipico[fase] != null ? tipico[fase] : null;
    if (!ultima || !ultima.steps || !(fase in ultima.steps)) {
      out.push({ fase, hoje: null, tipico: t, status: 'sumiu' });
      continue;
    }
    const p = parseStep(ultima.steps[fase]);
    if (p.tipo === 'erro') { out.push({ fase, hoje: null, tipico: t, status: 'erro', msg: p.msg }); continue; }
    if (p.tipo === 'neutro') { out.push({ fase, hoje: p.msg, tipico: t, status: 'neutro' }); continue; }
    if (t == null || t < LIMITES.tipicoMin) { out.push({ fase, hoje: p.n, tipico: t, status: 'neutro' }); continue; }
    if (p.n === 0) { out.push({ fase, hoje: 0, tipico: t, status: 'zerou' }); continue; }
    if (p.n < t * LIMITES.fracaoAbaixo) { out.push({ fase, hoje: p.n, tipico: t, status: 'abaixo' }); continue; }
    out.push({ fase, hoje: p.n, tipico: t, status: 'ok' });
  }
  return out;
}

function inicioJanelaHoje(hhmm, agora) {
  const ymd = agora.toLocaleDateString('en-CA', { timeZone: TZ });
  return new Date(`${ymd}T${hhmm}:00-03:00`);
}

function estadoJob(rowsJob, jobDef, agora) {
  const ultima = (rowsJob && rowsJob[0]) || null;
  const ultimaCompleta = (rowsJob || []).find(completa) || null;
  if (ultima && !ultima.finished_at &&
      agora.getTime() - new Date(ultima.started_at).getTime() > LIMITES.travadoMin * 60000) {
    return { status: 'travou', ultima, ultimaCompleta };
  }
  const janela = inicioJanelaHoje(jobDef.janelaHHMM, agora);
  const limite = new Date(janela.getTime() + jobDef.margemMin * 60000);
  if (agora >= limite) {
    const rodouHoje = (rowsJob || []).some(r => new Date(r.started_at) >= janela);
    if (!rodouHoje) return { status: 'nao_rodou', ultima, ultimaCompleta };
  }
  if (ultimaCompleta && ultimaCompleta.ok === false) return { status: 'falhou', ultima, ultimaCompleta };
  return { status: 'ok', ultima, ultimaCompleta };
}
```

E atualizar o export:

```js
module.exports = { TZ, JOBS, LIMITES, parseStep, mediana, separarPorJob, completa, tipicoPorFase, classificarFases, inicioJanelaHoje, estadoJob };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/health.js lib/sync/health.test.js
git commit -m "feat(sync-saude): classificação de fases (zerou/abaixo/erro/sumiu) e estado do job"
```

---

### Task 3: gatilhos de alerta + payload do endpoint

**Files:**
- Modify: `lib/sync/health.js`
- Test: `lib/sync/health.test.js`

**Interfaces:**
- Consumes: tudo das Tasks 1–2; formato de gatilho do CAPI (`{ gatilho, escopo, status:'ok'|'ruim', detalhe }` — aceito por `capiHealth.decidirAlertas`).
- Produces (usadas na Task 4):
  - `avaliarGatilhosSync(rows, agora) → [{ gatilho, escopo, status, detalhe }]`
  - `montarSaude(rows, agora) → { jobs:[{ id, label, estado, ultima, fases, erros, historico }], atualizadoEm }`

- [ ] **Step 1: Escrever os testes que falham**

Adicionar ao `lib/sync/health.test.js`:

```js
test('avaliarGatilhosSync: falha vira ruim; fase zerada vira ruim; formato do decidirAlertas', () => {
  const agora = new Date('2026-07-07T05:00:00-03:00');
  const rows = [
    { trigger: 'agendado', started_at: '2026-07-07T02:00:05-03:00', finished_at: '2026-07-07T02:03:00-03:00',
      ok: true, duration_s: 180, steps: { agendamentos: 0, pagamentos: 20 } },
    { trigger: 'agendado', started_at: '2026-07-06T02:00:05-03:00', finished_at: '2026-07-06T02:03:00-03:00',
      ok: true, duration_s: 180, steps: { agendamentos: 30, pagamentos: 22 } },
    { trigger: 'agendado', started_at: '2026-07-05T02:00:05-03:00', finished_at: '2026-07-05T02:03:00-03:00',
      ok: true, duration_s: 180, steps: { agendamentos: 28, pagamentos: 19 } },
    // social não rodou hoje (última é de ontem) → nao_rodou depois de 05:15+margem... às 05:00 ainda DENTRO da margem (03:15+120=05:15) → ok
    { trigger: 'social-media-diario', started_at: '2026-07-06T03:15:05-03:00', finished_at: '2026-07-06T03:16:00-03:00',
      ok: true, duration_s: 55, steps: { midias_dr_marcos: '50 mídias' } },
  ];
  const g = h.avaliarGatilhosSync(rows, agora);
  const porChave = Object.fromEntries(g.map(x => [x.gatilho + '|' + x.escopo, x]));
  // fase agendamentos zerou (típico 29 >= 3) → ruim
  assert.equal(porChave['sync_fase|clinicorp:agendamentos'].status, 'ruim');
  // pagamentos normal → ok
  assert.equal(porChave['sync_fase|clinicorp:pagamentos'].status, 'ok');
  // clinicorp rodou ok → sync_falha ok, sync_nao_rodou ok
  assert.equal(porChave['sync_falha|clinicorp'].status, 'ok');
  assert.equal(porChave['sync_nao_rodou|clinicorp'].status, 'ok');
  // social às 05:00 ainda dentro da margem → não alarma
  assert.equal(porChave['sync_nao_rodou|social'].status, 'ok');
  // todo gatilho tem os campos que o decidirAlertas usa
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
  assert.ok(s.jobs.find(j => j.id === 'social')); // job sem linhas ainda aparece
  assert.ok(s.atualizadoEm);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — `h.avaliarGatilhosSync is not a function`.

- [ ] **Step 3: Implementar**

Adicionar ao `lib/sync/health.js` (antes do export; export ganha os 2 nomes):

```js
function avaliarGatilhosSync(rows, agora = new Date()) {
  const porJob = separarPorJob(rows);
  const out = [];
  for (const job of JOBS) {
    const rowsJob = porJob[job.id];
    const est = estadoJob(rowsJob, job, agora);
    out.push({
      gatilho: 'sync_falha', escopo: job.id,
      status: (est.status === 'falhou' || est.status === 'travou') ? 'ruim' : 'ok',
      detalhe: { estado: est.status, error: (est.ultimaCompleta && est.ultimaCompleta.error) || null },
    });
    out.push({
      gatilho: 'sync_nao_rodou', escopo: job.id,
      status: est.status === 'nao_rodou' ? 'ruim' : 'ok',
      detalhe: { estado: est.status },
    });
    const completas = rowsJob.filter(completa);
    const ultima = completas[0];
    if (ultima) {
      const tipico = tipicoPorFase(completas.slice(1)); // exclui a própria rodada avaliada
      for (const f of classificarFases(ultima, tipico)) {
        const ruim = ['erro', 'zerou', 'abaixo'].includes(f.status);
        out.push({
          gatilho: 'sync_fase', escopo: job.id + ':' + f.fase,
          status: ruim ? 'ruim' : 'ok',
          detalhe: { hoje: f.hoje, tipico: f.tipico, status: f.status, msg: f.msg || null },
        });
      }
    }
  }
  return out;
}

function montarSaude(rows, agora = new Date()) {
  const porJob = separarPorJob(rows);
  const jobs = [];
  for (const job of JOBS) {
    const rowsJob = porJob[job.id];
    const est = estadoJob(rowsJob, job, agora);
    const completas = rowsJob.filter(completa);
    const ultima = completas[0] || null;
    const tipico = tipicoPorFase(completas.slice(1));
    const fases = ultima ? classificarFases(ultima, tipico) : [];
    const corte7 = new Date(agora.getTime() - 7 * 86400000);
    const erros = rowsJob
      .filter(r => r.error && new Date(r.started_at) >= corte7)
      .map(r => ({ quando: r.started_at, msg: r.error }))
      .slice(0, 10);
    jobs.push({
      id: job.id, label: job.label, estado: est.status,
      ultima: ultima ? { quando: ultima.started_at, ok: ultima.ok, duracao_s: ultima.duration_s, trigger: ultima.trigger } : null,
      fases, erros,
      historico: rowsJob.slice(0, 7).map(r => ({ quando: r.started_at, ok: r.ok, duracao_s: r.duration_s, trigger: r.trigger })),
    });
  }
  return { jobs, atualizadoEm: agora.toISOString() };
}
```

Export final do arquivo:

```js
module.exports = { TZ, JOBS, LIMITES, parseStep, mediana, separarPorJob, completa, tipicoPorFase, classificarFases, inicioJanelaHoje, estadoJob, avaliarGatilhosSync, montarSaude };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/health.js lib/sync/health.test.js
git commit -m "feat(sync-saude): gatilhos de alerta e payload do dashboard"
```

---

### Task 4: endpoints + tick de alerta no `server.js`

**Files:**
- Modify: `server.js` — logo APÓS o bloco do capi-monitor (após a linha `console.log('[capi-monitor] scheduler de alertas ativo (30 min)');`, ~linha 5103, e antes do endpoint `/api/admin/capi-saude/recheck` tudo bem também; o importante é ficar no nível topo do arquivo, fora de qualquer função)

**Interfaces:**
- Consumes: `syncHealth.avaliarGatilhosSync`, `syncHealth.montarSaude` (Task 3); `capiHealth.decidirAlertas` (já existe, `server.js:52` importa `./lib/capi/health`); `requireAuth`, `requireGestor` (linha 417), `criarNotificacao`, `supabase` (existentes).
- Produces: `GET /api/admin/sync-saude`, `POST /api/admin/sync-saude/recheck` (usados pela página na Task 5).

- [ ] **Step 1: Adicionar o require**

Perto do `const capiHealth = require('./lib/capi/health');` (linha 52), adicionar:

```js
const syncHealth = require('./lib/sync/health');
```

- [ ] **Step 2: Adicionar o bloco (endpoints + tick)**

Inserir após o bloco do capi-monitor:

```js
// ── Monitor de Saúde dos Syncs (spec 2026-07-07) ────────────────────────────
// Lê o sync_log (Clinicorp 02h + social media), compara cada fase com o típico
// e alerta gestores em falha / não-rodou / fase zerada. Reusa a máquina de
// dedup do CAPI (decidirAlertas + capi_monitor_estado) — sem tabela nova.
async function syncSaudeCarregarRows() {
  const { data, error } = await supabase.from('sync_log')
    .select('started_at, finished_at, ok, trigger, duration_s, steps, error')
    .order('started_at', { ascending: false })
    .limit(syncHealth.LIMITES.historico);
  if (error) throw error;
  return data || [];
}

app.get('/api/admin/sync-saude', requireAuth, requireGestor, async (req, res) => {
  try {
    res.json(syncHealth.montarSaude(await syncSaudeCarregarRows(), new Date()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function _textoAlertaSync(n) {
  const map = {
    sync_falha: 'Sync falhou',
    sync_nao_rodou: 'Sync não rodou na janela',
    sync_fase: 'Fase do sync fora do normal',
  };
  return (map[n.gatilho] || n.gatilho) + (n.escopo ? ` — ${n.escopo}` : '');
}

let _syncSaudeChecando = false;
async function syncSaudeChecarGatilhos() {
  if (_syncSaudeChecando) return;
  _syncSaudeChecando = true;
  try {
    const agora = new Date();
    const atuais = syncHealth.avaliarGatilhosSync(await syncSaudeCarregarRows(), agora);
    const { data: salvos } = await supabase.from('capi_monitor_estado').select('*')
      .in('gatilho', ['sync_falha', 'sync_nao_rodou', 'sync_fase']);
    const { notificar, upserts } = capiHealth.decidirAlertas(atuais, salvos || [], agora);
    for (const u of upserts) {
      await supabase.from('capi_monitor_estado')
        .upsert({ ...u, atualizado_em: agora.toISOString() }, { onConflict: 'gatilho,escopo' });
    }
    if (notificar.length) {
      const { data: gestores } = await supabase.from('profiles').select('id').or('roles.cs.{admin},roles.cs.{gestor}');
      for (const n of notificar) {
        const corpo = _textoAlertaSync(n) + ' — veja o detalhe no monitor.';
        for (const g of gestores || []) await criarNotificacao(g.id, 'sync_alerta', 'Alerta Sync', corpo, { url: '/sync-saude/' });
      }
      console.log('[sync-saude] alertas enviados:', notificar.map(_textoAlertaSync).join(' | '));
    }
  } catch (e) { console.error('[sync-saude] checagem falhou:', e.message); }
  finally { _syncSaudeChecando = false; }
}

setTimeout(() => syncSaudeChecarGatilhos(), 90_000);
setInterval(() => syncSaudeChecarGatilhos(), 30 * 60_000); // a cada 30 min
console.log('[sync-saude] scheduler de alertas ativo (30 min)');

app.post('/api/admin/sync-saude/recheck', requireAuth, requireGestor, async (req, res) => {
  await syncSaudeChecarGatilhos();
  try {
    res.json(syncHealth.montarSaude(await syncSaudeCarregarRows(), new Date()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 3: Verificar sintaxe + testes**

Run: `node --check server.js && npm test`
Expected: sem erro de sintaxe; testes PASS.

- [ ] **Step 4: Testar o endpoint sem token (deve barrar)**

Run (com o servidor local parado, apenas conferência estática): conferir que as duas rotas têm `requireAuth, requireGestor` na assinatura (grep):

```bash
grep -n "api/admin/sync-saude" server.js
```

Expected: 2 linhas, ambas contendo `requireAuth, requireGestor`.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(sync-saude): endpoints + tick de alerta 30min reusando dedup do CAPI"
```

---

### Task 5: página `/sync-saude/` + api.js + nav

**Files:**
- Create: `public/js/sync-saude/api.js`
- Create: `public/sync-saude/index.html`
- Modify: `public/js/nav-config.js:77` (após o item `capi-saude`)

**Interfaces:**
- Consumes: `GET /api/admin/sync-saude` e `POST /api/admin/sync-saude/recheck` (Task 4) — payload `{ jobs:[{ id, label, estado, ultima, fases:[{fase,hoje,tipico,status,msg}], erros, historico }], atualizadoEm }`.

- [ ] **Step 1: Criar `public/js/sync-saude/api.js`** (mesmo padrão do `public/js/capi-saude/api.js`)

```js
async function api(path, opts = {}) {
  let token = null;
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
      try { token = JSON.parse(localStorage.getItem(k)).access_token; } catch (e) {}
      break;
    }
  }
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) },
  });
  if (r.status === 401) { location.href = '/'; return; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('Erro ' + r.status));
  return j;
}
```

- [ ] **Step 2: Criar `public/sync-saude/index.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Saúde dos Syncs — Clínica AMA</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --border:#334155; --text:#e2e8f0; --muted:#94a3b8;
          --green:#4ade80; --yellow:#facc15; --red:#f87171; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f1f5f9; --card:#fff; --border:#e2e8f0; --text:#0f172a; --muted:#64748b; }
  }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font-family:system-ui,sans-serif; }
  main { max-width:1000px; margin:0 auto; padding:16px; }
  h1 { font-size:1.3rem; margin:8px 0 2px; }
  h2 { font-size:1.05rem; margin:22px 0 8px; display:flex; align-items:center; gap:8px; }
  .pill { padding:2px 10px; border-radius:999px; font-size:.78rem; font-weight:600; }
  .pill.ok  { background:rgba(74,222,128,.15); color:var(--green); }
  .pill.bad { background:rgba(248,113,113,.15); color:var(--red); }
  .sub { color:var(--muted); font-size:.85rem; margin-bottom:14px; }
  button { background:var(--card); color:var(--text); border:1px solid var(--border);
           border-radius:8px; padding:6px 14px; cursor:pointer; font-size:.85rem; }
  table { width:100%; border-collapse:collapse; background:var(--card);
          border:1px solid var(--border); border-radius:10px; overflow:hidden; }
  th, td { padding:8px 10px; text-align:left; font-size:.86rem; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-weight:600; font-size:.78rem; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:6px; }
  .dot.ok{background:var(--green)} .dot.bad{background:var(--red)}
  .dot.warn{background:var(--yellow)} .dot.mut{background:var(--muted)}
  .just { color:var(--muted); font-size:.8rem; padding:4px 10px 10px 26px; }
  .just b { color:var(--text); }
  .hist { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
  .hist span { font-size:.75rem; padding:3px 8px; border-radius:6px; background:var(--card);
               border:1px solid var(--border); color:var(--muted); }
  .hist span.bad { color:var(--red); border-color:var(--red); }
  .erro-item { background:var(--card); border:1px solid var(--border); border-radius:8px;
               padding:8px 10px; font-size:.82rem; margin-top:6px; color:var(--red); }
  .erro-item small { color:var(--muted); display:block; }
</style>
</head>
<body>
<main>
  <h1>🩺 Saúde dos Syncs</h1>
  <div class="sub" id="sub">carregando…</div>
  <button id="recheck">Re-checar agora</button>
  <div id="jobs"></div>
</main>
<script src="/js/sync-saude/api.js"></script>
<script>
const ESTADO_LBL = {
  ok: ['ok', '✅ rodou normal'], falhou: ['bad', '🔴 última rodada FALHOU'],
  travou: ['bad', '🔴 começou e não terminou (travou)'], nao_rodou: ['bad', '🔴 NÃO RODOU na janela de hoje'],
};
const ST = { ok:['ok','normal'], erro:['bad','ERRO'], zerou:['bad','ZEROU'],
             abaixo:['warn','abaixo do normal'], neutro:['mut','—'], sumiu:['mut','sumiu da última rodada'] };

// Verbetes: o que a fase faz · o que significa desviar · o que checar primeiro.
const FASE_INFO = {
  agendamentos: 'Puxa agendamentos do Clinicorp (30d passados + 60d futuros). Zerar quase nunca é "dia sem consulta" — desconfie da API do Clinicorp. Checar: erros na fase e se pagamentos também caiu.',
  pagamentos: 'Pagamentos dos últimos 30 dias no Clinicorp. Zerado em dia útil é implausível — provável falha da API financeira.',
  orcamentos_abertos: 'Orçamentos em aberto. Queda brusca já aconteceu por mudança no endpoint do Clinicorp (passou a exigir datas).',
  novos_pacientes: 'Cadastra pacientes novos detectados. 0 pode ser dia fraco; vários dias em 0 com clínica cheia = investigar.',
  emails_leads: 'Preenche e-mail dos leads com o cadastro do Clinicorp (alimenta o CAPI/EMQ). 0 é normal em dia sem paciente novo; desconfie se novos_pacientes também caiu.',
  pacientes_abc: 'Atualiza a base da Curva ABC. Segue agendamentos+pagamentos — se eles caíram, esta cai junto.',
  funil_config: 'Carrega a configuração do funil (avaliadores). Só alarma se der erro.',
  avaliacoes_funil: 'Avaliações do funil comercial (Dashboard/Conferência). Zerado = funil de avaliações congelado.',
  orcamentos_funil: 'Orçamentos do funil (alimenta a Conferência). Zerado = aprovações novas param de chegar.',
  producao: 'Procedimentos executados (90d) — alimenta a Análise por Dentista.',
  prevencao: 'Eventos de prevenção — alimenta Retorno de Prevenção/Curva ABC.',
  agenda: 'Consultas da agenda (90d) — alimenta ocupação e recuperação de falta. Zerado quebra a detecção de remarcação.',
  leads_vinculados: 'Liga avaliações/orçamentos aos leads por telefone. 0 pode ser normal; dias seguidos em 0 com leads novos = investigar.',
  leads_fechados: 'Avança leads para Fechou quando o orçamento aprova (dispara Purchase no CAPI). 0 é comum.',
  entradas: 'Casa o 1º pagamento dos leads fechados. 0 é comum em dia fraco.',
  avaliacoes_validas: 'Marca avaliações com orçamento em 60d. Acompanha as fases do funil.',
  fechamentos_reabertos: 'Reabre fechados cujo tratamento mudou. Quase sempre 0 — normal.',
  pendentes_notificados: 'Avisa a CRC de pendências novas na Conferência.',
  config: 'Carrega a configuração do social media. Só alarma se der erro.',
  resolver_perfis: 'Resolve os IDs de IG/página no Meta. "sem mudança" é o normal.',
  midias_dr_marcos: 'Posts do IG do Dr. Marcos + métricas. Erro (#10) = permissão do token no BM.',
  midias_ama: 'Posts do IG da Clínica AMA. "pulado (sem ig_id)" é a pendência conhecida do BM — vira número quando o acesso for liberado.',
  snapshot_dr_marcos: 'Snapshot diário de seguidores do Dr. Marcos.',
};
const GENERICO = 'Fase nova (sem verbete ainda). Se estiver 🔴/🟡, confira a mensagem de erro e compare com o típico.';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDt = iso => iso ? new Date(iso).toLocaleString('pt-BR', { timeZone:'America/Sao_Paulo' }) : '—';

function renderJob(j) {
  const [cls, lbl] = ESTADO_LBL[j.estado] || ['mut', j.estado];
  let html = `<h2>${esc(j.label)} <span class="pill ${cls === 'ok' ? 'ok' : 'bad'}">${esc(lbl)}</span></h2>`;
  if (j.ultima) html += `<div class="sub">última rodada: ${fmtDt(j.ultima.quando)} · ${esc(j.ultima.duracao_s)}s · gatilho ${esc(j.ultima.trigger)}</div>`;
  else html += `<div class="sub">nenhuma rodada registrada ainda</div>`;
  if (j.fases.length) {
    html += '<table><tr><th></th><th>Fase</th><th>Hoje</th><th>Típico</th><th>Status</th></tr>';
    const ordem = { erro:0, zerou:1, abaixo:2, sumiu:3, ok:4, neutro:5 };
    for (const f of [...j.fases].sort((a,b) => (ordem[a.status]??9) - (ordem[b.status]??9))) {
      const [dcls, dlbl] = ST[f.status] || ['mut', f.status];
      html += `<tr><td><span class="dot ${dcls}"></span></td><td>${esc(f.fase)}</td>`
        + `<td>${esc(f.hoje == null ? '—' : f.hoje)}</td><td>${esc(f.tipico == null ? '—' : f.tipico)}</td><td>${esc(dlbl)}</td></tr>`;
      if (['erro','zerou','abaixo','sumiu'].includes(f.status)) {
        const info = FASE_INFO[f.fase] || GENERICO;
        html += `<tr><td colspan="5" class="just"><b>Por que importa:</b> ${esc(info)}`
          + (f.msg ? `<br><b>Erro:</b> ${esc(f.msg)}` : '') + `</td></tr>`;
      }
    }
    html += '</table>';
  }
  if (j.erros.length) {
    html += j.erros.map(e => `<div class="erro-item">${esc(e.msg)}<small>${fmtDt(e.quando)}</small></div>`).join('');
  }
  html += '<div class="hist">' + j.historico.map(hh =>
    `<span class="${hh.ok === false ? 'bad' : ''}">${fmtDt(hh.quando).slice(0, 10)} ${hh.ok === false ? '✗' : (hh.ok ? '✓' : '…')}</span>`).join('') + '</div>';
  return html;
}

async function carregar(recheck) {
  const d = recheck ? await api('/api/admin/sync-saude/recheck', { method: 'POST' })
                    : await api('/api/admin/sync-saude');
  const ruins = d.jobs.filter(j => j.estado !== 'ok').length
    + d.jobs.reduce((n, j) => n + j.fases.filter(f => ['erro','zerou','abaixo'].includes(f.status)).length, 0);
  document.getElementById('sub').innerHTML =
    `<span class="pill ${ruins ? 'bad' : 'ok'}">${ruins ? '⚠️ ' + ruins + ' ponto(s) de atenção' : '✅ tudo normal'}</span>`
    + ` · atualizado ${fmtDt(d.atualizadoEm)}`;
  document.getElementById('jobs').innerHTML = d.jobs.map(renderJob).join('');
}

document.getElementById('recheck').onclick = () => carregar(true).catch(e => alert(e.message));
carregar().catch(e => { document.getElementById('sub').textContent = 'Erro: ' + e.message; });
</script>
<script src="/js/shared-nav.js" data-active="sync-saude"></script>
</body>
</html>
```

- [ ] **Step 3: Adicionar o item no nav**

Em `public/js/nav-config.js`, logo após a linha do `capi-saude` (linha 77), adicionar:

```js
      { slug: 'sync-saude',          label: 'Saúde dos Syncs',      roles: 'admin,gestor',                                    mode: 'link', href: '/sync-saude/' },
```

- [ ] **Step 4: Verificar sintaxe dos JS**

Run: `node --check public/js/nav-config.js && node --check public/js/sync-saude/api.js`
Expected: sem output (OK). (O index.html não passa no `node --check`; conferência visual pós-deploy.)

- [ ] **Step 5: Commit, push e deploy**

```bash
git add public/sync-saude/index.html public/js/sync-saude/api.js public/js/nav-config.js
git commit -m "feat(sync-saude): página do monitor + item na nav"
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

---

### Task 6: validação pós-deploy + pendências

**Files:** nenhum (verificações e memória).

- [ ] **Step 1: Conferir que a página está no ar e protegida**

Run: `curl -s -o /dev/null -w "%{http_code}" https://plataformaama-plataforma.uc5as5.easypanel.host/sync-saude/` → Expected: `200` (HTML estático).
Run: `curl -s -o /dev/null -w "%{http_code}" https://plataformaama-plataforma.uc5as5.easypanel.host/api/admin/sync-saude` → Expected: `401` (sem token).

- [ ] **Step 2: Conferir dados reais contra o banco**

Comparar a resposta da página (logado, ou via SQL) com:

```sql
select trigger, ok, steps from sync_log order by started_at desc limit 3;
```

A linha `ok=false` do social media (erro `#10` de 07/07) deve aparecer 🔴 na seção Social Media com a mensagem crua.

- [ ] **Step 3: Conferir o tick nos logs do Easypanel**

Nos logs do serviço, após o boot: `[sync-saude] scheduler de alertas ativo (30 min)`. Se houver problema real (ex.: o social media seguir falhando), em ~90s o primeiro tick upserta `sync_falha|social` em `capi_monitor_estado` e notifica gestores 1× (dedup 12h).

Conferir estado gravado:

```sql
select gatilho, escopo, status, ultimo_alerta_em from capi_monitor_estado
where gatilho in ('sync_falha','sync_nao_rodou','sync_fase') order by atualizado_em desc;
```

- [ ] **Step 4: Registrar pendências do Luiz**

Adicionar item no `pending_tests.md` da memória: validar logado a página `/sync-saude/` (fases vs típico, justificativas, botão Re-checar), conferir amanhã pós-02h que a rodada nova aparece, e Fase 2 (instrumentar financeiro/fluxo futuro/comparecimentos) como backlog.

- [ ] **Step 5: Validação com dia cheio (amanhã)**

Após o sync das 02h de 08/07: abrir a página e conferir que "última rodada" é de hoje e as fases têm Hoje ≈ Típico. Se o sino recebeu `sync_alerta` indevido, revisar limiares (`LIMITES` em `lib/sync/health.js`).
