'use strict';
const https = require('https');

const THREEC_TOKEN = () => process.env.THREEC_TOKEN || '';
const THREEC_BASE  = () => process.env.THREEC_BASE_URL || 'https://api.3cplus.com.br';

function temToken() {
  return Boolean(THREEC_TOKEN());
}

function httpsRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const url = new URL(path, THREEC_BASE());
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${THREEC_TOKEN()}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: 15000,
    };
    const req = https.request(options, (res) => {
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
// ⚠️ Confirmar endpoint e campos reais na doc da API 3cplus.
async function ligar({ agentId, numeroDestino }) {
  if (!temToken()) throw new Error('3cplus não configurado — preencha THREEC_TOKEN no .env');

  const { status, body } = await httpsRequest('POST', '/v1/call', {
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
