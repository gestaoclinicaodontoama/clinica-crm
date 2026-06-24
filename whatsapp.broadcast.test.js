// Env precisa existir ANTES do require (tokens lidos no load do módulo).
process.env.WHATSAPP_API_TOKEN = 'sdr-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '2873id';
process.env.WHATSAPP_BROADCAST_TOKEN = 'bcast-token';
process.env.WHATSAPP_BROADCAST_PHONE_ID = '8700id';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const wa = require('./whatsapp');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function mockCapture() {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, auth: opts?.headers?.Authorization, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.X' }] }) };
  };
  return calls;
}

test('sem phoneNumberId usa o número de broadcast (8700) e seu token', async () => {
  const calls = mockCapture();
  await wa.enviarBroadcast({ para: '5531999990000', templateName: 'tpl', variaveis: ['Ana'] });
  assert.ok(calls[0].url.includes('/8700id/messages'), calls[0].url);
  assert.strictEqual(calls[0].auth, 'Bearer bcast-token');
  assert.strictEqual(calls[0].body.template.name, 'tpl');
});

test('com phoneNumberId do 2873 envia por ele com o token do SDR', async () => {
  const calls = mockCapture();
  await wa.enviarBroadcast({ para: '5531999990000', templateName: 'tpl', variaveis: ['Ana'], phoneNumberId: '2873id' });
  assert.ok(calls[0].url.includes('/2873id/messages'), calls[0].url);
  assert.strictEqual(calls[0].auth, 'Bearer sdr-token');
});
