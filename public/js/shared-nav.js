/**
 * shared-nav.js
 * Injeta a sidebar do CRM em páginas separadas (fora do index.html).
 * A ESTRUTURA do menu vem de /js/nav-config.js (fonte única, compartilhada
 * com o index.html). Aqui ficam só o "chrome" (logo, tema, versão) e a
 * lógica específica de páginas separadas (roles via /api/me, mobile-nav).
 *
 * Uso: <script src="/js/shared-nav.js" data-active="avaliacao-dentista"></script>
 */
(function () {
  if (!document.querySelector('script[src="/js/mobile-nav.js"]')) {
    var _mn = document.createElement('script'); _mn.src = '/js/mobile-nav.js'; document.head.appendChild(_mn);
  }

  const scriptTag = document.currentScript;
  const activePage = scriptTag?.dataset?.active || '';

  // ── CSS ─────────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    body.crm-shell { display: flex; margin: 0; min-height: 100vh; }
    .crm-nav {
      width: 220px; min-width: 220px; background: var(--bg2); border-right: 1px solid var(--border);
      padding: 22px 14px; display: flex; flex-direction: column; gap: 4px;
      height: 100vh; overflow-y: auto; position: sticky; top: 0; flex-shrink: 0;
      transition: width .18s, min-width .18s;
    }
    .crm-nav[hidden] { visibility: hidden; }
    .crm-nav .logo { font-size: 18px; font-weight: 700; padding: 6px 12px 22px; letter-spacing: -.4px;
      display: flex; align-items: center; justify-content: space-between; }
    .crm-nav .logo span { color: var(--accent); }
    .crm-nav .nav-btn {
      display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 8px;
      cursor: pointer; font-size: 13.5px; font-weight: 500; color: var(--muted);
      border: none; background: none; width: 100%; text-align: left; transition: all .15s;
      text-decoration: none;
    }
    .crm-nav .nav-btn:hover { background: var(--bg3); color: var(--text); }
    .crm-nav .nav-btn.active { background: var(--accent); color: white; }
    .crm-nav .nav-icon { width: 16px; height: 16px; flex-shrink: 0; }
    .crm-nav .nav-section { display: flex; flex-direction: column; gap: 2px; }
    .crm-nav .nav-btn--section {
      font-weight: 700; color: var(--text); font-size: 12px; letter-spacing: .04em;
      text-transform: uppercase; padding: 8px 12px 6px; margin-top: 6px;
    }
    .crm-nav .nav-btn--section:hover { background: var(--bg3); }
    .crm-nav .nav-submenu { padding-left: 6px; display: flex; flex-direction: column; gap: 1px; margin-top: 1px; }
    .crm-nav .nav-subitem {
      display: flex; align-items: center; padding: 7px 12px; border-radius: 8px;
      font-size: 13px; color: var(--muted); text-decoration: none; transition: all .15s;
      background: none; border: none; cursor: pointer; width: 100%; text-align: left;
      font-family: inherit;
    }
    .crm-nav .nav-subitem:hover { background: var(--bg3); color: var(--text); }
    .crm-nav .nav-subitem.active { background: var(--accent); color: white; }
    .crm-nav .nav-arrow { margin-left: auto; width: 12px; height: 12px; transition: transform .2s; flex-shrink: 0; }
    .crm-nav .nav-divider { height: 1px; background: var(--border); margin: 6px 4px; }
    .crm-nav .badge-nav { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 18px; border-radius: 999px; font-size: .65rem; font-weight: 700; padding: 0 .35rem; margin-left: auto; }
    .crm-nav .badge-nav--green { background: #D1FAE5; color: #065F46; }
    .crm-nav .badge-nav--amber { background: #FEF3C7; color: #92400E; }
    .crm-nav .inad-nav-badge { margin-left: auto; font-size: 10px; font-weight: 700; background: rgba(239,68,68,.2); color: var(--red); padding: 1px 6px; border-radius: 10px; }
    .crm-nav .theme-btn {
      margin-top: auto; padding: 9px 12px; background: var(--bg3); color: var(--text);
      border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500;
      display: flex; align-items: center; justify-content: center; gap: 8px; transition: all .15s; width: 100%;
    }
    .crm-nav .theme-btn:hover { background: var(--border); }
    .crm-content { flex: 1; min-height: 100vh; overflow-x: hidden; overflow-y: auto; }
  `;
  document.head.appendChild(style);

  // ── BOOTSTRAP: carrega nav-config.js e então monta a sidebar ─────────────────
  function ready(cb) {
    if (window.CRMNav) return cb();
    var existing = document.querySelector('script[src="/js/nav-config.js"]');
    if (existing) { existing.addEventListener('load', cb); return; }
    var s = document.createElement('script');
    s.src = '/js/nav-config.js';
    s.onload = cb;
    document.head.appendChild(s);
  }

  ready(function () {
    const nav = document.createElement('nav');
    nav.className = 'crm-nav';
    nav.setAttribute('hidden', '');           // FOUC: escondida até aplicar roles
    nav.innerHTML = `
      <div class="logo"><span>CRM <span>AMA</span></span></div>
      ${window.CRMNav.buildItemsHTML('link', activePage)}
      <button class="nav-btn theme-btn" onclick="window._sharedNavToggleTheme()">
        <span id="shared-theme-icon">🌙</span>
        <span id="shared-theme-label">Modo escuro</span>
      </button>
      <div id="shared-nav-version" style="font-size:10.5px;color:var(--muted);text-align:center;padding:6px 4px 2px;opacity:.6;letter-spacing:.02em">—</div>
    `;

    // ── MONTAR LAYOUT ──────────────────────────────────────────────────────────
    document.body.classList.add('crm-shell');
    document.body.insertBefore(nav, document.body.firstChild);

    const content = document.createElement('div');
    content.className = 'crm-content';
    while (nav.nextSibling) content.appendChild(nav.nextSibling);
    document.body.appendChild(content);

    // Recursos compartilhados: busca, colapso, a11y
    window.CRMNav.initFeatures(nav, { context: 'shared' });

    // ── TEMA ───────────────────────────────────────────────────────────────────
    function applyTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      const icon = document.getElementById('shared-theme-icon');
      const label = document.getElementById('shared-theme-label');
      if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
      if (label) label.textContent = theme === 'dark' ? 'Modo claro' : 'Modo escuro';
    }
    window._sharedNavToggleTheme = function () {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      localStorage.setItem('crm-theme', next);
      applyTheme(next);
    };
    applyTheme(localStorage.getItem('crm-theme') || 'dark');

    // ── ROLES (esconde itens sem permissão; só então revela a sidebar) ──────────
    let revealed = false;
    const revealOnce = () => { if (!revealed) { revealed = true; nav.removeAttribute('hidden'); } };
    setTimeout(revealOnce, 1500); // fallback: nunca deixa a sidebar invisível

    async function applyRoles() {
      try {
        const k = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
        if (!k) return;
        const parsed = JSON.parse(localStorage.getItem(k));
        const token = parsed?.access_token ?? null;
        if (!token) return;

        const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const user = await res.json();
        const roles = Array.isArray(user.roles) ? user.roles : [];
        const canSee = (attr) => roles.includes('admin') || attr.split(',').some(r => roles.includes(r.trim()));

        nav.querySelectorAll('[data-roles]').forEach(el => {
          el.style.display = canSee(el.dataset.roles) ? '' : 'none';
        });

        _initMobileNav(user.nav_prefs ?? null, token);
      } catch (_) {} finally {
        revealOnce();
      }
    }

    function _initMobileNav(navPrefs, token) {
      var tries = 0;
      (function go() {
        if (window.MobileNav && document.querySelector('.crm-nav')) {
          window.MobileNav.init({ navSelector: '.crm-nav', activeSlug: activePage || '', navPrefs: navPrefs || null, getToken: function () { return token; } });
        } else if (tries++ < 40) { setTimeout(go, 50); }
      })();
    }

    applyRoles();

    // ── VERSÃO ─────────────────────────────────────────────────────────────────
    fetch('/api/version').then(r => r.json()).then(v => {
      const el = document.getElementById('shared-nav-version');
      if (!el) return;
      const d = new Date(v.deployedAt);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      el.textContent = `${v.commit} · ${dd}/${mm} ${hh}:${mi}`;
    }).catch(() => {});
  });
})();
