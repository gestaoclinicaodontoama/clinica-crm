-- supabase/migrations/20260620000000_producao_procedimentos.sql

CREATE TABLE IF NOT EXISTS producao_procedimentos (
  id                     bigserial PRIMARY KEY,
  clinicorp_estimate_id  text        NOT NULL,
  clinicorp_treatment_id text,
  price_id               text,
  procedure_name         text,
  specialty_id           text,
  dentist_person_id      text,
  dentist_name           text,
  executed_date          date        NOT NULL,
  amount                 numeric     NOT NULL DEFAULT 0,
  bill_type              text,
  paciente_nome          text,
  atualizado_em          timestamptz NOT NULL DEFAULT now(),

  -- Coluna gerada para dedup idempotente via Supabase JS onConflict.
  -- Supabase JS não suporta onConflict em índices funcionais (COALESCE),
  -- então usamos coluna gerada com UNIQUE CONSTRAINT normal.
  -- Usamos extract(epoch) para evitar date::text (não imutável no Postgres).
  dedup_key text GENERATED ALWAYS AS (
    clinicorp_estimate_id
    || '|' || COALESCE(price_id, '')
    || '|' || extract(epoch from executed_date)::bigint::text
    || '|' || COALESCE(dentist_person_id, '')
  ) STORED,

  CONSTRAINT producao_procedimentos_dedup_uk UNIQUE (dedup_key)
);

CREATE INDEX IF NOT EXISTS producao_procedimentos_date_idx
  ON producao_procedimentos (executed_date);

CREATE INDEX IF NOT EXISTS producao_procedimentos_dentist_idx
  ON producao_procedimentos (dentist_person_id);

CREATE INDEX IF NOT EXISTS producao_procedimentos_estimate_idx
  ON producao_procedimentos (clinicorp_estimate_id);
