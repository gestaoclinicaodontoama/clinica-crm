/**
 * nav-config.js — FONTE ÚNICA DA SIDEBAR DO CRM
 * ------------------------------------------------------------------
 * Define a estrutura do menu lateral UMA ÚNICA VEZ. Tanto o index.html
 * (SPA, usa setPage) quanto as páginas separadas (shared-nav.js, usam
 * links) renderizam a partir daqui. Assim os dois navs param de divergir.
 *
 * Para adicionar/alterar um item de menu, edite APENAS o array CRM_NAV abaixo.
 *
 * Campos de um item:
 *   slug   — identificador único (vira data-page no SPA / data-active nas páginas)
 *   label  — texto exibido
 *   icon   — nome do ícone (top-level). Subitens não usam ícone.
 *   roles  — string CSV de roles que veem o item ('admin' sempre vê)
 *   mode   — 'spa'  → no index vira botão setPage(); nas páginas vira link /?page=slug
 *            'link' → âncora com href em todos os contextos
 *   href   — destino (para mode 'link')
 *   badge  — opcional { id, cls } cria <span> de badge (atualizado pelo index)
 *
 * Seção:
 *   id, label, icon, roles, items:[...]
 */
(function () {
  // ── ÍCONES (distintos por área p/ facilitar o scan) ────────────────────────
  const PATHS = {
    dashboard:     '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    kanban:        '<rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="4" height="8" rx="1"/>',
    comercial:     '<path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/>',
    sucesso:       '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    pos:           '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    funil:         '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
    disparos:      '<path d="M22 2L11 13"/><path d="M22 2L15 22 11 13 2 9l20-7z"/>',
    publicos:      '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    admin:         '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    dentista:      '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    relatorios:    '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
    tarefas:       '<path d="M9 11l3 3L22 4"/><rect x="3" y="3" width="18" height="18" rx="2"/>',
    tarefasGestao: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6"/><path d="M9 16h4"/>',
    financeiro:    '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    producao:      '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
    config:        '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    marketing:     '<path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/>',
    equipe:        '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  };
  const ARROW = '<svg class="nav-arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l4 4 4-4"/></svg>';
  function ic(name) {
    return '<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + (PATHS[name] || '') + '</svg>';
  }

  // ── ESTRUTURA CANÔNICA DO MENU ─────────────────────────────────────────────
  const ALL = 'admin,gestor,crc_leads,crc_comercial,crc_sucesso,crc_pos_tratamento';
  const CRM_NAV = [

    { slug: 'painel-gestor', label: 'Painel do Gestor', icon: 'dashboard', roles: 'admin,gestor', mode: 'spa' },

    { id: 'crc-leads', label: 'CRC de Leads', icon: 'kanban', roles: 'admin,gestor,crc_leads,crc_comercial', items: [
      { slug: 'kanban-leads',      label: 'Kanban Leads',       roles: 'admin,crc,crc_leads,crc_comercial,mod_kanban_leads', mode: 'link', href: '/kanban-leads/' },
      { slug: 'conv-agendamentos', label: 'WhatsApp CRC Lead',  roles: 'admin,gestor,crc_leads,crc_comercial,crc_sucesso',    mode: 'spa' },
      { slug: 'monitor-crc',       label: 'Monitor Diário',     roles: 'admin,gestor,crc_leads',                              mode: 'link', href: '/monitor-crc/' },
    ]},

    { id: 'crc-comercial', label: 'CRC Comercial', icon: 'comercial', roles: 'admin,gestor,crc_comercial', items: [
      { slug: 'meu-dia',           label: '📅 Meu Dia',             roles: 'admin,gestor,crc_comercial',                   mode: 'link', href: '/meu-dia/' },
      { slug: 'kanban-comercial',  label: 'Kanban Comercial',       roles: 'admin,crc,crc_comercial,mod_kanban_comercial', mode: 'link', href: '/kanban-comercial/' },
      { slug: 'comercial',         label: 'Comercial',              roles: 'admin,gestor,crc_comercial',                   mode: 'link', href: '/comercial/' },
      { slug: 'conferencia',       label: 'Conferência',            roles: 'admin,gestor,crc_comercial',                   mode: 'link', href: '/comercial/conferencia/' },
      { slug: 'comercial-monitor', label: 'Monitor CRM Novo',       roles: 'admin,gestor,crc_comercial',                   mode: 'link', href: '/comercial/monitor.html' },
      { slug: 'conv-avaliacao',    label: 'WhatsApp CRC Comercial', roles: 'admin,gestor,crc_comercial,crc_sucesso',        mode: 'spa' },
    ]},

    { id: 'marketing', label: 'Marketing', icon: 'marketing', roles: 'admin,gestor,crc_leads,crc_comercial,crc_sucesso,mod_publicos,mod_social_media', items: [
      { slug: 'funil',               label: 'Funil',                roles: 'admin,gestor,crc_leads,crc_comercial,crc_sucesso', mode: 'spa' },
      { slug: 'comercial-dashboard', label: 'Dashboard Comercial',  roles: 'admin,gestor,crc_comercial',                      mode: 'link', href: '/comercial/dashboard.html' },
      { slug: 'disparos',            label: 'Disparos',             roles: 'admin,gestor,crc_comercial',                      mode: 'spa', badge: { id: 'nav-disp-badge', inline: true } },
      { slug: 'conv-oficial',        label: 'WhatsApp API Oficial', roles: 'admin,gestor',                                    mode: 'spa' },
      { slug: 'publicos',            label: 'Públicos',             roles: 'admin,gestor,crc_comercial,mod_publicos',          mode: 'link', href: '/publicos/' },
      { slug: 'capi-saude',          label: 'Saúde do CAPI',        roles: 'admin,gestor',                                    mode: 'link', href: '/capi-saude/' },
      { slug: 'sync-saude',          label: 'Saúde dos Syncs',      roles: 'admin,gestor',                                    mode: 'link', href: '/sync-saude/' },
      { slug: 'marketing-agente',    label: 'Agente de Marketing',  roles: 'admin,gestor',                                    mode: 'link', href: '/marketing-agente/' },
      { slug:'social-media', label:'Social Media', roles:'admin,gestor,mod_social_media', mode:'link', href:'/social-media/' },
    ]},

    { id: 'crc-sucesso', label: 'CRC Sucesso do Cliente', icon: 'sucesso', roles: 'admin,gestor,crc_sucesso,crc_comercial', items: [
      { slug: 'pacientes',      label: 'Pacientes',            roles: 'crc_sucesso,crc_comercial,gestor,admin',          mode: 'link', href: '/pacientes/' },
      { slug: 'pacientes-2',    label: 'Pacientes 2 (beta)',   roles: 'crc_sucesso,crc_comercial,gestor,admin',          mode: 'link', href: '/pacientes-2/' },
      { slug: 'pacientes-busca', label: 'Buscar Paciente 360º', roles: 'crc_sucesso,crc_comercial,crc_leads,gestor,admin', mode: 'link', href: '/pacientes-busca/' },
    ]},

    { id: 'pos', label: 'CRC Pós Tratamento', icon: 'pos', roles: 'admin,gestor,crc_sucesso,crc_pos_tratamento', items: [
      { slug: 'aniversariantes', label: 'Aniversariantes', roles: 'admin,gestor,crc_sucesso,crc_pos_tratamento', mode: 'link', href: '/pos-tratamento/aniversariantes.html', badge: { id: 'badge-aniv', cls: 'badge-nav badge-nav--green' } },
      { slug: 'curva-abc',       label: 'Curva ABC / Prevenção', roles: 'admin,gestor,crc_sucesso,crc_pos_tratamento', mode: 'link', href: '/pos-tratamento/curva-abc.html' },
    ]},

    { divider: true, roles: 'admin,gestor,financeiro,mod_financeiro,mod_producao,dentista,mod_avaliacao_dentista,crc_comercial' },

    { id: 'producao', label: 'Clínica / Produção', icon: 'producao', roles: 'admin,gestor,financeiro,mod_financeiro,mod_producao,dentista,mod_avaliacao_dentista,crc_comercial', items: [
      { slug: 'avaliacao-dentista', label: 'Avaliação Dentista',   roles: 'gestor,dentista,admin,mod_avaliacao_dentista,crc_comercial', mode: 'link', href: '/avaliacao-dentista/' },
      { slug: 'producao',           label: 'Receita × Entrega',    roles: 'financeiro,mod_financeiro,mod_producao',                    mode: 'link', href: '/producao/' },
      { slug: 'producao-dentista',  label: 'Análise por Dentista', roles: 'financeiro,mod_financeiro,mod_producao',                    mode: 'link', href: '/producao/dentista/' },
    ]},

    { id: 'financeiro-sec', label: 'Financeiro', icon: 'financeiro', roles: 'admin,gestor,financeiro,auxiliar_adm,mod_notas_fiscais,mod_inadimplentes,mod_financeiro', items: [
      { slug: 'financeiro',    label: 'Financeiro (DRE)', roles: 'financeiro,mod_financeiro',                      mode: 'link', href: '/financeiro/' },
      { slug: 'financeiro-saude', label: 'A Receber / A Pagar', roles: 'financeiro,mod_financeiro', mode: 'link', href: '/financeiro/saude/' },
      { slug: 'analise-receita', label: 'Análise de Receita', roles: 'admin,gestor', mode: 'link', href: '/financeiro/receita/' },
      { slug: 'inadimplentes', label: 'Inadimplentes',    roles: 'admin,gestor,auxiliar_adm,mod_inadimplentes',    mode: 'spa', badge: { id: 'badge-inadimplentes', cls: 'inad-nav-badge' } },
      { slug: 'notas-fiscais', label: 'Notas Fiscais',    roles: 'admin,gestor,auxiliar_adm,mod_notas_fiscais',    mode: 'spa' },
    ]},

    { divider: true, roles: ALL },

    { id: 'equipe', label: 'Equipe / Operação', icon: 'equipe', roles: ALL, items: [
      { slug: 'tarefas',        label: 'Tarefas',           roles: ALL,            mode: 'link', href: '/tarefas/' },
      { slug: 'tarefas-gestao', label: 'Gestão de Tarefas', roles: 'admin,gestor', mode: 'link', href: '/tarefas/gestao.html' },
      { slug: 'ligacoes',       label: 'Ligações',          roles: 'gestor,admin', mode: 'link', href: '/ligacoes' },
    ]},

    { divider: true, roles: 'admin,gestor' },

    { id: 'config-geral', label: 'Configurações', icon: 'config', roles: 'admin,gestor', items: [
      { slug: 'config',   label: 'Configurações', roles: 'admin,gestor', mode: 'spa' },
      { slug: 'usuarios', label: 'Usuários',      roles: 'admin',        mode: 'spa', id: 'nav-usuarios' },
      { slug: 'funcoes',  label: 'Funções',       roles: 'admin',        mode: 'link', href: '/admin/funcoes/' },
    ]},
  ];

  // ── HELPERS DE RENDER ──────────────────────────────────────────────────────
  function badgeHTML(b) {
    if (!b) return '';
    if (b.inline) return ` <span id="${b.id}" style="display:none;color:var(--red);font-weight:700">•</span>`;
    return ` <span class="${b.cls}" id="${b.id}"></span>`;
  }

  // Subitem. ctx = 'spa' (index) | 'link' (páginas separadas)
  function subitemHTML(item, ctx, activeSlug) {
    const isSpa = item.mode === 'spa';
    const active = activeSlug && activeSlug === item.slug ? ' active' : '';
    const idAttr = item.id ? ` id="${item.id}"` : '';
    if (ctx === 'spa' && isSpa) {
      return `<button class="nav-subitem${active}"${idAttr} data-page="${item.slug}" data-roles="${item.roles}" onclick="setPage('${item.slug}',this)">${item.label}${badgeHTML(item.badge)}</button>`;
    }
    const href = isSpa ? `/?page=${item.slug}` : item.href;
    return `<a class="nav-subitem${active}"${idAttr} href="${href}" data-roles="${item.roles}">${item.label}${badgeHTML(item.badge)}</a>`;
  }

  // Item de topo
  function topItemHTML(item, ctx, activeSlug) {
    const isSpa = item.mode === 'spa';
    const active = activeSlug && activeSlug === item.slug ? ' active' : '';
    if (ctx === 'spa' && isSpa) {
      return `<button class="nav-btn${active}" data-page="${item.slug}" data-roles="${item.roles}" onclick="setPage('${item.slug}',this)">${ic(item.icon)} ${item.label}${badgeHTML(item.badge)}</button>`;
    }
    const href = isSpa ? `/?page=${item.slug}` : item.href;
    return `<a class="nav-btn${active}" href="${href}" data-roles="${item.roles}">${ic(item.icon)} ${item.label}${badgeHTML(item.badge)}</a>`;
  }

  // Seção (colapsável)
  function sectionHTML(sec, ctx, activeSlug) {
    const subPrefix = ctx === 'spa' ? 'submenu-' : 'snav-sub-';
    const secPrefix = ctx === 'spa' ? 'nav-section-' : 'snav-section-';
    const arrowId = ctx === 'spa' ? ` id="arrow-${sec.id}"` : '';
    const subId = subPrefix + sec.id;
    const subItems = sec.items.map(it => subitemHTML(it, ctx, activeSlug)).join('');
    // estado inicial: aberto se contém o item ativo
    const hasActive = activeSlug && sec.items.some(it => it.slug === activeSlug);
    const lsOpen = (function () { try { return localStorage.getItem('crm-nav-' + sec.id) === 'open'; } catch (e) { return false; } })();
    const open = hasActive || lsOpen;
    const display = open ? 'flex' : 'none';
    const arrowOpen = open ? ' style="transform:rotate(180deg)"' : '';

    let toggle;
    if (ctx === 'spa') {
      toggle = `onclick="toggleNavSection('${sec.id}')"`;
    } else {
      toggle = `onclick="window._crmNavToggleSection('${sec.id}',this)"`;
    }
    const arrow = `<svg class="nav-arrow"${arrowId} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="margin-left:auto;width:12px;height:12px;transition:transform .2s${arrowOpen ? ';transform:rotate(180deg)' : ''}"><path d="M4 6l4 4 4-4"/></svg>`;

    return `<div class="nav-section" id="${secPrefix}${sec.id}" data-roles="${sec.roles}">
      <button class="nav-btn nav-btn--section" aria-expanded="${open}" ${toggle}>${ic(sec.icon)} ${sec.label}${arrow}</button>
      <div class="nav-submenu" id="${subId}" style="display:${display};flex-direction:column">${subItems}</div>
    </div>`;
  }

  // Constrói o HTML completo dos ITENS (sem o chrome).
  // ctx: 'spa' (index.html) | 'link' (shared-nav.js)
  function buildItemsHTML(ctx, activeSlug) {
    return CRM_NAV.map(entry => {
      if (entry.divider) return `<div class="nav-divider" data-roles="${entry.roles}"></div>`;
      if (entry.items) return sectionHTML(entry, ctx, activeSlug);
      return topItemHTML(entry, ctx, activeSlug);
    }).join('\n');
  }

  // ── CSS DOS RECURSOS NOVOS (busca, colapso, divisória) ─────────────────────
  function injectFeatureCSS() {
    if (document.getElementById('crm-nav-feat-css')) return;
    const s = document.createElement('style');
    s.id = 'crm-nav-feat-css';
    s.textContent = `
      .nav-divider { height:1px; background:var(--border); margin:6px 4px; }
      .nav-search-wrap { padding:2px 2px 8px; position:relative; }
      .nav-search { width:100%; box-sizing:border-box; padding:7px 10px 7px 30px; font-size:12.5px;
        border:1px solid var(--border); border-radius:8px; background:var(--bg3); color:var(--text);
        outline:none; font-family:inherit; }
      .nav-search::placeholder { color:var(--muted); }
      .nav-search:focus { border-color:var(--accent); }
      .nav-search-wrap svg { position:absolute; left:11px; top:50%; transform:translateY(-50%);
        width:13px; height:13px; color:var(--muted); pointer-events:none; }
      .nav-hidden-search { display:none !important; }
      .nav-no-results { font-size:12px; color:var(--muted); text-align:center; padding:10px; display:none; }
      /* botão recolher / rail de ícones */
      .nav-collapse-btn { background:none; border:none; cursor:pointer; color:var(--muted);
        padding:4px; border-radius:8px; display:flex; align-items:center; transition:opacity .15s; }
      .nav-collapse-btn:hover { color:var(--text); background:var(--bg3); }
      body.nav-collapsed nav, body.nav-collapsed .crm-nav { width:60px !important; min-width:60px !important; }
      body.nav-collapsed .nav-btn, body.nav-collapsed .nav-subitem { justify-content:center; }
      body.nav-collapsed .nav-btn > :not(.nav-icon):not(svg),
      body.nav-collapsed .nav-btn--section,
      body.nav-collapsed .nav-submenu,
      body.nav-collapsed .nav-search-wrap,
      body.nav-collapsed .logo span:last-child,
      body.nav-collapsed .theme-btn span:last-child,
      body.nav-collapsed #nav-version, body.nav-collapsed #shared-nav-version,
      body.nav-collapsed #nav-clinicorp,
      body.nav-collapsed .nav-btn .nav-arrow,
      body.nav-collapsed .badge-nav, body.nav-collapsed .inad-nav-badge { display:none !important; }
      body.nav-collapsed .nav-btn span:not(.nav-icon) { display:none; }
      body.nav-collapsed .logo { justify-content:center; padding-left:0; padding-right:0; }
    `;
    document.head.appendChild(s);
  }

  // ── BUSCA + COLAPSO + A11Y (usado por ambos os contextos) ──────────────────
  function initFeatures(navEl, opts) {
    opts = opts || {};
    if (!navEl || navEl.dataset.featReady) return;
    navEl.dataset.featReady = '1';
    injectFeatureCSS();

    // ---- Busca rápida ----
    const wrap = document.createElement('div');
    wrap.className = 'nav-search-wrap';
    wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
      <input class="nav-search" type="text" placeholder="Buscar no menu…" aria-label="Buscar no menu">`;
    const noRes = document.createElement('div');
    noRes.className = 'nav-no-results';
    noRes.textContent = 'Nada encontrado';

    // insere logo após o logo (primeiro filho que tiver classe logo) ou no topo
    const logo = navEl.querySelector('.logo');
    if (logo && logo.nextSibling) navEl.insertBefore(wrap, logo.nextSibling);
    else navEl.insertBefore(wrap, navEl.firstChild);
    wrap.insertAdjacentElement('afterend', noRes);

    const input = wrap.querySelector('.nav-search');
    const _diacritics = new RegExp('[\\u0300-\\u036f]', 'g');
    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(_diacritics, '');
    input.addEventListener('input', () => {
      const q = norm(input.value.trim());
      const sections = navEl.querySelectorAll('.nav-section');
      let anyTop = false;
      // itens de topo simples
      navEl.querySelectorAll(':scope > .nav-btn').forEach(btn => {
        if (btn.classList.contains('nav-logout') || btn.classList.contains('theme-btn')) return;
        const match = !q || norm(btn.textContent).includes(q);
        btn.classList.toggle('nav-hidden-search', !match);
        if (match) anyTop = true;
      });
      navEl.querySelectorAll('.nav-divider').forEach(d => d.classList.toggle('nav-hidden-search', !!q));
      sections.forEach(sec => {
        const subs = sec.querySelectorAll('.nav-subitem');
        let anySub = false;
        subs.forEach(s => {
          const match = !q || norm(s.textContent).includes(q);
          s.classList.toggle('nav-hidden-search', !match);
          if (match) anySub = true;
        });
        const sub = sec.querySelector('.nav-submenu');
        sec.classList.toggle('nav-hidden-search', q && !anySub);
        if (q && anySub && sub) { sub.style.display = 'flex'; }
        if (anySub) anyTop = true;
      });
      noRes.style.display = q && !anyTop ? 'block' : 'none';
    });

    // ---- Botão recolher (rail de ícones) ----
    const themeBtn = navEl.querySelector('.theme-btn');
    if (themeBtn) {
      const collapsed = (function () { try { return localStorage.getItem('crm-nav-collapsed') === '1'; } catch (e) { return false; } })();
      if (collapsed) document.body.classList.add('nav-collapsed');
      const cb = document.createElement('button');
      cb.className = 'nav-collapse-btn';
      cb.title = 'Recolher menu';
      cb.setAttribute('aria-label', 'Recolher menu');
      cb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="15 18 9 12 15 6"/></svg>`;
      cb.onclick = function () {
        const now = document.body.classList.toggle('nav-collapsed');
        try { localStorage.setItem('crm-nav-collapsed', now ? '1' : '0'); } catch (e) {}
        cb.querySelector('polyline').setAttribute('points', now ? '9 18 15 12 9 6' : '15 18 9 12 15 6');
      };
      if (collapsed) cb.querySelector('polyline').setAttribute('points', '9 18 15 12 9 6');
      // coloca o botão dentro do logo (canto)
      if (logo) logo.appendChild(cb);
      else navEl.insertBefore(cb, navEl.firstChild);
    }

    // ---- A11y: aria-current no item ativo ----
    navEl.querySelectorAll('.nav-btn.active,.nav-subitem.active').forEach(el => el.setAttribute('aria-current', 'page'));
  }

  // Toggle de seção usado pelas páginas separadas (shared-nav)
  window._crmNavToggleSection = function (id, btn) {
    const sub = document.getElementById('snav-sub-' + id);
    if (!sub) return;
    const open = sub.style.display !== 'none';
    sub.style.display = open ? 'none' : 'flex';
    const arrow = btn && btn.querySelector('.nav-arrow');
    if (arrow) arrow.style.transform = open ? '' : 'rotate(180deg)';
    if (btn) btn.setAttribute('aria-expanded', String(!open));
    try { localStorage.setItem('crm-nav-' + id, open ? 'closed' : 'open'); } catch (e) {}
  };

  // ── EXPORT ─────────────────────────────────────────────────────────────────
  window.CRMNav = {
    MENU: CRM_NAV,
    icon: ic,
    buildItemsHTML: buildItemsHTML,
    injectFeatureCSS: injectFeatureCSS,
    initFeatures: initFeatures,
  };
})();
