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
