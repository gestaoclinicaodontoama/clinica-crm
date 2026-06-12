'use strict';
const http  = require('http');
const https = require('https');

const THREEC_TOKEN = () => process.env.THREEC_TOKEN || '';
// Base URL por empresa: https://clinicaama.3c.plus (sem trailing slash)
const THREEC_BASE  = () => process.env.THREEC_BASE_URL || 'https://clnicaama.3c.plus';

function temToken() {
  return Boolean(THREEC_TOKEN());
}

// Auth: query param ?api_token=TOKEN (confirmado na doc oficial)
// token = token do agente para ações de agente; THREEC_TOKEN() para ações do gestor
function apiRequest(method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
    const tok = token || THREEC_TOKEN();
    const data = body ? JSON.stringify(body) : null;
    const url = new URL(apiPath, THREEC_BASE());
    url.searchParams.set('api_token', tok);
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

// Extrai a mensagem legível do corpo de erro da 3cplus ({ detail, errors: { campo: [msgs] } })
function msgErro3c(body) {
  try {
    const d = JSON.parse(body);
    const errs = d?.errors ? Object.values(d.errors).flat().join(' ') : '';
    return [d?.detail, errs].filter(Boolean).join(' ') || body.slice(0, 200);
  } catch {
    return String(body || '').slice(0, 200);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Faz login do agente na primeira campanha disponível (preferencialmente manual/preview).
// Necessário antes de manual_call/enter — registrar o ramal WebRTC é separado de login.
// Campanha manual: agente escolhe quando discar. Preditiva: auto-discagem perigosa.
async function _loginAgenteCampanha(agentToken) {
  const rc = await apiRequest('GET', '/api/v1/agent/campaigns', null, agentToken);
  console.log('[3cplus] campaigns status=%s body=%s', rc.status, rc.body.slice(0, 500));
  if (rc.status !== 200) return false;
  let lista = [];
  try {
    const d = JSON.parse(rc.body);
    lista = Array.isArray(d) ? d : (d.data || d.campaigns || d.results || []);
  } catch { return false; }
  if (!lista.length) return false;
  // Prefere campanha manual ou preview; evita preditivas (auto-discagem)
  const campanha =
    lista.find(c => /manual/i.test(c.type || c.campaign_type || c.mode || '')) ||
    lista.find(c => /preview/i.test(c.type || c.campaign_type || c.mode || '')) ||
    lista[0];
  console.log('[3cplus] login campanha id=%s tipo=%s', campanha.id, campanha.type || campanha.campaign_type || '?');
  const rl = await apiRequest('POST', '/api/v1/agent/login', { campaign: campanha.id }, agentToken);
  console.log('[3cplus] agent/login status=%s body=%s', rl.status, rl.body.slice(0, 200));
  return rl.status === 200 || rl.status === 204 || rl.status === 201;
}

// Click-to-call — usa TOKEN DO AGENTE (não do gestor)
// Paths reais da API usam barra: /agent/manual_call/enter|dial|exit (underscore dá 404).
// Pré-requisito da 3cplus: ramal WebRTC registrado (iframe) + login numa campanha.
// Se o enter retornar 422 "não ocioso", tenta login automático e re-tenta.
// 3cplus retorna 204 sem call_id; o call_id real chega via Socket.io (call-was-connected)
// O cron de polling preenche threec_call_id depois via GET /calls
async function ligar({ agentToken, numeroDestino }) {
  if (!agentToken) {
    const err = new Error('Token de agente não configurado. Configure em Perfil → Token 3cplus.');
    err.status = 400;
    throw err;
  }

  // Bug 5 fix: números com 0 à esquerda (estratégia de família no WhatsApp) têm o 0 removido
  // apenas para discagem — no banco ficam intactos.
  const raw = numeroDestino.replace(/\D/g, '');
  const destino = raw.startsWith('0') ? raw.slice(1) : raw;

  const ok = r => r.status === 200 || r.status === 204;

  // Passo 1: entrar em modo manual (requer ramal WebRTC ativo + login em campanha)
  let r1 = await apiRequest('POST', '/api/v1/agent/manual_call/enter', null, agentToken);
  console.log('[3cplus] manual_call/enter status=%s body=%s', r1.status, r1.body.slice(0, 300));

  if (!ok(r1)) {
    const detail1 = msgErro3c(r1.body);
    // 422 "não ocioso" = agente não logado numa campanha; tenta login automático
    if (r1.status === 422) {
      console.log('[3cplus] enter 422, tentando login automático em campanha...');
      const logado = await _loginAgenteCampanha(agentToken).catch(e => {
        console.error('[3cplus] login campanha erro:', e.message);
        return false;
      });
      if (logado) {
        await sleep(1500); // aguarda a 3cplus processar o login
        r1 = await apiRequest('POST', '/api/v1/agent/manual_call/enter', null, agentToken);
        console.log('[3cplus] manual_call/enter (re-tentativa) status=%s body=%s', r1.status, r1.body.slice(0, 300));
      }
    }
  }

  if (!ok(r1)) {
    const detail = msgErro3c(r1.body);
    const err = new Error(`3cplus: ${detail} Verifique se o softfone (📞) está ativo e tente de novo.`);
    err.status = 422;
    throw err;
  }

  // Pequena pausa para a 3cplus processar o enter antes de discar
  await sleep(800);

  // Passo 2: discar para o número
  const r2 = await apiRequest('POST', '/api/v1/agent/manual_call/dial', { phone: destino }, agentToken);
  console.log('[3cplus] manual_call/dial status=%s body=%s', r2.status, r2.body.slice(0, 300));
  if (!ok(r2)) {
    // Bug 4 fix: se o dial falhar, sair do modo manual para não travar o agente
    apiRequest('POST', '/api/v1/agent/manual_call/exit', null, agentToken).catch(() => {});
    const err = new Error(`3cplus não discou: ${msgErro3c(r2.body)}`);
    err.status = 502;
    throw err;
  }

  // Tenta extrair call_id se a resposta incluir (pode vir null — cron preenche depois)
  let callId = null;
  try {
    const d = JSON.parse(r2.body);
    callId = d?.call_id || d?.id || d?.call?.id || null;
  } catch {}

  return { callId };
}

// Polling de chamadas com token do GESTOR para encontrar calls não capturados via socket
// Retorna raw para permitir log/debug no cron
// API exige start_date e end_date (snake_case) como parâmetros obrigatórios
async function getCalls({ startDate, endDate } = {}) {
  const now = new Date();
  const twoHoursAgo = new Date(now - 2 * 3600 * 1000);
  const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');
  const params = new URLSearchParams();
  params.set('start_date', startDate || fmt(twoHoursAgo));
  params.set('end_date',   endDate   || fmt(now));
  return apiRequest('GET', '/api/v1/calls?' + params.toString(), null, THREEC_TOKEN());
}

// Baixa o buffer de áudio de uma URL de gravação (suporta redirect 301/302)
async function downloadGravacao(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
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

module.exports = { ligar, getCalls, downloadGravacao, temToken, apiRequest };
