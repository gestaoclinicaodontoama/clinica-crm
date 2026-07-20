-- Todos os profissionais ATIVOS no Clinicorp (proxy: agenda ou produção nos últimos 90 dias;
-- API pública não expõe /professional/list — 404 confirmado 20/07). Usada pelo dropdown de executor do planejamento.
CREATE OR REPLACE FUNCTION public.executores_ativos()
RETURNS TABLE (nome text)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT trim(dentist_name) AS nome FROM (
    SELECT dentist_name FROM agenda_appointments
      WHERE appointment_date >= current_date - 90 AND dentist_name IS NOT NULL AND dentist_name <> ''
    UNION ALL
    SELECT dentist_name FROM producao_procedimentos
      WHERE executed_date >= current_date - 90 AND dentist_name IS NOT NULL AND dentist_name <> ''
  ) t
  WHERE dentist_name NOT ILIKE '%avalia%'
  ORDER BY 1;
$$;
REVOKE ALL ON FUNCTION public.executores_ativos() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.executores_ativos() TO service_role;
