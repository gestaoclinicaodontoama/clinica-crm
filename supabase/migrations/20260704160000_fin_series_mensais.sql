-- Série mensal para a projeção de crescimento: faturamento (REVENUE, competência),
-- caixa (RECEIVED, regime de caixa) e saídas (fluxo 'sai'), num só passe.
create or replace function fin_series_mensais(p_from date, p_to date)
returns table(ym text, faturamento numeric, caixa numeric, saidas numeric)
language sql stable security definer
set search_path = public as $$
  select to_char(data, 'YYYY-MM'),
    coalesce(sum(valor) filter (where fluxo = 'entra' and post_type = 'REVENUE'), 0),
    coalesce(sum(valor) filter (where fluxo = 'entra' and post_type = 'RECEIVED'), 0),
    coalesce(sum(valor) filter (where fluxo = 'sai'), 0)
  from fin_lancamentos
  where ativo and data between p_from and p_to
  group by 1;
$$;

revoke execute on function fin_series_mensais(date, date) from public, anon, authenticated;
grant execute on function fin_series_mensais(date, date) to service_role;
