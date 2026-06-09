-- Corrige registros onde crc_agendamento_nome / crc_comercial_nome
-- ficaram salvos com o email do usuário ao invés do nome do perfil.
UPDATE leads l
SET crc_agendamento_nome = p.nome
FROM profiles p
WHERE l.crc_agendamento_id = p.id
  AND l.crc_agendamento_nome LIKE '%@%'
  AND p.nome IS NOT NULL
  AND p.nome NOT LIKE '%@%';

UPDATE leads l
SET crc_comercial_nome = p.nome
FROM profiles p
WHERE l.crc_comercial_id = p.id
  AND l.crc_comercial_nome LIKE '%@%'
  AND p.nome IS NOT NULL
  AND p.nome NOT LIKE '%@%';
