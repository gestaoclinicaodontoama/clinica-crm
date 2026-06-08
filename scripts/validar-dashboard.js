// scripts/validar-dashboard.js
// Validação de ponta-a-ponta do Dashboard Comercial (CRM Antigo).
// Rodar QUANDO a rede do Supabase estiver estável:  node scripts/validar-dashboard.js
// Faz: (1) inventário das contagens historico_*, (2) monta o dashboard real do período "tudo"
// (2023-01-01 → hoje), (3) cruza kpis.leads do funil com a contagem de historico_lead_criado.
// Sai com código 0 se bater, 1 se divergir ou falhar.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { resolvePeriodo } = require('../lib/funil/periodo');
const { montarDashboard } = require('../lib/funil/dashboard');
const { withTimeout } = require('../lib/funil/eventos');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('FALTA SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no .env');
  process.exit(1);
}
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const TIPOS = ['historico_lead_criado', 'historico_agendado', 'historico_compareceu', 'historico_orcamento', 'historico_fechou'];

async function contar(tipo) {
  const r = await withTimeout(
    sb.from('lead_eventos').select('*', { count: 'exact', head: true }).eq('tipo', tipo),
    15000, `contagem ${tipo}`,
  );
  if (r.error) throw new Error(r.error.message);
  return r.count;
}

const fmtBRL = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtPct = (v) => v == null ? '—' : (v * 100).toFixed(1) + '%';

(async () => {
  console.log('━━━ 1) Inventário de eventos historico_* ━━━');
  const inv = {};
  for (const t of TIPOS) { inv[t] = await contar(t); console.log(`  ${t.padEnd(24)} = ${inv[t]}`); }

  console.log('\n━━━ 2) Dashboard real — período "tudo" (2023-01-01 → hoje) ━━━');
  const hoje = new Date().toISOString().slice(0, 10);
  const periodo = resolvePeriodo('custom', '2023-01-01', hoje);
  const t0 = Date.now();
  const d = await montarDashboard(sb, periodo, null);
  console.log(`  (montado em ${Date.now() - t0}ms)`);
  console.log('  Funil:');
  for (const e of d.funil.etapas) {
    const garg = d.funil.gargalo && d.funil.gargalo.id === e.id ? '  ← GARGALO' : '';
    console.log(`    ${e.rotulo.padEnd(14)} ${String(e.n).padStart(6)}   ${fmtPct(e.conv_etapa_anterior)} da etapa anterior${garg}`);
  }
  console.log(`  Venda (contrato): ${fmtBRL(d.kpis.venda)} | Entrada: ${fmtBRL(d.kpis.entrada)} | Ticket: ${fmtBRL(d.kpis.ticket_medio)}`);
  console.log(`  Origens detectadas: ${d.origens.length} (${d.origens.slice(0, 8).join(', ')}${d.origens.length > 8 ? '…' : ''})`);

  console.log('\n━━━ 3) Conferência (números batem?) ━━━');
  const leadsFunil = d.kpis.leads;
  const leadsInv = inv.historico_lead_criado;
  const okLeads = leadsFunil === leadsInv;
  console.log(`  leads do funil (${leadsFunil}) vs historico_lead_criado (${leadsInv}) → ${okLeads ? '✅ batem' : '⚠️ DIVERGEM'}`);
  if (!okLeads) {
    console.log('    (divergência pode indicar bug de paginação/coorte, ou leads com >1 evento de criação)');
  }
  const fechFunil = d.funil.etapas.find(e => e.id === 'fecharam').n;
  console.log(`  fecharam no funil (${fechFunil}) vs historico_fechou (${inv.historico_fechou}) → ${fechFunil === inv.historico_fechou ? '✅' : 'ℹ diferença esperada se houver lead com múltiplos fechamentos'}`);

  console.log(okLeads ? '\n✅ Validação OK.' : '\n⚠️ Validação com divergência — investigar antes do deploy.');
  process.exit(okLeads ? 0 : 1);
})().catch(e => { console.error('\n💥 FALHA:', e.message); process.exit(1); });
