// scripts/verificar-planejamento.js — sonda V1/V2/V3 da spec do Modo de Planejamento.
// Uso: node scripts/verificar-planejamento.js   (1 única chamada à API Clinicorp)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BASE = 'https://api.clinicorp.com/rest/v1';
const user = process.env.CLINICORP_USER, token = process.env.CLINICORP_TOKEN;
const subscriber = process.env.CLINICORP_SUBSCRIBER_ID || user, business = process.env.CLINICORP_BUSINESS_ID || user;
const auth = 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');

async function apiGet(path, params) {
  const qs = new URLSearchParams({ subscriber_id: subscriber, business_id: business, ...params });
  const r = await fetch(`${BASE}${path}?${qs}`, { headers: { Authorization: auth, 'X-Api-Key': token } });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return r.json();
}

(async () => {
  // V1 — um estimate APROVADO recente: dump das chaves do estimate e de 1 item da ProcedureList
  const hoje = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const ests = await apiGet('/estimates/list', { from, to: hoje });
  const aprovado = (Array.isArray(ests) ? ests : []).find(e => e.Status === 'APPROVED' && (e.ProcedureList || []).length);
  console.log('=== V1: chaves do estimate ===\n', aprovado ? Object.keys(aprovado).sort().join(', ') : 'NENHUM APROVADO NA JANELA');
  if (aprovado) {
    console.log('=== V1: item[0] da ProcedureList (procurar: status por item? quantidade?) ===');
    console.log(JSON.stringify(aprovado.ProcedureList[0], null, 2));
    const qtdKeys = Object.keys(aprovado.ProcedureList[0]).filter(k => /qty|quant|amount|tooth|dente/i.test(k));
    console.log('candidatas a quantidade/dente:', qtdKeys.join(', ') || '(nenhuma)');
  }
  // V2 — domínios de status vistos no nosso banco (o que o sync enxerga)
  // (⚠️ NUNCA .catch() no builder do supabase-js — regra da casa)
  const { data: statusRows } = await supabase.from('orcamentos').select('status').limit(1000);
  console.log('\n=== V2: valores distintos de orcamentos.status (amostra 1000) ===');
  console.log([...new Set((statusRows || []).map(r => r.status))].join(', '));
  // V3 — profissionais dos orçamentos aprovados × usuários com role dentista
  const { data: profs } = await supabase.from('orcamentos').select('profissional_nome').eq('status', 'APPROVED').limit(1000);
  const contagem = {};
  for (const p of profs || []) contagem[p.profissional_nome || '(vazio)'] = (contagem[p.profissional_nome || '(vazio)'] || 0) + 1;
  console.log('\n=== V3: profissional_nome dos APPROVED (contagem) ===');
  console.log(JSON.stringify(contagem, null, 2));
  // ⚠️ profiles NÃO tem coluna email (verificado 2026-07-19) — usa `nome`. Brief original
  // pedia 'id, email, roles'; adaptado para 'id, nome, roles' (roles já é ARRAY no Postgres,
  // então (u.roles||[]).includes(...) funciona sem parsing de CSV).
  const { data: users } = await supabase.from('profiles').select('id, nome, roles');
  console.log('\n=== V3: todos os profiles (nome, id, roles) — role dentista marcado ===');
  for (const u of users || []) {
    const ehDentista = (u.roles || []).includes('dentista');
    console.log(`${ehDentista ? '[dentista] ' : ''}${u.nome} | ${u.id} | ${(u.roles || []).join(',')}`);
  }
})();
