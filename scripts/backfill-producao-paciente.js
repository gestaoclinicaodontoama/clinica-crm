// Preenche producao_procedimentos.paciente_clinicorp_id casando clinicorp_treatment_id
// com o TreatmentId do /payment/list (24 meses). Idempotente.
//
// Nota: re-rodar estimates/list NÃO recupera procedimentos antigos (a API só devolve
// estimates recentes). Por isso o backfill casa PELO TRATAMENTO: producao.clinicorp_
// treatment_id -> TreatmentId do /payment/list (24m) -> PatientId.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const ClinicorpApi = require('../sync/clinicorp-api');

const supabase = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });
const api = new ClinicorpApi({
  user: process.env.CLINICORP_USER, token: process.env.CLINICORP_TOKEN,
  subscriberId: process.env.CLINICORP_SUBSCRIBER_ID, businessId: process.env.CLINICORP_BUSINESS_ID,
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // 1) Mapa TreatmentId -> PatientId a partir de 24 meses de pagamentos (chunks de 2 meses).
  const mapa = new Map();
  for (let i = 0; i < 12; i++) {
    const toDate = new Date();   toDate.setMonth(toDate.getMonth() - i * 2);
    const fromDate = new Date(); fromDate.setMonth(fromDate.getMonth() - (i + 1) * 2);
    const from = fromDate.toISOString().split('T')[0];
    const to = toDate.toISOString().split('T')[0];
    try {
      const r = await api.get('/payment/list', { from, to, date_type: 'postDate' });
      const arr = Array.isArray(r) ? r : (Array.isArray(r?.data) ? r.data : []);
      for (const it of arr) {
        const t = String(it.TreatmentId || ''); const p = String(it.PatientId || '');
        if (t && p) mapa.set(t, p);
      }
      console.log(`chunk ${from}~${to}: mapa agora com ${mapa.size} tratamentos`);
    } catch (e) { console.log(`chunk ${from} erro: ${e.message}`); }
    await sleep(400);
  }

  // 2) Ler producao sem paciente_clinicorp_id (paginado, limite 1000 do client Supabase).
  const semId = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from('producao_procedimentos')
      .select('id, clinicorp_treatment_id')
      .or('paciente_clinicorp_id.is.null,paciente_clinicorp_id.eq.')
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    semId.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  console.log(`producao sem id: ${semId.length}`);

  // 3) Atualizar as que casam pelo tratamento.
  let atualizadas = 0, semMatch = 0;
  for (const row of semId) {
    const pid = mapa.get(String(row.clinicorp_treatment_id || ''));
    if (!pid) { semMatch++; continue; }
    const { error } = await supabase.from('producao_procedimentos')
      .update({ paciente_clinicorp_id: pid }).eq('id', row.id);
    if (error) console.error('update erro id', row.id, error.message); else atualizadas++;
  }
  console.log(`atualizadas: ${atualizadas} | sem match no pagamento: ${semMatch}`);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
