# Monitor de Saúde dos Syncs — Fase 2 (heartbeat dos jobs órfãos) — Design

**Data:** 2026-07-08
**Status:** aprovado (brainstorming) — aguardando revisão do spec

## Objetivo e contexto

A Fase 1 (`/sync-saude/`) monitora o que grava no `sync_log`: o sync Clinicorp das 02h
(multi-fase) e o social media. Ficaram de fora os jobs que hoje só logam no console —
invisíveis quando falham. A Fase 2 os traz pra mesma página via **batimento
(heartbeat)**: cada job registra sua última execução, e a saúde é **frescor** ("rodou
dentro da cadência esperada?") + resultado da última rodada.

**Jobs órfãos (4), descobertos no `server.js`:**

| Job (id) | Cadência | Onde roda |
|---|---|---|
| `financeiro_mes` (syncFinanceiro + `fin_series_cache_refresh`) | diária (~02h) | dentro do `agendarSyncDiario`, try/catch |
| `fluxo_futuro` (`syncFluxoFuturo`, A Receber/Pagar 24m) | diária (~02h) | idem |
| `inadimplentes` (`fetchInadimplentesBackground`, financeiro por paciente) | diária (~02h) | idem |
| `comparecimentos` (`syncComparecimentos`, detecta "Compareceu") | a cada 10 min | `setInterval` próprio |

## Decisões (do brainstorming)

- **Modelo heartbeat, não fase-vs-típico:** jobs de propósito único; a métrica é frescor.
- **Tabela nova `job_health`** (upsert 1 linha/job) — não poluir o `sync_log` (o
  `comparecimentos` roda 144×/dia).
- **Mesma página e mesmo alerta** da Fase 1 (tick de 30 min, dedup via
  `capi_monitor_estado`).
- **Fora de escopo:** notificadores puros (resumo CRC, varreduras, mensagens agendadas)
  — não puxam dados; entram depois se sentir falta.

## Componentes

### 1. Tabela `job_health` (migration)

```sql
create table if not exists job_health (
  job          text primary key,
  label        text not null,
  cadencia_min integer not null,        -- gap máximo esperado entre execuções
  margem_min   integer not null,        -- folga antes de considerar "parado"
  last_run_at  timestamptz,
  ok           boolean,
  duration_s   numeric,
  detalhe      jsonb,
  error        text,
  atualizado_em timestamptz not null default now()
);
alter table job_health enable row level security;
-- sem policy: só o servidor (service_role) lê/escreve; front acessa via /api.
```

### 2. `registrarJob(job, resultado)` — helper no `server.js`

```js
// resultado: { ok, durationS?, detalhe?, error? }
async function registrarJob(job, resultado) {
  const meta = JOB_HEARTBEAT[job];                 // { label, cadenciaMin, margemMin }
  if (!meta) return;
  try {
    await supabase.from('job_health').upsert({
      job, label: meta.label, cadencia_min: meta.cadenciaMin, margem_min: meta.margemMin,
      last_run_at: new Date().toISOString(),
      ok: resultado.ok, duration_s: resultado.durationS ?? null,
      detalhe: resultado.detalhe ?? null, error: resultado.error ?? null,
      atualizado_em: new Date().toISOString(),
    }, { onConflict: 'job' });
  } catch (e) { console.error('[registrarJob] ' + job + ':', e.message); }
}
```

`JOB_HEARTBEAT` (constante no server, fonte da verdade dos metadados):

```js
const JOB_HEARTBEAT = {
  financeiro_mes:  { label: 'Financeiro (mês corrente)',      cadenciaMin: 1440, margemMin: 180 },
  fluxo_futuro:    { label: 'Fluxo futuro 24m (A Receber/Pagar)', cadenciaMin: 1440, margemMin: 180 },
  inadimplentes:   { label: 'Financeiro por paciente / Inadimplentes', cadenciaMin: 1440, margemMin: 180 },
  comparecimentos: { label: 'Detecção de comparecimento',     cadenciaMin: 10,   margemMin: 50 },
};
```

### 3. Instrumentação dos 4 jobs

**Regra crítica (aprendida na Fase 1):** o `registrarJob(ok:true)` roda em **TODOS os
caminhos de saída bem-sucedidos**, inclusive `return` cedo — senão o job fica "parado"
eterno. Padrão: `try { …; registrarJob(job, {ok:true, …}) } catch(e) { registrarJob(job, {ok:false, error:e.message}) }`.
Para funções com `return` no meio (`syncComparecimentos`, `fetchInadimplentesBackground`),
envolver o corpo num wrapper que registra no `finally` com base numa flag de erro, OU
mover o `registrarJob` para o ponto único de chamada e capturar sucesso/erro ali.

- **financeiro_mes / fluxo_futuro / inadimplentes:** já são chamados em blocos try/catch
  isolados dentro do `agendarSyncDiario` (server.js ~4952–4967). Cada bloco ganha
  `registrarJob('<job>', {ok:true, durationS})` no fim do try e
  `registrarJob('<job>', {ok:false, error:e.message})` no catch.
- **comparecimentos:** o `setInterval(syncComparecimentos, 10min)` passa a chamar um
  wrapper: mede início, `await syncComparecimentos()`, `registrarJob('comparecimentos',
  {ok:true, durationS})`; em erro, `{ok:false, error}`. Como `syncComparecimentos` já
  tem seu próprio try/catch interno que engole erros e dá `return`, o wrapper considera
  "ok" toda execução que não lançar — coerente com o design atual (a função nunca lança).

### 4. Classificação de frescor — `lib/sync/health.js` (pura, testável)

```js
// row: linha de job_health (ou undefined). agora: Date.
// → { job, label, status, ultima, idadeMin, error }
//   status ∈ 'ok' | 'parado' | 'falhou' | 'aguardando'
function classificarJob(row, agora) { … }
```

Regras:
- `row` ausente ou `last_run_at` nulo → `aguardando` (nunca rodou; sem alarme).
- última `ok === false` → `falhou` (mostra `error`).
- `agora - last_run_at > (cadencia_min + margem_min)` min → `parado` (mostra "há X").
- senão → `ok`.

E `avaliarGatilhosJobs(rows, agora)` → gatilhos `{ gatilho:'sync_job', escopo:job,
status:'ruim'|'ok', detalhe }` (ruim se `parado` ou `falhou`; `aguardando` = ok).

### 5. Endpoint + página + alerta (estende a Fase 1)

- **`GET /api/admin/sync-saude`** passa a incluir `jobsHeartbeat: [classificarJob(...)]`
  lendo `job_health` (`select *`), além dos `jobs` de fase que já retorna.
- **Tick** `syncSaudeChecarGatilhos` soma `avaliarGatilhosJobs` aos gatilhos atuais e
  amplia o `.in('gatilho', [...])` com `'sync_job'`. `_textoAlertaSync` ganha
  `sync_job: 'Job parado ou falhou'`.
- **Página `/sync-saude/`:** nova seção **"Outros jobs (batimento)"** abaixo dos dois
  syncs — um card por job: `label` · "última há X" · pill 🟢 no ar / 🔴 parado há X /
  🔴 última falhou / ⚪ aguardando 1ª execução. Verbete fixo por job (`JOB_INFO` no
  frontend): o que faz · o que significa parar · o que checar.

## Casos de borda e tratamento de erro

| Caso | Comportamento |
|---|---|
| Job nunca registrou (linha ausente) | ⚪ `aguardando` — sem alerta |
| `syncComparecimentos` deu `return` cedo (sem checkin) | conta como sucesso — o wrapper só marca falha se lançar |
| Deploy/restart cria buraco no `comparecimentos` | margem 50min (total 60 = 6 ciclos) evita falso positivo |
| `registrarJob` falhou (banco fora) | try/catch interno loga e segue; não derruba o job |
| Job diário rodou mas outro do mesmo scheduler falhou | cada job tem seu registro isolado |
| Gatilho `sync_job` na `capi_monitor_estado` | chave `(gatilho, escopo)` — não colide com `sync_falha/_fase/_nao_rodou` nem com os do CAPI |

## Testes (TDD — em `lib/sync/health.test.js`)

- `classificarJob`: ausente→aguardando; last_run nulo→aguardando; ok=false→falhou;
  gap > cadência+margem→parado; dentro da folga→ok.
- `avaliarGatilhosJobs`: parado→ruim; falhou→ruim; aguardando→ok; ok→ok; formato aceito
  pelo `decidirAlertas`.
- Integração leve: `montarSaude` (ou o campo novo) inclui `jobsHeartbeat` a partir de
  linhas semeadas.

**Validação manual pós-deploy:** aplicar migration; após o 1º ciclo, conferir
`select * from job_health` (4 linhas); abrir `/sync-saude/` → seção "Outros jobs" com os
4 no ar (comparecimentos deve bater dentro de ~10min; os diários aparecem "aguardando"
até as 02h ou um sync manual). Forçar um erro controlado não é necessário: o caminho de
alerta já é coberto pelo `decidirAlertas` (Fase 1) + os testes de `avaliarGatilhosJobs`.

## Fora de escopo

- Notificadores puros (resumo CRC, varredura aguardando/parados, mensagens agendadas).
- Histórico/tendência por job (o heartbeat guarda só a última execução; sync_log já dá
  histórico dos dois grandes).
- Detalhe rico por job (contagens) além de um resumo curto opcional em `detalhe`.
