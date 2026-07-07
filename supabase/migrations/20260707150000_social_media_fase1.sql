-- Agente de Social Media — Fase 1 (calendário + coleta IG)
create table if not exists public.sm_posts (
  id bigint generated always as identity primary key,
  data_hora timestamptz not null,
  perfil text not null check (perfil in ('ama','dr_marcos')),
  titulo text not null,
  formato text not null default 'reel' check (formato in ('reel','carrossel','foto','story')),
  redes jsonb not null default '{}'::jsonb,
  legenda text not null default '',
  hashtags text not null default '',
  link_drive text not null default '',
  status text not null default 'rascunho'
    check (status in ('rascunho','aguardando_aprovacao','aprovado','publicado','cancelado')),
  ig_media_id text,
  observacoes text not null default '',
  criado_por uuid,
  aprovado_por uuid,
  aprovado_em timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists sm_posts_data_idx on public.sm_posts (data_hora);
create index if not exists sm_posts_status_idx on public.sm_posts (status);

create table if not exists public.ig_posts (
  media_id text primary key,
  perfil text not null,
  ig_timestamp timestamptz,
  caption text,
  media_type text,
  permalink text,
  reach int, likes int, comments int, shares int, saved int,
  total_interactions int, plays int,
  atualizado_em timestamptz not null default now()
);
create index if not exists ig_posts_perfil_ts_idx on public.ig_posts (perfil, ig_timestamp desc);

create table if not exists public.ig_perfil_snapshot (
  data date not null,
  perfil text not null,
  followers int,
  reach_dia int,
  primary key (data, perfil)
);

create table if not exists public.sm_config (
  id int primary key check (id = 1),
  exigir_aprovacao boolean not null default true,
  perfis jsonb not null default '{
    "dr_marcos": {"nome":"Dr. Marcos Vinicius","page_id":"106183378976777","ig_id":"17841400142826935"},
    "ama":       {"nome":"Clínica AMA","page_id":"292276370828259","ig_id":null}
  }'::jsonb,
  atualizado_em timestamptz not null default now()
);
insert into public.sm_config (id) values (1) on conflict do nothing;

-- RLS ligado SEM policies: acesso só pelo service role do servidor (regra da casa pós-auditoria 07/07)
alter table public.sm_posts enable row level security;
alter table public.ig_posts enable row level security;
alter table public.ig_perfil_snapshot enable row level security;
alter table public.sm_config enable row level security;
