const BASE = '/api';
const RETRY_DELAY_MS = 5000;

function getToken() {
  try {
    // Supabase JS v2 stores session under key "sb-{project-ref}-auth-token"
    const supabaseKey = Object.keys(localStorage).find(
      k => k.startsWith('sb-') && k.endsWith('-auth-token')
    );
    if (supabaseKey) {
      const raw = localStorage.getItem(supabaseKey);
      const parsed = JSON.parse(raw);
      return parsed?.access_token ?? parsed?.session?.access_token ?? null;
    }
  } catch (_) {}
  return null;
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

export const get  = (path)        => request('GET',    path);
export const post = (path, body)  => request('POST',   path, body);
export const patch = (path, body) => request('PATCH',  path, body);
export const del  = (path)        => request('DELETE', path);

export async function postFile(path, file) {
  const token = getToken();
  const headers = {
    'Content-Type': file.type || 'application/octet-stream',
    'X-Filename': encodeURIComponent(file.name || 'audio'),
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
