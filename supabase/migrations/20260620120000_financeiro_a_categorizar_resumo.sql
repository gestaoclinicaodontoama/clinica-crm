-- Resumo de pendências de categorização (despesa sem conta) agrupado por ano,
-- para o seletor de ano da tela "A categorizar".
create or replace function fin_a_categorizar_por_ano()
returns table(ano int, qtd bigint, total numeric)
language sql stable security definer
set search_path = public as $$
  select extract(year from data)::int as ano, count(*), sum(valor)
  from fin_lancamentos
  where ativo = true and fluxo = 'sai' and conta_id is null
  group by 1 order by 1 desc;
$$;
