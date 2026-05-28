'use strict';
const http  = require('http');
const https = require('https');

const THREEC_TOKEN = () => process.env.THREEC_TOKEN || '';
// Base URL por empresa: https://clinicaama.3c.plus (sem trailing slash)
const THREEC_BASE  = () => process.env.THREEC_BASE_URL || 'https://clinicaama.3c.plus';

function temToken() {
  return Boolean(THREEC_TOKEN());
}

// Auth: query param ?api_token=TOKEN (não Bearer header — confirmado na doc oficial)
function apiRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const url = new URL(apiPath, THREEC_BASE());
    url.searchParams.set('api_token', THREEC_TOKEN());
    const mod = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: 15000,
    };
    const req = mod.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('3cplus timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Click-to-call: cria uma chamada. A plataforma liga para o agente primeiro,
// depois conecta com o destino.
// ⚠️ Endpoint não documentado publicamente — confirmar com suporte 3cplus se /api/v1/calls está correto.
async function ligar({ agentId, numeroDestino }) {
  if (!temToken()) throw new Error('3cplus não configurado — preencha THREEC_TOKEN no .env');

  const { status, body } = await apiRequest('POST', '/api/v1/calls', {
    agent_id: agentId,
    destination: numeroDestino.replace(/\D/g, ''),
  });

  if (status !== 200 && status !== 201) {
    const err = new Error(`3cplus erro ${status}: ${body.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }

  const data = JSON.parse(body);
  // ⚠️ Confirmar nome do campo call_id na resposta real
  if (!data.call_id && !data.id) throw new Error('3cplus: resposta sem call_id');
  return { callId: data.call_id || data.id, ...data };
}

// Baixa o buffer de áudio de uma URL de gravação
async function downloadGravacao(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : require('http');
    mod.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return downloadGravacao(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Download gravação falhou: ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'audio/mpeg' }));
      res.on('error', reject);
    }).on('timeout', () => reject(new Error('Download gravação timeout'))).on('error', reject);
  });
}

module.exports = { ligar, downloadGravacao, temToken };
