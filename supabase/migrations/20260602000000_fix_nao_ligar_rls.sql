-- Fix RLS policies for nao_ligar_pacientes:
-- Original used user_metadata (user-writable, spoofable).
-- Replace with profiles table check (server-controlled) matching project convention.

DROP POLICY IF EXISTS "nlp_select" ON nao_ligar_pacientes;
DROP POLICY IF EXISTS "nlp_insert" ON nao_ligar_pacientes;
DROP POLICY IF EXISTS "nlp_delete" ON nao_ligar_pacientes;

CREATE POLICY "nlp_select" ON nao_ligar_pacientes FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid()
      AND (roles && ARRAY['crc_leads','crc_comercial','gestor','admin'])
  ));

CREATE POLICY "nlp_insert" ON nao_ligar_pacientes FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid()
      AND (roles && ARRAY['crc_leads','crc_comercial','gestor','admin'])
  ));

CREATE POLICY "nlp_delete" ON nao_ligar_pacientes FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid()
      AND (roles && ARRAY['gestor','admin'])
  ));
