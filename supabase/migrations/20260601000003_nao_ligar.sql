-- supabase/migrations/20260601000003_nao_ligar.sql

CREATE TABLE nao_ligar_pacientes (
  clinicorp_id TEXT PRIMARY KEY,
  criado_em    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE nao_ligar_pacientes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "nlp_select" ON nao_ligar_pacientes FOR SELECT
  USING ((auth.jwt() -> 'user_metadata' ->> 'role') IN ('crc_leads','crc_comercial','gestor','admin'));

CREATE POLICY "nlp_insert" ON nao_ligar_pacientes FOR INSERT
  WITH CHECK ((auth.jwt() -> 'user_metadata' ->> 'role') IN ('crc_leads','crc_comercial','gestor','admin'));

CREATE POLICY "nlp_delete" ON nao_ligar_pacientes FOR DELETE
  USING ((auth.jwt() -> 'user_metadata' ->> 'role') IN ('gestor','admin'));

ALTER TABLE leads ADD COLUMN nao_ligar BOOLEAN NOT NULL DEFAULT false;
