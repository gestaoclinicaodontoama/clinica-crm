-- Resumo mensal materializado (faturamento REVENUE, caixa RECEIVED, saídas) — uma
-- linha por mês. Evita varrer os ~66k lançamentos a cada abertura da projeção
-- (fin_series_mensais ao vivo sobre 36 meses estourava o statement_timeout).
-- Meses passados não mudam; só os recentes são recalculados no sync diário.
create table if not exists fin_series_cache (
  ym text primary key,
  faturamento numeric not null default 0,
  caixa numeric not null default 0,
  saidas numeric not null default 0,
  atualizado_em timestamptz not null default now()
);
alter table fin_series_cache enable row level security;
revoke all on fin_series_cache from anon, authenticated;

-- Recalcula e faz upsert dos meses no intervalo [p_from, p_to]. Chamar com janela
-- pequena (backfill em blocos anuais; sync diário só os últimos ~2 meses).
create or replace function fin_series_cache_refresh(p_from date, p_to date)
returns integer
language sql
security definer
set search_path = public as $$
  with agg as (
    select to_char(data, 'YYYY-MM') as ym,
      coalesce(sum(valor) filter (where fluxo = 'entra' and post_type = 'REVENUE'), 0) as fat,
      coalesce(sum(valor) filter (where fluxo = 'entra' and post_type = 'RECEIVED'), 0) as cx,
      coalesce(sum(valor) filter (where fluxo = 'sai'), 0) as sd
    from fin_lancamentos
    where ativo and data between p_from and p_to
    group by 1
  ), up as (
    insert into fin_series_cache (ym, faturamento, caixa, saidas, atualizado_em)
    select ym, fat, cx, sd, now() from agg
    on conflict (ym) do update
      set faturamento = excluded.faturamento, caixa = excluded.caixa,
          saidas = excluded.saidas, atualizado_em = now()
    returning 1
  )
  select count(*)::int from up;
$$;
revoke execute on function fin_series_cache_refresh(date, date) from public, anon, authenticated;
grant execute on function fin_series_cache_refresh(date, date) to service_role;

-- Backfill inicial (histórico do financeiro = 2024→). Blocos anuais p/ não pesar.
select fin_series_cache_refresh('2024-01-01','2024-12-31');
select fin_series_cache_refresh('2025-01-01','2025-12-31');
select fin_series_cache_refresh('2026-01-01','2026-12-31');
