-- supabase/migrations/20260717120208_agenda_status_compareceu.sql
-- Auditoria de registro clínico: syncAgenda passa a gravar o StatusId do
-- /appointment/list e o derivado compareceu (checkin OU status marcado em
-- config_status_compareceu). NULL = linha ainda não re-sincronizada.
ALTER TABLE agenda_appointments
  ADD COLUMN IF NOT EXISTS status_id  text,
  ADD COLUMN IF NOT EXISTS compareceu boolean;
-- Sem índice novo: o endpoint filtra por appointment_date (índice
-- agenda_appointments_date_idx já existe) e decide compareceu no JS.
