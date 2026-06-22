-- supabase/migrations/20260621200002_dentista_horas_manual.sql
CREATE TABLE IF NOT EXISTS dentista_horas_manual (
  id                bigserial PRIMARY KEY,
  dentist_person_id text NOT NULL,
  dentist_name      text,
  ano               int NOT NULL,
  mes               int NOT NULL,
  horas             numeric(6,2) NOT NULL,
  criado_em         timestamptz NOT NULL DEFAULT now(),
  atualizado_em     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dentista_horas_manual_uk UNIQUE (dentist_person_id, ano, mes)
);
