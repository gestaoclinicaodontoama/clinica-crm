CREATE TABLE dentista_config (
  dentist_person_id     text PRIMARY KEY,
  dentist_name          text,
  keyword_despesa       text,
  persona_avaliacao_id  text,
  criado_em             timestamptz NOT NULL DEFAULT now(),
  atualizado_em         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE dentista_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "all_access_dentista_config" ON dentista_config USING (true) WITH CHECK (true);

INSERT INTO dentista_config (dentist_person_id, dentist_name, keyword_despesa, persona_avaliacao_id) VALUES
  ('5966301134192640', 'Marcos - Execução',     'Marcos Vinicius', '5757301300985856'),
  ('5057694956126208', 'Matheus G. - Execução', 'Matheus',         '6576596377468928')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION horas_agenda_por_personas(
  p_ids  text[],
  p_from date,
  p_to   date
)
RETURNS TABLE (dentist_person_id text, horas numeric)
LANGUAGE sql STABLE AS $$
  SELECT dentist_person_id, ROUND(SUM(duration_minutes) / 60.0, 2) AS horas
  FROM agenda_appointments
  WHERE dentist_person_id = ANY(p_ids)
    AND deleted = false
    AND appointment_date >= p_from
    AND appointment_date <= p_to
  GROUP BY dentist_person_id;
$$;
