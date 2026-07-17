# Auditoria de Registro Clínico Diário — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Página "Registro Diário" no CRM que cruza, por dia, quem foi atendido (agenda) com o que foi registrado como executado (produção), expondo atendimentos sem registro.

**Architecture:** 2 colunas novas em `agenda_appointments` preenchidas pelo `syncAgenda()` existente (zero chamadas novas à API Clinicorp); função pura de classificação em `lib/producao/registro.js` (testável); endpoint `GET /api/producao/auditoria-registro` no `server.js`; página nova `public/producao/registro/` no padrão das irmãs.

**Tech Stack:** Node.js + Express, Supabase (service_role no servidor), HTML/CSS/JS vanilla, `node --test`.

**Spec:** `docs/superpowers/specs/2026-07-16-auditoria-registro-clinico-design.md`

## Global Constraints

- Front vanilla, sem framework. Comentários/UI em pt-BR, sem siglas financeiras.
- Toda tabela nova/coluna: RLS já ativo em `agenda_appointments`; front NÃO lê tabela direto — tudo via `/api` (service_role).
- Migrações: arquivo em `supabase/migrations/` + aplicar via MCP Supabase (project `mtqdpjhhqzvuklnlfpvi`); verificar com `list_migrations`.
- Roles do endpoint: `requireAuth, requireProducao` (`requireProducao` já existe em `server.js:451` = `financeiro, admin, mod_financeiro, mod_producao`).
- Menu: editar SOMENTE `public/js/nav-config.js` (fonte única).
- Retry 5xx no front: 2 tentativas extras, 1,5s/3s.
- Deploy: `git push` + `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"` sem perguntar.
- ⚠️ Working dir concorrente: há mudanças não commitadas de outra sessão (`lib/financeiro/receita-motor.*`). NUNCA incluí-las em commits (`git add` sempre por caminho explícito).

---

### Task 1: Migração — colunas `status_id` e `compareceu` em `agenda_appointments`

**Files:**
- Create: `supabase/migrations/20260717090000_agenda_status_compareceu.sql`

**Interfaces:**
- Produces: colunas `agenda_appointments.status_id text` e `agenda_appointments.compareceu boolean` (nullable — `NULL` = sincronizado antes do deploy, ainda sem status), usadas pelas Tasks 2 e 4.

- [ ] **Step 1: Escrever o arquivo de migração**

```sql
-- supabase/migrations/20260717090000_agenda_status_compareceu.sql
-- Auditoria de registro clínico: syncAgenda passa a gravar o StatusId do
-- /appointment/list e o derivado compareceu (checkin OU status marcado em
-- config_status_compareceu). NULL = linha ainda não re-sincronizada.
ALTER TABLE agenda_appointments
  ADD COLUMN IF NOT EXISTS status_id  text,
  ADD COLUMN IF NOT EXISTS compareceu boolean;
-- Sem índice novo: o endpoint filtra por appointment_date (índice
-- agenda_appointments_date_idx já existe) e decide compareceu no JS.
```

- [ ] **Step 2: Aplicar via MCP Supabase**

`mcp__plugin_supabase_supabase__apply_migration` com `project_id: mtqdpjhhqzvuklnlfpvi`, `name: agenda_status_compareceu`, query = conteúdo acima.

- [ ] **Step 3: Verificar**

`mcp__plugin_supabase_supabase__execute_sql`:
```sql
select column_name from information_schema.columns
where table_name = 'agenda_appointments' and column_name in ('status_id','compareceu');
```
Expected: 2 linhas.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260717090000_agenda_status_compareceu.sql
git commit -m "feat(auditoria-registro): colunas status_id/compareceu em agenda_appointments"
```

---

### Task 2: `syncAgenda()` grava `status_id` e `compareceu`

**Files:**
- Modify: `sync/clinicorp-sync.js` (função `syncAgenda`, ~linha 629; chamada em `runSync`, ~linha 960)

**Interfaces:**
- Consumes: `loadFunilConfig()` já retorna `{ ids, nomeById, statusCompareceu: Set<string> }` (linha 356) e `runSync` já o carrega como `funilCfg` (linha 941) ANTES da fase `agenda` (linha 960).
- Produces: linhas de `agenda_appointments` com `status_id` e `compareceu` preenchidos. O sync rebusca 90 dias toda noite → primeira execução pós-deploy preenche o histórico sozinha.

- [ ] **Step 1: Passar `cfg` para `syncAgenda` e gravar os 2 campos**

Em `sync/clinicorp-sync.js`, mudar a assinatura (linha 629):

```js
async function syncAgenda(cfg) {
```

Dentro do loop `for (const a of raw)`, logo após `const apptId = ...` / dedup, adicionar a extração do status e incluir os 2 campos no `rows.push` (que hoje termina em `atualizado_em`):

```js
    const statusId = String(a.StatusId || '');

    rows.push({
      clinicorp_appt_id:  apptId,
      dentist_person_id:  a.Dentist_PersonId ? String(a.Dentist_PersonId) : null,
      dentist_name:       a.DentistName || a.ProfessionalName || null,
      patient_name:       a.PatientName || null,
      paciente_clinicorp_id: String(a.Patient_PersonId || a.PatientId || ''),
      appointment_date:   apptDate,
      from_time:          fromTime,
      to_time:            toTime,
      duration_minutes:   (dur !== null && dur >= 0) ? dur : null,
      category:           a.CategoryDescription || null,
      checkin_time:       a.CheckinTime || null,
      deleted:            (a.Deleted || '') === 'X',
      status_id:          statusId || null,
      // mesma regra validada do syncAvaliacoes (linha 401)
      compareceu:         !!a.CheckinTime || cfg.statusCompareceu.has(statusId),
      atualizado_em:      new Date().toISOString(),
    });
```

- [ ] **Step 2: Passar `funilCfg` na chamada em `runSync`**

Na fase `agenda` (~linha 962), trocar:

```js
    const r = await syncAgenda(funilCfg);
```

(Obs.: se a fase `funil_config` falhar, o fallback já é `{ statusCompareceu: new Set() }` — `compareceu` degrada para "só check-in", sem quebrar.)

- [ ] **Step 3: Checagem estática**

Run: `node -e "const s = require('./sync/clinicorp-sync'); console.log(typeof s.syncAgenda)"`
Expected: `function` (sem erro de sintaxe).

- [ ] **Step 4: Commit**

```bash
git add sync/clinicorp-sync.js
git commit -m "feat(auditoria-registro): syncAgenda grava status_id e compareceu"
```

---

### Task 3: Função pura `classificarDia` (TDD)

**Files:**
- Create: `lib/producao/registro.js`
- Test: `lib/producao/registro.test.js`

**Interfaces:**
- Produces: `classificarDia({ atendimentos, producao })` → `{ resumo, sem_registro, com_registro, manutencao }`, consumida pela Task 4.
  - `atendimentos`: linhas de `agenda_appointments` do dia (`paciente_clinicorp_id, patient_name, dentist_name, from_time, to_time, category, compareceu`) — o SQL já filtra `deleted=false`; a função filtra `compareceu` e categorias.
  - `producao`: linhas de `producao_procedimentos` do dia (`paciente_clinicorp_id, procedure_name, dentist_name`).
  - Item de saída: `{ paciente, paciente_clinicorp_id, dentista, horario, categoria, registrado, sem_id, procedimentos }`.
  - `resumo`: `{ atendidos, registrados, pendentes, por_dentista: [{ dentista, atendidos, registrados, pendentes }] }` — só grupo clínico (manutenção fora da conta).

- [ ] **Step 1: Escrever os testes (falhando)**

```js
// lib/producao/registro.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { classificarDia } = require('./registro');

const at = (over = {}) => ({
  paciente_clinicorp_id: 'P1', patient_name: 'Ana', dentist_name: 'Dr. A',
  from_time: '09:00', to_time: '10:00', category: null, compareceu: true, ...over,
});

test('atendido com procedimento no dia → com_registro, com lista de procedimentos', () => {
  const r = classificarDia({
    atendimentos: [at()],
    producao: [{ paciente_clinicorp_id: 'P1', procedure_name: 'Restauração', dentist_name: 'Dr. A' }],
  });
  assert.strictEqual(r.com_registro.length, 1);
  assert.strictEqual(r.sem_registro.length, 0);
  assert.deepStrictEqual(r.com_registro[0].procedimentos, ['Restauração']);
  assert.deepStrictEqual(r.resumo, {
    atendidos: 1, registrados: 1, pendentes: 0,
    por_dentista: [{ dentista: 'Dr. A', atendidos: 1, registrados: 1, pendentes: 0 }],
  });
});

test('atendido sem procedimento → sem_registro (pendente)', () => {
  const r = classificarDia({ atendimentos: [at()], producao: [] });
  assert.strictEqual(r.sem_registro.length, 1);
  assert.strictEqual(r.sem_registro[0].registrado, false);
  assert.strictEqual(r.resumo.pendentes, 1);
});

test('não compareceu → fora de tudo', () => {
  const r = classificarDia({ atendimentos: [at({ compareceu: false })], producao: [] });
  assert.strictEqual(r.resumo.atendidos, 0);
  assert.strictEqual(r.sem_registro.length, 0);
});

test('compareceu null (linha pré-deploy) → fora de tudo', () => {
  const r = classificarDia({ atendimentos: [at({ compareceu: null })], producao: [] });
  assert.strictEqual(r.resumo.atendidos, 0);
});

test('categoria Avaliação → excluída (auditada no Dashboard Comercial)', () => {
  const r = classificarDia({
    atendimentos: [at({ category: 'Avaliação leads internet' }), at({ category: 'avaliação CRC Pós ' })],
    producao: [],
  });
  assert.strictEqual(r.resumo.atendidos, 0);
  assert.strictEqual(r.sem_registro.length, 0);
});

test('categoria Manutenção → seção própria, fora da contagem de pendência', () => {
  const r = classificarDia({ atendimentos: [at({ category: 'Manutenção' })], producao: [] });
  assert.strictEqual(r.manutencao.length, 1);
  assert.strictEqual(r.manutencao[0].registrado, false);
  assert.strictEqual(r.resumo.atendidos, 0);
  assert.strictEqual(r.resumo.pendentes, 0);
});

test('sem paciente_clinicorp_id → pendente com flag sem_id', () => {
  const r = classificarDia({ atendimentos: [at({ paciente_clinicorp_id: '' })], producao: [] });
  assert.strictEqual(r.sem_registro.length, 1);
  assert.strictEqual(r.sem_registro[0].sem_id, true);
});

test('pendentes ordenados por dentista e horário', () => {
  const r = classificarDia({
    atendimentos: [
      at({ patient_name: 'C', dentist_name: 'Dr. B', from_time: '11:00' }),
      at({ patient_name: 'B', dentist_name: 'Dr. A', from_time: '14:00', paciente_clinicorp_id: 'P2' }),
      at({ patient_name: 'A', dentist_name: 'Dr. A', from_time: '08:00', paciente_clinicorp_id: 'P3' }),
    ],
    producao: [],
  });
  assert.deepStrictEqual(r.sem_registro.map(x => x.paciente), ['A', 'B', 'C']);
});

test('dia vazio → tudo zerado', () => {
  const r = classificarDia({ atendimentos: [], producao: [] });
  assert.deepStrictEqual(r.resumo, { atendidos: 0, registrados: 0, pendentes: 0, por_dentista: [] });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/producao/registro.test.js`
Expected: FAIL — `Cannot find module './registro'`.

- [ ] **Step 3: Implementar**

```js
// lib/producao/registro.js
// Classifica os atendimentos de um dia em: com registro de procedimento
// executado, sem registro (pendência de documentação) e manutenção (visita
// sem procedimento cobrável esperado — informativa, fora da contagem).
// Categorias "Avalia%" ficam fora: esse funil já é auditado no Dashboard
// Comercial (orçamento criado, não procedimento executado).
'use strict';

const isAvaliacao  = c => /^avalia/i.test(String(c || '').trim());
const isManutencao = c => /^manuten/i.test(String(c || '').trim());

function classificarDia({ atendimentos, producao }) {
  // paciente → procedimentos executados no dia
  const procsPorPaciente = new Map();
  for (const p of (producao || [])) {
    const id = String(p.paciente_clinicorp_id || '');
    if (!id) continue;
    if (!procsPorPaciente.has(id)) procsPorPaciente.set(id, []);
    procsPorPaciente.get(id).push(p.procedure_name || '');
  }

  const sem_registro = [], com_registro = [], manutencao = [];
  const porDent = new Map();

  for (const a of (atendimentos || [])) {
    if (a.compareceu !== true) continue;
    if (isAvaliacao(a.category)) continue;

    const pid    = String(a.paciente_clinicorp_id || '');
    const procs  = pid ? (procsPorPaciente.get(pid) || []) : [];
    const item = {
      paciente:              a.patient_name || '',
      paciente_clinicorp_id: pid || null,
      dentista:              a.dentist_name || '',
      horario:               [a.from_time, a.to_time].filter(Boolean).join('–'),
      categoria:             a.category || null,
      registrado:            procs.length > 0,
      sem_id:                !pid,
      procedimentos:         procs,
    };

    if (isManutencao(a.category)) { manutencao.push(item); continue; }

    (item.registrado ? com_registro : sem_registro).push(item);
    const d = porDent.get(item.dentista) || { dentista: item.dentista, atendidos: 0, registrados: 0, pendentes: 0 };
    d.atendidos++;
    if (item.registrado) d.registrados++; else d.pendentes++;
    porDent.set(item.dentista, d);
  }

  const byDentHora = (x, y) =>
    x.dentista.localeCompare(y.dentista, 'pt-BR') || x.horario.localeCompare(y.horario);
  sem_registro.sort(byDentHora); com_registro.sort(byDentHora); manutencao.sort(byDentHora);

  const por_dentista = [...porDent.values()]
    .sort((x, y) => y.pendentes - x.pendentes || x.dentista.localeCompare(y.dentista, 'pt-BR'));

  return {
    resumo: {
      atendidos:   com_registro.length + sem_registro.length,
      registrados: com_registro.length,
      pendentes:   sem_registro.length,
      por_dentista,
    },
    sem_registro, com_registro, manutencao,
  };
}

module.exports = { classificarDia };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/producao/registro.test.js`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/producao/registro.js lib/producao/registro.test.js
git commit -m "feat(auditoria-registro): classificarDia (agenda x produção do dia)"
```

---

### Task 4: Endpoint `GET /api/producao/auditoria-registro`

**Files:**
- Modify: `server.js` — inserir após o bloco de `GET /api/producao/top-procedimentos` (~linha 8895), junto das demais rotas de Produção.

**Interfaces:**
- Consumes: `classificarDia` (Task 3); colunas da Task 1; `requireProducao` (server.js:451); `supabase` (client service_role global do server).
- Produces: `GET /api/producao/auditoria-registro?data=YYYY-MM-DD` → `{ data, resumo, sem_registro, com_registro, manutencao }` (formas da Task 3), consumido pela UI (Task 5). `data` default = ontem em BRT.

- [ ] **Step 1: Implementar a rota**

```js
// ── Auditoria de Registro Clínico: agenda (compareceu) × produção (Executed) ──
const { classificarDia } = require('./lib/producao/registro');

function ontemBRT() {
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const d = new Date(hoje + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

app.get('/api/producao/auditoria-registro', requireAuth, requireProducao, async (req, res) => {
  try {
    const data = req.query.data || ontemBRT();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      return res.status(400).json({ error: 'data inválida (YYYY-MM-DD)' });
    }

    // Volume diário « 1000 → sem risco do limite do client Supabase.
    const [{ data: atendimentos, error: eA }, { data: producao, error: eP }] = await Promise.all([
      supabase.from('agenda_appointments')
        .select('paciente_clinicorp_id, patient_name, dentist_name, from_time, to_time, category, compareceu')
        .eq('appointment_date', data).eq('deleted', false),
      supabase.from('producao_procedimentos')
        .select('paciente_clinicorp_id, procedure_name, dentist_name')
        .eq('executed_date', data),
    ]);
    if (eA) throw new Error(`agenda: ${eA.message}`);
    if (eP) throw new Error(`producao: ${eP.message}`);

    res.json({ data, ...classificarDia({ atendimentos, producao }) });
  } catch (e) {
    console.error('[producao/auditoria-registro]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

⚠️ O `require` fica junto da rota por clareza, mas confira se `server.js` já não importa `classificarDia`; declarar `const` duplicado quebra o boot.

- [ ] **Step 2: Checagem estática**

Run: `node --check server.js`
Expected: sem saída (sintaxe ok).

- [ ] **Step 3: Rodar os testes do repo**

Run: `npm test`
Expected: todos passam (nenhum teste toca a rota, mas garante que nada quebrou).

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(auditoria-registro): endpoint GET /api/producao/auditoria-registro"
```

---

### Task 5: Página `/producao/registro/` + item no menu

**Files:**
- Create: `public/producao/registro/index.html`
- Modify: `public/js/nav-config.js` — array `items` da seção `producao` (após o item `producao-dentista`, ~linha 99)

**Interfaces:**
- Consumes: endpoint da Task 4; `shared-nav.js` (carrega `nav-config.js` sozinho); token Supabase no localStorage (`sb-*-auth-token`).
- Produces: página final para o usuário.

- [ ] **Step 1: Adicionar o item no `nav-config.js`**

Logo após a linha do item `producao-dentista`:

```js
      { slug: 'producao-registro',  label: 'Registro Diário',      roles: 'financeiro,mod_financeiro,mod_producao',                    mode: 'link', href: '/producao/registro/' },
```

- [ ] **Step 2: Criar a página**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Registro Diário — AMA</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root[data-theme="dark"]{--bg:#0f1117;--bg2:#181b24;--bg3:#1e2230;--border:#2a2f42;--text:#e8eaf0;--muted:#6b7280;--accent:#4f8ef7;--accent-hover:#3a78e0;--green:#22c55e;--yellow:#f59e0b;--red:#ef4444}
:root[data-theme="light"]{--bg:#f7f8fa;--bg2:#ffffff;--bg3:#f1f3f7;--border:#e3e6ed;--text:#1a1d29;--muted:#6b7280;--accent:#3b82f6;--accent-hover:#2563eb;--green:#16a34a;--yellow:#d97706;--red:#dc2626}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.wrap{padding:16px 20px;max-width:1100px}
.page-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.page-header-left{display:flex;flex-direction:column;gap:4px}
.back-link{font-size:12px;color:var(--muted);text-decoration:none}
.back-link:hover{color:var(--accent)}
.page-header h1{font-size:20px;font-weight:700}
.controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:16px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px 14px}
.controls input[type=date]{background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:7px;padding:5px 8px;font-family:inherit;font-size:13px}
.btn{padding:6px 14px;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;border:none;font-family:inherit;transition:all .15s}
.btn-ghost{background:var(--bg3);color:var(--text);border:1px solid var(--border)}
.btn-ghost:hover{background:var(--border)}
.btn-ghost:disabled{opacity:.5;cursor:default}
.resumo-card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:16px;display:flex;gap:24px;flex-wrap:wrap;align-items:center}
.resumo-num{font-size:26px;font-weight:700}
.resumo-label{font-size:12px;color:var(--muted)}
.resumo-pend .resumo-num{color:var(--red)}
.resumo-ok .resumo-num{color:var(--green)}
.aviso{font-size:12px;color:var(--yellow);margin-bottom:12px}
.section{background:var(--bg2);border:1px solid var(--border);border-radius:10px;margin-bottom:16px;overflow:hidden}
.section-header{padding:12px 16px;font-weight:600;font-size:14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px}
.section-header .count{font-size:12px;color:var(--muted);font-weight:400}
.section-header.clickable{cursor:pointer;user-select:none}
table{width:100%;border-collapse:collapse;font-size:13px}
th{font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);text-align:left;padding:8px 16px;border-bottom:1px solid var(--border)}
td{padding:8px 16px;border-bottom:1px solid var(--border)}
tr:last-child td{border-bottom:none}
.tag-pend{color:var(--red);font-weight:600;font-size:12px}
.tag-semid{color:var(--yellow);font-size:11px}
.procs{color:var(--muted);font-size:12px}
.empty{padding:24px;text-align:center;color:var(--muted);font-size:13px}
.footer-note{font-size:11px;color:var(--muted);margin:8px 2px 24px}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;vertical-align:-2px}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="wrap">

  <div class="page-header">
    <div class="page-header-left">
      <a href="/producao/" class="back-link">← Receita × Entrega</a>
      <h1>Registro Diário</h1>
    </div>
    <button class="btn btn-ghost" id="syncBtn" onclick="syncNow()">Atualizar dados</button>
  </div>

  <div class="controls">
    <button class="btn btn-ghost" onclick="mudarDia(-1)">◀</button>
    <input type="date" id="dataInput" onchange="carregar()">
    <button class="btn btn-ghost" id="nextBtn" onclick="mudarDia(1)">▶</button>
    <button class="btn btn-ghost" onclick="irOntem()">Ontem</button>
  </div>

  <div id="avisoHoje" class="aviso" style="display:none">
    ⚠ O dado deste dia só fecha após o sync das 02:00 — pendências podem ser só atraso de sincronização.
  </div>

  <div id="conteudo"><div class="empty"><span class="spinner"></span></div></div>

  <p class="footer-note">
    Esta tela mostra se existe procedimento executado no Clinicorp no dia do atendimento —
    ela não lê o texto da ficha clínica. Um atendimento "sem registro" é um sinal para
    conferir com a equipe, não prova de que nada foi anotado.
  </p>

</div>

<script>
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let token = null;

(function init() {
  const k = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
  if (!k) return (window.location.href = '/');
  let parsed;
  try { parsed = JSON.parse(localStorage.getItem(k)); } catch (_) {}
  token = parsed?.access_token;
  if (!token) return (window.location.href = '/');

  document.getElementById('dataInput').value = ontem();
  carregar();
})();

function hoje() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); }
function ontem() {
  const d = new Date(hoje() + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function mudarDia(delta) {
  const d = new Date(document.getElementById('dataInput').value + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  document.getElementById('dataInput').value = d.toISOString().slice(0, 10);
  carregar();
}
function irOntem() { document.getElementById('dataInput').value = ontem(); carregar(); }

// Retry padrão do CRM p/ 5xx: 2 tentativas extras (1,5s / 3s).
async function fetchRetry(url, opts) {
  for (const espera of [1500, 3000, null]) {
    const res = await fetch(url, opts);
    if (res.status < 500 || espera === null) return res;
    await new Promise(r => setTimeout(r, espera));
  }
}

async function syncNow() {
  const btn = document.getElementById('syncBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    await fetch('/api/admin/sync-clinicorp', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    await carregar();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Atualizar dados';
  }
}

async function carregar() {
  const data = document.getElementById('dataInput').value;
  document.getElementById('avisoHoje').style.display = data >= hoje() ? '' : 'none';
  document.getElementById('nextBtn').disabled = data >= hoje();
  const el = document.getElementById('conteudo');
  el.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  try {
    const res = await fetchRetry(`/api/producao/auditoria-registro?data=${data}`,
      { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Erro ao carregar');
    render(json);
  } catch (e) {
    el.innerHTML = `<div class="empty">Erro: ${esc(e.message)}</div>`;
  }
}

function linha(x, comProcs) {
  const semId = x.sem_id ? ' <span class="tag-semid">(sem vínculo de paciente)</span>' : '';
  return `<tr>
    <td>${esc(x.paciente)}${semId}</td>
    <td>${esc(x.dentista)}</td>
    <td>${esc(x.horario)}</td>
    <td>${esc(x.categoria || '—')}</td>
    ${comProcs ? `<td class="procs">${esc(x.procedimentos.join(', '))}</td>` : ''}
  </tr>`;
}

function tabela(itens, comProcs, vazio) {
  if (!itens.length) return `<div class="empty">${esc(vazio)}</div>`;
  return `<table><thead><tr>
    <th>Paciente</th><th>Dentista</th><th>Horário</th><th>Categoria</th>
    ${comProcs ? '<th>Procedimentos registrados</th>' : ''}
  </tr></thead><tbody>${itens.map(x => linha(x, comProcs)).join('')}</tbody></table>`;
}

function render(j) {
  const r = j.resumo;
  const pct = r.atendidos ? Math.round((r.registrados / r.atendidos) * 100) : 0;

  const porDent = r.por_dentista.length ? `
    <div class="section">
      <div class="section-header">Por dentista</div>
      <table><thead><tr><th>Dentista</th><th>Atendidos</th><th>Com registro</th><th>Pendentes</th></tr></thead>
      <tbody>${r.por_dentista.map(d => `<tr>
        <td>${esc(d.dentista)}</td><td>${d.atendidos}</td><td>${d.registrados}</td>
        <td>${d.pendentes ? `<span class="tag-pend">${d.pendentes}</span>` : '0'}</td>
      </tr>`).join('')}</tbody></table>
    </div>` : '';

  document.getElementById('conteudo').innerHTML = `
    <div class="resumo-card">
      <div><div class="resumo-num">${r.atendidos}</div><div class="resumo-label">atendimentos clínicos</div></div>
      <div class="resumo-ok"><div class="resumo-num">${r.registrados}</div><div class="resumo-label">com registro (${pct}%)</div></div>
      <div class="resumo-pend"><div class="resumo-num">${r.pendentes}</div><div class="resumo-label">sem registro</div></div>
    </div>

    <div class="section">
      <div class="section-header">Sem registro de procedimento <span class="count">${j.sem_registro.length}</span></div>
      ${tabela(j.sem_registro, false, 'Nenhuma pendência neste dia 🎉')}
    </div>

    ${porDent}

    <div class="section">
      <div class="section-header">Com registro <span class="count">${j.com_registro.length}</span></div>
      ${tabela(j.com_registro, true, 'Nenhum atendimento com registro neste dia.')}
    </div>

    <div class="section">
      <div class="section-header clickable" onclick="const b=document.getElementById('manutBody');b.style.display=b.style.display==='none'?'':'none'">
        Manutenção (sem procedimento cobrável esperado) <span class="count">${j.manutencao.length} ▾</span>
      </div>
      <div id="manutBody" style="display:none">
        ${tabela(j.manutencao, true, 'Nenhuma manutenção neste dia.')}
      </div>
    </div>`;
}
</script>
<script src="/js/shared-nav.js" data-active="producao-registro"></script>
</body>
</html>
```

- [ ] **Step 3: Checar sintaxe do JS embutido**

Run:
```bash
node -e "const m=require('fs').readFileSync('public/producao/registro/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/); new Function(m[1]); console.log('js ok')"
```
Expected: `js ok` (o `new Function` faz o parse do bloco `<script>` sem executá-lo; erro de sintaxe lançaria exceção).

- [ ] **Step 4: Commit**

```bash
git add public/producao/registro/index.html public/js/nav-config.js
git commit -m "feat(auditoria-registro): página Registro Diário na seção Produção"
```

---

### Task 6: Deploy + verificação de ponta a ponta

**Files:** nenhum novo.

- [ ] **Step 1: Push + deploy (sem perguntar)**

```bash
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

(⚠️ Se o push travar no credential manager, usar o fluxo headless de token via CredRead — memória `feedback_git_push_headless`.)

- [ ] **Step 2: Aguardar deploy e disparar sync manual**

Aguardar ~2 min o container subir, então (com um token de admin obtido do navegador, ou pedir ao Luiz para clicar em "Atualizar dados" na página):
`POST /api/admin/sync-clinicorp` — preenche `status_id`/`compareceu` dos 90 dias.

- [ ] **Step 3: Verificar preenchimento no banco**

`mcp__plugin_supabase_supabase__execute_sql`:
```sql
select count(*) filter (where compareceu is not null) as preenchidos,
       count(*) as total
from agenda_appointments
where appointment_date >= current_date - 90;
```
Expected: `preenchidos` ≈ `total` (linhas de +90d atrás podem ficar NULL — ok).

- [ ] **Step 4: Validação visual com o Luiz**

Abrir `/producao/registro/` logado, data = ontem; conferir 2–3 pacientes pendentes contra o Clinicorp logado (a ficha realmente não tem procedimento executado no dia?). Registrar resultado.

- [ ] **Step 5: Atualizar STATUS.md / memória**

Marcar a feature como deployada com pendência de validação logada.
