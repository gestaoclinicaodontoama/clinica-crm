-- Agregação da DRE no Postgres (evita o limite de 1000 linhas do cliente supabase-js).
-- Retorna soma por conta+fluxo no período; a cascata 1→7 é montada em lib/financeiro/dre.js.
-- (Já aplicada no projeto via MCP; este arquivo garante reprodutibilidade do schema.)
create or replace function fin_dre_agg(p_from date, p_to date)
returns table(conta_codigo text, fluxo text, total numeric)
language sql stable security definer
set search_path = public as $$
  select c.codigo, l.fluxo, sum(l.valor)
  from fin_lancamentos l
  join fin_contas c on c.id = l.conta_id
  where l.ativo = true and l.data between p_from and p_to and l.conta_id is not null
  group by c.codigo, l.fluxo;
$$;
