// lib/nfse/cliente.js — transporte SOAP (document/literal, xml interno como string) + parse
// dos retornos ABRASF do WS de Ipatinga (SigCorp).
//
// Achado real da POC (docs/superpowers/specs/2026-07-09-nfse-poc-achados.md, seção 2):
// a resposta HTTP do WS NÃO vem envolta em <return> nem mostra soap:Envelope visível —
// o corpo é a XML de resposta ABRASF pura (ex.: <ConsultarNfseFaixaResposta>...), sem
// escaping de entidades. O fallback abaixo (`_tag(texto,'return') ?? texto`) cobre esse
// caso real (retorna o texto cru) e mantém uma rede de segurança caso outra operação ou
// uma futura mudança do WS volte a embrulhar em <return> (comum em outras implementações
// ABRASF Brasil afora) — nesse caso desescapa entidades antes de devolver.
//
// Respostas ABRASF são pequenas e de esquema fixo → extração por regex tolerante
// (decisão consciente: zero dependência de parser XML).
const ENDPOINTS = {
  producao: 'https://abrasfipatinga.meumunicipio.online/ws',
  homologacao: 'https://testeipatingaabrasf.meumunicipio.online/ws',
};

class NfseComunicacaoError extends Error {}

function _ambiente() { return process.env.NFSE_AMBIENTE === 'producao' ? 'producao' : 'homologacao'; }
function urlWs() { return ENDPOINTS[_ambiente()]; }

function _desescapar(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// (?=[\s/>]) impede que "Numero" case com "NumeroRps" — sem essa checagem de fronteira,
// tags mais longas com o mesmo prefixo (ex.: <NumeroRps> aninhada em IdentificacaoRps
// dentro de InfNfse) seriam capturadas por engano no lugar da tag certa.
function _tag(xml, nome) {
  const m = new RegExp(`<(?:\\w+:)?${nome}(?=[\\s/>])[^>]*>([\\s\\S]*?)</(?:\\w+:)?${nome}>`).exec(xml);
  return m ? m[1].trim() : null;
}

function _todas(xml, nome) {
  const re = new RegExp(`<(?:\\w+:)?${nome}(?=[\\s/>])[^>]*>([\\s\\S]*?)</(?:\\w+:)?${nome}>`, 'g');
  const out = []; let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

async function chamarWs(operacao, xmlInterno, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const url = urlWs();
  const body = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<${operacao} xmlns="${url}"><xml><![CDATA[${xmlInterno}]]></xml></${operacao}>` +
    `</soap:Body></soap:Envelope>`;
  let resp;
  try {
    const t = parseInt(process.env.NFSE_TIMEOUT_MS || '45000', 10);
    const timeoutMs = Number.isFinite(t) && t > 0 ? t : 45000;
    resp = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"ws#${operacao}"` },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new NfseComunicacaoError(`falha de rede/timeout em ${operacao}: ${e.message}`);
  }
  const texto = await resp.text();
  if (resp.status !== 200) throw new NfseComunicacaoError(`HTTP ${resp.status} em ${operacao}: ${texto.slice(0, 300)}`);
  // resposta real observada na POC vem crua (sem <return>); mantido fallback defensivo
  // para o caso de vir envolta e escapada.
  const interno = _tag(texto, 'return') ?? texto;
  return interno.includes('&lt;') ? _desescapar(interno) : interno;
}

function _erros(xml) {
  return _todas(xml, 'MensagemRetorno').map((bloco) => {
    const codigo = _tag(bloco, 'Codigo') || '?';
    const msg = _tag(bloco, 'Mensagem') || 'erro não informado';
    const corr = _tag(bloco, 'Correcao');
    return { codigo, mensagem: corr ? `${msg}. ${corr}` : msg };
  });
}

function parseGerarNfse(xml) {
  const inf = _tag(xml, 'InfNfse');
  if (inf) {
    return { ok: true, numero: _tag(inf, 'Numero'), codigoVerificacao: _tag(inf, 'CodigoVerificacao'), dataEmissao: _tag(inf, 'DataEmissao'), avisos: _erros(xml) };
  }
  const erros = _erros(xml);
  return { ok: false, erros: erros.length ? erros : [{ codigo: '?', mensagem: `resposta sem InfNfse nem erros: ${xml.slice(0, 200)}` }] };
}

function parseCancelarNfse(xml) {
  const conf = _tag(xml, 'Confirmacao') ?? _tag(xml, 'RetCancelamento');
  if (conf !== null) return { ok: true, dataCancelamento: _tag(xml, 'DataHora') };
  const erros = _erros(xml);
  if (erros.length) return { ok: false, erros };
  return { ok: false, erros: [{ codigo: '?', mensagem: `resposta inesperada: ${xml.slice(0, 200)}` }] };
}

function parseConsultarPorRps(xml) {
  const inf = _tag(xml, 'InfNfse');
  if (inf) return { existe: true, numero: _tag(inf, 'Numero'), codigoVerificacao: _tag(inf, 'CodigoVerificacao'), dataEmissao: _tag(inf, 'DataEmissao'), avisos: _erros(xml) };
  return { existe: false, erros: _erros(xml) };
}

module.exports = { chamarWs, urlWs, parseGerarNfse, parseCancelarNfse, parseConsultarPorRps, NfseComunicacaoError };
