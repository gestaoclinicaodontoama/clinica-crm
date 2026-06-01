alter table public.orcamentos
  add column if not exists revisao_status         text not null default 'pendente',
  add column if not exists valor_aprovado         numeric(12,2),
  add column if not exists entrada_aprovada       numeric(12,2),
  add column if not exists revisado_por           uuid,
  add column if not exists revisado_em            timestamptz,
  add column if not exists revisao_motivo         text,
  add column if not exists clinicorp_lastchange   timestamptz,
  add column if not exists revisao_ref_lastchange timestamptz,
  add column if not exists revisao_notificado     boolean not null default false,
  add column if not exists paciente_nome          text;

create index if not exists idx_orcamentos_revisao on public.orcamentos (revisao_status);
