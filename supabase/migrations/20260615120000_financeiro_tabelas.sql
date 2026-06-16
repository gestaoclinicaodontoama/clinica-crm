-- fin_contas: plano de contas canônico
create table if not exists fin_contas (
  id          bigint generated always as identity primary key,
  codigo      text not null,                 -- "3.1.7", "1.2"
  nome        text not null,                 -- "Invisalign", "Particular"
  grupo       text not null,                 -- "3.1 - CUSTOS MATERIAL"
  tipo        text not null check (tipo in ('receita','imposto','custo','despesa','financeiro','investimento')),
  ordem       int  not null default 0,
  ativo       boolean not null default true,
  unique (codigo)
);

-- fin_lancamentos: espelho dos lançamentos do Clinicorp
create table if not exists fin_lancamentos (
  id                   bigint generated always as identity primary key,
  clinicorp_id         text not null unique,
  data                 date not null,
  descricao            text not null,
  valor                numeric(14,2) not null,
  fluxo                text not null check (fluxo in ('entra','sai')),
  post_type            text,
  entry_type           text,
  forma_pgto           text,
  empresa              text,
  paciente_id          text,
  receita_sub          text check (receita_sub in ('entrada','parcelas')),
  conta_id             bigint references fin_contas(id),
  classificacao_metodo text,
  override_manual      boolean not null default false,
  ativo                boolean not null default true,
  visto_em             timestamptz,
  raw                  jsonb,
  criado_em            timestamptz not null default now()
);
create index if not exists idx_fin_lanc_data    on fin_lancamentos(data);
create index if not exists idx_fin_lanc_conta   on fin_lancamentos(conta_id);
create index if not exists idx_fin_lanc_semcat  on fin_lancamentos(conta_id) where conta_id is null;
create index if not exists idx_fin_lanc_pac     on fin_lancamentos(paciente_id);

-- fin_regras: regras de categorização
create table if not exists fin_regras (
  id         bigint generated always as identity primary key,
  metodo     text not null check (metodo in ('exato','keyword','pessoa')),
  padrao     text not null,
  conta_id   bigint not null references fin_contas(id),
  prioridade int not null default 0,
  origem     text not null default 'manual',
  criado_por text,
  hits       int not null default 0,
  criado_em  timestamptz not null default now(),
  unique (metodo, padrao)
);

-- fin_pessoas: registro de nomes próprios
create table if not exists fin_pessoas (
  id        bigint generated always as identity primary key,
  nome      text not null,
  papel     text,
  conta_id  bigint references fin_contas(id),
  empresa   text,
  ativo     boolean not null default true,
  unique (nome)
);

-- fin_sync_log: auditoria
create table if not exists fin_sync_log (
  id              bigint generated always as identity primary key,
  periodo         text,
  qtd_lancamentos int,
  novos           int,
  inativados      int,
  quando          timestamptz not null default now(),
  status          text,
  erro            text
);

alter table fin_contas      enable row level security;
alter table fin_lancamentos enable row level security;
alter table fin_regras      enable row level security;
alter table fin_pessoas     enable row level security;
alter table fin_sync_log    enable row level security;
