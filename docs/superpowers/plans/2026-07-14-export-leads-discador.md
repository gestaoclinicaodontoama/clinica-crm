# Exportar Leads para Discador (CSV) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Botão "Exportar CSV" no board Kanban de Leads: a CRC marca cards (ou escolhe uma coluna inteira) e baixa `nome,telefone,telefone_wa,status,origem,anuncio` para importar no discador, com auditoria LGPD.

**Architecture:** Helper puro de CSV (`lib/leads/exportCsv.js`, TDD) + rota `POST /api/leads/exportar` (dois modos: `{ids}` ou `{coluna, filtros}`) reusando `buildLeadsColFilter` + tabela de auditoria `leads_export_log` + checkboxes/modal no `public/kanban-leads/index.html`. Spec: `docs/superpowers/specs/2026-07-14-export-leads-discador-design.md`.

**Tech Stack:** Node 18+/Express (monólito `server.js`), Supabase (service_role no server), front HTML/JS vanilla, testes `node:test`.

## Global Constraints

- Front é **vanilla** (sem framework, sem lib nova); UI em pt-BR, sem siglas financeiras.
- Testes: `npm test` roda `node --test "lib/**/*.test.js"` — arquivos de teste vivem em `lib/**/*.test.js`.
- Supabase client: **nunca** `.catch()` no builder (try/catch no `await`); **nunca** confiar em >1000 linhas sem paginar (`range`).
- Telefones com **0 à esquerda são famílias** — NUNCA normalizar/prefixar (o helper `telefoneWa` já respeita: só prefixa 55 em 10–11 dígitos).
- Tabela nova nasce com `ENABLE ROW LEVEL SECURITY` e **sem policy** (só service_role acessa). Migração no project `mtqdpjhhqzvuklnlfpvi`, aplicada via MCP Supabase, nome `YYYYMMDDHHMMSS_slug.sql`.
- **BOM no CSV**: usar `String.fromCharCode(0xFEFF)` no código (NÃO digitar o caractere literal nem o escape `\u...` — invisível no diff, já causou problema no spec).
- Git: várias sessões usam a main — antes de começar, `git fetch origin`; se a main local divergir de `origin/main`, trabalhar em branch criada de `origin/main`.
- Deploy ao final: `git push` e imediatamente `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"` (sem perguntar).
- Commits frequentes, mensagens em pt-BR no padrão do repo (`feat:`/`fix:`/`refactor:` curto).

---

### Task 1: Extrair helpers compartilhados de CSV (`lib/csv-helpers.js`)

Os helpers `_esc`/`_wa` de `lib/publicos/csv.js` serão usados também pelo novo export. Extrair para módulo compartilhado sem mudar comportamento.

**Files:**
- Create: `lib/csv-helpers.js`
- Modify: `lib/publicos/csv.js` (arquivo inteiro tem ~22 linhas)

**Interfaces:**
- Produces: `require('./lib/csv-helpers')` → `{ esc(v):string, telefoneWa(tel):string }`
- `esc`: escapa CSV (aspas/vírgula/quebra). `telefoneWa`: prefixa `55` só em 10–11 dígitos sem 55; resto intacto.

- [ ] **Step 1: Rodar a suíte atual (linha de base)**

Run: `cd "C:/Users/Luiz Martins/Desktop/Projeto Claude Code/clinica-crm" && npm test`
Expected: PASS (anotar quantos testes passam — a extração não pode quebrar nenhum).

- [ ] **Step 2: Criar `lib/csv-helpers.js`**

```js
// Helpers compartilhados de CSV (Públicos + export de leads p/ discador).
// telefoneWa prefixa 55 só quando faltar (10–11 dígitos); telefones de família
// (0 à esquerda, >11 dígitos) e já-com-55 ficam intactos.
function telefoneWa(tel) {
  const n = String(tel == null ? '' : tel).replace(/\D/g, '');
  if ((n.length === 10 || n.length === 11) && !n.startsWith('55')) return '55' + n;
  return n;
}

function esc(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

module.exports = { esc, telefoneWa };
```

- [ ] **Step 3: Refatorar `lib/publicos/csv.js` para importar os helpers**

Conteúdo completo do arquivo após o refactor:

```js
// CSV de um público. Helpers de escape/telefone em lib/csv-helpers.js.
const { esc: _esc, telefoneWa: _wa } = require('../csv-helpers');

function montarCsv(rows) {
  const head = 'nome,telefone,telefone_wa,status,origem';
  const linhas = (rows || []).map(r =>
    [_esc(r.nome), _esc(r.telefone), _esc(_wa(r.telefone)), _esc(r.status), _esc(r.origem)].join(','));
  return [head, ...linhas].join('\n');
}

module.exports = { montarCsv };
```

- [ ] **Step 4: Rodar a suíte de novo**

Run: `npm test`
Expected: PASS, mesmo número de testes do Step 1. Também: `node --check server.js` → sem erro (server.js importa `lib/publicos/csv` na linha ~211).

- [ ] **Step 5: Commit**

```bash
git add lib/csv-helpers.js lib/publicos/csv.js
git commit -m "refactor(csv): extrai esc/telefoneWa p/ lib/csv-helpers (reuso no export de leads)"
```

---

### Task 2: Helper `montarCsvDiscador` (`lib/leads/exportCsv.js`) — TDD

**Files:**
- Create: `lib/leads/exportCsv.js`
- Test: `lib/leads/exportCsv.test.js`

**Interfaces:**
- Consumes: `{ esc, telefoneWa }` de `lib/csv-helpers.js` (Task 1).
- Produces: `montarCsvDiscador(rows, anunciosMap) → { csv: string, descartados: number }`
  - `rows`: `[{ nome, telefone, status, origem, campanha }]` (campanha = ID do anúncio ou null)
  - `anunciosMap`: `{ [chaveLowerCase]: nomeDoAnuncio }`
  - `csv` começa com BOM (charCode 0xFEFF); cabeçalho `nome,telefone,telefone_wa,status,origem,anuncio`; linhas sem telefone ficam fora e contam em `descartados`.

- [ ] **Step 1: Escrever os testes que falham (`lib/leads/exportCsv.test.js`)**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { montarCsvDiscador } = require('./exportCsv');

test('cabeçalho com BOM e 6 colunas', () => {
  const { csv, descartados } = montarCsvDiscador([], {});
  assert.strictEqual(csv.charCodeAt(0), 0xFEFF);
  assert.strictEqual(csv.slice(1), 'nome,telefone,telefone_wa,status,origem,anuncio');
  assert.strictEqual(descartados, 0);
});

test('linha completa com anúncio resolvido pelo catálogo', () => {
  const rows = [{ nome: 'Maria', telefone: '31988887777', status: 'Novo', origem: 'Meta Ads', campanha: '120212345678900000' }];
  const map = { '120212345678900000': 'Invisalign Julho' };
  const { csv } = montarCsvDiscador(rows, map);
  assert.strictEqual(csv.split('\n')[1], 'Maria,31988887777,5531988887777,Novo,Meta Ads,Invisalign Julho');
});

test('anúncio vazio quando campanha é nula ou fora do catálogo', () => {
  const rows = [
    { nome: 'A', telefone: '3198888777', status: 'Novo', origem: 'Google', campanha: null },
    { nome: 'B', telefone: '31988887771', status: 'Novo', origem: 'Meta Ads', campanha: '999' },
  ];
  const { csv } = montarCsvDiscador(rows, {});
  const linhas = csv.split('\n');
  assert.ok(linhas[1].endsWith(','), 'campanha null -> anuncio vazio');
  assert.ok(linhas[2].endsWith(','), 'fora do catálogo -> anuncio vazio');
});

test('descarta linhas sem telefone e conta', () => {
  const rows = [
    { nome: 'Com', telefone: '31988887777', status: 'Novo', origem: 'X' },
    { nome: 'Vazio', telefone: '', status: 'Novo', origem: 'X' },
    { nome: 'Nulo', telefone: null, status: 'Novo', origem: 'X' },
    { nome: 'Espaço', telefone: '   ', status: 'Novo', origem: 'X' },
  ];
  const { csv, descartados } = montarCsvDiscador(rows, {});
  assert.strictEqual(descartados, 3);
  assert.strictEqual(csv.split('\n').length, 2); // cabeçalho + 1 linha
});

test('escapa vírgula e aspas no nome', () => {
  const rows = [{ nome: 'Silva, "Zé"', telefone: '31988887777', status: 'Novo', origem: 'X' }];
  const { csv } = montarCsvDiscador(rows, {});
  assert.ok(csv.includes('"Silva, ""Zé"""'));
});

test('telefone de família (0 à esquerda, 12 dígitos) fica intacto', () => {
  const rows = [{ nome: 'Fam', telefone: '031988887777', status: 'Novo', origem: 'X' }];
  const cols = montarCsvDiscador(rows, {}).csv.split('\n')[1].split(',');
  assert.strictEqual(cols[1], '031988887777');
  assert.strictEqual(cols[2], '031988887777'); // não prefixa 55
});

test('telefone já com 55 não duplica prefixo', () => {
  const rows = [{ nome: 'C', telefone: '5531988887777', status: 'Novo', origem: 'X' }];
  assert.strictEqual(montarCsvDiscador(rows, {}).csv.split('\n')[1].split(',')[2], '5531988887777');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/leads/exportCsv.test.js`
Expected: FAIL — `Cannot find module './exportCsv'`.

- [ ] **Step 3: Implementar `lib/leads/exportCsv.js`**

```js
// CSV p/ discador — spec docs/superpowers/specs/2026-07-14-export-leads-discador-design.md
// BOM no início: a CRC abre no Excel, que sem BOM quebra os acentos.
// Linhas sem telefone ficam fora (inúteis no discador) e contam em `descartados`.
const { esc, telefoneWa } = require('../csv-helpers');

const BOM = String.fromCharCode(0xFEFF);

function montarCsvDiscador(rows, anunciosMap = {}) {
  const todas = rows || [];
  const validas = todas.filter(r => r.telefone && String(r.telefone).trim());
  const head = 'nome,telefone,telefone_wa,status,origem,anuncio';
  const linhas = validas.map(r => [
    esc(r.nome), esc(r.telefone), esc(telefoneWa(r.telefone)), esc(r.status), esc(r.origem),
    esc(r.campanha ? (anunciosMap[String(r.campanha).toLowerCase()] || '') : ''),
  ].join(','));
  return { csv: BOM + [head, ...linhas].join('\n'), descartados: todas.length - validas.length };
}

module.exports = { montarCsvDiscador };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/leads/exportCsv.test.js` → 7 PASS. Depois `npm test` → suíte inteira PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/leads/exportCsv.js lib/leads/exportCsv.test.js
git commit -m "feat(export-leads): montarCsvDiscador (BOM, anuncio via catálogo, descarta sem telefone)"
```

---

### Task 3: Migração `leads_export_log` (auditoria LGPD)

**Files:**
- Create: `supabase/migrations/20260714120000_leads_export_log.sql`

**Interfaces:**
- Produces: tabela `public.leads_export_log(id, usuario_id uuid, usuario_nome text, modo text, qtd int, filtros jsonb, criado_em timestamptz)` — RLS ligado, SEM policy (só service_role). Task 4 insere nela.

- [ ] **Step 1: Criar o arquivo de migração**

```sql
-- Auditoria de exportação de leads (LGPD): quem baixou, quantos, com que filtro.
-- Spec: docs/superpowers/specs/2026-07-14-export-leads-discador-design.md
create table public.leads_export_log (
  id bigint generated always as identity primary key,
  usuario_id uuid,
  usuario_nome text,
  modo text,              -- 'ids' | 'filtro'
  qtd int not null,       -- linhas do CSV entregue (pós-descarte de sem-telefone)
  filtros jsonb,          -- {coluna,q,crc,origem} quando modo='filtro'
  criado_em timestamptz not null default now()
);

alter table public.leads_export_log enable row level security;
-- SEM policy: só o servidor (service_role) grava/lê. Front não toca direto.
```

- [ ] **Step 2: Aplicar via MCP Supabase**

Usar `apply_migration` do MCP Supabase (project `mtqdpjhhqzvuklnlfpvi`) com o nome `leads_export_log` e o SQL acima.

- [ ] **Step 3: Verificar**

Usar `list_migrations` (deve listar `leads_export_log`) e `execute_sql` com:
`select relrowsecurity from pg_class where relname = 'leads_export_log';` → `true`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260714120000_leads_export_log.sql
git commit -m "feat(export-leads): tabela de auditoria leads_export_log (RLS, sem policy)"
```

---

### Task 4: Backend — param `fields` no builder + rota `POST /api/leads/exportar`

**Files:**
- Modify: `server.js:211` (require), `server.js:932` (assinatura de `buildLeadsColFilter`), `server.js:937` (linha do `sel`), inserir rota nova logo APÓS o fechamento da rota `GET /api/kanban/leads/:coluna` (após `server.js:1017`).

**Interfaces:**
- Consumes: `montarCsvDiscador` (Task 2); tabela `leads_export_log` (Task 3); `buildLeadsColFilter`, `LEADS_COLUNAS`, `requireAuth`, `requireKanbanLeads`, `rateLimit`, `supabase` (já existem no server.js).
- Produces: `POST /api/leads/exportar` — body `{ids:number[]}` OU `{coluna:string, filtros:{q,crc,origem}}` → `text/csv` attachment `leads-discador-YYYY-MM-DD.csv` + header `X-Descartados-Sem-Telefone`. Erros: 400 body/coluna inválida, 500 `{error}`.

- [ ] **Step 1: Adicionar o require (junto do `montarCsv` na linha ~211)**

```js
const { montarCsvDiscador } = require('./lib/leads/exportCsv');
```

- [ ] **Step 2: Param `fields` no `buildLeadsColFilter`**

Linha 932, trocar a assinatura e a linha do `sel` (937):

```js
function buildLeadsColFilter(coluna, q, crc, countOnly = false, origem = null, fields = null) {
```
```js
  const sel = countOnly ? '*' : (fields || CARD_FIELDS);
```

Nenhum chamador existente muda (param novo é opcional com default).

- [ ] **Step 3: Inserir a rota nova (após `server.js:1017`)**

```js
// Exportar leads p/ discador (CSV) — spec 2026-07-14-export-leads-discador-design.md
// Dois modos: {ids} = cards marcados no board; {coluna, filtros} = coluna inteira.
app.post('/api/leads/exportar', requireAuth, requireKanbanLeads, rateLimit, async (req, res) => {
  try {
    const { ids, coluna, filtros } = req.body || {};
    const EXPORT_FIELDS = 'id,nome,telefone,status,origem,campanha';
    const rows = [];
    let modo;

    if (Array.isArray(ids)) {
      modo = 'ids';
      const lista = [...new Set(ids.map(Number).filter(Number.isInteger))];
      if (!lista.length) return res.status(400).json({ error: 'Nenhum id válido' });
      if (lista.length > 5000) return res.status(400).json({ error: 'Máximo de 5000 leads por exportação' });
      // .in() vira query string no PostgREST — lotes de 500 p/ não estourar a URL
      for (let i = 0; i < lista.length; i += 500) {
        const { data, error } = await supabase.from('leads')
          .select(EXPORT_FIELDS).in('id', lista.slice(i, i + 500));
        if (error) throw error;
        rows.push(...(data || []));
      }
    } else if (coluna) {
      modo = 'filtro';
      if (!LEADS_COLUNAS.includes(coluna)) return res.status(400).json({ error: 'Coluna inválida' });
      const f = filtros || {};
      // mesma ordenação do board + desempate por id (range com empate pula/duplica linha)
      const orderField = coluna === 'agendado' ? 'data_agendamento' : 'criado_em';
      const ascending = coluna === 'agendado';
      const PAGINA = 1000; // corte do client Supabase — paginar sempre
      for (let offset = 0; ; offset += PAGINA) {
        const { data, error } = await buildLeadsColFilter(coluna, f.q || null, f.crc || null, false, f.origem || null, EXPORT_FIELDS)
          .order(orderField, { ascending })
          .order('id', { ascending: false })
          .range(offset, offset + PAGINA - 1);
        if (error) throw error;
        const pagina = data || [];
        rows.push(...pagina);
        if (pagina.length < PAGINA) break;
      }
    } else {
      return res.status(400).json({ error: 'Informe ids ou coluna' });
    }

    // ID do anúncio -> nome legível (catálogo local; sem chamar a Meta)
    const { data: catalog, error: catErr } = await supabase.from('anuncios').select('chave,nome').eq('ativo', true);
    if (catErr) throw catErr;
    const anunciosMap = {};
    (catalog || []).forEach(a => { anunciosMap[String(a.chave).toLowerCase()] = a.nome; });

    const { csv, descartados } = montarCsvDiscador(rows, anunciosMap);

    // Auditoria LGPD — best-effort: não derruba o download se falhar
    try {
      const { error: logErr } = await supabase.from('leads_export_log').insert({
        usuario_id: req.user.id,
        usuario_nome: req.user.profile?.nome || req.user.email,
        modo,
        qtd: rows.length - descartados,
        filtros: modo === 'filtro' ? { coluna, q: filtros?.q || null, crc: filtros?.crc || null, origem: filtros?.origem || null } : null,
      });
      if (logErr) console.warn('⚠️ leads_export_log:', logErr.message);
    } catch (logEx) { console.warn('⚠️ leads_export_log:', logEx.message); }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-discador-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('X-Descartados-Sem-Telefone', String(descartados));
    res.send(csv);
  } catch (e) {
    console.error('❌ leads/exportar:', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 4: Verificar sintaxe e suíte**

Run: `node --check server.js` → sem saída (ok). `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(export-leads): POST /api/leads/exportar (ids em lotes | coluna paginada) + fields no buildLeadsColFilter"
```

---

### Task 5: Frontend — checkbox, contador, botão e modal de export no board

**Files:**
- Modify: `public/kanban-leads/index.html` — pontos exatos:
  - CSS dentro do `<style>` existente (antes da linha 90)
  - Header `.kb-header` (linhas 95–110)
  - `renderCard()` (linha 253)
  - `reload()` (linha 363)
  - Novas funções antes do bloco `// ── INIT` (linha 485)

**Interfaces:**
- Consumes: `POST /api/leads/exportar` (Task 4); já existentes na página: `_token`, `state`, `COLUNAS`, `renderCol`, `_searchQ/_crcQ/_origemQ`, `esc()`, padrão de overlay de `pedirData` (linhas 190–208).
- Produces: UI completa — nada consome depois.

- [ ] **Step 1: CSS (adicionar antes do `</style>`)**

```css
.kb-card{position:relative;}
.kb-check{width:15px;height:15px;margin:1px 6px 0 0;cursor:pointer;accent-color:var(--accent);flex-shrink:0;}
.kb-export{padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px;font-weight:600;cursor:pointer;}
.kb-export:hover{border-color:var(--accent);}
.kb-sel-chip{font-size:13px;color:var(--muted);background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:6px 10px;}
.kb-sel-chip a{color:var(--accent);cursor:pointer;text-decoration:none;}
```

- [ ] **Step 2: Header — chip + botão (dentro da `.kb-header`, após o select `#kb-origem`, linha ~109)**

```html
    <span class="kb-sel-chip" id="kb-sel-chip" style="display:none">☑ <b id="kb-sel-count">0</b> selecionados · <a onclick="limparSelecao()">limpar</a></span>
    <button class="kb-export" id="kb-export" onclick="abrirExport()">⬇ Exportar CSV</button>
```

- [ ] **Step 3: Checkbox no `renderCard()` (linha 253)**

Trocar o início do template — a `<div class="kb-card-top">` passa a ter o checkbox antes do nome. `checked` vem do `Set` (re-render restaura o estado — regra do spec):

```js
function renderCard(lead) {
  const age = timeAgo(lead.criado_em);
  const tel = lead.telefone || '';
  const checked = _selecao.has(lead.id) ? 'checked' : '';
  return `<div class="kb-card" draggable="true" data-id="${lead.id}" data-status="${esc(lead.status)}"
    ondragstart="onDragStart(event)" ondragend="onDragEnd(event)"
    onclick="if(!window._kbDragging)abrirLead(${lead.id})">
    <div class="kb-card-top">
      <input type="checkbox" class="kb-check" ${checked} draggable="false"
        onclick="event.stopPropagation();toggleSelecao(${lead.id}, this.checked)"
        ondragstart="event.preventDefault();event.stopPropagation();">
      <span class="kb-card-nome">${esc(lead.nome || 'Sem nome')}</span>
      <span class="kb-card-age">${age}</span>
    </div>
    <div class="kb-card-tel">${esc(fmtTel(tel))}</div>
    <div class="kb-card-foot">
      <span class="kb-badge">${esc(lead.origem || '')}</span>
      ${lead.valor ? `<span class="kb-valor">${fmtBRL(lead.valor)}</span>` : ''}
      <button class="kb-wa" onclick="event.stopPropagation();abrirConversa(${lead.id})">💬</button>
    </div>
  </div>`;
}
```

- [ ] **Step 4: Estado de seleção + limpeza no `reload()`**

Junto das declarações de estado (após linha 227), adicionar:

```js
const _selecao = new Set(); // ids de leads marcados p/ export
function toggleSelecao(id, on) {
  if (on) _selecao.add(id); else _selecao.delete(id);
  renderSelChip();
}
function limparSelecao() {
  _selecao.clear();
  renderSelChip();
  COLUNAS.forEach(renderCol); // desmarca os checkboxes na tela
}
function renderSelChip() {
  const chip = document.getElementById('kb-sel-chip');
  if (!chip) return;
  chip.style.display = _selecao.size ? '' : 'none';
  document.getElementById('kb-sel-count').textContent = _selecao.size;
}
```

E no `reload()` (linha 363) — filtro novo = seleção nova (regra do spec: nunca seleção invisível):

```js
async function reload() {
  _selecao.clear(); renderSelChip();
  COLUNAS.forEach(c => { state[c.slug].leads = []; state[c.slug].page = 0; });
  await loadAll();
}
```

- [ ] **Step 5: Modal de export + download (antes do bloco `// ── INIT`, linha ~485)**

Segue o padrão de overlay de `pedirData` (inline styles, `ov`/`box`). Contagem do modo coluna = `state[slug].total` (já em memória, zero rede). Retry 5xx 2x (padrão do CRM).

```js
// ── EXPORTAR CSV (discador) ───────────────────────────────────────────────────
async function _fetchExport(body, _retry = 0) {
  const r = await fetch('/api/leads/exportar', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + _token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status >= 500 && _retry < 2) {
    await new Promise(res => setTimeout(res, 1500 * (_retry + 1)));
    return _fetchExport(body, _retry + 1);
  }
  return r;
}

async function _baixarExport(body, btnOk, msgEl) {
  btnOk.disabled = true; btnOk.textContent = 'Gerando…';
  try {
    const r = await _fetchExport(body);
    if (!r.ok) throw new Error(await r.text());
    const descartados = parseInt(r.headers.get('X-Descartados-Sem-Telefone') || '0', 10);
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'leads-discador-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
    msgEl.style.color = '';
    msgEl.textContent = descartados > 0
      ? `✅ Arquivo baixado. ${descartados} lead(s) sem telefone ficaram de fora.`
      : '✅ Arquivo baixado.';
    btnOk.style.display = 'none';
    return true;
  } catch (e) {
    msgEl.style.color = 'var(--red, #dc2626)';
    msgEl.textContent = 'Erro: ' + (e.message || e);
    btnOk.disabled = false; btnOk.textContent = 'Baixar';
    return false;
  }
}

function abrirExport() {
  const marcados = _selecao.size;
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center';
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg2,#fff);color:var(--text,#1a1d29);border-radius:12px;padding:20px;width:360px;max-width:92vw;box-shadow:0 12px 40px rgba(0,0,0,.25)';
  const btnCss = 'flex:1;padding:9px;border:none;border-radius:8px;background:var(--accent,#3b82f6);color:#fff;font-weight:700;cursor:pointer';
  const cancelCss = 'padding:9px 14px;border:1px solid var(--border,#e5e7eb);background:none;border-radius:8px;cursor:pointer;color:var(--muted,#6b7280)';

  if (marcados > 0) {
    box.innerHTML = `
      <div style="font-weight:700;font-size:16px;margin-bottom:6px">Exportar CSV</div>
      <div style="font-size:14px;margin-bottom:12px">Vai baixar os <b>${marcados}</b> leads marcados.</div>
      <div id="ex-msg" style="font-size:13px;min-height:18px;margin-bottom:10px"></div>
      <div style="display:flex;gap:8px">
        <button id="ex-ok" style="${btnCss}">Baixar</button>
        <button id="ex-cancel" style="${cancelCss}">Cancelar</button>
      </div>`;
  } else {
    const opts = COLUNAS.map(c =>
      `<option value="${c.slug}">${c.label} (${state[c.slug].total.toLocaleString('pt-BR')})</option>`).join('');
    box.innerHTML = `
      <div style="font-weight:700;font-size:16px;margin-bottom:6px">Exportar coluna inteira</div>
      <div style="font-size:13px;color:var(--muted,#6b7280);margin-bottom:10px">
        Nenhum lead marcado — escolha a coluna. Os filtros atuais (busca, CRC, origem) serão aplicados.</div>
      <select id="ex-col" style="width:100%;padding:9px;border:1px solid var(--border,#e5e7eb);border-radius:8px;font-size:14px;background:var(--bg3,#f9fafb);color:var(--text,#1a1d29)">${opts}</select>
      <div id="ex-count" style="font-size:14px;margin:10px 0"></div>
      <div id="ex-msg" style="font-size:13px;min-height:18px;margin-bottom:10px"></div>
      <div style="display:flex;gap:8px">
        <button id="ex-ok" style="${btnCss}">Baixar</button>
        <button id="ex-cancel" style="${cancelCss}">Cancelar</button>
      </div>`;
  }

  ov.appendChild(box); document.body.appendChild(ov);
  const close = () => document.body.removeChild(ov);
  ov.onclick = e => { if (e.target === ov) close(); };
  box.querySelector('#ex-cancel').onclick = close;

  const msgEl = box.querySelector('#ex-msg');
  const btnOk = box.querySelector('#ex-ok');

  if (marcados > 0) {
    btnOk.onclick = () => _baixarExport({ ids: [..._selecao] }, btnOk, msgEl);
  } else {
    const sel = box.querySelector('#ex-col');
    const countEl = box.querySelector('#ex-count');
    const atualiza = () => {
      const c = COLUNAS.find(x => x.slug === sel.value);
      countEl.innerHTML = `Vai baixar <b>${state[sel.value].total.toLocaleString('pt-BR')}</b> leads de <i>${c.label}</i>.`;
    };
    sel.onchange = atualiza; atualiza();
    btnOk.onclick = () => _baixarExport({
      coluna: sel.value,
      filtros: { q: _searchQ || null, crc: _crcQ || null, origem: _origemQ || null },
    }, btnOk, msgEl);
  }
}
```

Nota: o botão "Cancelar" continua funcionando após o download como "fechar" (o `#ex-ok` some) — sem estado extra.

- [ ] **Step 6: Verificação estática**

Run: `node -e "const s=require('fs').readFileSync('public/kanban-leads/index.html','utf8'); const m=s.match(/<script>([\s\S]*)<\/script>\s*<\/body>/); new Function(m[1]); console.log('JS da página parseia ok')"`
Expected: `JS da página parseia ok` (parse-only; DOM não executa).

- [ ] **Step 7: Commit**

```bash
git add public/kanban-leads/index.html
git commit -m "feat(export-leads): checkbox por card + botão Exportar CSV no Kanban Leads (duas vias: marcados | coluna inteira)"
```

---

### Task 6: Verificação final, push e deploy

**Files:** nenhum novo — verificação e entrega.

- [ ] **Step 1: Suíte completa + sintaxe**

Run: `npm test && node --check server.js`
Expected: todos PASS, sem erro de sintaxe.

- [ ] **Step 2: Push + deploy (fluxo padrão, sem perguntar)**

```bash
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

(Se o push travar no credential manager: token via CredRead + store — ver memória `feedback_git_push_headless`.)

- [ ] **Step 3: Smoke test da API em produção (sem login = deve barrar)**

Run: `curl -s -X POST "https://plataformaama-plataforma.uc5as5.easypanel.host/api/leads/exportar" -H "Content-Type: application/json" -d "{}"`
Expected: `{"error":"Não autenticado"}` (401) — rota existe e exige auth.

- [ ] **Step 4: Reportar validação manual pendente ao Luiz**

Checklist (logado, papel CRC):
1. Board de Leads mostra checkbox nos cards; marcar 2–3 → chip "N selecionados" aparece.
2. Exportar marcados → arquivo baixa; abrir no Excel: acentos ok, 6 colunas, coluna `anuncio` preenchida em lead de Meta Ads.
3. Sem nada marcado → modal de coluna; escolher "Reativação 30–180d" → contagem bate com o board → baixar → nº de linhas do arquivo = contagem (menos os sem-telefone avisados).
4. Carregar mais cards numa coluna → checks marcados continuam marcados.
5. Mudar filtro de origem → seleção zera (esperado).
6. Conferir no Supabase: `select * from leads_export_log order by id desc limit 5;` → linhas com usuario/modo/qtd.
7. Importar o CSV no discador.
