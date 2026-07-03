// Backfill único de fin_saude_analises + snapshot do dia (mesma lógica do
// fetchInadimplentesBackground; as tabelas fin_recebiveis_mensal/fin_fluxo_futuro
// precisam estar frescas — são a base do snapshot).
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const ClinicorpApi = require('../sync/clinicorp-api');
const A = require('../lib/financeiro/analise-parcelas');

const supabase = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });
const api = new ClinicorpApi({
  user: process.env.CLINICORP_USER, token: process.env.CLINICORP_TOKEN,
  subscriberId: process.env.CLINICORP_SUBSCRIBER_ID, businessId: process.env.CLINICORP_BUSINESS_ID,
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const allItems = [];
  for (let i = 0; i < 12; i++) {
    const toDate = new Date(); toDate.setMonth(toDate.getMonth() - i * 2);
    const fromDate = new Date(); fromDate.setMonth(fromDate.getMonth() - (i + 1) * 2);
    const from = fromDate.toISOString().split('T')[0];
    const to = toDate.toISOString().split('T')[0];
    try {
      const r = await api.get('/payment/list', { from, to, date_type: 'postDate' });
      const arr = Array.isArray(r) ? r : (Array.isArray(r?.data) ? r.data : []);
      allItems.push(...arr);
      console.log(`chunk ${from}~${to}: ${arr.length} (total ${allItems.length})`);
    } catch (e) { console.log(`chunk ${from} erro: ${e.message}`); }
    await sleep(400);
  }
  const dados = {
    aging: A.agingVencido(allItems, hoje),
    perda: A.taxaPerda(allItems, hoje),
    renovacao: A.novasERecebidasPorMes(allItems, hoje, 12),
    top: A.topPagadores(allItems, hoje, 10),
    retroativo: A.carteiraRetroativa(allItems, hoje, 24),
  };
  const up1 = await supabase.from('fin_saude_analises')
    .upsert({ id: 1, dados, atualizado_em: new Date().toISOString() }, { onConflict: 'id' });
  if (up1.error) throw new Error(up1.error.message);

  const proxMes = (() => { let [y, m] = hoje.slice(0, 7).split('-').map(Number);
    m++; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, '0')}-01`; })();
  const [receb, fluxo, vencido] = await Promise.all([
    supabase.from('fin_recebiveis_mensal').select('valor').gte('mes', proxMes),
    supabase.from('fin_fluxo_futuro').select('a_pagar').gte('mes', proxMes),
    supabase.rpc('fin_vencido_total'),
  ]);
  const receber = (receb.data || []).reduce((s, r) => s + Number(r.valor), 0);
  const pagar = (fluxo.data || []).reduce((s, r) => s + Number(r.a_pagar), 0);
  const up2 = await supabase.from('fin_saude_snapshots').upsert({
    data: hoje, receber: Math.round(receber * 100) / 100, pagar: Math.round(pagar * 100) / 100,
    resultado: Math.round((receber - pagar) * 100) / 100, vencido: Number(vencido.data || 0), origem: 'diario',
  }, { onConflict: 'data' });
  if (up2.error) throw new Error(up2.error.message);

  console.log(`aging total: R$ ${Math.round(dados.aging.total).toLocaleString('pt-BR')}`);
  console.log(`taxa de perda: ${(dados.perda.taxa * 100).toFixed(1)}% (base R$ ${Math.round(dados.perda.base).toLocaleString('pt-BR')})`);
  console.log(`retroativo: ${dados.retroativo.length} pontos (${dados.retroativo[0].mes} → ${dados.retroativo[23].mes})`);
  console.log(`top 1: ${dados.top[0]?.nome} R$ ${Math.round(dados.top[0]?.valor || 0).toLocaleString('pt-BR')}`);
  console.log(`snapshot ${hoje}: receber ${Math.round(receber)} × pagar ${Math.round(pagar)} = ${Math.round(receber - pagar)}`);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
