-- Horas fixas de escala por semana, para ratear o salário de dentistas com
-- duas agendas (execução + avaliação) por proporção estável em vez das horas
-- realmente agendadas (que distorcem quando a agenda de avaliação tem slots vazios).
ALTER TABLE dentista_config
  ADD COLUMN IF NOT EXISTS horas_semana_exec numeric(5,2),
  ADD COLUMN IF NOT EXISTS horas_semana_aval numeric(5,2);

-- Marcos: 8h execução / 36h avaliação por semana (escala informada)
UPDATE dentista_config
  SET horas_semana_exec = 8, horas_semana_aval = 36
  WHERE dentist_person_id = '5966301134192640';
