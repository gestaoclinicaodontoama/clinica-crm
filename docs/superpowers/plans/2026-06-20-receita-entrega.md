# Receita x Entrega — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Módulo `/producao/` que compara valor de procedimentos realizados (Produção) com receita recebida em caixa (RECEIVED) no mesmo período, com breakdown por dentista e lista de procedimentos.

**Architecture:** Nova tabela `producao_procedimentos` sincronizada diariamente pelo `clinicorp-sync.js`; dois endpoints API consultam Supabase; página HTML vanilla segue padrão do `/financeiro/`.

**Tech Stack:** Node.js/Express, Supabase (Postgres), HTML/CSS/JS vanilla, Clinicorp API.

## Global Constraints

- Stack: Node.js + Express (`server.js`), HTML vanilla, Supabase Postgres
- Sem frameworks JS — só HTML/CSS/JS puro (padrão do projeto)
- Auth: `requireAuth` + `requireProducao` em todos os endpoints de produção
- `requireProducao = requireRole('financeiro', 'admin', 'mod_financeiro', 'mod_producao')`
- Migrações Supabase: `supabase/migrations/YYYYMMDDHHMMSS_nome.sql`, aplicar via MCP Supabase
- Deploy: `git push` + `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"` (sem perguntar)
- Rate limit Clinicorp: 25 chamadas/hora — backfill espaça automaticamente
- Supabase `.select()` limita 1000 linhas — usar `range()` ou `SUM` no SQL, nunca somar no JS
- NUNCA `.catch()` direto no builder Supabase (thenable sem .catch) — usar `try/catch` no `await`

---

## Mapa de Arquivos

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `supabase/migrations/20260620000000_producao_procedimentos.sql` | Criar | Tabela + índices |
| `sync/clinicorp-sync.js` | Modificar | Adicionar `syncProducao()` + step `producao` |
| `scripts/backfill-producao.js` | Criar | Backfill histórico por ano |
| `server.js` | Modificar | `requireProducao` + 2 endpoints API |
| `public/producao/index.html` | Criar | Página completa com cards + tabelas |
| `public/js/shared-nav.js` | Modificar | Entrada "Receita x Entrega" no nav |
| `public/index.html` | Modificar | Link nav + registro no módulo de Usuários |

---

### Task 1: Migração Supabase — tabela `producao_procedimentos`

**Files:**
- Create: `supabase/migrations/20260620000000_producao_procedimentos.sql`

**Interfaces:**
- Produces: tabela `producao_procedimentos` com índice único funcional para upserts idempotentes

- [ ] **Step 1: Criar arquivo de migração**

```sql
-- supabase/migrations/20260620000000_producao_procedimentos.sql

CREATE TABLE IF NOT EXISTS producao_procedimentos (
  id                     bigserial PRIMARY KEY,
  clinicorp_estimate_id  text        NOT NULL,
  clinicorp_treatment_id text,
  price_id               text,
  procedure_name         text,
  specialty_id           text,
  dentist_person_id      text,
  dentist_name           text,
  executed_date          date        NOT NULL,
  amount                 numeric     NOT NULL DEFAULT 0,
  bill_type              text,
  paciente_nome          text,
  atualizado_em          timestamptz NOT NULL DEFAULT now(),

  -- Coluna gerada para dedup idempotente via Supabase JS onConflict.
  -- Supabase JS não suporta onConflict em índices funcionais (COALESCE),
  -- então usamos coluna gerada com UNIQUE CONSTRAINT normal.
  dedup_key text GENERATED ALWAYS AS (
    clinicorp_estimate_id
    || '|' || COALESCE(price_id, '')
    || '|' || executed_date::text
    || '|' || COALESCE(dentist_person_id, '')
  ) STORED,

  CONSTRAINT producao_procedimentos_dedup_uk UNIQUE (dedup_key)
);

CREATE INDEX IF NOT EXISTS producao_procedimentos_date_idx
  ON producao_procedimentos (executed_date);

CREATE INDEX IF NOT EXISTS producao_procedimentos_dentist_idx
  ON producao_procedimentos (dentist_person_id);

CREATE INDEX IF NOT EXISTS producao_procedimentos_estimate_idx
  ON producao_procedimentos (clinicorp_estimate_id);
```

- [ ] **Step 2: Aplicar via MCP Supabase**

Usar `mcp__plugin_supabase_supabase__apply_migration` com:
- `project_id`: `mtqdpjhhqzvuklnlfpvi`
- `name`: `producao_procedimentos`
- `query`: conteúdo do arquivo acima

- [ ] **Step 3: Verificar migração aplicada**

Usar `mcp__plugin_supabase_supabase__list_migrations` e confirmar `20260620000000_producao_procedimentos` na lista.

Usar `mcp__plugin_supabase_supabase__execute_sql` para verificar a tabela:
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'producao_procedimentos' ORDER BY ordinal_position;
```
Esperado: 13 colunas listadas.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260620000000_producao_procedimentos.sql
git commit -m "feat: migração tabela producao_procedimentos"
```

---

### Task 2: Sync de produção em `clinicorp-sync.js`

**Files:**
- Modify: `sync/clinicorp-sync.js`

**Interfaces:**
- Consumes: `fetchRangeChunked(path, dias, chunkDias)` já definida no arquivo (linha ~293); `api.get(path, params)` da ClinicorpApi; `supabase` client
- Produces: função `syncProducao()` que retorna `{ count: number }`; step `'producao'` registrado no batch diário

- [ ] **Step 1: Adicionar constante e função `syncProducao` após `syncEntradas`**

Localizar a função `syncEntradas` (buscar por `async function syncEntradas`) e inserir após ela:

```js
const PRODUCAO_DIAS = 90;

async function syncProducao() {
  // Carrega catálogo de procedimentos uma vez (cache por sessão de sync)
  const catalogRaw = await api.get('/procedures/list', {});
  const catalog = new Map();
  if (Array.isArray(catalogRaw)) {
    for (const p of catalogRaw) {
      if (p.id) catalog.set(String(p.id), p.ProcedureName || p.Name || '');
    }
  }

  const estimates = await fetchRangeChunked('/estimates/list', PRODUCAO_DIAS);

  const rows = [];
  for (const est of estimates) {
    const estId = String(est.id || est.EstimateId || '');
    if (!estId) continue;
    const procs = est.ProcedureList || est.procedureList || [];
    for (const p of procs) {
      if (p.Executed !== 'X') continue;
      const amount = Number(p.Amount ?? 0);
      if (amount <= 0) continue;
      const priceId = p.PriceId ? String(p.PriceId) : null;
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
        atualizado_em:          new Date().toISOString(),
      });
    }
  }

  // Filtra linhas sem executed_date (dado inválido da Clinicorp)
  const valid = rows.filter(r => r.executed_date);

  let count = 0;
  for (let i = 0; i < valid.length; i += 500) {
    const chunk = valid.slice(i, i + 500);
    // onConflict usa a coluna gerada 'dedup_key' (UNIQUE CONSTRAINT normal)
    const { error } = await supabase.from('producao_procedimentos').upsert(chunk, {
      onConflict: 'dedup_key',
      ignoreDuplicates: false,
    });
    if (error) log(`ERRO upsert producao (batch ${i}): ${error.message}`);
    else count += chunk.length;
  }

  log(`Produção: ${count} procedimentos upserted (${valid.length} válidos de ${rows.length} brutos)`);
  return { count };
}

- [ ] **Step 2: Registrar step `producao` no batch diário**

Localizar o bloco de steps após `orcamentos_funil` (buscar por `await step('orcamentos_funil'`) e adicionar após:

```js
  await step('producao', async () => {
    const r = await syncProducao();
    result.steps.producao = r.count;
  });
```

- [ ] **Step 3: Verificar sintaxe**

```bash
node -e "require('./sync/clinicorp-sync.js')" 2>&1 | head -5
```
Esperado: sem erro (ou só aviso de variável de ambiente faltando, que é normal fora do .env).

- [ ] **Step 4: Commit**

```bash
git add sync/clinicorp-sync.js
git commit -m "feat: sync producao_procedimentos (90d, ProcedureList Executed=X)"
```

---

### Task 3: Script de backfill histórico

**Files:**
- Create: `scripts/backfill-producao.js`

**Interfaces:**
- Consumes: `syncProducao()` via import direto do módulo de sync (não — sync não exporta); usa ClinicorpApi + supabase direto
- Produces: script CLI `node scripts/backfill-producao.js 2026` que popula `producao_procedimentos` para o ano inteiro

- [ ] **Step 1: Criar o script**

```js
// scripts/backfill-producao.js
// Uso: node scripts/backfill-producao.js <ano>
// Ex:  node scripts/backfill-producao.js 2026
//      node scripts/backfill-producao.js 2025

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const ClinicorpApi = require('../sync/clinicorp-api');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const api = new ClinicorpApi({
  user: process.env.CLINICORP_USER,
  token: process.env.CLINICORP_TOKEN,
  subscriberId: process.env.CLINICORP_SUBSCRIBER_ID,
  businessId: process.env.CLINICORP_BUSINESS_ID,
});

const DELAY_MS = 3000; // 3s entre chunks = máx ~20 chamadas/minuto, seguro no rate limit

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

async function backfillMes(ano, mes) {
  const from = new Date(ano, mes - 1, 1);
  const to   = new Date(ano, mes, 0); // último dia do mês
  const fromStr = dateStr(from);
  const toStr   = dateStr(to);

  console.log(`[${fromStr} → ${toStr}] buscando estimates...`);
  const estimates = await api.get('/estimates/list', { from: fromStr, to: toStr });
  if (!Array.isArray(estimates)) {
    console.log(`  sem dados`);
    return 0;
  }

  // Carrega catálogo apenas na primeira chamada (passa como parâmetro nos demais)
  return { estimates, fromStr, toStr };
}

async function main() {
  const ano = parseInt(process.argv[2]);
  if (!ano || ano < 2020 || ano > 2030) {
    console.error('Uso: node scripts/backfill-producao.js <ano>');
    process.exit(1);
  }

  // Carrega catálogo uma vez
  console.log('Carregando catálogo de procedimentos...');
  const catalogRaw = await api.get('/procedures/list', {});
  const catalog = new Map();
  if (Array.isArray(catalogRaw)) {
    for (const p of catalogRaw) {
      if (p.id) catalog.set(String(p.id), p.ProcedureName || p.Name || '');
    }
  }
  console.log(`Catálogo: ${catalog.size} procedimentos`);

  let totalGeral = 0;

  for (let mes = 1; mes <= 12; mes++) {
    const from = new Date(ano, mes - 1, 1);
    const to   = new Date(ano, mes, 0);

    // Não backfillar meses futuros
    if (from > new Date()) { console.log(`Mês ${mes}/${ano}: futuro, pulando`); break; }

    const fromStr = dateStr(from);
    const toStr   = dateStr(to);
    console.log(`\n[${fromStr} → ${toStr}] buscando...`);

    let estimates;
    try {
      estimates = await api.get('/estimates/list', { from: fromStr, to: toStr });
    } catch (e) {
      console.error(`  ERRO ao buscar: ${e.message}`);
      await sleep(DELAY_MS);
      continue;
    }

    if (!Array.isArray(estimates)) { console.log('  sem dados'); await sleep(DELAY_MS); continue; }

    const rows = [];
    for (const est of estimates) {
      const estId = String(est.id || est.EstimateId || '');
      if (!estId) continue;
      const procs = est.ProcedureList || est.procedureList || [];
      for (const p of procs) {
        if (p.Executed !== 'X') continue;
        const amount = Number(p.Amount ?? 0);
        if (amount <= 0) continue;
        const priceId = p.PriceId ? String(p.PriceId) : null;
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
          atualizado_em:          new Date().toISOString(),
        });
      }
    }

    const valid = rows.filter(r => r.executed_date);
    console.log(`  ${estimates.length} orçamentos → ${rows.length} brutos → ${valid.length} válidos`);

    let count = 0;
    for (let i = 0; i < valid.length; i += 500) {
      const chunk = valid.slice(i, i + 500);
      const { error } = await supabase.from('producao_procedimentos').upsert(chunk, {
        onConflict: 'dedup_key',
        ignoreDuplicates: false,
      });
      if (error) console.error(`  ERRO upsert batch ${i}: ${error.message}`);
      else count += chunk.length;
    }

    console.log(`  ✓ ${count} upserted`);
    totalGeral += count;

    await sleep(DELAY_MS);
  }

  console.log(`\n✅ Backfill ${ano} concluído: ${totalGeral} procedimentos no total`);

  // Verificação final
  const { data } = await supabase
    .from('producao_procedimentos')
    .select('executed_date.sum(amount)', { count: 'exact' })
    .gte('executed_date', `${ano}-01-01`)
    .lte('executed_date', `${ano}-12-31`);
  console.log(`Verificação Supabase ${ano}: ${data?.length || 0} registros`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verificar sintaxe**

```bash
node -e "require('./scripts/backfill-producao.js')" 2>&1 | head -3
```
Esperado: começa a executar (ou erro de env, não de sintaxe).

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-producao.js
git commit -m "feat: script backfill-producao histórico por ano"
```

---

### Task 4: Endpoints API em `server.js`

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: tabela `producao_procedimentos` e `fin_lancamentos` no Supabase
- Produces:
  - `GET /api/producao/resumo?from&to` → `{ from, to, producao_total, receita_total, percentual, por_dentista[] }`
  - `GET /api/producao/procedimentos?from&to&page&limit` → `{ total, page, data[] }`

- [ ] **Step 1: Adicionar middleware `requireProducao` após `requireFinanceiro`**

Localizar linha `const requireFinanceiro = requireRole(...)` em server.js e adicionar logo após:

```js
const requireProducao  = requireRole('financeiro', 'admin', 'mod_financeiro', 'mod_producao');
```

- [ ] **Step 2: Adicionar endpoints após os endpoints de `/api/financeiro/`**

Localizar o bloco de endpoints financeiros (buscar `app.get('/api/financeiro/dre'`) e inserir os dois endpoints após o último endpoint de financeiro:

```js
// ── Produção: Receita x Entrega ──────────────────────────────────────────────

app.get('/api/producao/resumo', requireAuth, requireProducao, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from e to obrigatórios' });

  try {
    // Produção total e por dentista
    const { data: prods, error: eP } = await supabase
      .from('producao_procedimentos')
      .select('dentist_person_id, dentist_name, amount')
      .gte('executed_date', from)
      .lte('executed_date', to);
    if (eP) throw new Error(eP.message);

    const producao_total = (prods || []).reduce((s, r) => s + Number(r.amount), 0);

    // Agrupa por dentista
    const dentMap = new Map();
    for (const r of (prods || [])) {
      const key = r.dentist_person_id || '__sem_dentista__';
      const entry = dentMap.get(key) || { dentist_person_id: key, dentist_name: r.dentist_name || 'Sem dentista', producao: 0 };
      entry.producao += Number(r.amount);
      dentMap.set(key, entry);
    }
    const por_dentista = [...dentMap.values()]
      .sort((a, b) => b.producao - a.producao)
      .map(d => ({
        ...d,
        participacao_pct: producao_total > 0 ? Math.round((d.producao / producao_total) * 1000) / 10 : 0,
      }));

    // Receita RECEIVED do período (usa SUM no Supabase para evitar limite de 1000 linhas)
    const { data: recData, error: eR } = await supabase
      .rpc('sum_received', { p_from: from, p_to: to });
    // Fallback se a RPC não existir ainda: query direta com paginação
    let receita_total = 0;
    if (eR) {
      // Sem RPC: soma paginada
      let offset = 0;
      while (true) {
        const { data: page, error: ep2 } = await supabase
          .from('fin_lancamentos')
          .select('valor')
          .eq('post_type', 'RECEIVED')
          .eq('ativo', true)
          .gte('data', from)
          .lte('data', to)
          .range(offset, offset + 999);
        if (ep2 || !page || !page.length) break;
        receita_total += page.reduce((s, r) => s + Number(r.valor), 0);
        if (page.length < 1000) break;
        offset += 1000;
      }
    } else {
      receita_total = Number(recData?.[0]?.total ?? recData ?? 0);
    }

    const percentual = receita_total > 0
      ? Math.round((producao_total / receita_total) * 1000) / 10
      : null;

    res.json({ from, to, producao_total, receita_total, percentual, por_dentista });
  } catch (e) {
    console.error('[producao/resumo]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/producao/procedimentos', requireAuth, requireProducao, async (req, res) => {
  const { from, to } = req.query;
  const page  = Math.max(1, parseInt(req.query.page  || '1'));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '100')));
  if (!from || !to) return res.status(400).json({ error: 'from e to obrigatórios' });

  try {
    const offset = (page - 1) * limit;
    const { data, error, count } = await supabase
      .from('producao_procedimentos')
      .select('executed_date, dentist_name, procedure_name, paciente_nome, amount, bill_type', { count: 'exact' })
      .gte('executed_date', from)
      .lte('executed_date', to)
      .order('executed_date', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(error.message);
    res.json({ total: count || 0, page, data: data || [] });
  } catch (e) {
    console.error('[producao/procedimentos]', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 3: Criar RPC `sum_received` no Supabase (simplifica a query de receita)**

Usar `mcp__plugin_supabase_supabase__execute_sql`:

```sql
CREATE OR REPLACE FUNCTION sum_received(p_from date, p_to date)
RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(valor), 0)
  FROM fin_lancamentos
  WHERE post_type = 'RECEIVED'
    AND ativo = true
    AND data >= p_from
    AND data <= p_to;
$$;
```

Após criar, o endpoint `/resumo` vai preferir a RPC (mais eficiente que paginação).

- [ ] **Step 4: Verificar sintaxe do server.js**

```bash
node -e "require('./server.js')" 2>&1 | head -5
```
Esperado: o server inicia (ou erro de env, não de sintaxe).

- [ ] **Step 5: Testar endpoints manualmente (com servidor rodando)**

```bash
# Iniciar servidor local
node server.js &

# Testar resumo (substituir TOKEN por um token válido)
curl -s "http://localhost:3001/api/producao/resumo?from=2026-06-01&to=2026-06-30" \
  -H "Authorization: Bearer TOKEN" | head -100

# Testar procedimentos
curl -s "http://localhost:3001/api/producao/procedimentos?from=2026-06-01&to=2026-06-30" \
  -H "Authorization: Bearer TOKEN" | head -100
```

Esperado: JSON com `producao_total`, `receita_total`, `percentual` e array `por_dentista`. Os valores serão 0 até o backfill rodar — isso é esperado.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: endpoints GET /api/producao/resumo e /procedimentos"
```

---

### Task 5: Página `/producao/index.html`

**Files:**
- Create: `public/producao/index.html`

**Interfaces:**
- Consumes: `GET /api/producao/resumo`, `GET /api/producao/procedimentos`
- Produces: página funcional em `/producao/` com seletor de mês, cards, tabelas

- [ ] **Step 1: Criar `public/producao/index.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receita x Entrega — AMA</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root[data-theme="dark"] {
  --bg:#0f1117;--bg2:#181b24;--bg3:#1e2230;--border:#2a2f42;
  --text:#e8eaf0;--muted:#6b7280;--accent:#4f8ef7;--accent-hover:#3a78e0;
  --green:#22c55e;--yellow:#f59e0b;--red:#ef4444;
}
:root[data-theme="light"] {
  --bg:#f7f8fa;--bg2:#ffffff;--bg3:#f1f3f7;--border:#e3e6ed;
  --text:#1a1d29;--muted:#6b7280;--accent:#3b82f6;--accent-hover:#2563eb;
  --green:#16a34a;--yellow:#d97706;--red:#dc2626;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.wrap{padding:20px 24px}
.header{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.header h1{font-size:20px;font-weight:700;flex:1}
.controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:20px}
.controls label{font-size:13px;color:var(--muted);font-weight:500}
.controls input[type="month"],.controls input[type="date"]{
  padding:6px 10px;border:1px solid var(--border);border-radius:8px;
  font-size:13px;background:var(--bg2);color:var(--text);font-family:inherit;outline:none
}
.controls input:focus{border-color:var(--accent)}
.btn{padding:7px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none;font-family:inherit;transition:all .15s}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent-hover)}
.btn-primary:disabled{opacity:.6;cursor:default}
.btn-ghost{background:var(--bg2);color:var(--text);border:1px solid var(--border)}
.btn-ghost:hover{background:var(--bg3)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:18px 20px}
.card-label{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
.card-value{font-size:24px;font-weight:700}
.card-sub{font-size:12px;color:var(--muted);margin-top:4px}
.card-green .card-value{color:var(--green)}
.card-yellow .card-value{color:var(--yellow)}
.card-red .card-value{color:var(--red)}
.section{background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:20px}
.section-header{padding:14px 18px;border-bottom:1px solid var(--border);font-weight:600;font-size:14px;display:flex;justify-content:space-between;align-items:center}
table{border-collapse:collapse;width:100%;font-size:13px}
th{padding:10px 14px;text-align:left;font-size:11px;font-weight:600;color:var(--muted);border-bottom:1px solid var(--border);text-transform:uppercase;letter-spacing:.5px}
th:last-child,td:last-child{text-align:right}
td{padding:9px 14px;border-bottom:1px solid var(--border)}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--bg3)}
.empty{padding:40px;color:var(--muted);text-align:center;font-size:13px}
.pagination{display:flex;gap:8px;align-items:center;padding:12px 18px;border-top:1px solid var(--border);font-size:13px;color:var(--muted)}
.range-inputs{display:none;gap:8px;align-items:center}
.range-inputs.visible{display:flex}
</style>
</head>
<body>
<script src="/js/shared-nav.js" data-active="producao"></script>
<div class="wrap">
  <div class="header">
    <h1>Receita × Entrega</h1>
  </div>

  <div class="controls">
    <label>Mês</label>
    <input type="month" id="mes" />
    <button class="btn btn-ghost" id="btnRange" onclick="toggleRange()">Range livre</button>
    <div class="range-inputs" id="rangeInputs">
      <label>De</label><input type="date" id="rangeFrom" />
      <label>Até</label><input type="date" id="rangeTo" />
    </div>
    <button class="btn btn-primary" onclick="carregar()">Carregar</button>
    <button class="btn btn-ghost" onclick="atualizarDados()" id="btnSync">🔄 Atualizar dados</button>
  </div>

  <div class="cards" id="cards">
    <div class="card"><div class="card-label">Produção</div><div class="card-value" id="valProd">—</div><div class="card-sub">procedimentos realizados</div></div>
    <div class="card"><div class="card-label">Receita</div><div class="card-value" id="valRec">—</div><div class="card-sub">recebido em caixa (RECEIVED)</div></div>
    <div class="card" id="cardAlign"><div class="card-label">Alinhamento</div><div class="card-value" id="valAlign">—</div><div class="card-sub">Produção ÷ Receita</div></div>
  </div>

  <div class="section">
    <div class="section-header">Por dentista</div>
    <table><thead><tr><th>Dentista</th><th>Produção</th><th>% da produção</th></tr></thead>
    <tbody id="tbDentista"><tr><td colspan="3" class="empty">Selecione um período</td></tr></tbody></table>
  </div>

  <div class="section">
    <div class="section-header">
      Procedimentos realizados
      <span id="totalProc" style="font-size:12px;color:var(--muted);font-weight:400"></span>
    </div>
    <table><thead><tr><th>Data</th><th>Dentista</th><th>Procedimento</th><th>Paciente</th><th>Valor</th></tr></thead>
    <tbody id="tbProc"><tr><td colspan="5" class="empty">Selecione um período</td></tr></tbody></table>
    <div class="pagination" id="paginacao" style="display:none">
      <button class="btn btn-ghost" id="btnAnterior" onclick="mudarPagina(-1)">← Anterior</button>
      <span id="paginaInfo"></span>
      <button class="btn btn-ghost" id="btnProximo" onclick="mudarPagina(1)">Próximo →</button>
    </div>
  </div>
</div>

<script>
const TOKEN_KEY = [...Object.keys(localStorage)].find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
const TOKEN = TOKEN_KEY ? JSON.parse(localStorage.getItem(TOKEN_KEY) || '{}')?.access_token : null;

let currentPage = 1;
let currentFrom = '';
let currentTo   = '';

// Inicializa com mês atual
const hoje = new Date();
document.getElementById('mes').value = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;

function toggleRange() {
  const ri = document.getElementById('rangeInputs');
  const mes = document.getElementById('mes');
  const visible = ri.classList.toggle('visible');
  mes.style.display = visible ? 'none' : '';
  document.getElementById('btnRange').textContent = visible ? 'Usar mês' : 'Range livre';
}

function getPeriodo() {
  const rangeVisible = document.getElementById('rangeInputs').classList.contains('visible');
  if (rangeVisible) {
    return { from: document.getElementById('rangeFrom').value, to: document.getElementById('rangeTo').value };
  }
  const [ano, mes] = document.getElementById('mes').value.split('-');
  if (!ano || !mes) return null;
  const from = `${ano}-${mes}-01`;
  const ultimo = new Date(Number(ano), Number(mes), 0).getDate();
  const to = `${ano}-${mes}-${String(ultimo).padStart(2, '0')}`;
  return { from, to };
}

function fmt(v) {
  return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function apiFetch(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function carregar() {
  const p = getPeriodo();
  if (!p || !p.from || !p.to) { alert('Selecione um período válido'); return; }
  currentFrom = p.from;
  currentTo   = p.to;
  currentPage = 1;
  await Promise.all([carregarResumo(), carregarProcedimentos()]);
}

async function carregarResumo() {
  document.getElementById('valProd').textContent = '...';
  document.getElementById('valRec').textContent  = '...';
  document.getElementById('valAlign').textContent = '...';
  document.getElementById('tbDentista').innerHTML = '<tr><td colspan="3" class="empty">Carregando...</td></tr>';

  try {
    const d = await apiFetch(`/api/producao/resumo?from=${currentFrom}&to=${currentTo}`);

    document.getElementById('valProd').textContent = fmt(d.producao_total);
    document.getElementById('valRec').textContent  = fmt(d.receita_total);

    const pct = d.percentual;
    document.getElementById('valAlign').textContent = pct !== null ? `${pct}%` : '—';
    const card = document.getElementById('cardAlign');
    card.className = 'card ' + (pct === null ? '' : pct >= 90 && pct <= 110 ? 'card-green' : pct >= 80 && pct <= 125 ? 'card-yellow' : 'card-red');

    const tb = document.getElementById('tbDentista');
    if (!d.por_dentista || !d.por_dentista.length) {
      tb.innerHTML = '<tr><td colspan="3" class="empty">Sem dados de produção neste período</td></tr>';
      return;
    }
    tb.innerHTML = d.por_dentista.map(r => `
      <tr>
        <td>${r.dentist_name}</td>
        <td>${fmt(r.producao)}</td>
        <td>${r.participacao_pct}%</td>
      </tr>`).join('');
  } catch (e) {
    document.getElementById('tbDentista').innerHTML = `<tr><td colspan="3" class="empty">Erro: ${e.message}</td></tr>`;
  }
}

async function carregarProcedimentos() {
  document.getElementById('tbProc').innerHTML = '<tr><td colspan="5" class="empty">Carregando...</td></tr>';
  document.getElementById('paginacao').style.display = 'none';

  try {
    const d = await apiFetch(`/api/producao/procedimentos?from=${currentFrom}&to=${currentTo}&page=${currentPage}&limit=100`);

    document.getElementById('totalProc').textContent = `${d.total} procedimentos`;

    if (!d.data || !d.data.length) {
      document.getElementById('tbProc').innerHTML = '<tr><td colspan="5" class="empty">Sem procedimentos neste período</td></tr>';
      return;
    }

    document.getElementById('tbProc').innerHTML = d.data.map(r => `
      <tr>
        <td>${r.executed_date ? r.executed_date.slice(0, 10).split('-').reverse().join('/') : '—'}</td>
        <td>${r.dentist_name || '—'}</td>
        <td>${r.procedure_name || '<em style="color:var(--muted)">não identificado</em>'}</td>
        <td>${r.paciente_nome || '—'}</td>
        <td>${fmt(r.amount)}</td>
      </tr>`).join('');

    const totalPags = Math.ceil(d.total / 100);
    if (totalPags > 1) {
      document.getElementById('paginaInfo').textContent = `Página ${currentPage} de ${totalPags}`;
      document.getElementById('btnAnterior').disabled = currentPage <= 1;
      document.getElementById('btnProximo').disabled  = currentPage >= totalPags;
      document.getElementById('paginacao').style.display = 'flex';
    }
  } catch (e) {
    document.getElementById('tbProc').innerHTML = `<tr><td colspan="5" class="empty">Erro: ${e.message}</td></tr>`;
  }
}

async function mudarPagina(delta) {
  currentPage = Math.max(1, currentPage + delta);
  await carregarProcedimentos();
}

async function atualizarDados() {
  const btn = document.getElementById('btnSync');
  btn.disabled = true;
  btn.textContent = '⏳ Sincronizando...';
  try {
    const r = await fetch('/api/admin/sync-clinicorp', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
    const d = await r.json();
    btn.textContent = d.ok ? '✅ Sincronizado' : '⚠️ Erro no sync';
    if (d.ok && currentFrom) await Promise.all([carregarResumo(), carregarProcedimentos()]);
  } catch (e) {
    btn.textContent = '⚠️ Erro';
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = '🔄 Atualizar dados'; }, 3000);
}
</script>
</body>
</html>
```

- [ ] **Step 2: Testar a página no navegador**

Com o servidor rodando em localhost, acessar `http://localhost:3001/producao/`. Verificar:
- Cards aparecem com "—"
- Seletor de mês iniciado no mês atual
- Botão "Range livre" abre os datepickers e esconde o input de mês
- Clicar "Carregar" sem período = alerta
- shared-nav carrega (sidebar visível)

- [ ] **Step 3: Commit**

```bash
git add public/producao/index.html
git commit -m "feat: página /producao/ com cards e tabelas"
```

---

### Task 6: Navegação e registro no módulo de Usuários

**Files:**
- Modify: `public/js/shared-nav.js`
- Modify: `public/index.html`

**Interfaces:**
- Produces: link "Receita x Entrega" no nav lateral; módulo registrado para criação de usuários

- [ ] **Step 1: Adicionar entrada em `shared-nav.js`**

Localizar a entrada do Financeiro (buscar `financeiro,mod_financeiro` em shared-nav.js, linha ~184) e adicionar logo após:

```js
    <a class="nav-btn${activePage==='producao'?' active':''}" href="/producao/"
      data-roles="financeiro,mod_financeiro,mod_producao">
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>
      </svg>
      Receita × Entrega
    </a>
```

- [ ] **Step 2: Adicionar link no nav de `public/index.html`**

Localizar o link do Financeiro em `public/index.html` (buscar `href="/financeiro/"`) e adicionar logo após:

```html
  <a class="nav-btn" href="/producao/" data-roles="financeiro,mod_financeiro,mod_producao">
    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>
    </svg>
    Receita × Entrega
  </a>
```

- [ ] **Step 3: Registrar em `_ROLE_LABELS` em `public/index.html`**

Localizar `mod_financeiro:'Financeiro'` e adicionar após:

```js
  mod_producao:'Receita × Entrega',
```

- [ ] **Step 4: Adicionar ao array de módulos extras no módulo de Usuários**

Localizar o array que lista módulos extras (buscar `{r:'mod_financeiro',label:'Financeiro'}`) e adicionar após:

```js
{r:'mod_producao',label:'Receita × Entrega'},
```

- [ ] **Step 5: Adicionar checkbox no formulário de Usuários**

Localizar o checkbox `nu-mod-financeiro` (ou a label "Financeiro" no formulário de criação de usuário) e adicionar ao lado:

```html
<label style="display:flex;align-items:center;gap:6px;cursor:pointer">
  <input type="checkbox" id="nu-mod-producao">
  Receita × Entrega
</label>
```

- [ ] **Step 6: Adicionar push em `criarUsuario()`**

Localizar dentro de `criarUsuario()` o bloco que faz push para `mod_financeiro` e adicionar após:

```js
if (document.getElementById('nu-mod-producao').checked) roles.push('mod_producao');
```

- [ ] **Step 7: Commit**

```bash
git add public/js/shared-nav.js public/index.html
git commit -m "feat: navegação e registro Usuários para mod_producao"
```

---

### Task 7: Deploy, backfill e validação

**Files:** nenhum novo arquivo

- [ ] **Step 1: Push e deploy**

```bash
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

Aguardar deploy confirmar (resposta com `ok: true`).

- [ ] **Step 2: Verificar boot sem erro**

```bash
curl -s "https://plataformaama-plataforma.uc5as5.easypanel.host/api/version"
```
Esperado: resposta JSON sem erro 503.

- [ ] **Step 3: Rodar backfill de 2026**

```bash
node scripts/backfill-producao.js 2026
```

Esperado: log por mês, `✅ Backfill 2026 concluído: N procedimentos no total`. Anotar o total.

- [ ] **Step 4: Rodar backfill de 2025**

```bash
node scripts/backfill-producao.js 2025
```

Aguardar (~1 min com delay de 3s entre chunks). Anotar o total.

- [ ] **Step 5: Verificar no Supabase**

Usar `mcp__plugin_supabase_supabase__execute_sql`:

```sql
SELECT
  date_trunc('month', executed_date)::date AS mes,
  COUNT(*)                                 AS procedimentos,
  SUM(amount)                              AS producao_total
FROM producao_procedimentos
GROUP BY 1
ORDER BY 1 DESC
LIMIT 20;
```

Esperado: linhas mensais de 2025 e 2026 com valores > 0.

- [ ] **Step 6: Validar a página no navegador**

Acessar `https://plataformaama-plataforma.uc5as5.easypanel.host/producao/` logado como admin.

Verificar:
1. Cards de Produção e Receita mostram valores reais para o mês atual
2. % Alinhamento tem cor (verde/amarelo/vermelho)
3. Tabela por dentista lista Marcos e Matheus com valores
4. Tabela de procedimentos lista itens com data, dentista e nome do procedimento
5. Paginação aparece se houver > 100 procedimentos
6. "🔄 Atualizar dados" mostra "✅ Sincronizado" após alguns segundos
7. Link "Receita × Entrega" aparece no nav lateral

- [ ] **Step 7: Commit final (se houver ajustes de bugfix)**

```bash
git add -p  # apenas o que mudou nos ajustes
git commit -m "fix: ajustes pós-validação producao"
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```
