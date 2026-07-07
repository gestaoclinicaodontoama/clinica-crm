// Boilerplate de auth/refresh/retry padrão do projeto (cópia de meu-dia/api.js, que por sua vez é
// cópia de avaliacao-dentista/api.js). Carregado como <script> clássico (não módulo).
// public/js/social-media/api.js expõe `smApi(path, { method, body })` (ver adaptador no fim do arquivo).
const BASE = '/api';
const RETRY_DELAY_MS = 5000;
const _SB_URL = 'https://mtqdpjhhqzvuklnlfpvi.supabase.co';
const _SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im10cWRwamhocXp2dWtsbmxmcHZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2Nzg0MjIsImV4cCI6MjA5NDI1NDQyMn0.pNA_AwaFDoT7ReinDMB6Sz0RT_gMZO2IwbAKOq5Ypzw';

function _sbKey() {
  return Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
}

function getToken() {
  try {
    const key = _sbKey();
    if (key) {
      const parsed = JSON.parse(localStorage.getItem(key));
      return parsed?.access_token ?? parsed?.session?.access_token ?? null;
    }
  } catch (_) {}
  return null;
}

async function _refreshSession() {
  try {
    const key = _sbKey();
    if (!key) return null;
    const parsed = JSON.parse(localStorage.getItem(key));
    const refreshToken = parsed?.refresh_token;
    if (!refreshToken) return null;

    const res = await fetch(`${_SB_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': _SB_ANON },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.access_token) return null;

    localStorage.setItem(key, JSON.stringify({ ...parsed, access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at }));
    return data.access_token;
  } catch (_) {
    return null;
  }
}

async function request(method, path, body, attempt = 0) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    if (res.status === 503 && attempt === 0) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      return request(method, path, body, 1);
    }
    if (res.status === 401 && attempt === 0) {
      const newToken = await _refreshSession();
      if (newToken) return request(method, path, body, 1);
    }
    let message = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      message = data?.error ?? data?.message ?? message;
    } catch (_) {}
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  if (res.status === 204) return null;
  try {
    return await res.json();
  } catch (e) {
    const parseErr = new Error(`Resposta inválida do servidor (status ${res.status})`);
    parseErr.status = res.status;
    throw parseErr;
  }
}

const get  = (path)        => request('GET',    path);
const post = (path, body)  => request('POST',   path, body);
const patch = (path, body) => request('PATCH',  path, body);
const put  = (path, body)  => request('PUT',    path, body);
const del  = (path)        => request('DELETE', path);

async function postFile(path, file) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/octet-stream', // express.raw() needs a generic type
    'X-Audio-Content-Type': file.type || 'audio/mpeg', // real type forwarded to Deepgram
    'X-Filename': encodeURIComponent(file.name || 'audio'),
    'x-audio-filename': (file?.name || '').slice(0, 120),
    'x-audio-content-type': file?.type || 'application/octet-stream',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: file });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try { const d = await res.json(); message = d?.error ?? d?.message ?? message; } catch (_) {}
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Adaptador exportado para a página Social Media: `smApi(path)` ou `smApi(path, { method, body })`.
// Único acréscimo em relação ao boilerplate original (meu-dia/api.js não expõe nenhum global único
// com essa assinatura — apenas get/post/put/patch/del separados). Reaproveita `request` acima,
// mantendo _refreshSession/getToken/retry-503 intactos.
async function smApi(path, opts = {}) {
  const { method = 'GET', body } = opts;
  return request(method, path, body);
}
window.smApi = smApi;
