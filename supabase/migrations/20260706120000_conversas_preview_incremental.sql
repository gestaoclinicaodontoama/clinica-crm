-- LISTA INCREMENTAL das Conversas (economia de egress Supabase).
-- Base: 20260703130000_fila_aguardando_preview_fix (retorno idêntico).
-- Única mudança: novo parâmetro opcional `desde timestamptz`.
--   - desde NULL  → devolve a lista inteira (1ª carga / troca de view). Comportamento atual.
--   - desde SET   → devolve SÓ as conversas cuja última mensagem é mais nova que `desde`
--                   (m.criada_em > desde). O front faz merge por id.
-- O poll de 60s passa a mandar `desde` → payload cai de ~360KB (lista inteira)
-- para poucos KB por ciclo, sem migrar pra Realtime.
drop function if exists public.conversas_com_preview(text);
drop function if exists public.conversas_com_preview(text, timestamptz);

create function public.conversas_com_preview(sdr_phone text default null, desde timestamptz default null)
returns table(
  id bigint, nome text, telefone text, status text, ctwa_clid text,
  texto text, direcao text, criada_em timestamptz, total bigint,
  crc_agendamento_id uuid, crc_agendamento_nome text,
  data_agendamento date, clinicorp_appointment_id text,
  crc_comercial_id uuid, crc_comercial_nome text,
  proximo_contato timestamptz, notas_sdr text, notas_comercial text,
  observacao_interna text,
  origem text, perfil_disc text, campanha text, fbclid text, gclid text,
  eventos_meta_enviados text[],
  wa_number_id text, ultima_wa_number_id text, conversa_fixada boolean,
  ultima_recebida_em timestamptz, nao_ligar boolean
)
language sql stable
as $function$
  SELECT l.id, l.nome, l.telefone, l.status, l.ctwa_clid,
    m.texto, m.direcao, m.criada_em, c.total,
    l.crc_agendamento_id, l.crc_agendamento_nome,
    l.data_agendamento, l.clinicorp_appointment_id,
    l.crc_comercial_id, l.crc_comercial_nome, l.proximo_contato,
    l.notas_sdr, l.notas_comercial, l.observacao_interna,
    l.origem, l.perfil_disc, l.campanha, l.fbclid, l.gclid,
    l.eventos_meta_enviados,
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
  WHERE (desde IS NULL OR m.criada_em > desde)
  ORDER BY l.conversa_fixada DESC, m.criada_em DESC;
$function$;
