// lib/tarefas/geracao.js
const { moldeValeNoDia } = require('./recorrencia');

// repo: { templatesDoUsuario, taskExisteNoDia, taskAbertaDoTemplate, inserir }
async function gerarTarefasDoDia(repo, userId, roles, dataRef) {
  const templates = await repo.templatesDoUsuario(userId, roles);
  for (const t of templates) {
    if (t.ativo === false) continue;
    if (!moldeValeNoDia(t, dataRef)) continue;

    if (t.arrasta) {
      // só uma ocorrência aberta por vez
      if (await repo.taskAbertaDoTemplate(t.id, userId)) continue;
    } else {
      if (await repo.taskExisteNoDia(t.id, userId, dataRef)) continue;
    }

    await repo.inserir({
      titulo: t.titulo,
      descricao: t.descricao || null,
      tipo: 'rotina',
      template_id: t.id,
      data_ref: dataRef,
      assignee_id: userId,
      created_by: t.created_by || userId,
      prioridade: t.prioridade || 'normal',
      categoria: t.categoria || null,
      tipo_resultado: t.tipo_resultado || 'check',
      unidade: t.unidade || null,
      meta: t.meta ?? null,
      arrasta: !!t.arrasta,
      status: 'pendente',
    });
  }
}

module.exports = { gerarTarefasDoDia };
