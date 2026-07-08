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
    'tarefas': 'Tarefas', 'gestao': 'Gestão Tar.', 'config': 'Config', 'avaliacao-dentista': 'Aval. Dent.',
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
    /* Páginas que usam .main-content (financeiro, pacientes) em vez de <main>: sem o respiro
       do rodapé a última linha (ex.: bloco Provisões da DRE) fica atrás da tabbar fixa e não
       dá pra tocar. Espelha o padding do <main> (topo p/ a topbar + baixo p/ a tabbar). */
    .main-content { padding-top:64px !important;
      padding-bottom:calc(64px + env(safe-area-inset-bottom,0)) !important; }
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

  function openPersonalize() {
    const bg = document.querySelector('.mnav-sheet-bg');
    if (!bg) return;
    const body = bg.querySelector('.mnav-sheet-body');
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
        const tkn = _state.getToken ? _state.getToken() : null;
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
      _state.getToken = typeof opts.getToken === 'function' ? opts.getToken : null;
      _state.bar = resolveBar(_state.items, _state.navPrefs);
      renderTopbar();
      renderBar();
    },
  };
})();
