-- Fase 3 (spec 2026-07-08-analise-receita-fase3): backfill de produção órfã
-- (o id do paciente vem no sufixo "(1234)" do nome) + tabelas do detector de
-- renegociação por snapshot diário (payment/list não devolve canceladas).

-- 1) Backfill: 7.541 de 7.549 órfãs têm "(id)" no nome (medido 08/07).
update public.producao_procedimentos
   set paciente_clinicorp_id = (regexp_match(paciente_nome, '\((\d+)\)\s*$'))[1]
 where (paciente_clinicorp_id is null or paciente_clinicorp_id = '')
   and paciente_nome ~ '\(\d+\)\s*$';

-- 2) Foto diária das parcelas ABERTAS, agregada por posição (valor somado,
--    menor vencimento) — substituída inteira a cada rodada do job.
create table if not exists public.fin_parcelas_abertas_snapshot (
  posicao text primary key,          -- TreatmentId|InstallmentNumber
  treatment_id text not null,
  installment int not null,
  patient_id text,
  patient_name text,
  due_date date,
  valor numeric not null default 0,
  atualizado_em timestamptz not null default now()
);
alter table public.fin_parcelas_abertas_snapshot enable row level security;

-- 3) Eventos detectados (nunca apagada; série mensal nasce daqui).
create table if not exists public.fin_renegociacoes (
  id bigserial primary key,
  data date not null,
  tipo text not null check (tipo in ('renegociacao','cancelamento','inicio')),
  treatment_id text,
  patient_id text,
  patient_name text,
  valor_antigo numeric,
  valor_novo numeric,
  detalhes jsonb,
  criado_em timestamptz not null default now()
);
alter table public.fin_renegociacoes enable row level security;
create index if not exists fin_renegociacoes_data_idx on public.fin_renegociacoes (data);
-- Sem policies de propósito: só o servidor (service_role).
