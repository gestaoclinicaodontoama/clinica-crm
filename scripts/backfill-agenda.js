// scripts/backfill-agenda.js
// Uso: node scripts/backfill-agenda.js <ano>
// Ex:  node scripts/backfill-agenda.js 2026

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const ClinicorpApi = require('../sync/clinicorp-api');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const api = new ClinicorpApi({
  user:         process.env.CLINICORP_USER,
  token:        process.env.CLINICORP_TOKEN,
  subscriberId: process.env.CLINICORP_SUBSCRIBER_ID,
  businessId:   process.env.CLINICORP_BUSINESS_ID,
});

const DELAY_MS = 3000;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function dateStr(d) { return d.toISOString().slice(0, 10); }
function parseMinutes(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return ((h || 0) * 60) + (m || 0);
}

async function main() {
  const ano = parseInt(process.argv[2]);
  if (!ano || ano < 2020 || ano > 2030) {
    console.error('Uso: node scripts/backfill-agenda.js <ano>');
    process.exit(1);
  }

  let totalGeral = 0;

  for (let mes = 1; mes <= 12; mes++) {
    const from = new Date(ano, mes - 1, 1);
    const to   = new Date(ano, mes, 0);

    if (from > new Date()) { console.log(`Mês ${mes}/${ano}: futuro, pulando`); break; }

    const fromStr = dateStr(from);
    const toStr   = dateStr(to);
    console.log(`\n[${fromStr} → ${toStr}] buscando...`);

    let appointments;
    try {
      appointments = await api.get('/appointment/list', { from: fromStr, to: toStr });
    } catch (e) {
      console.error(`  ERRO ao buscar: ${e.message}`);
      await sleep(DELAY_MS);
      continue;
    }

    if (!Array.isArray(appointments)) { console.log('  sem dados'); await sleep(DELAY_MS); continue; }

    const rows = [];
    const seenIds = new Set();
    for (const a of appointments) {
      const apptId = String(a.id || a.AppointmentId || '');
      if (!apptId || seenIds.has(apptId)) continue;
      seenIds.add(apptId);

      const apptDate = (a.date || a.Date || '').slice(0, 10);
      if (!apptDate) continue;

      const fromTime = a.fromTime || a.FromTime || null;
      const toTime   = a.toTime   || a.ToTime   || null;
      const dur = (fromTime && toTime)
        ? parseMinutes(toTime) - parseMinutes(fromTime)
        : null;

      rows.push({
        clinicorp_appt_id:  apptId,
        dentist_person_id:  a.Dentist_PersonId ? String(a.Dentist_PersonId) : null,
        dentist_name:       a.DentistName || a.ProfessionalName || null,
        patient_name:       a.PatientName || null,
        appointment_date:   apptDate,
        from_time:          fromTime,
        to_time:            toTime,
        duration_minutes:   (dur !== null && dur >= 0) ? dur : null,
        category:           a.CategoryDescription || null,
        checkin_time:       a.CheckinTime || null,
        deleted:            (a.Deleted || '') === 'X',
        atualizado_em:      new Date().toISOString(),
      });
    }

    console.log(`  ${appointments.length} appointments → ${rows.length} válidos`);

    let count = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      try {
        const { error } = await supabase.from('agenda_appointments').upsert(chunk, {
          onConflict: 'clinicorp_appt_id',
          ignoreDuplicates: false,
        });
        if (error) console.error(`  ERRO upsert batch ${i}: ${error.message}`);
        else count += chunk.length;
      } catch (e) {
        console.error(`  ERRO upsert batch ${i}: ${e.message}`);
      }
    }

    console.log(`  ✓ ${count} upserted`);
    totalGeral += count;
    await sleep(DELAY_MS);
  }

  console.log(`\n✅ Backfill ${ano} concluído: ${totalGeral} appointments no total`);

  try {
    const { count } = await supabase
      .from('agenda_appointments')
      .select('*', { count: 'exact', head: true })
      .gte('appointment_date', `${ano}-01-01`)
      .lte('appointment_date', `${ano}-12-31`);
    console.log(`Verificação Supabase ${ano}: ${count || 0} registros na tabela`);
  } catch (e) {
    console.error(`  ERRO na verificação final: ${e.message}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
