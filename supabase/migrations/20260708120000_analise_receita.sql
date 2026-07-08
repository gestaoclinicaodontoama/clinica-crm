-- Análise de Receita (entrada nova × base recorrente) — spec 2026-07-08.
-- fin_receita_analises: 1 linha JSON sobrescrita pelo job diário (padrão fin_saude_analises).
-- fin_receita_metas: lucro-alvo editável por mês (página Análise de Receita).
create table if not exists public.fin_receita_analises (
  id int primary key,
  dados jsonb not null,
  atualizado_em timestamptz not null default now()
);
alter table public.fin_receita_analises enable row level security;

create table if not exists public.fin_receita_metas (
  mes date primary key,
  lucro_alvo numeric not null check (lucro_alvo >= 0),
  atualizado_em timestamptz not null default now()
);
alter table public.fin_receita_metas enable row level security;
-- Sem policies de propósito: só o servidor (service_role) lê/escreve.
