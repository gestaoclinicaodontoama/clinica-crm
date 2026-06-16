let _token = null;
function getToken() {
  if (_token) return _token;
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
      try { _token = JSON.parse(localStorage.getItem(k))?.access_token; } catch {}
    }
  }
  return _token;
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken(), ...(opts.headers || {}) },
  });
  if (r.status === 401) _token = null;
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
  return r.json();
}

window.FinAPI = {
  dre: (from, to) => api(`/api/financeiro/dre?from=${from}&to=${to}`),
  lancamentos: (q = {}) => api('/api/financeiro/lancamentos?' + new URLSearchParams(q)),
  aCategorizar: () => api('/api/financeiro/a-categorizar'),
  classificar: (id, body) => api(`/api/financeiro/lancamentos/${id}/classificar`, { method: 'POST', body: JSON.stringify(body) }),
  contas: () => api('/api/financeiro/contas'),
  regras: () => api('/api/financeiro/regras'),
  pessoas: () => api('/api/financeiro/pessoas'),
  criarPessoa: (b) => api('/api/financeiro/pessoas', { method: 'POST', body: JSON.stringify(b) }),
  sync: () => api('/api/financeiro/sync', { method: 'POST' }),
};
