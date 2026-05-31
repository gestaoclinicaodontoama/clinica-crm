// public/js/comercial/api.js
function _token() {
  for (const k in localStorage) {
    if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
      try { return JSON.parse(localStorage.getItem(k)).access_token; } catch (_) {}
    }
  }
  return null;
}
async function getFunil({ from, to, origem }) {
  const qs = new URLSearchParams({ from, to, origem: origem || 'all' });
  const r = await fetch(`/api/comercial/funil?${qs}`, {
    headers: { Authorization: `Bearer ${_token()}` },
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
window.ComercialApi = { getFunil };
