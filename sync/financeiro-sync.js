require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const ClinicorpApi = require('./clinicorp-api');
const { mapear } = require('../lib/financeiro/mapear-lancamento');
const { criarCategorizador } = require('../lib/financeiro/categorizar');
const { parseCashFlow, janela24m } = require('../lib/financeiro/fluxo-futuro');
const { dataLocal } = require('../lib/financeiro/data');

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

  // Em lote (antes era 1 SELECT + 1 upsert por item = ~2N viagens ao banco).
  // 1) mapeia e descarta itens sem data; 2) busca os existentes em poucas
  // consultas IN; 3) monta as linhas; 4) grava em lotes. Egress cai de ~2N
  // requisições para um punhado.
  const CHUNK = 500;
  const mapeados = itens.map(mapear).filter(m => m.data);

  // dedupe por clinicorp_id (último vence) — evita erro de upsert que afeta a
  // mesma linha duas vezes no mesmo lote e espelha o comportamento do loop.
  const porId = new Map();
  for (const m of mapeados) porId.set(m.clinicorp_id, m);
  const ids = [...porId.keys()];

  // existentes (id + override_manual) em consultas IN paginadas
  const existentes = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data: ex } = await supabase.from('fin_lancamentos')
      .select('clinicorp_id,override_manual').in('clinicorp_id', ids.slice(i, i + CHUNK));
    for (const r of (ex || [])) existentes.set(r.clinicorp_id, r);
  }

  const rows = [];
  let novos = 0;
  for (const m of porId.values()) {
    const existente = existentes.get(m.clinicorp_id);
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
    rows.push(row);
    if (!existente) novos++;
  }

  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase.from('fin_lancamentos').upsert(rows.slice(i, i + CHUNK), { onConflict: 'clinicorp_id' });
    if (error) throw new Error(error.message);
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

// Fluxo futuro (A Receber / A Pagar, 24 meses) — 1 chamada list_cash_flow.
// Upsert por mês + limpeza dos meses passados (a tabela guarda só o futuro).
async function syncFluxoFuturo(hojeISO = dataLocal(new Date().toISOString())) {
  const { from, to } = janela24m(hojeISO);
  const r = await api.get('/financial/list_cash_flow', { from, to });
  const meses = parseCashFlow(r, from);
  const agora = new Date().toISOString();
  const rows = meses.map(m => ({
    mes: m.mes + '-01', a_receber: m.a_receber, a_pagar: m.a_pagar, atualizado_em: agora,
  }));
  if (rows.length) {
    const { error } = await supabase.from('fin_fluxo_futuro').upsert(rows, { onConflict: 'mes' });
    if (error) throw new Error(error.message);
  }
  // guarda só a janela [mês corrente, 24º mês]: limpa o passado E sobras além
  // do horizonte (linha órfã de um parse ruim ficaria pra sempre sem isso)
  const primeiro = hojeISO.slice(0, 7) + '-01';
  const ultimo = to.slice(0, 7) + '-01';
  await supabase.from('fin_fluxo_futuro').delete().or(`mes.lt.${primeiro},mes.gt.${ultimo}`);
  return { meses: rows.length };
}

module.exports = { syncPeriodo, syncFluxoFuturo };
