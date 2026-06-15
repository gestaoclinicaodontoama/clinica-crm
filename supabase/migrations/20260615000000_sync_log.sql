-- Observabilidade do sync diário Clinicorp.
-- Registra cada execução (início, fim, ok/erro, fases) para detectar falhas silenciosas
-- e permitir um scheduler self-healing que sobrevive a restarts do container.

create table if not exists public.sync_log (
  id          bigint generated always as identity primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  trigger     text not null default 'agendado',   -- 'agendado' | 'manual'
  duration_s  numeric(10,1),
  steps       jsonb,
  error       text
);

create index if not exists idx_sync_log_started on public.sync_log (started_at desc);

-- Escrita só pelo service role do servidor; leitura para autenticados (status no painel).
alter table public.sync_log enable row level security;

drop policy if exists sync_log_select on public.sync_log;
create policy sync_log_select on public.sync_log
  for select to authenticated using (true);
