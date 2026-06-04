// Teste end-to-end do CAPI CTWA: resolve page_id pelo anúncio e dispara eventos
// para leads reais com ctwa_clid. Usa test_event_code (Test Events) por padrão.
// Rodar real (afeta atribuição):  node scripts/test-capi-ctwa.js --real
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const REAL = process.argv.includes('--real');
const META_API_VERSION = 'v21.0';
const PIXEL = process.env.META_PIXEL_ID;
const TOKEN = process.env.META_ACCESS_TOKEN;
const ADS_TOKEN = process.env.META_ADS_TOKEN || process.env.META_ACCESS_TOKEN;
const TEST_CODE = process.env.META_TEST_EVENT_CODE;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const sha256 = v => v ? crypto.createHash('sha256').update(String(v).toLowerCase().trim()).digest('hex') : null;

const _cache = new Map();
async function resolveAdPageId(adId) {
  if (!adId) return '';
  if (_cache.has(adId)) return _cache.get(adId);
  if (!ADS_TOKEN) return '';
  try {
    const r = await fetch('https://graph.facebook.com/' + META_API_VERSION + '/' + encodeURIComponent(adId) +
      '?fields=creative%7Beffective_object_story_id%7D&access_token=' + encodeURIComponent(ADS_TOKEN));
    const j = await r.json();
    if (j.error) { console.log('   resolveAdPageId ERRO:', j.error.message); return ''; }
    const story = (j.creative && j.creative.effective_object_story_id) || '';
    const pageId = String(story).split('_')[0] || '';
    if (pageId) _cache.set(adId, pageId);
    return pageId;
  } catch (e) { console.log('   resolveAdPageId EXC:', e.message); return ''; }
}

async function enviar(lead, eventName, { usePageId, label }) {
  const user_data = {};
  if (lead.telefone) user_data.ph = [sha256(lead.telefone)];
  if (lead.nome) user_data.fn = [sha256(lead.nome.split(' ')[0])];
  user_data.ctwa_clid = lead.ctwa_clid;
  if (usePageId) user_data.page_id = usePageId;
  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      event_id: 'test_lead_' + lead.id + '_' + eventName + '_' + Date.now(),
      user_data,
      custom_data: { currency: 'BRL', value: parseFloat(lead.valor) || 0 },
    }],
    ...(!REAL && TEST_CODE && { test_event_code: TEST_CODE }),
  };
  const r = await fetch('https://graph.facebook.com/' + META_API_VERSION + '/' + PIXEL + '/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  const ok = !!j.events_received;
  console.log(`   [${label}] ${eventName} page_id=${usePageId || '(nenhum)'} -> HTTP ${r.status} | ${ok ? '✅ events_received=' + j.events_received : '❌ ' + (j.error?.error_user_msg || j.error?.message || JSON.stringify(j).slice(0,200))}`);
  return ok;
}

(async () => {
  console.log(`\n=== Teste CAPI CTWA ${REAL ? '(REAL — afeta atribuição)' : '(TEST EVENTS — seguro)'} ===`);
  console.log('Pixel:', PIXEL, '| ads_read token:', ADS_TOKEN ? 'sim' : 'NÃO', '| test_code:', TEST_CODE || '(nenhum)\n');

  const ids = process.argv.filter(a => /^\d+$/.test(a)).map(Number);
  const q = supabase.from('leads').select('id,nome,telefone,valor,status,ctwa_clid,referral_data')
    .not('ctwa_clid', 'is', null).neq('ctwa_clid', '');
  const { data: leads, error } = ids.length ? await q.in('id', ids) : await q;
  if (error) { console.error('Erro Supabase:', error.message); process.exit(1); }

  for (const lead of leads.filter(l => (l.referral_data || {}).source_id)) {
    const adId = lead.referral_data.source_id;
    console.log(`\n#${lead.id} ${lead.nome} (status ${lead.status}) ad=${adId}`);
    const pageId = await resolveAdPageId(adId);
    console.log('   page_id resolvido pelo anúncio:', pageId || '(falhou — usaria fallback META_PAGE_ID=' + process.env.META_PAGE_ID + ')');
    // A) page_id resolvido (o fix)
    await enviar(lead, 'LeadSubmitted', { usePageId: pageId || process.env.META_PAGE_ID, label: 'FIX' });
    // B) page_id antigo fixo (demonstra o 400 quando não bate)
    if (pageId && pageId !== process.env.META_PAGE_ID) {
      await enviar(lead, 'LeadSubmitted', { usePageId: process.env.META_PAGE_ID, label: 'page_id antigo' });
    }
    // C) evento Schedule (confirma se business_messaging aceita ou rejeita)
    await enviar(lead, 'Schedule', { usePageId: pageId || process.env.META_PAGE_ID, label: 'Schedule?' });
  }
  console.log('\n=== fim ===');
})();
