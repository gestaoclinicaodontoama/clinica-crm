// lib/nfse/assinar.js — assinatura XMLDSig (padrão ABRASF: RSA-SHA1 + C14N, cert dentro de KeyInfo).
// ⚠️ Se a prefeitura rejeitar SHA1, trocar por RSA-SHA256 (ver achados da POC).
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');

function _extrairChaveECert(pfxB64, senha) {
  let p12;
  try {
    const der = forge.util.decode64(pfxB64);
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), senha);
  } catch (e) {
    throw new Error('certificado inválido ou senha incorreta');
  }
  let privateKey = null;
  const certs = [];
  for (const safeContents of p12.safeContents) {
    for (const safeBag of safeContents.safeBags) {
      if (safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag || safeBag.type === forge.pki.oids.keyBag) privateKey = safeBag.key;
      else if (safeBag.type === forge.pki.oids.certBag) certs.push(safeBag.cert);
    }
  }
  if (!privateKey || certs.length === 0) throw new Error('PFX sem chave privada ou certificado');
  // PFX de A1 brasileiro costuma vir com a cadeia (CA) junto do certificado do titular (leaf).
  // Selecionar o cert cuja chave pública bate com a chave privada extraída (o leaf), não o primeiro do bag.
  const cert = certs.find((c) => (
    c.publicKey && c.publicKey.n && c.publicKey.e &&
    c.publicKey.n.toString(16) === privateKey.n.toString(16) &&
    c.publicKey.e.toString(16) === privateKey.e.toString(16)
  )) || certs[0];
  const keyPem = forge.pki.privateKeyToPem(privateKey);
  const certDerB64 = forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
  return { keyPem, certDerB64 };
}

function assinarXml(xml, { pfxB64, senha, referenciaUri }) {
  const { keyPem, certDerB64 } = _extrairChaveECert(pfxB64, senha);
  const sig = new SignedXml({
    privateKey: keyPem,
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    getKeyInfoContent: () => `<X509Data><X509Certificate>${certDerB64}</X509Certificate></X509Data>`,
  });
  sig.addReference({
    xpath: `//*[@Id='${referenciaUri}']`,
    uri: `#${referenciaUri}`,
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    ],
  });
  sig.computeSignature(xml, { location: { reference: `//*[@Id='${referenciaUri}']`, action: 'after' } });
  return sig.getSignedXml();
}

function carregarCertificado(sistema) {
  const chave = sistema === 'Vieira' ? 'VIEIRA' : sistema === 'Martins' ? 'MARTINS' : null;
  if (!chave) return null;
  const pfxB64 = process.env[`NFSE_CERT_${chave}_B64`];
  const senha = process.env[`NFSE_CERT_${chave}_SENHA`];
  return pfxB64 && senha ? { pfxB64, senha } : null;
}

module.exports = { assinarXml, carregarCertificado };
