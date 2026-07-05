-- supabase/migrations/20260705120000_inad_paciente_ids.sql
-- Liga produção realizada e agenda ao paciente (id Clinicorp) para o módulo Inadimplência 2.0.

ALTER TABLE producao_procedimentos
  ADD COLUMN IF NOT EXISTS paciente_clinicorp_id text;

CREATE INDEX IF NOT EXISTS producao_procedimentos_paciente_idx
  ON producao_procedimentos (paciente_clinicorp_id);

ALTER TABLE agenda_appointments
  ADD COLUMN IF NOT EXISTS paciente_clinicorp_id text;

CREATE INDEX IF NOT EXISTS agenda_appointments_paciente_idx
  ON agenda_appointments (paciente_clinicorp_id);
