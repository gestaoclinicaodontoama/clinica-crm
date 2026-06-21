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
        (t.escopo === 'role' && roles.includes(t.role)) ||
        (t.escopo === 'usuarios' && Array.isArray(t.assignee_ids) && t.assignee_ids.includes(userId))
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

test('gera tarefa para usuario em assignee_ids', async () => {
  const tpl = { id: 't3', escopo: 'usuarios', assignee_ids: ['u1', 'u2'],
    frequencia: 'diaria', dias_semana: null, titulo: 'Tarefa rotina p/ pessoas',
    arrasta: false, tipo_resultado: 'check', prioridade: 'normal' };
  const repo = fakeRepo([tpl]);
  await gerarTarefasDoDia(repo, 'u1', [], '2026-06-17');
  assert.strictEqual(repo._tasks.length, 1);
  assert.strictEqual(repo._tasks[0].assignee_id, 'u1');
});

test('nao gera para usuario fora de assignee_ids', async () => {
  const tpl = { id: 't4', escopo: 'usuarios', assignee_ids: ['u2'],
    frequencia: 'diaria', dias_semana: null, titulo: 'Tarefa so p/ u2',
    arrasta: false, tipo_resultado: 'check', prioridade: 'normal' };
  const repo = fakeRepo([tpl]);
  await gerarTarefasDoDia(repo, 'u1', [], '2026-06-17');
  assert.strictEqual(repo._tasks.length, 0);
});

const COLETA_TPL = {
  id: 'c1', escopo: 'role', role: 'crc_leads', tipo: 'coleta', ativo: true,
  titulo: 'Coleta CRC Leads', categoria: 'Leads', prioridade: 'normal',
  metricas: [
    { chave: 'ligacoes', rotulo: 'Ligações', tipo_campo: 'numero', ordem: 1 },
    { chave: 'agendados', rotulo: 'Agendados', tipo_campo: 'numero', ordem: 2 },
  ],
  periodos: [
    { chave: 'manha', rotulo: 'Manhã',      dias_semana: [1,2,3,4,5,6] },
    { chave: 'tarde', rotulo: 'Fim do dia', dias_semana: [1,2,3,4,5] },
  ],
};

// Estende o fakeRepo: coleta precisa de coletaCardExiste
function fakeRepoColeta(templates, tasks = []) {
  const repo = fakeRepo(templates, tasks);
  repo.coletaCardExiste = async (templateId, userId, dataRef, periodo) =>
    repo._tasks.some(t => t.template_id === templateId && t.assignee_id === userId
      && t.data_ref === dataRef && t.periodo === periodo);
  return repo;
}

test('coleta: sexta gera 2 cards (manha + tarde)', async () => {
  const repo = fakeRepoColeta([COLETA_TPL]);
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-19'); // sexta
  assert.strictEqual(repo._tasks.length, 2);
  assert.deepStrictEqual(repo._tasks.map(t => t.periodo).sort(), ['manha', 'tarde']);
  assert.strictEqual(repo._tasks[0].template_id, 'c1');
  assert.deepStrictEqual(repo._tasks[0].valores, {});
  assert.strictEqual(repo._tasks[0].origem, 'manual');
});

test('coleta: sabado gera so 1 card (manha)', async () => {
  const repo = fakeRepoColeta([COLETA_TPL]);
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-20'); // sabado
  assert.strictEqual(repo._tasks.length, 1);
  assert.strictEqual(repo._tasks[0].periodo, 'manha');
  assert.strictEqual(repo._tasks[0].titulo, 'Coleta CRC Leads — Manhã');
});

test('coleta: idempotente, rodar 2x nao duplica', async () => {
  const repo = fakeRepoColeta([COLETA_TPL]);
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-19');
  await gerarTarefasDoDia(repo, 'u1', ['crc_leads'], '2026-06-19');
  assert.strictEqual(repo._tasks.length, 2);
});
