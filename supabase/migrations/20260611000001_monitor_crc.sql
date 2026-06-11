-- Monitor diário das CRCs
-- 1) Claim idempotente do resumo diário (push 18h30)
alter table public.app_config
  add column if not exists resumo_crc_ultimo_envio date;

-- 2) Esperas abertas: leads cuja conversa terminou em mensagem RECEBIDA sem
-- resposta posterior; `desde` = primeira recebida após a última enviada.
create or replace function public.esperas_abertas(fim timestamptz)
returns table(lead_id bigint, nome text, desde timestamptz)
language sql
stable
as $$
  select l.id, l.nome, w.desde
  from leads l
  join lateral (select max(criada_em) t from mensagens where lead_id = l.id and direcao = 'enviada') ue on true
  join lateral (select min(criada_em) desde from mensagens
                where lead_id = l.id and direcao = 'recebida'
                  and (ue.t is null or criada_em > ue.t)) w on true
  where w.desde is not null and w.desde <= fim
  order by w.desde;
$$;