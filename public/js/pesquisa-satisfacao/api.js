// public/js/pesquisa-satisfacao/api.js
// API do módulo Pesquisa de Satisfação.
// Token: chave sb-{ref}-auth-token do localStorage (NUNCA k.includes('supabase')).
function _token() {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
      try { return JSON.parse(localStorage.getItem(k)).access_token || ''; } catch { return ''; }
    }
  }
  return '';
}

// Retry 1.5s/3s em 5xx — padrão das páginas principais do CRM.
async function _fetch(url, opts = {}, tentativa = 0) {
  const delays = [1500, 3000];
  const r = await fetch(url, {
    ...opts,
    headers: { 'Authorization': 'Bearer ' + _token(), 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (r.status === 401) { location.href = '/'; return; }
  if (r.status >= 500 && tentativa < delays.length) {
    await new Promise(res => setTimeout(res, delays[tentativa]));
    return _fetch(url, opts, tentativa + 1);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  return data;
}

async function listarPesquisas(from, to) {
  return _fetch('/api/pesquisa-satisfacao?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to));
}

async function dispararHoje() {
  return _fetch('/api/pesquisa-satisfacao/disparar', { method: 'POST' });
}

window.PesquisaSatisfacaoAPI = { listarPesquisas, dispararHoje };
