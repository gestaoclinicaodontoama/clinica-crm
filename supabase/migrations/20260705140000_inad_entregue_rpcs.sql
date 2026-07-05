-- Agregações SQL-side p/ Inadimplência 2.0 (evita somar no JS / limite 1000 do client
-- e reduz egress). SECURITY INVOKER (default); revoga de anon/authenticated — o servidor
-- chama com a service_role. Ver pendência de RPCs anon-exposed.

CREATE OR REPLACE FUNCTION inad_entregue_por_paciente(p_ids text[], p_hoje date)
RETURNS TABLE(paciente_clinicorp_id text, total_entregue numeric, veio_recente boolean)
LANGUAGE sql STABLE AS $$
  SELECT paciente_clinicorp_id,
         COALESCE(SUM(amount), 0)                      AS total_entregue,
         bool_or(executed_date >= p_hoje - 90)         AS veio_recente
  FROM producao_procedimentos
  WHERE paciente_clinicorp_id = ANY(p_ids)
    AND paciente_clinicorp_id <> ''
  GROUP BY paciente_clinicorp_id;
$$;

CREATE OR REPLACE FUNCTION inad_consulta_futura_ids(p_ids text[], p_hoje date)
RETURNS TABLE(paciente_clinicorp_id text)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT paciente_clinicorp_id
  FROM agenda_appointments
  WHERE paciente_clinicorp_id = ANY(p_ids)
    AND paciente_clinicorp_id <> ''
    AND deleted = false
    AND appointment_date >= p_hoje;
$$;

REVOKE EXECUTE ON FUNCTION inad_entregue_por_paciente(text[], date) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION inad_consulta_futura_ids(text[], date) FROM anon, authenticated;
