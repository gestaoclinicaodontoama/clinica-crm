-- supabase/migrations/20260621200001_dentista_custo_hora.sql
CREATE TABLE IF NOT EXISTS dentista_custo_hora (
  id                bigserial PRIMARY KEY,
  dentist_person_id text NOT NULL,
  dentist_name      text,
  ano               int NOT NULL,
  custo_hora        numeric(10,2) NOT NULL,
  criado_em         timestamptz NOT NULL DEFAULT now(),
  atualizado_em     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dentista_custo_hora_uk UNIQUE (dentist_person_id, ano)
);
