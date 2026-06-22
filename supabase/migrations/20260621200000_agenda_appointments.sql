-- supabase/migrations/20260621200000_agenda_appointments.sql
CREATE TABLE IF NOT EXISTS agenda_appointments (
  id                 bigserial PRIMARY KEY,
  clinicorp_appt_id  text NOT NULL,
  dentist_person_id  text,
  dentist_name       text,
  patient_name       text,
  appointment_date   date NOT NULL,
  from_time          text,
  to_time            text,
  duration_minutes   int,
  category           text,
  checkin_time       text,
  deleted            boolean NOT NULL DEFAULT false,
  atualizado_em      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agenda_appointments_appt_uk UNIQUE (clinicorp_appt_id)
);

CREATE INDEX IF NOT EXISTS agenda_appointments_dent_date_idx
  ON agenda_appointments (dentist_person_id, appointment_date);
CREATE INDEX IF NOT EXISTS agenda_appointments_date_idx
  ON agenda_appointments (appointment_date);
