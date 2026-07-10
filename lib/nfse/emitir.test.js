// lib/nfse/emitir.test.js
const test = require('node:test');
const assert = require('node:assert');
const { _processarUma, reconciliarProcessando, processarPendentes } = require('./emitir');
const { NfseComunicacaoError } = require('./cliente');

// Mock mínimo do client Supabase para as operações usadas (from().update().eq(), rpc())
function supabaseMock({ rps = 10, rpcError = null } = {}) {
  const updates = [];
  return {
    updates,
    rpc: async (fn, args) => (rpcError ? { data: null, error: rpcError } : { data: rps, error: null }),
    from: (tabela) => ({
      update: (patch) => ({ eq: async (col, val) => { updates.push({ tabela, patch, id: val }); return { error: null }; } }),
    }),
  };
}

const emissor = { sistema: 'Vieira', cnpj: '05617377000108', inscricao_municipal: '106657', optante_simples: 1, item_lista_servico: '4.12', aliquota: 3, descricao_padrao: 'Serviços odontológicos', ativo: true };
const nota = { id: 42, sistema: 'Vieira', competencia: '07-2026', tipo_tomador: 'CPF', cpf_tomador: '11144477735', nome_tomador: 'Teste', valor: 100, descricao: 'x', rps_serie: '1' };

const XML_SUCESSO = `<r><InfNfse><Numero>412</Numero><CodigoVerificacao>AB</CodigoVerificacao><DataEmissao>2026-07-10</DataEmissao></InfNfse></r>`;

test('sucesso: grava Emitida com numero + codigo de verificacao + xmls', async () => {
  const sb = supabaseMock();
  const ws = async () => XML_SUCESSO;
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
  const sb = supabaseMock();
  const ws = async () => { throw new NfseComunicacaoError('timeout'); };
  const r = await _processarUma(sb, nota, emissor, { chamarWsImpl: ws });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.pendenteReconciliacao, true);
  const final = sb.updates.at(-1).patch;
  assert.strictEqual(final.status, 'Processando'); // permanece; reconciliador resolve
});

test('nota inválida (não-comunicação): grava Erro com a mensagem e NÃO lança (lote continua)', async () => {
  const sb = supabaseMock();
  const notaRuim = { ...nota, cpf_tomador: '123' }; // montarGerarNfseEnvio lança
  const ws = async () => { throw new Error('ws não deveria ser chamado'); };
  const r = await _processarUma(sb, notaRuim, emissor, { chamarWsImpl: ws });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.pendenteReconciliacao, undefined);
  const final = sb.updates.at(-1).patch;
  assert.strictEqual(final.status, 'Erro');
  assert.match(final.erro_msg, /CPF do tomador/);
  assert.strictEqual(final.rps_numero, 10); // reserva persistida p/ reuso no reprocesso
});

test('falha ao reservar RPS: nota permanece Pendente (sem status no patch) mas com erro_msg durável', async () => {
  const sb = supabaseMock({ rpcError: { message: 'sequência indisponível' } });
  const r = await _processarUma(sb, nota, emissor, { chamarWsImpl: async () => XML_SUCESSO });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(sb.updates.length, 1);
  const final = sb.updates.at(-1).patch;
  assert.strictEqual(final.status, undefined); // não muda o status — segue Pendente
  assert.match(final.erro_msg, /falha ao reservar RPS: sequência indisponível/);
});

test('falha ao GRAVAR a Emitida: conta como erro e sinaliza reconciliação (linha segue Processando)', async () => {
  const efetivados = [];
  const sb = {
    rpc: async () => ({ data: 10, error: null }),
    from: () => ({
      update: (patch) => ({ eq: async (c, id) => {
        // update Processando grava; update Emitida falha (simula queda de conexão com o banco)
        if (patch.status === 'Emitida') return { error: { message: 'conexão caiu' } };
        efetivados.push({ id, patch });
        return { error: null };
      } }),
    }),
  };
  const r = await _processarUma(sb, nota, emissor, { chamarWsImpl: async () => XML_SUCESSO });
  assert.strictEqual(r.ok, false); // NÃO conta como emitida — fica visível como erro
  assert.strictEqual(r.pendenteReconciliacao, true);
  assert.strictEqual(efetivados.at(-1).patch.status, 'Processando'); // último update efetivado no banco
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
  const ws = async () => { throw new NfseComunicacaoError('timeout na consulta'); };
  const r = await reconciliarProcessando(sb, { chamarWsImpl: ws, emissoresPorSistema: { Vieira: emissor } });
  assert.strictEqual(r.fechadas, 0);
  assert.strictEqual(r.voltaram, 0);
  assert.strictEqual(updates.length, 0); // nenhuma nota foi tocada — segue Processando até o próximo ciclo
});

test('reconciliar: InfNfse malformado (sem CodigoVerificacao) → NÃO marca Emitida, nota mantida Processando sem update', async () => {
  const presas = [
    { id: 3, sistema: 'Vieira', rps_numero: 8, rps_serie: '1', status: 'Processando' },
  ];
  const updates = [];
  const sb = {
    from: (t) => ({
      select: () => ({ eq: () => ({ limit: async () => ({ data: presas, error: null }) }) }),
      update: (patch) => ({ eq: async (c, id) => { updates.push({ id, patch }); return { error: null }; } }),
    }),
  };
  // existe=true (InfNfse presente) mas sem CodigoVerificacao — jamais fechar Emitida às cegas
  const ws = async () => `<r><InfNfse><Numero>800</Numero><DataEmissao>2026-07-10</DataEmissao></InfNfse></r>`;
  const r = await reconciliarProcessando(sb, { chamarWsImpl: ws, emissoresPorSistema: { Vieira: emissor } });
  assert.strictEqual(r.fechadas, 0);
  assert.strictEqual(r.voltaram, 0);
  assert.strictEqual(updates.length, 0); // update NÃO chamado — segue presa p/ próximo ciclo
});

// ---- processarPendentes (lote inteiro) ----

// Mock estrito da cadeia real do supabase-js: método/tabela não previsto lança em vez de aceitar em silêncio.
function sbLoteMock({ notasPendentes, presas = [] }) {
  const updates = [];
  const calls = { reconciler: 0 };
  let proximoRps = 10;
  return {
    updates, calls,
    rpc: async (fn, args) => {
      assert.strictEqual(fn, 'nf_reservar_rps');
      return { data: proximoRps++, error: null };
    },
    from: (tabela) => {
      if (tabela === 'nf_emissores') return {
        select: () => ({
          eq: (col, val) => {
            assert.strictEqual(col, 'ativo'); assert.strictEqual(val, true);
            return { limit: async () => ({ data: [emissor], error: null }) };
          },
        }),
      };
      if (tabela === 'notas_fiscais') return {
        select: () => ({
          eq: (col, val) => {
            if (val === 'Pendente') return { in: (c, sistemas) => {
              assert.deepStrictEqual(sistemas, ['Vieira']);
              return { order: () => ({ limit: async () => ({ data: notasPendentes, error: null }) }) };
            } };
            if (val === 'Processando') { calls.reconciler++; return { limit: async () => ({ data: presas, error: null }) }; }
            throw new Error(`eq inesperado no select: ${col}=${val}`);
          },
        }),
        update: (patch) => ({ eq: async (c, id) => { updates.push({ id, patch }); return { error: null }; } }),
      };
      throw new Error(`tabela inesperada: ${tabela}`);
    },
  };
}

test('processarPendentes: happy path — processa as 2 notas do lote e conta emitidas', async () => {
  const notas = [{ ...nota, id: 101 }, { ...nota, id: 102 }];
  const sb = sbLoteMock({ notasPendentes: notas });
  const ws = async () => XML_SUCESSO;
  const r = await processarPendentes(sb, { chamarWsImpl: ws });
  assert.strictEqual(r.emitidas, 2);
  assert.strictEqual(r.erros, 0);
  assert.strictEqual(r.detalhes.length, 2);
  assert.deepStrictEqual(r.detalhes.map(d => d.id), [101, 102]);
  const emitidas = sb.updates.filter(u => u.patch.status === 'Emitida');
  assert.strictEqual(emitidas.length, 2);
  assert.strictEqual(sb.calls.reconciler, 1); // reconciliação rodou ao fim do lote
});

test('processarPendentes: nota inválida no meio do lote → Erro nela, a PRÓXIMA ainda é processada e a reconciliação roda', async () => {
  const notas = [
    { ...nota, id: 201, cpf_tomador: '123' }, // inválida — montagem lança
    { ...nota, id: 202 },                      // válida
  ];
  const sb = sbLoteMock({ notasPendentes: notas });
  const ws = async () => XML_SUCESSO;
  const r = await processarPendentes(sb, { chamarWsImpl: ws });
  assert.strictEqual(r.emitidas, 1);
  assert.strictEqual(r.erros, 1);
  const updErro = sb.updates.find(u => u.id === 201 && u.patch.status === 'Erro');
  assert.ok(updErro, 'nota 201 deve ir a Erro');
  assert.match(updErro.patch.erro_msg, /CPF do tomador/);
  const updEmitida = sb.updates.find(u => u.id === 202 && u.patch.status === 'Emitida');
  assert.ok(updEmitida, 'nota 202 deve ser processada mesmo com erro na anterior');
  assert.strictEqual(sb.calls.reconciler, 1); // reconciliação roda mesmo com erro no meio do lote
});

test('processarPendentes: reentrância — segunda chamada retorna jaRodando sem tocar o banco', async () => {
  let liberar;
  const gate = new Promise((res) => { liberar = res; });
  // 1ª chamada fica presa no select de nf_emissores até liberarmos o gate
  const sbLento = {
    rpc: async () => ({ data: 1, error: null }),
    from: (tabela) => {
      if (tabela === 'nf_emissores') return {
        select: () => ({ eq: () => ({ limit: async () => { await gate; return { data: [], error: null }; } }) }),
      };
      if (tabela === 'notas_fiscais') return {
        select: () => ({
          eq: (c, v) => v === 'Pendente'
            ? { in: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }
            : { limit: async () => ({ data: [], error: null }) },
        }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
      throw new Error(`tabela inesperada: ${tabela}`);
    },
  };
  const sbIntocavel = {
    from: () => { throw new Error('não deveria tocar o banco'); },
    rpc: () => { throw new Error('não deveria tocar o banco'); },
  };
  const p1 = processarPendentes(sbLento, { chamarWsImpl: async () => XML_SUCESSO });
  const r2 = await processarPendentes(sbIntocavel);
  assert.strictEqual(r2.jaRodando, true);
  assert.deepStrictEqual({ emitidas: r2.emitidas, erros: r2.erros }, { emitidas: 0, erros: 0 });
  liberar();
  const r1 = await p1;
  assert.strictEqual(r1.jaRodando, undefined);
});
