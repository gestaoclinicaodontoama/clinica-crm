-- Mesclagem de leads duplicados por telefone (executado em 2026-06-10 via MCP Supabase)
-- Resultado: 70 pares mesclados; backup completo em public.leads_dedup_backup_20260610 (140 linhas).
--
-- Contexto: a base tinha cadastros do mesmo número em formatos diferentes
-- (sem DDI 55 / com DDI; com e sem o 9º dígito). O webhook do WhatsApp criava
-- um lead novo a cada resposta porque o match era por igualdade exata.
--
-- Regras aplicadas:
-- - Par elegível: mesmos dígitos após remover DDI 55 e o 3º dígito QUANDO é '9'
--   (mesma regra de chaveTelefone em lib/funil/telefone.js). Pares cujo dígito
--   extra não é 9 (ex.: 44 7 5089... vs 44 9 5089... — pessoas diferentes da
--   mesma família) ou com zero à esquerda NÃO foram mesclados.
-- - Keeper: lead com mais mensagens; empate → mais eventos; empate → id menor.
-- - Telefone final: variante com DDI 55 (formato que o webhook recebe).
-- - Status final: 'Fechou' sempre vence (preserva receita); senão vale o status
--   do cadastro mais recente. valor = greatest; datas de funil = coalesce;
--   notas concatenadas com ' | '; etiquetas/eventos_meta = união; criado_em = mais antigo.
-- - Filhos repontados: mensagens, mensagens_agendadas, lead_eventos, chamadas,
--   consultas_spin, ligacoes, pacientes_sucesso, pixel_sessions, avaliacoes, orcamentos.
--   (lead_eventos respeitando os índices únicos parciais de template.)
-- - Cada mesclagem registrou evento 'leads_mesclados' no trajeto do keeper.
--
-- Para desfazer um caso específico: consultar leads_dedup_backup_20260610 pelo id.

do $$
declare
  par record;
  keeper public.leads%rowtype;
  dup public.leads%rowtype;
  tel_canon text;
  novo_status text;
  n_merged int := 0;
begin
  create table if not exists public.leads_dedup_backup_20260610 (like public.leads including defaults);

  for par in (
    with d as (
      select id, regexp_replace(coalesce(telefone,''),'\D','','g') dig
      from public.leads where telefone is not null and telefone <> ''
    ), n as (
      select id, case when dig like '55%' and length(dig) in (12,13) then substr(dig,3) else dig end s from d
    ), k as (
      select id, case when length(s)=11 and substr(s,3,1)='9' then substr(s,1,2)||substr(s,4) else s end chave
      from n where length(s) in (10,11)
    )
    select a.id id_a, b.id id_b from k a join k b on a.chave = b.chave and a.id < b.id
  ) loop
    select l.* into keeper from public.leads l where l.id in (par.id_a, par.id_b)
      order by (select count(*) from public.mensagens m where m.lead_id = l.id) desc,
               (select count(*) from public.lead_eventos e where e.lead_id = l.id) desc,
               l.id asc
      limit 1;
    select l.* into dup from public.leads l where l.id in (par.id_a, par.id_b) and l.id <> keeper.id;

    insert into public.leads_dedup_backup_20260610 select * from public.leads where id in (keeper.id, dup.id);

    update public.mensagens set lead_id = keeper.id where lead_id = dup.id;
    update public.mensagens_agendadas set lead_id = keeper.id where lead_id = dup.id;
    update public.chamadas set lead_id = keeper.id where lead_id = dup.id;
    update public.consultas_spin set lead_id = keeper.id where lead_id = dup.id;
    update public.ligacoes set lead_id = keeper.id where lead_id = dup.id;
    update public.pacientes_sucesso set lead_id = keeper.id where lead_id = dup.id;
    update public.pixel_sessions set lead_id = keeper.id where lead_id = dup.id;
    update public.avaliacoes set lead_id = keeper.id where lead_id = dup.id;
    update public.orcamentos set lead_id = keeper.id where lead_id = dup.id;
    update public.lead_eventos e set lead_id = keeper.id
      where e.lead_id = dup.id
        and not (e.tipo in ('template_respondido','template_sem_resposta')
          and exists (select 1 from public.lead_eventos x
                      where x.lead_id = keeper.id and x.tipo = e.tipo
                        and coalesce(x.metadata->>'template','') = coalesce(e.metadata->>'template','')));
    delete from public.lead_eventos where lead_id = dup.id;

    tel_canon := case
      when keeper.telefone ~ '^55\d{10,11}$' then keeper.telefone
      when dup.telefone ~ '^55\d{10,11}$' then dup.telefone
      else keeper.telefone end;
    novo_status := case
      when keeper.status = 'Fechou' or dup.status = 'Fechou' then 'Fechou'
      when dup.criado_em > keeper.criado_em then dup.status
      else keeper.status end;

    update public.leads set
      telefone = tel_canon,
      status = novo_status,
      nome = case when coalesce(keeper.nome,'') = '' or keeper.nome ~ '^\d+$'
                  then coalesce(nullif(dup.nome,''), keeper.nome) else keeper.nome end,
      email = coalesce(nullif(keeper.email,''), nullif(dup.email,''), ''),
      origem = case when coalesce(keeper.origem,'') in ('','WhatsApp Direto','Outros','Direto')
                     and coalesce(dup.origem,'') not in ('','WhatsApp Direto','Outros','Direto')
                    then dup.origem else coalesce(keeper.origem,'') end,
      campanha = coalesce(nullif(keeper.campanha,''), nullif(dup.campanha,''), ''),
      fbclid = coalesce(nullif(keeper.fbclid,''), nullif(dup.fbclid,''), ''),
      gclid = coalesce(nullif(keeper.gclid,''), nullif(dup.gclid,''), ''),
      ctwa_clid = coalesce(nullif(keeper.ctwa_clid,''), nullif(dup.ctwa_clid,''), ''),
      referral_data = case when keeper.referral_data <> '{}'::jsonb then keeper.referral_data
                           when dup.referral_data is not null and dup.referral_data <> '{}'::jsonb then dup.referral_data
                           else keeper.referral_data end,
      valor = greatest(keeper.valor, dup.valor),
      tipo_trat = coalesce(nullif(keeper.tipo_trat,''), nullif(dup.tipo_trat,''), ''),
      notas_sdr = concat_ws(' | ', nullif(keeper.notas_sdr,''),
        case when coalesce(dup.notas_sdr,'') <> '' and coalesce(dup.notas_sdr,'') <> coalesce(keeper.notas_sdr,'') then dup.notas_sdr end),
      notas_avaliacao = concat_ws(' | ', nullif(keeper.notas_avaliacao,''),
        case when coalesce(dup.notas_avaliacao,'') <> '' and coalesce(dup.notas_avaliacao,'') <> coalesce(keeper.notas_avaliacao,'') then dup.notas_avaliacao end),
      notas_comercial = concat_ws(' | ', nullif(keeper.notas_comercial,''),
        case when coalesce(dup.notas_comercial,'') <> '' and coalesce(dup.notas_comercial,'') <> coalesce(keeper.notas_comercial,'') then dup.notas_comercial end),
      score_interesse = coalesce(keeper.score_interesse, dup.score_interesse),
      perfil_disc = coalesce(nullif(keeper.perfil_disc,''), nullif(dup.perfil_disc,''), ''),
      etiquetas = (select coalesce(array_agg(distinct e), '{}'::text[])
                   from unnest(coalesce(keeper.etiquetas,'{}'::text[]) || coalesce(dup.etiquetas,'{}'::text[])) e),
      eventos_meta_enviados = (select coalesce(array_agg(distinct e), '{}'::text[])
                   from unnest(coalesce(keeper.eventos_meta_enviados,'{}'::text[]) || coalesce(dup.eventos_meta_enviados,'{}'::text[])) e),
      proximo_contato = coalesce(keeper.proximo_contato, dup.proximo_contato),
      ultimo_contato = case when coalesce(dup.ultimo_contato,'') > coalesce(keeper.ultimo_contato,'')
                            then dup.ultimo_contato else keeper.ultimo_contato end,
      data_lead = least(keeper.data_lead, dup.data_lead),
      data_agendamento = coalesce(keeper.data_agendamento, dup.data_agendamento),
      data_comparecimento = coalesce(keeper.data_comparecimento, dup.data_comparecimento),
      data_avaliacao = coalesce(keeper.data_avaliacao, dup.data_avaliacao),
      data_orcamento = coalesce(keeper.data_orcamento, dup.data_orcamento),
      data_fechamento = coalesce(keeper.data_fechamento, dup.data_fechamento),
      enviado_meta = coalesce(keeper.enviado_meta,false) or coalesce(dup.enviado_meta,false),
      enviado_google = coalesce(keeper.enviado_google,false) or coalesce(dup.enviado_google,false),
      criado_em = least(keeper.criado_em, dup.criado_em),
      clinicorp_appointment_id = coalesce(keeper.clinicorp_appointment_id, dup.clinicorp_appointment_id),
      clinicorp_patient_id = coalesce(keeper.clinicorp_patient_id, dup.clinicorp_patient_id),
      crc_agendamento_id = coalesce(keeper.crc_agendamento_id, dup.crc_agendamento_id),
      crc_agendamento_nome = coalesce(nullif(keeper.crc_agendamento_nome,''), nullif(dup.crc_agendamento_nome,'')),
      crc_comercial_id = coalesce(keeper.crc_comercial_id, dup.crc_comercial_id),
      crc_comercial_nome = coalesce(nullif(keeper.crc_comercial_nome,''), nullif(dup.crc_comercial_nome,'')),
      wa_number_id = coalesce(nullif(keeper.wa_number_id,''), nullif(dup.wa_number_id,''), ''),
      conversa_fixada = coalesce(keeper.conversa_fixada,false) or coalesce(dup.conversa_fixada,false),
      nao_ligar = coalesce(keeper.nao_ligar,false) or coalesce(dup.nao_ligar,false),
      atualizado_em = now()
    where id = keeper.id;

    insert into public.lead_eventos (lead_id, tipo, descricao, metadata)
    values (keeper.id, 'leads_mesclados',
      'Cadastro duplicado #' || dup.id || ' (' || coalesce(dup.nome,'sem nome') || ') mesclado neste lead — mesmo telefone em formato diferente',
      jsonb_build_object('dup_id', dup.id, 'dup_nome', dup.nome, 'dup_status', dup.status,
                         'dup_telefone', dup.telefone, 'dup_criado_em', dup.criado_em,
                         'keeper_status_antes', keeper.status, 'status_final', novo_status));

    delete from public.leads where id = dup.id;
    n_merged := n_merged + 1;
  end loop;
  raise notice 'pares mesclados: %', n_merged;
end $$;
