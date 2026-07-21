// lib/planejamento/estados.test.js
const test = require('node:test');
const assert = require('node:assert');
const { transicaoValida, validarSubLotes, aplicarResync, avancarPorRegistro, statusAposRegistro } = require('./estados');

test('transições do fluxo principal e laterais', () => {
  assert.equal(transicaoValida('aguardando_planejamento', 'planejado'), true);
  assert.equal(transicaoValida('planejado', 'em_andamento'), true);
  assert.equal(transicaoValida('em_andamento', 'concluido'), true);
  assert.equal(transicaoValida('planejado', 'concluido'), false);       // não pula
  assert.equal(transicaoValida('aguardando_planejamento', 'descartado'), true);
  assert.equal(transicaoValida('planejado', 'cancelado'), true);
  assert.equal(transicaoValida('descartado', 'aguardando_planejamento'), true); // ressurreição
  assert.equal(transicaoValida('cancelado', 'aguardando_planejamento'), true);  // maleabilidade
  assert.equal(transicaoValida('concluido', 'aguardando_planejamento'), true);  // regressão por re-sync
  assert.equal(transicaoValida('descartado', 'planejado'), false);
});

test('validarSubLotes: conservação da quantidade', () => {
  assert.equal(validarSubLotes(6, [{ quantidade: 4 }, { quantidade: 2 }]).ok, true);
  assert.equal(validarSubLotes(6, [{ quantidade: 4 }, { quantidade: 3 }]).ok, false);
  assert.equal(validarSubLotes(6, []).ok, false);
});

test('re-sync: item adicionado regride plano planejado', () => {
  const r = aplicarResync({
    plano: { status: 'planejado' },
    itensPlano: [{ price_id: '10', quantidade: 6, etapas_executadas: false }],
    itensNovos: [{ price_id: '10', quantidade: 6 }, { price_id: '22', quantidade: 1 }],
  });
  assert.ok(r.acoes.some(a => a.tipo === 'adicionar_item' && a.price_id === '22'));
  assert.ok(r.acoes.some(a => a.tipo === 'regredir'));
});

test('re-sync: item adicionado ressuscita plano descartado', () => {
  const r = aplicarResync({
    plano: { status: 'descartado' },
    itensPlano: [{ price_id: '10', quantidade: 1, etapas_executadas: false }],
    itensNovos: [{ price_id: '10', quantidade: 1 }, { price_id: '22', quantidade: 1 }],
  });
  assert.ok(r.acoes.some(a => a.tipo === 'ressuscitar'));
});

test('re-sync: item removido sem etapas → remover; com etapas → travar', () => {
  const base = { plano: { status: 'planejado' }, itensNovos: [{ price_id: '10', quantidade: 6 }] };
  const sem = aplicarResync({ ...base, itensPlano: [{ price_id: '10', quantidade: 6, etapas_executadas: false }, { price_id: '22', quantidade: 1, etapas_executadas: false }] });
  assert.ok(sem.acoes.some(a => a.tipo === 'remover_item' && a.price_id === '22'));
  const com = aplicarResync({ ...base, itensPlano: [{ price_id: '10', quantidade: 6, etapas_executadas: false }, { price_id: '22', quantidade: 1, etapas_executadas: true }] });
  assert.ok(com.acoes.some(a => a.tipo === 'travar'));
});

test('re-sync: quantidade alterada sem etapas → regredir+replanejar; com etapas → travar', () => {
  const sem = aplicarResync({ plano: { status: 'planejado' },
    itensPlano: [{ price_id: '10', quantidade: 6, etapas_executadas: false }],
    itensNovos: [{ price_id: '10', quantidade: 4 }] });
  assert.ok(sem.acoes.some(a => a.tipo === 'regredir'));
  const com = aplicarResync({ plano: { status: 'planejado' },
    itensPlano: [{ price_id: '10', quantidade: 6, etapas_executadas: true }],
    itensNovos: [{ price_id: '10', quantidade: 4 }] });
  assert.ok(com.acoes.some(a => a.tipo === 'travar'));
});

test('re-sync: status revertido no Clinicorp → cancelar; plano travado não recebe ação nova', () => {
  const r = aplicarResync({ plano: { status: 'planejado' }, statusClinicorp: 'CANCELED',
    itensPlano: [], itensNovos: [] });
  assert.ok(r.acoes.some(a => a.tipo === 'cancelar'));
  const travado = aplicarResync({ plano: { status: 'planejado', trava_resync: 'item removido' },
    itensPlano: [{ price_id: '10', quantidade: 1, etapas_executadas: false }],
    itensNovos: [] });
  assert.deepEqual(travado.acoes, []);   // trava = humano decide antes de qualquer reconciliação nova
});

test('avancarPorRegistro: 1ª etapa registrada em plano planejado → em_andamento', () => {
  assert.equal(avancarPorRegistro('planejado', ['concluida', 'pendente', 'pendente']), 'em_andamento');
  assert.equal(avancarPorRegistro('aguardando_planejamento', ['concluida']), 'em_andamento');
});
test('avancarPorRegistro: última etapa → concluido', () => {
  assert.equal(avancarPorRegistro('em_andamento', ['concluida', 'concluida_retroativa']), 'concluido');
});
test('avancarPorRegistro: em_andamento com etapa pendente → sem mudança (null)', () => {
  assert.equal(avancarPorRegistro('em_andamento', ['concluida', 'pendente']), null);
});
test('avancarPorRegistro: já concluido / laterais → null', () => {
  assert.equal(avancarPorRegistro('concluido', ['concluida']), null);
  assert.equal(avancarPorRegistro('descartado', ['concluida']), null);
  assert.equal(avancarPorRegistro('cancelado', ['concluida']), null);
});
test('avancarPorRegistro: sem etapas → não conclui', () => {
  assert.equal(avancarPorRegistro('planejado', []), 'em_andamento');
  assert.equal(avancarPorRegistro('em_andamento', []), null);
});

test('statusAposRegistro: todas concluídas em planejado/aguardando → concluido (2 degraus numa chamada)', () => {
  assert.equal(statusAposRegistro('planejado', ['concluida']), 'concluido');
  assert.equal(statusAposRegistro('aguardando_planejamento', ['concluida', 'concluida_retroativa']), 'concluido');
});
test('statusAposRegistro: resta pendente → sobe 1 degrau só', () => {
  assert.equal(statusAposRegistro('planejado', ['concluida', 'pendente']), 'em_andamento');
});
test('statusAposRegistro: em_andamento com pendente → inalterado', () => {
  assert.equal(statusAposRegistro('em_andamento', ['concluida', 'pendente']), 'em_andamento');
});
test('statusAposRegistro: concluido/laterais → inalterado', () => {
  assert.equal(statusAposRegistro('concluido', ['concluida']), 'concluido');
  assert.equal(statusAposRegistro('descartado', ['concluida']), 'descartado');
  assert.equal(statusAposRegistro('cancelado', ['concluida']), 'cancelado');
});

test('temItemSemEtapa: nunca conclui o plano (item sem etapa = trabalho não detalhado)', () => {
  assert.equal(avancarPorRegistro('em_andamento', ['concluida'], true), null);
  assert.equal(statusAposRegistro('em_andamento', ['concluida'], true), 'em_andamento');
  assert.equal(statusAposRegistro('planejado', ['concluida'], true), 'em_andamento');   // sobe, mas não fecha
});
test('temItemSemEtapa=false (default): comportamento antigo preservado', () => {
  assert.equal(statusAposRegistro('planejado', ['concluida']), 'concluido');
  assert.equal(avancarPorRegistro('em_andamento', ['concluida'], false), 'concluido');
});

test('resync: fase externa DEVE ser filtrada antes do aplicarResync (sem filtro = remover_item indevido)', () => {
  const externo = { price_id: null, quantidade: 1, etapas_executadas: false };   // shape cru de um tipo=externo
  const clinicorp = { price_id: '10', quantidade: 1, etapas_executadas: false };
  const novos = [{ price_id: '10', quantidade: 1, procedure_name: 'X' }];
  // COM o externo no itensPlano (filtro esquecido): aplicarResync o vê como "removido no Clinicorp"
  const sem = aplicarResync({ plano: { status: 'em_andamento', trava_resync: null }, itensPlano: [clinicorp, externo], itensNovos: novos, statusClinicorp: 'APPROVED' });
  assert.ok(sem.acoes.some(a => a.tipo === 'remover_item'), 'sem filtro, o externo seria removido — por isso o sync PRECISA excluí-lo');
  // SEM o externo (filtro aplicado, contrato do sync): nenhuma ação
  const com = aplicarResync({ plano: { status: 'em_andamento', trava_resync: null }, itensPlano: [clinicorp], itensNovos: novos, statusClinicorp: 'APPROVED' });
  assert.equal(com.acoes.length, 0);
});
