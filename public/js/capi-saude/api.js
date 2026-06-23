// public/js/capi-saude/api.js
function _token() {
  for (const k of Object.keys(localStorage))
    if (k.startsWith('sb-') && k.endsWith('-auth-token'))
      try { return JSON.parse(localStorage.getItem(k)).access_token; } catch {}
  return null;
}
async function capiApi(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _token(), ...(opts.headers || {}) } });
  if (r.status === 401) { location.href = '/'; return; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('Erro ' + r.status));
  return j;
}
window.capiApi = capiApi;
