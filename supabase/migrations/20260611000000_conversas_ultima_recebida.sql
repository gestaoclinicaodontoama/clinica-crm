-- Indicador da janela de 24h: a lista de conversas precisa da última mensagem
-- RECEBIDA (no número SDR) de cada lead. sdr_phone é passado pelo server
-- (whatsapp.defaultPhoneId()); null = sem filtro de número (fallback).
-- DROP necessário: CREATE com assinatura nova criaria um overload ambíguo no PostgREST.
drop function if exists public.conversas_com_preview();

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
  ultima_recebida_em timestamptz
)
language sql
stable
as $function$
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
    ur.criada_em AS ultima_recebida_em
  FROM leads l
  JOIN LATERAL (SELECT texto, direcao, criada_em, wa_number_id FROM mensagens WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) m ON true
  JOIN LATERAL (SELECT COUNT(*) AS total FROM mensagens WHERE lead_id = l.id) c ON true
  LEFT JOIN LATERAL (
    SELECT criada_em FROM mensagens
    WHERE lead_id = l.id AND direcao = 'recebida'
      AND (sdr_phone IS NULL OR wa_number_id IS NULL OR wa_number_id = '' OR wa_number_id = sdr_phone)
    ORDER BY id DESC LIMIT 1
  ) ur ON true
  ORDER BY l.conversa_fixada DESC, m.criada_em DESC;
$function$;
