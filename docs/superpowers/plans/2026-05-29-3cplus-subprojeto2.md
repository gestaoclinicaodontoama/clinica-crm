# 3cplus Sub-projeto 2 — Campanha de Discagem Preditiva

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que CRCs lancem campanhas de discagem preditiva pelo CRM (Curva ABC e Leads), com preview antes de confirmar e controle de pause/retomada sem sair do sistema.

**Architecture:** 4 campanhas fixas no 3cplus (IDs em env vars). Cada lançamento substitui o mailing via API REST. Backend faz polling de resultados com `GET /api/v1/calls?campaign_id=...`. Widget compartilhado (`campanha-widget.js`) aparece em Curva ABC e Leads, pollingando a cada 60s e auto-encerrando quando a fila esvazia.

**Tech Stack:** Node.js + Express, Supabase Postgres, 3cplus REST API (gestor token + agent token), HTML/CSS/JS vanilla.

---

## File Structure

**Criar:**
- `supabase/migrations/20260529000000_campanhas_discagem.sql` — tabela + RLS
- `lib/3cplus-campanhas.js` — funções de API de campanha (gestor token + agent token)
- `public/js/campanha-widget.js` — widget de painel compartilhado entre módulos

**Modificar:**
- `server.js` — adicionar `require('./lib/3cplus-campanhas')` + 7 endpoints `/api/campanhas/*` + função `buscarContatos`
- `public/pos-tratamento/curva-abc.html` — botão "Enviar para Discagem" + mount div + script do widget
- `public/js/pos-tratamento/curva-abc.js` — `backendApi()` + `lancarCampanhaABC()` + modal de preview
- `public/index.html` — 3 botões de campanha + mount div + `lancarCampanha(tipo)` + modal + script do widget

---

## Task 1: Database Migration — Tabela `campanhas_discagem`

**Files:**
- Create: `supabase/migrations/20260529000000_campanhas_discagem.sql`

Context: O Supabase do projeto tem ID `mtqdpjhhqzvuklnlfpvi`. Migrações são aplicadas via MCP tool `mcp__plugin_supabase_supabase__apply_migration`. Depois verificar com `mcp__plugin_supabase_supabase__list_migrations`.

- [ ] **Step 1: Criar arquivo de migração**

```sql
-- supabase/migrations/20260529000000_campanhas_discagem.sql

CREATE TABLE campanhas_discagem (
  id                 SERIAL PRIMARY KEY,
  tipo               TEXT NOT NULL CHECK (tipo IN ('abc','indicacoes','recentes','frios')),
  threec_campaign_id INTEGER NOT NULL,
  contatos_total     INTEGER NOT NULL DEFAULT 0,
  contatos_json      JSONB,
  status             TEXT NOT NULL DEFAULT 'ativa'
                     CHECK (status IN ('ativa','pausada','encerrada')),
  usuario_id         UUID REFERENCES auth.users(id),
  iniciada_em        TIMESTAMPTZ DEFAULT NOW(),
  pausada_em         TIMESTAMPTZ,
  encerrada_em       TIMESTAMPTZ
);

ALTER TABLE campanhas_discagem ENABLE ROW LEVEL SECURITY;

CREATE POLICY "campanhas_discagem_select" ON campanhas_discagem FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND (roles && ARRAY['crc_leads','crc_comercial','gestor','admin'])
  )
);

CREATE POLICY "campanhas_discagem_insert" ON campanhas_discagem FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND (roles && ARRAY['crc_leads','crc_comercial','gestor','admin'])
  )
);

CREATE POLICY "campanhas_discagem_update" ON campanhas_discagem FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND (roles && ARRAY['crc_leads','crc_comercial','gestor','admin'])
  )
);
```

- [ ] **Step 2: Aplicar migração via MCP Supabase**

Usar a tool `mcp__plugin_supabase_supabase__apply_migration` com:
- `project_id`: `mtqdpjhhqzvuklnlfpvi`
- `name`: `campanhas_discagem`
- `query`: conteúdo do SQL acima

- [ ] **Step 3: Verificar migração aplicada**

Usar `mcp__plugin_supabase_supabase__list_migrations` e confirmar que `20260529000000_campanhas_discagem` aparece na lista.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260529000000_campanhas_discagem.sql
git commit -m "feat: add campanhas_discagem table with RLS"
```

---

## Task 2: `lib/3cplus-campanhas.js` — Funções de API de Campanha

**Files:**
- Create: `lib/3cplus-campanhas.js`

Context: `lib/3cplus.js` exporta `apiRequest(method, path, body, token)` que faz a chamada HTTP à 3cplus usando `?api_token=TOKEN` como query param. O gestor token vem de `process.env.THREEC_TOKEN`. Os endpoints de campanha são todos prefixados com `/api/v1/campaigns/{id}/`. **Atenção:** esses endpoints não foram testados em produção — a implementação deve lidar com respostas inesperadas. Se um endpoint retornar 404, pode ser que o endpoint correto seja diferente — o plan registra a alternativa em comentário para o implementador ajustar se necessário.

- [ ] **Step 1: Criar `lib/3cplus-campanhas.js`**

```js
'use strict';
const { apiRequest } = require('./3cplus');

const THREEC_TOKEN = () => process.env.THREEC_TOKEN || '';

// ── Gestor token ─────────────────────────────────────────────────────

async function uploadMailing(campaignId, contacts) {
  // contacts: [{nome, telefone}]
  // Alternativa se recusar JSON: converter para CSV internamente
  const r = await apiRequest('POST', `/api/v1/campaigns/${campaignId}/mailing`, contacts, THREEC_TOKEN());
  if (r.status < 200 || r.status >= 300) {
    const err = new Error(`3cplus uploadMailing: status ${r.status} — ${r.body.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  return r;
}

async function pausarCampanha(campaignId) {
  const r = await apiRequest('POST', `/api/v1/campaigns/${campaignId}/pause`, null, THREEC_TOKEN());
  if (r.status < 200 || r.status >= 300) {
    const err = new Error(`3cplus pausar: status ${r.status} — ${r.body.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  return r;
}

async function retomarCampanha(campaignId) {
  const r = await apiRequest('POST', `/api/v1/campaigns/${campaignId}/resume`, null, THREEC_TOKEN());
  if (r.status < 200 || r.status >= 300) {
    const err = new Error(`3cplus retomar: status ${r.status} — ${r.body.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  return r;
}

async function encerrarCampanha(campaignId) {
  // 404 = campanha já encerrada/inexistente → trata como sucesso (idempotente)
  const r = await apiRequest('POST', `/api/v1/campaigns/${campaignId}/stop`, null, THREEC_TOKEN());
  if (r.status < 200 || (r.status >= 300 && r.status !== 404)) {
    const err = new Error(`3cplus encerrar: status ${r.status} — ${r.body.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  return r;
}

async function getCallsDaCampanha(campaignId, iniciada_em) {
  const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');
  const start = fmt(new Date(iniciada_em));
  const end = fmt(new Date());
  const params = new URLSearchParams({
    campaign_id: String(campaignId),
    start_date: start,
    end_date: end,
  });
  const r = await apiRequest('GET', `/api/v1/calls?${params}`, null, THREEC_TOKEN());
  if (r.status !== 200) {
    const err = new Error(`3cplus getCallsDaCampanha: status ${r.status}`);
    err.status = 502;
    throw err;
  }
  const parsed = JSON.parse(r.body);
  return Array.isArray(parsed?.data) ? parsed.data : [];
}

// ── Agent token ───────────────────────────────────────────────────────

async function loginCrcNaCampanha(agentToken, campaignId) {
  // Endpoint não confirmado — ajustar se retornar 404
  // Alternativa: POST /api/v1/campaigns/{id}/agents/login
  const r = await apiRequest('POST', `/api/v1/campaigns/${campaignId}/login`, null, agentToken);
  if (r.status < 200 || r.status >= 300) {
    const err = new Error(`3cplus loginCrcNaCampanha: status ${r.status} — ${r.body.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  return r;
}

module.exports = {
  uploadMailing,
  pausarCampanha,
  retomarCampanha,
  encerrarCampanha,
  getCallsDaCampanha,
  loginCrcNaCampanha,
};
```

- [ ] **Step 2: Verificar que `lib/3cplus.js` exporta `apiRequest`**

Abrir `lib/3cplus.js` e confirmar que `module.exports` inclui `apiRequest`. Se não incluir, adicionar ao `module.exports`.

- [ ] **Step 3: Commit**

```bash
git add lib/3cplus-campanhas.js
git commit -m "feat: add 3cplus campaign API module"
```

---

## Task 3: Backend — Preview Endpoint + Helper `buscarContatos`

**Files:**
- Modify: `server.js` (após linha com `const threec = require('./lib/3cplus');` e após endpoint `/api/leads/:id/ligacoes`)

Context: `server.js` já tem `const threec = require('./lib/3cplus')` no topo. O `supabase` client usa service role key (bypass RLS). `requireCrcLead` está definido na linha 201 como `requireRole('crc_leads', 'crc_comercial', 'admin', 'gestor')`. As queries ao Supabase seguem o padrão `const { data, error } = await supabase.from('tabela').select(...)`.

- [ ] **Step 1: Adicionar require do novo módulo no topo de `server.js`**

Localizar a linha `const threec = require('./lib/3cplus');` (está próximo da linha 16) e adicionar logo abaixo:

```js
const threecCamp = require('./lib/3cplus-campanhas');
```

- [ ] **Step 2: Adicionar seção de campanhas após o endpoint `/api/leads/:id/ligacoes`**

Localizar o trecho (próximo da linha 636):
```js
});

app.post('/webhooks/totalvoice', async (req, res) => {
```

Inserir o bloco abaixo entre eles (antes do `app.post('/webhooks/totalvoice'...`):

```js
// ========== CAMPANHAS DE DISCAGEM PREDITIVA ==========

const CAMP_ENV = {
  abc:        'THREEC_CAMPAIGN_ABC',
  indicacoes: 'THREEC_CAMPAIGN_INDICACOES',
  recentes:   'THREEC_CAMPAIGN_RECENTES',
  frios:      'THREEC_CAMPAIGN_FRIOS',
};

const TIPOS_VALIDOS = Object.keys(CAMP_ENV);

async function buscarContatos(tipo) {
  if (tipo === 'abc') {
    const { data, error } = await supabase.from('pacientes_abc')
      .select('nome, telefone, clinicorp_id, dias_sem_visita')
      .in('classe', ['A', 'B'])
      .gte('dias_sem_visita', 180)
      .is('proxima_consulta', null);
    if (error) throw error;
    return (data || []).map(c => ({ ...c, tipo_origem: 'abc' }));
  }
  if (tipo === 'indicacoes') {
    const { data, error } = await supabase.from('leads')
      .select('id, nome, telefone')
      .eq('origem', 'Indicação')
      .not('status', 'in', '("Fechou","Perdido")');
    if (error) throw error;
    return (data || []).map(c => ({ ...c, tipo_origem: 'indicacoes' }));
  }
  if (tipo === 'recentes') {
    const { data, error } = await supabase.from('leads')
      .select('id, nome, telefone')
      .neq('origem', 'Indicação')
      .not('status', 'in', '("Fechou","Perdido")')
      .order('criado_em', { ascending: false })
      .limit(50);
    if (error) throw error;
    return (data || []).map(c => ({ ...c, tipo_origem: 'recentes' }));
  }
  if (tipo === 'frios') {
    const { data, error } = await supabase.from('leads')
      .select('id, nome, telefone')
      .neq('origem', 'Indicação')
      .not('status', 'in', '("Fechou","Perdido")')
      .order('criado_em', { ascending: false })
      .range(50, 150);
    if (error) throw error;
    return (data || []).map(c => ({ ...c, tipo_origem: 'frios' }));
  }
  const err = new Error('Tipo inválido'); err.status = 400; throw err;
}

app.get('/api/campanhas/preview/:tipo', requireAuth, requireCrcLead, async (req, res) => {
  try {
    const { tipo } = req.params;
    if (!TIPOS_VALIDOS.includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });
    const contatos = await buscarContatos(tipo);
    if (req.query.count_only === 'true') return res.json({ total: contatos.length });
    res.json({ total: contatos.length, contatos });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
```

- [ ] **Step 3: Verificar o endpoint com curl**

Fazer git push + deploy primeiro (padrão do projeto):
```bash
git add server.js lib/3cplus-campanhas.js
git commit -m "feat: campaign preview endpoint + buscarContatos helper"
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

Depois testar (substituir `<TOKEN>` pelo JWT do usuário logado, obtido do localStorage no browser):
```bash
curl -s -H "Authorization: Bearer <TOKEN>" \
  "http://2.24.94.120:3000/api/campanhas/preview/abc" | head -c 500

curl -s -H "Authorization: Bearer <TOKEN>" \
  "http://2.24.94.120:3000/api/campanhas/preview/abc?count_only=true"

curl -s -H "Authorization: Bearer <TOKEN>" \
  "http://2.24.94.120:3000/api/campanhas/preview/indicacoes?count_only=true"
```

Esperado: `{"total": N}` para count_only, e `{"total": N, "contatos": [...]}` para preview completo.

---

## Task 4: Backend — Endpoint `POST /api/campanhas/lancar`

**Files:**
- Modify: `server.js` (adicionar após o endpoint preview, dentro da seção campanhas)

Context: O rollback ao falhar o DB insert é chamar `encerrarCampanha()` para não deixar o 3cplus rodando sem registro. `loginCrcNaCampanha` é não-fatal: o `catch` apenas loga um warning. O profile da CRC já foi carregado pelo `requireCrcLead` middleware via `loadProfile(req)` — usar `req.user.profile` diretamente.

- [ ] **Step 1: Adicionar endpoint de lançamento após o endpoint preview**

```js
app.post('/api/campanhas/lancar', requireAuth, requireCrcLead, async (req, res) => {
  try {
    const { tipo } = req.body;
    if (!TIPOS_VALIDOS.includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });

    const envVar = CAMP_ENV[tipo];
    const campaignId = parseInt(process.env[envVar], 10);
    if (!campaignId) {
      return res.status(400).json({ error: `Campanha não configurada. Configure ${envVar} no Easypanel.` });
    }

    const { data: ativas } = await supabase.from('campanhas_discagem')
      .select('id').in('status', ['ativa', 'pausada']).limit(1);
    if (ativas?.length) {
      return res.status(409).json({ error: 'Encerre ou retome e encerre a campanha atual antes de lançar outra.' });
    }

    const contatos = await buscarContatos(tipo);
    const comTelefone = contatos.filter(c => c.telefone?.trim());
    if (!comTelefone.length) {
      return res.status(400).json({ error: 'Nenhum contato encontrado com telefone cadastrado.' });
    }

    await threecCamp.uploadMailing(campaignId, comTelefone.map(c => ({ nome: c.nome, telefone: c.telefone })));

    const { data: campanha, error: dbErr } = await supabase.from('campanhas_discagem').insert({
      tipo,
      threec_campaign_id: campaignId,
      contatos_total: comTelefone.length,
      contatos_json: comTelefone,
      status: 'ativa',
      usuario_id: req.user.id,
    }).select().single();

    if (dbErr) {
      await threecCamp.encerrarCampanha(campaignId).catch(e => console.error('❌ rollback encerrar:', e.message));
      throw dbErr;
    }

    const p = req.user.profile;
    if (p?.threec_agent_token) {
      threecCamp.loginCrcNaCampanha(p.threec_agent_token, campaignId).catch(e => {
        console.warn('⚠️ loginCrcNaCampanha falhou (não-fatal):', e.message);
      });
    } else {
      console.info('ℹ️ CRC sem threec_agent_token — loginCrcNaCampanha ignorado');
    }

    res.json({ ok: true, campanha: { id: campanha.id, tipo: campanha.tipo, contatos_total: campanha.contatos_total } });
  } catch (e) {
    console.error('❌ campanhas/lancar:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Commit + deploy + testar**

```bash
git add server.js
git commit -m "feat: add campaign launch endpoint"
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

Testar (sem THREEC_CAMPAIGN_ABC configurado deve retornar 400):
```bash
curl -s -X POST "http://2.24.94.120:3000/api/campanhas/lancar" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"tipo":"abc"}'
```

Esperado: `{"error":"Campanha não configurada. Configure THREEC_CAMPAIGN_ABC no Easypanel."}` (400)

---

## Task 5: Backend — Endpoints de Controle + Status

**Files:**
- Modify: `server.js` (adicionar após o endpoint lancar)

Context: Pausar valida `status === 'ativa'`, retomar valida `status === 'pausada'`. Encerrar funciona em qualquer status (idempotente). O endpoint resultado usa `getCallsDaCampanha` que filtra por `campaign_id` desde `iniciada_em`. `status_id === 7` = atendida.

- [ ] **Step 1: Adicionar endpoints pausar, retomar, encerrar, ativa, resultado**

```js
app.post('/api/campanhas/:id/pausar', requireAuth, requireCrcLead, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data: campanha } = await supabase.from('campanhas_discagem').select('*').eq('id', id).maybeSingle();
    if (!campanha) return res.status(404).json({ error: 'Campanha não encontrada' });
    if (campanha.status !== 'ativa') return res.status(400).json({ error: `Campanha não está ativa (status atual: ${campanha.status})` });
    await threecCamp.pausarCampanha(campanha.threec_campaign_id);
    await supabase.from('campanhas_discagem').update({ status: 'pausada', pausada_em: new Date().toISOString() }).eq('id', id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/campanhas/:id/retomar', requireAuth, requireCrcLead, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data: campanha } = await supabase.from('campanhas_discagem').select('*').eq('id', id).maybeSingle();
    if (!campanha) return res.status(404).json({ error: 'Campanha não encontrada' });
    if (campanha.status !== 'pausada') return res.status(400).json({ error: `Campanha não está pausada (status atual: ${campanha.status})` });
    await threecCamp.retomarCampanha(campanha.threec_campaign_id);
    await supabase.from('campanhas_discagem').update({ status: 'ativa', pausada_em: null }).eq('id', id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/campanhas/:id/encerrar', requireAuth, requireCrcLead, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data: campanha } = await supabase.from('campanhas_discagem').select('threec_campaign_id').eq('id', id).maybeSingle();
    if (!campanha) return res.status(404).json({ error: 'Campanha não encontrada' });
    await threecCamp.encerrarCampanha(campanha.threec_campaign_id);
    await supabase.from('campanhas_discagem').update({ status: 'encerrada', encerrada_em: new Date().toISOString() }).eq('id', id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/campanhas/ativa', requireAuth, requireCrcLead, async (req, res) => {
  try {
    const { data: campanha } = await supabase.from('campanhas_discagem')
      .select('id, tipo, status, contatos_total, iniciada_em, pausada_em')
      .in('status', ['ativa', 'pausada'])
      .order('iniciada_em', { ascending: false })
      .limit(1)
      .maybeSingle();
    res.json({ campanha: campanha || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/campanhas/:id/resultado', requireAuth, requireCrcLead, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data: campanha } = await supabase.from('campanhas_discagem')
      .select('threec_campaign_id, contatos_total, iniciada_em').eq('id', id).maybeSingle();
    if (!campanha) return res.status(404).json({ error: 'Campanha não encontrada' });
    const calls = await threecCamp.getCallsDaCampanha(campanha.threec_campaign_id, campanha.iniciada_em);
    const atendidas = calls.filter(c => c.status_id === 7).length;
    const nao_atendeu = calls.filter(c => c.status_id !== 7).length;
    const na_fila = Math.max(0, campanha.contatos_total - atendidas - nao_atendeu);
    res.json({ atendidas, nao_atendeu, na_fila });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Commit + deploy + testar ativa (deve retornar null se nenhuma campanha)**

```bash
git add server.js
git commit -m "feat: add campaign control and status endpoints"
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

```bash
curl -s -H "Authorization: Bearer <TOKEN>" "http://2.24.94.120:3000/api/campanhas/ativa"
```

Esperado: `{"campanha":null}`

---

## Task 6: `public/js/campanha-widget.js` — Widget Compartilhado

**Files:**
- Create: `public/js/campanha-widget.js`

Context: Este arquivo é carregado como script não-modular (`<script src="/js/campanha-widget.js">`). Ele funciona em qualquer página porque extrai o JWT do localStorage (chave com padrão `sb-*-auth-token`) sem depender de globals externos. O widget injeta seu HTML em `<div id="campanha-widget-mount">` que existirá em cada página. Ao lançar uma campanha com sucesso, o código de chamada chama `window.campanhaWidgetRefresh()` para atualizar o painel.

Nomes dos tipos em português para exibir no painel:
- `abc` → "Retorno ABC"
- `indicacoes` → "Leads Indicações"
- `recentes` → "Leads Recentes"
- `frios` → "Leads Frios"

- [ ] **Step 1: Criar `public/js/campanha-widget.js`**

```js
(function () {
  'use strict';

  var _campanhaAtiva = null;
  var _pollTimer = null;

  var TIPO_LABEL = {
    abc: 'Retorno ABC',
    indicacoes: 'Leads Indicações',
    recentes: 'Leads Recentes',
    frios: 'Leads Frios',
  };

  function _getToken() {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) {
        try { return JSON.parse(localStorage.getItem(k)).access_token || null; }
        catch (e) { return null; }
      }
    }
    return null;
  }

  async function cw_api(method, path, body) {
    var token = _getToken();
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (body) opts.body = JSON.stringify(body);
    var r = await fetch(path, opts);
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(data.error || 'Erro ' + r.status);
    return data;
  }

  function _mount() {
    return document.getElementById('campanha-widget-mount');
  }

  function _toast(msg, tipo) {
    var el = document.createElement('div');
    el.style.cssText = [
      'position:fixed;bottom:80px;right:20px;z-index:9999',
      'padding:10px 16px;border-radius:8px;font-size:13px;max-width:340px',
      'color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.2)',
      'background:' + (tipo === 'error' ? '#e53e3e' : tipo === 'warning' ? '#d69e2e' : '#38a169'),
    ].join(';');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }

  function _renderPanel(campanha, resultado) {
    var mount = _mount();
    if (!mount) return;
    var label = TIPO_LABEL[campanha.tipo] || campanha.tipo;
    var hora = campanha.iniciada_em
      ? new Date(campanha.iniciada_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      : '—';
    var atendidas = resultado ? resultado.atendidas : '—';
    var naoAtendeu = resultado ? resultado.nao_atendeu : '—';
    var naFila = resultado ? resultado.na_fila : '—';
    var isPausada = campanha.status === 'pausada';

    mount.innerHTML =
      '<div id="cw-panel" style="' +
        'background:var(--color-surface,#fff);border:1px solid var(--color-border,#e2e8f0);' +
        'border-radius:12px;padding:14px 18px;margin-bottom:16px;' +
        'display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.06)">' +
        '<div style="display:flex;align-items:center;gap:10px;flex:1;min-width:280px">' +
          '<span style="font-size:18px">' + (isPausada ? '⏸' : '🔵') + '</span>' +
          '<div>' +
            '<div style="font-weight:600;font-size:14px">' +
              (isPausada ? 'Pausada' : 'Campanha ativa') + ': ' + label +
            '</div>' +
            '<div style="font-size:12px;color:var(--color-text-muted,#718096);margin-top:2px">' +
              'Enviados: ' + campanha.contatos_total +
              ' · Atendidos: ' + atendidas +
              ' · Não atendeu: ' + naoAtendeu +
              ' · Fila: ' + naFila +
              ' · Iniciada ' + hora +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px">' +
          (isPausada
            ? '<button onclick="campanhaWidgetRetomar()" style="' + _btnStyle('#48bb78') + '">▶ Retomar</button>'
            : '<button onclick="campanhaWidgetPausar()" style="' + _btnStyle('#718096') + '">⏸ Pausar</button>') +
          '<button onclick="campanhaWidgetEncerrar()" style="' + _btnStyle('#fc8181') + '">⏹ Encerrar</button>' +
        '</div>' +
      '</div>';
  }

  function _btnStyle(bg) {
    return 'background:' + bg + ';color:#fff;border:none;border-radius:6px;' +
      'padding:6px 12px;font-size:12px;cursor:pointer;font-weight:500';
  }

  function _hidePanel() {
    var mount = _mount();
    if (mount) mount.innerHTML = '';
  }

  async function _fetchResultado(campanhaId) {
    try {
      return await cw_api('GET', '/api/campanhas/' + campanhaId + '/resultado');
    } catch (e) {
      console.warn('cw resultado:', e.message);
      return null;
    }
  }

  async function _poll() {
    if (!_campanhaAtiva) return;
    var resultado = await _fetchResultado(_campanhaAtiva.id);
    if (!resultado) return;
    if (resultado.na_fila <= 0 && _campanhaAtiva.status === 'ativa') {
      try { await cw_api('POST', '/api/campanhas/' + _campanhaAtiva.id + '/encerrar'); } catch (e) {}
      _toast(
        'Campanha encerrada. ' + resultado.atendidas + ' atendidos, ' + resultado.nao_atendeu + ' não atenderam.',
        'success'
      );
      _campanhaAtiva = null;
      clearInterval(_pollTimer);
      _pollTimer = null;
      _hidePanel();
      return;
    }
    _renderPanel(_campanhaAtiva, resultado);
  }

  function _startPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(_poll, 60000);
  }

  async function _init() {
    try {
      var data = await cw_api('GET', '/api/campanhas/ativa');
      if (!data.campanha) { _hidePanel(); return; }
      _campanhaAtiva = data.campanha;
      var resultado = await _fetchResultado(_campanhaAtiva.id);
      _renderPanel(_campanhaAtiva, resultado);
      _startPolling();
    } catch (e) {
      console.warn('cw init:', e.message);
    }
  }

  window.campanhaWidgetRefresh = function () { _init(); };

  window.campanhaWidgetPausar = async function () {
    if (!_campanhaAtiva) return;
    try {
      await cw_api('POST', '/api/campanhas/' + _campanhaAtiva.id + '/pausar');
      _campanhaAtiva.status = 'pausada';
      _renderPanel(_campanhaAtiva, null);
    } catch (e) { _toast(e.message, 'error'); }
  };

  window.campanhaWidgetRetomar = async function () {
    if (!_campanhaAtiva) return;
    try {
      await cw_api('POST', '/api/campanhas/' + _campanhaAtiva.id + '/retomar');
      _campanhaAtiva.status = 'ativa';
      _renderPanel(_campanhaAtiva, null);
    } catch (e) { _toast(e.message, 'error'); }
  };

  window.campanhaWidgetEncerrar = async function () {
    if (!_campanhaAtiva) return;
    if (!confirm('Encerrar campanha? Os contatos restantes não serão discados.')) return;
    try {
      await cw_api('POST', '/api/campanhas/' + _campanhaAtiva.id + '/encerrar');
      _toast('Campanha encerrada.', 'success');
      _campanhaAtiva = null;
      clearInterval(_pollTimer);
      _pollTimer = null;
      _hidePanel();
    } catch (e) { _toast(e.message, 'error'); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
```

- [ ] **Step 2: Commit**

```bash
git add public/js/campanha-widget.js
git commit -m "feat: add shared campanha-widget.js component"
```

---

## Task 7: Curva ABC — Botão + Modal + Widget

**Files:**
- Modify: `public/pos-tratamento/curva-abc.html`
- Modify: `public/js/pos-tratamento/curva-abc.js`

Context: `curva-abc.html` carrega `nav.js` (não-módulo) e `curva-abc.js` (ES module com `type="module"`). O widget deve ser carregado como script não-módulo antes do `curva-abc.js`. `curva-abc.js` usa `toast` importado de `./shared.js`. Para chamadas ao backend, precisa de um helper local `backendApi()` que extrai o JWT do cliente Supabase (`sb.auth.getSession()`). A função `lancarCampanhaABC` é exposta em `window` para ser chamada pelo `onclick` do botão. O modal usa as classes CSS existentes: `.modal-overlay` e `.modal` (definidas em `pos-tratamento.css`).

- [ ] **Step 1: Adicionar mount div, botão e script do widget em `curva-abc.html`**

Localizar em `curva-abc.html` a linha:
```html
        <div class="abc-list-section">
```

Inserir antes dela:
```html
        <div id="campanha-widget-mount"></div>
        <div style="margin-bottom:16px">
          <button class="btn btn--success" id="btn-campanha-abc" onclick="lancarCampanhaABC()">
            📞 Enviar para Discagem
          </button>
        </div>
```

Localizar ao final do `<body>`:
```html
  <script src="/js/pos-tratamento/nav.js"></script>
  <script type="module" src="/js/pos-tratamento/curva-abc.js"></script>
```

Adicionar o script do widget entre os dois:
```html
  <script src="/js/pos-tratamento/nav.js"></script>
  <script src="/js/campanha-widget.js"></script>
  <script type="module" src="/js/pos-tratamento/curva-abc.js"></script>
```

- [ ] **Step 2: Adicionar `backendApi` e `lancarCampanhaABC` em `curva-abc.js`**

Ao final de `curva-abc.js`, adicionar:

```js
async function backendApi(method, path, body) {
  const { data: { session } } = await sb.auth.getSession();
  const r = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: 'Bearer ' + session.access_token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Erro ' + r.status);
  return data;
}

async function lancarCampanhaABC() {
  try {
    const preview = await backendApi('GET', '/api/campanhas/preview/abc');
    if (!preview.total) {
      toast('Nenhum paciente encontrado com os critérios (Classe A/B, 180+ dias sem retorno, sem agenda).', 'error');
      return;
    }
    _abrirModalCampanha('abc', preview);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function _abrirModalCampanha(tipo, preview) {
  const LABELS = {
    abc: { titulo: 'Retorno ABC', sub: 'Classe A/B · Sem consulta há 180+ dias · Sem agenda' },
    indicacoes: { titulo: 'Leads Indicações', sub: 'Leads com origem = indicação · Status ativo' },
    recentes: { titulo: 'Leads Recentes', sub: 'Últimos 50 leads (não-indicação)' },
    frios: { titulo: 'Leads Frios', sub: 'Leads do 51º ao 151º (não-indicação)' },
  };
  const { titulo, sub } = LABELS[tipo] || { titulo: tipo, sub: '' };

  const cols = tipo === 'abc'
    ? ['nome', 'telefone', 'dias_sem_visita']
    : ['nome', 'telefone'];
  const colLabels = tipo === 'abc'
    ? ['Nome', 'Telefone', 'Dias sem retorno']
    : ['Nome', 'Telefone'];

  const rows = (preview.contatos || []).slice(0, 20).map(c =>
    '<tr>' + cols.map(k => `<td style="padding:6px 8px;border-bottom:1px solid var(--color-border,#e2e8f0);font-size:13px">${c[k] || '—'}</td>`).join('') + '</tr>'
  ).join('');
  const extra = preview.total > 20
    ? `<tr><td colspan="${cols.length}" style="padding:6px 8px;color:var(--color-text-muted,#718096);font-size:12px">... e mais ${preview.total - 20} contatos</td></tr>`
    : '';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:560px;max-height:80vh;display:flex;flex-direction:column">
      <h3 class="modal__title">${titulo} — ${preview.total} contatos</h3>
      <p style="font-size:13px;color:var(--color-text-muted,#718096);margin:0 0 12px">${sub}</p>
      <div style="overflow-y:auto;flex:1;border:1px solid var(--color-border,#e2e8f0);border-radius:8px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>${colLabels.map(l => `<th style="padding:8px;text-align:left;font-size:12px;background:var(--color-surface-alt,#f7fafc);border-bottom:2px solid var(--color-border,#e2e8f0)">${l}</th>`).join('')}</tr></thead>
          <tbody>${rows}${extra}</tbody>
        </table>
      </div>
      <div class="modal__actions" style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
        <button id="cmp-cancelar" class="btn btn--ghost">Cancelar</button>
        <button id="cmp-confirmar" class="btn btn--success">📞 Enviar para discagem</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  document.getElementById('cmp-cancelar').onclick = () => overlay.remove();
  document.getElementById('cmp-confirmar').onclick = async () => {
    const btn = document.getElementById('cmp-confirmar');
    btn.disabled = true; btn.textContent = 'Enviando...';
    try {
      await backendApi('POST', '/api/campanhas/lancar', { tipo });
      overlay.remove();
      toast(`Campanha iniciada! ${preview.total} contatos na fila de discagem.`);
      if (window.campanhaWidgetRefresh) window.campanhaWidgetRefresh();
    } catch (e) {
      btn.disabled = false; btn.textContent = '📞 Enviar para discagem';
      toast(e.message, 'error');
    }
  };
}

window.lancarCampanhaABC = lancarCampanhaABC;
```

- [ ] **Step 3: Commit + deploy + testar no browser**

```bash
git add public/pos-tratamento/curva-abc.html public/js/pos-tratamento/curva-abc.js
git commit -m "feat: add campaign button and modal to curva-abc"
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

Verificar no browser:
1. Abrir Curva ABC como usuário `crc_leads`
2. Botão "📞 Enviar para Discagem" aparece
3. Clicar → modal de preview abre com lista de pacientes
4. Cancelar fecha o modal sem lançar

---

## Task 8: Leads (index.html) — Botões de Campanha + Modal + Widget

**Files:**
- Modify: `public/index.html`

Context: `index.html` tem `async function api(url, opts={})` definida globalmente (linha ~1505) que já inclui autenticação via `_sbSession`. Usar `api()` diretamente nos botões de campanha (não precisa de `backendApi`). O modal pode reusar a função `_abrirModalCampanhaLeads` definida inline. A tabela de leads fica após `<div style="display:flex;...">` que contém o search + filtros (linha ~620). Adicionar os botões de campanha entre os filtros e a tabela.

- [ ] **Step 1: Adicionar mount div e botões de campanha antes da tabela de leads**

Em `index.html`, localizar:
```html
    <table>
      <thead><tr><th>ID</th><th>Nome</th>...
```

Inserir antes dessa linha:
```html
    <div id="campanha-widget-mount" style="margin-bottom:4px"></div>
    <div id="campanha-leads-btns" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <button class="btn btn-secondary" style="font-size:12.5px" onclick="lancarCampanha('indicacoes')">📞 Indicações (<span id="cnt-indicacoes">...</span>)</button>
      <button class="btn btn-secondary" style="font-size:12.5px" onclick="lancarCampanha('recentes')">📞 Recentes — 50</button>
      <button class="btn btn-secondary" style="font-size:12.5px" onclick="lancarCampanha('frios')">📞 Frios — 51 a 151</button>
    </div>
```

- [ ] **Step 2: Adicionar script do widget antes do `</body>`**

Localizar próximo ao final do `<body>` o bloco de `<script>` existente. Adicionar o script do widget antes do fechamento do body (se houver outros scripts inline, adicionar antes deles):

```html
<script src="/js/campanha-widget.js"></script>
```

- [ ] **Step 3: Adicionar funções `lancarCampanha` e `_abrirModalCampanhaLeads` no bloco `<script>` de `index.html`**

No bloco `<script>` principal do `index.html`, adicionar as funções (pode ser ao final do bloco, antes do `</script>`):

```js
const CAMP_LABELS = {
  indicacoes: { titulo: 'Leads Indicações', sub: 'Leads com origem = indicação · Status ativo' },
  recentes:   { titulo: 'Leads Recentes', sub: 'Últimos 50 leads (não-indicação)' },
  frios:      { titulo: 'Leads Frios', sub: 'Leads do 51º ao 151º (não-indicação)' },
};

async function lancarCampanha(tipo) {
  try {
    const preview = await api('/api/campanhas/preview/' + tipo);
    if (!preview.total) {
      toast('Nenhum lead encontrado para esta campanha.', true);
      return;
    }
    _abrirModalCampanhaLeads(tipo, preview);
  } catch (e) {
    toast(e.message || 'Erro ao carregar preview.', true);
  }
}

function _abrirModalCampanhaLeads(tipo, preview) {
  const { titulo, sub } = CAMP_LABELS[tipo] || { titulo: tipo, sub: '' };
  const rows = (preview.contatos || []).slice(0, 20).map(c =>
    `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid var(--border);font-size:13px">${c.nome || '—'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid var(--border);font-size:13px">${c.telefone || '—'}</td>
    </tr>`
  ).join('');
  const extra = preview.total > 20
    ? `<tr><td colspan="2" style="padding:6px 10px;color:var(--muted);font-size:12px">... e mais ${preview.total - 20} leads</td></tr>`
    : '';

  const bg = document.createElement('div');
  bg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:2000';
  bg.innerHTML = `
    <div class="modal" style="max-width:480px;max-height:80vh;display:flex;flex-direction:column">
      <div class="modal-header">
        <span class="modal-titulo">${titulo} — ${preview.total} leads</span>
        <button class="modal-close" id="cml-close">×</button>
      </div>
      <p style="font-size:12px;color:var(--muted);margin:0 0 12px">${sub}</p>
      <div style="overflow-y:auto;flex:1;border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="padding:8px 10px;text-align:left;font-size:12px;background:#f7fafc;border-bottom:2px solid var(--border)">Nome</th>
            <th style="padding:8px 10px;text-align:left;font-size:12px;background:#f7fafc;border-bottom:2px solid var(--border)">Telefone</th>
          </tr></thead>
          <tbody>${rows}${extra}</tbody>
        </table>
      </div>
      <div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
        <button id="cml-cancelar" class="btn" style="background:#edf2f7;color:#4a5568">Cancelar</button>
        <button id="cml-confirmar" class="btn btn-primary">📞 Enviar para discagem</button>
      </div>
    </div>`;
  document.body.appendChild(bg);

  bg.querySelector('#cml-close').onclick = () => bg.remove();
  bg.querySelector('#cml-cancelar').onclick = () => bg.remove();
  bg.querySelector('#cml-confirmar').onclick = async () => {
    const btn = bg.querySelector('#cml-confirmar');
    btn.disabled = true; btn.textContent = 'Enviando...';
    try {
      await api('/api/campanhas/lancar', { method: 'POST', body: JSON.stringify({ tipo }) });
      bg.remove();
      showToast('Campanha iniciada! ' + preview.total + ' leads na fila de discagem.');
      if (window.campanhaWidgetRefresh) window.campanhaWidgetRefresh();
    } catch (e) {
      btn.disabled = false; btn.textContent = '📞 Enviar para discagem';
      toast(e.message || 'Erro ao lançar campanha.', true);
    }
  };
}
```

- [ ] **Step 4: Carregar contagem de indicações ao ativar módulo leads**

Em `index.html`, localizar a linha (próximo da linha 1491):
```js
  if (p === 'leads') loadLeads();
```

Substituir por:
```js
  if (p === 'leads') {
    loadLeads();
    api('/api/campanhas/preview/indicacoes?count_only=true').then(d => {
      const span = document.getElementById('cnt-indicacoes');
      if (span) span.textContent = d.total;
    }).catch(() => {});
  }
```

- [ ] **Step 6: Commit + deploy + testar no browser**

```bash
git add public/index.html
git commit -m "feat: add campaign buttons and modal to leads module"
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

Verificar no browser como usuário `crc_leads`:
1. Módulo Leads → 3 botões de campanha aparecem acima da tabela
2. Contador "Indicações (N)" carrega com a contagem real
3. Clicar qualquer botão → modal de preview abre
4. Cancelar fecha o modal
5. Curva ABC → painel de campanha ativa aparece (se houver campanha ativa)

---

## Notas de Implementação

**Env vars necessárias (configurar no Easypanel após criar as campanhas no painel 3cplus):**
```
THREEC_CAMPAIGN_ABC=<ID numérico>
THREEC_CAMPAIGN_INDICACOES=<ID numérico>
THREEC_CAMPAIGN_RECENTES=<ID numérico>
THREEC_CAMPAIGN_FRIOS=<ID numérico>
```

**Endpoints 3cplus não confirmados (testar via curl com THREEC_TOKEN antes de considerar ok):**
- `POST /api/v1/campaigns/{id}/mailing` — upload de mailing
- `POST /api/v1/campaigns/{id}/pause` — pausar
- `POST /api/v1/campaigns/{id}/resume` — retomar
- `POST /api/v1/campaigns/{id}/stop` — encerrar
- `POST /api/v1/campaigns/{id}/login` — logar CRC (agent token)

Se algum retornar 404, buscar o endpoint correto na documentação da 3cplus e ajustar em `lib/3cplus-campanhas.js`.

**Token de teste:**
Para testar endpoints via curl, obter o JWT do browser: DevTools → Application → Local Storage → chave `sb-mtqdpjhhqzvuklnlfpvi-auth-token` → campo `access_token`.
