-- Recebíveis por mês de vencimento (parcelas do /payment/list), horizonte 24m.
-- Substitui o in_forecast do cash_flow como fonte do lado "a receber" da página
-- /financeiro/saude/ (o cash_flow só devolve ~12 meses; as parcelas cobrem 24+).
-- Range completo com zeros: mês sem parcela = linha com valor 0, não ausência.
create table if not exists fin_recebiveis_mensal (
  mes date primary key,                    -- dia 1 do mês
  valor numeric not null default 0,        -- soma das parcelas a vencer no mês
  atualizado_em timestamptz not null default now()
);
-- Mesmo padrão das demais fin_*: RLS ligada sem policies = acesso só via service role.
alter table fin_recebiveis_mensal enable row level security;
