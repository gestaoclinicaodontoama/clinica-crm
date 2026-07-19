-- Transição do Planejamento: origem (backlog fora da fila do dentista) + tipo de pagamento + inclusão manual
-- Aplicada REMOTO via MCP em 2026-07-19 (version 20260719230226).
ALTER TABLE plano_tratamento
  ADD COLUMN IF NOT EXISTS origem text NOT NULL DEFAULT 'sync_novo'
    CHECK (origem IN ('sync_novo','backlog','sucesso_manual')),
  ADD COLUMN IF NOT EXISTS tipo_pagamento text
    CHECK (tipo_pagamento IN ('particular','convenio','misto')),
  ADD COLUMN IF NOT EXISTS descricao_manual text;
CREATE INDEX IF NOT EXISTS idx_plano_trat_origem ON plano_tratamento(origem);
