-- RPC: produção total por dentista no período
-- Criada durante o módulo Receita x Entrega; migração adicionada retroativamente
-- para garantir que o schema seja reproduzível a partir das migrations.
CREATE OR REPLACE FUNCTION producao_por_dentista(p_from date, p_to date)
RETURNS TABLE (
  dentist_person_id text,
  dentist_name      text,
  producao          numeric
)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE(dentist_person_id, '__sem_dentista__') AS dentist_person_id,
    COALESCE(MAX(dentist_name), 'Sem dentista')     AS dentist_name,
    SUM(amount)                                      AS producao
  FROM producao_procedimentos
  WHERE executed_date >= p_from AND executed_date <= p_to
  GROUP BY COALESCE(dentist_person_id, '__sem_dentista__')
  ORDER BY producao DESC;
$$;
