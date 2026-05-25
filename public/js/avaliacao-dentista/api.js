const BASE = '/api';
const RETRY_DELAY_MS = 5000;

function getToken() {
  try {
    const supabaseKey = Object.keys(localStorage).find(k => k.includes('supabase') && k.includes('auth'));
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
  return res.json();
}

export const get  = (path)        => request('GET',    path);
export const post = (path, body)  => request('POST',   path, body);
export const patch = (path, body) => request('PATCH',  path, body);
export const del  = (path)        => request('DELETE', path);
