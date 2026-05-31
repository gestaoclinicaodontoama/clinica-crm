/* Barra de navegação mobile do CRM. Lê os itens do <nav> existente (DRY).
   Uso: após aplicar roles, chamar window.MobileNav.init({ navSelector, activeSlug, onAfterNav, navPrefs }). */
(function () {
  const MOBILE_BP = 768;
  const DESKTOP_ONLY = new Set(['leads','inadimplentes','notas-fiscais','disparos','usuarios','config','ligacoes']);
  // rótulos curtos p/ a barra/topo. slug -> label curto
  const SHORT = {
    'dashboard': 'Início', 'leads': 'Leads', 'funil': 'Funil',
    'conv-agendamentos': 'CRC Lead', 'conv-avaliacao': 'CRC Com.', 'disparos': 'Disparos',
    'notas-fiscais': 'Notas', 'inadimplentes': 'Inadimpl.', 'usuarios': 'Usuários',
    'tarefas-gestor': 'Tarefas', 'config': 'Config', 'avaliacao-dentista': 'Aval. Dent.',
    'atribuicao': 'Atribuição', 'ligacoes': 'Ligações',
    'aniversariantes': 'Aniversár.', 'recall': 'Recall', 'vips': 'VIPs',
  };

  const isMobile = () => window.matchMedia('(max-width:' + MOBILE_BP + 'px)').matches;
  let _state = { items: [], bar: [], activeSlug: null, onAfterNav: null, navPrefs: null };

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

  function collectItems(navEl) {
    const out = [];
    const seen = new Set();
    navEl.querySelectorAll('.nav-btn[data-page], a.nav-btn[href], .nav-subitem[href]').forEach(el => {
      if (el.classList.contains('nav-logout') || el.classList.contains('nav-btn--section')) return;
      if (getComputedStyle(el).display === 'none') return;
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
    if (pref) bar = pref.map(s => bySlug[s]).filter(Boolean);
    for (const it of items) { if (bar.length >= 4) break; if (!bar.includes(it)) bar.push(it); }
    return bar.slice(0, 4);
  }

  function navigate(item) {
    _state.activeSlug = item.slug;
    item.el.click();
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
    bar.innerHTML = tabs +
      '<button class="mnav-tab mnav-more" data-more="1">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>' +
      '<span>Mais</span></button>';
    bar.querySelectorAll('.mnav-tab[data-slug]').forEach(btn => {
      btn.onclick = () => { const it = _state.items.find(i => i.slug === btn.dataset.slug); if (it) navigate(it); };
    });
    bar.querySelector('.mnav-more').onclick = openSheet;
  }

  // Implementados em tasks posteriores
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
