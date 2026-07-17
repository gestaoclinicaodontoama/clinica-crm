# Templates por WABA/número (2873 × 8700) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cada template do CRM passa a saber de qual número/WABA ele é (2873 ou 8700); o chat do CRC mostra e envia só templates da conta da conversa, os Disparos só da conta do número escolhido, e o histórico do lead mostra o template recebido de forma legível.

**Architecture:** Migração adiciona `templates.wa_number_id` + backfill de `leads.wa_number_id`; o `sync-meta` passa a varrer todas as WABAs visíveis pelos tokens (token que descobriu a WABA é o token usado nela); filtros no front por número da conversa/campanha; checagem de aprovação no back escopada por número. Regra transitória: enquanto um template legado tiver `wa_number_id = ''` (pré-sync), ele continua aparecendo/valendo em todas as telas — o primeiro sync o adota para a conta certa e o transitório desaparece sozinho.

**Tech Stack:** Node/Express (`server.js`), HTML/JS vanilla (`public/index.html`), Supabase Postgres (migração via MCP), Meta Graph API v21.0.

**Spec:** `docs/superpowers/specs/2026-07-17-templates-por-waba-design.md`

## Global Constraints

- Working dir compartilhado com outras sessões: implementar num **worktree isolado de `origin/main`** (`git worktree add -b waba-templates ../_wt_waba origin/main`), nunca na checkout principal. Antes do 1º commit conferir `git rev-parse --show-toplevel` termina em `_wt_waba`.
- Copiar para o worktree os 2 docs (spec deste plano e o próprio plano) a partir da checkout principal antes do commit final, para viajarem juntos no push.
- Sem framework de teste de rotas HTTP no projeto (`node --test` só cobre `lib/**`); as mudanças em `server.js`/`index.html` são verificadas por `npm test` (regressão) + validação manual/SQL do passo final. Não criar framework novo (YAGNI).
- Migração segue a regra de segurança do `CLAUDE.md`: RLS de `templates` permanece ligado; nenhum grant novo a `anon`/`authenticated`.
- Deploy: `git push origin HEAD:main` do worktree (fetch antes; nunca force) → `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`.
- Erro padrão de conversa sem número (copiar verbatim): `Não foi possível identificar o número desta conversa. Fale com o suporte.`

---

### Task 1: Migração — `templates.wa_number_id`, unicidade composta, backfill de `leads.wa_number_id`

**Files:**
- Create: `supabase/migrations/20260717150000_templates_wa_number_id.sql` (no worktree)
- Aplicar via MCP Supabase `apply_migration` (project `mtqdpjhhqzvuklnlfpvi`)

**Interfaces:**
- Produces: coluna `templates.wa_number_id text not null default ''`; índice único `templates_nome_wa_number_uniq (nome, wa_number_id)`; `leads.wa_number_id` preenchido para ~101 leads.

- [ ] **Step 1: Escrever a migração**

```sql
-- Templates por WABA/número: cada template pertence a um número (2873/8700).
-- '' = legado ainda não associado (o sync-meta adota na primeira rodada).
alter table public.templates add column if not exists wa_number_id text not null default '';

-- nome deixa de ser único global (o mesmo nome pode existir nas duas WABAs)
alter table public.templates drop constraint if exists templates_nome_key;
create unique index if not exists templates_nome_wa_number_uniq
  on public.templates (nome, wa_number_id);

-- Backfill leads.wa_number_id: o número "da conversa" é onde o lead FALA —
-- prioriza mensagens recebidas (um disparo enviado via 8700 não pode virar o número do lead)
update public.leads l set wa_number_id = sub.wa_number_id
from (
  select distinct on (lead_id) lead_id, wa_number_id
  from public.mensagens
  where wa_number_id is not null and wa_number_id <> ''
  order by lead_id, (direcao = 'recebida') desc, id desc
) sub
where l.id = sub.lead_id and (l.wa_number_id is null or l.wa_number_id = '');
```

- [ ] **Step 2: Aplicar via MCP** (`apply_migration`, name `templates_wa_number_id`) e conferir com `list_migrations` que entrou.

- [ ] **Step 3: Verificar no banco**

```sql
select count(*) filter (where wa_number_id = '') as legados from templates;
select count(*) from leads where (wa_number_id is null or wa_number_id = '')
  and id in (select distinct lead_id from mensagens where lead_id is not null);
select indexdef from pg_indexes where tablename='templates' and indexname='templates_nome_wa_number_uniq';
```
Esperado: `legados` = total atual de templates (14); leads sem número com conversa ≈ 19; índice existe.

- [ ] **Step 4: Commit** (`git add supabase/migrations/... && git commit -m "feat: coluna wa_number_id em templates + backfill do número da conversa nos leads"`)

---

### Task 2: Backend — aprovação por número, consultas robustas a nome duplicado, rota `/whatsapp` alinhada

**Files:**
- Modify: `server.js:1504-1510` (`templateAprovado`), `server.js:1556` e `server.js:1718-1730` (chamadas), `server.js:2554-2567` (`GET /api/templates` env-merge), `server.js:2576` (dup-check), `server.js:2194-2222` (rota `/api/leads/:id/whatsapp`)

**Interfaces:**
- Produces: `templateAprovado(nome, waNumberId)` — aceita legado `''` como válido para qualquer número (transitório); `GET /api/templates` retorna itens de env com `wa_number_id` do broadcast.

- [ ] **Step 1: `templateAprovado` escopado por número (com tolerância a legado)**

Substituir (linhas 1504-1510):
```js
// Confirma que um template está aprovado (db status 'aprovado' ou allow-list de env).
async function templateAprovado(nome) {
  const envNames = (process.env.WA_TEMPLATES || '').split(',').map(t => t.trim()).filter(Boolean);
  if (envNames.includes(nome)) return true;
  const { data } = await supabase.from('templates').select('status').eq('nome', nome).maybeSingle();
  return !!data && data.status === 'aprovado';
}
```
por:
```js
// Confirma que um template está aprovado (db 'aprovado' ou allow-list de env) PARA um número.
// Templates legados (wa_number_id='') valem para qualquer número até o sync adotá-los.
async function templateAprovado(nome, waNumberId) {
  const envNames = (process.env.WA_TEMPLATES || '').split(',').map(t => t.trim()).filter(Boolean);
  if (envNames.includes(nome)) return true;
  const { data } = await supabase.from('templates').select('status')
    .eq('nome', nome).in('wa_number_id', [waNumberId || '', '']);
  return (data || []).some(t => t.status === 'aprovado');
}
```

- [ ] **Step 2: Chamada em `/api/disparos/criar`** — linha 1556: trocar
`if (!(await templateAprovado(template_nome)))` por `if (!(await templateAprovado(template_nome, wa_number_id)))` (a variável `wa_number_id` já está resolvida nas linhas 1548-1553, acima da checagem).

- [ ] **Step 3: Chamada em `/api/publicos/disparar`** — o número só é resolvido DEPOIS da checagem (linhas 1724 vs 1727-1730). Reordenar: mover o bloco de resolução de número (linhas 1726-1730, comentário incluído) para antes da checagem, e trocar a chamada:
```js
    if (!nome) return res.status(400).json({ error: 'Nome da campanha obrigatório' });
    if (!template_nome) return res.status(400).json({ error: 'Template obrigatório' });

    // Número: ausente = default (2873); presente precisa ter token.
    const sendable = await whatsapp.getPhoneNumbers();
    let wa_number_id = sanitizeStr(req.body.wa_number_id || '', 50);
    if (!wa_number_id) wa_number_id = whatsapp.defaultPhoneId() || '';
    else if (!sendable[wa_number_id]) return res.status(400).json({ error: 'Número sem credencial de envio configurada' });

    if (!(await templateAprovado(template_nome, wa_number_id))) return res.status(400).json({ error: 'Template não aprovado pela Meta' });
```

- [ ] **Step 4: env-merge do `GET /api/templates` com número do broadcast** — linha ~2562, trocar:
```js
    const envObjs = envNames
      .filter(n => !(dbTpls || []).find(t => t.nome === n))
      .map(n => ({ id: null, nome: n, titulo: n, corpo: '', categoria: 'MARKETING', status: 'aprovado' }));
```
por:
```js
    const envObjs = envNames
      .filter(n => !(dbTpls || []).find(t => t.nome === n))
      .map(n => ({ id: null, nome: n, titulo: n, corpo: '', categoria: 'MARKETING', status: 'aprovado', wa_number_id: whatsapp.broadcastPhoneId() || '' }));
```

- [ ] **Step 5: dup-check do `POST /api/templates`** — linha 2576, trocar:
```js
    const { data: dup } = await supabase.from('templates').select('id').eq('nome', nomeLimpo).maybeSingle();
```
por:
```js
    const { data: dupRows } = await supabase.from('templates').select('id').eq('nome', nomeLimpo).limit(1);
    const dup = dupRows && dupRows[0];
```
(a linha seguinte que usa `dup` permanece igual.)

- [ ] **Step 6: Rota `/api/leads/:id/whatsapp` — braço de template pelo número da conversa**

Trocar (linhas ~2193-2205):
```js
    // Política fixa (decisão do gestor): conversa livre SEMPRE pelo número SDR
    // (2873); template SEMPRE pelo número de disparos (8700). O cliente não escolhe.
    const sdrPhoneId = whatsapp.defaultPhoneId() || '';
    if (templateName) {
      resultado = await whatsapp.enviarTemplate({ para: lead.telefone, templateName, variaveis });
    } else {
      if (!(await janela24hAberta(lead.id))) return res.status(400).json({ error: MSG_JANELA_FECHADA });
      const contextWaId = reply_wa_id ? sanitizeStr(reply_wa_id, 500) : null;
      resultado = await whatsapp.enviarTexto({ para: lead.telefone, texto, phoneNumberId: sdrPhoneId, contextWaId });
    }
    const sentPhoneId = templateName ? (whatsapp.broadcastPhoneId() || '') : sdrPhoneId;
```
por:
```js
    // Conversa livre pelo número SDR; template pelo número da PRÓPRIA conversa
    // (mesma regra do /broadcast — template de outra WABA a Meta rejeita).
    const sdrPhoneId = whatsapp.defaultPhoneId() || '';
    if (templateName) {
      if (!lead.wa_number_id) return res.status(400).json({ error: 'Não foi possível identificar o número desta conversa. Fale com o suporte.' });
      resultado = await whatsapp.enviarTemplate({ para: lead.telefone, templateName, variaveis, phoneNumberId: lead.wa_number_id });
    } else {
      if (!(await janela24hAberta(lead.id))) return res.status(400).json({ error: MSG_JANELA_FECHADA });
      const contextWaId = reply_wa_id ? sanitizeStr(reply_wa_id, 500) : null;
      resultado = await whatsapp.enviarTexto({ para: lead.telefone, texto, phoneNumberId: sdrPhoneId, contextWaId });
    }
    const sentPhoneId = templateName ? lead.wa_number_id : sdrPhoneId;
```

- [ ] **Step 7: Lookup de categoria escopado** — linha ~2215, trocar:
```js
      supabase.from('templates').select('categoria').eq('nome', templateName).maybeSingle()
        .then(({ data: tpl }) => {
```
por:
```js
      supabase.from('templates').select('categoria').eq('nome', templateName)
        .in('wa_number_id', [lead.wa_number_id || '', '']).limit(1)
        .then(({ data: tplRows }) => { const tpl = tplRows && tplRows[0];
```
(o corpo do `.then` que usa `tpl?.categoria` permanece igual.)

- [ ] **Step 8: `npm test`** — Esperado: mesmas falhas pré-existentes de `lib/monitor/crc.test.js` e `lib/nfse/assinar.test.js`, nenhuma nova.

- [ ] **Step 9: Commit** — `git commit -m "feat: aprovação de template escopada por número + rota /whatsapp envia template pelo número da conversa"`

---

### Task 3: Backend — `sync-meta` multi-WABA

**Files:**
- Modify: `server.js:2663-2728` (rota `POST /api/templates/sync-meta` inteira)

**Interfaces:**
- Consumes: tokens de env (`META_ACCESS_TOKEN`, `WHATSAPP_BROADCAST_TOKEN`, `WHATSAPP_API_TOKEN`, `WHATSAPP_CLOUD_TOKEN`), `whatsapp.broadcastPhoneId()`, const `WA_BUSINESS_ACCOUNT_ID` já existente no arquivo.
- Produces: resposta `{ ok, atualizados, importados, contas, total_meta }` (o front usa `atualizados`; campo novo `contas` é informativo).

- [ ] **Step 1: Substituir o corpo da rota** (mantendo `app.post('/api/templates/sync-meta', requireAuth, rateLimit, async (req, res) => { try {` e o `catch` externo):

```js
    const tokens = [...new Set([
      process.env.META_ACCESS_TOKEN,
      process.env.WHATSAPP_BROADCAST_TOKEN,
      process.env.WHATSAPP_API_TOKEN,
      process.env.WHATSAPP_CLOUD_TOKEN,
    ].filter(Boolean))];
    if (!tokens.length) return res.status(503).json({ error: 'Nenhum token Meta configurado' });

    // 1) Descobre as WABAs visíveis por cada token — e LEMBRA qual token enxergou
    //    cada uma (um token de uma conta não necessariamente acessa a outra).
    const wabas = new Map(); // wabaId -> token
    for (const tok of tokens) {
      try {
        const r = await fetch('https://graph.facebook.com/v21.0/me/whatsapp_business_accounts?fields=id&limit=10',
          { headers: { 'Authorization': 'Bearer ' + tok } });
        const d = await r.json();
        for (const w of d.data || []) if (w.id && !wabas.has(w.id)) wabas.set(w.id, tok);
      } catch (_) {}
    }
    // Compat: WABA fixa do env, caso a descoberta não a retorne
    const envWaba = process.env.WA_BUSINESS_ACCOUNT_ID || WA_BUSINESS_ACCOUNT_ID || '';
    if (envWaba && !wabas.has(envWaba)) wabas.set(envWaba, process.env.META_ACCESS_TOKEN || tokens[0]);
    if (!wabas.size) return res.status(400).json({ error: 'Nenhuma WABA encontrada. Confira os tokens/WA_BUSINESS_ACCOUNT_ID no Easypanel.' });

    // 2) Para cada WABA: número (1 por WABA) + templates paginados
    const contas = [];
    for (const [wabaId, tok] of wabas) {
      let phoneId = '';
      try {
        const pr = await fetch(`https://graph.facebook.com/v21.0/${wabaId}/phone_numbers?fields=id&limit=5`,
          { headers: { 'Authorization': 'Bearer ' + tok } });
        const pd = await pr.json();
        phoneId = pd.data?.[0]?.id || '';
      } catch (_) {}
      if (!phoneId) continue; // WABA sem número visível — ignora
      const meta = [];
      let url = `https://graph.facebook.com/v21.0/${wabaId}/message_templates?fields=name,status,category,components&limit=200`;
      let _pagina = 0;
      while (url && _pagina < 20) { _pagina++;
        const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + tok } });
        const data = await r.json();
        if (data.error) return res.status(400).json({ error: data.error.message });
        if (data.data) meta.push(...data.data);
        url = data.paging?.next || null;
      }
      contas.push({ wabaId, phoneId, meta });
    }

    // 3) Broadcast primeiro: os registros legados (wa_number_id='') vieram do sync
    //    antigo, que só lia essa conta — a adoção deles cai na WABA de origem.
    const bId = whatsapp.broadcastPhoneId() || '';
    contas.sort((a, b) => (b.phoneId === bId) - (a.phoneId === bId));

    const STATUS_MAP = { APPROVED: 'aprovado', PENDING: 'submetido', REJECTED: 'rejeitado', PAUSED: 'pausado', DISABLED: 'pausado', IN_APPEAL: 'em_recurso', PENDING_DELETION: 'pendente' };
    const { data: localTpls } = await supabase.from('templates').select('*');
    const locais = localTpls || [];
    const adotados = new Set();
    let atualizados = 0, importados = 0, totalMeta = 0;
    for (const conta of contas) {
      totalMeta += conta.meta.length;
      const toImport = [];
      for (const m of conta.meta) {
        const novoStatus = STATUS_MAP[m.status] || String(m.status || '').toLowerCase();
        const existente = locais.find(t => t.nome === m.name && t.wa_number_id === conta.phoneId);
        const legado = existente ? null : locais.find(t => t.nome === m.name && !t.wa_number_id && !adotados.has(t.id));
        if (existente) {
          const patch = {};
          if (existente.status !== novoStatus) { patch.status = novoStatus; atualizados++; }
          if (m.id && !existente.meta_id) patch.meta_id = m.id;
          if (Object.keys(patch).length) await supabase.from('templates').update(patch).eq('id', existente.id);
        } else if (legado) {
          adotados.add(legado.id);
          if (legado.status !== novoStatus) atualizados++;
          await supabase.from('templates').update({
            wa_number_id: conta.phoneId, status: novoStatus, meta_id: m.id || legado.meta_id || null,
          }).eq('id', legado.id);
        } else {
          const bodyComp = (m.components || []).find(c => c.type === 'BODY');
          const cat = ['MARKETING','UTILITY','AUTHENTICATION'].includes(m.category) ? m.category : 'MARKETING';
          const titulo = m.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          toImport.push({ nome: m.name, titulo, corpo: bodyComp ? bodyComp.text : '', categoria: cat, status: novoStatus, meta_id: m.id || null, wa_number_id: conta.phoneId });
        }
      }
      if (toImport.length) {
        const { error: insErr } = await supabase.from('templates').insert(toImport);
        if (!insErr) importados += toImport.length;
      }
    }
    res.json({ ok: true, atualizados, importados, contas: contas.length, total_meta: totalMeta });
```

- [ ] **Step 2: `npm test`** (regressão — sem falha nova) e **Commit** — `git commit -m "feat: sync-meta varre todas as WABAs e associa cada template ao seu número"`

---

### Task 4: Frontend — modal de template do chat filtra pelo número da conversa

**Files:**
- Modify: `public/index.html:1582` (texto do modal), `public/index.html:4275-4291` (`abrirModalTemplate`)

**Interfaces:**
- Consumes: `chatLeadAtual.wa_number_id` (RPC `conversas_com_preview`), `_waNumbers` (mapa id→rótulo já carregado no chat), `_templatesCache`.

- [ ] **Step 1: Dar id ao parágrafo do modal** — linha 1582, trocar:
```html
  <p style="font-size:12.5px;color:var(--muted);margin-bottom:16px">Enviado pelo <strong>Número 2 (broadcast)</strong> — use para confirmações, lembretes e follow-ups fora da janela de 24h.</p>
```
por:
```html
  <p id="tpl-info" style="font-size:12.5px;color:var(--muted);margin-bottom:16px">Enviado pelo número desta conversa — use para retomar o contato fora da janela de 24h.</p>
```

- [ ] **Step 2: Filtro por número em `abrirModalTemplate()`** — substituir a função inteira (a versão atual já filtra por aprovado; esta adiciona número + mensagens específicas):
```js
async function abrirModalTemplate() {
  if (!chatLeadAtual) return;
  try {
    const numConversa = chatLeadAtual.wa_number_id || '';
    const todos = await api('/api/templates');
    // Do número desta conversa; legados sem número (pré-sync) continuam valendo
    _templatesCache = todos.filter(t => t.status === 'aprovado' && (t.wa_number_id === numConversa || !t.wa_number_id));
    const sel = document.getElementById('tpl-select');
    const info = document.getElementById('tpl-info');
    if (!numConversa) {
      sel.innerHTML = '<option value="">Conversa sem número identificado — não é possível enviar template</option>';
      _templatesCache = [];
    } else if (!_templatesCache.length) {
      sel.innerHTML = '<option value="">Nenhum template aprovado disponível para este número</option>';
    } else {
      sel.innerHTML = _templatesCache.map(t =>
        `<option value="${escHtml(t.nome)}">${escHtml(t.titulo || t.nome)}</option>`
      ).join('');
    }
    if (info) {
      const rot = numConversa && _waNumbers[numConversa] ? ' (' + escHtml(_waNumbers[numConversa]) + ')' : '';
      info.innerHTML = 'Enviado pelo número desta conversa' + rot + ' — use para retomar o contato fora da janela de 24h.';
    }
    atualizarPreviewTemplate();
    document.getElementById('modal-template-bg').classList.add('open');
  } catch(e) { toast('❌ Erro ao carregar templates: ' + e.message, true); }
}
```

- [ ] **Step 3: Commit** — `git commit -m "feat: modal de template do chat filtra pelo número da conversa"`

---

### Task 5: Frontend — Disparos filtram templates pelo número selecionado

**Files:**
- Modify: `public/index.html:4353-4372` (`dispCarregarTemplates`) + `onchange` no `<select id="disp-numero">`

- [ ] **Step 1: Substituir `dispCarregarTemplates()`** (número carregado ANTES para o filtro inicial usar o default; guarda a lista completa para refiltrar na troca):
```js
let _dispTplsTodos = [];
async function dispCarregarTemplates() {
  const sel = document.getElementById('disp-template');
  if (!sel) return;
  try {
    const cfg = await api('/api/config/wa');
    const selN = document.getElementById('disp-numero');
    const ids = (cfg.sendable && cfg.sendable.length) ? cfg.sendable : Object.keys(cfg.numbers || {});
    if (ids.length) {
      selN.innerHTML = ids.map(id =>
        `<option value="${id}">${(cfg.numbers && cfg.numbers[id]) || id}</option>`).join('');
      if (cfg.defaultPhoneId && ids.includes(cfg.defaultPhoneId)) selN.value = cfg.defaultPhoneId;
    } else { console.error('disp numeros: lista vazia'); }
  } catch (e) { console.error('disp numeros:', e); }
  try {
    _dispTplsTodos = await api('/api/templates');
    dispRefiltrarTemplates();
  } catch (e) { sel.innerHTML = '<option value="">Erro ao carregar</option>'; }
}

function dispRefiltrarTemplates() {
  const sel = document.getElementById('disp-template');
  const num = document.getElementById('disp-numero')?.value || '';
  // Templates da conta do número escolhido; legados sem número (pré-sync) continuam valendo
  const aprovados = _dispTplsTodos.filter(t => t.status === 'aprovado' && (t.wa_number_id === num || !t.wa_number_id));
  sel.innerHTML = aprovados.length
    ? aprovados.map(t => `<option value="${escHtml(t.nome)}">${escHtml(t.titulo || t.nome)}</option>`).join('')
    : '<option value="">Nenhum template aprovado para este número</option>';
}
```

- [ ] **Step 2: `onchange` no seletor de número** — localizar `<select id="disp-numero"` no HTML (grep) e adicionar `onchange="dispRefiltrarTemplates()"` ao elemento (preservando atributos existentes).

- [ ] **Step 3: Commit** — `git commit -m "feat: Disparos filtram templates pela conta do número selecionado"`

---

### Task 6: Frontend — bolha legível para template no histórico

**Files:**
- Modify: `public/index.html:3674-3691` (`_bolhaMsgHtml`)

- [ ] **Step 1: Detecção e render** — dentro de `_bolhaMsgHtml`, logo após a linha do `🚫 Mensagem apagada` (3675), inserir:
```js
  // Envio de template/disparo gravado como texto marcador — render legível.
  // Formatos: "[template: nome | var1, var2]" (chat), "[disparo: nome]" (massa),
  // "[template:nome]" (rota /whatsapp, sem espaço).
  const tplM = /^\[(template|disparo):\s*([^\]|]+?)\s*(?:\|\s*(.*))?\]$/.exec((m.texto || '').trim());
  if (tplM) {
    const nomeTpl = tplM[2].trim();
    const tpl = (_templatesCache || []).find(t => t.nome === nomeTpl);
    const titulo = tpl && tpl.titulo ? tpl.titulo : nomeTpl.replace(/_/g, ' ');
    const vars = tplM[3] ? `<div style="font-size:11px;opacity:.75;margin-top:3px">${escHtml(tplM[3].trim())}</div>` : '';
    const origem = tplM[1] === 'disparo' ? 'Disparo em massa' : 'Template enviado';
    return `<div style="font-size:10.5px;opacity:.75">📢 ${origem}</div><strong>${escHtml(titulo)}</strong>${vars}`;
  }
```
(`waLabel` e ticks de entrega ficam fora da bolha e continuam funcionando sem mudança.)

- [ ] **Step 2: Commit** — `git commit -m "feat: bolha legível para template/disparo no histórico do lead"`

---

### Task 7: Verificação final, push isolado, deploy, sync e validação

- [ ] **Step 1: `npm test` no worktree** — sem falha nova vs baseline (`lib/monitor/crc.test.js` e `lib/nfse/assinar.test.js` já falham em `origin/main`).

- [ ] **Step 2: Copiar docs** — do checkout principal para o worktree: `docs/superpowers/specs/2026-07-17-templates-por-waba-design.md` e `docs/superpowers/plans/2026-07-17-templates-por-waba.md`; commit `docs: spec+plano templates por WABA`.

- [ ] **Step 3: Push + deploy**
```bash
git fetch && git log --oneline origin/main -1   # conferir que não avançou de forma conflitante
git push origin HEAD:main
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

- [ ] **Step 4: Luiz clica "↻ Sincronizar com Meta"** (aba Disparos) após o deploy subir.

- [ ] **Step 5: Validar via SQL**
```sql
select nome, status, wa_number_id from templates order by wa_number_id, nome;
```
Esperado: os 4 novos (`retomar_atendimento`, `retomar_atendimento_1`, `retomar_atendimento_2`, `ultima_semana_para_garantir_at_15_de_descon...`) com `wa_number_id = '993441140514749'` (2873); os antigos com `wa_number_id = '1142709218919903'` (8700); zero (ou quase zero) linhas com `wa_number_id = ''`.

- [ ] **Step 6: Validação funcional (Luiz)** — abrir conversa no 2873 → Template → só aprovados do 2873 (incluindo os `retomar_*`); enviar 1 template de teste e conferir que chega pelo 2873; conferir bolha legível; abrir Disparos e alternar o número → lista de templates muda.

- [ ] **Step 7: Limpar worktree** — `git worktree remove ../_wt_waba` (após push ok).
