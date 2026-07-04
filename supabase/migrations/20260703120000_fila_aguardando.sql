-- Fila "aguardando resposta" (spec 2026-07-03-fila-aguardando-ecos-claim).
-- Regra CANÔNICA em um lugar só: status ativo, sem nao_ligar, última mensagem
-- da conversa é 'recebida' há >= N minutos. O filtro ⏰ do cliente espelha isso.
create or replace function public.conversas_aguardando(minutos int default 30)
returns table(lead_id bigint, nome text, telefone text, status text,
              ultima_recebida timestamptz, espera_min int, crc_agendamento_id uuid)
language sql stable as $$
  select l.id, l.nome, l.telefone, l.status, m.criada_em,
         floor(extract(epoch from (now() - m.criada_em)) / 60)::int,
         l.crc_agendamento_id
  from leads l
  -- criada_em desc (não id): ecos backfillados têm id novo com data antiga
  join lateral (select direcao, criada_em from mensagens
                where lead_id = l.id order by criada_em desc, id desc limit 1) m on true
  where l.status in ('Novo','Em qualificação','Avaliação agendada','Compareceu','Em negociação')
    and coalesce(l.nao_ligar, false) = false
    and m.direcao = 'recebida'
    and m.criada_em <= now() - make_interval(mins => minutos)
  order by m.criada_em asc;
$$;

-- conversas_com_preview: + nao_ligar (o filtro ⏰ do cliente precisa dele).
-- DROP necessário: assinatura de retorno muda.
drop function if exists public.conversas_com_preview(text);
create or replace function public.conversas_com_preview(sdr_phone text default null)
returns table(
  id bigint, nome text, telefone text, status text, ctwa_clid text,
  texto text, direcao text, criada_em timestamptz, total bigint,
  crc_agendamento_id uuid, crc_agendamento_nome text,
  data_agendamento date, clinicorp_appointment_id text,
  crc_comercial_id uuid, crc_comercial_nome text,
  proximo_contato timestamptz, notas_sdr text, notas_comercial text,
  origem text, perfil_disc text, campanha text, fbclid text, gclid text,
  referral_data jsonb, eventos_meta_enviados text[],
  wa_number_id text, ultima_wa_number_id text, conversa_fixada boolean,
  ultima_recebida_em timestamptz, nao_ligar boolean
)
language sql stable as $function$
  SELECT l.id, l.nome, l.telefone, l.status, l.ctwa_clid,
    m.texto, m.direcao, m.criada_em, c.total,
    l.crc_agendamento_id, l.crc_agendamento_nome,
    l.data_agendamento, l.clinicorp_appointment_id,
    l.crc_comercial_id, l.crc_comercial_nome, l.proximo_contato,
    l.notas_sdr, l.notas_comercial,
    l.origem, l.perfil_disc, l.campanha, l.fbclid, l.gclid,
    l.referral_data, l.eventos_meta_enviados,
    l.wa_number_id, m.wa_number_id AS ultima_wa_number_id,
    l.conversa_fixada,
    ur.criada_em AS ultima_recebida_em,
    l.nao_ligar
  FROM leads l
  -- criada_em DESC (não id): ecos backfillados têm id novo com data antiga —
  -- por id, um eco velho viraria a "última mensagem" e afundaria a conversa
  JOIN LATERAL (SELECT texto, direcao, criada_em, wa_number_id FROM mensagens WHERE lead_id = l.id ORDER BY criada_em DESC, id DESC LIMIT 1) m ON true
  JOIN LATERAL (SELECT COUNT(*) AS total FROM mensagens WHERE lead_id = l.id) c ON true
  LEFT JOIN LATERAL (
    SELECT criada_em FROM mensagens
    WHERE lead_id = l.id AND direcao = 'recebida'
      AND (sdr_phone IS NULL OR wa_number_id IS NULL OR wa_number_id = '' OR wa_number_id = sdr_phone)
    ORDER BY criada_em DESC, id DESC LIMIT 1
  ) ur ON true
  ORDER BY l.conversa_fixada DESC, m.criada_em DESC;
$function$;

-- Config da varredura fim de dia (17:30 Maria Eduarda, 18:00 Paola)
alter table app_config
  add column if not exists varredura_aguardando jsonb,
  add column if not exists varredura_aguardando_envios jsonb default '{}'::jsonb;

update app_config set varredura_aguardando = (
  select coalesce(jsonb_agg(jsonb_build_object('usuario_id', p.id, 'hora', v.hora)), '[]'::jsonb)
  from (values ('Maria Eduarda%', '17:30'), ('Paola%', '18:00')) as v(padrao, hora)
  join profiles p on p.nome ilike v.padrao
) where id = 1 and varredura_aguardando is null;
