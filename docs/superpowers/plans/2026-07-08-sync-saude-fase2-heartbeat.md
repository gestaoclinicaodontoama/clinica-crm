# Monitor de Saúde dos Syncs — Fase 2 (heartbeat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trazer os 4 jobs órfãos (financeiro mês, fluxo futuro, inadimplentes, comparecimentos) para a página `/sync-saude/` via batimento (heartbeat), com alerta quando pararem ou falharem.

**Architecture:** Tabela `job_health` (upsert 1 linha/job) alimentada por um helper `registrarJob` chamado em cada job; classificação de frescor pura em `lib/sync/health.js`; a página e o tick de alerta da Fase 1 ganham a seção/gatilho dos jobs.

**Tech Stack:** Node.js/Express (`server.js`), `node --test`, Supabase (project `mtqdpjhhqzvuklnlfpvi`), HTML/JS vanilla.

**Spec:** `docs/superpowers/specs/2026-07-08-sync-saude-fase2-heartbeat-design.md`

## Global Constraints

- Tabela nova nasce com RLS ligado, sem policy (regra do CLAUDE.md): `alter table job_health enable row level security;`.
- `registrarJob(ok:true)` deve rodar em TODOS os caminhos de saída bem-sucedidos. `syncComparecimentos` e `fetchInadimplentesBackground` engolem erro internamente → passam a RETORNAR `{ ok, error?, ... }` (nunca lançam); os wrappers registram pelo retorno.
- Cadências/margens (constante `JOB_HEARTBEAT` no server): `financeiro_mes`/`fluxo_futuro`/`inadimplentes` = 1440/180 min; `comparecimentos` = 10/50 min.
- Estados: `ok` | `parado` (gap > cadência+margem) | `falhou` (última ok=false) | `aguardando` (nunca rodou → sem alerta).
- Gatilho de alerta novo: `sync_job` (escopo = id do job); reusa `capiHealth.decidirAlertas` + `capi_monitor_estado` (chave `gatilho,escopo`, não colide).
- Auth: `requireAuth`+`requireGestor`. Migração via MCP Supabase (`apply_migration`), conferir `list_migrations`.
- Testes: `npm test` = `node --test "lib/**/*.test.js"`. Há 3 falhas PRÉ-EXISTENTES em `lib/monitor/crc.test.js` (alheias) — ignorar; focar em `lib/sync/health.test.js`.
- Deploy: após `git push`, `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`. Push travando → token via CredRead, `git -c credential.helper= push https://x-access-token:$TOKEN@github.com/gestaoclinicaodontoama/clinica-crm main`.

---

### Task 1: Migration — tabela `job_health`

**Files:**
- Create: `supabase/migrations/20260708120000_job_health.sql`

**Interfaces:**
- Produces: tabela `job_health` (PK `job`), lida/escrita só por service_role.

- [ ] **Step 1: Escrever a migration**

`supabase/migrations/20260708120000_job_health.sql`:

```sql
-- Batimento (heartbeat) dos jobs de fundo que só logavam no console.
-- Upsert 1 linha por job; a página /sync-saude/ lê para mostrar frescor.
create table if not exists job_health (
  job           text primary key,
  label         text not null,
  cadencia_min  integer not null,
  margem_min    integer not null,
  last_run_at   timestamptz,
  ok            boolean,
  duration_s    numeric,
  detalhe       jsonb,
  error         text,
  atualizado_em timestamptz not null default now()
);
alter table job_health enable row level security;
-- sem policy: só o servidor (service_role) acessa; front vai pelo /api.
```

- [ ] **Step 2: Aplicar via MCP**

MCP `apply_migration` (project `mtqdpjhhqzvuklnlfpvi`, name `job_health`) com o SQL acima. Depois `list_migrations` → esperado: `20260708120000` na lista.

- [ ] **Step 3: Conferir RLS ligado e sem policy**

MCP `execute_sql`:

```sql
select relrowsecurity from pg_class where relname = 'job_health';
select count(*) as policies from pg_policies where tablename = 'job_health';
```

Esperado: `relrowsecurity = true`, `policies = 0`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260708120000_job_health.sql
git commit -m "feat(sync-saude): tabela job_health para heartbeat dos jobs órfãos"
```

---

### Task 2: `lib/sync/health.js` — classificação de frescor

**Files:**
- Modify: `lib/sync/health.js` (adicionar 2 funções + exports)
- Test: `lib/sync/health.test.js` (adicionar testes)

**Interfaces:**
- Consumes: nada de novo.
- Produces (usadas nas Tasks 4):
  - `classificarJob(row, agora) → { job, label, status, ultima, idadeMin, error }` com `status ∈ 'ok'|'parado'|'falhou'|'aguardando'`. `row` traz `job,label,cadencia_min,margem_min,last_run_at,ok,error` (linha do banco OU stub com `last_run_at:null`).
  - `avaliarGatilhosJobs(rows, agora) → [{ gatilho:'sync_job', escopo:job, status:'ok'|'ruim', detalhe }]`.

- [ ] **Step 1: Escrever os testes que falham**

Adicionar ao fim de `lib/sync/health.test.js`:

```js
test('classificarJob: aguardando / falhou / parado / ok', () => {
  const agora = new Date('2026-07-08T12:00:00-03:00');
  const meta = { job: 'x', label: 'X', cadencia_min: 10, margem_min: 50 };

  // sem last_run_at → aguardando
  assert.equal(h.classificarJob({ ...meta, last_run_at: null }, agora).status, 'aguardando');

  // última falhou
  assert.equal(h.classificarJob({ ...meta, last_run_at: '2026-07-08T11:58:00-03:00', ok: false, error: 'X' }, agora).status, 'falhou');

  // parado: gap 70min > 10+50
  assert.equal(h.classificarJob({ ...meta, last_run_at: '2026-07-08T10:50:00-03:00', ok: true }, agora).status, 'parado');

  // ok: gap 5min < 60
  assert.equal(h.classificarJob({ ...meta, last_run_at: '2026-07-08T11:55:00-03:00', ok: true }, agora).status, 'ok');
});

test('classificarJob: job diário dentro de 24h+margem é ok', () => {
  const agora = new Date('2026-07-08T12:00:00-03:00');
  const diario = { job: 'financeiro_mes', label: 'Fin', cadencia_min: 1440, margem_min: 180,
                   last_run_at: '2026-07-08T02:05:00-03:00', ok: true };
  assert.equal(h.classificarJob(diario, agora).status, 'ok'); // ~10h < 27h
});

test('avaliarGatilhosJobs: parado e falhou viram ruim; aguardando e ok viram ok', () => {
  const agora = new Date('2026-07-08T12:00:00-03:00');
  const rows = [
    { job: 'a', label: 'A', cadencia_min: 10, margem_min: 50, last_run_at: '2026-07-08T10:00:00-03:00', ok: true }, // parado
    { job: 'b', label: 'B', cadencia_min: 10, margem_min: 50, last_run_at: '2026-07-08T11:59:00-03:00', ok: false, error: 'x' }, // falhou
    { job: 'c', label: 'C', cadencia_min: 10, margem_min: 50, last_run_at: '2026-07-08T11:59:00-03:00', ok: true }, // ok
    { job: 'd', label: 'D', cadencia_min: 10, margem_min: 50, last_run_at: null }, // aguardando
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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/sync/health.test.js`
Expected: FAIL — `h.classificarJob is not a function`.

- [ ] **Step 3: Implementar**

Adicionar ao `lib/sync/health.js` (antes do `module.exports`):

```js
function classificarJob(row, agora = new Date()) {
  const base = { job: row.job, label: row.label, ultima: row.last_run_at || null, error: row.error || null };
  if (!row.last_run_at) return { ...base, status: 'aguardando', idadeMin: null };
  const idadeMin = (agora.getTime() - new Date(row.last_run_at).getTime()) / 60000;
  if (row.ok === false) return { ...base, status: 'falhou', idadeMin };
  if (idadeMin > (row.cadencia_min + row.margem_min)) return { ...base, status: 'parado', idadeMin };
  return { ...base, status: 'ok', idadeMin };
}

function avaliarGatilhosJobs(rows, agora = new Date()) {
  return (rows || []).map(row => {
    const c = classificarJob(row, agora);
    const ruim = c.status === 'parado' || c.status === 'falhou';
    return {
      gatilho: 'sync_job', escopo: c.job, status: ruim ? 'ruim' : 'ok',
      detalhe: { estado: c.status, idadeMin: c.idadeMin != null ? Math.round(c.idadeMin) : null, error: c.error },
    };
  });
}
```

E acrescentar `classificarJob, avaliarGatilhosJobs` ao objeto exportado no `module.exports`.

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/sync/health.test.js`
Expected: PASS em todos (os testes da Fase 1 seguem passando).

- [ ] **Step 5: Commit**

```bash
git add lib/sync/health.js lib/sync/health.test.js
git commit -m "feat(sync-saude): classificarJob + avaliarGatilhosJobs (frescor dos jobs)"
```

---

### Task 3: `registrarJob` + instrumentar os 4 jobs (`server.js`)

**Files:**
- Modify: `server.js` — `syncComparecimentos` (~4021), `fetchInadimplentesBackground` (~3752), bloco do scheduler (~4952-4967), setInterval do comparecimentos (~4101), e um ponto de topo para `JOB_HEARTBEAT`+`registrarJob`.

**Interfaces:**
- Consumes: `supabase` (existente).
- Produces: `JOB_HEARTBEAT` (metadados), `registrarJob(job, {ok,durationS?,detalhe?,error?})`; `syncComparecimentos()` e `fetchInadimplentesBackground()` passam a retornar `{ ok, error?, ... }`.

- [ ] **Step 1: Definir `JOB_HEARTBEAT` + `registrarJob`**

Inserir imediatamente antes de `// ── Sync diário Clinicorp: self-healing` (linha ~4924):

```js
// ── Heartbeat dos jobs de fundo (Fase 2 do monitor de syncs) ────────────────
const JOB_HEARTBEAT = {
  financeiro_mes:  { label: 'Financeiro (mês corrente)',              cadenciaMin: 1440, margemMin: 180 },
  fluxo_futuro:    { label: 'Fluxo futuro 24m (A Receber/Pagar)',     cadenciaMin: 1440, margemMin: 180 },
  inadimplentes:   { label: 'Financeiro por paciente / Inadimplentes', cadenciaMin: 1440, margemMin: 180 },
  comparecimentos: { label: 'Detecção de comparecimento',            cadenciaMin: 10,   margemMin: 50 },
};

async function registrarJob(job, resultado) {
  const meta = JOB_HEARTBEAT[job];
  if (!meta) return;
  try {
    const agora = new Date().toISOString();
    await supabase.from('job_health').upsert({
      job, label: meta.label, cadencia_min: meta.cadenciaMin, margem_min: meta.margemMin,
      last_run_at: agora, ok: resultado.ok,
      duration_s: resultado.durationS ?? null, detalhe: resultado.detalhe ?? null,
      error: resultado.error ?? null, atualizado_em: agora,
    }, { onConflict: 'job' });
  } catch (e) { console.error('[registrarJob] ' + job + ':', e.message); }
}
```

- [ ] **Step 2: `syncComparecimentos` passa a retornar resultado**

Em `server.js`, os pontos de saída de `syncComparecimentos`:

- Linha 4022 `if (!process.env.CLINICORP_TOKEN) return;` → `if (!process.env.CLINICORP_TOKEN) return { ok: true, movidos: 0 };`
- Adicionar um contador: logo após `const PRE_COMPARECEU = [...]` no topo do corpo, declarar `let _movidos = 0;` NÃO — em vez de contador global, contar nos dois pontos de update. Simplesmente: nos dois `await supabase.from('leads').update({ status:'Compareceu' ...})` (linhas 4060 e 4091), preceder com um contador. Implementação mínima: declarar `let movidos = 0;` logo após a linha 4024 (`const PRE_COMPARECEU = ...`), e trocar cada `await supabase.from('leads').update({ status: 'Compareceu', ... })` por `movidos++; await supabase.from('leads').update({ status: 'Compareceu', ... })`.
- Linha 4079 `if (!phones11.length) return;` → `if (!phones11.length) return { ok: true, movidos };`
- No fim do try (após o `for` da Phase 2, antes do `} catch`): adicionar `return { ok: true, movidos };`
- O `catch(e)` (linha 4098) → trocar `console.error('[sync-compareceu]', e.message);` por `console.error('[sync-compareceu]', e.message); return { ok: false, error: e.message };`

- [ ] **Step 3: `fetchInadimplentesBackground` passa a retornar resultado**

- Linha 3753 `if (_inadimplentesRefreshing) return;` → `if (_inadimplentesRefreshing) return { ok: true, skipped: true };`
- No fim do try (após a linha 3795 `gravarSnapshotSaude` bloco, antes do `} catch`): adicionar `return { ok: true, pacientes: processado.totais.pacientes };`
- O `catch(e)` (linha 3797) → adicionar `return { ok: false, error: e.message };` após o `console.error`.
- (O `finally` que zera `_inadimplentesRefreshing` continua igual — `return` dentro de try executa o finally normalmente.)

- [ ] **Step 4: Instrumentar o comparecimentos (setInterval ~4101)**

Trocar:

```js
setInterval(syncComparecimentos, 10 * 60 * 1000);
```

por:

```js
setInterval(async () => {
  const t0 = Date.now();
  const r = await syncComparecimentos();
  await registrarJob('comparecimentos', {
    ok: r.ok, durationS: (Date.now() - t0) / 1000,
    detalhe: r.movidos != null ? { movidos: r.movidos } : null, error: r.error,
  });
}, 10 * 60 * 1000);
```

- [ ] **Step 5: Instrumentar os 3 jobs diários (scheduler ~4952-4967)**

Trocar o trecho:

```js
    // sync financeiro do mês corrente — mesma janela diária, sem derrubar o processo
    try {
      const { from, to } = _finMesCorrente();
      await syncFinanceiro(from, to);
      console.log('[financeiro-sync] mês corrente sincronizado');
      // Atualiza o resumo mensal materializado (só os meses recentes; passados não mudam)
      await supabase.rpc('fin_series_cache_refresh', { p_from: from, p_to: _finDataLocal(new Date()) });
      console.log('[fin-series-cache] meses recentes atualizados');
    } catch (e) { console.error('[financeiro-sync] erro:', e.message); }
    // A Receber / A Pagar (24m) — 1 chamada list_cash_flow, erro não derruba as demais fases
    try {
      await syncFluxoFuturo();
      console.log('[fluxo-futuro] 24m sincronizado');
    } catch (e) { console.error('[fluxo-futuro] erro:', e.message); }
    // Financeiro por paciente + inadimplentes (/payment/list) — diário, não só sob demanda.
    try { await fetchInadimplentesBackground(); }
    catch (e) { console.error('[inadimplentes-diario] erro:', e.message); }
```

por:

```js
    // sync financeiro do mês corrente — mesma janela diária, sem derrubar o processo
    try {
      const t0 = Date.now();
      const { from, to } = _finMesCorrente();
      await syncFinanceiro(from, to);
      console.log('[financeiro-sync] mês corrente sincronizado');
      // Atualiza o resumo mensal materializado (só os meses recentes; passados não mudam)
      await supabase.rpc('fin_series_cache_refresh', { p_from: from, p_to: _finDataLocal(new Date()) });
      console.log('[fin-series-cache] meses recentes atualizados');
      await registrarJob('financeiro_mes', { ok: true, durationS: (Date.now() - t0) / 1000 });
    } catch (e) { console.error('[financeiro-sync] erro:', e.message); await registrarJob('financeiro_mes', { ok: false, error: e.message }); }
    // A Receber / A Pagar (24m) — 1 chamada list_cash_flow, erro não derruba as demais fases
    try {
      const t0 = Date.now();
      await syncFluxoFuturo();
      console.log('[fluxo-futuro] 24m sincronizado');
      await registrarJob('fluxo_futuro', { ok: true, durationS: (Date.now() - t0) / 1000 });
    } catch (e) { console.error('[fluxo-futuro] erro:', e.message); await registrarJob('fluxo_futuro', { ok: false, error: e.message }); }
    // Financeiro por paciente + inadimplentes (/payment/list) — diário, não só sob demanda.
    try {
      const t0 = Date.now();
      const r = await fetchInadimplentesBackground();
      await registrarJob('inadimplentes', { ok: r.ok, durationS: (Date.now() - t0) / 1000, detalhe: r.pacientes != null ? { pacientes: r.pacientes } : null, error: r.error });
    } catch (e) { console.error('[inadimplentes-diario] erro:', e.message); await registrarJob('inadimplentes', { ok: false, error: e.message }); }
```

- [ ] **Step 6: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem output (OK).

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat(sync-saude): registrarJob + instrumenta os 4 jobs (retorno de resultado nos que engolem erro)"
```

---

### Task 4: endpoint + tick incluem os jobs heartbeat (`server.js`)

**Files:**
- Modify: `server.js` — bloco do Monitor de Saúde dos Syncs (endpoints + `syncSaudeChecarGatilhos` + `_textoAlertaSync`).

**Interfaces:**
- Consumes: `syncHealth.classificarJob`, `syncHealth.avaliarGatilhosJobs` (Task 2); `JOB_HEARTBEAT`, `registrarJob` (Task 3).
- Produces: resposta de `/api/admin/sync-saude` com `jobsHeartbeat`; alerta do gatilho `sync_job`.

- [ ] **Step 1: Extrair um montador combinado e usar nos 2 endpoints**

Substituir o handler do GET:

```js
app.get('/api/admin/sync-saude', requireAuth, requireGestor, async (req, res) => {
  try {
    res.json(syncHealth.montarSaude(await syncSaudeCarregarRows(), new Date()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

por:

```js
async function syncSaudeMontar(agora) {
  const saude = syncHealth.montarSaude(await syncSaudeCarregarRows(), agora);
  const { data: jobRows } = await supabase.from('job_health').select('*');
  const mapa = Object.fromEntries((jobRows || []).map(r => [r.job, r]));
  saude.jobsHeartbeat = Object.entries(JOB_HEARTBEAT).map(([job, meta]) =>
    syncHealth.classificarJob(mapa[job] || {
      job, label: meta.label, cadencia_min: meta.cadenciaMin, margem_min: meta.margemMin,
      last_run_at: null, ok: null, error: null,
    }, agora));
  return saude;
}

app.get('/api/admin/sync-saude', requireAuth, requireGestor, async (req, res) => {
  try {
    res.json(await syncSaudeMontar(new Date()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 2: `_textoAlertaSync` ganha o rótulo de `sync_job`**

No objeto `map` de `_textoAlertaSync`, adicionar a linha:

```js
    sync_job: 'Job de fundo parado ou falhou',
```

- [ ] **Step 3: Tick soma os gatilhos de job**

Em `syncSaudeChecarGatilhos`, trocar:

```js
    const agora = new Date();
    const atuais = syncHealth.avaliarGatilhosSync(await syncSaudeCarregarRows(), agora);
    const { data: salvos } = await supabase.from('capi_monitor_estado').select('*')
      .in('gatilho', ['sync_falha', 'sync_nao_rodou', 'sync_fase']);
```

por:

```js
    const agora = new Date();
    const { data: jobRows } = await supabase.from('job_health').select('*');
    const atuais = [
      ...syncHealth.avaliarGatilhosSync(await syncSaudeCarregarRows(), agora),
      ...syncHealth.avaliarGatilhosJobs(jobRows || [], agora),
    ];
    const { data: salvos } = await supabase.from('capi_monitor_estado').select('*')
      .in('gatilho', ['sync_falha', 'sync_nao_rodou', 'sync_fase', 'sync_job']);
```

- [ ] **Step 4: `/recheck` usa o montador combinado**

No handler `POST /api/admin/sync-saude/recheck`, trocar a resposta:

```js
    res.json(syncHealth.montarSaude(await syncSaudeCarregarRows(), new Date()));
```

por:

```js
    res.json(await syncSaudeMontar(new Date()));
```

- [ ] **Step 5: Verificar sintaxe + testes**

Run: `node --check server.js && node --test lib/sync/health.test.js`
Expected: sem erro de sintaxe; testes PASS.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(sync-saude): endpoint e tick incluem os jobs heartbeat (gatilho sync_job)"
```

---

### Task 5: seção "Outros jobs" na página

**Files:**
- Modify: `public/sync-saude/index.html`

**Interfaces:**
- Consumes: `d.jobsHeartbeat: [{ job, label, status, ultima, idadeMin, error }]` (Task 4).

- [ ] **Step 1: Adicionar `JOB_INFO`, o render e a chamada**

No `<script>` de `public/sync-saude/index.html`, após a constante `GENERICO`, adicionar:

```js
const JOB_ST = { ok:['ok','🟢 no ar'], parado:['bad','🔴 parado'], falhou:['bad','🔴 última falhou'], aguardando:['mut','⚪ aguardando 1ª execução'] };
const JOB_INFO = {
  financeiro_mes: 'Sincroniza o mês corrente do Financeiro/DRE e atualiza o cache das séries. Parado = DRE do mês pode ficar defasada.',
  fluxo_futuro: 'Reconstrói A Receber / A Pagar (24 meses). Parado = a página do fluxo mostra dados velhos.',
  inadimplentes: 'Financeiro por paciente + inadimplência (via /payment/list). Parado = inadimplência e perfis financeiros defasados.',
  comparecimentos: 'A cada 10 min detecta no Clinicorp quem compareceu e avança o lead. Parado = comparecimentos deixam de virar "Compareceu" no funil.',
};
function fmtIdade(min) {
  if (min == null) return '';
  if (min < 90) return 'há ' + Math.round(min) + ' min';
  if (min < 60 * 48) return 'há ' + Math.round(min / 60) + ' h';
  return 'há ' + Math.round(min / 1440) + ' d';
}
function renderHeartbeat(list) {
  if (!list || !list.length) return '';
  let html = '<h2>Outros jobs (batimento)</h2><table><tr><th></th><th>Job</th><th>Última</th><th>Status</th></tr>';
  const ordem = { falhou:0, parado:1, aguardando:2, ok:3 };
  for (const j of [...list].sort((a,b) => (ordem[a.status]??9) - (ordem[b.status]??9))) {
    const [cls, lbl] = JOB_ST[j.status] || ['mut', j.status];
    html += `<tr><td><span class="dot ${cls}"></span></td><td>${esc(j.label)}</td>`
      + `<td>${j.ultima ? esc(fmtIdade(j.idadeMin)) : '—'}</td><td>${esc(lbl)}</td></tr>`;
    if (['parado','falhou'].includes(j.status)) {
      html += `<tr><td colspan="4" class="just"><b>Por que importa:</b> ${esc(JOB_INFO[j.job] || GENERICO)}`
        + (j.error ? `<br><b>Erro:</b> ${esc(j.error)}` : '') + `</td></tr>`;
    }
  }
  return html + '</table>';
}
```

- [ ] **Step 2: Chamar o render e incluir os jobs na contagem de atenção**

Na função `carregar`, trocar:

```js
  const ruins = d.jobs.filter(j => j.estado !== 'ok').length
    + d.jobs.reduce((n, j) => n + j.fases.filter(f => ['erro','zerou','abaixo'].includes(f.status)).length, 0);
```

por:

```js
  const ruins = d.jobs.filter(j => j.estado !== 'ok').length
    + d.jobs.reduce((n, j) => n + j.fases.filter(f => ['erro','zerou','abaixo'].includes(f.status)).length, 0)
    + (d.jobsHeartbeat || []).filter(j => ['parado','falhou'].includes(j.status)).length;
```

E trocar:

```js
  document.getElementById('jobs').innerHTML = d.jobs.map(renderJob).join('');
```

por:

```js
  document.getElementById('jobs').innerHTML = d.jobs.map(renderJob).join('') + renderHeartbeat(d.jobsHeartbeat);
```

- [ ] **Step 3: Verificar sintaxe (extração do script não é trivial; validar via node -c num arquivo temporário)**

Como o JS está inline no HTML, conferir por inspeção que: `renderHeartbeat` está definido antes de ser chamado em `carregar`, e que `JOB_ST`/`JOB_INFO`/`fmtIdade` não colidem com nomes já existentes (`ST`, `FASE_INFO`, `fmtDt` são distintos). Nenhum `node --check` no HTML.

- [ ] **Step 4: Commit, push e deploy**

```bash
git add public/sync-saude/index.html
git commit -m "feat(sync-saude): seção 'Outros jobs (batimento)' na página"
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

---

### Task 6: validação pós-deploy + pendências

**Files:** nenhum.

- [ ] **Step 1: Página no ar + endpoint protegido**

Run:
```bash
base="https://plataformaama-plataforma.uc5as5.easypanel.host"
curl -s -o /dev/null -w "%{http_code}\n" "$base/sync-saude/"           # 200
curl -s -o /dev/null -w "%{http_code}\n" "$base/api/admin/sync-saude"   # 401
```

- [ ] **Step 2: Conferir o batimento nascendo (via node + service_role)**

Após ~1-2 min do deploy (o boot roda o `verificarEExecutar` em 30s; o comparecimentos em 10 min):

```bash
node -e "require('dotenv').config();const {createClient}=require('@supabase/supabase-js');const s=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);s.from('job_health').select('job,ok,last_run_at,error').then(({data})=>{console.log(data);process.exit(0)});"
```

Esperado: com o tempo, `comparecimentos` aparece com `ok=true` e `last_run_at` recente. Os 3 diários só aparecem após o sync das 02h (ou um sync manual) — até lá ficam ausentes → a página mostra ⚪ "aguardando 1ª execução".

- [ ] **Step 3: Forçar os diários agora (opcional) para validar sem esperar as 02h**

`POST /api/admin/sync-clinicorp` (ou o gatilho manual existente) dispara o scheduler que roda financeiro/fluxo/inadimplentes; depois repetir o SELECT do Step 2 e conferir as 4 linhas em `job_health`.

- [ ] **Step 4: Conferir a página (logado)**

Abrir `/sync-saude/` → seção "Outros jobs (batimento)" com os 4; `comparecimentos` 🟢 no ar; diários 🟢 se já rodaram (ou ⚪ aguardando). Rodar `select * from job_health` e bater com a tela.

- [ ] **Step 5: Registrar pendência na memória**

Atualizar o item do monitor de syncs em `pending_tests.md`: Fase 2 deployada — validar a seção "Outros jobs" logado; conferir amanhã pós-02h que os 3 diários viram 🟢; se algum ficar ⚪/🔴 sem motivo, revisar `JOB_HEARTBEAT` (cadência/margem) no server.
