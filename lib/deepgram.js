'use strict';
const https = require('https');

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const DEEPGRAM_PROJECT_ID = process.env.DEEPGRAM_PROJECT_ID || '';
const DEFAULT_TTL = 30;

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function createEphemeralToken() {
  const ttl = Math.max(10, Math.min(3600, parseInt(process.env.DEEPGRAM_EPHEMERAL_TTL_SECONDS || '', 10) || DEFAULT_TTL));
  const url = `https://api.deepgram.com/v1/projects/${DEEPGRAM_PROJECT_ID}/keys`;

  const { status, body } = await httpsPost(url, {
    'Authorization': `Token ${DEEPGRAM_API_KEY}`,
    'Content-Type': 'application/json',
  }, {
    comment: 'crm-ephemeral',
    scopes: ['usage:write'],
    time_to_live_in_seconds: ttl,
  });

  if (status !== 200 && status !== 201) {
    const err = new Error(`Deepgram key creation failed: ${status} ${body}`);
    err.status = 502;
    throw err;
  }

  const json = JSON.parse(body);
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  return { token: json.key, expiresAt };
}

function transcribeStream(readableStream, contentType, contentLength) {
  return new Promise((resolve, reject) => {
    const url = 'https://api.deepgram.com/v1/listen?model=nova-2&language=pt-BR&diarize=true&punctuate=true&smart_format=true';
    const parsed = new URL(url);
    const reqHeaders = {
      'Authorization': `Token ${DEEPGRAM_API_KEY}`,
      'Content-Type': contentType || 'audio/mpeg',
    };
    if (contentLength) reqHeaders['Content-Length'] = contentLength;

    const dgReq = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: reqHeaders,
    }, (dgRes) => {
      let raw = '';
      dgRes.on('data', chunk => { raw += chunk; });
      dgRes.on('end', () => {
        if (dgRes.statusCode !== 200) {
          const err = new Error(`Deepgram ${dgRes.statusCode}: ${raw}`);
          err.status = 502;
          return reject(err);
        }
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('Resposta inválida do Deepgram')); }
      });
    });
    dgReq.on('error', reject);
    readableStream.pipe(dgReq);
  });
}

module.exports = { createEphemeralToken, transcribeStream };
