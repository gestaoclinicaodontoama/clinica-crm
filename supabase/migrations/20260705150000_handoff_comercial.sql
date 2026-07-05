-- Handoff comercial (spec 2026-07-05).
-- 1) tipo de notificação novo (o CHECK bloqueia tipos fora da lista)
alter table notificacoes drop constraint if exists notificacoes_tipo_check;
alter table notificacoes add constraint notificacoes_tipo_check check (tipo = any (array[
  'visita_lead','tarefa_atribuida','tarefa_vencendo','tarefa_resumo','sistema','conferencia_pendente',
  'resumo_crc','capi_alerta','aguardando_resposta','falta_sem_responsavel','falta_recuperar_lembrete',
  'whatsapp_saude','capi_resumo','coleta_lembrete','novo_comparecimento'
]));

-- 2) pool comercial (ids das CRC comerciais ativas)
alter table app_config add column if not exists comercial_pool jsonb;
update app_config set comercial_pool = (
  select coalesce(jsonb_agg(id order by nome), '[]'::jsonb) from profiles
  where roles @> array['crc_comercial']::text[] and coalesce(ativo,true)
) where id = 1 and comercial_pool is null;

-- 3) RPC dos 4 blocos do Meu Dia. p_uid = CRC logada; null = agregado (gestor).
create or replace function public.comercial_meu_dia(p_uid uuid)
returns jsonb language sql stable as $$
  with base as (
    select id, nome, telefone, status, etapa_negociacao,
           data_comparecimento, proximo_contato, valor, crc_comercial_id
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
    )
  );
$$;
