-- Alerta de lead parado (spec 2026-07-06).
-- 1) config
alter table app_config
  add column if not exists parado_prazo_compareceu_dias int default 3,
  add column if not exists parado_prazo_negociacao_dias int default 2,
  add column if not exists parado_notif_hora text default '09:00',
  add column if not exists parado_notif_envios jsonb default '{}'::jsonb;

-- 2) tipo de notificação novo
alter table notificacoes drop constraint if exists notificacoes_tipo_check;
alter table notificacoes add constraint notificacoes_tipo_check check (tipo = any (array[
  'visita_lead','tarefa_atribuida','tarefa_vencendo','tarefa_resumo','sistema','conferencia_pendente',
  'resumo_crc','capi_alerta','aguardando_resposta','falta_sem_responsavel','falta_recuperar_lembrete',
  'whatsapp_saude','capi_resumo','coleta_lembrete','novo_comparecimento','lead_parado'
]));

-- 3) RPC leads_ultima_atividade — parado? por card (kanban). Allowlist de atividade.
create or replace function public.leads_ultima_atividade(p_ids bigint[])
returns table(lead_id bigint, dias_parado int, parado boolean)
language sql stable as $$
  with cfg as (
    select coalesce(parado_prazo_compareceu_dias,3) c, coalesce(parado_prazo_negociacao_dias,2) n
    from app_config where id=1
  )
  select l.id,
    floor(extract(epoch from (now()-x.ua))/86400)::int as dias_parado,
    case
      when l.proximo_contato is not null and l.proximo_contato > now() then false
      when l.status='Compareceu' then x.ua <= now() - make_interval(days => (select c from cfg))
      when l.status='Em negociação' then x.ua <= now() - make_interval(days => (select n from cfg))
      else false
    end as parado
  from leads l
  cross join lateral (
    select coalesce(max(e.criado_em), l.data_comparecimento, l.data_avaliacao, l.criado_em) as ua
    from lead_eventos e
    where e.lead_id = l.id and e.tipo = any(array[
      'mensagem_enviada','mensagem_recebida','ligacao','status_mudou','etapa_mudou',
      'nota_sdr_editada','template_enviado','conversa_assumida','comercial_assumido','mensagem_falhou'])
  ) x
  where l.id = any(p_ids);
$$;

-- 4) comercial_meu_dia recriada COM o bloco 'parados' (mantém os 4 blocos do item 3).
--    SECURITY INVOKER (default). base ganha data_avaliacao/criado_em p/ o coalesce.
create or replace function public.comercial_meu_dia(p_uid uuid)
returns jsonb language sql stable as $$
  with cfg as (
    select coalesce(parado_prazo_compareceu_dias,3) pc, coalesce(parado_prazo_negociacao_dias,2) pn
    from app_config where id=1
  ),
  base as (
    select id, nome, telefone, status, etapa_negociacao,
           data_comparecimento, data_avaliacao, proximo_contato, valor, crc_comercial_id, criado_em
    from leads
  )
  select jsonb_build_object(
    'para_pegar', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',id,'nome',nome,'telefone',telefone,'data_comparecimento',data_comparecimento
      ) order by data_comparecimento desc), '[]'::jsonb)
      from base where status='Compareceu' and crc_comercial_id is null
        and data_comparecimento >= now() - interval '30 days'
    ),
    'meus_comparecidos', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',id,'nome',nome,'telefone',telefone,'data_comparecimento',data_comparecimento
      ) order by data_comparecimento desc), '[]'::jsonb)
      from base where status='Compareceu'
        and (case when p_uid is null then crc_comercial_id is not null else crc_comercial_id = p_uid end)
    ),
    'minhas_negociacoes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',id,'nome',nome,'telefone',telefone,'etapa',coalesce(etapa_negociacao,'D0'),'valor',valor
      ) order by etapa_negociacao nulls first), '[]'::jsonb)
      from base where status='Em negociação'
        and (case when p_uid is null then crc_comercial_id is not null else crc_comercial_id = p_uid end)
    ),
    'followups', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',id,'nome',nome,'telefone',telefone,'proximo_contato',proximo_contato,'status',status
      ) order by proximo_contato asc), '[]'::jsonb)
      from base where proximo_contato is not null and proximo_contato <= now()
        and (case when p_uid is null then crc_comercial_id is not null else crc_comercial_id = p_uid end)
    ),
    'parados', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',id,'nome',nome,'telefone',telefone,'status',status,'etapa',etapa,'dias_parado',dias_parado
      ) order by dias_parado desc), '[]'::jsonb)
      from (
        select b.id, b.nome, b.telefone, b.status,
          coalesce(b.etapa_negociacao,'D0') as etapa,
          floor(extract(epoch from (now()-x.ua))/86400)::int as dias_parado
        from base b
        cross join lateral (
          select coalesce(max(e.criado_em), b.data_comparecimento, b.data_avaliacao, b.criado_em) as ua
          from lead_eventos e
          where e.lead_id = b.id and e.tipo = any(array[
            'mensagem_enviada','mensagem_recebida','ligacao','status_mudou','etapa_mudou',
            'nota_sdr_editada','template_enviado','conversa_assumida','comercial_assumido','mensagem_falhou'])
        ) x
        where (case when p_uid is null then b.crc_comercial_id is not null else b.crc_comercial_id = p_uid end)
          and (b.proximo_contato is null or b.proximo_contato <= now())
          and (
            (b.status='Compareceu' and x.ua <= now() - make_interval(days => (select pc from cfg)))
            or (b.status='Em negociação' and x.ua <= now() - make_interval(days => (select pn from cfg)))
          )
      ) s
    )
  );
$$;

-- 5) segurança: revoke execute (recriar re-concede a PUBLIC)
revoke execute on function public.comercial_meu_dia(uuid) from public, anon, authenticated;
revoke execute on function public.leads_ultima_atividade(bigint[]) from public, anon, authenticated;
