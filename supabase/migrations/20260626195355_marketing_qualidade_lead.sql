create or replace function marketing_qualidade_lead(p_desde date, p_ate date)
returns table(campanha_id text, total bigint, por_status jsonb)
language sql
stable
as $$
  select
    g.campanha as campanha_id,
    sum(g.cnt)::bigint as total,
    jsonb_object_agg(g.status, g.cnt) as por_status
  from (
    select
      nullif(trim(coalesce(campanha, '')), '') as campanha,
      status,
      count(*) as cnt
    from leads
    where criado_em >= p_desde::timestamptz
      and criado_em <  ((p_ate)::date + 1)::timestamptz
    group by 1, 2
  ) g
  group by g.campanha;
$$;
