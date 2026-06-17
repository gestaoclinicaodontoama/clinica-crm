// lib/tarefas/geracao.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { gerarTarefasDoDia } = require('./geracao');

// Repositório fake em memória
function fakeRepo(templates, tasks = []) {
  return {
    _tasks: tasks,
    async templatesDoUsuario(userId, roles) {
      return templates.filter(t =>
        (t.escopo === 'pessoal' && t.owner_id === userId) ||
        (t.escopo === 'role' && roles.includes(t.role))
      );
    },
    async taskExisteNoDia(templateId, userId, dataRef) {
      return this._tasks.some(t => t.template_id === templateId && t.assignee_id === userId && t.data_ref === dataRef);
    },
    async taskAbertaDoTemplate(templateId, userId) {
      return this._tasks.some(t => t.template_id === templateId && t.assignee_id === userId && t.status === 'pendente');
    },
    async inserir(task) { this._tasks.push({ ...task, id: 'gen-' + this._tasks.length }); },
  };
}

const T_DIARIA = { id: 't1', escopo: 'role', role: 'crc_leads', frequencia: 'diaria', dias_semana: null, titulo: 'Responder leads', arrasta: false, tipo_resultado: 'check', prioridade: 'normal' };

test('gera tarefa de rotina quando nao existe', async () => {
  const repo = fakeRepo([T_DIARIA]);
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-17');
  assert.strictEqual(repo._tasks.length, 1);
  assert.strictEqual(repo._tasks[0].titulo, 'Responder leads');
  assert.strictEqual(repo._tasks[0].data_ref, '2026-06-17');
});

test('idempotente: rodar 2x nao duplica', async () => {
  const repo = fakeRepo([T_DIARIA]);
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-17');
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-17');
  assert.strictEqual(repo._tasks.length, 1);
});

test('molde que arrasta com tarefa aberta de ontem NAO gera nova hoje', async () => {
  const arrastaTpl = { ...T_DIARIA, id: 't2', arrasta: true };
  const repo = fakeRepo([arrastaTpl], [
    { template_id: 't2', assignee_id: 'u1', data_ref: '2026-06-16', status: 'pendente' },
  ]);
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-17');
  assert.strictEqual(repo._tasks.length, 1); // continua so a de ontem
});

test('molde que nao se aplica hoje nao gera', async () => {
  const semFds = { ...T_DIARIA, dias_semana: [6] }; // so sabado
  const repo = fakeRepo([semFds]);
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-17'); // quarta
  assert.strictEqual(repo._tasks.length, 0);
});
