// scripts/backfill-ecos-app.js — ingere ecos históricos (webhook_wa_debug) em
// mensagens. Idempotente: dedup por wa_id. Rodar: node scripts/backfill-ecos-app.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { parseEchoes } = require('../lib/wa/echoes');
const { chaveTelefone } = require('../lib/funil/telefone');

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

async function acharLeadPorTelefone(fone) {
  const { data: rows } = await supabase.from('leads').select('id, telefone')
    .eq('telefone', fone).order('id').limit(1);
  let lead = rows?.[0] || null;
  if (!lead) {
    const suf = String(fone).slice(-8);
    const alvo = chaveTelefone(fone);
    if (suf.length === 8 && alvo) {
      const { data: cands } = await supabase.from('leads').select('id, telefone')
        .like('telefone', '%' + suf).order('id').limit(20);
      lead = (cands || []).find(c => chaveTelefone(c.telefone) === alvo) || null;
    }
  }
  return lead;
}

(async () => {
  let inseridos = 0, duplicados = 0, semLead = 0, offset = 0;
  for (;;) {
    const { data: rows, error } = await supabase.from('webhook_wa_debug')
      .select('id, payload').order('id').range(offset, offset + 199);
    if (error) throw error;
    if (!rows?.length) break;
    offset += rows.length;
    for (const row of rows) {
      // payload gravado é o change; parseEchoes espera o body completo
      for (const eco of parseEchoes({ entry: [{ changes: [row.payload] }] })) {
        const { data: dup } = await supabase.from('mensagens').select('id').eq('wa_id', eco.wamid).limit(1);
        if (dup?.length) { duplicados++; continue; }
        const lead = await acharLeadPorTelefone(eco.to);
        if (!lead) { semLead++; continue; }
        const { error: insErr } = await supabase.from('mensagens').insert({
          lead_id: lead.id, direcao: 'enviada', canal: 'app',
          texto: (eco.texto || '').slice(0, 4000), wa_id: eco.wamid, tipo: eco.tipo,
          wa_number_id: (eco.phone_number_id || '').slice(0, 50),
          ...(eco.timestamp ? { criada_em: eco.timestamp } : {}),
        });
        if (insErr) console.error('insert', eco.wamid.slice(-12), insErr.message);
        else inseridos++;
      }
    }
  }
  console.log(`✅ backfill ecos: ${inseridos} inseridos, ${duplicados} já existiam, ${semLead} sem lead`);
})().catch(e => { console.error(e); process.exit(1); });
