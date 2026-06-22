/**
 * shared-nav.js
 * Injeta a sidebar do CRM em páginas separadas (fora do index.html).
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
    }
    .crm-nav .logo { font-size: 18px; font-weight: 700; padding: 6px 12px 22px; letter-spacing: -.4px; }
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
    .crm-nav .nav-arrow.open { transform: rotate(180deg); }
    .crm-nav .nav-divider { height: 1px; background: var(--border); margin: 6px 4px; }
    .crm-nav .theme-btn {
      margin-top: auto; padding: 9px 12px; background: var(--bg3); color: var(--text);
      border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500;
      display: flex; align-items: center; justify-content: center; gap: 8px; transition: all .15s; width: 100%;
    }
    .crm-nav .theme-btn:hover { background: var(--border); }
    .crm-content { flex: 1; min-height: 100vh; overflow-x: hidden; overflow-y: auto; }
  `;
  document.head.appendChild(style);

  // ── ICONS ───────────────────────────────────────────────────────────────────
  const IC = {
    dashboard: `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
    funil:     `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>`,
    disparos:  `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2L15 22 11 13 2 9l20-7z"/></svg>`,
    kanban:    `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="4" height="8" rx="1"/></svg>`,
    whatsapp:  `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    comercial: `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg>`,
    pacientes: `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><path d="M12 11v4"/><path d="M10 13h4"/></svg>`,
    pos:       `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z"/><path d="M8 4v4l2.5 2.5"/></svg>`,
    inad:      `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    nf:        `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
    dentista:  `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
    ligacoes:  `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.8a19.79 19.79 0 01-3.07-8.64A2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14.92v2z"/></svg>`,
    atrib:     `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
    tarefas:   `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`,
    config:    `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    arrow:     `<svg class="nav-arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l4 4 4-4"/></svg>`,
  };

  // ── HELPERS ─────────────────────────────────────────────────────────────────
  function link(href, roles, slug, icon, label) {
    const isActive = activePage === slug ? ' active' : '';
    return `<a class="nav-subitem${isActive}" href="${href}" data-roles="${roles}">${icon}${label}</a>`;
  }

  function section(id, roles, icon, label, items, defaultOpen) {
    const lsKey = 'crm-nav-' + id;
    const isOpen = defaultOpen || localStorage.getItem(lsKey) === 'open';
    const arrowClass = isOpen ? ' open' : '';
    const subDisplay = isOpen ? '' : 'none';
    return `
      <div class="nav-section" data-roles="${roles}" id="snav-section-${id}">
        <button class="nav-btn nav-btn--section" onclick="(function(id){
          const sub=document.getElementById('snav-sub-'+id);
          const arrow=document.querySelector('#snav-section-'+id+' .nav-arrow');
          const open=sub.style.display!=='none';
          sub.style.display=open?'none':'';
          if(arrow)arrow.classList.toggle('open',!open);
          try{localStorage.setItem('crm-nav-'+id,open?'closed':'open');}catch(e){}
        })('${id}')" data-roles="${roles}">
          ${icon}${label}${IC.arrow.replace('class="nav-arrow"',`class="nav-arrow${arrowClass}"`)}
        </button>
        <div class="nav-submenu" id="snav-sub-${id}" style="display:${subDisplay}">${items}</div>
      </div>`;
  }

  // ── NAV HTML ────────────────────────────────────────────────────────────────
  const nav = document.createElement('nav');
  nav.className = 'crm-nav';
  nav.innerHTML = `
    <div class="logo">CRM <span>AMA</span></div>

    <a class="nav-btn${activePage==='dashboard'?' active':''}" href="/"
      data-roles="admin,gestor,crc_leads,crc_comercial,crc_sucesso,crc_pos_tratamento">
      ${IC.dashboard} Dashboard
    </a>

    <a class="nav-btn${activePage==='tarefas'?' active':''}" href="/tarefas/"
      data-roles="admin,gestor,crc_leads,crc_comercial,crc_sucesso,crc_pos_tratamento">
      ${IC.tarefas} Tarefas
    </a>

    <a class="nav-btn${activePage==='tarefas-gestao'?' active':''}" href="/tarefas/gestao.html"
      data-roles="admin,gestor">
      ${IC.tarefas} Gestão de Tarefas
    </a>

    ${section('crc-leads','admin,gestor,crc_leads,crc_comercial',IC.kanban,'CRC de Leads',
      link('/kanban-leads/','admin,crc,crc_leads,crc_comercial,mod_kanban_leads','kanban-leads',IC.kanban,'Kanban Leads') +
      link('/','admin,gestor,crc_leads,crc_comercial,crc_sucesso','conv-agendamentos',IC.whatsapp,'WhatsApp CRC Lead') +
      link('/','admin,gestor','conv-oficial',IC.whatsapp,'WhatsApp API Oficial') +
      link('/monitor-crc/','admin,gestor,crc_leads','monitor-crc',IC.dashboard,'Monitor Diario')
    )}

    ${section('crc-comercial','admin,gestor,crc_comercial',IC.comercial,'CRC Comercial',
      link('/comercial/','admin,gestor,crc_comercial','comercial',IC.comercial,'Comercial') +
      link('/comercial/dashboard.html','admin,gestor,crc_comercial','comercial-dashboard',IC.comercial,'Dashboard') +
      link('/comercial/monitor.html','admin,gestor,crc_comercial','comercial-monitor',IC.comercial,'Monitor CRM Novo') +
      link('/kanban-comercial/','admin,crc,crc_comercial,mod_kanban_comercial','kanban-comercial',IC.kanban,'Kanban Comercial') +
      link('/','admin,gestor,crc_comercial,crc_sucesso','conv-avaliacao',IC.whatsapp,'WhatsApp CRC Comercial') +
      link('/comercial/conferencia/','admin,gestor,crc_comercial','conferencia',IC.dentista,'Conferência')
    )}

    ${section('crc-sucesso','admin,gestor,crc_sucesso,crc_comercial',IC.pacientes,'CRC Sucesso do Cliente',
      link('/pacientes/','crc_sucesso,crc_comercial,gestor,admin','pacientes',IC.pacientes,'Pacientes')
    )}

    ${section('crc-pos','admin,gestor,crc_sucesso,crc_pos_tratamento',IC.pos,'CRC Pós Tratamento',
      link('/pos-tratamento/aniversariantes.html','admin,gestor,crc_sucesso,crc_pos_tratamento','aniversariantes','','Aniversariantes') +
      link('/pos-tratamento/recall.html','admin,gestor,crc_sucesso,crc_pos_tratamento','recall','','Recall') +
      link('/pos-tratamento/vips.html','admin,gestor,crc_sucesso,crc_pos_tratamento','vips','','VIPs')
    )}

    <div class="nav-divider" data-roles="admin,gestor,crc_leads,crc_comercial,crc_sucesso"></div>

    <a class="nav-btn${activePage==='funil'?' active':''}" href="/"
      data-roles="admin,gestor,crc_leads,crc_comercial,crc_sucesso">
      ${IC.funil} Funil
    </a>

    <a class="nav-btn${activePage==='disparos'?' active':''}" href="/"
      data-roles="admin,gestor,crc_comercial">
      ${IC.disparos} Disparos
    </a>

    <div class="nav-divider" data-roles="admin,gestor,auxiliar_adm,mod_notas_fiscais,mod_inadimplentes"></div>

    ${section('admin','admin,gestor,auxiliar_adm,mod_notas_fiscais,mod_inadimplentes',IC.nf,'Administrativo',
      link('/#inadimplentes','admin,gestor,auxiliar_adm,mod_inadimplentes','inadimplentes',IC.inad,'Inadimplentes') +
      link('/#notas-fiscais','admin,gestor,auxiliar_adm,mod_notas_fiscais','notas-fiscais',IC.nf,'Notas Fiscais')
    )}

    ${section('dentistas','admin,gestor,dentista,mod_avaliacao_dentista,crc_comercial',IC.dentista,'Dentistas',
      link('/avaliacao-dentista/','admin,gestor,dentista,mod_avaliacao_dentista,crc_comercial','avaliacao-dentista',IC.dentista,'Avaliação Dentista')
    )}

    ${section('relatorios','admin,gestor',IC.atrib,'Relatórios',
      link('/ligacoes','admin,gestor','ligacoes',IC.ligacoes,'Ligações') +
      link('/atribuicao/','admin,gestor','atribuicao',IC.atrib,'Atribuição')
    )}

    <a class="nav-btn${activePage==='financeiro'?' active':''}" href="/financeiro/"
      data-roles="financeiro,mod_financeiro">
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg>
      Financeiro
    </a>

    ${section('producao','financeiro,mod_financeiro,mod_producao',
      `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>`,
      'Receita × Entrega',
      link('/producao/','financeiro,mod_financeiro,mod_producao','producao','','Visão Geral') +
      link('/producao/dentista/','financeiro,mod_financeiro,mod_producao','producao-dentista','','Análise por Dentista'),
      activePage === 'producao' || activePage === 'producao-dentista'
    )}

    ${section('config','admin,gestor',IC.config,'Configurações Gerais',
      link('/','admin,gestor','config',IC.config,'Configurações') +
      link('/','admin','usuarios',`<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,'Usuários') +
      link('/admin/funcoes/','admin','funcoes',`<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,'Funções')
    )}

    <button class="nav-btn theme-btn" onclick="window._sharedNavToggleTheme()">
      <span id="shared-theme-icon">🌙</span>
      <span id="shared-theme-label">Modo escuro</span>
    </button>
    <div id="shared-nav-version" style="font-size:10.5px;color:var(--muted);text-align:center;padding:6px 4px 2px;opacity:.6;letter-spacing:.02em">—</div>
  `;

  // ── MONTAR LAYOUT ────────────────────────────────────────────────────────────
  document.body.classList.add('crm-shell');
  document.body.insertBefore(nav, document.body.firstChild);

  const content = document.createElement('div');
  content.className = 'crm-content';
  while (nav.nextSibling) content.appendChild(nav.nextSibling);
  document.body.appendChild(content);

  // Auto-expande seção que contém a página ativa
  function autoExpandActive() {
    const activeSubitem = nav.querySelector('.nav-subitem.active');
    if (!activeSubitem) return;
    const sub = activeSubitem.closest('.nav-submenu');
    if (!sub) return;
    sub.style.display = '';
    const arrow = sub.previousElementSibling?.querySelector('.nav-arrow');
    if (arrow) arrow.classList.add('open');
    const sectionId = sub.id?.replace('snav-sub-', '');
    if (sectionId) { try { localStorage.setItem('crm-nav-' + sectionId, 'open'); } catch(e) {} }
  }
  autoExpandActive();

  // ── TEMA ────────────────────────────────────────────────────────────────────
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

  // ── ROLES ────────────────────────────────────────────────────────────────────
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
    } catch (_) {}
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

  // ── VERSÃO ──────────────────────────────────────────────────────────────────
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
})();
