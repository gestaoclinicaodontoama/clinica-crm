const { test } = require('node:test');
const assert = require('node:assert');
const { parseMensagemRecebida } = require('./whatsapp');

function body(msg, contact = { profile: { name: 'Paciente' }, wa_id: '5531999990000' }) {
  return { entry: [{ changes: [{ field: 'messages', value: { contacts: [contact], messages: [msg] } }] }] };
}

test('texto continua funcionando', () => {
  const r = parseMensagemRecebida(body({ from: '5531999990000', id: 'wamid.1', type: 'text', timestamp: '1', text: { body: 'oi' } }));
  assert.strictEqual(r.tipo, 'text');
  assert.strictEqual(r.texto, 'oi');
  assert.strictEqual(r.media_id, '');
});

test('audio extrai media_id e mime', () => {
  const r = parseMensagemRecebida(body({ from: '5531999990000', id: 'wamid.2', type: 'audio', timestamp: '2', audio: { id: 'MEDIA_AUD', mime_type: 'audio/ogg; codecs=opus' } }));
  assert.strictEqual(r.tipo, 'audio');
  assert.strictEqual(r.media_id, 'MEDIA_AUD');
  assert.strictEqual(r.mime, 'audio/ogg; codecs=opus');
  assert.strictEqual(r.texto, '');
});

test('image extrai media_id e usa caption como texto', () => {
  const r = parseMensagemRecebida(body({ from: '5531999990000', id: 'wamid.3', type: 'image', timestamp: '3', image: { id: 'MEDIA_IMG', mime_type: 'image/jpeg', caption: 'minha foto' } }));
  assert.strictEqual(r.tipo, 'image');
  assert.strictEqual(r.media_id, 'MEDIA_IMG');
  assert.strictEqual(r.texto, 'minha foto');
});

test('document extrai filename', () => {
  const r = parseMensagemRecebida(body({ from: '5531999990000', id: 'wamid.4', type: 'document', timestamp: '4', document: { id: 'MEDIA_DOC', mime_type: 'application/pdf', filename: 'exame.pdf' } }));
  assert.strictEqual(r.tipo, 'document');
  assert.strictEqual(r.media_id, 'MEDIA_DOC');
  assert.strictEqual(r.media_filename, 'exame.pdf');
});

test('sticker extrai media_id', () => {
  const r = parseMensagemRecebida(body({ from: '5531999990000', id: 'wamid.5', type: 'sticker', timestamp: '5', sticker: { id: 'MEDIA_STK', mime_type: 'image/webp' } }));
  assert.strictEqual(r.tipo, 'sticker');
  assert.strictEqual(r.media_id, 'MEDIA_STK');
});
