-- A Receber / A Pagar (saúde 24m): agregado mensal futuro do list_cash_flow.
-- Tabela guarda SÓ o futuro (mês corrente em diante); sem histórico de snapshots.
create table if not exists fin_fluxo_futuro (
  mes date primary key,                    -- dia 1 do mês
  a_receber numeric not null default 0,    -- in_forecast (parcelas a vencer)
  a_pagar numeric not null default 0,      -- out_forecast (contas lançadas)
  atualizado_em timestamptz not null default now()
);
-- Mesmo padrão das demais fin_*: RLS ligada sem policies = acesso só via service role.
alter table fin_fluxo_futuro enable row level security;

-- Vencido a receber: SUM no SQL (o client JS trunca em 1000 linhas).
create or replace function fin_vencido_total()
returns numeric language sql stable as $$
  select coalesce(sum(total_vencido), 0) from pacientes_financeiro;
$$;
