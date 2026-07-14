-- Auditoria de exportação de leads (LGPD): quem baixou, quantos, com que filtro.
-- Spec: docs/superpowers/specs/2026-07-14-export-leads-discador-design.md
create table public.leads_export_log (
  id bigint generated always as identity primary key,
  usuario_id uuid,
  usuario_nome text,
  modo text,              -- 'ids' | 'filtro'
  qtd int not null,       -- linhas do CSV entregue (pós-descarte de sem-telefone)
  filtros jsonb,          -- {coluna,q,crc,origem} quando modo='filtro'
  criado_em timestamptz not null default now()
);

alter table public.leads_export_log enable row level security;
-- SEM policy: só o servidor (service_role) grava/lê. Front não toca direto.
