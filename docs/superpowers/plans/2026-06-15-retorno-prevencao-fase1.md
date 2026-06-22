# Retorno de Prevenção (Fase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar, na página Curva ABC, quando cada paciente fez prevenção pela última vez e quem está vencido (>180 dias), com filtro Adulto/Infantil.

**Architecture:** Uma fase nova no sync diário (`syncPrevencao`) lê os procedimentos realizados (`estimates/list` → `ProcedureList` com `Executed="X"`), classifica em prevenção adulto/infantil por **nome** (lógica pura testável em `lib/`), grava eventos em `prevencao_eventos` e agrega em colunas novas da `pacientes_abc` (`ultima_prevencao*`). A fase também insere na base os pacientes de prevenção que ainda não existem (convênio-only). O frontend `curva-abc.js` ganha 3 colunas ordenáveis + filtro de categoria + status de vencimento.

**Tech Stack:** Node.js + Express, Supabase Postgres (migrations via MCP), HTML/CSS/JS vanilla, `node:test`.

**Spec:** `docs/superpowers/specs/2026-06-15-retorno-prevencao-design.md`

**Decisão de implementação (refina o spec):** em vez de uma tabela `prevencao_status` separada, as colunas de prevenção ficam na `pacientes_abc` (upsert do Supabase só toca colunas informadas, então o sync ABC não as zera) e a fase de prevenção faz upsert dos pacientes convênio-only que faltam. Isso honra o "cobrir todos os pacientes" do review e reaproveita o frontend existente com mudança mínima.

---

## File Structure

- **Create** `lib/prevencao/classificacao.js` — lógica pura: normaliza nome, classifica em `'adulto'|'infantil'|null`. Sem I/O.
- **Create** `lib/prevencao/classificacao.test.js` — testes `node:test`.
- **Modify** `sync/clinicorp-sync.js` — novo helper `loadProcedureCatalog()`, nova função `syncPrevencao()`, nova fase em `runSync()`, export.
- **Create** `scripts/backfill-prevencao.js` — carga histórica única (janela larga).
- **Modify** `public/js/pos-tratamento/curva-abc.js` — colunas, filtro de categoria, status, ordenação.
- **Modify** `public/pos-tratamento/curva-abc.html` — chips de categoria + (opcional) preset.
- **Modify** `public/js/nav-config.js` — remover item `recall`, adicionar `curva-abc`.
- **DB (migrations via MCP):** colunas em `pacientes_abc`; tabelas `prevencao_eventos`, `prevencao_procedimentos` (config+seed), `prevencao_nao_classificados` (auditoria); chave em `app_config`.

---

## Task 1: Lógica de classificação (pura, TDD)

**Files:**
- Create: `lib/prevencao/classificacao.js`
- Test: `lib/prevencao/classificacao.test.js`

- [ ] **Step 1: Escrever os testes que falham**

```js
// lib/prevencao/classificacao.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizarNome, classificar } = require('./classificacao');

test('normalizarNome remove código, acento e caixa', () => {
  assert.strictEqual(normalizarNome('84000090 - Aplicação Tópica de Flúor'), 'aplicacao topica de fluor');
  assert.strictEqual(normalizarNome('84.00.019-8 - Profilaxia: polimento coronário'), 'profilaxia polimento coronario');
});

test('profilaxia e flúor contam como prevenção adulto', () => {
  assert.strictEqual(classificar({ nome: '84000198 - Profilaxia:polimento coronário' }), 'adulto');
  assert.strictEqual(classificar({ nome: 'Aplicação tópica de flúor' }), 'adulto');
  assert.strictEqual(classificar({ nome: '85300047 - Raspagem supra-gengival' }), 'adulto');
  assert.strictEqual(classificar({ nome: '84000139 - Atividade educativa em saúde bucal' }), 'adulto');
});

test('condicionamento é infantil', () => {
  assert.strictEqual(classificar({ nome: '81000014 - Condicionamento em Odontologia' }), 'infantil');
});

test('especialidade Odontopediatria ou Dra. Ana Luiza força infantil', () => {
  assert.strictEqual(classificar({ nome: 'Aplicação tópica de flúor', expertise: 'Odontopediatria' }), 'infantil');
  assert.strictEqual(classificar({ nome: 'Profilaxia', profissional: 'Ana Luiza Rodrigues Coelho' }), 'infantil');
});

test('consulta sozinha, sub-gengival e tratamentos NÃO contam', () => {
  assert.strictEqual(classificar({ nome: '81000065 - Consulta odontológica inicial' }), null);
  assert.strictEqual(classificar({ nome: '85300039 - Raspagem sub-gengival/alisamento radicular' }), null);
  assert.strictEqual(classificar({ nome: 'Manutenção periodontal' }), null);
  assert.strictEqual(classificar({ nome: '83000089 - Exodontia simples de decíduo' }), null);
  assert.strictEqual(classificar({ nome: 'Pulpotomia em dente decíduo' }), null);
  assert.strictEqual(classificar({ nome: 'Imobilização dentária em dentes permanentes' }), null);
  assert.strictEqual(classificar({ nome: 'Manutenção mensal de aparelho fixo' }), null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — `Cannot find module './classificacao'`.

- [ ] **Step 3: Implementar o mínimo**

```js
// lib/prevencao/classificacao.js
'use strict';

function normalizarNome(s) {
  if (!s) return '';
  let n = String(s).replace(/^\s*[\d.\-]+\s*-\s*/, '');      // tira "84000090 - " / "84.00.009-0 - "
  n = n.normalize('NFD').replace(/[̀-ͯ]/g, '');     // tira acentos
  n = n.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();     // só alfanumérico + espaço
  return n.replace(/\s+/g, ' ');
}

// Chave (substring no nome normalizado) → categoria base.
// 'condicionamento' nasce infantil; o resto adulto (pode virar infantil por especialidade/profissional).
const REGRAS_PADRAO = [
  ['profilaxia', 'adulto'], ['polimento coronario', 'adulto'],
  ['aplicacao topica de fluor', 'adulto'], ['verniz fluoretado', 'adulto'], ['fluor verniz', 'adulto'],
  ['remineraliz', 'adulto'], ['fluorterapia', 'adulto'],
  ['controle de biofilme', 'adulto'], ['controle de placa', 'adulto'],
  ['remocao dos fatores de retencao do biofilme', 'adulto'],
  ['atividade educativa', 'adulto'], ['orientacao de higiene', 'adulto'],
  ['raspagem supra', 'adulto'],
  ['aplicacao de selante', 'adulto'], ['aplicacao de cariostatico', 'adulto'],
  ['condicionamento', 'infantil'],
  ['pacote de prevencao', 'adulto'], ['pacote de atendimento', 'adulto'], ['pacote atendimento preventivo', 'adulto'],
  ['prevencao', 'adulto'],
];

function classificar({ nome, expertise, profissional } = {}, regras = REGRAS_PADRAO) {
  const n = normalizarNome(nome);
  if (!n) return null;
  if (n.includes('sub') && n.includes('gengiv')) return null;   // raspagem sub-gengival = tratamento
  if (n.startsWith('consulta')) return null;                    // consulta não dispara sozinha

  let categoria = null;
  for (const [chave, cat] of regras) {
    if (n.includes(chave)) { categoria = cat; break; }
  }
  if (!categoria) return null;

  const prof = (profissional || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (expertise === 'Odontopediatria' || prof.startsWith('ana luiza')) categoria = 'infantil';
  return categoria;
}

module.exports = { normalizarNome, classificar, REGRAS_PADRAO };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS (todos os testes de `classificacao.test.js`).

- [ ] **Step 5: Commit**

```bash
git add lib/prevencao/classificacao.js lib/prevencao/classificacao.test.js
git commit -m "feat(prevencao): lógica pura de classificação de procedimentos (TDD)"
```

---

## Task 2: Migration — colunas, tabelas e seed

**Files:** aplicar via **Supabase MCP `apply_migration`** (project `mtqdpjhhqzvuklnlfpvi`). Nome: `prevencao_fase1`.

- [ ] **Step 1: Aplicar a migration**

SQL (uma migration só):

```sql
-- 1) Colunas de agregado na pacientes_abc (upsert do ABC não as toca)
ALTER TABLE pacientes_abc
  ADD COLUMN IF NOT EXISTS ultima_prevencao          DATE,
  ADD COLUMN IF NOT EXISTS ultima_prevencao_adulto   DATE,
  ADD COLUMN IF NOT EXISTS ultima_prevencao_infantil DATE,
  ADD COLUMN IF NOT EXISTS dias_sem_prevencao        INTEGER;

-- 2) Eventos detalhados (1 linha por procedimento preventivo realizado)
CREATE TABLE IF NOT EXISTS prevencao_eventos (
  id                BIGSERIAL PRIMARY KEY,
  clinicorp_id      BIGINT NOT NULL,
  data              DATE   NOT NULL,
  categoria         TEXT   NOT NULL,            -- 'adulto' | 'infantil'
  procedimento      TEXT,
  expertise         TEXT,
  dentist_person_id BIGINT,
  profissional      TEXT,
  bill_type         TEXT,
  treatment_id      BIGINT,
  sincronizado_em   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (clinicorp_id, data, categoria, treatment_id)
);
CREATE INDEX IF NOT EXISTS idx_prev_eventos_pac ON prevencao_eventos (clinicorp_id);

-- 3) Config editável (transparência + futura edição item-a-item)
CREATE TABLE IF NOT EXISTS prevencao_procedimentos (
  id            BIGSERIAL PRIMARY KEY,
  nome_norm     TEXT NOT NULL UNIQUE,
  categoria     TEXT NOT NULL,                  -- 'adulto' | 'infantil'
  incluir       BOOLEAN NOT NULL DEFAULT TRUE,
  observacao    TEXT,
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 4) Auditoria: procedimentos executados que NÃO casaram com a config
CREATE TABLE IF NOT EXISTS prevencao_nao_classificados (
  nome_norm     TEXT PRIMARY KEY,
  exemplo_nome  TEXT,
  expertise     TEXT,
  ocorrencias   INTEGER DEFAULT 0,
  ultima_vez    DATE,
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 5) Seed da config (mesma lista de REGRAS_PADRAO do lib)
INSERT INTO prevencao_procedimentos (nome_norm, categoria) VALUES
  ('profilaxia','adulto'),('polimento coronario','adulto'),
  ('aplicacao topica de fluor','adulto'),('verniz fluoretado','adulto'),('fluor verniz','adulto'),
  ('remineraliz','adulto'),('fluorterapia','adulto'),
  ('controle de biofilme','adulto'),('controle de placa','adulto'),
  ('remocao dos fatores de retencao do biofilme','adulto'),
  ('atividade educativa','adulto'),('orientacao de higiene','adulto'),
  ('raspagem supra','adulto'),
  ('aplicacao de selante','adulto'),('aplicacao de cariostatico','adulto'),
  ('condicionamento','infantil'),
  ('pacote de prevencao','adulto'),('pacote de atendimento','adulto'),('pacote atendimento preventivo','adulto'),
  ('prevencao','adulto')
ON CONFLICT (nome_norm) DO NOTHING;

-- 6) Chave para o PersonId da Dra. Ana Luiza (preencher quando souber; opcional)
INSERT INTO app_config (chave, valor)
  VALUES ('ana_luiza_person_id','')
ON CONFLICT (chave) DO NOTHING;
```

> Se `app_config` não tiver colunas `(chave, valor)`, ajustar ao schema real (checar com `list_tables`). O `ana_luiza_person_id` é **opcional** — a regra infantil já funciona por `expertise='Odontopediatria'`.

- [ ] **Step 2: Verificar**

Via MCP: `list_migrations` (deve listar `prevencao_fase1`) e `execute_sql`:
`SELECT count(*) FROM prevencao_procedimentos;` → Expected: 20.
`SELECT column_name FROM information_schema.columns WHERE table_name='pacientes_abc' AND column_name LIKE 'ultima_prevencao%';` → 3 linhas.

- [ ] **Step 3: Commit** (migration fica versionada pelo MCP; registrar nota no repo)

```bash
git commit --allow-empty -m "chore(prevencao): migration prevencao_fase1 aplicada (colunas abc + eventos + config seed + auditoria)"
```

---

## Task 3: Fase de coleta `syncPrevencao` no sync

**Files:**
- Modify: `sync/clinicorp-sync.js` (helper `loadProcedureCatalog`, função `syncPrevencao`, fase em `runSync` ~linha 772, export ~linha 822)

- [ ] **Step 1: Extrair helper de catálogo (DRY com syncProducao)**

Adicionar perto dos helpers (após `dateStr`, ~linha 48). Retorna `Map<priceId(string), {nome, expertise}>`:

```js
/** Catálogo de procedimentos: PriceId(string) → { nome, expertise }. */
async function loadProcedureCatalog() {
  const hoje = new Date().toISOString().slice(0, 10);
  const raw = await api.get('/procedures/list', { from: '2020-01-01', to: hoje });
  const all = Array.isArray(raw) ? raw : Object.values(raw).flat();
  const map = new Map();
  for (const p of all) {
    if (p.id != null) map.set(String(p.id), { nome: p.ProcedureName || p.Name || '', expertise: p.ProcedureExpertiseName || null });
  }
  return map;
}
```

- [ ] **Step 2: Escrever `syncPrevencao`**

Adicionar antes de `runSync` (~linha 700). `janelaDias` default cobre o ciclo com folga no sync diário; o backfill chama com janela larga.

```js
const { classificar, normalizarNome } = require('../lib/prevencao/classificacao');

const PREVENCAO_DIAS = 45; // sync diário: reprocessa últimos 45d por ExecutedDate

/**
 * Coleta procedimentos de prevenção realizados (estimates/list, Executed=X),
 * classifica adulto/infantil, grava prevencao_eventos, insere pacientes faltantes
 * e recomputa os agregados em pacientes_abc.
 */
async function syncPrevencao(janelaDias = PREVENCAO_DIAS) {
  const catalog = await loadProcedureCatalog();
  const estimates = await fetchRangeChunked('/estimates/list', janelaDias);

  const eventos = [];
  const naoClass = new Map(); // nome_norm → {exemplo_nome, expertise, ocorrencias, ultima_vez}
  for (const est of estimates) {
    for (const p of (est.ProcedureList || [])) {
      if (p.Executed !== 'X') continue;
      const data = (p.ExecutedDate || p.z_LastChange_Date || '').slice(0, 10);
      const cid  = p.Patient_PersonId || est.PatientId;
      if (!data || !cid) continue;
      const priceId = p.PriceId != null ? String(p.PriceId) : null;
      const info = priceId ? catalog.get(priceId) : null;
      const nome = info?.nome || '';
      const expertise = info?.expertise || null;
      const profissional = p.ProfessionalName || p.DentistName || null;

      const categoria = classificar({ nome, expertise, profissional });
      if (!categoria) {
        // candidato preventivo (tem nome) que não casou → auditoria
        const nn = normalizarNome(nome);
        if (nn) {
          const cur = naoClass.get(nn) || { exemplo_nome: nome, expertise, ocorrencias: 0, ultima_vez: data };
          cur.ocorrencias++; if (data > cur.ultima_vez) cur.ultima_vez = data;
          naoClass.set(nn, cur);
        }
        continue;
      }
      eventos.push({
        clinicorp_id: Number(cid), data, categoria,
        procedimento: nome, expertise,
        dentist_person_id: p.Dentist_PersonId ? Number(p.Dentist_PersonId) : null,
        profissional, bill_type: p.BillType || null,
        treatment_id: est.TreatmentId ? Number(est.TreatmentId) : null,
      });
    }
  }

  // Dedup pelo UNIQUE (clinicorp_id, data, categoria, treatment_id)
  const seen = new Set();
  const dedup = eventos.filter(e => {
    const k = `${e.clinicorp_id}|${e.data}|${e.categoria}|${e.treatment_id}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });

  for (let i = 0; i < dedup.length; i += 500) {
    const { error } = await supabase.from('prevencao_eventos')
      .upsert(dedup.slice(i, i + 500), { onConflict: 'clinicorp_id,data,categoria,treatment_id' });
    if (error) log(`ERRO upsert prevencao_eventos: ${error.message}`);
  }
  log(`Prevenção: ${dedup.length} eventos (de ${eventos.length} brutos)`);

  // Auditoria (não classificados)
  const naoRows = [...naoClass.entries()].map(([nome_norm, v]) => ({ nome_norm, ...v, atualizado_em: new Date().toISOString() }));
  for (let i = 0; i < naoRows.length; i += 500) {
    await supabase.from('prevencao_nao_classificados').upsert(naoRows.slice(i, i + 500), { onConflict: 'nome_norm' });
  }

  await recomputarPrevencaoAbc();
  return { eventos: dedup.length, nao_classificados: naoRows.length };
}

/** Recalcula ultima_prevencao* na pacientes_abc a partir de prevencao_eventos,
 *  inserindo pacientes que ainda não existem (convênio-only). */
async function recomputarPrevencaoAbc() {
  const eventos = await selectAll('prevencao_eventos', 'clinicorp_id, data, categoria, procedimento');
  const agg = new Map(); // clinicorp_id → {adulto, infantil}
  for (const e of eventos) {
    const a = agg.get(e.clinicorp_id) || { adulto: null, infantil: null };
    if (e.data > (a[e.categoria] || '')) a[e.categoria] = e.data;
    agg.set(e.clinicorp_id, a);
  }

  // garante cadastro em pacientes e pacientes_abc p/ todos com evento
  const cids = [...agg.keys()];
  const idMap = new Map(); // clinicorp_id → pacientes.id
  for (let i = 0; i < cids.length; i += 1000) {
    const { data } = await supabase.from('pacientes').select('id, clinicorp_id').in('clinicorp_id', cids.slice(i, i + 1000));
    (data || []).forEach(p => idMap.set(Number(p.clinicorp_id), p.id));
  }
  // (pacientes faltantes: inserir mínimo com nome/telefone do evento — ver nota abaixo)

  const now = new Date().toISOString();
  const rows = [];
  for (const [cid, a] of agg) {
    const ultima = [a.adulto, a.infantil].filter(Boolean).sort().slice(-1)[0] || null;
    rows.push({
      clinicorp_id: cid,
      paciente_id: idMap.get(cid) || null,
      ultima_prevencao: ultima,
      ultima_prevencao_adulto: a.adulto,
      ultima_prevencao_infantil: a.infantil,
      dias_sem_prevencao: ultima ? daysSince(ultima) : null,
    });
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('pacientes_abc')
      .upsert(rows.slice(i, i + 500), { onConflict: 'clinicorp_id' });
    if (error) log(`ERRO upsert prevencao em pacientes_abc: ${error.message}`);
  }
  log(`Prevenção: agregados de ${rows.length} pacientes atualizados`);
}
```

> Nota sobre pacientes faltantes: `pacientes_abc.paciente_id` é FK e a tela usa `pacientes!inner`. Pacientes com evento mas sem cadastro (~8%) precisam de upsert mínimo em `pacientes` (clinicorp_id + nome + telefone do estimate) ANTES do upsert em `pacientes_abc`. Coletar `est.PatientName`/`est.PatientMobilePhone` em `syncPrevencao` num mapa `cid→{nome,telefone}` e, em `recomputarPrevencaoAbc`, fazer `supabase.from('pacientes').upsert(..., {onConflict:'clinicorp_id'})` para os `cid` ausentes de `idMap`, depois reler os ids. (Reusa o padrão de `insertNewPatients` já existente no arquivo.)

- [ ] **Step 3: Registrar a fase em `runSync`**

Após a fase `producao` (~linha 772), adicionar:

```js
  // Fase 7d: prevenção realizada (estimates Executed=X, classificada)
  await step('prevencao', async () => {
    const r = await syncPrevencao();
    result.steps.prevencao = r.eventos;
  });
```

- [ ] **Step 4: Exportar**

Atualizar `module.exports` (~linha 822) incluindo `syncPrevencao`.

- [ ] **Step 5: Teste manual (janela pequena)**

Run: `node -e "require('./sync/clinicorp-sync').syncPrevencao(45).then(r=>{console.log(r);process.exit(0)})"`
Expected: log `Prevenção: N eventos...` e `agregados de M pacientes`. Sem erros de upsert.

Verificar via MCP `execute_sql`:
`SELECT categoria, count(*) FROM prevencao_eventos GROUP BY categoria;` → linhas adulto/infantil.
`SELECT count(*) FROM pacientes_abc WHERE ultima_prevencao IS NOT NULL;` → > 0.

- [ ] **Step 6: Commit**

```bash
git add sync/clinicorp-sync.js
git commit -m "feat(prevencao): fase syncPrevencao (estimates Executed=X → eventos + agregados ABC)"
```

---

## Task 4: Carga histórica (backfill)

**Files:**
- Create: `scripts/backfill-prevencao.js`

- [ ] **Step 1: Escrever o script**

```js
// scripts/backfill-prevencao.js
// Carga histórica única da prevenção (janela larga). Uso: node scripts/backfill-prevencao.js [dias]
const { syncPrevencao } = require('../sync/clinicorp-sync');
const dias = Number(process.argv[2]) || 1080; // ~3 anos
syncPrevencao(dias)
  .then(r => { console.log('backfill prevenção:', r); process.exit(0); })
  .catch(e => { console.error('falhou:', e.message); process.exit(1); });
```

- [ ] **Step 2: Rodar (tolera auto-wait de rate limit do clinicorp-api)**

Run: `node scripts/backfill-prevencao.js 1080`
Expected: termina com `backfill prevenção: { eventos: N, ... }` (N na casa dos milhares).

Verificar: `SELECT min(data), max(data), count(*) FROM prevencao_eventos;` → cobre ~2023→hoje.

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-prevencao.js
git commit -m "feat(prevencao): script de carga histórica"
```

---

## Task 5: Frontend — colunas, filtro e status na Curva ABC

**Files:**
- Modify: `public/js/pos-tratamento/curva-abc.js`
- Modify: `public/pos-tratamento/curva-abc.html`

- [ ] **Step 1: Estado do filtro de categoria + coluna ativa de prevenção**

No topo de `curva-abc.js` (perto de `let sortCol = ...`, ~linha 9) adicionar:

```js
let catPrev = "todas"; // 'todas' | 'adulto' | 'infantil'
const prevCol = () => catPrev === "adulto" ? "ultima_prevencao_adulto"
                    : catPrev === "infantil" ? "ultima_prevencao_infantil"
                    : "ultima_prevencao";
function statusPrev(dateStr) {
  if (!dateStr) return { txt: "Nunca", cls: "st-nunca" };
  const dias = Math.floor((Date.now() - new Date(dateStr)) / 86400000);
  if (dias > 180) return { txt: `${dias}d`, cls: "st-vencido" };
  if (dias >= 150) return { txt: `${dias}d`, cls: "st-perto" };
  return { txt: `${dias}d`, cls: "st-emdia" };
}
```

- [ ] **Step 2: Incluir as colunas no SELECT**

No `.select(...)` (~linha 146), acrescentar os campos:

```js
.select("paciente_id, clinicorp_id, nome, classe, total_receita, ultima_visita, dias_sem_visita, proxima_consulta, telefone, ultima_prevencao, ultima_prevencao_adulto, ultima_prevencao_infantil, pacientes!inner(id, telefone_celular)", { count: "exact" })
```

- [ ] **Step 3: Cabeçalhos novos (ordenáveis) no `renderTabela`**

Após o `<th ... data-col="proxima_consulta">` (~linha 186) adicionar:

```js
        <th class="sortable-th" data-col="${prevCol()}">ÚLTIMA PREVENÇÃO${sortInd(prevCol())}</th>
        <th>STATUS</th>
```

- [ ] **Step 4: Células novas em cada linha**

Onde monta cada `<tr>` (logo após a célula de PRÓXIMA AGENDA), adicionar:

```js
        <td>${r[prevCol()] ? new Date(r[prevCol()]).toLocaleDateString('pt-BR') : '—'}</td>
        <td><span class="prev-status ${statusPrev(r[prevCol()]).cls}">${statusPrev(r[prevCol()]).txt}</span></td>
```

- [ ] **Step 5: Chips de categoria (HTML)**

Em `curva-abc.html`, dentro do bloco de filtros (`.abc-filters`, ~linha 76), adicionar um grupo:

```html
            <div class="abc-filter-group">
              <span class="abc-filter-label">PREVENÇÃO</span>
              <div class="abc-chips" id="prev-cat-chips">
                <button class="abc-chip prev-cat prev-cat--active" data-cat="todas">Todas</button>
                <button class="abc-chip prev-cat" data-cat="adulto">Adulto</button>
                <button class="abc-chip prev-cat" data-cat="infantil">Infantil</button>
              </div>
            </div>
```

- [ ] **Step 6: Handler dos chips + ordenação pela coluna ativa**

Em `curva-abc.js`, no setup de eventos (perto dos outros listeners de chip), adicionar:

```js
document.getElementById("prev-cat-chips")?.addEventListener("click", (e) => {
  const b = e.target.closest(".prev-cat"); if (!b) return;
  document.querySelectorAll(".prev-cat").forEach(x => x.classList.remove("prev-cat--active"));
  b.classList.add("prev-cat--active");
  catPrev = b.dataset.cat;
  if (sortCol.startsWith("ultima_prevencao")) sortCol = prevCol(); // mantém ordenando por prevenção
  pagina = 1; carregar();
});
```

> Verificar o nome real da função de recarga (`carregar`/`load`) e da var de página no arquivo e usar os corretos.

- [ ] **Step 7: CSS dos status**

Em `public/css/pos-tratamento.css`, adicionar:

```css
.prev-status{font-weight:600;font-size:12px;padding:2px 8px;border-radius:999px}
.st-vencido{background:#fde2e2;color:#b42318}
.st-perto{background:#fef3c7;color:#92400e}
.st-emdia{background:#dcfce7;color:#166534}
.st-nunca{background:#eee;color:#666}
```

- [ ] **Step 8: Verificação visual**

Subir local (`npm start` ou conforme projeto), abrir `/pos-tratamento/curva-abc.html`:
- colunas Última prevenção + Status aparecem; clicar no cabeçalho ordena; chips Adulto/Infantil trocam a data/sort; "Nunca" aparece para quem não tem.

- [ ] **Step 9: Commit**

```bash
git add public/js/pos-tratamento/curva-abc.js public/pos-tratamento/curva-abc.html public/css/pos-tratamento.css
git commit -m "feat(prevencao): colunas última prevenção + status + filtro adulto/infantil na curva-abc"
```

---

## Task 6: Sidebar — remover Recall, adicionar Curva ABC

**Files:**
- Modify: `public/js/nav-config.js` (seção `{ id:'pos' }`, ~linhas 72–75)

- [ ] **Step 1: Editar a seção `pos`**

Remover o item `recall` e adicionar o item da Curva ABC:

```js
    { id: 'pos', label: 'CRC Pós Tratamento', icon: 'pos', roles: 'admin,gestor,crc_sucesso,crc_pos_tratamento', items: [
      { slug: 'aniversariantes', label: 'Aniversariantes', roles: 'admin,gestor,crc_sucesso,crc_pos_tratamento', mode: 'link', href: '/pos-tratamento/aniversariantes.html', badge: { id: 'badge-aniv', cls: 'badge-nav badge-nav--green' } },
      { slug: 'curva-abc',       label: 'Curva ABC / Prevenção', roles: 'admin,gestor,crc_sucesso,crc_pos_tratamento', mode: 'link', href: '/pos-tratamento/curva-abc.html' },
      { slug: 'vips',            label: 'VIPs',            roles: 'admin,gestor,crc_sucesso,crc_pos_tratamento', mode: 'link', href: '/pos-tratamento/vips.html' },
    ] },
```

- [ ] **Step 2: Confirmar `data-active`**

Garantir que `curva-abc.html` carregue o nav com o slug certo. Se usar `nav.js`, conferir que o slug bate; se usar `shared-nav.js`, incluir `data-active="curva-abc"`. (Checar qual dos dois a página usa hoje — ela usa `nav.js`.)

- [ ] **Step 3: Verificação**

Abrir o app: o menu "CRC Pós Tratamento" mostra Aniversariantes / Curva ABC / Prevenção / VIPs; Recall sumiu; o link abre a curva-abc com a sidebar correta.

- [ ] **Step 4: Commit**

```bash
git add public/js/nav-config.js
git commit -m "chore(nav): remove Recall e adiciona Curva ABC/Prevenção no menu Pós Tratamento"
```

---

## Task 7: Auditoria de não-classificados (mínima)

**Files:** já criada a tabela na Task 2; aqui só a leitura.

- [ ] **Step 1: Verificar conteúdo após backfill**

Via MCP `execute_sql`:
`SELECT exemplo_nome, expertise, ocorrencias FROM prevencao_nao_classificados ORDER BY ocorrencias DESC LIMIT 30;`
Expected: lista de procedimentos executados que não casaram (ex.: nomes de tratamento, novos por convênio).

- [ ] **Step 2: Revisar com o Luiz**

Levar essa lista pro Luiz: itens que deveriam contar como prevenção → adicionar em `prevencao_procedimentos` (e, se virar regra fixa, no `REGRAS_PADRAO` do lib). Itens corretos como não-prevenção → ignorar. Garante que nada é contado errado em silêncio.

> UI dedicada da auditoria fica para depois; a leitura via SQL atende a Fase 1.

---

## Self-Review (cobertura do spec)

- Fonte estimates/list Executed=X → **Task 3**. ✅
- Resolução por nome (PriceId→catálogo) → **Task 3** (`loadProcedureCatalog`). ✅
- Classificação por nome + regras duras (consulta/sub-gengival/infantil) → **Task 1** (testado). ✅
- Config editável + seed → **Task 2**. ✅
- Eventos + agregados cobrindo convênio-only (upsert pacientes faltantes) → **Task 3** (`recomputarPrevencaoAbc` + nota). ✅
- Histórico desde início Clinicorp → **Task 4**. ✅
- Sync diário (fase isolada) → **Task 3** Step 3. ✅
- Página: coluna + ordenável + filtro adulto/infantil + status/nunca → **Task 5**. ✅
- Sidebar (remove recall, add curva-abc, fonte única) → **Task 6**. ✅
- Auditoria não-classificados → **Tasks 2 + 7**. ✅
- "Nunca" cruzando ultima_visita → coberto pelo Status `Nunca` + a coluna `ultima_visita` já existe na linha (tooltip refinado fica como melhoria menor).

**Ponto a confirmar na execução (baixo risco):** se `estimates/list` filtra `from/to` por CreateDate ou LastChange — afeta só quão "fresca" é a janela diária; o backfill amplo cobre o histórico de qualquer forma. Validar no Step 5 da Task 3 comparando contagem de maio (~223 proc) com a janela.

**Fora de escopo (Fase 2):** seleção múltipla→discador, "não ligar" nunca/este mês, UI de auditoria.
</content>
