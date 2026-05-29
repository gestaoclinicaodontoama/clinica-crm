'use strict';
const { apiRequest } = require('./3cplus');

const THREEC_TOKEN = () => process.env.THREEC_TOKEN || '';

// ── Gestor token ─────────────────────────────────────────────────────

async function uploadMailing(campaignId, contacts) {
  // contacts: [{nome, telefone}]
  // Alternativa se recusar JSON: converter para CSV internamente
  const r = await apiRequest('POST', `/api/v1/campaigns/${campaignId}/mailing`, contacts, THREEC_TOKEN());
  if (r.status < 200 || r.status >= 300) {
    const err = new Error(`3cplus uploadMailing: status ${r.status} — ${r.body.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  return r;
}

async function pausarCampanha(campaignId) {
  const r = await apiRequest('POST', `/api/v1/campaigns/${campaignId}/pause`, null, THREEC_TOKEN());
  if (r.status < 200 || r.status >= 300) {
    const err = new Error(`3cplus pausar: status ${r.status} — ${r.body.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  return r;
}

async function retomarCampanha(campaignId) {
  const r = await apiRequest('POST', `/api/v1/campaigns/${campaignId}/resume`, null, THREEC_TOKEN());
  if (r.status < 200 || r.status >= 300) {
    const err = new Error(`3cplus retomar: status ${r.status} — ${r.body.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  return r;
}

async function encerrarCampanha(campaignId) {
  // 404 = campanha já encerrada/inexistente → trata como sucesso (idempotente)
  const r = await apiRequest('POST', `/api/v1/campaigns/${campaignId}/stop`, null, THREEC_TOKEN());
  if (r.status < 200 || (r.status >= 300 && r.status !== 404)) {
    const err = new Error(`3cplus encerrar: status ${r.status} — ${r.body.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  return r;
}

async function getCallsDaCampanha(campaignId, iniciada_em) {
  const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');
  const start = fmt(new Date(iniciada_em));
  const end = fmt(new Date());
  const params = new URLSearchParams({
    campaign_id: String(campaignId),
    start_date: start,
    end_date: end,
  });
  const r = await apiRequest('GET', `/api/v1/calls?${params}`, null, THREEC_TOKEN());
  if (r.status !== 200) {
    const err = new Error(`3cplus getCallsDaCampanha: status ${r.status}`);
    err.status = 502;
    throw err;
  }
  const parsed = JSON.parse(r.body);
  return Array.isArray(parsed?.data) ? parsed.data : [];
}

// ── Agent token ───────────────────────────────────────────────────────

async function loginCrcNaCampanha(agentToken, campaignId) {
  // Endpoint não confirmado — ajustar se retornar 404
  // Alternativa: POST /api/v1/campaigns/{id}/agents/login
  const r = await apiRequest('POST', `/api/v1/campaigns/${campaignId}/login`, null, agentToken);
  if (r.status < 200 || r.status >= 300) {
    const err = new Error(`3cplus loginCrcNaCampanha: status ${r.status} — ${r.body.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
  return r;
}

module.exports = {
  uploadMailing,
  pausarCampanha,
  retomarCampanha,
  encerrarCampanha,
  getCallsDaCampanha,
  loginCrcNaCampanha,
};
