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
async function listarConferencia(status) {
  const r = await fetch(`/api/comercial/conferencia?status=${status || 'pendente'}`, {
    headers: { Authorization: `Bearer ${_token()}` },
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
async function revisarConferencia(id, body) {
  const r = await fetch(`/api/comercial/conferencia/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token()}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
async function sincronizarClinicorp() {
  const r = await fetch('/api/admin/sync-clinicorp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${_token()}` },
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
async function syncStatus() {
  const r = await fetch('/api/admin/sync-status', {
    headers: { Authorization: `Bearer ${_token()}` },
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
window.ComercialApi = { getFunil, listarConferencia, revisarConferencia, sincronizarClinicorp, syncStatus };
