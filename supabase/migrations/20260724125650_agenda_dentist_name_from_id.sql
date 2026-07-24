-- A agenda da Clinicorp manda só Dentist_PersonId (id), não o nome → dentist_name ficava vazio
-- (Registro Diário e Registrar Sessão sem dentista). Resolve id→nome pelo par já existente em
-- producao_procedimentos, via GATILHO (re-preenche a cada gravação; sobrevive ao re-sync noturno) + backfill.
-- Aplicada REMOTO via MCP 2026-07-24 (version 20260724125650).

CREATE INDEX IF NOT EXISTS idx_prod_dentist_person_nome
  ON producao_procedimentos(dentist_person_id)
  WHERE dentist_person_id IS NOT NULL AND dentist_name IS NOT NULL AND dentist_name <> '';

CREATE OR REPLACE FUNCTION fill_agenda_dentist_name() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.dentist_name IS NULL OR NEW.dentist_name = '')
     AND NEW.dentist_person_id IS NOT NULL AND NEW.dentist_person_id <> '' THEN
    SELECT p.dentist_name INTO NEW.dentist_name
    FROM producao_procedimentos p
    WHERE p.dentist_person_id = NEW.dentist_person_id
      AND p.dentist_name IS NOT NULL AND p.dentist_name <> ''
    LIMIT 1;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_fill_agenda_dentist_name ON agenda_appointments;
CREATE TRIGGER trg_fill_agenda_dentist_name
  BEFORE INSERT OR UPDATE ON agenda_appointments
  FOR EACH ROW EXECUTE FUNCTION fill_agenda_dentist_name();

UPDATE agenda_appointments a SET dentist_name = m.nome
FROM (
  SELECT dentist_person_id, mode() WITHIN GROUP (ORDER BY dentist_name) AS nome
  FROM producao_procedimentos
  WHERE dentist_person_id IS NOT NULL AND dentist_name IS NOT NULL AND dentist_name <> ''
  GROUP BY dentist_person_id
) m
WHERE a.dentist_person_id = m.dentist_person_id
  AND (a.dentist_name IS NULL OR a.dentist_name = '');
