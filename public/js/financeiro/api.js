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
  if (!r.ok) { const e = await r.json().catch(() => ({})); const err = new Error(e.error || r.statusText); err.status = r.status; throw err; }
  return r.json();
}

window.FinAPI = {
  dre: (from, to) => api(`/api/financeiro/dre?from=${from}&to=${to}`),
  dreMensal: (from, to) => api(`/api/financeiro/dre-mensal?from=${from}&to=${to}`),
  lancamentos: (q = {}) => api('/api/financeiro/lancamentos?' + new URLSearchParams(q)),
  aCategorizar: (q = {}) => api('/api/financeiro/a-categorizar?' + new URLSearchParams(q)),
  aCategorizarResumo: () => api('/api/financeiro/a-categorizar/resumo'),
  saude: () => api('/api/financeiro/saude'),
  curvaDiaria: () => api('/api/financeiro/curva-diaria'),
  avaliacao: (from, to, force) => api(`/api/financeiro/avaliacao?from=${from}&to=${to}${force ? '&force=1' : ''}`),
  perguntarDRE: (from, to, pergunta) => api(`/api/financeiro/avaliacao?from=${from}&to=${to}&pergunta=${encodeURIComponent(pergunta)}`),
  classificar: (id, body) => api(`/api/financeiro/lancamentos/${id}/classificar`, { method: 'POST', body: JSON.stringify(body) }),
  contas: () => api('/api/financeiro/contas'),
  regras: () => api('/api/financeiro/regras'),
  pessoas: () => api('/api/financeiro/pessoas'),
  criarPessoa: (b) => api('/api/financeiro/pessoas', { method: 'POST', body: JSON.stringify(b) }),
  sync: () => api('/api/financeiro/sync', { method: 'POST' }),
  analiseReceita: () => api('/api/analise-receita'),
  analiseReceitaMeta: (mes, lucroAlvo) => api('/api/analise-receita/meta',
    { method: 'POST', body: JSON.stringify({ mes, lucro_alvo: lucroAlvo }) }),
  analiseReceitaSync: () => api('/api/analise-receita/sync', { method: 'POST' }),
};
