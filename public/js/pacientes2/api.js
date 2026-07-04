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

window.Pacientes2API = {
  listar: () => api('/api/pacientes2'),
  dentistas: () => api('/api/pacientes2/dentistas'),
  config: () => api('/api/pacientes/config'),
  atualizar: (id, body) => api('/api/pacientes/' + id, { method: 'PATCH', body: JSON.stringify(body) }),
  excluir: (id) => api('/api/pacientes2/' + id, { method: 'DELETE' }),
  restaurar: (id) => api('/api/pacientes2/' + id + '/restaurar', { method: 'POST' }),
  sync: () => api('/api/admin/sync-clinicorp', { method: 'POST' }),
};
