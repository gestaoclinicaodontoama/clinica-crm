-- Batimento (heartbeat) dos jobs de fundo que só logavam no console.
-- Upsert 1 linha por job; a página /sync-saude/ lê para mostrar frescor.
create table if not exists job_health (
  job           text primary key,
  label         text not null,
  cadencia_min  integer not null,
  margem_min    integer not null,
  last_run_at   timestamptz,
  ok            boolean,
  duration_s    numeric,
  detalhe       jsonb,
  error         text,
  atualizado_em timestamptz not null default now()
);
alter table job_health enable row level security;
-- sem policy: só o servidor (service_role) acessa; front vai pelo /api.
