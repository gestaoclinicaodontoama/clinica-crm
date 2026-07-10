// lib/nfse/cliente.test.js — testes do transporte SOAP + parse dos retornos ABRASF.
// Fixtures de erro/consulta usam texto REAL capturado na POC de homologação
// (docs/superpowers/specs/2026-07-09-nfse-poc-achados.md) — não são inventados.
// A única resposta sem evidência real é o "sucesso" (GerarNfse/CancelarNfse ficaram
// bloqueados em E174 "RPS não assinado" na POC); esses casos seguem o schema ABRASF
// padrão e estão marcados como tal.
const test = require('node:test');
const assert = require('node:assert');
const { chamarWs, parseGerarNfse, parseCancelarNfse, parseConsultarPorRps, NfseComunicacaoError } = require('./cliente');

function fakeFetch(status, texto) {
  return async (url, init) => ({ status, ok: status === 200, text: async () => texto, _url: url, _init: init });
}

test('chamarWs monta envelope com CDATA, SOAPAction e namespace de homologação', async () => {
  let capturado;
  const f = async (url, init) => { capturado = { url, init }; return { status: 200, ok: true, text: async () => '<resp/>' }; };
  await chamarWs('GerarNfse', '<GerarNfseEnvio/>', { fetchImpl: f });
  assert.strictEqual(capturado.url, 'https://testeipatingaabrasf.meumunicipio.online/ws');
  assert.strictEqual(capturado.init.headers.SOAPAction, '"ws#GerarNfse"');
  assert.match(capturado.init.body, /<GerarNfse xmlns="https:\/\/testeipatingaabrasf\.meumunicipio\.online\/ws"><xml><!\[CDATA\[<GerarNfseEnvio\/>\]\]><\/xml><\/GerarNfse>/);
});

test('chamarWs: NFSE_TIMEOUT_MS malformado não aborta a chamada (guard contra NaN → timeout 0)', async () => {
  const original = process.env.NFSE_TIMEOUT_MS;
  try {
    process.env.NFSE_TIMEOUT_MS = 'abc';
    const r = await chamarWs('GerarNfse', '<x/>', { fetchImpl: fakeFetch(200, '<resp/>') });
    assert.strictEqual(r, '<resp/>');
  } finally {
    if (original === undefined) delete process.env.NFSE_TIMEOUT_MS; else process.env.NFSE_TIMEOUT_MS = original;
  }
});

test('chamarWs lança NfseComunicacaoError em HTTP 500', async () => {
  await assert.rejects(
    chamarWs('GerarNfse', '<x/>', { fetchImpl: fakeFetch(500, 'erro interno') }),
    NfseComunicacaoError
  );
});

// Achado da POC (seção 2 do achados.md): a resposta HTTP real NÃO vem envolta em
// <return> nem em soap:Envelope visível — o corpo é a XML de resposta ABRASF pura,
// sem escaping de entidades. chamarWs deve devolver esse texto sem alterações.
test('chamarWs devolve o texto puro quando a resposta real do WS não vem envolta em <return> (achado da POC)', async () => {
  const respostaReal = `<ConsultarNfseFaixaResposta xmlns="http://www.abrasf.org.br/nfse.xsd"><ListaMensagemRetorno><MensagemRetorno><Codigo>E212</Codigo><Mensagem>NFS-e não encontrada. - CODE: 8</Mensagem><Correcao>Não existe NFS-e emitida com o número do documento ou do RPS ou período pesquisado.</Correcao></MensagemRetorno></ListaMensagemRetorno></ConsultarNfseFaixaResposta>`;
  const r = await chamarWs('ConsultarNfseFaixa', '<ConsultarNfseFaixaEnvio/>', { fetchImpl: fakeFetch(200, respostaReal) });
  assert.strictEqual(r, respostaReal);
});

// Sucesso do GerarNfse não foi observado na POC (bloqueado em E174 antes de chegar
// aqui) — estrutura abaixo é a padrão ABRASF (ListaNfse > CompNfse > Nfse > InfNfse),
// mantida como melhor esforço até haver uma nota real assinada.
test('parseGerarNfse extrai numero + codigo de verificacao (estrutura padrão ABRASF, sucesso ainda não observado na POC)', () => {
  const xml = `<GerarNfseResposta><ListaNfse><CompNfse><Nfse><InfNfse>` +
    `<Numero>412</Numero><CodigoVerificacao>AB12-CD34</CodigoVerificacao>` +
    `<DataEmissao>2026-07-10T10:00:00</DataEmissao></InfNfse></Nfse></CompNfse></ListaNfse></GerarNfseResposta>`;
  const r = parseGerarNfse(xml);
  assert.deepStrictEqual(r, { ok: true, numero: '412', codigoVerificacao: 'AB12-CD34', dataEmissao: '2026-07-10T10:00:00', avisos: [] });
});

// Achado real da POC (seção 3 do achados.md): GerarNfse com XML mínimo corrigido
// (<TomadorServico>) retorna E174 "RPS não assinado" com Correcao "Assine o  RPS"
// (espaço duplo é literal do retorno do WS).
test('parseGerarNfse: erro real único (E174 RPS não assinado, achado da POC)', () => {
  const xml = `<GerarNfseResposta xmlns="http://www.abrasf.org.br/nfse.xsd"><ListaMensagemRetorno><MensagemRetorno>` +
    `<Codigo>E174</Codigo><Mensagem>RPS não assinado. - CODE: 1</Mensagem><Correcao>Assine o  RPS</Correcao>` +
    `</MensagemRetorno></ListaMensagemRetorno></GerarNfseResposta>`;
  const r = parseGerarNfse(xml);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.erros, [{ codigo: 'E174', mensagem: 'RPS não assinado. - CODE: 1. Assine o  RPS' }]);
});

// Achado real da POC (seção 3 do achados.md): tentativa com <Tomador> (tag errada)
// retorna DOIS MensagemRetorno — SCH1 (sem Correcao) + E160. Prova que _erros lida
// com múltiplos blocos e com Correcao ausente.
test('parseGerarNfse: múltiplos erros reais (SCH1 sem Correcao + E160, achado da POC)', () => {
  const xml = `<GerarNfseResposta xmlns="http://www.abrasf.org.br/nfse.xsd"><ListaMensagemRetorno>` +
    `<MensagemRetorno><Codigo>SCH1</Codigo><Mensagem>TAG 'Tomador': Esta TAG não é esperada. O Esperado é um dos ( TomadorServico, Intermediario, ConstrucaoCivil, Obra, RegimeEspecialTributacao, OptanteSimplesNacional ). - CODE: 1</Mensagem></MensagemRetorno>` +
    `<MensagemRetorno><Codigo>E160</Codigo><Mensagem>Arquivo em desacordo com o XML Schema. - CODE: 1</Mensagem></MensagemRetorno>` +
    `</ListaMensagemRetorno></GerarNfseResposta>`;
  const r = parseGerarNfse(xml);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.erros.length, 2);
  assert.deepStrictEqual(r.erros[0], { codigo: 'SCH1', mensagem: "TAG 'Tomador': Esta TAG não é esperada. O Esperado é um dos ( TomadorServico, Intermediario, ConstrucaoCivil, Obra, RegimeEspecialTributacao, OptanteSimplesNacional ). - CODE: 1" });
  assert.deepStrictEqual(r.erros[1], { codigo: 'E160', mensagem: 'Arquivo em desacordo com o XML Schema. - CODE: 1' });
});

// CancelarNfse não foi exercitado na POC (fora de escopo, exige nota já emitida).
// Estrutura abaixo segue o padrão ABRASF (RetCancelamento > Confirmacao); melhor
// esforço até haver uma nota real cancelada.
test('parseCancelarNfse extrai data de cancelamento (estrutura padrão ABRASF, não observado na POC)', () => {
  const xml = `<CancelarNfseResposta><RetCancelamento><Confirmacao>` +
    `<Pedido><InfPedidoCancelamento><Numero>412</Numero></InfPedidoCancelamento></Pedido>` +
    `<DataHora>2026-07-10T12:00:00</DataHora>` +
    `</Confirmacao></RetCancelamento></CancelarNfseResposta>`;
  const r = parseCancelarNfse(xml);
  assert.deepStrictEqual(r, { ok: true, dataCancelamento: '2026-07-10T12:00:00' });
});

test('parseCancelarNfse: Confirmacao sem DataHora retorna null (não fabrica timestamp)', () => {
  const xml = `<CancelarNfseResposta><RetCancelamento><Confirmacao>` +
    `<Pedido><InfPedidoCancelamento><Numero>412</Numero></InfPedidoCancelamento></Pedido>` +
    `</Confirmacao></RetCancelamento></CancelarNfseResposta>`;
  const r = parseCancelarNfse(xml);
  assert.deepStrictEqual(r, { ok: true, dataCancelamento: null });
});

test('parseCancelarNfse: lista de erros quando não confirma', () => {
  const xml = `<CancelarNfseResposta><ListaMensagemRetorno><MensagemRetorno>` +
    `<Codigo>E92</Codigo><Mensagem>NFS-e não encontrada</Mensagem>` +
    `</MensagemRetorno></ListaMensagemRetorno></CancelarNfseResposta>`;
  const r = parseCancelarNfse(xml);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.erros, [{ codigo: 'E92', mensagem: 'NFS-e não encontrada' }]);
});

// Sucesso do ConsultarPorRps também não foi observado (o único teste real na POC foi
// ConsultarNfseFaixa, que já resultou em E212 por faixa vazia) — mantido por spec.
test('parseConsultarPorRps: nota existe (estrutura padrão ABRASF, não observado na POC)', () => {
  const existe = parseConsultarPorRps(`<x><InfNfse><Numero>77</Numero><CodigoVerificacao>ZZ</CodigoVerificacao><DataEmissao>2026-07-10</DataEmissao></InfNfse></x>`);
  assert.strictEqual(existe.existe, true);
  assert.strictEqual(existe.numero, '77');
  assert.strictEqual(existe.codigoVerificacao, 'ZZ');
  assert.deepStrictEqual(existe.avisos, []);
});

test('parseConsultarPorRps: nota existe com MensagemRetorno (avisos)', () => {
  const xml = `<x><InfNfse><Numero>77</Numero><CodigoVerificacao>ZZ</CodigoVerificacao><DataEmissao>2026-07-10</DataEmissao></InfNfse>` +
    `<ListaMensagemRetorno><MensagemRetorno>` +
    `<Codigo>W002</Codigo><Mensagem>Aviso na consulta</Mensagem>` +
    `</MensagemRetorno></ListaMensagemRetorno></x>`;
  const r = parseConsultarPorRps(xml);
  assert.strictEqual(r.existe, true);
  assert.strictEqual(r.numero, '77');
  assert.strictEqual(r.avisos.length, 1);
  assert.deepStrictEqual(r.avisos[0], { codigo: 'W002', mensagem: 'Aviso na consulta' });
});

// Achado real da POC (seção 2 do achados.md): ConsultarNfseFaixa com IM correta e
// faixa vazia retorna E212 "NFS-e não encontrada" com Correcao.
test('parseConsultarPorRps: nao existe — erro real (E212, achado da POC)', () => {
  const xml = `<ConsultarNfseFaixaResposta xmlns="http://www.abrasf.org.br/nfse.xsd"><ListaMensagemRetorno><MensagemRetorno>` +
    `<Codigo>E212</Codigo><Mensagem>NFS-e não encontrada. - CODE: 8</Mensagem>` +
    `<Correcao>Não existe NFS-e emitida com o número do documento ou do RPS ou período pesquisado.</Correcao>` +
    `</MensagemRetorno></ListaMensagemRetorno></ConsultarNfseFaixaResposta>`;
  const r = parseConsultarPorRps(xml);
  assert.strictEqual(r.existe, false);
  assert.deepStrictEqual(r.erros, [{ codigo: 'E212', mensagem: 'NFS-e não encontrada. - CODE: 8. Não existe NFS-e emitida com o número do documento ou do RPS ou período pesquisado.' }]);
});

// Regressão: InfNfse real aninha DeclaracaoPrestacaoServico > ... > IdentificacaoRps >
// NumeroRps ANTES do <Numero> da própria NFS-e — _tag('Numero') não pode confundir com
// _tag('NumeroRps').
test('parseGerarNfse: nao confunde <Numero> com <NumeroRps> aninhado antes dele', () => {
  const xml = `<GerarNfseResposta><ListaNfse><CompNfse><Nfse><InfNfse>` +
    `<DeclaracaoPrestacaoServico><InfDeclaracaoPrestacaoServico><Rps><IdentificacaoRps>` +
    `<NumeroRps>1</NumeroRps></IdentificacaoRps></Rps></InfDeclaracaoPrestacaoServico></DeclaracaoPrestacaoServico>` +
    `<Numero>412</Numero><CodigoVerificacao>AB12-CD34</CodigoVerificacao><DataEmissao>2026-07-10T10:00:00</DataEmissao>` +
    `</InfNfse></Nfse></CompNfse></ListaNfse></GerarNfseResposta>`;
  const r = parseGerarNfse(xml);
  assert.strictEqual(r.numero, '412');
  assert.deepStrictEqual(r.avisos, []);
});

test('parseGerarNfse: sucesso com MensagemRetorno (avisos)', () => {
  const xml = `<GerarNfseResposta><ListaNfse><CompNfse><Nfse><InfNfse>` +
    `<Numero>412</Numero><CodigoVerificacao>AB12-CD34</CodigoVerificacao>` +
    `<DataEmissao>2026-07-10T10:00:00</DataEmissao></InfNfse></Nfse></CompNfse></ListaNfse>` +
    `<ListaMensagemRetorno><MensagemRetorno>` +
    `<Codigo>W001</Codigo><Mensagem>Aviso importante</Mensagem>` +
    `</MensagemRetorno></ListaMensagemRetorno></GerarNfseResposta>`;
  const r = parseGerarNfse(xml);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.numero, '412');
  assert.strictEqual(r.avisos.length, 1);
  assert.deepStrictEqual(r.avisos[0], { codigo: 'W001', mensagem: 'Aviso importante' });
});

test('urlWs: homologação por padrão, produção só com NFSE_AMBIENTE=producao', () => {
  const original = process.env.NFSE_AMBIENTE;
  try {
    delete process.env.NFSE_AMBIENTE;
    assert.strictEqual(require('./cliente').urlWs(), 'https://testeipatingaabrasf.meumunicipio.online/ws');
    process.env.NFSE_AMBIENTE = 'qualquer-coisa';
    assert.strictEqual(require('./cliente').urlWs(), 'https://testeipatingaabrasf.meumunicipio.online/ws');
    process.env.NFSE_AMBIENTE = 'producao';
    assert.strictEqual(require('./cliente').urlWs(), 'https://abrasfipatinga.meumunicipio.online/ws');
  } finally {
    if (original === undefined) delete process.env.NFSE_AMBIENTE; else process.env.NFSE_AMBIENTE = original;
  }
});
