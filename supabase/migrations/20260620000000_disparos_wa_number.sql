-- Número de WhatsApp escolhido para o disparo (phone_number_id da Meta).
-- NULL = usa o número de broadcast padrão (comportamento anterior).
ALTER TABLE disparos_campanhas ADD COLUMN IF NOT EXISTS wa_number_id text;
