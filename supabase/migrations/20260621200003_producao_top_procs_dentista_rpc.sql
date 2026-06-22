-- supabase/migrations/20260621200003_producao_top_procs_dentista_rpc.sql
CREATE OR REPLACE FUNCTION producao_top_procs_dentista(
  p_from         date,
  p_to           date,
  p_dentist_id   text,
  p_limit        int DEFAULT 5
)
RETURNS TABLE (
  procedure_name text,
  total_value    numeric,
  count          bigint
)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE(NULLIF(procedure_name, ''), 'Não identificado') AS procedure_name,
    SUM(amount)  AS total_value,
    COUNT(*)     AS count
  FROM producao_procedimentos
  WHERE executed_date BETWEEN p_from AND p_to
    AND dentist_person_id = p_dentist_id
  GROUP BY 1
  ORDER BY total_value DESC
  LIMIT p_limit;
$$;
