-- Tempo real da sessão vem da duração do agendamento do dia (não digitado pela ASB). Aplicada REMOTO 2026-07-20.
ALTER TABLE sessao_avulsa ADD COLUMN IF NOT EXISTS tempo_real_min int;
