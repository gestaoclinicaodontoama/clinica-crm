-- Templates por WABA/número: cada template pertence a um número (2873/8700).
-- '' = legado ainda não associado (o sync-meta adota na primeira rodada).
alter table public.templates add column if not exists wa_number_id text not null default '';

-- nome deixa de ser único global (o mesmo nome pode existir nas duas WABAs)
alter table public.templates drop constraint if exists templates_nome_key;
create unique index if not exists templates_nome_wa_number_uniq
  on public.templates (nome, wa_number_id);

-- Backfill leads.wa_number_id: o número "da conversa" é onde o lead FALA —
-- prioriza mensagens recebidas (um disparo enviado via 8700 não pode virar o número do lead)
update public.leads l set wa_number_id = sub.wa_number_id
from (
  select distinct on (lead_id) lead_id, wa_number_id
  from public.mensagens
  where wa_number_id is not null and wa_number_id <> ''
  order by lead_id, (direcao = 'recebida') desc, id desc
) sub
where l.id = sub.lead_id and (l.wa_number_id is null or l.wa_number_id = '');
