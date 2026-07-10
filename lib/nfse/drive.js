// lib/nfse/drive.js — upload do documento da nota ao Google Drive via service account.
// JWT RS256 manual (node:crypto) — sem SDK do Google (regra da casa: stdlib primeiro).
//
// Decisão do controller (POC não confirmou URL pública de DANFSE — ver
// docs/superpowers/specs/2026-07-09-nfse-poc-achados.md, item 7): caminho feliz
// tenta baixar o PDF de nota.caminho_pdf; se não houver URL ou o download falhar,
// sobe o xml_retorno (comprovante oficial da prefeitura) como fallback. Só retorna
// { ok:false } quando nem PDF nem XML estão disponíveis.
const crypto = require('node:crypto');

function _nomeArquivo(nota, ext = 'pdf') {
  const tomador = String(nota.nome_tomador || '').replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 60);
  return `NF-${nota.num_nota}-${tomador}.${ext}`;
}

function _montarJwt(sa, agoraMs) {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(agoraMs / 1000);
  const header = b64u({ alg: 'RS256', typ: 'JWT' });
  const payload = b64u({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    iat, exp: iat + 3600,
  });
  const assinatura = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), sa.private_key).toString('base64url');
  return `${header}.${payload}.${assinatura}`;
}

async function _accessToken(fetchImpl) {
  const sa = JSON.parse(Buffer.from(process.env.GOOGLE_SA_JSON_B64 || '', 'base64').toString('utf8'));
  const jwt = _montarJwt(sa, Date.now());
  const r = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`token Drive falhou: ${JSON.stringify(j).slice(0, 200)}`);
  return j.access_token;
}

/** Tenta baixar o PDF público; retorna null se não houver URL ou o download falhar
 *  (silencioso — chamador cai no fallback XML). */
async function _baixarPdf(caminhoPdf, fetchImpl) {
  if (!caminhoPdf || !/^https?:\/\//i.test(caminhoPdf)) return null;
  try {
    const resp = await fetchImpl(caminhoPdf, { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

/** Baixa (ou monta) o documento a subir: PDF de nota.caminho_pdf como caminho feliz;
 *  se indisponível, o xml_retorno (comprovante oficial) como fallback. */
async function _documentoParaSubir(nota, fetchImpl) {
  const pdf = await _baixarPdf(nota.caminho_pdf, fetchImpl);
  if (pdf) return { conteudo: pdf, ext: 'pdf', contentType: 'application/pdf' };
  if (nota.xml_retorno) return { conteudo: Buffer.from(String(nota.xml_retorno), 'utf8'), ext: 'xml', contentType: 'application/xml' };
  return null;
}

async function uploadNota(supabase, nota, emissor, { fetchImpl = fetch } = {}) {
  try {
    if (!process.env.GOOGLE_SA_JSON_B64 || !emissor.drive_folder_id) return { ok: false, link: '' };

    const doc = await _documentoParaSubir(nota, fetchImpl);
    if (!doc) return { ok: false, link: '' };

    const token = await _accessToken(fetchImpl);
    const boundary = 'nfse' + crypto.randomBytes(8).toString('hex');
    const meta = JSON.stringify({ name: _nomeArquivo(nota, doc.ext), parents: [emissor.drive_folder_id] });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${doc.contentType}\r\n\r\n`),
      doc.conteudo,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const up = await fetchImpl('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    const j = await up.json();
    if (!j.id) throw new Error(`upload falhou: ${JSON.stringify(j).slice(0, 200)}`);
    const link = j.webViewLink || `https://drive.google.com/file/d/${j.id}/view`;
    await supabase.from('notas_fiscais').update({ drive_link: link }).eq('id', nota.id);
    return { ok: true, link };
  } catch (e) {
    console.error(`[nfse-drive] nota ${nota.id}: ${e.message}`); // best-effort: nunca derruba a emissão
    return { ok: false, link: '', erro: e.message };
  }
}

module.exports = { uploadNota, _montarJwt, _nomeArquivo };
