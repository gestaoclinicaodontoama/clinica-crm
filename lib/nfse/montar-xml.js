// lib/nfse/montar-xml.js — gera os XMLs ABRASF 2.04 (padrão SigCorp/Ipatinga).
// Estrutura validada na POC (docs/superpowers/specs/2026-07-09-nfse-poc-achados.md,
// bloco XML_MINIMO_ACEITO): passou por 100% da validação de schema do WS de homologação
// (só falta assinatura digital, que é responsabilidade de outra task).
// ⚠️ O schema deste município exige <TomadorServico>, NÃO <Tomador> — o schema rejeita
// <Tomador> com erro SCH1 ("TAG 'Tomador' não é esperada"). Não existe grupo IBSCBS
// neste schema (ABRASF 2.04 clássico, pré-reforma tributária) — não adicionar.
const NS = 'http://www.abrasf.org.br/nfse.xsd';
const COD_MUNICIPIO = '3131307'; // IBGE Ipatinga

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _valor(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  if (!n || n <= 0 || !isFinite(n)) throw new Error(`valor inválido: ${v}`);
  return n.toFixed(2);
}

function _competencia(mmaaaa) {
  const m = /^(\d{2})-(\d{4})$/.exec(String(mmaaaa || ''));
  if (!m) throw new Error(`competência inválida (esperado MM-AAAA): ${mmaaaa}`);
  return `${m[2]}-${m[1]}-01`;
}

function _tomadorDoc(nota) {
  const doc = String(nota.cpf_tomador || '').replace(/\D/g, '');
  if (nota.tipo_tomador === 'CNPJ') {
    if (doc.length !== 14) throw new Error(`CNPJ do tomador deve ter 14 dígitos: ${doc}`);
    return `<Cnpj>${doc}</Cnpj>`;
  }
  if (doc.length !== 11) throw new Error(`CPF do tomador deve ter 11 dígitos: ${doc}`);
  return `<Cpf>${doc}</Cpf>`;
}

function _prestador(emissor) {
  return `<Prestador><CpfCnpj><Cnpj>${emissor.cnpj}</Cnpj></CpfCnpj>` +
    `<InscricaoMunicipal>${escapeXml(emissor.inscricao_municipal)}</InscricaoMunicipal></Prestador>`;
}

function montarGerarNfseEnvio(nota, emissor, rps) {
  const hoje = new Date().toISOString().slice(0, 10);
  const valor = _valor(nota.valor);
  const discriminacao = escapeXml(nota.descricao || emissor.descricao_padrao || 'Serviços odontológicos');
  return `<GerarNfseEnvio xmlns="${NS}">` +
    `<Rps><InfDeclaracaoPrestacaoServico Id="rps${rps.numero}">` +
    `<Rps><IdentificacaoRps><Numero>${rps.numero}</Numero><Serie>${escapeXml(rps.serie)}</Serie><Tipo>1</Tipo></IdentificacaoRps>` +
    `<DataEmissao>${hoje}</DataEmissao><Status>1</Status></Rps>` +
    `<Competencia>${_competencia(nota.competencia)}</Competencia>` +
    `<Servico><Valores><ValorServicos>${valor}</ValorServicos>` +
    `<Aliquota>${Number(emissor.aliquota).toFixed(2)}</Aliquota></Valores>` +
    `<IssRetido>2</IssRetido>` +
    `<ItemListaServico>${escapeXml(emissor.item_lista_servico)}</ItemListaServico>` +
    (emissor.codigo_tributacao_municipio ? `<CodigoTributacaoMunicipio>${escapeXml(emissor.codigo_tributacao_municipio)}</CodigoTributacaoMunicipio>` : '') +
    `<Discriminacao>${discriminacao}</Discriminacao>` +
    `<CodigoMunicipio>${COD_MUNICIPIO}</CodigoMunicipio><ExigibilidadeISS>1</ExigibilidadeISS></Servico>` +
    _prestador(emissor) +
    // TomadorServico (não Tomador) — ver nota de topo do arquivo / achados item 3.
    `<TomadorServico><IdentificacaoTomador><CpfCnpj>${_tomadorDoc(nota)}</CpfCnpj></IdentificacaoTomador>` +
    `<RazaoSocial>${escapeXml(nota.nome_tomador)}</RazaoSocial></TomadorServico>` +
    `<OptanteSimplesNacional>${emissor.optante_simples}</OptanteSimplesNacional><IncentivoFiscal>2</IncentivoFiscal>` +
    `</InfDeclaracaoPrestacaoServico></Rps></GerarNfseEnvio>`;
}

function montarCancelarNfseEnvio({ numeroNfse, emissor, codigoCancelamento }) {
  return `<CancelarNfseEnvio xmlns="${NS}"><Pedido><InfPedidoCancelamento Id="canc${numeroNfse}">` +
    `<IdentificacaoNfse><Numero>${escapeXml(numeroNfse)}</Numero>` +
    `<CpfCnpj><Cnpj>${emissor.cnpj}</Cnpj></CpfCnpj>` +
    `<InscricaoMunicipal>${escapeXml(emissor.inscricao_municipal)}</InscricaoMunicipal>` +
    `<CodigoMunicipio>${COD_MUNICIPIO}</CodigoMunicipio></IdentificacaoNfse>` +
    `<CodigoCancelamento>${escapeXml(codigoCancelamento)}</CodigoCancelamento>` +
    `</InfPedidoCancelamento></Pedido></CancelarNfseEnvio>`;
}

function montarConsultarNfsePorRpsEnvio({ rpsNumero, rpsSerie, emissor }) {
  return `<ConsultarNfseRpsEnvio xmlns="${NS}">` +
    `<IdentificacaoRps><Numero>${rpsNumero}</Numero><Serie>${escapeXml(rpsSerie)}</Serie><Tipo>1</Tipo></IdentificacaoRps>` +
    _prestador(emissor) + `</ConsultarNfseRpsEnvio>`;
}

module.exports = { montarGerarNfseEnvio, montarCancelarNfseEnvio, montarConsultarNfsePorRpsEnvio, escapeXml };
