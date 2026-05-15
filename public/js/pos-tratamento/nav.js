(function () {
  var theme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  var path = window.location.pathname;
  var isAniv  = path.indexOf('aniversariantes') !== -1;
  var isRecall = path.indexOf('recall') !== -1;
  var isVip   = path.indexOf('vip') !== -1;

  function sc(active) { return 'nav-subitem' + (active ? ' nav-subitem--active' : ''); }

  var nav = document.getElementById('crm-nav');
  if (!nav) return;

  nav.innerHTML = [
    '<div class="logo">Clínica <span>CRM</span></div>',
    '<a href="/" class="nav-btn"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>Dashboard</a>',
    '<a href="/" class="nav-btn"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>Todos os Leads</a>',
    '<a href="/" class="nav-btn"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>Funil</a>',
    '<a href="/" class="nav-btn"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Conversas</a>',
    '<a href="/" class="nav-btn"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2L15 22 11 13 2 9l20-7z"/></svg>Disparos</a>',
    '<a href="/" class="nav-btn"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>Notas Fiscais</a>',
    '<a href="/" class="nav-btn"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>Inadimplentes</a>',
    '<div class="nav-section">',
    '  <button class="nav-btn nav-btn--section" id="nav-pos-toggle">',
    '    <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z"/><path d="M8 4v4l2.5 2.5"/></svg>',
    '    Pós Tratamento',
    '    <svg id="arrow-pos" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="margin-left:auto;width:12px;height:12px;transition:transform .2s;transform:rotate(180deg)"><path d="M4 6l4 4 4-4"/></svg>',
    '  </button>',
    '  <div class="nav-submenu" id="submenu-pos">',
    '    <a href="/pos-tratamento/aniversariantes.html" class="' + sc(isAniv) + '">Aniversariantes</a>',
    '    <a href="/pos-tratamento/recall.html" class="' + sc(isRecall) + '">Recall</a>',
    '    <a href="/pos-tratamento/vips.html" class="' + sc(isVip) + '">VIPs</a>',
    '  </div>',
    '</div>',
    '<a href="/" class="nav-btn"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>Configurações</a>',
    '<button class="nav-btn nav-logout" id="nav-logout-btn"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>Sair</button>',
    '<button class="theme-btn" id="nav-theme-btn"><span id="theme-icon"></span><span id="theme-label"></span></button>'
  ].join('\n');

  document.getElementById('nav-pos-toggle').addEventListener('click', function () {
    var sub = document.getElementById('submenu-pos');
    var arrow = document.getElementById('arrow-pos');
    var open = sub.style.display === 'flex';
    sub.style.display = open ? 'none' : 'flex';
    if (arrow) arrow.style.transform = open ? '' : 'rotate(180deg)';
  });

  function updateThemeBtn() {
    var cur = document.documentElement.getAttribute('data-theme');
    var icon = document.getElementById('theme-icon');
    var label = document.getElementById('theme-label');
    if (icon) icon.textContent = cur === 'dark' ? '☀️' : '🌙';
    if (label) label.textContent = cur === 'dark' ? 'Modo claro' : 'Modo escuro';
  }
  updateThemeBtn();

  document.getElementById('nav-theme-btn').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    updateThemeBtn();
  });

  document.getElementById('nav-logout-btn').addEventListener('click', function () {
    Object.keys(localStorage).filter(function (k) { return k.startsWith('sb-'); })
      .forEach(function (k) { localStorage.removeItem(k); });
    window.location.href = '/login.html';
  });
})();