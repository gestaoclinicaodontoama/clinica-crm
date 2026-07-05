# Inadimplência 2.0 — Fase 0 + Fase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao módulo Inadimplentes a fundação de dados (id do paciente na produção e na agenda, agenda futura) e a primeira camada visível: grupos refinados por exposição real, selos *pago-vs-entregue* e *vem-à-clínica*, cobrança do pagador com 2ª via de boleto.

**Architecture:** A lógica nova de agregação/classificação vira **funções puras em `lib/financeiro/inadimplencia.js`** (testadas com `node:test`, no mesmo padrão de `analise-parcelas.js`). O `server.js` faz a IO (consulta produção e agenda para montar mapas) e chama as funções puras. Migrations e sync são verificados por execução/consulta SQL. O frontend (SPA em `index.html`) lê os campos novos que já vêm no `inadimplentes_cache.data`.

**Tech Stack:** Node.js + Express, Supabase (Postgres via `@supabase/supabase-js`), `node:test`/`node:assert`, frontend HTML/CSS/JS vanilla. API Clinicorp (`/payment/list`, `/appointment/list`).

## Global Constraints

- **Fonte por paciente = `/payment/list`** (`date_type=postDate`), campos: `PatientId`, `Amount`/`AmountWithDiscounts`/`TotalPostAmount`, `DueDate`, `ReceivedDate`, `PaymentReceived`, `PayerName`, `PayerPhone`, `BoletoUrl`, `BoletoDigitalLine`, `PaymentForm`, `InstallmentNumber`, `TreatmentId`, `MaxInstallmentsCount`.
- **Nunca casar paciente por nome** — famílias têm telefone/nome repetidos (regra do Luiz). Chave sempre = id Clinicorp.
- **Supabase client limita 1000 linhas por select** — paginar (ver `selectAll` em `sync/clinicorp-sync.js`) ou somar no SQL. Nunca somar no JS por cima de um select truncado.
- **Nunca `.catch()` direto no builder do Supabase** — usar `try/catch` no `await`.
- **Migrations** em `supabase/migrations/`, timestamp crescente, aplicadas via MCP Supabase (project `mtqdpjhhqzvuklnlfpvi`), conferir com `list_migrations`.
- **Deploy** após `git push`: `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`. (Só quando o Luiz pedir push/deploy.)
- **Não remover** colunas/comportamento atuais do módulo sem substituição equivalente.
- Datas dos itens podem vir com hora (`...T03:00Z`) — normalizar com `.slice(0,10)`.

---

## File Structure

- **Create** `lib/financeiro/inadimplencia.js` — funções puras: `agregarPorPaciente(items, today)` e `classificarESepararGrupos(pacientes, mapas)`.
- **Create** `lib/financeiro/inadimplencia.test.js` — testes `node:test`.
- **Create** `supabase/migrations/20260705120000_inad_paciente_ids.sql` — colunas `paciente_clinicorp_id` em `producao_procedimentos` e `agenda_appointments` + índices.
- **Create** `scripts/backfill-producao-paciente.js` — preenche `producao_procedimentos.paciente_clinicorp_id` casando `clinicorp_treatment_id` ↔ `TreatmentId` do `/payment/list`.
- **Modify** `sync/clinicorp-sync.js` — gravar `paciente_clinicorp_id` na produção e na agenda; agenda passa a coletar janela futura.
- **Modify** `server.js` — `processarInadimplentes` passa a usar o lib novo; enriquecer com mapas de entregue/agenda; captura de campos do pagador/boleto.
- **Modify** `public/index.html` — dois selos na tabela, WhatsApp com pagador + boleto, rótulos dos grupos.

---

## Task 1: Migration — colunas de id do paciente

**Files:**
- Create: `supabase/migrations/20260705120000_inad_paciente_ids.sql`

**Interfaces:**
- Produces: colunas `producao_procedimentos.paciente_clinicorp_id text` e `agenda_appointments.paciente_clinicorp_id text` (+ índices), consumidas pelas Tasks 2, 3 e 5.

- [ ] **Step 1: Escrever a migration**

```sql
-- supabase/migrations/20260705120000_inad_paciente_ids.sql
-- Liga produção realizada e agenda ao paciente (id Clinicorp) para o módulo Inadimplência 2.0.

ALTER TABLE producao_procedimentos
  ADD COLUMN IF NOT EXISTS paciente_clinicorp_id text;

CREATE INDEX IF NOT EXISTS producao_procedimentos_paciente_idx
  ON producao_procedimentos (paciente_clinicorp_id);

ALTER TABLE agenda_appointments
  ADD COLUMN IF NOT EXISTS paciente_clinicorp_id text;

CREATE INDEX IF NOT EXISTS agenda_appointments_paciente_idx
  ON agenda_appointments (paciente_clinicorp_id);
```

- [ ] **Step 2: Aplicar via MCP Supabase**

Aplicar o arquivo com a ferramenta `apply_migration` (project `mtqdpjhhqzvuklnlfpvi`), name `inad_paciente_ids`.

- [ ] **Step 3: Verificar que aplicou**

Rodar `list_migrations` via MCP e confirmar que `20260705120000_inad_paciente_ids` aparece.
Rodar via `execute_sql`:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name IN ('producao_procedimentos','agenda_appointments')
  AND column_name = 'paciente_clinicorp_id';
```
Expected: 2 linhas.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260705120000_inad_paciente_ids.sql
git commit -m "feat(inad): colunas paciente_clinicorp_id em producao e agenda"
```

---

## Task 2: Sync grava id do paciente + agenda futura

**Files:**
- Modify: `sync/clinicorp-sync.js` (função de produção ~L565-590; `syncAgenda` ~L626-678; `fetchRangeChunked` ~L326)

**Interfaces:**
- Consumes: colunas da Task 1.
- Produces: linhas novas de `producao_procedimentos` e `agenda_appointments` com `paciente_clinicorp_id`; `agenda_appointments` passa a conter também agendamentos futuros (até +90d).

- [ ] **Step 1: Produção grava o id do paciente**

Em `sync/clinicorp-sync.js`, no `rows.push({...})` da produção (bloco que monta cada procedimento executado, hoje termina em `paciente_nome: est.PatientName || null,`), acrescentar o campo:

```js
      rows.push({
        clinicorp_estimate_id:  estId,
        clinicorp_treatment_id: est.TreatmentId ? String(est.TreatmentId) : null,
        price_id:               priceId,
        procedure_name:         priceId ? (catalog.get(priceId) || '') : '',
        specialty_id:           p.SpecialtyId ? String(p.SpecialtyId) : null,
        dentist_person_id:      p.Dentist_PersonId ? String(p.Dentist_PersonId) : null,
        dentist_name:           p.ProfessionalName || p.DentistName || null,
        executed_date:          p.ExecutedDate ? p.ExecutedDate.slice(0, 10) : null,
        amount,
        bill_type:              p.BillType || null,
        paciente_nome:          est.PatientName || null,
        paciente_clinicorp_id:  String(est.PatientId || ''),
        atualizado_em:          new Date().toISOString(),
      });
```

- [ ] **Step 2: Agenda grava o id do paciente**

Em `syncAgenda`, no `rows.push({...})` (hoje tem `patient_name: a.PatientName || null,`), acrescentar:

```js
      patient_name:       a.PatientName || null,
      paciente_clinicorp_id: String(a.Patient_PersonId || a.PatientId || ''),
```

- [ ] **Step 3: Agenda coleta também a janela futura**

`fetchRangeChunked` (L326) só olha para trás (`to = today - off`). Adicionar um helper de janela futura no arquivo e usá-lo no `syncAgenda`. Logo após a definição de `fetchRangeChunked`, adicionar:

```js
// Igual ao fetchRangeChunked, mas para FRENTE (today → today+dias). Usado pela agenda
// (precisamos de consultas futuras para o sinal "vem à clínica" da Inadimplência).
async function fetchRangeChunkedFuturo(path, dias, chunkDias = 30) {
  const today = new Date();
  const all = [];
  for (let off = 0; off < dias; off += chunkDias) {
    const from = new Date(today); from.setDate(from.getDate() + off);
    const to   = new Date(today); to.setDate(to.getDate() + Math.min(off + chunkDias, dias));
    const part = await api.get(path, { from: dateStr(from), to: dateStr(to) });
    if (Array.isArray(part)) all.push(...part);
  }
  return all;
}
```

Em `syncAgenda`, trocar a linha que busca os agendamentos para concatenar passado + futuro:

```js
  const raw = [
    ...await fetchRangeChunked('/appointment/list', AGENDA_DIAS),
    ...await fetchRangeChunkedFuturo('/appointment/list', AGENDA_DIAS),
  ];
```

(O dedup por `apptId` via `seenIds` já existente no loop cobre qualquer sobreposição na data de hoje.)

- [ ] **Step 4: Verificar por execução do sync**

Rodar o sync (ou aguardar o das 02h). Depois, via `execute_sql`:
```sql
SELECT
  count(*) FILTER (WHERE paciente_clinicorp_id <> '') AS com_id,
  count(*) AS total,
  max(appointment_date) AS ultima_data
FROM agenda_appointments;
```
Expected: `com_id` > 0 e `ultima_data` no futuro (> hoje) — confirma id gravado e janela futura.
E:
```sql
SELECT count(*) FILTER (WHERE paciente_clinicorp_id <> '') AS com_id, count(*) AS total
FROM producao_procedimentos WHERE atualizado_em::date = current_date;
```
Expected: `com_id` = `total` para as linhas re-sincronizadas hoje.

- [ ] **Step 5: Commit**

```bash
git add sync/clinicorp-sync.js
git commit -m "feat(inad): sync grava paciente_clinicorp_id (producao+agenda) e agenda futura"
```

---

## Task 3: Backfill do id do paciente na produção histórica

**Files:**
- Create: `scripts/backfill-producao-paciente.js`

**Interfaces:**
- Consumes: coluna da Task 1; `TreatmentId`/`PatientId` do `/payment/list`.
- Produces: `producao_procedimentos.paciente_clinicorp_id` preenchido no histórico (linhas onde `clinicorp_treatment_id` casa com um pagamento).

**Nota (correção da revisão):** re-rodar `estimates/list` NÃO recupera procedimentos antigos (a API só devolve estimates recentes). Por isso o backfill casa **pelo tratamento**: `producao.clinicorp_treatment_id` → `TreatmentId` do `/payment/list` (24m) → `PatientId`.

- [ ] **Step 1: Escrever o script**

Seguir o padrão dos scripts existentes em `scripts/` (carregam `.env` via dotenv e criam client Supabase). Verificar o topo de `scripts/backfill-saude.js` para copiar o boilerplate de conexão exato.

```js
// scripts/backfill-producao-paciente.js
// Preenche producao_procedimentos.paciente_clinicorp_id casando clinicorp_treatment_id
// com o TreatmentId do /payment/list (24 meses). Idempotente.
require('dotenv').config();
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function clinicorpGet(apiPath, params = {}) {
  return new Promise((resolve, reject) => {
    const user = process.env.CLINICORP_USER || 'clinicaama';
    const token = process.env.CLINICORP_TOKEN || '';
    const auth = Buffer.from(user + ':' + token).toString('base64');
    const qs = new URLSearchParams({
      subscriber_id: process.env.CLINICORP_SUBSCRIBER_ID || 'clinicaama',
      business_id:   process.env.CLINICORP_BUSINESS_ID   || 'clinicaama',
      ...params,
    }).toString();
    const opts = { hostname: 'api.clinicorp.com', path: '/rest/v1' + apiPath + '?' + qs,
      method: 'GET', headers: { Authorization: 'Basic ' + auth, 'X-Api-Key': token, Accept: 'application/json' } };
    const req = https.request(opts, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { resolve(null); } });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject); req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // 1) Mapa TreatmentId -> PatientId a partir de 24 meses de pagamentos (chunks de 2 meses).
  const mapa = new Map();
  for (let i = 0; i < 12; i++) {
    const to = new Date();   to.setMonth(to.getMonth() - i * 2);
    const from = new Date(); from.setMonth(from.getMonth() - (i + 1) * 2);
    const data = await clinicorpGet('/payment/list', {
      from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), date_type: 'postDate' });
    if (Array.isArray(data)) for (const it of data) {
      const t = String(it.TreatmentId || ''); const p = String(it.PatientId || '');
      if (t && p) mapa.set(t, p);
    }
    console.log(`chunk ${i}: mapa agora com ${mapa.size} tratamentos`);
    await sleep(400);
  }

  // 2) Ler producao sem paciente_clinicorp_id (paginado, limite 1000).
  const semId = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from('producao_procedimentos')
      .select('id, clinicorp_treatment_id')
      .or('paciente_clinicorp_id.is.null,paciente_clinicorp_id.eq.')
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    semId.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  console.log(`producao sem id: ${semId.length}`);

  // 3) Atualizar as que casam pelo tratamento.
  let atualizadas = 0, semMatch = 0;
  for (const row of semId) {
    const pid = mapa.get(String(row.clinicorp_treatment_id || ''));
    if (!pid) { semMatch++; continue; }
    const { error } = await supabase.from('producao_procedimentos')
      .update({ paciente_clinicorp_id: pid }).eq('id', row.id);
    if (error) console.error('update erro id', row.id, error.message); else atualizadas++;
  }
  console.log(`✅ atualizadas: ${atualizadas} | sem match no pagamento: ${semMatch}`);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
```

- [ ] **Step 2: Rodar o backfill**

Run: `node scripts/backfill-producao-paciente.js`
Expected: termina com `✅ atualizadas: N | sem match no pagamento: M` sem erro.

- [ ] **Step 3: Medir cobertura (risco anotado na spec)**

Via `execute_sql`:
```sql
SELECT
  round(100.0 * count(*) FILTER (WHERE paciente_clinicorp_id <> '') / count(*), 1) AS pct_com_id,
  count(*) AS total
FROM producao_procedimentos;
```
Expected: `pct_com_id` alto. Se baixo, anotar para investigar (tratamentos sem pagamento no feed) — não bloqueia a Fase 1, só reduz a fidelidade do "entregue".

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-producao-paciente.js
git commit -m "feat(inad): backfill paciente_clinicorp_id na producao via TreatmentId"
```

---

## Task 4: Lib pura — agregação e classificação por exposição (TDD)

**Files:**
- Create: `lib/financeiro/inadimplencia.js`
- Test: `lib/financeiro/inadimplencia.test.js`

**Interfaces:**
- Produces:
  - `agregarPorPaciente(items, today) -> Array<Pac>` onde `Pac = { id, name, phone, payerName, payerPhone, boletoUrl, boletoLinha, paymentForm, overdueAmount, futureAmount, overdueCount, oldestDueDate, nextDueDate, pago, diasDeAtraso, diasParaProximo }`. Só entram pacientes com `overdueCount > 0`. Campos de boleto/pagador vêm da **parcela vencida em aberto mais antiga**. `pago` = soma das parcelas recebidas do paciente nos itens.
  - `classificarESepararGrupos(pacientes, { entregueMap, consultaFuturaSet, veioRecenteSet }) -> { grupo1, grupo2, grupo3, totais }`. Cada paciente ganha `grupo` (1|2|3), `entregue` (número), `exposicao` ('vermelho'|'verde'), `engajamento` ('futuro'|'recente'|'sumiu'). Grupos ordenados por `overdueAmount` desc.
- Consumed by: Task 5 (`server.js`).

- [ ] **Step 1: Escrever os testes que falham**

```js
// lib/financeiro/inadimplencia.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { agregarPorPaciente, classificarESepararGrupos } = require('./inadimplencia');

const HOJE = '2026-07-05';

test('agregarPorPaciente: só pacientes com parcela vencida; soma vencido/futuro/pago', () => {
  const items = [
    { PatientId: 'A', PatientName: 'Ana (1)', DueDate: '2026-06-01', Amount: 100, PayerName: 'Mãe A', PayerPhone: '31999', BoletoUrl: 'u1', BoletoDigitalLine: 'l1', PaymentForm: 'Boleto' }, // vencida
    { PatientId: 'A', DueDate: '2026-05-01', Amount: 50 },                                   // vencida mais antiga
    { PatientId: 'A', DueDate: '2026-08-01', Amount: 200 },                                  // futura
    { PatientId: 'A', DueDate: '2026-04-01', Amount: 30, PaymentReceived: 'X' },             // paga
    { PatientId: 'B', DueDate: '2026-09-01', Amount: 500 },                                  // só futura → fora
  ];
  const pac = agregarPorPaciente(items, HOJE);
  assert.equal(pac.length, 1);
  const a = pac[0];
  assert.equal(a.id, 'A');
  assert.equal(a.name, 'Ana');            // sufixo "(1)" removido
  assert.equal(a.overdueAmount, 150);
  assert.equal(a.futureAmount, 200);
  assert.equal(a.overdueCount, 2);
  assert.equal(a.pago, 30);
  assert.equal(a.oldestDueDate, '2026-05-01');
  // boleto/pagador vêm da vencida em aberto MAIS ANTIGA (a de 2026-05-01 não tem boleto → cai p/ a que tem)
  assert.equal(a.payerName, 'Mãe A');
  assert.equal(a.boletoUrl, 'u1');
  assert.equal(a.paymentForm, 'Boleto');
});

test('classificar: Crítico exige exposição (entregue > pago) E parado (sem futura e sem consulta)', () => {
  const pacientes = [
    // C1: sem futura, entregue 1000 > pago 100, sem consulta → CRÍTICO (3)
    { id: 'C1', overdueAmount: 900, overdueCount: 3, futureAmount: 0, pago: 100 },
    // C2: sem futura, mas entregue 0 (não começou) → NÃO é crítico; 1 vencida → grupo 1
    { id: 'C2', overdueAmount: 200, overdueCount: 1, futureAmount: 0, pago: 0 },
    // C3: tem futura, 2 vencidas → Renegociação (2)
    { id: 'C3', overdueAmount: 300, overdueCount: 2, futureAmount: 400, pago: 50 },
    // C4: tem futura, 1 vencida → Em Cobrança (1)
    { id: 'C4', overdueAmount: 80, overdueCount: 1, futureAmount: 400, pago: 50 },
  ];
  const r = classificarESepararGrupos(pacientes, {
    entregueMap: new Map([['C1', 1000], ['C2', 0], ['C3', 0], ['C4', 0]]),
    consultaFuturaSet: new Set(['C4']),
    veioRecenteSet: new Set(['C3']),
  });
  assert.deepEqual(r.grupo3.map(p => p.id), ['C1']);
  assert.deepEqual(r.grupo1.map(p => p.id).sort(), ['C2', 'C4']);
  assert.deepEqual(r.grupo2.map(p => p.id), ['C3']);
  assert.equal(r.totais.criticos, 1);
  // selos
  assert.equal(r.grupo3[0].exposicao, 'vermelho');
  assert.equal(r.grupo3[0].engajamento, 'sumiu');
  assert.equal(r.grupo1.find(p => p.id === 'C4').engajamento, 'futuro');
  assert.equal(r.grupo2[0].engajamento, 'recente');
});

test('classificar: totais somam valorTotal do vencido', () => {
  const r = classificarESepararGrupos(
    [{ id: 'X', overdueAmount: 100, overdueCount: 1, futureAmount: 0, pago: 0 }],
    { entregueMap: new Map(), consultaFuturaSet: new Set(), veioRecenteSet: new Set() });
  assert.equal(r.totais.valorTotal, 100);
  assert.equal(r.totais.pacientes, 1);
});
```

- [ ] **Step 2: Rodar os testes e ver falhar**

Run: `node --test "lib/financeiro/inadimplencia.test.js"`
Expected: FAIL — `Cannot find module './inadimplencia'`.

- [ ] **Step 3: Implementar o lib**

```js
// lib/financeiro/inadimplencia.js
// Puras: agregam o /payment/list por paciente para cobrança e classificam os grupos
// por EXPOSIÇÃO REAL (entregue vs. pago) + engajamento (vem à clínica).
// Datas dos itens podem vir com hora — normalizar com slice(0,10).

const dia = s => (s || '').slice(0, 10);
const valorItem = it => Number(it.Amount || it.TotalPostAmount || it.AmountWithDiscounts || 0) || 0;
function recebida(it) {
  return it.PaymentReceived === 'X' ||
    !!(it.ReceivedDate && it.ReceivedDate !== '' && dia(it.ReceivedDate) !== '0001-01-01');
}
const limpaNome = n => String(n || '').replace(/\s*\(\d+\)\s*$/, '');

// Agrega por paciente; só devolve quem tem parcela vencida em aberto.
function agregarPorPaciente(items, today) {
  const m = {};
  for (const it of (items || [])) {
    const id = String(it.PatientId || it.patientId || it.Patient_PersonId || '').trim();
    if (!id) continue;
    const paid = recebida(it);
    const due = dia(it.DueDate || it.due_date || it.PostDate || it.ScheduledDate || '');
    const v = valorItem(it);
    if (!m[id]) m[id] = {
      id, name: limpaNome(it.PatientName || it.patientName || it.Patient_PersonName || 'Paciente ' + id),
      phone: String(it.Phone || it.MobilePhone || it.phone || it.PayerPhone || ''),
      payerName: '', payerPhone: '', boletoUrl: '', boletoLinha: '', paymentForm: '',
      overdueAmount: 0, futureAmount: 0, overdueCount: 0, pago: 0,
      oldestDueDate: null, nextDueDate: null, _boletoDue: null,
    };
    const p = m[id];
    if (paid) { p.pago += v; continue; }
    if (!due) continue;
    if (due < today) {
      p.overdueAmount += v; p.overdueCount++;
      if (!p.oldestDueDate || due < p.oldestDueDate) p.oldestDueDate = due;
      // pagador/boleto da vencida em aberto MAIS ANTIGA que tenha boleto
      if (it.BoletoUrl && (!p._boletoDue || due < p._boletoDue)) {
        p._boletoDue = due;
        p.boletoUrl = String(it.BoletoUrl || '');
        p.boletoLinha = String(it.BoletoDigitalLine || '');
      }
      if (!p.payerName && it.PayerName) { p.payerName = String(it.PayerName); p.payerPhone = String(it.PayerPhone || ''); }
      if (!p.paymentForm && it.PaymentForm) p.paymentForm = String(it.PaymentForm);
    } else {
      p.futureAmount += v;
      if (!p.nextDueDate || due < p.nextDueDate) p.nextDueDate = due;
    }
  }
  const td = new Date(today);
  return Object.values(m).filter(p => p.overdueCount > 0).map(p => {
    delete p._boletoDue;
    p.overdueAmount = Math.round(p.overdueAmount * 100) / 100;
    p.futureAmount = Math.round(p.futureAmount * 100) / 100;
    p.pago = Math.round(p.pago * 100) / 100;
    p.diasDeAtraso = p.oldestDueDate ? Math.floor((td - new Date(p.oldestDueDate)) / 86400000) : 0;
    p.diasParaProximo = p.nextDueDate ? Math.floor((new Date(p.nextDueDate) - td) / 86400000) : null;
    return p;
  });
}

function classificarESepararGrupos(pacientes, { entregueMap, consultaFuturaSet, veioRecenteSet }) {
  const em = entregueMap || new Map();
  const cf = consultaFuturaSet || new Set();
  const vr = veioRecenteSet || new Set();
  for (const p of pacientes) {
    const entregue = Math.round((em.get(String(p.id)) || 0) * 100) / 100;
    const temFutura = p.futureAmount > 0;
    const temConsulta = cf.has(String(p.id));
    p.entregue = entregue;
    p.exposicao = entregue > (p.pago || 0) ? 'vermelho' : 'verde';
    p.engajamento = temConsulta ? 'futuro' : (vr.has(String(p.id)) ? 'recente' : 'sumiu');
    // Crítico = exposição real E parado (sem futura E sem consulta futura).
    if (entregue > (p.pago || 0) && !temFutura && !temConsulta) p.grupo = 3;
    else if (p.overdueCount === 1) p.grupo = 1;
    else p.grupo = 2;
  }
  const byOverdue = (a, b) => b.overdueAmount - a.overdueAmount;
  const grupo1 = pacientes.filter(p => p.grupo === 1).sort(byOverdue);
  const grupo2 = pacientes.filter(p => p.grupo === 2).sort(byOverdue);
  const grupo3 = pacientes.filter(p => p.grupo === 3).sort(byOverdue);
  return {
    grupo1, grupo2, grupo3,
    totais: {
      pacientes: pacientes.length,
      valorTotal: Math.round(pacientes.reduce((s, p) => s + p.overdueAmount, 0) * 100) / 100,
      emCobranca: grupo1.length, renegociacao: grupo2.length, criticos: grupo3.length,
    },
  };
}

module.exports = { agregarPorPaciente, classificarESepararGrupos };
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `node --test "lib/financeiro/inadimplencia.test.js"`
Expected: PASS (3 testes).

- [ ] **Step 5: Rodar a suíte inteira (não quebrou nada)**

Run: `npm test`
Expected: todos os testes passam (inadimplencia + analise-parcelas + fluxo-futuro).

- [ ] **Step 6: Commit**

```bash
git add lib/financeiro/inadimplencia.js lib/financeiro/inadimplencia.test.js
git commit -m "feat(inad): lib pura de agregacao + classificacao por exposicao (TDD)"
```

---

## Task 5: Fiar o lib no server + mapas de entregue/agenda

**Files:**
- Modify: `server.js` (`processarInadimplentes` ~L3557-3613; `fetchInadimplentesBackground` ~L3630; requires no topo).

**Interfaces:**
- Consumes: `agregarPorPaciente`, `classificarESepararGrupos` (Task 4); colunas/backfill (Tasks 1-3).
- Produces: `inadimplentes_cache.data` com os grupos enriquecidos (`entregue`, `exposicao`, `engajamento`, `payerName`, `payerPhone`, `boletoUrl`, `boletoLinha`, `grupo`) por paciente. Consumido pela Task 6.

- [ ] **Step 1: Importar o lib**

No topo de `server.js`, perto de `const _analiseParcelas = require('./lib/financeiro/analise-parcelas');`, adicionar:

```js
const _inad = require('./lib/financeiro/inadimplencia');
```

- [ ] **Step 2: Substituir o corpo de `processarInadimplentes` por uso do lib**

`processarInadimplentes(items, today)` é síncrona hoje. Precisamos de IO (produção/agenda), então torná-la `async` e montar os mapas. Substituir a função inteira por:

```js
async function processarInadimplentes(items, today) {
  const pacientes = _inad.agregarPorPaciente(items, today);
  const ids = pacientes.map(p => String(p.id));

  // entregue por paciente (soma da produção realizada) — agregado no SQL (evita limite 1000).
  const entregueMap = new Map();
  const veioRecenteSet = new Set();
  if (ids.length) {
    const d90 = new Date(); d90.setDate(d90.getDate() - 90);
    const d90str = d90.toISOString().slice(0, 10);
    for (let i = 0; i < ids.length; i += 300) {
      const chunk = ids.slice(i, i + 300);
      const { data, error } = await supabase
        .from('producao_procedimentos')
        .select('paciente_clinicorp_id, amount, executed_date')
        .in('paciente_clinicorp_id', chunk);
      if (error) { console.error('[inad] entregue erro:', error.message); continue; }
      for (const r of (data || [])) {
        const id = String(r.paciente_clinicorp_id || '');
        if (!id) continue;
        entregueMap.set(id, (entregueMap.get(id) || 0) + (Number(r.amount) || 0));
        if (r.executed_date && r.executed_date.slice(0, 10) >= d90str) veioRecenteSet.add(id);
      }
    }
  }

  // consultas futuras marcadas.
  const consultaFuturaSet = new Set();
  if (ids.length) {
    for (let i = 0; i < ids.length; i += 300) {
      const chunk = ids.slice(i, i + 300);
      const { data, error } = await supabase
        .from('agenda_appointments')
        .select('paciente_clinicorp_id, appointment_date, deleted')
        .in('paciente_clinicorp_id', chunk)
        .gte('appointment_date', today);
      if (error) { console.error('[inad] agenda erro:', error.message); continue; }
      for (const r of (data || [])) {
        if (r.deleted) continue;
        const id = String(r.paciente_clinicorp_id || '');
        if (id) consultaFuturaSet.add(id);
      }
    }
  }

  return _inad.classificarESepararGrupos(pacientes, { entregueMap, consultaFuturaSet, veioRecenteSet });
}
```

- [ ] **Step 3: `await` na chamada de `processarInadimplentes`**

Em `fetchInadimplentesBackground` a linha hoje é `const processado = processarInadimplentes(allItems, today);`. Trocar por:

```js
    const processado = await processarInadimplentes(allItems, today);
```

(`fetchInadimplentesBackground` já é `async`.) Confirmar com grep que não há outra chamada síncrona:
Run: `grep -n "processarInadimplentes(" server.js`
Expected: 2 ocorrências (definição + a chamada com `await`).

- [ ] **Step 4: Verificar o endpoint end-to-end**

Rodar o servidor localmente (`node server.js` com `.env`) e forçar o refresh autenticado, OU após deploy chamar com um token válido. Verificação mínima sem UI — inspecionar o cache gravado via `execute_sql`:
```sql
SELECT
  jsonb_array_length(data->'grupo3') AS criticos,
  (data->'grupo1'->0) AS exemplo_em_cobranca
FROM inadimplentes_cache WHERE id = 1;
```
Expected: `exemplo_em_cobranca` é um objeto que agora contém as chaves `entregue`, `exposicao`, `engajamento`, `payerPhone`, `boletoUrl`, `grupo`.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(inad): server usa lib novo + mapas de entregue/agenda por paciente"
```

---

## Task 6: Frontend — selos, WhatsApp com pagador + boleto

**Files:**
- Modify: `public/index.html` (`inadWaBtn` ~L5266; `renderInadSection` ~L5283-5352; `openWhatsAppInad` ~L5457; cabeçalhos `<th>` da seção ~L1266-1276)

**Interfaces:**
- Consumes: campos por paciente vindos do cache (Task 5): `entregue`, `pago`, `exposicao`, `engajamento`, `payerName`, `payerPhone`, `boletoUrl`, `overdueAmount`, `oldestDueDate`.

- [ ] **Step 1: Helpers dos dois selos**

Perto de `inadDiasBadge` (L5260), adicionar:

```js
function inadExposicaoBadge(p) {
  const entregue = Number(p.entregue || 0), pago = Number(p.pago || 0);
  if (!entregue && !pago) return '<span style="color:var(--muted)">–</span>';
  const vermelho = p.exposicao === 'vermelho';
  const cls = vermelho ? 'inad-dias-crit' : 'inad-dias-ok';
  const titulo = `Pago ${_inadFmt(pago)} · Entregue ${_inadFmt(entregue)}`;
  return `<span class="${cls}" title="${titulo}">${vermelho ? '▲' : '✓'} ${_inadFmt(entregue - pago)}</span>`;
}
function inadEngajamentoBadge(p) {
  const map = {
    futuro:  ['inad-dias-ok',  'Tem consulta'],
    recente: ['inad-dias-med', 'Veio ≤90d'],
    sumiu:   ['inad-dias-crit','Sumiu'],
  };
  const [cls, label] = map[p.engajamento] || map.sumiu;
  return `<span class="${cls}">${label}</span>`;
}
```

- [ ] **Step 2: WhatsApp usa pagador**

Trocar `inadWaBtn(patientId, phone, name)` (L5266) para receber o paciente inteiro e priorizar o pagador. Alterar a assinatura e o `data-*`:

```js
function inadWaBtn(p) {
  const rawPhone = (p.payerPhone || p.phone || '');
  const clean = rawPhone.replace(/\D/g, '');
  const alvoNome = p.payerName || p.name || '';
  const SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>`;
  if (!clean) return `<button class="inad-wa" style="opacity:.35;cursor:default" disabled title="Sem telefone">${SVG}</button>`;
  return `<button class="inad-wa" data-phone="${clean}" data-nome="${escHtml(alvoNome)}" data-valor="${p.overdueAmount || 0}" data-venc="${escHtml(p.oldestDueDate || '')}" data-boleto="${escHtml(p.boletoUrl || '')}" onclick="openWhatsAppInadEl(this)" title="WhatsApp${p.payerName ? ' (pagador: ' + escHtml(p.payerName) + ')' : ''}">${SVG}</button>`;
}
```

- [ ] **Step 3: Mensagem personalizada com boleto**

Substituir `openWhatsAppInadEl` (L5453) e `openWhatsAppInad` (L5457):

```js
function openWhatsAppInadEl(el) {
  const d = el.dataset;
  const phone = d.phone; if (!phone) { toast('Sem telefone', true); return; }
  const num = phone.startsWith('55') ? phone : '55' + phone;
  const primeiro = (d.nome || '').split(' ')[0];
  const valor = Number(d.valor || 0);
  const venc = d.venc ? d.venc.split('-').reverse().join('/') : '';
  let msg = `Olá ${primeiro}! Tudo bem? Aqui é da Clínica AMA.`;
  if (valor > 0) msg += ` Identificamos uma parcela em aberto de ${_inadFmt(valor)}${venc ? ' (venc. ' + venc + ')' : ''}.`;
  if (d.boleto) msg += ` Segue a 2ª via atualizada para pagamento: ${d.boleto}`;
  window.open(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`, '_blank');
}
```

(Remover a função `openWhatsAppInad` antiga — não é mais chamada. Confirmar com `grep -n "openWhatsAppInad\b" public/index.html` que só resta `openWhatsAppInadEl`.)

- [ ] **Step 4: Renderizar os selos e a nova chamada do WhatsApp**

Em `renderInadSection` (L5302-5339), na montagem de cada linha:
- trocar `const wa = inadWaBtn(pid, p.phone, name);` por `const wa = inadWaBtn(p);`
- adicionar duas células (exposição e engajamento) antes da coluna do WhatsApp, nos dois ramos (crítico e não-crítico). Ex., no ramo não-crítico, antes de `<td class="inad-td-c">${wa}</td>`:

```js
      <td class="inad-td-c">${inadExposicaoBadge(p)}</td>
      <td class="inad-td-c">${inadEngajamentoBadge(p)}</td>
      <td class="inad-td-c">${wa}</td>
```

Fazer o mesmo no ramo `isCritico`. Atualizar o `colspan` do estado vazio: o cálculo `const cols = isCritico ? 11 : (num === 1 ? 9 : 10);` passa a `isCritico ? 13 : (num === 1 ? 11 : 12)` (duas colunas novas).

- [ ] **Step 5: Cabeçalhos das tabelas**

Em cada uma das 3 seções (`inad-body1/2/3`, HTML ~L1266-1276 e equivalentes), adicionar dois `<th>` antes do `<th ...>WA</th>`:

```html
          <th class="inad-th" style="text-align:center">Pago×Entregue</th>
          <th class="inad-th" style="text-align:center">Clínica</th>
          <th class="inad-th" style="text-align:center">WA</th>
```

E ajustar o `colspan` dos `<tbody>`/`<tfoot>` placeholders dessas seções para +2 (ex.: `colspan="9"` → `colspan="11"` na seção 1).

- [ ] **Step 6: Verificação manual no navegador**

Rodar o app (ver skill `run` / `node server.js`), logar como admin, abrir **Inadimplentes**, clicar **Atualizar dados**. Conferir:
- Aparecem as colunas **Pago×Entregue** (▲ vermelho quando entregamos mais do que recebemos) e **Clínica** (Tem consulta / Veio ≤90d / Sumiu).
- Passar o mouse no selo de exposição mostra "Pago X · Entregue Y".
- Clicar no WhatsApp de um paciente abre o wa.me com a mensagem citando o valor e, quando houver, o link do boleto; o número é o do pagador quando existir.
- Nenhum erro no console.

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "feat(inad): selos pago-vs-entregue e vem-a-clinica + WhatsApp pagador/boleto"
```

---

## Self-Review (feito)

- **Cobertura da spec (Fase 0+1):** id do paciente na produção (T1-3) ✓; id + janela futura na agenda (T1-2) ✓; captura pagador/boleto/forma (T4 lib, T5 fiação) ✓; grupos por exposição (T4) ✓; selos pago-vs-entregue e vem-à-clínica (T4+T6) ✓; cobrar pagador + WhatsApp com boleto (T6) ✓. Fases 2/3/4 = planos futuros (fora deste plano, como definido).
- **Placeholders:** nenhum — todo passo tem código/consulta/comando concreto.
- **Consistência de tipos:** `agregarPorPaciente`/`classificarESepararGrupos` com as mesmas assinaturas em T4 (definição+testes) e T5 (consumo); campos por paciente (`entregue`, `exposicao`, `engajamento`, `payerPhone`, `boletoUrl`, `overdueAmount`, `oldestDueDate`, `pago`) produzidos em T4/T5 e consumidos em T6 batem.
- **Riscos herdados da spec:** cobertura do backfill (T3 step 3 mede); semântica pago(caixa) × entregue(produção) exposta no tooltip do selo; A Receber ainda não validado logado — **não é tocado neste plano** (a relocação é Fase 2).
