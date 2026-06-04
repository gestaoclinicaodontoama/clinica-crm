// Diagnóstico da integração Clinicorp: testa /appointment/list e /patient/get ao vivo.
require('dotenv').config();
const https = require('https');

function cGet(apiPath, params = {}) {
  return new Promise((resolve, reject) => {
    const user = process.env.CLINICORP_USER || 'clinicaama';
    const token = process.env.CLINICORP_TOKEN || '';
    const auth = Buffer.from(user + ':' + token).toString('base64');
    const qs = new URLSearchParams({
      subscriber_id: process.env.CLINICORP_SUBSCRIBER_ID || 'clinicaama',
      business_id: process.env.CLINICORP_BUSINESS_ID || 'clinicaama',
      ...params,
    }).toString();
    const opts = {
      hostname: 'api.clinicorp.com', path: '/rest/v1' + apiPath + '?' + qs, method: 'GET',
      headers: { Authorization: 'Basic ' + auth, 'X-Api-Key': token, Accept: 'application/json' },
    };
    const req = https.request(opts, res => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(body) }); } catch { resolve({ status: res.statusCode, raw: body.slice(0,300) }); } });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject); req.end();
  });
}

(async () => {
  console.log('CLINICORP_USER:', process.env.CLINICORP_USER, '| token len:', (process.env.CLINICORP_TOKEN||'').length,
    '| subscriber:', process.env.CLINICORP_SUBSCRIBER_ID, '| business:', process.env.CLINICORP_BUSINESS_ID, '\n');

  const today = new Date().toISOString().split('T')[0];
  const tmrw = new Date(Date.now() + 864e5).toISOString().split('T')[0];
  console.log(`--- /appointment/list (from=${today} to=${tmrw}) ---`);
  try {
    const r = await cGet('/appointment/list', { from: today, to: tmrw });
    console.log('HTTP', r.status);
    const arr = Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.data) ? r.data.data : null);
    if (arr) {
      console.log('agendamentos:', arr.length);
      if (arr[0]) console.log('exemplo campos:', Object.keys(arr[0]).slice(0,15).join(', '));
      if (arr[0]) console.log('exemplo:', JSON.stringify({Dentist_PersonId:arr[0].Dentist_PersonId, DoctorId:arr[0].DoctorId, FromTime:arr[0].FromTime, fromTime:arr[0].fromTime, ToTime:arr[0].ToTime, Date:arr[0].Date}));
    } else {
      console.log('resposta:', JSON.stringify(r.data || r.raw).slice(0, 400));
    }
  } catch(e) { console.log('ERRO:', e.message); }

  console.log('\n--- /patient/get (teste) ---');
  try {
    const r = await cGet('/patient/get', { Name: 'Maria' });
    console.log('HTTP', r.status, '| resposta:', JSON.stringify(r.data || r.raw).slice(0, 250));
  } catch(e) { console.log('ERRO:', e.message); }
})();
