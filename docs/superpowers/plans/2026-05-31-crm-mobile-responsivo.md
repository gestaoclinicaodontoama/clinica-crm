# CRM Responsivo no Celular + Barra Inferior Personalizável — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o CRM usável no celular — sidebar vira barra inferior personalizável; Dashboard e telas leves renderizam bem; telas pesadas mostram aviso "melhor no computador".

**Architecture:** Modo mobile via `@media (max-width:768px)`. Um módulo único `public/js/mobile-nav.js` lê os itens do `<nav>` existente (DRY) e monta topo + barra inferior + gaveta "Mais" + tela de personalização. A preferência da barra é salva em `profiles.nav_prefs` (Supabase). O mesmo módulo serve o SPA (`index.html`) e as páginas separadas (`shared-nav.js`).

**Tech Stack:** Node.js/Express, HTML/CSS/JS vanilla, Supabase. Verificação via `node --check` + Playwright (MCP) em viewport mobile contra o site deployado.

**Nota sobre testes:** o projeto não tem runner de testes unitários. "Verificação" aqui = `node --check server.js` (sintaxe), validações de lógica via Playwright em viewport 390×844 no site deployado, e checagem visual no celular do usuário. Não há TDD unitário porque não há harness — não inventar um.

**Spec:** `docs/superpowers/specs/2026-05-31-crm-mobile-responsivo-design.md`

---

## Estrutura de arquivos

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| Supabase migration | coluna `profiles.nav_prefs jsonb` | Criar (MCP) |
| `server.js` | `GET /api/me` (+nav_prefs), `PATCH /api/me/nav-prefs`, whitelist de slugs | Modificar |
| `public/js/mobile-nav.js` | módulo da barra: lê nav do DOM, render topo/barra/sheet/personalização, guard desktop-only, CSS injetado | Criar |
| `public/index.html` | CSS responsivo de conteúdo; carregar mobile-nav.js; `setPage` atualiza título e aplica guard; chamar `MobileNav.init` após roles | Modificar |
| `public/js/shared-nav.js` | carregar/chamar `MobileNav.init` nas páginas separadas | Modificar |
| `public/ligacoes.html` | guard desktop-only no load | Modificar |

---

## Task 1: Migração — coluna `nav_prefs`

**Files:**
- Supabase (projeto `mtqdpjhhqzvuklnlfpvi`) via MCP `apply_migration`

- [ ] **Step 1: Aplicar migração**

Usar MCP `mcp__plugin_supabase_supabase__apply_migration`:
- `name`: `add_nav_prefs_to_profiles`
- `query`:
```sql
alter table profiles add column if not exists nav_prefs jsonb default null;
```

- [ ] **Step 2: Confirmar**

Usar MCP `mcp__plugin_supabase_supabase__list_migrations` e confirmar que `add_nav_prefs_to_profiles` aparece. Também rodar MCP `execute_sql`:
```sql
select column_name, data_type from information_schema.columns
where table_name='profiles' and column_name='nav_prefs';
```
Esperado: 1 linha, `nav_prefs | jsonb`.

---

## Task 2: Backend — expor e salvar `nav_prefs`

**Files:**
- Modify: `server.js` (`GET /api/me` ~linha 141; inserir novo endpoint logo após o bloco `/api/me/threec-agent-id` que termina ~linha 197)

- [ ] **Step 1: Adicionar `nav_prefs` à resposta de `GET /api/me`**

Em `server.js`, no objeto `res.json({...})` do `GET /api/me`, adicionar a linha após `threec_agent_ramal`:
```js
      threec_agent_ramal: profile?.threec_agent_ramal || null,
      nav_prefs: profile?.nav_prefs || null,
```

- [ ] **Step 2: Adicionar whitelist de slugs + endpoint `PATCH /api/me/nav-prefs`**

Inserir logo após o fechamento do endpoint `app.patch('/api/me/threec-agent-id', ...)` (a linha `});` ~197):
```js
// Slugs de navegação válidos para a barra inferior mobile (nav_prefs.tabbar)
const NAV_SLUGS = new Set([
  'dashboard','leads','funil','conv-agendamentos','conv-avaliacao','disparos',
  'notas-fiscais','inadimplentes','usuarios','tarefas-gestor','config',
  'avaliacao-dentista','atribuicao','ligacoes',
  'aniversariantes','recall','vips',
]);
app.patch('/api/me/nav-prefs', requireAuth, async (req, res) => {
  try {
    const tabbar = req.body?.tabbar;
    if (!Array.isArray(tabbar)) return res.status(400).json({ error: 'tabbar deve ser array' });
    if (tabbar.length < 1 || tabbar.length > 4) return res.status(400).json({ error: 'tabbar deve ter de 1 a 4 itens' });
    const seen = new Set();
    for (const s of tabbar) {
      if (typeof s !== 'string' || !NAV_SLUGS.has(s)) return res.status(400).json({ error: 'slug inválido: ' + s });
      if (seen.has(s)) return res.status(400).json({ error: 'slug duplicado: ' + s });
      seen.add(s);
    }
    const { error } = await supabase.from('profiles').update({ nav_prefs: { tabbar } }).eq('id', req.user.id);
    if (error) throw error;
    res.json({ ok: true, tabbar });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 3: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem saída (sucesso). Se imprimir erro, corrigir antes de seguir.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(api): nav_prefs no /api/me e PATCH /api/me/nav-prefs"
```

---

## Task 3: `mobile-nav.js` — topo + barra inferior (sem sheet/personalização ainda)

**Files:**
- Create: `public/js/mobile-nav.js`

- [ ] **Step 1: Criar o módulo com CSS, coleta de itens do DOM e render de topo+barra**

Criar `public/js/mobile-nav.js`:
```js
/* Barra de navegação mobile do CRM. Lê os itens do <nav> existente (DRY).
   Uso: após aplicar roles, chamar window.MobileNav.init({ navSelector, activeSlug, onAfterNav, saveUrl }). */
(function () {
  const MOBILE_BP = 768;
  const DESKTOP_ONLY = new Set(['leads','inadimplentes','notas-fiscais','disparos','usuarios','config','ligacoes']);
  // rótulos curtos p/ a barra/topo (long demais cabe mal). slug -> {label, title}
  const SHORT = {
    'dashboard': 'Início', 'leads': 'Leads', 'funil': 'Funil',
    'conv-agendamentos': 'CRC Lead', 'conv-avaliacao': 'CRC Com.', 'disparos': 'Disparos',
    'notas-fiscais': 'Notas', 'inadimplentes': 'Inadimpl.', 'usuarios': 'Usuários',
    'tarefas-gestor': 'Tarefas', 'config': 'Config', 'avaliacao-dentista': 'Aval. Dent.',
    'atribuicao': 'Atribuição', 'ligacoes': 'Ligações',
    'aniversariantes': 'Aniversár.', 'recall': 'Recall', 'vips': 'VIPs',
  };

  const isMobile = () => window.matchMedia('(max-width:' + MOBILE_BP + 'px)').matches;
  let _state = { items: [], bar: [], activeSlug: null, onAfterNav: null };

  const CSS = `
  .mnav-topbar, .mnav-tabbar, .mnav-sheet-bg { display:none; }
  @media (max-width:${MOBILE_BP}px) {
    .shell > nav, body.crm-shell > .crm-nav { display:none !important; }
    .mnav-topbar { display:flex; align-items:center; gap:10px; position:fixed; top:0; left:0; right:0;
      height:52px; padding:0 14px; background:var(--bg2); border-bottom:1px solid var(--border); z-index:60; }
    .mnav-topbar .mnav-logo { font-weight:700; font-size:16px; }
    .mnav-topbar .mnav-logo span { color:var(--accent); }
    .mnav-topbar .mnav-title { font-size:14px; color:var(--muted); margin-left:auto; max-width:55%;
      overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .mnav-tabbar { display:flex; position:fixed; bottom:0; left:0; right:0; z-index:60;
      background:var(--bg2); border-top:1px solid var(--border);
      padding-bottom:env(safe-area-inset-bottom,0); }
    .mnav-tab { flex:1; display:flex; flex-direction:column; align-items:center; gap:3px;
      padding:8px 2px 7px; background:none; border:none; color:var(--muted); cursor:pointer;
      font-size:10px; font-family:inherit; min-width:0; }
    .mnav-tab svg { width:20px; height:20px; }
    .mnav-tab span { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .mnav-tab.active { color:var(--accent); }
    /* layout geral: esconde sidebar, ajusta main */
    .shell { display:block !important; height:auto !important; overflow:visible !important; }
    main { height:auto !important; min-height:100vh; padding:64px 14px calc(64px + env(safe-area-inset-bottom,0)) !important;
      overflow-x:hidden !important; }
  }`;

  function injectCSS() {
    if (document.getElementById('mnav-css')) return;
    const s = document.createElement('style'); s.id = 'mnav-css'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function slugOf(el) {
    if (el.dataset && el.dataset.page) return el.dataset.page;
    const href = el.getAttribute('href') || '';
    return href.replace(/^\//, '').replace(/\/$/, '').replace(/\.html$/, '').split('/').pop() || 'home';
  }

  // Coleta itens VISÍVEIS do nav (roles já aplicados => display:none nos ocultos).
  function collectItems(navEl) {
    const out = [];
    const seen = new Set();
    navEl.querySelectorAll('.nav-btn[data-page], a.nav-btn[href], .nav-subitem[href]').forEach(el => {
      if (el.classList.contains('nav-logout') || el.classList.contains('nav-btn--section')) return;
      if (getComputedStyle(el).display === 'none') return; // role oculto
      // dentro de seção/submenu oculto?
      const sec = el.closest('.nav-section');
      if (sec && getComputedStyle(sec).display === 'none') return;
      const slug = slugOf(el);
      if (seen.has(slug)) return; seen.add(slug);
      const svg = el.querySelector('svg');
      out.push({
        slug,
        label: SHORT[slug] || (el.textContent || '').trim().replace(/\s+/g, ' ').split(' ').slice(0, 1).join(' '),
        title: (el.textContent || '').trim().replace(/\s+/g, ' '),
        icon: svg ? svg.outerHTML : '',
        el,
      });
    });
    return out;
  }

  function resolveBar(items, navPrefs) {
    const bySlug = Object.fromEntries(items.map(i => [i.slug, i]));
    let bar = [];
    const pref = navPrefs && Array.isArray(navPrefs.tabbar) ? navPrefs.tabbar : null;
    if (pref) bar = pref.map(s => bySlug[s]).filter(Boolean); // filtra itens não mais visíveis
    for (const it of items) { if (bar.length >= 4) break; if (!bar.includes(it)) bar.push(it); }
    return bar.slice(0, 4);
  }

  function navigate(item) {
    _state.activeSlug = item.slug;
    item.el.click(); // reusa setPage/href original
    renderBar();
    if (typeof _state.onAfterNav === 'function') _state.onAfterNav(item.slug);
    closeSheet();
  }

  function renderTopbar() {
    let bar = document.querySelector('.mnav-topbar');
    if (!bar) {
      bar = document.createElement('div'); bar.className = 'mnav-topbar';
      bar.innerHTML = '<div class="mnav-logo">CRM <span>AMA</span></div><div class="mnav-title" id="mnav-title"></div>';
      document.body.appendChild(bar);
    }
    setTitle(_state.activeSlug);
  }

  function setTitle(slug) {
    const t = document.getElementById('mnav-title');
    if (!t) return;
    const it = _state.items.find(i => i.slug === slug);
    t.textContent = it ? it.title : '';
  }

  function renderBar() {
    let bar = document.querySelector('.mnav-tabbar');
    if (!bar) { bar = document.createElement('div'); bar.className = 'mnav-tabbar'; document.body.appendChild(bar); }
    const tabs = _state.bar.map(it => {
      const active = it.slug === _state.activeSlug ? ' active' : '';
      return '<button class="mnav-tab' + active + '" data-slug="' + it.slug + '">' + it.icon + '<span>' + it.label + '</span></button>';
    }).join('');
    const moreActive = _state.bar.every(it => it.slug !== _state.activeSlug) ? '' : '';
    bar.innerHTML = tabs +
      '<button class="mnav-tab mnav-more" data-more="1">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>' +
      '<span>Mais</span></button>';
    bar.querySelectorAll('.mnav-tab[data-slug]').forEach(btn => {
      btn.onclick = () => { const it = _state.items.find(i => i.slug === btn.dataset.slug); if (it) navigate(it); };
    });
    bar.querySelector('.mnav-more').onclick = openSheet;
  }

  // placeholders preenchidos na Task 4/5
  function openSheet() {}
  function closeSheet() {}

  window.MobileNav = {
    isMobile,
    isDesktopOnly: (slug) => DESKTOP_ONLY.has(slug),
    setActive: (slug) => { _state.activeSlug = slug; setTitle(slug); document.querySelectorAll('.mnav-tab[data-slug]').forEach(b => b.classList.toggle('active', b.dataset.slug === slug)); },
    init: function (opts) {
      opts = opts || {};
      const navEl = document.querySelector(opts.navSelector || 'nav');
      if (!navEl) return;
      injectCSS();
      _state.items = collectItems(navEl);
      _state.activeSlug = opts.activeSlug || (_state.items[0] && _state.items[0].slug) || null;
      _state.onAfterNav = opts.onAfterNav || null;
      _state.navPrefs = opts.navPrefs || null;
      _state.bar = resolveBar(_state.items, _state.navPrefs);
      renderTopbar();
      renderBar();
    },
  };
})();
```

- [ ] **Step 2: Verificação manual de sintaxe JS**

Run: `node --check public/js/mobile-nav.js`
Expected: sem saída.

- [ ] **Step 3: Commit**

```bash
git add public/js/mobile-nav.js
git commit -m "feat(mobile): modulo mobile-nav com topo e barra inferior"
```

---

## Task 4: `mobile-nav.js` — gaveta "Mais" (sheet)

**Files:**
- Modify: `public/js/mobile-nav.js`

- [ ] **Step 1: Adicionar CSS do sheet**

No template `CSS`, antes do `}` final do bloco `@media`, inserir:
```js
    .mnav-sheet-bg { display:block; position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:70; opacity:0; transition:opacity .2s; }
    .mnav-sheet-bg.open { opacity:1; }
    .mnav-sheet { position:fixed; left:0; right:0; bottom:0; z-index:71; background:var(--bg2);
      border-top-left-radius:16px; border-top-right-radius:16px; max-height:80vh; overflow-y:auto;
      transform:translateY(100%); transition:transform .25s; padding:8px 0 calc(12px + env(safe-area-inset-bottom,0)); }
    .mnav-sheet.open { transform:translateY(0); }
    .mnav-sheet .mnav-grip { width:36px; height:4px; border-radius:2px; background:var(--border); margin:8px auto 12px; }
    .mnav-sheet-item { display:flex; align-items:center; gap:12px; padding:13px 20px; color:var(--text);
      font-size:15px; cursor:pointer; border:none; background:none; width:100%; text-align:left; font-family:inherit; text-decoration:none; }
    .mnav-sheet-item svg { width:20px; height:20px; flex-shrink:0; }
    .mnav-sheet-item.active { color:var(--accent); }
    .mnav-sheet-sep { height:1px; background:var(--border); margin:8px 0; }
```

- [ ] **Step 2: Implementar `openSheet`/`closeSheet` (substituir os placeholders)**

Substituir as funções placeholder `function openSheet() {}` e `function closeSheet() {}` por:
```js
  function buildSheetItems() {
    return _state.items.map(it => {
      const active = it.slug === _state.activeSlug ? ' active' : '';
      return '<button class="mnav-sheet-item' + active + '" data-slug="' + it.slug + '">' + it.icon + '<span>' + it.title + '</span></button>';
    }).join('');
  }

  function openSheet() {
    let bg = document.querySelector('.mnav-sheet-bg');
    if (!bg) {
      bg = document.createElement('div'); bg.className = 'mnav-sheet-bg';
      bg.innerHTML = '<div class="mnav-sheet"><div class="mnav-grip"></div><div class="mnav-sheet-body"></div></div>';
      document.body.appendChild(bg);
      bg.onclick = (e) => { if (e.target === bg) closeSheet(); };
    }
    const body = bg.querySelector('.mnav-sheet-body');
    body.innerHTML = buildSheetItems() +
      '<div class="mnav-sheet-sep"></div>' +
      '<button class="mnav-sheet-item" data-act="personalizar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg><span>Personalizar barra</span></button>' +
      '<button class="mnav-sheet-item" data-act="tema"><span style="width:20px;text-align:center">🌓</span><span>Alternar tema</span></button>' +
      '<button class="mnav-sheet-item" data-act="sair"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg><span>Sair</span></button>';
    body.querySelectorAll('.mnav-sheet-item[data-slug]').forEach(btn => {
      btn.onclick = () => { const it = _state.items.find(i => i.slug === btn.dataset.slug); if (it) navigate(it); };
    });
    body.querySelector('[data-act="personalizar"]').onclick = openPersonalize;
    body.querySelector('[data-act="tema"]').onclick = () => {
      if (typeof window.toggleTheme === 'function') window.toggleTheme();
      else if (typeof window._sharedNavToggleTheme === 'function') window._sharedNavToggleTheme();
    };
    body.querySelector('[data-act="sair"]').onclick = () => {
      if (typeof window.handleLogout === 'function') window.handleLogout();
    };
    requestAnimationFrame(() => { bg.classList.add('open'); bg.querySelector('.mnav-sheet').classList.add('open'); });
  }

  function closeSheet() {
    const bg = document.querySelector('.mnav-sheet-bg');
    if (!bg) return;
    bg.classList.remove('open'); bg.querySelector('.mnav-sheet').classList.remove('open');
    setTimeout(() => { if (!bg.classList.contains('open')) bg.remove(); }, 260);
  }

  function openPersonalize() {} // implementado na Task 5
```

- [ ] **Step 3: Verificação de sintaxe**

Run: `node --check public/js/mobile-nav.js`
Expected: sem saída.

- [ ] **Step 4: Commit**

```bash
git add public/js/mobile-nav.js
git commit -m "feat(mobile): gaveta Mais com itens, tema e sair"
```

---

## Task 5: `mobile-nav.js` — personalização (liga/desliga + setas) e save

**Files:**
- Modify: `public/js/mobile-nav.js`

- [ ] **Step 1: Adicionar CSS da tela de personalização**

No bloco `@media`, antes do `}` final, inserir:
```js
    .mnav-perso-row { display:flex; align-items:center; gap:10px; padding:11px 16px; border-bottom:1px solid var(--border); }
    .mnav-perso-row .lbl { flex:1; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .mnav-perso-row.off .lbl { color:var(--muted); }
    .mnav-perso-row button { background:var(--bg3); border:1px solid var(--border); color:var(--text); border-radius:7px;
      width:32px; height:32px; cursor:pointer; font-size:15px; }
    .mnav-perso-row button:disabled { opacity:.35; cursor:default; }
    .mnav-perso-row .tgl { width:auto; padding:0 12px; }
    .mnav-perso-row .tgl.on { background:var(--accent); color:#fff; border-color:var(--accent); }
    .mnav-perso-head { display:flex; align-items:center; gap:10px; padding:6px 16px 12px; }
    .mnav-perso-head .save { margin-left:auto; background:var(--accent); color:#fff; border:none; border-radius:8px; padding:8px 16px; font-weight:600; cursor:pointer; font-family:inherit; }
    .mnav-perso-hint { font-size:12px; color:var(--muted); padding:0 16px 10px; }
```

- [ ] **Step 2: Implementar `openPersonalize` (substituir o placeholder) + save**

Substituir `function openPersonalize() {}` por:
```js
  function openPersonalize() {
    const bg = document.querySelector('.mnav-sheet-bg');
    if (!bg) return;
    const body = bg.querySelector('.mnav-sheet-body');
    // estado de edição: lista ordenada com flag "on" (na barra) — os 4 primeiros "on" iniciais = barra atual
    let draft = _state.items.map(it => ({ slug: it.slug, title: it.title, on: _state.bar.some(b => b.slug === it.slug) }));

    function render() {
      const onCount = draft.filter(d => d.on).length;
      body.innerHTML =
        '<div class="mnav-perso-head"><strong>Personalizar barra</strong>' +
        '<button class="save">Salvar</button></div>' +
        '<div class="mnav-perso-hint">Escolha até 4 itens para a barra inferior e ordene com ↑ ↓.</div>' +
        draft.map((d, i) =>
          '<div class="mnav-perso-row' + (d.on ? '' : ' off') + '">' +
          '<button class="up" data-i="' + i + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button class="down" data-i="' + i + '"' + (i === draft.length - 1 ? ' disabled' : '') + '>↓</button>' +
          '<span class="lbl">' + d.title + '</span>' +
          '<button class="tgl' + (d.on ? ' on' : '') + '" data-i="' + i + '">' + (d.on ? 'Na barra' : 'Fora') + '</button>' +
          '</div>'
        ).join('');
      body.querySelector('.save').onclick = save;
      body.querySelectorAll('.up').forEach(b => b.onclick = () => { const i = +b.dataset.i; [draft[i-1], draft[i]] = [draft[i], draft[i-1]]; render(); });
      body.querySelectorAll('.down').forEach(b => b.onclick = () => { const i = +b.dataset.i; [draft[i+1], draft[i]] = [draft[i], draft[i+1]]; render(); });
      body.querySelectorAll('.tgl').forEach(b => b.onclick = () => {
        const i = +b.dataset.i;
        if (!draft[i].on && onCount >= 4) { alert('Máximo de 4 itens na barra.'); return; }
        draft[i].on = !draft[i].on; render();
      });
    }

    async function save() {
      const tabbar = draft.filter(d => d.on).slice(0, 4).map(d => d.slug);
      if (tabbar.length < 1) { alert('Escolha ao menos 1 item.'); return; }
      try {
        const tkn = (typeof window.getToken === 'function') ? window.getToken() : window._tkn;
        const r = await fetch('/api/me/nav-prefs', {
          method: 'PATCH',
          headers: { 'Authorization': 'Bearer ' + tkn, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tabbar }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        _state.navPrefs = { tabbar };
        _state.bar = resolveBar(_state.items, _state.navPrefs);
        renderBar();
        closeSheet();
      } catch (e) { alert('Não foi possível salvar: ' + e.message); }
    }

    render();
  }
```

- [ ] **Step 3: Verificação de sintaxe**

Run: `node --check public/js/mobile-nav.js`
Expected: sem saída.

- [ ] **Step 4: Commit**

```bash
git add public/js/mobile-nav.js
git commit -m "feat(mobile): personalizar barra (liga/desliga + setas) salvo no perfil"
```

---

## Task 6: Integração no `index.html` (SPA)

**Files:**
- Modify: `public/index.html` (head: incluir script; CSS responsivo de conteúdo; `setPage`; chamada de init após roles)

- [ ] **Step 1: Carregar o módulo**

No `<head>` do `index.html`, adicionar (após os outros `<script>` do head ou antes de `</head>`):
```html
<script src="/js/mobile-nav.js" defer></script>
```

- [ ] **Step 2: CSS responsivo de conteúdo**

No `<style>` do `index.html`, no final (antes de `</style>`), adicionar:
```css
@media (max-width: 768px) {
  h1 { font-size: 19px; margin-bottom: 16px; }
  h2 { font-size: 14px; }
  .cards { grid-template-columns: repeat(2, 1fr) !important; gap: 10px; }
  .card-value { font-size: 20px; }
  .table-wrap, .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { min-width: 560px; }
  .funil-row { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  /* modais viram quase tela cheia */
  .modal, .modal-card, .modal-content { width: 96vw !important; max-width: 96vw !important; max-height: 88vh !important; }
  /* toolbars/filtros quebram linha */
  .toolbar, .filtros, .filter-row { flex-wrap: wrap !important; }
  /* aviso desktop-only */
  .mnav-desktop-only { display: none; text-align: center; padding: 48px 20px; color: var(--muted); }
}
.mnav-desktop-only-card { max-width: 340px; margin: 0 auto; background: var(--bg2); border: 1px solid var(--border);
  border-radius: 14px; padding: 28px 22px; }
```

> Nota p/ o executor: confirmar os nomes reais das classes de modal/toolbar no `index.html` com `grep -n "class=\"modal" public/index.html` e ajustar o seletor se diferente. Adicionar as classes encontradas ao seletor acima; não remover as já listadas.

- [ ] **Step 3: Adicionar bloco de aviso desktop-only no `<main>`**

Logo após a abertura de `<main>` (linha ~618), inserir:
```html
<div id="mnav-desktop-warning" class="mnav-desktop-only">
  <div class="mnav-desktop-only-card">
    <div style="font-size:32px;margin-bottom:10px">📊</div>
    <div style="font-weight:600;color:var(--text);margin-bottom:6px">Melhor no computador</div>
    <div>Esta tela tem muita informação e fica melhor numa tela grande. Abra no notebook para ver em detalhe.</div>
  </div>
</div>
```

- [ ] **Step 4: `setPage` atualiza título mobile e aplica guard desktop-only**

Localizar a função `setPage` (`grep -n "function setPage" public/index.html`). No início do corpo dela, após determinar o `page`/slug, inserir:
```js
  // mobile: título + guard desktop-only
  if (window.MobileNav && window.MobileNav.isMobile()) {
    window.MobileNav.setActive(page);
    const warn = document.getElementById('mnav-desktop-warning');
    const isDO = window.MobileNav.isDesktopOnly(page);
    if (warn) warn.style.display = isDO ? 'block' : 'none';
    document.querySelectorAll('main > .page').forEach(p => { if (isDO) p.style.display = 'none'; });
    if (isDO) return; // não renderiza a tela pesada
  }
```
> `page` é o nome do slug recebido por `setPage(page, btn)`. Se o parâmetro tiver outro nome, usar o nome real.

- [ ] **Step 5: Inicializar `MobileNav` após aplicar roles**

Localizar onde roles são aplicados (`grep -n "applyRoles\|/api/me" public/index.html` — bloco ~4588). Após o `forEach` que aplica `data-roles` e define `window._me`/roles, e após expor o token, inserir:
```js
  if (window.MobileNav) {
    const activePage = (document.querySelector('.page.active') || {}).id || '';
    window.MobileNav.init({
      navSelector: 'nav',
      activeSlug: activePage.replace(/^page-/, '') || 'dashboard',
      navPrefs: d.nav_prefs || null,
      onAfterNav: (slug) => {/* setActive já tratado no setPage */},
    });
  }
```
> `d` é o objeto de `GET /api/me`. Garantir que `getToken()`/`window._tkn` exista globalmente para o save (Task 5). Conferir com `grep -n "function getToken\|_tkn" public/index.html`; se o nome do acessor de token for outro, ajustar a referência no `save()` da Task 5.

- [ ] **Step 6: Verificação Playwright (deployar antes — ver Task 8, ou testar local se houver server)**

Após deploy (Task 8) ou em ambiente com server rodando, usar Playwright MCP:
1. `browser_resize` 390×844.
2. `browser_navigate` para a URL pública, logar como gestor.
3. `browser_snapshot`: confirmar `.mnav-tabbar` com 5 botões (4 + Mais) e `.mnav-topbar` visível; sidebar `nav` oculta.
4. `browser_evaluate`: `document.body.scrollWidth <= window.innerWidth + 1` → esperado `true` no Dashboard (sem overflow horizontal).
5. Tocar "Mais" → confirmar `.mnav-sheet.open` e itens + Personalizar/Tema/Sair.
6. Navegar para "Leads" via sheet → confirmar `#mnav-desktop-warning` visível e `.page` ocultas.

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "feat(mobile): integra barra mobile, guard desktop-only e responsividade no SPA"
```

---

## Task 7: Integração nas páginas separadas (`shared-nav.js`) + `ligacoes`

**Files:**
- Modify: `public/js/shared-nav.js`
- Modify: `public/ligacoes.html`

- [ ] **Step 1: Carregar mobile-nav.js junto do shared-nav**

No `shared-nav.js`, no topo do IIFE (antes de montar o nav), injetar o script se ausente:
```js
  if (!document.querySelector('script[src="/js/mobile-nav.js"]')) {
    const s = document.createElement('script'); s.src = '/js/mobile-nav.js'; document.head.appendChild(s);
  }
```

- [ ] **Step 2: Inicializar MobileNav após montar o nav e aplicar roles**

No `shared-nav.js`, ao final de `applyRoles()` (após filtrar os itens por role), e após carregar o perfil, inserir:
```js
  function initMobileNav(navPrefs) {
    const start = () => {
      if (!window.MobileNav) return setTimeout(start, 50);
      window.MobileNav.init({
        navSelector: '.crm-nav',
        activeSlug: document.currentScript ? '' : (document.body.getAttribute('data-active') || ''),
        navPrefs: navPrefs || null,
      });
    };
    start();
  }
```
E chamar `initMobileNav(profile?.nav_prefs)` após obter o perfil em `applyRoles` (onde o `GET /api/me`/perfil é lido). Usar o `data-active` do `<script src="/js/shared-nav.js" data-active="...">` como `activeSlug` — ler via `document.querySelector('script[src="/js/shared-nav.js"]').dataset.active`.

> Conferir como `shared-nav.js` obtém o perfil/roles e o token (`grep -n "api/me\|getToken\|access_token" public/js/shared-nav.js`). Reusar o mesmo token para a chamada de save (já tratado no módulo via `window.getToken`/`window._tkn` — se as páginas separadas não definem isso, expor `window._tkn` no `shared-nav.js` com o token lido).

- [ ] **Step 3: Guard desktop-only em `/ligacoes`**

Em `public/ligacoes.html`, adicionar script no final do `<body>`:
```html
<script>
  function _ligGuard(){
    if (window.MobileNav && window.MobileNav.isMobile() && window.MobileNav.isDesktopOnly('ligacoes')) {
      document.querySelector('main').innerHTML =
        '<div style="text-align:center;padding:48px 20px;color:var(--muted)"><div style="font-size:32px">📊</div>' +
        '<div style="font-weight:600;color:var(--text);margin:8px 0 6px">Melhor no computador</div>' +
        '<div>Esta tela fica melhor numa tela grande.</div></div>';
    }
  }
  window.addEventListener('load', () => setTimeout(_ligGuard, 300));
</script>
```

- [ ] **Step 4: Verificação de sintaxe**

Run: `node --check public/js/shared-nav.js`
Expected: sem saída.

- [ ] **Step 5: Commit**

```bash
git add public/js/shared-nav.js public/ligacoes.html
git commit -m "feat(mobile): barra mobile nas paginas separadas + guard /ligacoes"
```

---

## Task 8: Deploy + verificação real

**Files:** nenhum (deploy)

- [ ] **Step 1: Push**

```bash
git push
```

- [ ] **Step 2: Deploy Easypanel (CRM)**

```bash
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

- [ ] **Step 3: Verificação Playwright na URL pública (mobile)**

Esperar ~60s, então rodar a verificação da Task 6, Step 6 contra `https://plataformaama-plataforma.uc5as5.easypanel.host` em 390×844, logado como gestor. Também:
- Personalizar barra: ligar/desligar itens, reordenar com ↑↓, Salvar → recarregar página → confirmar que a barra refletiu a escolha (persistência).
- Abrir `/atribuicao/` (página separada) no mobile → confirmar barra inferior presente e seção CPA/ROAS legível.

- [ ] **Step 4: Validação no celular do usuário**

Pedir ao Luiz para abrir no celular e confirmar: barra inferior, Dashboard legível, "Mais" + personalização funcionando, telas pesadas mostrando o aviso.

---

## Self-Review (preenchido)

**Cobertura da spec:**
- Breakpoint 768px → Task 3 (CSS) ✔
- Topo + barra inferior → Task 3 ✔
- Default 4 primeiros do perfil → `resolveBar` (Task 3) ✔
- Sheet "Mais" + tema + sair → Task 4 ✔
- Personalização liga/desliga + setas, máx 4 → Task 5 ✔
- Persistência `nav_prefs` (coluna + endpoint + GET) → Tasks 1, 2 ✔
- Carregamento defensivo (filtra por role) → `resolveBar` filtra itens não visíveis (Task 3) ✔
- Guard desktop-only → Task 6 (SPA) + Task 7 (ligacoes) ✔
- Responsividade de conteúdo (cards/tabelas/modais/funil) → Task 6 ✔
- Páginas separadas → Task 7 ✔
- Testes Playwright → Tasks 6, 8 ✔

**Placeholder scan:** `openSheet/closeSheet/openPersonalize` começam como stubs vazios na Task 3 e são substituídos por implementação completa nas Tasks 4 e 5 (intencional, ordem de construção). Sem TODOs pendentes ao fim.

**Consistência de tipos:** `resolveBar(items, navPrefs)`, `_state.bar/items/activeSlug/navPrefs`, `navigate(item)`, `MobileNav.init({navSelector,activeSlug,navPrefs,onAfterNav})`, `MobileNav.setActive/isDesktopOnly/isMobile` — usados de forma consistente entre tasks. Endpoint salva `{ tabbar }` e front lê `nav_prefs.tabbar` — consistente.

**Pontos a confirmar pelo executor (marcados inline):** nomes reais de classes de modal/toolbar no index; nome do parâmetro de `setPage`; acessor de token (`getToken`/`_tkn`) no index e nas páginas separadas.
