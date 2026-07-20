// Corrige plano_itens com nome 'PriceId <id>' usando o catálogo (1 chamada à API se a tabela estiver vazia).
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  let { data: cat } = await supabase.from('procedimentos_catalogo').select('price_id, procedure_name').limit(1);
  if (!cat?.length) {
    // tabela vazia → baixa o catálogo UMA vez (mesma chamada do sync noturno)
    const user = process.env.CLINICORP_USER, token = process.env.CLINICORP_TOKEN;
    const subscriber = process.env.CLINICORP_SUBSCRIBER_ID || user, business = process.env.CLINICORP_BUSINESS_ID || user;
    const hoje = new Date().toISOString().slice(0, 10);
    const qs = new URLSearchParams({ subscriber_id: subscriber, business_id: business, from: '2020-01-01', to: hoje });
    const r = await fetch(`https://api.clinicorp.com/rest/v1/procedures/list?${qs}`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64'), 'X-Api-Key': token } });
    if (!r.ok) { console.error(`catálogo HTTP ${r.status}`); process.exit(1); }
    const raw = await r.json();
    const all = Array.isArray(raw) ? raw : Object.values(raw).flat();
    const rows = all.filter(p => p.id && (p.ProcedureName || p.Name)).map(p => ({ price_id: String(p.id), procedure_name: p.ProcedureName || p.Name }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('procedimentos_catalogo').upsert(rows.slice(i, i + 500), { onConflict: 'price_id' });
      if (error) console.error('upsert catálogo:', error.message);
    }
    console.log(`Catálogo persistido: ${rows.length} procedimentos`);
  }
  // corrige os itens sem nome
  const { data: semNome } = await supabase.from('plano_itens').select('id, price_id').like('procedure_name', 'PriceId %');
  console.log(`Itens sem nome: ${semNome?.length || 0}`);
  let ok = 0, ainda = 0;
  for (const it of semNome || []) {
    const { data: c } = await supabase.from('procedimentos_catalogo').select('procedure_name').eq('price_id', String(it.price_id)).maybeSingle();
    if (c?.procedure_name) { const { error } = await supabase.from('plano_itens').update({ procedure_name: c.procedure_name }).eq('id', it.id); if (!error) ok++; }
    else ainda++;
  }
  console.log(`Corrigidos: ${ok} · sem nome no catálogo: ${ainda}`);
})();
