// Cliente HTTP para a API Clinicorp com rate limiter automático.
// Limite oficial: 25 req/hora. Se atingido, aguarda 1h10m a partir da
// requisição mais antiga da janela antes de continuar.

const https = require('https');

const API_HOST = 'api.clinicorp.com';
const API_BASE = '/rest/v1';
const MAX_PER_HOUR = 24;        // usa 24 como buffer de segurança
const WINDOW_MS   = 60 * 60_000; // 1 hora
const PAUSE_MS    = 70 * 60_000; // 1h10m

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

class ClinicorpApi {
  constructor({ user, token, subscriberId, businessId }) {
    this.auth   = Buffer.from(`${user}:${token}`).toString('base64');
    this.token  = token;
    this.sub    = subscriberId;
    this.biz    = businessId;
    this._reqs  = []; // timestamps das requisições na janela atual
  }

  async _throttle() {
    const now = Date.now();
    this._reqs = this._reqs.filter(t => now - t < WINDOW_MS);

    if (this._reqs.length >= MAX_PER_HOUR) {
      const oldest  = this._reqs[0];
      const waitMs  = (oldest + PAUSE_MS) - now;
      if (waitMs > 0) {
        const mins = Math.ceil(waitMs / 60_000);
        console.log(`[clinicorp-api] ${MAX_PER_HOUR} req/hora atingido. Aguardando ${mins} min (1h10m)...`);
        await sleep(waitMs);
        const after = Date.now();
        this._reqs = this._reqs.filter(t => after - t < WINDOW_MS);
      }
    }

    this._reqs.push(Date.now());
  }

  _raw(path, params = {}) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams({
        subscriber_id: this.sub,
        business_id:   this.biz,
        ...Object.fromEntries(
          Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
        ),
      });

      const req = https.request({
        hostname: API_HOST,
        path:     `${API_BASE}${path}?${qs}`,
        method:   'GET',
        headers:  {
          'Authorization': `Basic ${this.auth}`,
          'X-Api-Key':     this.token,
          'Accept':        'application/json',
        },
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });

      req.on('error', reject);
      req.setTimeout(60_000, () => { req.destroy(); reject(new Error('Timeout Clinicorp')); });
      req.end();
    });
  }

  async get(path, params = {}) {
    await this._throttle();
    const { status, body } = await this._raw(path, params);

    if (status === 429) {
      // Servidor retornou 429 mesmo com nosso contador — aguarda 1h10m e retenta
      console.log('[clinicorp-api] 429 recebido da API. Aguardando 1h10m e retentando...');
      await sleep(PAUSE_MS);
      this._reqs = [];
      await this._throttle();
      const retry = await this._raw(path, params);
      if (retry.status !== 200) throw new Error(`Clinicorp ${retry.status}: ${retry.body.slice(0, 200)}`);
      return JSON.parse(retry.body);
    }

    if (status !== 200) throw new Error(`Clinicorp ${status}: ${body.slice(0, 200)}`);
    return JSON.parse(body);
  }

  // Helpers de data
  static toDateStr(d) {
    return d.toISOString().split('T')[0];
  }

  get reqCount() { return this._reqs.length; }
}

module.exports = ClinicorpApi;
