// lib/social-media/status.test.js
const test = require('node:test');
const assert = require('node:assert');
const { podeTransicionar, STATUS_VALIDOS } = require('./status');

test('rascunho -> aguardando_aprovacao: qualquer role do módulo', () => {
  assert.equal(podeTransicionar({ de:'rascunho', para:'aguardando_aprovacao', roles:['mod_social_media'], exigirAprovacao:true }).ok, true);
});
test('aguardando -> aprovado exige gestor/admin quando exigirAprovacao', () => {
  assert.equal(podeTransicionar({ de:'aguardando_aprovacao', para:'aprovado', roles:['mod_social_media'], exigirAprovacao:true }).ok, false);
  assert.equal(podeTransicionar({ de:'aguardando_aprovacao', para:'aprovado', roles:['gestor'], exigirAprovacao:true }).ok, true);
});
test('com aprovação desligada, rascunho -> aprovado direto por qualquer um', () => {
  assert.equal(podeTransicionar({ de:'rascunho', para:'aprovado', roles:['mod_social_media'], exigirAprovacao:false }).ok, true);
});
test('aprovado -> publicado ok; publicado é terminal', () => {
  assert.equal(podeTransicionar({ de:'aprovado', para:'publicado', roles:['mod_social_media'], exigirAprovacao:true }).ok, true);
  assert.equal(podeTransicionar({ de:'publicado', para:'rascunho', roles:['admin'], exigirAprovacao:true }).ok, false);
});
test('devolver: aguardando -> rascunho ok; cancelado -> rascunho ok; transição inventada falha', () => {
  assert.equal(podeTransicionar({ de:'aguardando_aprovacao', para:'rascunho', roles:['gestor'], exigirAprovacao:true }).ok, true);
  assert.equal(podeTransicionar({ de:'cancelado', para:'rascunho', roles:['mod_social_media'], exigirAprovacao:true }).ok, true);
  assert.equal(podeTransicionar({ de:'rascunho', para:'publicado', roles:['admin'], exigirAprovacao:true }).ok, false);
});
test('STATUS_VALIDOS exporta os 5 status', () => {
  assert.deepEqual([...STATUS_VALIDOS].sort(),
    ['aguardando_aprovacao','aprovado','cancelado','publicado','rascunho']);
});
