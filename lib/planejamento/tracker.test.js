const test = require('node:test');
const assert = require('node:assert');
const { primeiroNome, resumoTracker, renderTracker, renderNeutro } = require('./tracker');

test('primeiroNome: remove sufixo (id) do fim, preserva parênteses no meio, aguenta vazio', () => {
  assert.equal(primeiroNome('Jeysa Vanessa Rocha Magalhaes Reis (10551)'), 'Jeysa');
  assert.equal(primeiroNome('Maria Silva'), 'Maria');                       // inclusão manual, sem sufixo
  assert.equal(primeiroNome('Ana (Bia) Souza (99)'), 'Ana');
  assert.equal(primeiroNome(''), '');
  assert.equal(primeiroNome(null), '');
});

test('resumoTracker: progresso conta item sem etapa como 1 pendente (filosofia temItemSemEtapa)', () => {
  const r = resumoTracker([
    { procedure_name: 'Doc', profissional_executor: 'Thais', plano_etapas: [{ descricao: 'Procedimento realizado', status: 'concluida', concluida_em: '2026-07-18T15:00:00Z', ordem: 999 }], sublotes: [] },   // sintética detectada SÓ pelo ordem 999 (descricao ≠ nome — teste mais forte)
    { procedure_name: 'Prevenção', profissional_executor: null, plano_etapas: [], sublotes: [] },
  ], 'Marcos');
  assert.equal(r.pct, 50);                                    // 1 concluída ÷ (1 etapa + 1 item sem etapa)
  assert.equal(r.procedimentos[0].status, 'concluido');
  assert.equal(r.procedimentos[0].sessoes[0].descricao, null); // sintética (ordem 999 / descricao==nome) → só data
  assert.equal(r.procedimentos[1].status, 'a_fazer');
  assert.equal(r.procedimentos[1].executor, 'Marcos');         // fallback = dentista responsável
});

test('resumoTracker: em_andamento + etapas de sub-lotes agregadas na raiz', () => {
  const r = resumoTracker([{ procedure_name: 'Facetas', profissional_executor: 'Lígia', plano_etapas: [],
    sublotes: [{ plano_etapas: [{ descricao: 'moldagem', status: 'concluida', concluida_em: '2026-07-01T12:00:00Z', ordem: 0 }, { descricao: 'cimentação', status: 'pendente', ordem: 1 }] }] }], null);
  assert.equal(r.pct, 50);
  assert.equal(r.procedimentos[0].status, 'em_andamento');
  assert.equal(r.procedimentos[0].sessoes.length, 1);          // pendente NÃO listada
  assert.equal(r.procedimentos[0].sessoes[0].descricao, 'moldagem');
});

test('renderTracker: nunca contém financeiro/interno; escapa nome; 100% dá parabéns', () => {
  const html = renderTracker({ nome: '<b>Jeysa</b>', concluido: true,
    resumo: { pct: 100, procedimentos: [{ nome: 'Doc', status: 'concluido', executor: 'Thais', sessoes: [{ descricao: null, data: '18/07/2026' }] }] },
    proxima: { appointment_date: '2026-07-25', from_time: '14:00' } });
  assert.ok(!/R\$|valor|entrada|orientac|recado/i.test(html));
  assert.ok(html.includes('&lt;b&gt;Jeysa&lt;/b&gt;'));
  assert.ok(/100%/.test(html) && /Parab/i.test(html));
  assert.ok(html.includes('25/07') && html.includes('14:00'));
  assert.ok(/noindex/.test(html));
});

test('renderNeutro: página neutra sem dados', () => {
  const html = renderNeutro();
  assert.ok(/inválido|não disponível/i.test(html) && /noindex/.test(html));
});
