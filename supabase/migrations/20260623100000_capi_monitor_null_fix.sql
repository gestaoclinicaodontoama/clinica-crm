-- Fix crítico: UNIQUE(gatilho, escopo) padrão usa NULLS DISTINCT, então duas
-- linhas com escopo=NULL (gatilhos globais: taxa_falha/erro_novo/queda_volume)
-- NÃO conflitam → ON CONFLICT insere linha nova a cada tick (storm de alerta +
-- tabela crescendo). NULLS NOT DISTINCT (PG15+) faz dois NULLs comparar iguais.
alter table capi_monitor_estado drop constraint capi_monitor_estado_gatilho_escopo_key;
create unique index capi_monitor_estado_gatilho_escopo_key
  on capi_monitor_estado (gatilho, escopo) nulls not distinct;
alter table capi_monitor_estado
  add constraint capi_monitor_estado_gatilho_escopo_key
  unique using index capi_monitor_estado_gatilho_escopo_key;
