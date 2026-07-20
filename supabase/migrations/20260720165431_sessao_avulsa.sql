-- Entrega ② Registro por Sessão (ASB): registro de atendimento avulso (caso b) + comparecimento sem etapa.
-- Aplicada REMOTO via MCP 2026-07-20 (version 20260720165431). RLS on, sem policy.
CREATE TABLE IF NOT EXISTS sessao_avulsa (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  paciente_clinicorp_id text,
  paciente_nome text,
  data date NOT NULL DEFAULT CURRENT_DATE,
  asb_user_id uuid,
  obs text,
  plano_id bigint REFERENCES plano_tratamento(id) ON DELETE SET NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessao_avulsa_data ON sessao_avulsa(data);
CREATE INDEX IF NOT EXISTS idx_sessao_avulsa_pac ON sessao_avulsa(paciente_clinicorp_id);
ALTER TABLE sessao_avulsa ENABLE ROW LEVEL SECURITY;
