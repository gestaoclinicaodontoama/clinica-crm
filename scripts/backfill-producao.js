// scripts/backfill-producao.js
// Uso: node scripts/backfill-producao.js <ano>
// Ex:  node scripts/backfill-producao.js 2026
//      node scripts/backfill-producao.js 2025

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const ClinicorpApi = require('../sync/clinicorp-api');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const api = new ClinicorpApi({
  user: process.env.CLINICORP_USER,
  token: process.env.CLINICORP_TOKEN,
  subscriberId: process.env.CLINICORP_SUBSCRIBER_ID,
  businessId: process.env.CLINICORP_BUSINESS_ID,
});

const DELAY_MS = 3000; // 3s entre chunks ≈ 20 chamadas/min, seguro no rate limit

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function dateStr(d) { return d.toISOString().slice(0, 10); }

async function main() {
  const ano = parseInt(process.argv[2]);
  if (!ano || ano < 2020 || ano > 2030) {
    console.error('Uso: node scripts/backfill-producao.js <ano>');
    process.exit(1);
  }

  // Carrega catálogo uma vez
  console.log('Carregando catálogo de procedimentos...');
  const catalogRaw = await api.get('/procedures/list', {});
  const catalog = new Map();
  if (Array.isArray(catalogRaw)) {
    for (const p of catalogRaw) {
      if (p.id) catalog.set(String(p.id), p.ProcedureName || p.Name || '');
    }
  }
  console.log(`Catálogo: ${catalog.size} procedimentos`);

  let totalGeral = 0;

  for (let mes = 1; mes <= 12; mes++) {
    const from = new Date(ano, mes - 1, 1);
    const to   = new Date(ano, mes, 0);

    // Não backfillar meses futuros
    if (from > new Date()) { console.log(`Mês ${mes}/${ano}: futuro, pulando`); break; }

    const fromStr = dateStr(from);
    const toStr   = dateStr(to);
    console.log(`\n[${fromStr} → ${toStr}] buscando...`);

    let estimates;
    try {
      estimates = await api.get('/estimates/list', { from: fromStr, to: toStr });
    } catch (e) {
      console.error(`  ERRO ao buscar: ${e.message}`);
      await sleep(DELAY_MS);
      continue;
    }

    if (!Array.isArray(estimates)) { console.log('  sem dados'); await sleep(DELAY_MS); continue; }

    const rows = [];
    for (const est of estimates) {
      const estId = String(est.id || est.EstimateId || '');
      if (!estId) continue;
      const procs = est.ProcedureList || est.procedureList || [];
      for (const p of procs) {
        if (p.Executed !== 'X') continue;
        const amount = Number(p.Amount ?? 0);
        if (amount <= 0) continue;
        const priceId = p.PriceId ? String(p.PriceId) : null;
        rows.push({
          clinicorp_estimate_id:  estId,
          clinicorp_treatment_id: est.TreatmentId ? String(est.TreatmentId) : null,
          price_id:               priceId,
          procedure_name:         priceId ? (catalog.get(priceId) || '') : '',
          specialty_id:           p.SpecialtyId ? String(p.SpecialtyId) : null,
          dentist_person_id:      p.Dentist_PersonId ? String(p.Dentist_PersonId) : null,
          dentist_name:           p.ProfessionalName || p.DentistName || null,
          executed_date:          p.ExecutedDate ? p.ExecutedDate.slice(0, 10) : null,
          amount,
          bill_type:              p.BillType || null,
          paciente_nome:          est.PatientName || null,
          atualizado_em:          new Date().toISOString(),
        });
      }
    }

    const valid = rows.filter(r => r.executed_date);
    console.log(`  ${estimates.length} orçamentos → ${rows.length} brutos → ${valid.length} válidos`);

    let count = 0;
    for (let i = 0; i < valid.length; i += 500) {
      const chunk = valid.slice(i, i + 500);
      try {
        const { error } = await supabase.from('producao_procedimentos').upsert(chunk, {
          onConflict: 'dedup_key',
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

  console.log(`\n✅ Backfill ${ano} concluído: ${totalGeral} procedimentos no total`);

  // Verificação final — contagem via head: true (não traz linhas, só o count)
  try {
    const { count } = await supabase
      .from('producao_procedimentos')
      .select('*', { count: 'exact', head: true })
      .gte('executed_date', `${ano}-01-01`)
      .lte('executed_date', `${ano}-12-31`);
    console.log(`Verificação Supabase ${ano}: ${count || 0} registros na tabela`);
  } catch (e) {
    console.error(`  ERRO na verificação final: ${e.message}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
