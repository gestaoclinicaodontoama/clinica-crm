-- Monitor de Saúde do CAPI — estado dos gatilhos + idempotência dos resumos
create table if not exists capi_monitor_estado (
  id bigint generated always as identity primary key,
  gatilho text not null,
  escopo text,
  status text not null default 'ok',         -- 'ok' | 'alertado'
  fingerprint text,
  ultimo_alerta_em timestamptz,
  detalhe jsonb,
  atualizado_em timestamptz not null default now(),
  unique (gatilho, escopo)
);

-- idempotência dos resumos diários (claim atômico, padrão do resumo_crc)
alter table app_config add column if not exists capi_resumo_8h_ultimo date;
alter table app_config add column if not exists capi_resumo_18h_ultimo date;
