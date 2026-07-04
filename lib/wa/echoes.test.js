// lib/wa/echoes.test.js
const test = require('node:test');
const assert = require('node:assert');
const { parseEchoes } = require('./echoes');

// Payload REAL capturado em webhook_wa_debug (03/07/2026) — não inventado
const PAYLOAD_REAL = { entry: [{ changes: [{ field: 'smb_message_echoes', value: {
  contacts: [{ wa_id: '553199206744', user_id: 'BR.2805644406472492' }],
  metadata: { phone_number_id: '993441140514749', display_phone_number: '553196492873' },
  message_echoes: [{ id: 'wamid.HBgMNTUzMTk5MjA2NzQ0FQIAERggQTVBQjZDODFCNUUzRjYxNTQ4NTlCNTkyMTcyQ0YwOTEA',
    to: '553199206744', from: '553196492873',
    text: { body: 'Bom dia Sandra! Tudo bem?' }, type: 'text',
    timestamp: '1783088335', to_user_id: 'BR.2805644406472492' }],
  messaging_product: 'whatsapp' } }] }] };

test('extrai eco de texto do payload real', () => {
  const r = parseEchoes(PAYLOAD_REAL);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].to, '553199206744');
  assert.strictEqual(r[0].texto, 'Bom dia Sandra! Tudo bem?');
  assert.strictEqual(r[0].phone_number_id, '993441140514749');
  assert.match(r[0].wamid, /^wamid\./);
  assert.strictEqual(r[0].timestamp, new Date(1783088335 * 1000).toISOString());
});

test('eco de mídia vira rótulo [tipo]', () => {
  const b = structuredClone(PAYLOAD_REAL);
  b.entry[0].changes[0].value.message_echoes[0] = { id: 'wamid.X', to: '5531999', type: 'image', image: { id: 'm1' }, timestamp: '1783088335' };
  const r = parseEchoes(b);
  assert.strictEqual(r[0].texto, '[image]');
  assert.strictEqual(r[0].tipo, 'image');
});

test('reaction é descartada; field messages é ignorado; body vazio não quebra', () => {
  const b = structuredClone(PAYLOAD_REAL);
  b.entry[0].changes[0].value.message_echoes[0].type = 'reaction';
  assert.strictEqual(parseEchoes(b).length, 0);
  assert.strictEqual(parseEchoes({ entry: [{ changes: [{ field: 'messages', value: {} }] }] }).length, 0);
  assert.strictEqual(parseEchoes(null).length, 0);
  assert.strictEqual(parseEchoes({}).length, 0);
});

test('aceita field message_echoes (variante sem smb_)', () => {
  const b = structuredClone(PAYLOAD_REAL);
  b.entry[0].changes[0].field = 'message_echoes';
  assert.strictEqual(parseEchoes(b).length, 1);
});
