// lib/nfse/drive.test.js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { uploadNota, _montarJwt, _nomeArquivo } = require('./drive');

function setSaEnv() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const sa = { client_email: 'sa@teste.iam.gserviceaccount.com', private_key: pem };
  process.env.GOOGLE_SA_JSON_B64 = Buffer.from(JSON.stringify(sa)).toString('base64');
}
function limparSaEnv() { delete process.env.GOOGLE_SA_JSON_B64; }

function supabaseMock() {
  const updates = [];
  return { updates, from: () => ({ update: (patch) => ({ eq: async (c, id) => { updates.push({ id, patch }); return { error: null }; } }) }) };
}

// Mock de fetch cobrindo os 3 endpoints envolvidos: download do PDF, token OAuth, upload multipart do Drive.
function fetchMock({ downloadOk = true, downloadStatus = 200, downloadBody = 'PDFDATA', tokenOk = true, uploadOk = true } = {}) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url === 'https://oauth2.googleapis.com/token') {
      return { ok: tokenOk, json: async () => (tokenOk ? { access_token: 'tok123' } : { error: 'invalid_grant' }) };
    }
    if (String(url).startsWith('https://www.googleapis.com/upload/drive')) {
      return { ok: uploadOk, json: async () => (uploadOk ? { id: 'FILEID', webViewLink: 'https://drive.google.com/file/d/FILEID/view' } : { error: 'upload falhou' }) };
    }
    return { ok: downloadOk, status: downloadStatus, arrayBuffer: async () => Buffer.from(downloadBody) };
  };
  impl.calls = calls;
  return impl;
}

const emissor = { sistema: 'Vieira', drive_folder_id: 'FOLDER123' };
const notaBase = { id: 42, num_nota: '412', nome_tomador: 'Maria / Silva: Teste' };

test('nome de arquivo sanitiza tomador e usa numero da nota (extensao padrao pdf)', () => {
  assert.strictEqual(_nomeArquivo({ num_nota: '412', nome_tomador: 'Maria / Silva: Teste' }), 'NF-412-Maria - Silva- Teste.pdf');
});

test('nome de arquivo aceita extensao customizada (fallback xml)', () => {
  assert.strictEqual(_nomeArquivo({ num_nota: '412', nome_tomador: 'Teste' }, 'xml'), 'NF-412-Teste.xml');
});

test('JWT tem claims de escopo drive e assina RS256', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwt = _montarJwt({ client_email: 'sa@teste.iam.gserviceaccount.com', private_key: pem }, Date.now());
  const [h, p] = jwt.split('.').slice(0, 2).map((x) => JSON.parse(Buffer.from(x, 'base64url').toString()));
  assert.strictEqual(h.alg, 'RS256');
  assert.strictEqual(p.iss, 'sa@teste.iam.gserviceaccount.com');
  assert.match(p.scope, /drive/);
  assert.strictEqual(p.aud, 'https://oauth2.googleapis.com/token');
});

test('sem GOOGLE_SA_JSON_B64: retorna ok:false sem chamar fetch', async () => {
  limparSaEnv();
  const sb = supabaseMock();
  const fetchImpl = fetchMock();
  const nota = { ...notaBase, caminho_pdf: 'https://exemplo.com/nota.pdf' };
  const r = await uploadNota(sb, nota, emissor, { fetchImpl });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fetchImpl.calls.length, 0);
  assert.strictEqual(sb.updates.length, 0);
});

test('emissor sem drive_folder_id: retorna ok:false sem chamar fetch', async () => {
  setSaEnv();
  const sb = supabaseMock();
  const fetchImpl = fetchMock();
  const nota = { ...notaBase, caminho_pdf: 'https://exemplo.com/nota.pdf' };
  const r = await uploadNota(sb, nota, { ...emissor, drive_folder_id: null }, { fetchImpl });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fetchImpl.calls.length, 0);
  limparSaEnv();
});

test('sucesso: baixa PDF de caminho_pdf, sobe ao Drive e grava drive_link', async () => {
  setSaEnv();
  const sb = supabaseMock();
  const fetchImpl = fetchMock();
  const nota = { ...notaBase, caminho_pdf: 'https://exemplo.com/nota.pdf' };
  const r = await uploadNota(sb, nota, emissor, { fetchImpl });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.link, 'https://drive.google.com/file/d/FILEID/view');
  const uploadCall = fetchImpl.calls.find((c) => String(c.url).includes('/upload/drive'));
  assert.ok(uploadCall, 'deve ter chamado o endpoint de upload');
  assert.match(uploadCall.opts.body.toString('latin1'), /"name":"NF-412-Maria - Silva- Teste\.pdf"/);
  assert.match(uploadCall.opts.headers['Content-Type'], /multipart\/related/);
  assert.strictEqual(sb.updates.at(-1).patch.drive_link, r.link);
  assert.strictEqual(sb.updates.at(-1).id, 42);
  limparSaEnv();
});

test('fallback XML: sem caminho_pdf mas com xml_retorno, sobe o XML (.xml, application/xml)', async () => {
  setSaEnv();
  const sb = supabaseMock();
  const fetchImpl = fetchMock();
  const nota = { ...notaBase, caminho_pdf: '', xml_retorno: '<CompNfse><Numero>412</Numero></CompNfse>' };
  const r = await uploadNota(sb, nota, emissor, { fetchImpl });
  assert.strictEqual(r.ok, true);
  const uploadCall = fetchImpl.calls.find((c) => String(c.url).includes('/upload/drive'));
  const bodyStr = uploadCall.opts.body.toString('utf8');
  assert.match(bodyStr, /"name":"NF-412-Maria - Silva- Teste\.xml"/);
  assert.match(bodyStr, /Content-Type: application\/xml/);
  assert.match(bodyStr, /<CompNfse><Numero>412<\/Numero><\/CompNfse>/);
  // download do PDF nunca deveria ter sido tentado (caminho_pdf vazio)
  assert.strictEqual(fetchImpl.calls.filter((c) => c.url === '').length, 0);
  limparSaEnv();
});

test('fallback XML: download do PDF falha (HTTP 404) mas xml_retorno presente — sobe XML', async () => {
  setSaEnv();
  const sb = supabaseMock();
  const fetchImpl = fetchMock({ downloadOk: false, downloadStatus: 404 });
  const nota = { ...notaBase, caminho_pdf: 'https://exemplo.com/nota-inexistente.pdf', xml_retorno: '<CompNfse/>' };
  const r = await uploadNota(sb, nota, emissor, { fetchImpl });
  assert.strictEqual(r.ok, true);
  const uploadCall = fetchImpl.calls.find((c) => String(c.url).includes('/upload/drive'));
  assert.match(uploadCall.opts.body.toString('utf8'), /"name":"NF-412-Maria - Silva- Teste\.xml"/);
  limparSaEnv();
});

test('nem PDF nem XML disponiveis: retorna ok:false sem chamar upload', async () => {
  setSaEnv();
  const sb = supabaseMock();
  const fetchImpl = fetchMock();
  const nota = { ...notaBase, caminho_pdf: '', xml_retorno: '' };
  const r = await uploadNota(sb, nota, emissor, { fetchImpl });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fetchImpl.calls.filter((c) => String(c.url).includes('/upload/drive')).length, 0);
  assert.strictEqual(sb.updates.length, 0);
  limparSaEnv();
});
