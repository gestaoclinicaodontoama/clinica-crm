const { test } = require('node:test');
const assert = require('node:assert');
const { detectFormat, needsConversion, ffmpegArgsTo16kWav } = require('./audio-format');

test('detecta m4a por content-type', () => {
  assert.strictEqual(detectFormat('audio/mp4', null), 'm4a');
  assert.strictEqual(detectFormat('audio/x-m4a', null), 'm4a');
});

test('detecta por extensão quando content-type genérico', () => {
  assert.strictEqual(detectFormat('application/octet-stream', 'consulta.m4a'), 'm4a');
  assert.strictEqual(detectFormat('application/octet-stream', 'gravacao.OPUS'), 'opus');
});

test('formatos já aceitos pelo Deepgram não precisam converter', () => {
  assert.strictEqual(needsConversion('mp3'), false);
  assert.strictEqual(needsConversion('wav'), false);
});

test('formatos problemáticos precisam converter', () => {
  assert.strictEqual(needsConversion('m4a'), true);
  assert.strictEqual(needsConversion('opus'), true);
  assert.strictEqual(needsConversion('amr'), true);
});

test('desconhecido converte por segurança', () => {
  assert.strictEqual(detectFormat('application/octet-stream', 'x.bin'), 'desconhecido');
  assert.strictEqual(needsConversion('desconhecido'), true);
});

test('ffmpegArgs gera args de stdin→stdout wav 16k mono', () => {
  const args = ffmpegArgsTo16kWav('m4a');
  assert.ok(args.includes('-i') && args.includes('pipe:0'));
  assert.ok(args.includes('pipe:1'));
  assert.ok(args.includes('16000'));
  assert.ok(args.includes('1')); // mono
});
