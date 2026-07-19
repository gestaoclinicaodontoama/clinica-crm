-- Data de corte da virada: orçamento aprovado ANTES = backlog (fora da fila do dentista); a partir dela = sync_novo.
-- Torna a classificação independente da ordem entre backfill e sync noturno (remove o footgun operacional).
-- Aplicada REMOTO via MCP 2026-07-19 (version 20260719234539). Default CURRENT_DATE = dia da migração; operador pode UPDATE.
ALTER TABLE planejamento_config
  ADD COLUMN IF NOT EXISTS cutover_date date NOT NULL DEFAULT CURRENT_DATE;
