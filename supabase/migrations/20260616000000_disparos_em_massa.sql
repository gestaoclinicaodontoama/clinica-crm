-- Disparo em massa via WhatsApp (Fase 1)
create table if not exists disparos_campanhas (
  id            bigint generated always as identity primary key,
  nome          text not null,
  template_nome text not null,
  lang          text not null default 'pt_BR',
  total         int  not null default 0,
  enviados      int  not null default 0,
  falhas        int  not null default 0,
  status        text not null default 'rascunho',  -- rascunho/enviando/pausada/concluida
  auto_pausada  boolean not null default false,
  criado_por    uuid,
  criado_em     timestamptz not null default now(),
  iniciada_em   timestamptz,
  concluida_em  timestamptz
);

create table if not exists disparos_contatos (
  id            bigint generated always as identity primary key,
  campanha_id   bigint not null references disparos_campanhas(id) on delete cascade,
  lead_id       bigint references leads(id) on delete set null,
  nome          text,
  primeiro_nome text,
  telefone      text not null,
  variaveis     jsonb not null default '[]'::jsonb,
  status        text not null default 'pendente',  -- pendente/enviado/falha
  wa_id         text,
  erro          text,
  enviado_em    timestamptz
);

create index if not exists idx_disparos_contatos_campanha_status
  on disparos_contatos (campanha_id, status);
create index if not exists idx_disparos_contatos_lead
  on disparos_contatos (lead_id);
create index if not exists idx_disparos_campanhas_status
  on disparos_campanhas (status);
