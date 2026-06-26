-- Backfill: extrai paciente_id dos REVENUE a partir do raw->>'PersonId'
update fin_lancamentos
set paciente_id = raw->>'PersonId'
where post_type = 'REVENUE'
  and (paciente_id is null or paciente_id = '')
  and coalesce(raw->>'PersonType','') = 'PATIENT'
  and coalesce(raw->>'PersonId','') not in ('', '-1');

-- Índice para os joins do agente de marketing
create index if not exists idx_fin_lanc_pac_tipo_data
  on fin_lancamentos (paciente_id, post_type, data);
