-- Dashboard Comercial: funil de avaliações
-- avaliacoes: 1 linha por agendamento de avaliador
create table if not exists public.avaliacoes (
  clinicorp_appointment_id text primary key,
  paciente_clinicorp_id    text,
  telefone                 text,            -- normalizado (só dígitos)
  dentista_nome            text,
  dentista_clinicorp_id    text,
  data                     date,
  compareceu               boolean not null default false,
  status_raw               text,           -- StatusId cru da Clinicorp
  lead_id                  bigint,         -- nullable; resolvido por telefone
  atualizado_em            timestamptz not null default now()
);
create index if not exists idx_avaliacoes_data     on public.avaliacoes (data);
create index if not exists idx_avaliacoes_telefone on public.avaliacoes (telefone);
create index if not exists idx_avaliacoes_lead     on public.avaliacoes (lead_id);

-- orcamentos: 1 linha por estimate
create table if not exists public.orcamentos (
  clinicorp_estimate_id text primary key,
  treatment_id          text,
  paciente_clinicorp_id text,
  telefone              text,
  profissional_nome     text,
  valor                 numeric(12,2) not null default 0,
  status                text,             -- APPROVED | OPEN | ...
  data_criacao          date,
  lead_id               bigint,
  atualizado_em         timestamptz not null default now()
);
create index if not exists idx_orcamentos_data     on public.orcamentos (data_criacao);
create index if not exists idx_orcamentos_paciente on public.orcamentos (paciente_clinicorp_id);
create index if not exists idx_orcamentos_telefone on public.orcamentos (telefone);
create index if not exists idx_orcamentos_lead     on public.orcamentos (lead_id);

-- config de dentistas avaliadores
create table if not exists public.config_avaliadores (
  id           bigint generated always as identity primary key,
  clinicorp_id text,
  nome         text not null,
  ativo        boolean not null default true,
  criado_em    timestamptz not null default now()
);

-- config: quais StatusId contam como "compareceu"
create table if not exists public.config_status_compareceu (
  status_id   text primary key,
  descricao   text,
  compareceu  boolean not null default false,
  criado_em   timestamptz not null default now()
);

-- Seed dos avaliadores (DENTISTAS_AVALIACAO do server.js, confirmados nos dados)
insert into public.config_avaliadores (clinicorp_id, nome, ativo) values
  ('5757301300985856', 'Marcos - Avaliação',     true),
  ('6576596377468928', 'Matheus G. - Avaliação', true)
on conflict do nothing;

-- Seed dos StatusId observados; verde = compareceu (90% têm check-in físico).
-- O sync usa CheckinTime como sinal primário; este config é reforço/ajustável.
insert into public.config_status_compareceu (status_id, descricao, compareceu) values
  ('6702677734588416', 'verde #66bb6a — atendido/compareceu', true),
  ('4838751182913536', 'cinza #424242 — faltou/cancelado',    false),
  ('5848518009421824', 'teal #009688 — raro',                 false),
  ('4634769697144832', 'azul #1976d2 — atendido (raro)',      true)
on conflict (status_id) do nothing;

-- RLS: habilitado, leitura para usuários autenticados; escrita só service_role (sync)
alter table public.avaliacoes               enable row level security;
alter table public.orcamentos               enable row level security;
alter table public.config_avaliadores       enable row level security;
alter table public.config_status_compareceu enable row level security;

create policy "comercial le avaliacoes" on public.avaliacoes
  for select to authenticated using (true);
create policy "comercial le orcamentos" on public.orcamentos
  for select to authenticated using (true);
create policy "comercial le config_avaliadores" on public.config_avaliadores
  for select to authenticated using (true);
create policy "comercial le config_status" on public.config_status_compareceu
  for select to authenticated using (true);
