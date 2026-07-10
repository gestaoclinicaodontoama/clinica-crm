// lib/nfse/emitir.test.js
const test = require('node:test');
const assert = require('node:assert');
const { _processarUma, reconciliarProcessando } = require('./emitir');

// Mock mínimo do client Supabase para as operações usadas (from().update().eq(), rpc())
function supabaseMock({ rps = 10 } = {}) {
  const updates = [];
  return {
    updates,
    rpc: async (fn, args) => ({ data: rps, error: null }),
    from: (tabela) => ({
      update: (patch) => ({ eq: async (col, val) => { updates.push({ tabela, patch, id: val }); return { error: null }; } }),
    }),
  };
}

const emissor = { sistema: 'Vieira', cnpj: '05617377000108', inscricao_municipal: '106657', optante_simples: 1, item_lista_servico: '4.12', aliquota: 3, descricao_padrao: 'Serviços odontológicos' };
const nota = { id: 42, sistema: 'Vieira', competencia: '07-2026', tipo_tomador: 'CPF', cpf_tomador: '11144477735', nome_tomador: 'Teste', valor: 100, descricao: 'x', rps_serie: '1' };

test('sucesso: grava Emitida com numero + codigo de verificacao + xmls', async () => {
  const sb = supabaseMock();
  const ws = async () => `<r><InfNfse><Numero>412</Numero><CodigoVerificacao>AB</CodigoVerificacao><DataEmissao>2026-07-10</DataEmissao></InfNfse></r>`;
  const r = await _processarUma(sb, nota, emissor, { chamarWsImpl: ws });
  assert.strictEqual(r.ok, true);
  const final = sb.updates.at(-1).patch;
  assert.strictEqual(final.status, 'Emitida');
  assert.strictEqual(final.num_nota, '412');
  assert.strictEqual(final.codigo_verificacao, 'AB');
  assert.ok(final.xml_envio.includes('<GerarNfseEnvio'));
  assert.ok(final.xml_retorno.includes('InfNfse'));
});

test('rejeição: grava Erro com mensagem oficial e NUNCA Emitida', async () => {
  const sb = supabaseMock();
  const ws = async () => `<r><ListaMensagemRetorno><MensagemRetorno><Codigo>E160</Codigo><Mensagem>CPF invalido</Mensagem></MensagemRetorno></ListaMensagemRetorno></r>`;
  const r = await _processarUma(sb, nota, emissor, { chamarWsImpl: ws });
  assert.strictEqual(r.ok, false);
  const final = sb.updates.at(-1).patch;
  assert.strictEqual(final.status, 'Erro');
  assert.match(final.erro_msg, /E160/);
});

test('timeout: nota fica Processando (não Erro, não Emitida)', async () => {
  const { NfseComunicacaoError } = require('./cliente');
  const sb = supabaseMock();
  const ws = async () => { throw new NfseComunicacaoError('timeout'); };
  const r = await _processarUma(sb, nota, emissor, { chamarWsImpl: ws });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.pendenteReconciliacao, true);
  const final = sb.updates.at(-1).patch;
  assert.strictEqual(final.status, 'Processando'); // permanece; reconciliador resolve
});

test('reconciliar: nota que EXISTE na prefeitura completa como Emitida; que NÃO existe volta a Pendente', async () => {
  const presas = [
    { id: 1, sistema: 'Vieira', rps_numero: 5, rps_serie: '1', status: 'Processando' },
    { id: 2, sistema: 'Vieira', rps_numero: 6, rps_serie: '1', status: 'Processando' },
  ];
  const updates = [];
  const sb = {
    from: (t) => ({
      select: () => ({ eq: () => ({ limit: async () => ({ data: presas, error: null }) }) }),
      update: (patch) => ({ eq: async (c, id) => { updates.push({ id, patch }); return { error: null }; } }),
    }),
  };
  const emissores = { Vieira: emissor };
  const ws = async (op, xml) => xml.includes('<Numero>5</Numero>')
    ? `<r><InfNfse><Numero>500</Numero><CodigoVerificacao>OK</CodigoVerificacao><DataEmissao>2026-07-10</DataEmissao></InfNfse></r>`
    : `<r><ListaMensagemRetorno><MensagemRetorno><Codigo>E92</Codigo><Mensagem>nao encontrado</Mensagem></MensagemRetorno></ListaMensagemRetorno></r>`;
  const r = await reconciliarProcessando(sb, { chamarWsImpl: ws, emissoresPorSistema: emissores });
  assert.strictEqual(r.fechadas, 1);
  assert.strictEqual(r.voltaram, 1);
  assert.strictEqual(updates.find(u => u.id === 1).patch.status, 'Emitida');
  assert.strictEqual(updates.find(u => u.id === 2).patch.status, 'Pendente');
});

test('reconciliar: consulta falhou (comunicação) → nota segue presa em Processando, sem update', async () => {
  const presas = [
    { id: 7, sistema: 'Vieira', rps_numero: 9, rps_serie: '1', status: 'Processando' },
  ];
  const updates = [];
  const sb = {
    from: (t) => ({
      select: () => ({ eq: () => ({ limit: async () => ({ data: presas, error: null }) }) }),
      update: (patch) => ({ eq: async (c, id) => { updates.push({ id, patch }); return { error: null }; } }),
    }),
  };
  const emissores = { Vieira: emissor };
  const { NfseComunicacaoError } = require('./cliente');
  const ws = async () => { throw new NfseComunicacaoError('timeout na consulta'); };
  const r = await reconciliarProcessando(sb, { chamarWsImpl: ws, emissoresPorSistema: emissores });
  assert.strictEqual(r.fechadas, 0);
  assert.strictEqual(r.voltaram, 0);
  assert.strictEqual(updates.length, 0); // nenhuma nota foi tocada — segue Processando até o próximo ciclo
});
