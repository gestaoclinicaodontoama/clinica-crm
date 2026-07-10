// lib/nfse/montar-xml.test.js
const test = require('node:test');
const assert = require('node:assert');
const { montarGerarNfseEnvio, montarCancelarNfseEnvio, montarConsultarNfsePorRpsEnvio, escapeXml } = require('./montar-xml');

const emissor = {
  sistema: 'Vieira', razao_social: 'Vieira e Vidigal Martins LTDA', cnpj: '05617377000108',
  inscricao_municipal: '8439700', optante_simples: 1, item_lista_servico: '4.12',
  aliquota: 3.00, cnbs: '123012300', descricao_padrao: 'Serviços odontológicos',
};
const nota = {
  id: 42, sistema: 'Vieira', competencia: '07-2026', tipo_tomador: 'CPF',
  cpf_tomador: '11144477735', nome_tomador: 'Maria & Silva <Teste>',
  data_pagamento: '2026-07-05', valor: 395.62, descricao: 'Tratamento odontológico',
};

test('gera GerarNfseEnvio com RPS, competência e valores formatados', () => {
  const xml = montarGerarNfseEnvio(nota, emissor, { numero: 7, serie: '1' });
  assert.match(xml, /<GerarNfseEnvio xmlns="http:\/\/www\.abrasf\.org\.br\/nfse\.xsd">/);
  assert.match(xml, /<IdentificacaoRps><Numero>7<\/Numero><Serie>1<\/Serie><Tipo>1<\/Tipo>/);
  assert.match(xml, /<Competencia>2026-07-01<\/Competencia>/);      // MM-AAAA → AAAA-MM-01
  assert.match(xml, /<ValorServicos>395\.62<\/ValorServicos>/);      // ponto decimal, 2 casas
  assert.match(xml, /<Cnpj>05617377000108<\/Cnpj>/);
  // POC (achados): schema exige <TomadorServico>, não <Tomador> (rejeitado com SCH1)
  assert.match(xml, /<TomadorServico><IdentificacaoTomador><CpfCnpj><Cpf>11144477735<\/Cpf><\/CpfCnpj><\/IdentificacaoTomador>/);
  assert.doesNotMatch(xml, /<Tomador>/); // garante que não regride para a tag rejeitada pelo schema
  assert.match(xml, /Maria &amp; Silva &lt;Teste&gt;/);              // escape XML
  assert.match(xml, /<CodigoMunicipio>3131307<\/CodigoMunicipio>/);
  // não deve existir grupo IBSCBS (não existe neste schema, achados item 5)
  assert.doesNotMatch(xml, /IBSCBS/);
});

test('tomador CNPJ usa <Cnpj> e valida 14 dígitos', () => {
  const xml = montarGerarNfseEnvio({ ...nota, tipo_tomador: 'CNPJ', cpf_tomador: '19876424000142' }, emissor, { numero: 8, serie: '1' });
  assert.match(xml, /<TomadorServico><IdentificacaoTomador><CpfCnpj><Cnpj>19876424000142<\/Cnpj>/);
});

test('valor inválido ou CPF com tamanho errado lança erro claro', () => {
  assert.throws(() => montarGerarNfseEnvio({ ...nota, valor: 0 }, emissor, { numero: 9, serie: '1' }), /valor/i);
  assert.throws(() => montarGerarNfseEnvio({ ...nota, cpf_tomador: '123' }, emissor, { numero: 9, serie: '1' }), /CPF/i);
});

test('CancelarNfseEnvio inclui numero, prestador e código de cancelamento', () => {
  const xml = montarCancelarNfseEnvio({ numeroNfse: '412', emissor, codigoCancelamento: '2' });
  assert.match(xml, /<Numero>412<\/Numero>/);
  assert.match(xml, /<CodigoCancelamento>2<\/CodigoCancelamento>/);
});

test('ConsultarNfsePorRpsEnvio inclui numero/serie do RPS e prestador', () => {
  const xml = montarConsultarNfsePorRpsEnvio({ rpsNumero: 7, rpsSerie: '1', emissor });
  assert.match(xml, /<ConsultarNfseRpsEnvio xmlns="http:\/\/www\.abrasf\.org\.br\/nfse\.xsd">/);
  assert.match(xml, /<IdentificacaoRps><Numero>7<\/Numero><Serie>1<\/Serie><Tipo>1<\/Tipo><\/IdentificacaoRps>/);
  assert.match(xml, /<Cnpj>05617377000108<\/Cnpj>/);
});

test('escapeXml cobre & < > " \'', () => {
  assert.strictEqual(escapeXml(`a&b<c>"d'`), 'a&amp;b&lt;c&gt;&quot;d&#39;');
});

test('CodigoTributacaoMunicipio aparece entre ItemListaServico e Discriminacao quando configurado', () => {
  const xml = montarGerarNfseEnvio(nota, { ...emissor, codigo_tributacao_municipio: '4.12<x>' }, { numero: 10, serie: '1' });
  assert.match(xml, /<\/ItemListaServico><CodigoTributacaoMunicipio>4\.12&lt;x&gt;<\/CodigoTributacaoMunicipio><Discriminacao>/);
});

test('CodigoTributacaoMunicipio ausente quando não configurado', () => {
  const xml = montarGerarNfseEnvio(nota, emissor, { numero: 11, serie: '1' });
  assert.doesNotMatch(xml, /<CodigoTributacaoMunicipio>/);
});
