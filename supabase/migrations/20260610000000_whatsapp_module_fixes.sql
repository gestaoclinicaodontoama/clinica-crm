-- Correções do módulo WhatsApp CRC Lead (code review 2026-06-10)

-- Índice composto: a RPC conversas_com_preview busca a última mensagem de cada
-- lead com ORDER BY id DESC LIMIT 1 — este índice atende o lateral direto.
create index if not exists mensagens_lead_id_id_idx
  on public.mensagens (lead_id, id desc);

-- Falha no envio de mensagem agendada: o cron faz claim antes de enviar e não
-- reenvia em caso de erro (evita spam ao lead); o motivo fica registrado aqui.
alter table public.mensagens_agendadas
  add column if not exists erro text;

-- Versiona a RPC conversas_com_preview no repositório (existia apenas no banco,
-- aplicada fora das migrations — drift de schema). Definição idêntica à de produção.
create or replace function public.conversas_com_preview()
returns table(
  id bigint, nome text, telefone text, status text, ctwa_clid text,
  texto text, direcao text, criada_em timestamptz, total bigint,
  crc_agendamento_id uuid, crc_agendamento_nome text,
  data_agendamento date, clinicorp_appointment_id text,
  crc_comercial_id uuid, crc_comercial_nome text,
  proximo_contato timestamptz, notas_sdr text, notas_comercial text,
  origem text, perfil_disc text, campanha text, fbclid text, gclid text,
  referral_data jsonb, eventos_meta_enviados text[],
  wa_number_id text, ultima_wa_number_id text, conversa_fixada boolean
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
    l.conversa_fixada
  FROM leads l
  JOIN LATERAL (SELECT texto, direcao, criada_em, wa_number_id FROM mensagens WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) m ON true
  JOIN LATERAL (SELECT COUNT(*) AS total FROM mensagens WHERE lead_id = l.id) c ON true
  ORDER BY l.conversa_fixada DESC, m.criada_em DESC;
$function$;
