const test = require('node:test');
const assert = require('node:assert');
const forge = require('node-forge');
const { assinarXml, carregarCertificado } = require('./assinar');

function pfxTeste(senha) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const attrs = [{ name: 'commonName', value: 'TESTE NFSE' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], senha, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary').toString('base64');
}

test('assinarXml anexa Signature com Reference ao Id informado', () => {
  const pfxB64 = pfxTeste('123456');
  const xml = `<GerarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd"><Rps>` +
    `<InfDeclaracaoPrestacaoServico Id="rps7"><Competencia>2026-07-01</Competencia></InfDeclaracaoPrestacaoServico>` +
    `</Rps></GerarNfseEnvio>`;
  const assinado = assinarXml(xml, { pfxB64, senha: '123456', referenciaUri: 'rps7' });
  assert.match(assinado, /<(?:ds:)?Signature/);
  assert.match(assinado, /URI="#rps7"/);
  assert.match(assinado, /<(?:ds:)?X509Certificate>/);
});

test('assinarXml produz DigestValue e SignatureValue não-vazios', () => {
  const pfxB64 = pfxTeste('123456');
  const xml = `<GerarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd"><Rps>` +
    `<InfDeclaracaoPrestacaoServico Id="rps7"><Competencia>2026-07-01</Competencia></InfDeclaracaoPrestacaoServico>` +
    `</Rps></GerarNfseEnvio>`;
  const assinado = assinarXml(xml, { pfxB64, senha: '123456', referenciaUri: 'rps7' });

  const digestMatch = assinado.match(/<(?:ds:)?DigestValue>([^<]+)<\/(?:ds:)?DigestValue>/);
  const sigMatch = assinado.match(/<(?:ds:)?SignatureValue>([^<]+)<\/(?:ds:)?SignatureValue>/);
  const certMatch = assinado.match(/<(?:ds:)?X509Certificate>([^<]+)<\/(?:ds:)?X509Certificate>/);

  assert.ok(digestMatch && digestMatch[1].trim().length > 0, 'DigestValue deve ter conteúdo');
  assert.ok(sigMatch && sigMatch[1].trim().length > 0, 'SignatureValue deve ter conteúdo');
  assert.ok(certMatch && certMatch[1].trim().length > 0, 'X509Certificate deve ter conteúdo');

  // Signature deve estar DENTRO de <Rps>, logo após o elemento referenciado (convenção ABRASF).
  const idxInfDecl = assinado.indexOf('</InfDeclaracaoPrestacaoServico>');
  const idxSignature = assinado.indexOf('<Signature', idxInfDecl >= 0 ? idxInfDecl : 0) >= 0
    ? assinado.indexOf('Signature', idxInfDecl)
    : -1;
  const idxRpsClose = assinado.indexOf('</Rps>');
  assert.ok(idxInfDecl > -1 && idxSignature > idxInfDecl, 'Signature deve vir depois de InfDeclaracaoPrestacaoServico');
  assert.ok(idxRpsClose > idxSignature, 'Signature deve estar dentro de <Rps>');
});

test('carregarCertificado retorna null quando env vars ausentes', () => {
  const original = {
    B64: process.env.NFSE_CERT_VIEIRA_B64,
    SENHA: process.env.NFSE_CERT_VIEIRA_SENHA,
  };
  delete process.env.NFSE_CERT_VIEIRA_B64;
  delete process.env.NFSE_CERT_VIEIRA_SENHA;
  try {
    assert.strictEqual(carregarCertificado('Vieira'), null);
    assert.strictEqual(carregarCertificado('SistemaInexistente'), null);
  } finally {
    if (original.B64 !== undefined) process.env.NFSE_CERT_VIEIRA_B64 = original.B64; else delete process.env.NFSE_CERT_VIEIRA_B64;
    if (original.SENHA !== undefined) process.env.NFSE_CERT_VIEIRA_SENHA = original.SENHA; else delete process.env.NFSE_CERT_VIEIRA_SENHA;
  }
});

test('carregarCertificado retorna { pfxB64, senha } quando env vars presentes', () => {
  const original = {
    B64: process.env.NFSE_CERT_MARTINS_B64,
    SENHA: process.env.NFSE_CERT_MARTINS_SENHA,
  };
  process.env.NFSE_CERT_MARTINS_B64 = 'ZmFrZS1wZng=';
  process.env.NFSE_CERT_MARTINS_SENHA = 'senha-teste';
  try {
    const resultado = carregarCertificado('Martins');
    assert.deepStrictEqual(resultado, { pfxB64: 'ZmFrZS1wZng=', senha: 'senha-teste' });
  } finally {
    if (original.B64 !== undefined) process.env.NFSE_CERT_MARTINS_B64 = original.B64; else delete process.env.NFSE_CERT_MARTINS_B64;
    if (original.SENHA !== undefined) process.env.NFSE_CERT_MARTINS_SENHA = original.SENHA; else delete process.env.NFSE_CERT_MARTINS_SENHA;
  }
});
