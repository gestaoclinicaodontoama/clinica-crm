// scripts/backfill-tempo-baixas.js — preenche tempo_real_min das retroativas criadas SEM tempo
// (baixas automáticas pré-ajuste 21/07 e retroativas da criação do plano — mesma assinatura,
// ambas execução real). Reusa o MESMO ledger de consumo do sync (spec 2026-07-21, ajuste do tempo).
// Alvo: plano_etapas status='concluida_retroativa' AND asb_responsavel IS NULL AND tempo_real_min IS NULL.
// Datas fora da janela da agenda (~30d) → 0 (documentado na spec). Rodar 1× no deploy. Idempotente.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { criarLedgerAgendamentos } = require('../sync/clinicorp-sync');

(async () => {
  const { data: alvos, error } = await supabase.from('plano_etapas')
    .select('id, ordem, concluida_em, item_id, plano_itens!inner(id, price_id, plano_id, plano_tratamento!inner(id, paciente_clinicorp_id, clinicorp_estimate_id))')
    .eq('status', 'concluida_retroativa').is('asb_responsavel', null).is('tempo_real_min', null)
    .order('id');
  if (error) throw error;
  console.log(`alvos: ${(alvos || []).length} etapas`);

  const ledger = criarLedgerAgendamentos();
  // agrupar por (plano, dia, item) e ordenar: 1ª etapa (menor ordem) do grupo consome; demais 0.
  const grupos = new Map();
  for (const e of (alvos || [])) {
    const pt = e.plano_itens.plano_tratamento;
    const dia = e.concluida_em ? String(e.concluida_em).slice(0, 10) : null;
    const key = `${pt.id}|${dia}|${e.plano_itens.id}`;
    if (!grupos.has(key)) grupos.set(key, { pac: pt.paciente_clinicorp_id, est: pt.clinicorp_estimate_id, price: e.plano_itens.price_id, dia, etapas: [] });
    grupos.get(key).etapas.push(e);
  }

  let comTempo = 0, zeradas = 0;
  for (const g of grupos.values()) {
    let tempo = 0;
    if (g.dia && g.pac) {
      // person_id do executor real via producao (mesma fonte da baixa)
      let person = null;
      if (g.est && g.price) {
        const { data: prod } = await supabase.from('producao_procedimentos')
          .select('dentist_person_id').eq('clinicorp_estimate_id', g.est).eq('price_id', g.price)
          .order('executed_date', { ascending: false }).limit(1);
        person = prod?.[0]?.dentist_person_id ? String(prod[0].dentist_person_id) : null;
      }
      tempo = await ledger.consumir(g.pac, g.dia, person);
    }
    const ordenadas = g.etapas.slice().sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0));
    for (const [i, e] of ordenadas.entries()) {
      const v = i === 0 ? tempo : 0;
      const { error: eUp } = await supabase.from('plano_etapas').update({ tempo_real_min: v }).eq('id', e.id);
      if (eUp) throw eUp;
      if (v > 0) comTempo++; else zeradas++;
    }
  }
  console.log(`backfill concluído: ${comTempo} etapas com tempo>0, ${zeradas} com 0`);
})().catch(e => { console.error('backfill falhou:', e.message); process.exit(1); });
