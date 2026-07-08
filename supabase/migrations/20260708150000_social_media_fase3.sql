-- Fase 3: cache da IA + radar de referência
create table if not exists public.sm_ia_cache (
  chave text primary key,
  fatos jsonb,
  payload jsonb,
  atualizado_em timestamptz not null default now()
);

create table if not exists public.radar_posts (
  media_id text primary key,
  username text not null,
  ig_timestamp timestamptz,
  caption text,
  media_type text,
  permalink text,
  like_count int,
  comments_count int not null default 0,
  followers_no_dia int,
  atualizado_em timestamptz not null default now()
);
create index if not exists radar_posts_user_ts_idx on public.radar_posts (username, ig_timestamp desc);

alter table public.sm_config add column if not exists radar jsonb not null default '[]'::jsonb;

alter table public.sm_ia_cache enable row level security;
alter table public.radar_posts enable row level security;
