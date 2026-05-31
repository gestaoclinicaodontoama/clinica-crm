-- Sub-1 comercial: fechamento, entrada, tempos por fase, validade por orçamento
alter table public.orcamentos
  add column if not exists data_fechamento  date,
  add column if not exists valor_particular numeric(12,2) not null default 0,
  add column if not exists eh_convenio      boolean not null default false,
  add column if not exists entrada_valor     numeric(12,2),
  add column if not exists entrada_data      date;

create index if not exists idx_orcamentos_fechamento on public.orcamentos (data_fechamento);

alter table public.avaliacoes
  add column if not exists agendado_em       timestamptz,
  add column if not exists comparecimento_em timestamptz,
  add column if not exists tem_orcamento     boolean not null default false;

create index if not exists idx_avaliacoes_tem_orcamento on public.avaliacoes (tem_orcamento);
