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

test('interactive button_reply extrai titulo como texto', () => {
  const r = parseMensagemRecebida(body({ from: '5531999990000', id: 'wamid.6', type: 'interactive', timestamp: '6', interactive: { type: 'button_reply', button_reply: { id: 'btn1', title: 'Sim, tenho interesse' } } }));
  assert.strictEqual(r.tipo, 'interactive');
  assert.strictEqual(r.texto, 'Sim, tenho interesse');
  assert.strictEqual(r.media_id, '');
});

test('interactive list_reply extrai titulo como texto', () => {
  const r = parseMensagemRecebida(body({ from: '5531999990000', id: 'wamid.7', type: 'interactive', timestamp: '7', interactive: { type: 'list_reply', list_reply: { id: 'opt1', title: 'Segunda às 10h' } } }));
  assert.strictEqual(r.tipo, 'interactive');
  assert.strictEqual(r.texto, 'Segunda às 10h');
});

test('button extrai texto do botao', () => {
  const r = parseMensagemRecebida(body({ from: '5531999990000', id: 'wamid.8', type: 'button', timestamp: '8', button: { text: 'Confirmar', payload: 'confirm' } }));
  assert.strictEqual(r.tipo, 'button');
  assert.strictEqual(r.texto, 'Confirmar');
  assert.strictEqual(r.media_id, '');
});

test('reaction armazena tipo sem texto e sem media_id', () => {
  const r = parseMensagemRecebida(body({ from: '5531999990000', id: 'wamid.9', type: 'reaction', timestamp: '9', reaction: { message_id: 'wamid.1', emoji: '👍' } }));
  assert.strictEqual(r.tipo, 'reaction');
  assert.strictEqual(r.texto, '');
  assert.strictEqual(r.media_id, '');
});

// ---------- parseStatuses ----------
const { parseStatuses } = require('./whatsapp');

function bodyStatus(statuses) {
  return { entry: [{ changes: [{ field: 'messages', value: { statuses } }] }] };
}

test('parseStatuses extrai delivered e read', () => {
  const r = parseStatuses(bodyStatus([
    { id: 'wamid.A', status: 'delivered', timestamp: '1' },
    { id: 'wamid.B', status: 'read', timestamp: '2' },
  ]));
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r[0], { wa_id: 'wamid.A', status: 'delivered', erro: '' });
  assert.strictEqual(r[1].status, 'read');
});

test('parseStatuses failed monta erro com code, title e details', () => {
  const r = parseStatuses(bodyStatus([{
    id: 'wamid.C', status: 'failed', timestamp: '3',
    errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'Message failed to send because more than 24 hours have passed' } }],
  }]));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].status, 'failed');
  assert.match(r[0].erro, /131047/);
  assert.match(r[0].erro, /24 hours/);
});

test('parseStatuses ignora payloads sem statuses e status desconhecidos', () => {
  assert.deepStrictEqual(parseStatuses({}), []);
  assert.deepStrictEqual(parseStatuses(bodyStatus([{ id: 'wamid.D', status: 'whatever' }])), []);
  const msgBody = { entry: [{ changes: [{ field: 'messages', value: { messages: [{ from: 'x', id: 'y', type: 'text', text: { body: 'oi' } }] } }] }] };
  assert.deepStrictEqual(parseStatuses(msgBody), []);
});
