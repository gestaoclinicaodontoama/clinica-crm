-- DRE por mês (mesma base da fin_dre_agg de 20260615120200, + mês no group by).
create or replace function fin_dre_agg_mensal(p_from date, p_to date)
returns table(ym text, conta_codigo text, fluxo text, total numeric)
language sql stable security definer
set search_path = public as $$
  select to_char(l.data, 'YYYY-MM'), c.codigo, l.fluxo, sum(l.valor)
  from fin_lancamentos l
  join fin_contas c on c.id = l.conta_id
  where l.ativo = true and l.data between p_from and p_to and l.conta_id is not null
  group by 1, 2, 3;
$$;

-- Saídas sem categoria no período (ficam FORA da DRE — aviso na página).
create or replace function fin_sem_categoria_resumo(p_from date, p_to date)
returns table(qtd bigint, total numeric)
language sql stable security definer
set search_path = public as $$
  select count(*), coalesce(sum(valor), 0)
  from fin_lancamentos
  where ativo = true and fluxo = 'sai' and conta_id is null
    and data between p_from and p_to;
$$;
