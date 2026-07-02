-- Análise por Dentista: agregações no SQL.
-- O client JS do Supabase trunca .select() em 1000 linhas; a agenda tem ~1000
-- agendamentos/mês, então buscar linhas cruas quebrava períodos multi-mês
-- (horas ficavam de ~1 mês só). Idem para a lista de dentistas de execução,
-- derivada de >10k linhas de producao_procedimentos.

CREATE OR REPLACE FUNCTION dentistas_execucao()
RETURNS TABLE (dentist_person_id text, dentist_name text)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (dentist_person_id) dentist_person_id, dentist_name
  FROM producao_procedimentos
  WHERE dentist_person_id IS NOT NULL
    AND dentist_name NOT ILIKE '%avalia%'
  ORDER BY dentist_person_id, executed_date DESC;
$$;

CREATE OR REPLACE FUNCTION agenda_horas_dentista_mes(
  p_ids  text[],
  p_from date,
  p_to   date
)
RETURNS TABLE (dentist_person_id text, ano int, mes int, horas numeric, dias int)
LANGUAGE sql STABLE AS $$
  SELECT dentist_person_id,
         EXTRACT(YEAR  FROM appointment_date)::int AS ano,
         EXTRACT(MONTH FROM appointment_date)::int AS mes,
         ROUND(SUM(duration_minutes) / 60.0, 2)    AS horas,
         COUNT(DISTINCT appointment_date)::int     AS dias
  FROM agenda_appointments
  WHERE dentist_person_id = ANY(p_ids)
    AND deleted = false
    AND appointment_date >= p_from
    AND appointment_date <= p_to
  GROUP BY 1, 2, 3;
$$;
