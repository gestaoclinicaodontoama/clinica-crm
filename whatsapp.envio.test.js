// Testes do envio com retry para erros transitórios da Meta.
// Env precisa existir ANTES do require (tokens lidos no load do módulo).
process.env.WHATSAPP_API_TOKEN = 'test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '111000111';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const wa = require('./whatsapp');

// Acelera o backoff nos testes (1ms em vez de 1s/3s)
wa._RETRY_DELAYS_MS.splice(0, wa._RETRY_DELAYS_MS.length, 1, 1);

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function mockFetch(responses) {
  let calls = 0;
  global.fetch = async () => {
    const r = responses[Math.min(calls, responses.length - 1)];
    calls++;
    return { ok: (r.status || 200) < 400, status: r.status || 200, json: async () => r.body };
  };
  return () => calls;
}

const ERRO_CODE2 = {
  error: { message: 'An unexpected error has occurred. Please retry your request later.', code: 2 },
};
const OK = { messages: [{ id: 'wamid.OK' }] };

test('erro transitório (code 2) é retentado e o envio conclui', async () => {
  const calls = mockFetch([{ status: 500, body: ERRO_CODE2 }, { body: OK }]);
  const r = await wa.enviarTexto({ para: '5531999990000', texto: 'oi' });
  assert.strictEqual(r.messages[0].id, 'wamid.OK');
  assert.strictEqual(calls(), 2);
});

test('erro transitório persistente esgota retries e vira mensagem PT', async () => {
  const calls = mockFetch([{ status: 500, body: ERRO_CODE2 }]);
  await assert.rejects(
    () => wa.enviarTexto({ para: '5531999990000', texto: 'oi' }),
    /Instabilidade temporária/
  );
  assert.strictEqual(calls(), 3); // 1 tentativa + 2 retries
});

test('erro permanente (ex.: janela 24h) NÃO é retentado e mantém a mensagem original', async () => {
  const calls = mockFetch([
    { status: 400, body: { error: { message: 'Re-engagement message', code: 131047 } } },
  ]);
  await assert.rejects(
    () => wa.enviarTexto({ para: '5531999990000', texto: 'oi' }),
    /Re-engagement/
  );
  assert.strictEqual(calls(), 1);
});

test('HTTP 5xx sem corpo JSON também é tratado como transitório', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { ok: false, status: 503, json: async () => { throw new Error('not json'); } };
  };
  await assert.rejects(
    () => wa.enviarTexto({ para: '5531999990000', texto: 'oi' }),
    /Instabilidade temporária/
  );
  assert.strictEqual(calls, 3);
});

test('uploadMidia também usa retry em erro transitório', async () => {
  const calls = mockFetch([{ status: 500, body: ERRO_CODE2 }, { body: { id: 'MEDIA_1' } }]);
  const id = await wa.uploadMidia({ buffer: Buffer.from('x'), mimetype: 'audio/ogg', filename: 'a.ogg' });
  assert.strictEqual(id, 'MEDIA_1');
  assert.strictEqual(calls(), 2);
});
