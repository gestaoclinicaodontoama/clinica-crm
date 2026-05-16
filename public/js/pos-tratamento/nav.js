(function () {
  var theme = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', theme);

  var path = window.location.pathname;
  var isAbc  = path.indexOf('curva-abc') !== -1;
  var isAniv = path.indexOf('aniversariantes') !== -1;
  var isVip  = path.indexOf('vip') !== -1;

  function sc(active) { return 'nav-subitem' + (active ? ' nav-subitem--active' : ''); }

  var nav = document.getElementById('crm-nav');
  if (!nav) return;

  nav.innerHTML = [
    '<div class="crc-logo">',
    '  <span class="crc-logo__clinic">Clinica AMA</span>',
    '  <span class="crc-logo__sub">CRC · POS-TRATAMENTO</span>',
    '</div>',
    '<div class="nav-group-label">PRINCIPAL</div>',
    '<a href="/" class="nav-subitem">',
    '  <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
    '  CRM',
    '</a>',
    '<div class="nav-group-label">CRC</div>',
    '<a href="/pos-tratamento/curva-abc.html" class="' + sc(isAbc) + '">',
    '  <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    '  Curva ABC',
    '</a>',
    '<a href="/pos-tratamento/aniversariantes.html" class="' + sc(isAniv) + '" id="nav-aniv-link">',
    '  <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    '  Aniversariantes',
    '  <span class="nav-badge hidden" id="nav-aniv-badge"></span>',
    '</a>',
    '<a href="/pos-tratamento/vips.html" class="' + sc(isVip) + '">',
    '  <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    '  VIPs',
    '</a>',
    '<button class="theme-btn" id="nav-theme-btn"><span id="theme-icon"></span><span id="theme-label"></span></button>',
  ].join('\n');

  function updateThemeBtn() {
    var cur = document.documentElement.getAttribute('data-theme');
    var icon = document.getElementById('theme-icon');
    var label = document.getElementById('theme-label');
    if (icon) icon.textContent = cur === 'dark' ? 'Sol' : 'Lua';
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

  (function loadAnivBadge() {
    var url = window.__SUPABASE_URL__;
    var key = window.__SUPABASE_ANON__;
    if (!url || !key) return;
    var today = new Date();
    var m = today.getMonth() + 1;
    var d = today.getDate();
    fetch(url + '/rest/v1/rpc/birthday_month', {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_month: m })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!Array.isArray(data)) return;
      var count = data.filter(function(p) { return p.dia_nasc === d; }).length;
      if (count > 0) {
        var badge = document.getElementById('nav-aniv-badge');
        if (badge) { badge.textContent = count + ' hoje'; badge.classList.remove('hidden'); }
      }
    }).catch(function() {});
  })();
})();