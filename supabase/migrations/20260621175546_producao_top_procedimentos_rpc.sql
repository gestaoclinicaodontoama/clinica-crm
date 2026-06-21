-- RPC: top procedimentos por valor total no período
CREATE OR REPLACE FUNCTION producao_top_procedimentos(
  p_from  date,
  p_to    date,
  p_limit int DEFAULT 10
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
  GROUP BY 1
  ORDER BY total_value DESC
  LIMIT p_limit;
$$;
