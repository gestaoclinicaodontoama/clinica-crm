// Testa quais event_name / action_source a Meta aceita para um lead CTWA.
// Uso: node scripts/test-event-name.js <leadId>
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const META_API_VERSION = 'v21.0';
const PIXEL = process.env.META_PIXEL_ID;
const TOKEN = process.env.META_ACCESS_TOKEN;
const ADS_TOKEN = process.env.META_ADS_TOKEN || process.env.META_ACCESS_TOKEN;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const sha256 = v => v ? crypto.createHash('sha256').update(String(v).toLowerCase().trim()).digest('hex') : null;

async function graph(path) {
  const r = await fetch('https://graph.facebook.com/' + META_API_VERSION + '/' + path +
    (path.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(ADS_TOKEN));
  return r.json();
}

async function enviar(lead, pageId, eventName, action_source) {
  const user_data = { ctwa_clid: lead.ctwa_clid };
  if (lead.telefone) user_data.ph = [sha256(lead.telefone)];
  if (lead.nome) user_data.fn = [sha256(lead.nome.split(' ')[0])];
  if (pageId) user_data.page_id = pageId;
  const ev = {
    event_name: eventName,
    event_time: Math.floor(Date.now()/1000),
    action_source,
    event_id: 'test_' + lead.id + '_' + eventName + '_' + action_source + '_' + Date.now(),
    user_data, custom_data: { currency: 'BRL', value: 0 },
  };
  if (action_source === 'business_messaging') ev.messaging_channel = 'whatsapp';
  const r = await fetch('https://graph.facebook.com/' + META_API_VERSION + '/' + PIXEL + '/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ data: [ev] }),
  });
  const j = await r.json();
  const tag = j.events_received ? '✅ recebido' : '❌ ' + (j.error?.error_user_msg || j.error?.message || '').slice(0, 90);
  console.log(`   ${action_source.padEnd(19)} | ${eventName.padEnd(14)} -> ${r.status} ${tag}`);
}

(async () => {
  const leadId = process.argv[2];
  const { data: lead, error } = await supabase.from('leads').select('*').eq('id', leadId).maybeSingle();
  if (error) { console.log('erro supabase:', error.message); return; }
  if (!lead) { console.log('lead', leadId, 'não encontrado'); return; }
  const adId = (lead.referral_data || {}).source_id || '';
  const ad = await graph(adId + '?fields=creative{effective_object_story_id}');
  const pageId = String((ad.creative && ad.creative.effective_object_story_id) || '').split('_')[0] || '';
  const p = pageId ? await graph(pageId + '?fields=name') : {};
  console.log(`\n#${lead.id} ${lead.nome} | page_id=${pageId} (${p.name || '?'})\n`);

  const eventos = ['LeadSubmitted', 'Lead', 'LeadQualified', 'Schedule', 'Contact', 'Purchase'];
  for (const as of ['business_messaging', 'system_generated']) {
    for (const ev of eventos) await enviar(lead, pageId, ev, as);
    console.log('');
  }
})();
