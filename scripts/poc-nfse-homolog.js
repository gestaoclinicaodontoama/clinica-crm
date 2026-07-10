// scripts/poc-nfse-homolog.js — POC DESCARTÁVEL. Não importar em produção.
// Uso: node scripts/poc-nfse-homolog.js [consultar|gerar|gerar-nbs|gerar-fracao]
//   consultar     → ConsultarNfseFaixa (leitura, sem efeito colateral, bom 1º teste de auth)
//   gerar         → GerarNfse mínimo (Aliquota em formato percentual "3.00")
//   gerar-nbs     → GerarNfse + <NBS>/<IBSCBS> dentro de <Servico> (testa se o schema aceita essas tags)
//   gerar-fracao  → GerarNfse com Aliquota em formato fração "0.03" (em vez de "3.00")
// IM real da Vieira (achado via PDF de nota emitida, CCM 8439700) — sobrescrever com POC_IM_VIEIRA se preciso.
require('dotenv').config();

const HOMOLOG = 'https://testeipatingaabrasf.meumunicipio.online/ws';
const NS = HOMOLOG; // targetNamespace do WSDL = URL do ambiente
const IM_VIEIRA = process.env.POC_IM_VIEIRA || '8439700'; // achado no PDF; '106657' era chute errado (CCM de um TOMADOR)

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function envelope(operacao, xmlInterno) {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body><${operacao} xmlns="${NS}"><xml><![CDATA[${xmlInterno}]]></xml></${operacao}></soap:Body>` +
    `</soap:Envelope>`;
}

// GerarNfseEnvio ABRASF 2.04 mínimo — Vieira, tomador fictício, R$ 1,00
// NOTA: <Tomador> do brief original foi corrigido para <TomadorServico> — o schema
// rejeitou <Tomador> com SCH1 "TAG não é esperada. O Esperado é ( TomadorServico, ... )".
function xmlGerarMinimo({ aliquota = '3.00', comNbsIbscbs = false } = {}) {
  const hoje = new Date().toISOString().slice(0, 10);
  const nbsIbscbs = comNbsIbscbs ? `<NBS>123456</NBS><IBSCBS><valor>1.00</valor></IBSCBS>` : '';
  return `<GerarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd">` +
    `<Rps><InfDeclaracaoPrestacaoServico Id="rps1">` +
    `<Rps><IdentificacaoRps><Numero>1</Numero><Serie>1</Serie><Tipo>1</Tipo></IdentificacaoRps>` +
    `<DataEmissao>${hoje}</DataEmissao><Status>1</Status></Rps>` +
    `<Competencia>${hoje}</Competencia>` +
    `<Servico><Valores><ValorServicos>1.00</ValorServicos><Aliquota>${aliquota}</Aliquota></Valores>` +
    `<IssRetido>2</IssRetido><ItemListaServico>4.12</ItemListaServico>` +
    `${nbsIbscbs}` +
    `<Discriminacao>TESTE POC - nao valido</Discriminacao>` +
    `<CodigoMunicipio>3131307</CodigoMunicipio><ExigibilidadeISS>1</ExigibilidadeISS></Servico>` +
    `<Prestador><CpfCnpj><Cnpj>05617377000108</Cnpj></CpfCnpj>` +
    `<InscricaoMunicipal>${esc(IM_VIEIRA)}</InscricaoMunicipal></Prestador>` +
    `<TomadorServico><IdentificacaoTomador><CpfCnpj><Cpf>11144477735</Cpf></CpfCnpj></IdentificacaoTomador>` +
    `<RazaoSocial>Tomador Teste POC</RazaoSocial></TomadorServico>` +
    `<OptanteSimplesNacional>1</OptanteSimplesNacional><IncentivoFiscal>2</IncentivoFiscal>` +
    `</InfDeclaracaoPrestacaoServico></Rps></GerarNfseEnvio>`;
}

// ConsultarNfseFaixaEnvio — leitura, sem efeito colateral (bom 1º teste de auth)
function xmlConsultaFaixa() {
  return `<ConsultarNfseFaixaEnvio xmlns="http://www.abrasf.org.br/nfse.xsd">` +
    `<Prestador><CpfCnpj><Cnpj>05617377000108</Cnpj></CpfCnpj>` +
    `<InscricaoMunicipal>${esc(IM_VIEIRA)}</InscricaoMunicipal></Prestador>` +
    `<Faixa><NumeroNfseInicial>1</NumeroNfseInicial><NumeroNfseFinal>1</NumeroNfseFinal></Faixa>` +
    `<Pagina>1</Pagina></ConsultarNfseFaixaEnvio>`;
}

async function chamar(operacao, xmlInterno) {
  const body = envelope(operacao, xmlInterno);
  console.log(`\n===== ${operacao} =====`);
  const r = await fetch(HOMOLOG, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"ws#${operacao}"` },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const texto = await r.text();
  console.log('HTTP', r.status);
  console.log(texto.slice(0, 4000));
  return texto;
}

(async () => {
  const modo = process.argv[2] || 'consultar';
  if (modo === 'consultar') await chamar('ConsultarNfseFaixa', xmlConsultaFaixa());
  else if (modo === 'gerar-nbs') await chamar('GerarNfse', xmlGerarMinimo({ comNbsIbscbs: true }));
  else if (modo === 'gerar-fracao') await chamar('GerarNfse', xmlGerarMinimo({ aliquota: '0.03' }));
  else await chamar('GerarNfse', xmlGerarMinimo());
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
