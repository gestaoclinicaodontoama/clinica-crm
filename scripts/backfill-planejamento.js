// scripts/backfill-planejamento.js — vira a chave do Modo de Planejamento.
// Pop. 1 (conferidos-não-planejados) e Pop. 2 (aprovados-não-conferidos): a própria fase
// syncPlanejamento cria os planos com triagem — basta rodá-la uma vez aqui.
// Pop. 3 (tratamentos longos EM CURSO): imprime a lista priorizada p/ a gestora planejar retroativo.
// Pop. 4 (rejeitados): já semeada na migration.
// Pré-requisito: preencher planejamento_dentistas com o mapa do V3 (seed abaixo) ANTES de rodar.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const MAPA_V3 = [
  { profissional_nome: 'Marcos Vinícius Coelho Vidigal Martins', user_id: '0b8c0c41-4c57-4b9a-a7e3-bdc76f0c8abe' },
  { profissional_nome: 'Matheus G. - Execução', user_id: '95dc2d78-108e-4c3b-9569-3d94280e7090' },
  { profissional_nome: 'Marcos - Avaliação', user_id: '0b8c0c41-4c57-4b9a-a7e3-bdc76f0c8abe' },
  { profissional_nome: 'Marcos - Execução', user_id: '0b8c0c41-4c57-4b9a-a7e3-bdc76f0c8abe' },
  { profissional_nome: 'Matheus G. - Avaliação', user_id: '95dc2d78-108e-4c3b-9569-3d94280e7090' },
];

const PADROES_INICIAIS = [
  // Semear ao menos os 2 casos-motivo do projeto + o caso de triagem:
  { procedure_name: 'Faceta', requer_plano: true, etapas: [
    { descricao: 'Preparo + moldagem', profissional_sugerido: null, tempo_sugerido_min: 90 },
    { descricao: 'Prova', profissional_sugerido: null, tempo_sugerido_min: 45 },
    { descricao: 'Cimentação / entrega', profissional_sugerido: null, tempo_sugerido_min: 60 } ] },
  { procedure_name: 'Protocolo', requer_plano: true, etapas: [
    { descricao: 'Cirurgia / instalação dos implantes', profissional_sugerido: null, tempo_sugerido_min: 180 },
    { descricao: 'Moldagem do provisório', profissional_sugerido: null, tempo_sugerido_min: 60 },
    { descricao: 'Instalação do provisório', profissional_sugerido: null, tempo_sugerido_min: 90 },
    { descricao: 'Osseointegração (~6 meses)', profissional_sugerido: null, tempo_sugerido_min: 0 },
    { descricao: 'Moldagem do definitivo', profissional_sugerido: null, tempo_sugerido_min: 60 },
    { descricao: 'Prova', profissional_sugerido: null, tempo_sugerido_min: 45 },
    { descricao: 'Instalação do definitivo', profissional_sugerido: null, tempo_sugerido_min: 90 } ] },
  { procedure_name: 'Profilaxia (limpeza)', requer_plano: false, etapas: [] },
];

(async () => {
  // 0) seeds — price_id casado por nome no catálogo (producao_procedimentos.procedure_name)
  for (const m of MAPA_V3) await supabase.from('planejamento_dentistas').upsert(m, { onConflict: 'profissional_nome' });
  for (const p of PADROES_INICIAIS) {
    const { data: cat } = await supabase.from('producao_procedimentos').select('price_id')
      .ilike('procedure_name', `%${p.procedure_name}%`).not('price_id', 'is', null).limit(1);
    await supabase.from('processos_padrao').upsert(
      { ...p, price_id: cat?.[0]?.price_id || null, status: 'aprovado' },
      { onConflict: 'price_id', ignoreDuplicates: true });
  }
  console.log('Seeds ok. Rodando a fase de planejamento (pop. 1 e 2)...');

  // 1+2) roda a fase do sync (deriva do banco; zero chamadas API)
  const { syncPlanejamento } = require('../sync/clinicorp-sync');
  console.log(await syncPlanejamento());

  // 3) lista dos tratamentos longos em curso p/ planejamento retroativo dirigido
  const { data: longos } = await supabase.from('plano_tratamento')
    .select('clinicorp_estimate_id, paciente_nome, valor, status')
    .eq('status', 'aguardando_planejamento').gte('valor', 5000).order('valor', { ascending: false }).limit(50);
  console.log('\n=== POP. 3 — priorizar retroativo (valor ≥ R$5.000, top 50) ===');
  for (const l of longos || []) console.log(`${l.paciente_nome} — R$${l.valor} — estimate ${l.clinicorp_estimate_id}`);
})();
