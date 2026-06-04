# Kanban Leads + Kanban Comercial — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar dois módulos Kanban server-side paginados — Kanban Leads (9 colunas) e Kanban Comercial (12 colunas) — com drag-and-drop, busca, filtro por CRC e collapse de coluna, servindo 13k+ leads sem carregar tudo em memória.

**Architecture:** Dois arquivos HTML independentes (`/kanban-leads/`, `/kanban-comercial/`) com shared-nav. Backend expõe 4 endpoints novos que computam column queries via Supabase JS client (colunas simples) e RPCs SQL (sub-colunas Em nutrição com COALESCE). Drag-and-drop reutiliza `PATCH /api/leads/:id` existente.

**Tech Stack:** Node.js + Express, Supabase JS client + Postgres RPCs, HTML/CSS/JS vanilla, shared-nav.js existente.

**Spec:** `docs/superpowers/specs/2026-06-02-kanban-leads-comercial-design.md`

---

## Mapa de arquivos

| Arquivo | Ação | Responsabilidade |
|---------|------|-----------------|
| `server.js` | Modificar | Add 'Faltou' ao FUNIL; 4 novos endpoints; helper `buildLeadsColFilter`; helper `buildComercialColFilter` |
| `public/kanban-leads/index.html` | Criar | Página completa Kanban Leads (9 colunas) |
| `public/kanban-comercial/index.html` | Criar | Página completa Kanban Comercial (12 colunas) |
| `public/js/shared-nav.js` | Modificar | Adicionar links Kanban Leads e Kanban Comercial |
| `public/index.html` | Modificar | Links de nav + Módulo de Usuários (roles) + handler `?abrir_lead=ID` |
| Supabase migration | Criar | RPCs `kanban_nutricao` e `kanban_nutricao_count` |

---

## Task 1: SQL migration — RPCs para sub-colunas Em nutrição

As sub-colunas Em nutrição precisam de `COALESCE(data_orcamento, data_comparecimento, criado_em)` como referência de tempo, o que não é expressável diretamente no Supabase JS client. Solução: duas funções SQL chamadas via `supabase.rpc()`.

**Files:**
- Supabase migration: `kanban_nutricao_rpcs`

- [ ] **Step 1: Aplicar migration com as duas funções RPC**

Via MCP Supabase (`apply_migration`, project `mtqdpjhhqzvuklnlfpvi`, name `kanban_nutricao_rpcs`):

```sql
-- Conta leads nas sub-colunas Em nutrição
CREATE OR REPLACE FUNCTION kanban_nutricao_count(
  p_bucket text,        -- '30' = 30-180d | '180' = 180-365d | '365' = 365+
  p_q      text DEFAULT NULL,
  p_crc    text DEFAULT NULL
) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH base AS (
    SELECT *,
      CASE
        WHEN status IN ('Em nutrição','Reclassificar')
          THEN COALESCE(data_orcamento, data_comparecimento, criado_em)
        ELSE data_comparecimento
      END AS ref_time
    FROM leads
    WHERE status IN ('Em nutrição','Reclassificar','Compareceu')
      AND NOT (status = 'Compareceu'
               AND data_comparecimento >= NOW() - INTERVAL '30 days')
  )
  SELECT COUNT(*) FROM base
  WHERE (
    (p_bucket = '30'  AND ref_time >= NOW() - INTERVAL '180 days'
                      AND ref_time <  NOW() - INTERVAL '30 days')
    OR
    (p_bucket = '180' AND ref_time >= NOW() - INTERVAL '365 days'
                      AND ref_time <  NOW() - INTERVAL '180 days')
    OR
    (p_bucket = '365' AND ref_time < NOW() - INTERVAL '365 days')
  )
  AND (p_q IS NULL OR nome ILIKE '%' || p_q || '%'
                   OR telefone ILIKE '%' || p_q || '%')
  AND (p_crc IS NULL OR crc_comercial_nome = p_crc);
$$;

-- Retorna cards das sub-colunas Em nutrição (paginado)
CREATE OR REPLACE FUNCTION kanban_nutricao(
  p_bucket  text,
  p_limit   int  DEFAULT 30,
  p_offset  int  DEFAULT 0,
  p_q       text DEFAULT NULL,
  p_crc     text DEFAULT NULL
) RETURNS TABLE(
  id                   integer,
  nome                 text,
  telefone             text,
  origem               text,
  status               text,
  valor                double precision,
  criado_em            timestamptz,
  data_comparecimento  timestamptz,
  data_agendamento     timestamptz,
  data_fechamento      timestamptz,
  data_orcamento       timestamptz,
  data_avaliacao       timestamptz,
  crc_agendamento_nome text,
  crc_comercial_nome   text
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH base AS (
    SELECT l.*,
      CASE
        WHEN l.status IN ('Em nutrição','Reclassificar')
          THEN COALESCE(l.data_orcamento, l.data_comparecimento, l.criado_em)
        ELSE l.data_comparecimento
      END AS ref_time
    FROM leads l
    WHERE l.status IN ('Em nutrição','Reclassificar','Compareceu')
      AND NOT (l.status = 'Compareceu'
               AND l.data_comparecimento >= NOW() - INTERVAL '30 days')
  )
  SELECT id, nome, telefone, origem, status, valor, criado_em,
         data_comparecimento, data_agendamento, data_fechamento,
         data_orcamento, data_avaliacao, crc_agendamento_nome, crc_comercial_nome
  FROM base
  WHERE (
    (p_bucket = '30'  AND ref_time >= NOW() - INTERVAL '180 days'
                      AND ref_time <  NOW() - INTERVAL '30 days')
    OR
    (p_bucket = '180' AND ref_time >= NOW() - INTERVAL '365 days'
                      AND ref_time <  NOW() - INTERVAL '180 days')
    OR
    (p_bucket = '365' AND ref_time < NOW() - INTERVAL '365 days')
  )
  AND (p_q IS NULL OR nome ILIKE '%' || p_q || '%'
                   OR telefone ILIKE '%' || p_q || '%')
  AND (p_crc IS NULL OR crc_comercial_nome = p_crc)
  ORDER BY ref_time DESC
  LIMIT p_limit OFFSET p_offset;
$$;
```

- [ ] **Step 2: Verificar que as funções existem**

```sql
SELECT proname FROM pg_proc WHERE proname IN ('kanban_nutricao','kanban_nutricao_count');
```

Esperado: 2 linhas.

- [ ] **Step 3: Smoke test rápido das funções**

```sql
SELECT kanban_nutricao_count('30');
SELECT COUNT(*) FROM kanban_nutricao('30', 5, 0);
```

Não deve retornar erro. Números podem ser 0 ou mais.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(kanban): RPCs SQL kanban_nutricao e kanban_nutricao_count"
```

---

## Task 2: Backend — FUNIL + helpers + endpoints Kanban Leads

**Files:**
- Modify: `server.js` linha 46 (FUNIL) + novo bloco de código após a seção `// ========== STATS ==========`

- [ ] **Step 1: Adicionar 'Faltou' ao FUNIL (server.js linha 46)**

Substituir:
```js
const FUNIL = ['Lead', 'Aguardando', 'Agendado', 'Compareceu', 'Nutrir', 'Não tem Interesse', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'Reclassificar', 'Em nutrição', 'Fechou', 'Perdido'];
```
Por:
```js
const FUNIL = ['Lead', 'Aguardando', 'Agendado', 'Faltou', 'Compareceu', 'Nutrir', 'Não tem Interesse', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'Reclassificar', 'Em nutrição', 'Fechou', 'Perdido'];
```

- [ ] **Step 2: Adicionar o helper e endpoints logo após o bloco `// ========== STATS ==========` (após a linha `});` que fecha o endpoint de stats)**

Adicionar o seguinte bloco em `server.js`:

```js
// ========== KANBAN ==========
const CARD_FIELDS = 'id,nome,telefone,origem,status,valor,criado_em,data_comparecimento,data_agendamento,data_fechamento,data_orcamento,data_avaliacao,crc_agendamento_nome,crc_comercial_nome';

function buildLeadsColFilter(coluna, q, crc, countOnly = false) {
  const now = Date.now();
  const d30  = new Date(now - 30  * 864e5).toISOString();
  const d180 = new Date(now - 180 * 864e5).toISOString();
  const d365 = new Date(now - 365 * 864e5).toISOString();
  const NURTURE = ['Lead', 'Nutrir', 'Reclassificar'];
  const sel = countOnly ? '*' : CARD_FIELDS;
  const opts = countOnly ? { count: 'exact', head: true } : { count: 'exact' };
  let qb = supabase.from('leads').select(sel, opts);
  switch (coluna) {
    case 'lead':
      qb = qb.in('status', NURTURE).gte('criado_em', d30); break;
    case 'nutrir_30':
      qb = qb.in('status', NURTURE).lt('criado_em', d30).gte('criado_em', d180); break;
    case 'nutrir_180':
      qb = qb.in('status', NURTURE).lt('criado_em', d180).gte('criado_em', d365); break;
    case 'nutrir_365':
      qb = qb.in('status', NURTURE).lt('criado_em', d365); break;
    case 'aguardando':      qb = qb.eq('status', 'Aguardando'); break;
    case 'agendado':        qb = qb.eq('status', 'Agendado'); break;
    case 'faltou':          qb = qb.eq('status', 'Faltou'); break;
    case 'compareceu':
      qb = qb.eq('status', 'Compareceu').gte('data_comparecimento', d30); break;
    case 'nao_tem_interesse': qb = qb.eq('status', 'Não tem Interesse'); break;
    default: return null;
  }
  if (q) qb = qb.or(`nome.ilike.%${q}%,telefone.ilike.%${q}%`);
  if (crc) qb = qb.eq('crc_agendamento_nome', crc);
  return qb;
}

const LEADS_COLUNAS = ['lead','nutrir_30','nutrir_180','nutrir_365','aguardando','agendado','faltou','compareceu','nao_tem_interesse'];

// IMPORTANTE: /counts deve vir ANTES de /:coluna para não ser capturado como parâmetro
app.get('/api/kanban/leads/counts', requireAuth, rateLimit, async (req, res) => {
  const q = req.query.q || null;
  const crc = req.query.crc || null;
  try {
    const results = await Promise.all(
      LEADS_COLUNAS.map(async col => {
        const qb = buildLeadsColFilter(col, q, crc, true);
        if (!qb) return [col, 0];
        const { count, error } = await qb;
        return [col, error ? 0 : (count ?? 0)];
      })
    );
    res.json(Object.fromEntries(results));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/kanban/leads/:coluna', requireAuth, rateLimit, async (req, res) => {
  const { coluna } = req.params;
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  const q = req.query.q || null;
  const crc = req.query.crc || null;
  if (!LEADS_COLUNAS.includes(coluna)) return res.status(400).json({ error: 'Coluna inválida' });
  try {
    const orderField = coluna === 'agendado' ? 'data_agendamento' : coluna === 'compareceu' ? 'data_comparecimento' : 'criado_em';
    const ascending  = coluna === 'agendado';
    const offset = page * 30;
    const { data, count, error } = await buildLeadsColFilter(coluna, q, crc)
      .order(orderField, { ascending })
      .range(offset, offset + 29);
    if (error) throw error;
    res.json({ leads: data, total: count ?? 0, page, hasMore: (data?.length ?? 0) === 30 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 3: Verificar manualmente que o servidor sobe sem erro**

```bash
node -e "require('./server.js')" 2>&1 | head -5
```

Esperado: nenhuma exceção de sintaxe (vai falhar na conexão Supabase, isso é ok para teste de sintaxe).

- [ ] **Step 4: Testar o endpoint counts localmente**

Subir o servidor e executar:
```bash
curl -s -H "Authorization: Bearer SEU_TOKEN" http://localhost:3000/api/kanban/leads/counts | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
```

Esperado: JSON com 9 chaves (`lead`, `nutrir_30`, ..., `nao_tem_interesse`), todas numéricas.

- [ ] **Step 5: Testar o endpoint de coluna**

```bash
curl -s -H "Authorization: Bearer SEU_TOKEN" "http://localhost:3000/api/kanban/leads/nutrir_30?page=0" | node -e "..."
```

Esperado: `{ leads: [...], total: N, page: 0, hasMore: bool }`. Cada item de `leads` deve ter os campos do CARD_FIELDS.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(kanban): FUNIL+Faltou, helper buildLeadsColFilter, endpoints /api/kanban/leads/*"
```

---

## Task 3: Backend — endpoints Kanban Comercial

**Files:**
- Modify: `server.js` — adicionar logo após os endpoints de Leads do Task 2

- [ ] **Step 1: Adicionar helper e endpoints Comercial em `server.js`**

Adicionar após o bloco do Task 2:

```js
function buildComercialColFilter(coluna, q, crc, countOnly = false) {
  const now = Date.now();
  const d30  = new Date(now - 30  * 864e5).toISOString();
  const sel  = countOnly ? '*' : CARD_FIELDS;
  const opts = countOnly ? { count: 'exact', head: true } : { count: 'exact' };
  let qb = supabase.from('leads').select(sel, opts);
  switch (coluna) {
    case 'compareceu':
      qb = qb.eq('status', 'Compareceu').gte('data_comparecimento', d30); break;
    case 'd0': qb = qb.eq('status', 'D0'); break;
    case 'd1': qb = qb.eq('status', 'D1'); break;
    case 'd2': qb = qb.eq('status', 'D2'); break;
    case 'd3': qb = qb.eq('status', 'D3'); break;
    case 'd4': qb = qb.eq('status', 'D4'); break;
    case 'd5': qb = qb.eq('status', 'D5'); break;
    case 'fechou':
      qb = qb.eq('status', 'Fechou').gte('data_fechamento', d30); break;
    case 'perdido': qb = qb.eq('status', 'Perdido'); break;
    default: return null; // nutricao_* tratado via RPC separado
  }
  if (q) qb = qb.or(`nome.ilike.%${q}%,telefone.ilike.%${q}%`);
  if (crc) qb = qb.eq('crc_comercial_nome', crc);
  return qb;
}

const COMERCIAL_SIMPLES = ['compareceu','d0','d1','d2','d3','d4','d5','fechou','perdido'];
const COMERCIAL_COLUNAS = [...COMERCIAL_SIMPLES, 'nutricao_30','nutricao_180','nutricao_365'];

app.get('/api/kanban/comercial/counts', requireAuth, rateLimit, async (req, res) => {
  const q   = req.query.q   || null;
  const crc = req.query.crc || null;
  try {
    const simplesPromises = COMERCIAL_SIMPLES.map(async col => {
      const qb = buildComercialColFilter(col, q, crc, true);
      const { count, error } = await qb;
      return [col, error ? 0 : (count ?? 0)];
    });
    const nutricaoPromises = ['30','180','365'].map(async bucket => {
      const { data, error } = await supabase.rpc('kanban_nutricao_count', {
        p_bucket: bucket,
        p_q: q,
        p_crc: crc,
      });
      return [`nutricao_${bucket}`, error ? 0 : (Number(data) || 0)];
    });
    const results = await Promise.all([...simplesPromises, ...nutricaoPromises]);
    res.json(Object.fromEntries(results));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/kanban/comercial/:coluna', requireAuth, rateLimit, async (req, res) => {
  const { coluna } = req.params;
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  const q   = req.query.q   || null;
  const crc = req.query.crc || null;
  if (!COMERCIAL_COLUNAS.includes(coluna)) return res.status(400).json({ error: 'Coluna inválida' });
  try {
    const offset = page * 30;
    if (coluna.startsWith('nutricao_')) {
      const bucket = coluna.replace('nutricao_', '');
      const { data, error } = await supabase.rpc('kanban_nutricao', {
        p_bucket: bucket, p_limit: 30, p_offset: offset, p_q: q, p_crc: crc,
      });
      if (error) throw error;
      const { data: total } = await supabase.rpc('kanban_nutricao_count', { p_bucket: bucket, p_q: q, p_crc: crc });
      return res.json({ leads: data, total: Number(total) || 0, page, hasMore: (data?.length ?? 0) === 30 });
    }
    const orderField = coluna === 'compareceu' ? 'data_comparecimento'
      : ['d0','d1','d2','d3','d4','d5'].includes(coluna) ? 'data_avaliacao'
      : coluna === 'fechou' ? 'data_fechamento' : 'criado_em';
    const { data, count, error } = await buildComercialColFilter(coluna, q, crc)
      .order(orderField, { ascending: false, nullsFirst: false })
      .range(offset, offset + 29);
    if (error) throw error;
    res.json({ leads: data, total: count ?? 0, page, hasMore: (data?.length ?? 0) === 30 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 2: Testar counts e coluna do comercial**

```bash
curl -s -H "Authorization: Bearer SEU_TOKEN" http://localhost:3000/api/kanban/comercial/counts
curl -s -H "Authorization: Bearer SEU_TOKEN" http://localhost:3000/api/kanban/comercial/nutricao_30
```

Esperado: JSON válido com as chaves corretas, sem erro.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(kanban): helper buildComercialColFilter, endpoints /api/kanban/comercial/*"
```

---

## Task 4: Nav + Módulo de Usuários + handler abrir_lead

**Files:**
- Modify: `public/js/shared-nav.js`
- Modify: `public/index.html`

- [ ] **Step 1: Adicionar Kanban Leads e Kanban Comercial ao shared-nav.js**

Após a linha do `navLink('/comercial/', ...)`, adicionar:

```js
    ${navLink('/kanban-leads/', 'admin,crc,crc_leads,crc_comercial,mod_kanban_leads', 'kanban-leads',
      `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="5" height="18"/><rect x="10" y="3" width="5" height="12"/><rect x="17" y="3" width="4" height="8"/></svg>`,
      'Kanban Leads')}

    ${navLink('/kanban-comercial/', 'admin,crc,crc_comercial,mod_kanban_comercial', 'kanban-comercial',
      `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="5" height="14"/><rect x="10" y="3" width="5" height="18"/><rect x="17" y="3" width="4" height="10"/></svg>`,
      'Kanban Comercial')}
```

- [ ] **Step 2: Adicionar links de nav no `public/index.html`**

Localizar o bloco dos botões de nav para "Comercial" em `public/index.html`. Após o botão Comercial, adicionar:

```html
<a class="nav-btn" href="/kanban-leads/" data-roles="admin,crc,crc_leads,crc_comercial,mod_kanban_leads">
  <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="5" height="18"/><rect x="10" y="3" width="5" height="12"/><rect x="17" y="3" width="4" height="8"/></svg>
  Kanban Leads
</a>
<a class="nav-btn" href="/kanban-comercial/" data-roles="admin,crc,crc_comercial,mod_kanban_comercial">
  <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="5" height="14"/><rect x="10" y="3" width="5" height="18"/><rect x="17" y="3" width="4" height="10"/></svg>
  Kanban Comercial
</a>
```

- [ ] **Step 3: Registrar roles no Módulo de Usuários em `public/index.html`**

3a. Localizar `_ROLE_LABELS` no JS de `index.html` e adicionar:
```js
mod_kanban_leads:    'Kanban Leads',
mod_kanban_comercial: 'Kanban Comercial',
```

3b. Localizar a seção "Módulos Extras" (checkboxes `nu-mod-*`) e adicionar:
```html
<label><input type="checkbox" id="nu-mod-kanban_leads"> Kanban Leads</label>
<label><input type="checkbox" id="nu-mod-kanban_comercial"> Kanban Comercial</label>
```

3c. Localizar `criarUsuario()` e adicionar:
```js
if (document.getElementById('nu-mod-kanban_leads').checked) roles.push('mod_kanban_leads');
if (document.getElementById('nu-mod-kanban_comercial').checked) roles.push('mod_kanban_comercial');
```

- [ ] **Step 4: Adicionar handler `?abrir_lead=ID` no `public/index.html`**

No script de inicialização do `index.html` (onde a página carrega ao iniciar), adicionar após o `DOMContentLoaded` ou na função de init existente:

```js
// Abre lead vindo de outro módulo (ex: kanban pages)
const _openLeadParam = new URLSearchParams(location.search).get('abrir_lead');
if (_openLeadParam) {
  history.replaceState(null, '', location.pathname + location.hash);
  // Aguarda o sistema de leads carregar e abre o chat
  const _tryOpen = setInterval(() => {
    if (typeof abrirChat === 'function') {
      clearInterval(_tryOpen);
      showPage('conversas');
      abrirChat(parseInt(_openLeadParam, 10));
    }
  }, 150);
  setTimeout(() => clearInterval(_tryOpen), 5000);
}
```

- [ ] **Step 5: Commit**

```bash
git add public/js/shared-nav.js public/index.html
git commit -m "feat(kanban): nav links, roles Usuarios, handler abrir_lead"
```

---

## Task 5: Frontend — Kanban Leads

**Files:**
- Create: `public/kanban-leads/index.html`

- [ ] **Step 1: Criar `public/kanban-leads/index.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kanban Leads — CRM AMA</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root[data-theme="dark"] {
  --bg:#0f1117;--bg2:#181b24;--bg3:#1e2230;--border:#2a2f42;
  --text:#e8eaf0;--muted:#6b7280;--accent:#4f8ef7;--accent-hover:#3a78e0;
  --green:#22c55e;--yellow:#f59e0b;--red:#ef4444;--orange:#f97316;--purple:#a855f7;
}
:root[data-theme="light"] {
  --bg:#f7f8fa;--bg2:#ffffff;--bg3:#f1f3f7;--border:#e3e6ed;
  --text:#1a1d29;--muted:#6b7280;--accent:#3b82f6;--accent-hover:#2563eb;
  --green:#16a34a;--yellow:#d97706;--red:#dc2626;--orange:#ea580c;--purple:#9333ea;
}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;}
.kb-wrap{display:flex;flex-direction:column;height:100vh;padding:20px 20px 0;overflow:hidden;}
.kb-header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:16px;flex-shrink:0;}
.kb-header h1{font-size:20px;font-weight:700;flex:1;}
.kb-search{padding:7px 11px;border-radius:8px;border:1px solid var(--border);background:var(--bg2);
  color:var(--text);font-size:13px;font-family:inherit;width:220px;}
.kb-crc{padding:7px 11px;border-radius:8px;border:1px solid var(--border);background:var(--bg2);
  color:var(--text);font-size:13px;font-family:inherit;}
.kb-board{display:flex;gap:12px;overflow-x:auto;overflow-y:hidden;flex:1;padding-bottom:12px;
  -webkit-overflow-scrolling:touch;}
.kb-col{flex-shrink:0;width:280px;display:flex;flex-direction:column;
  background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden;
  transition:width .2s;}
.kb-col.collapsed{width:48px;}
.kb-col-head{display:flex;align-items:center;gap:8px;padding:12px 14px;cursor:pointer;
  border-bottom:1px solid var(--border);flex-shrink:0;user-select:none;}
.kb-col-head .kb-col-color{width:4px;height:20px;border-radius:2px;flex-shrink:0;}
.kb-col-head .kb-col-title{font-size:13px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;}
.kb-col.collapsed .kb-col-title{display:none;}
.kb-col-count{font-size:11px;font-weight:700;font-family:'DM Mono',monospace;
  background:var(--bg3);border-radius:999px;padding:2px 7px;flex-shrink:0;}
.kb-col.collapsed .kb-col-count{writing-mode:vertical-rl;padding:6px 4px;}
.kb-col-body{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px;}
.kb-col.collapsed .kb-col-body{display:none;}
.kb-col.drop-over{background:var(--bg3);outline:2px dashed var(--accent);}
.kb-card{background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:11px 12px;
  cursor:pointer;transition:box-shadow .15s;}
.kb-card:hover{box-shadow:0 2px 8px rgba(0,0,0,.15);}
.kb-card[draggable="true"]{cursor:grab;}
.kb-card.dragging{opacity:.4;}
.kb-card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:4px;}
.kb-card-nome{font-size:13px;font-weight:600;line-height:1.3;}
.kb-card-age{font-size:11px;color:var(--muted);white-space:nowrap;flex-shrink:0;}
.kb-card-tel{font-size:12px;color:var(--muted);margin-bottom:7px;font-family:'DM Mono',monospace;}
.kb-card-foot{display:flex;justify-content:space-between;align-items:center;gap:6px;}
.kb-badge{font-size:10.5px;color:var(--muted);background:var(--bg3);
  border-radius:999px;padding:2px 7px;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;max-width:120px;}
.kb-valor{font-size:11.5px;font-weight:600;color:var(--green);white-space:nowrap;}
.kb-wa{font-size:11.5px;padding:4px 9px;border-radius:6px;border:1px solid var(--border);
  background:none;color:var(--text);cursor:pointer;font-family:inherit;transition:all .15s;}
.kb-wa:hover{background:var(--green);color:#fff;border-color:var(--green);}
.kb-load-more{margin-top:4px;padding:7px;border-radius:8px;border:1px dashed var(--border);
  background:none;color:var(--muted);font-size:12px;cursor:pointer;font-family:inherit;
  transition:all .15s;width:100%;}
.kb-load-more:hover{border-color:var(--accent);color:var(--accent);}
.kb-empty{font-size:12px;color:var(--muted);text-align:center;padding:20px 0;}
.kb-spinner{text-align:center;padding:20px;font-size:12px;color:var(--muted);}
</style>
<script src="/js/shared-nav.js" data-active="kanban-leads" defer></script>
</head>
<body class="crm-shell">
<div class="kb-wrap crm-content">
  <div class="kb-header">
    <h1>Kanban Leads</h1>
    <input class="kb-search" id="kb-search" placeholder="Buscar nome ou telefone…" autocomplete="off">
    <select class="kb-crc" id="kb-crc"><option value="">Todos os CRCs</option></select>
  </div>
  <div class="kb-board" id="kb-board"></div>
</div>
<script>
// ── AUTH ──────────────────────────────────────────────────────────────────────
let _token = null;
for (const k of Object.keys(localStorage)) {
  if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
    try { _token = JSON.parse(localStorage.getItem(k))?.access_token; } catch(_){}
  }
}
if (!_token) { window.location.href = '/'; throw new Error('no token'); }

async function api(path) {
  const r = await fetch(path, { headers: { Authorization: 'Bearer ' + _token } });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function patchLead(id, status) {
  const r = await fetch('/api/leads/' + id, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + _token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ── COLUMN DEFINITIONS ────────────────────────────────────────────────────────
const COLUNAS = [
  { slug:'lead',             label:'Lead',              cor:'var(--accent)', dropTarget:false, statusSet:null },
  { slug:'nutrir_30',        label:'Nutrir 30–180d',    cor:'var(--yellow)', dropTarget:false, statusSet:null },
  { slug:'nutrir_180',       label:'Nutrir 180–365d',   cor:'var(--orange)', dropTarget:false, statusSet:null },
  { slug:'nutrir_365',       label:'Nutrir 365+',       cor:'var(--red)',    dropTarget:false, statusSet:null },
  { slug:'aguardando',       label:'Aguardando',        cor:'var(--muted)',  dropTarget:true,  statusSet:'Aguardando' },
  { slug:'agendado',         label:'Agendado',          cor:'var(--yellow)', dropTarget:true,  statusSet:'Agendado' },
  { slug:'faltou',           label:'Faltou',            cor:'var(--orange)', dropTarget:true,  statusSet:'Faltou' },
  { slug:'compareceu',       label:'Compareceu',        cor:'var(--purple)', dropTarget:true,  statusSet:'Compareceu' },
  { slug:'nao_tem_interesse',label:'Não tem interesse', cor:'var(--muted)',  dropTarget:true,  statusSet:'Não tem Interesse' },
];

// ── STATE ─────────────────────────────────────────────────────────────────────
const state = {};   // slug → { leads:[], total:0, page:0, hasMore:false, loading:false }
COLUNAS.forEach(c => { state[c.slug] = { leads:[], total:0, page:0, hasMore:false, loading:false }; });
const collapsed = JSON.parse(localStorage.getItem('kb-leads-collapsed') || '{}');
let _searchQ = '', _crcQ = '', _searchTimer = null, _draggingId = null, _draggingStatus = null;

// ── HELPERS ───────────────────────────────────────────────────────────────────
function timeAgo(iso) {
  if (!iso) return '';
  const d = Math.floor((Date.now() - new Date(iso)) / 864e5);
  if (d === 0) return 'hoje';
  if (d === 1) return '1d atrás';
  if (d < 30)  return d + 'd atrás';
  const m = Math.floor(d / 30);
  return m < 12 ? m + 'm atrás' : Math.floor(m/12) + 'a atrás';
}
function fmtTel(t) {
  const d = (t||'').replace(/\D/g,'');
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  return t || '';
}
function fmtBRL(v) {
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits:0 });
}

// ── CARD RENDER ───────────────────────────────────────────────────────────────
function renderCard(lead) {
  const age = timeAgo(lead.criado_em);
  const tel = lead.telefone || '';
  return `<div class="kb-card" draggable="true" data-id="${lead.id}" data-status="${lead.status}"
    ondragstart="onDragStart(event)" ondragend="onDragEnd(event)"
    onclick="if(!window._kbDragging)abrirLead(${lead.id})">
    <div class="kb-card-top">
      <span class="kb-card-nome">${lead.nome||'Sem nome'}</span>
      <span class="kb-card-age">${age}</span>
    </div>
    <div class="kb-card-tel">${fmtTel(tel)}</div>
    <div class="kb-card-foot">
      <span class="kb-badge">${lead.origem||''}</span>
      ${lead.valor ? `<span class="kb-valor">${fmtBRL(lead.valor)}</span>` : ''}
      <button class="kb-wa" onclick="event.stopPropagation();abrirWA('${tel}')">💬</button>
    </div>
  </div>`;
}

// ── COLUMN RENDER ─────────────────────────────────────────────────────────────
function renderCol(col) {
  const s = state[col.slug];
  const isCollapsed = collapsed[col.slug];
  const el = document.getElementById('col-' + col.slug);
  if (!el) return;
  el.className = 'kb-col' + (isCollapsed ? ' collapsed' : '');
  if (!isCollapsed && col.dropTarget) {
    el.ondragover  = e => { e.preventDefault(); el.classList.add('drop-over'); };
    el.ondragleave = () => el.classList.remove('drop-over');
    el.ondrop      = e => onDrop(e, col);
  } else {
    el.ondragover = el.ondragleave = el.ondrop = null;
  }
  const body = el.querySelector('.kb-col-body');
  if (body) {
    body.innerHTML = s.loading && s.leads.length === 0
      ? '<div class="kb-spinner">Carregando…</div>'
      : s.leads.length === 0
        ? '<div class="kb-empty">Nenhum lead</div>'
        : s.leads.map(renderCard).join('')
          + (s.hasMore ? `<button class="kb-load-more" onclick="loadMore('${col.slug}')">+ 30 leads</button>` : '');
  }
  const countEl = el.querySelector('.kb-col-count');
  if (countEl) countEl.textContent = s.total.toLocaleString('pt-BR');
}

function buildBoard() {
  const board = document.getElementById('kb-board');
  board.innerHTML = COLUNAS.map(col => `
    <div class="kb-col" id="col-${col.slug}">
      <div class="kb-col-head" onclick="toggleCollapse('${col.slug}')">
        <div class="kb-col-color" style="background:${col.cor}"></div>
        <span class="kb-col-title">${col.label}</span>
        <span class="kb-col-count">…</span>
      </div>
      <div class="kb-col-body"><div class="kb-spinner">Carregando…</div></div>
    </div>`).join('');
}

// ── DATA LOADING ──────────────────────────────────────────────────────────────
function qs() {
  const p = new URLSearchParams();
  if (_searchQ) p.set('q', _searchQ);
  if (_crcQ)    p.set('crc', _crcQ);
  return p.toString() ? '?' + p : '';
}

async function loadCounts() {
  try {
    const counts = await api('/api/kanban/leads/counts' + qs());
    COLUNAS.forEach(col => {
      state[col.slug].total = counts[col.slug] ?? 0;
      const el = document.getElementById('col-' + col.slug);
      const c = el?.querySelector('.kb-col-count');
      if (c) c.textContent = state[col.slug].total.toLocaleString('pt-BR');
    });
  } catch(e) { console.error('counts:', e); }
}

async function loadColCards(slug, page = 0) {
  const s = state[slug];
  if (s.loading) return;
  s.loading = true;
  const col = COLUNAS.find(c => c.slug === slug);
  renderCol(col);
  try {
    const sep = qs() ? qs() + '&' : '?';
    const data = await api(`/api/kanban/leads/${slug}${qs()}${qs()?'&':'?'}page=${page}`);
    if (page === 0) s.leads = data.leads;
    else s.leads = [...s.leads, ...data.leads];
    s.total   = data.total;
    s.page    = page;
    s.hasMore = data.hasMore;
  } catch(e) { console.error('loadCol', slug, e); }
  s.loading = false;
  renderCol(col);
}

async function loadMore(slug) {
  const s = state[slug];
  await loadColCards(slug, s.page + 1);
}

async function loadAll() {
  await loadCounts();
  await Promise.all(COLUNAS.map(c => loadColCards(c.slug, 0)));
}

async function reload() {
  COLUNAS.forEach(c => { state[c.slug].leads = []; state[c.slug].page = 0; });
  await loadAll();
}

// ── DRAG AND DROP ─────────────────────────────────────────────────────────────
window._kbDragging = false;

function onDragStart(e) {
  _draggingId     = parseInt(e.currentTarget.dataset.id, 10);
  _draggingStatus = e.currentTarget.dataset.status;
  window._kbDragging = true;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  setTimeout(() => { window._kbDragging = false; }, 80);
  document.querySelectorAll('.kb-col').forEach(c => c.classList.remove('drop-over'));
}

async function onDrop(e, col) {
  e.preventDefault();
  col.el = document.getElementById('col-' + col.slug);
  if (col.el) col.el.classList.remove('drop-over');
  if (!_draggingId || !col.statusSet) return;
  if (col.statusSet === _draggingStatus) return; // mesmo status, noop
  try {
    await patchLead(_draggingId, col.statusSet);
    // Remove otimista da coluna de origem
    COLUNAS.forEach(c => {
      const idx = state[c.slug].leads.findIndex(l => l.id === _draggingId);
      if (idx !== -1) {
        state[c.slug].leads.splice(idx, 1);
        state[c.slug].total = Math.max(0, state[c.slug].total - 1);
        renderCol(c);
      }
    });
    // Recarrega coluna de destino
    state[col.slug].leads = [];
    state[col.slug].page  = 0;
    await loadColCards(col.slug, 0);
    await loadCounts();
  } catch(err) {
    alert('Erro ao mover lead: ' + err.message);
  }
}

// ── COLLAPSE ──────────────────────────────────────────────────────────────────
function toggleCollapse(slug) {
  collapsed[slug] = !collapsed[slug];
  localStorage.setItem('kb-leads-collapsed', JSON.stringify(collapsed));
  renderCol(COLUNAS.find(c => c.slug === slug));
}

// ── ACTIONS ───────────────────────────────────────────────────────────────────
function abrirLead(id) { window.open('/?abrir_lead=' + id, '_blank'); }
function abrirWA(tel) {
  const t = tel.replace(/\D/g,'');
  window.open('https://wa.me/55' + t, '_blank');
}

// ── FILTERS ───────────────────────────────────────────────────────────────────
document.getElementById('kb-search').addEventListener('input', function() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => { _searchQ = this.value.trim(); reload(); }, 300);
});
document.getElementById('kb-crc').addEventListener('change', function() {
  _crcQ = this.value; reload();
});

// ── INIT ──────────────────────────────────────────────────────────────────────
buildBoard();
loadAll();
</script>
</body>
</html>
```

- [ ] **Step 2: Verificar que a página abre sem erros de console**

Abrir `http://2.24.94.120:3000/kanban-leads/` no browser.
Verificar:
- Sidebar aparece corretamente
- 9 colunas renderizam com labels corretos
- Counts carregam nos headers
- Cards aparecem nas colunas (Lead, Nutrir 30-180d, etc.)
- Busca por nome filtra resultados

- [ ] **Step 3: Commit**

```bash
git add public/kanban-leads/index.html
git commit -m "feat(kanban): página Kanban Leads (9 colunas, paginação, drag-drop, busca)"
```

---

## Task 6: Frontend — Kanban Comercial

**Files:**
- Create: `public/kanban-comercial/index.html`

- [ ] **Step 1: Criar `public/kanban-comercial/index.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kanban Comercial — CRM AMA</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root[data-theme="dark"] {
  --bg:#0f1117;--bg2:#181b24;--bg3:#1e2230;--border:#2a2f42;
  --text:#e8eaf0;--muted:#6b7280;--accent:#4f8ef7;--accent-hover:#3a78e0;
  --green:#22c55e;--yellow:#f59e0b;--red:#ef4444;--orange:#f97316;--purple:#a855f7;
}
:root[data-theme="light"] {
  --bg:#f7f8fa;--bg2:#ffffff;--bg3:#f1f3f7;--border:#e3e6ed;
  --text:#1a1d29;--muted:#6b7280;--accent:#3b82f6;--accent-hover:#2563eb;
  --green:#16a34a;--yellow:#d97706;--red:#dc2626;--orange:#ea580c;--purple:#9333ea;
}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;}
.kb-wrap{display:flex;flex-direction:column;height:100vh;padding:20px 20px 0;overflow:hidden;}
.kb-header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:16px;flex-shrink:0;}
.kb-header h1{font-size:20px;font-weight:700;flex:1;}
.kb-search{padding:7px 11px;border-radius:8px;border:1px solid var(--border);background:var(--bg2);
  color:var(--text);font-size:13px;font-family:inherit;width:220px;}
.kb-crc{padding:7px 11px;border-radius:8px;border:1px solid var(--border);background:var(--bg2);
  color:var(--text);font-size:13px;font-family:inherit;}
.kb-board{display:flex;gap:12px;overflow-x:auto;overflow-y:hidden;flex:1;padding-bottom:12px;
  -webkit-overflow-scrolling:touch;}
.kb-col{flex-shrink:0;width:280px;display:flex;flex-direction:column;
  background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden;
  transition:width .2s;}
.kb-col.collapsed{width:48px;}
.kb-col-head{display:flex;align-items:center;gap:8px;padding:12px 14px;cursor:pointer;
  border-bottom:1px solid var(--border);flex-shrink:0;user-select:none;}
.kb-col-head .kb-col-color{width:4px;height:20px;border-radius:2px;flex-shrink:0;}
.kb-col-head .kb-col-title{font-size:13px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;}
.kb-col.collapsed .kb-col-title{display:none;}
.kb-col-count{font-size:11px;font-weight:700;font-family:'DM Mono',monospace;
  background:var(--bg3);border-radius:999px;padding:2px 7px;flex-shrink:0;}
.kb-col.collapsed .kb-col-count{writing-mode:vertical-rl;padding:6px 4px;}
.kb-col-body{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px;}
.kb-col.collapsed .kb-col-body{display:none;}
.kb-col.drop-over{background:var(--bg3);outline:2px dashed var(--accent);}
.kb-card{background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:11px 12px;
  cursor:pointer;transition:box-shadow .15s;}
.kb-card:hover{box-shadow:0 2px 8px rgba(0,0,0,.15);}
.kb-card[draggable="true"]{cursor:grab;}
.kb-card.dragging{opacity:.4;}
.kb-card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:4px;}
.kb-card-nome{font-size:13px;font-weight:600;line-height:1.3;}
.kb-card-age{font-size:11px;color:var(--muted);white-space:nowrap;flex-shrink:0;}
.kb-card-tel{font-size:12px;color:var(--muted);margin-bottom:7px;font-family:'DM Mono',monospace;}
.kb-card-foot{display:flex;justify-content:space-between;align-items:center;gap:6px;}
.kb-badge{font-size:10.5px;color:var(--muted);background:var(--bg3);
  border-radius:999px;padding:2px 7px;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;max-width:120px;}
.kb-valor{font-size:11.5px;font-weight:600;color:var(--green);white-space:nowrap;}
.kb-wa{font-size:11.5px;padding:4px 9px;border-radius:6px;border:1px solid var(--border);
  background:none;color:var(--text);cursor:pointer;font-family:inherit;transition:all .15s;}
.kb-wa:hover{background:var(--green);color:#fff;border-color:var(--green);}
.kb-load-more{margin-top:4px;padding:7px;border-radius:8px;border:1px dashed var(--border);
  background:none;color:var(--muted);font-size:12px;cursor:pointer;font-family:inherit;
  transition:all .15s;width:100%;}
.kb-load-more:hover{border-color:var(--accent);color:var(--accent);}
.kb-empty{font-size:12px;color:var(--muted);text-align:center;padding:20px 0;}
.kb-spinner{text-align:center;padding:20px;font-size:12px;color:var(--muted);}
.kb-blocked-tip{font-size:11.5px;color:var(--orange);text-align:center;padding:8px;
  background:var(--bg3);border-radius:6px;border:1px solid var(--orange);margin-top:4px;}
</style>
<script src="/js/shared-nav.js" data-active="kanban-comercial" defer></script>
</head>
<body class="crm-shell">
<div class="kb-wrap crm-content">
  <div class="kb-header">
    <h1>Kanban Comercial</h1>
    <input class="kb-search" id="kb-search" placeholder="Buscar nome ou telefone…" autocomplete="off">
    <select class="kb-crc" id="kb-crc"><option value="">Todos os CRCs</option></select>
  </div>
  <div class="kb-board" id="kb-board"></div>
</div>
<script>
// ── AUTH ──────────────────────────────────────────────────────────────────────
let _token = null;
for (const k of Object.keys(localStorage)) {
  if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
    try { _token = JSON.parse(localStorage.getItem(k))?.access_token; } catch(_){}
  }
}
if (!_token) { window.location.href = '/'; throw new Error('no token'); }

async function api(path) {
  const r = await fetch(path, { headers: { Authorization: 'Bearer ' + _token } });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function patchLead(id, status) {
  const r = await fetch('/api/leads/' + id, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + _token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ── D0-D5 COLORS (gradiente accent→green) ────────────────────────────────────
const D_COLORS = ['#4f8ef7','#3ea4e8','#2dbad9','#1ccfca','#0be5bb','#22c55e'];

// ── COLUMN DEFINITIONS ────────────────────────────────────────────────────────
const COLUNAS = [
  { slug:'compareceu',    label:'Compareceu',         cor:'var(--purple)', dropTarget:true,  statusSet:'Compareceu', isNutricao:false },
  { slug:'d0',            label:'D0',                 cor:D_COLORS[0],     dropTarget:true,  statusSet:'D0',         isNutricao:false },
  { slug:'d1',            label:'D1',                 cor:D_COLORS[1],     dropTarget:true,  statusSet:'D1',         isNutricao:false },
  { slug:'d2',            label:'D2',                 cor:D_COLORS[2],     dropTarget:true,  statusSet:'D2',         isNutricao:false },
  { slug:'d3',            label:'D3',                 cor:D_COLORS[3],     dropTarget:true,  statusSet:'D3',         isNutricao:false },
  { slug:'d4',            label:'D4',                 cor:D_COLORS[4],     dropTarget:true,  statusSet:'D4',         isNutricao:false },
  { slug:'d5',            label:'D5',                 cor:D_COLORS[5],     dropTarget:true,  statusSet:'D5',         isNutricao:false },
  { slug:'nutricao_30',   label:'Em nutrição 30–180d',cor:'var(--yellow)', dropTarget:false, statusSet:null,         isNutricao:true },
  { slug:'nutricao_180',  label:'Em nutrição 180–365d',cor:'var(--orange)',dropTarget:false, statusSet:null,         isNutricao:true },
  { slug:'nutricao_365',  label:'Em nutrição 365+',   cor:'var(--red)',    dropTarget:false, statusSet:null,         isNutricao:true },
  { slug:'fechou',        label:'Fechou',             cor:'var(--green)',  dropTarget:true,  statusSet:'Fechou',     isNutricao:false },
  { slug:'perdido',       label:'Perdido',            cor:'var(--muted)',  dropTarget:true,  statusSet:'Perdido',    isNutricao:false },
];

// Slugs de Em nutrição — usados para bloquear drop Em nutrição → Compareceu
const NUTRICAO_SLUGS = new Set(['nutricao_30','nutricao_180','nutricao_365']);

// ── STATE ─────────────────────────────────────────────────────────────────────
const state = {};
COLUNAS.forEach(c => { state[c.slug] = { leads:[], total:0, page:0, hasMore:false, loading:false }; });
const collapsed = JSON.parse(localStorage.getItem('kb-comercial-collapsed') || '{}');
let _searchQ = '', _crcQ = '', _searchTimer = null;
let _draggingId = null, _draggingStatus = null, _draggingFromSlug = null;

// ── HELPERS ───────────────────────────────────────────────────────────────────
function timeAgo(iso) {
  if (!iso) return '';
  const d = Math.floor((Date.now() - new Date(iso)) / 864e5);
  if (d === 0) return 'hoje';
  if (d === 1) return '1d atrás';
  if (d < 30)  return d + 'd atrás';
  const m = Math.floor(d / 30);
  return m < 12 ? m + 'm atrás' : Math.floor(m/12) + 'a atrás';
}
function cardAge(lead, slug) {
  if (slug === 'compareceu') return timeAgo(lead.data_comparecimento);
  if (slug.startsWith('nutricao')) return timeAgo(lead.data_orcamento || lead.data_comparecimento || lead.criado_em);
  if (['d0','d1','d2','d3','d4','d5'].includes(slug)) return timeAgo(lead.data_avaliacao);
  if (slug === 'fechou') return timeAgo(lead.data_fechamento);
  return timeAgo(lead.criado_em);
}
function fmtTel(t) {
  const d = (t||'').replace(/\D/g,'');
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  return t || '';
}
function fmtBRL(v) { return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits:0 }); }

// ── CARD RENDER ───────────────────────────────────────────────────────────────
function renderCard(lead, slug) {
  const age = cardAge(lead, slug);
  const tel = lead.telefone || '';
  const crc = lead.crc_comercial_nome || lead.crc_agendamento_nome || '';
  return `<div class="kb-card" draggable="true" data-id="${lead.id}" data-status="${lead.status}" data-slug="${slug}"
    ondragstart="onDragStart(event)" ondragend="onDragEnd(event)"
    onclick="if(!window._kbDragging)abrirLead(${lead.id})">
    <div class="kb-card-top">
      <span class="kb-card-nome">${lead.nome||'Sem nome'}</span>
      <span class="kb-card-age">${age}</span>
    </div>
    <div class="kb-card-tel">${fmtTel(tel)}${crc ? ` · ${crc}` : ''}</div>
    <div class="kb-card-foot">
      <span class="kb-badge">${lead.origem||''}</span>
      ${lead.valor ? `<span class="kb-valor">${fmtBRL(lead.valor)}</span>` : ''}
      <button class="kb-wa" onclick="event.stopPropagation();abrirWA('${tel}')">💬</button>
    </div>
  </div>`;
}

// ── COLUMN RENDER ─────────────────────────────────────────────────────────────
function renderCol(col) {
  const s = state[col.slug];
  const isCollapsed = collapsed[col.slug];
  const el = document.getElementById('col-' + col.slug);
  if (!el) return;
  el.className = 'kb-col' + (isCollapsed ? ' collapsed' : '');
  if (!isCollapsed && col.dropTarget) {
    el.ondragover  = e => { e.preventDefault(); el.classList.add('drop-over'); };
    el.ondragleave = () => el.classList.remove('drop-over');
    el.ondrop      = e => onDrop(e, col);
  } else {
    el.ondragover = el.ondragleave = el.ondrop = null;
  }
  const body = el.querySelector('.kb-col-body');
  if (body) {
    body.innerHTML = s.loading && s.leads.length === 0
      ? '<div class="kb-spinner">Carregando…</div>'
      : s.leads.length === 0
        ? '<div class="kb-empty">Nenhum lead</div>'
        : s.leads.map(l => renderCard(l, col.slug)).join('')
          + (s.hasMore ? `<button class="kb-load-more" onclick="loadMore('${col.slug}')">+ 30 leads</button>` : '');
  }
  const countEl = el.querySelector('.kb-col-count');
  if (countEl) countEl.textContent = s.total.toLocaleString('pt-BR');
}

function buildBoard() {
  const board = document.getElementById('kb-board');
  board.innerHTML = COLUNAS.map(col => `
    <div class="kb-col" id="col-${col.slug}">
      <div class="kb-col-head" onclick="toggleCollapse('${col.slug}')">
        <div class="kb-col-color" style="background:${col.cor}"></div>
        <span class="kb-col-title">${col.label}</span>
        <span class="kb-col-count">…</span>
      </div>
      <div class="kb-col-body"><div class="kb-spinner">Carregando…</div></div>
    </div>`).join('');
}

// ── DATA LOADING ──────────────────────────────────────────────────────────────
function qs() {
  const p = new URLSearchParams();
  if (_searchQ) p.set('q', _searchQ);
  if (_crcQ)    p.set('crc', _crcQ);
  return p.toString() ? '?' + p : '';
}

async function loadCounts() {
  try {
    const counts = await api('/api/kanban/comercial/counts' + qs());
    COLUNAS.forEach(col => {
      state[col.slug].total = counts[col.slug] ?? 0;
      const el = document.getElementById('col-' + col.slug);
      const c = el?.querySelector('.kb-col-count');
      if (c) c.textContent = state[col.slug].total.toLocaleString('pt-BR');
    });
  } catch(e) { console.error('counts:', e); }
}

async function loadColCards(slug, page = 0) {
  const s = state[slug];
  if (s.loading) return;
  s.loading = true;
  const col = COLUNAS.find(c => c.slug === slug);
  renderCol(col);
  try {
    const data = await api(`/api/kanban/comercial/${slug}${qs()}${qs()?'&':'?'}page=${page}`);
    if (page === 0) s.leads = data.leads;
    else s.leads = [...s.leads, ...data.leads];
    s.total   = data.total;
    s.page    = page;
    s.hasMore = data.hasMore;
  } catch(e) { console.error('loadCol', slug, e); }
  s.loading = false;
  renderCol(col);
}

async function loadMore(slug) {
  const s = state[slug];
  await loadColCards(slug, s.page + 1);
}

async function loadAll() {
  await loadCounts();
  await Promise.all(COLUNAS.map(c => loadColCards(c.slug, 0)));
}

async function reload() {
  COLUNAS.forEach(c => { state[c.slug].leads = []; state[c.slug].page = 0; });
  await loadAll();
}

// ── DRAG AND DROP ─────────────────────────────────────────────────────────────
window._kbDragging = false;

function onDragStart(e) {
  _draggingId       = parseInt(e.currentTarget.dataset.id, 10);
  _draggingStatus   = e.currentTarget.dataset.status;
  _draggingFromSlug = e.currentTarget.dataset.slug;
  window._kbDragging = true;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  setTimeout(() => { window._kbDragging = false; }, 80);
  document.querySelectorAll('.kb-col').forEach(c => c.classList.remove('drop-over'));
}

async function onDrop(e, col) {
  e.preventDefault();
  const el = document.getElementById('col-' + col.slug);
  if (el) el.classList.remove('drop-over');
  if (!_draggingId || !col.statusSet) return;
  if (col.statusSet === _draggingStatus) return;

  // EDGE CASE: bloquear drop de Em nutrição → Compareceu
  if (col.slug === 'compareceu' && NUTRICAO_SLUGS.has(_draggingFromSlug)) {
    const body = el?.querySelector('.kb-col-body');
    if (body) {
      const tip = document.createElement('div');
      tip.className = 'kb-blocked-tip';
      tip.textContent = 'Use D0–D5 para reativar este lead';
      body.prepend(tip);
      setTimeout(() => tip.remove(), 3500);
    }
    return;
  }

  try {
    await patchLead(_draggingId, col.statusSet);
    COLUNAS.forEach(c => {
      const idx = state[c.slug].leads.findIndex(l => l.id === _draggingId);
      if (idx !== -1) {
        state[c.slug].leads.splice(idx, 1);
        state[c.slug].total = Math.max(0, state[c.slug].total - 1);
        renderCol(c);
      }
    });
    state[col.slug].leads = [];
    state[col.slug].page  = 0;
    await loadColCards(col.slug, 0);
    await loadCounts();
  } catch(err) {
    alert('Erro ao mover lead: ' + err.message);
  }
}

// ── COLLAPSE ──────────────────────────────────────────────────────────────────
function toggleCollapse(slug) {
  collapsed[slug] = !collapsed[slug];
  localStorage.setItem('kb-comercial-collapsed', JSON.stringify(collapsed));
  renderCol(COLUNAS.find(c => c.slug === slug));
}

// ── ACTIONS ───────────────────────────────────────────────────────────────────
function abrirLead(id) { window.open('/?abrir_lead=' + id, '_blank'); }
function abrirWA(tel) {
  const t = tel.replace(/\D/g,'');
  window.open('https://wa.me/55' + t, '_blank');
}

// ── FILTERS ───────────────────────────────────────────────────────────────────
document.getElementById('kb-search').addEventListener('input', function() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => { _searchQ = this.value.trim(); reload(); }, 300);
});
document.getElementById('kb-crc').addEventListener('change', function() {
  _crcQ = this.value; reload();
});

// ── INIT ──────────────────────────────────────────────────────────────────────
buildBoard();
loadAll();
</script>
</body>
</html>
```

- [ ] **Step 2: Verificar a página no browser**

Abrir `http://2.24.94.120:3000/kanban-comercial/` e verificar:
- 12 colunas renderizam com labels e cores corretos
- Counts aparecem em cada header
- Cards em Em nutrição mostram o tempo baseado em `data_orcamento` (não `data_comparecimento`)
- Arrastar de Em nutrição → Compareceu exibe aviso "Use D0–D5 para reativar"
- Arrastar de Compareceu → D0 funciona e muda status corretamente

- [ ] **Step 3: Commit**

```bash
git add public/kanban-comercial/index.html
git commit -m "feat(kanban): página Kanban Comercial (12 colunas, COALESCE Em nutricao, edge case bloqueado)"
```

---

## Task 7: Deploy + smoke test final

**Files:** nenhum novo

- [ ] **Step 1: Push e deploy**

```bash
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

Aguardar ~60 segundos.

- [ ] **Step 2: Smoke test Kanban Leads**

Acessar `https://plataformaama-plataforma.uc5as5.easypanel.host/kanban-leads/` e verificar:
1. Sidebar presente e link "Kanban Leads" ativo
2. Coluna "Nutrir 365+" com count ~11k
3. Coluna "Lead" com count ~4
4. Buscar "ana" — colunas filtram
5. Colapsar "Nutrir 365+" — salva no localStorage e persiste no reload

- [ ] **Step 3: Smoke test Kanban Comercial**

Acessar `https://plataformaama-plataforma.uc5as5.easypanel.host/kanban-comercial/` e verificar:
1. 12 colunas renderizam com cores corretas (D0→D5 gradiente azul→verde)
2. "Em nutrição 30–180d" tem count > 0 (há leads Compareceu com 30-180 dias)
3. Arrastar card de "Em nutrição" para "Compareceu" → aviso laranja aparece e drag é bloqueado
4. Arrastar card de "Compareceu" para "D0" → funciona e muda status

- [ ] **Step 4: Verificar que sidebar na produção mostra os novos links**

Acessar qualquer página com sidebar (ex: `/pacientes/`) e confirmar que "Kanban Leads" e "Kanban Comercial" aparecem no menu lateral.

---

## Self-review: cobertura do spec

| Requisito do spec | Task |
|-------------------|------|
| 9 colunas Kanban Leads com critérios corretos | Task 2 + Task 5 |
| 12 colunas Kanban Comercial | Task 3 + Task 6 |
| Sub-colunas Nutrir com criado_em | Task 2 (query helper) |
| Sub-colunas Em nutrição com COALESCE(data_orcamento,...) | Task 1 (RPC) + Task 3 |
| Reclassificar incluso em Em nutrição | Task 1 (RPC) |
| Novo status 'Faltou' no FUNIL | Task 2 |
| Endpoints /api/kanban/leads/* | Task 2 |
| Endpoints /api/kanban/comercial/* | Task 3 |
| Paginação 30 cards/coluna com "load more" | Task 5 + Task 6 |
| Drag-and-drop via PATCH existente | Task 5 + Task 6 |
| Edge case Em nutrição → Compareceu bloqueado | Task 6 |
| Busca server-side debounced 300ms | Task 5 + Task 6 |
| Filtro por CRC | Task 5 + Task 6 |
| Collapse coluna em localStorage | Task 5 + Task 6 |
| Cores por urgência | Task 5 + Task 6 |
| D0-D5 gradiente azul→verde | Task 6 |
| Tempo na coluna baseado em campo correto | Task 5 + Task 6 |
| shared-nav com data-active | Task 4 + Task 5 + Task 6 |
| Roles mod_kanban_leads/comercial | Task 4 |
| Módulo de Usuários registrado | Task 4 |
| Link abrir_lead no CRM principal | Task 4 |
| Deploy | Task 7 |
