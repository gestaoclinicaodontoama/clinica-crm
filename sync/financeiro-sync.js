require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const ClinicorpApi = require('./clinicorp-api');
const { mapear } = require('../lib/financeiro/mapear-lancamento');
const { criarCategorizador } = require('../lib/financeiro/categorizar');

const supabase = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });
const api = new ClinicorpApi({
  user: process.env.CLINICORP_USER, token: process.env.CLINICORP_TOKEN,
  subscriberId: process.env.CLINICORP_SUBSCRIBER_ID, businessId: process.env.CLINICORP_BUSINESS_ID,
});

async function carregarCategorizador() {
  // fin_regras pode ter milhares de linhas — paginar (o cliente JS trunca em 1000).
  async function todasRegras() {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('fin_regras').select('metodo,padrao,peso,conta_id').range(from, from + 999);
      if (error) throw new Error(error.message);
      if (!data || !data.length) break;
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  }
  const [{ data: contas }, regras, { data: pessoas }] = await Promise.all([
    supabase.from('fin_contas').select('id,codigo'),
    todasRegras(),
    supabase.from('fin_pessoas').select('nome,conta_id').eq('ativo', true),
  ]);
  const codById = new Map(contas.map(c => [c.id, c.codigo]));
  const idByCod = new Map(contas.map(c => [c.codigo, c.id]));
  const cat = criarCategorizador({
    regras: regras.map(r => ({ metodo: r.metodo, padrao: r.padrao, peso: r.peso, conta_codigo: codById.get(r.conta_id) })),
    pessoas: pessoas.map(p => ({ nome: p.nome, conta_codigo: codById.get(p.conta_id) })),
  });
  return { cat, idByCod };
}

// Sincroniza um período [from,to] (YYYY-MM-DD). Idempotente + reconciliação.
async function syncPeriodo(from, to) {
  const inicio = new Date().toISOString();
  try {
  const r = await api.get('/financial/list_summary', { from, to });
  const itens = (r.values || []);
  const { cat, idByCod } = await carregarCategorizador();

  let novos = 0;
  for (const e of itens) {
    const m = mapear(e);
    if (!m.data) continue;
    const { data: existente } = await supabase.from('fin_lancamentos')
      .select('id,override_manual').eq('clinicorp_id', m.clinicorp_id).maybeSingle();
    let conta_id = null, metodo = null;
    if (m.fluxo === 'sai') { const c = cat(m.descricao); conta_id = c.conta_codigo ? idByCod.get(c.conta_codigo) : null; metodo = c.metodo; }
    // Receita: SÓ RECEIVED (regime de caixa) entra na DRE. REVENUE (competência/faturamento) e
    // demais 'entra' ficam guardados com conta_id=null — fora da DRE de caixa (uso na Fase 2).
    else if (m.post_type === 'RECEIVED') { conta_id = idByCod.get(m.forma_pgto === 'convenio' ? '1.1' : '1.2'); metodo = 'auto'; }
    else { conta_id = null; metodo = null; }

    const row = {
      clinicorp_id: m.clinicorp_id, data: m.data, descricao: m.descricao, valor: m.valor,
      fluxo: m.fluxo, post_type: m.post_type, entry_type: m.entry_type, forma_pgto: m.forma_pgto,
      empresa: m.empresa, paciente_id: m.paciente_id, raw: m.raw, ativo: true, visto_em: inicio,
    };
    if (!existente?.override_manual) { row.conta_id = conta_id; row.classificacao_metodo = metodo; }
    const { error } = await supabase.from('fin_lancamentos').upsert(row, { onConflict: 'clinicorp_id' });
    if (error) throw new Error(error.message);
    if (!existente) novos++;
  }

  const { data: inativados } = await supabase.from('fin_lancamentos')
    .update({ ativo: false }).gte('data', from).lte('data', to).lt('visto_em', inicio).select('id');

  await supabase.from('fin_sync_log').insert({
    periodo: `${from}~${to}`, qtd_lancamentos: itens.length, novos,
    inativados: inativados?.length || 0, status: 'ok',
  });
  return { total: itens.length, novos, inativados: inativados?.length || 0 };
  } catch (e) {
    // A1: registra a falha no log de auditoria sem engolir o erro.
    await supabase.from('fin_sync_log').insert({ periodo: `${from}~${to}`, status: 'erro', erro: String(e.message).slice(0, 500) });
    throw e;
  }
}

module.exports = { syncPeriodo };
