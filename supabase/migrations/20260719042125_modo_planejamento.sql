-- Modo de Planejamento (Produção ①) — spec docs/superpowers/specs/2026-07-19-modo-planejamento-design.md
-- Aplicada REMOTO via MCP em 2026-07-19 (version 20260719042125). RLS ligado em todas, sem policy
-- (front nunca lê direto — tudo via /api com service_role). Seed população 4 no fim.

ALTER TABLE orcamentos ADD COLUMN IF NOT EXISTS procedure_list jsonb;

CREATE TABLE IF NOT EXISTS plano_tratamento (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinicorp_estimate_id text UNIQUE NOT NULL,
  paciente_clinicorp_id text,
  paciente_nome text,
  dentista_avaliador_id uuid,
  planejado_por uuid,
  status text NOT NULL DEFAULT 'aguardando_planejamento'
    CHECK (status IN ('aguardando_planejamento','planejado','em_andamento','concluido','descartado','cancelado')),
  status_motivo text,
  valor numeric, entrada numeric,
  orientacao_clinica text,
  recado_sucesso text,
  possivel_duplicata boolean NOT NULL DEFAULT false,
  duplicata_de text,
  divergencia_reportada boolean NOT NULL DEFAULT false,
  divergencia_texto text,
  trava_resync text,
  trocas_responsavel jsonb NOT NULL DEFAULT '[]',
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  planejado_em timestamptz
);
CREATE INDEX IF NOT EXISTS idx_plano_trat_status ON plano_tratamento(status);
CREATE INDEX IF NOT EXISTS idx_plano_trat_dentista ON plano_tratamento(dentista_avaliador_id);

CREATE TABLE IF NOT EXISTS plano_itens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plano_id bigint NOT NULL REFERENCES plano_tratamento(id) ON DELETE CASCADE,
  parent_id bigint REFERENCES plano_itens(id) ON DELETE CASCADE,
  price_id text, procedure_name text NOT NULL,
  quantidade int NOT NULL DEFAULT 1 CHECK (quantidade >= 1),
  rotulo text,
  ordem int NOT NULL DEFAULT 0,
  removido_em timestamptz
);
CREATE INDEX IF NOT EXISTS idx_plano_itens_plano ON plano_itens(plano_id);

CREATE TABLE IF NOT EXISTS plano_etapas (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES plano_itens(id) ON DELETE CASCADE,
  ordem int NOT NULL DEFAULT 0,
  descricao text NOT NULL,
  profissional_executor text,
  tempo_planejado_min int,
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','concluida','concluida_retroativa')),
  tempo_real_min int,
  asb_responsavel uuid,
  concluida_em timestamptz
);
CREATE INDEX IF NOT EXISTS idx_plano_etapas_item ON plano_etapas(item_id);

CREATE TABLE IF NOT EXISTS processos_padrao (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  price_id text,
  procedure_name text NOT NULL,
  requer_plano boolean NOT NULL DEFAULT true,
  margem_alvo numeric,
  etapas jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'aprovado' CHECK (status IN ('rascunho','aprovado')),
  criado_por uuid, criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_processos_padrao_price ON processos_padrao(price_id) WHERE price_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS planejamento_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  custo_hora_clinica numeric NOT NULL DEFAULT 180,
  margem_alvo_default numeric NOT NULL DEFAULT 20,
  prazo_escalonamento_dias int NOT NULL DEFAULT 7,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
INSERT INTO planejamento_config (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS planejamento_dentistas (
  profissional_nome text PRIMARY KEY,
  user_id uuid,
  ativo boolean NOT NULL DEFAULT true
);

ALTER TABLE plano_tratamento      ENABLE ROW LEVEL SECURITY;
ALTER TABLE plano_itens           ENABLE ROW LEVEL SECURITY;
ALTER TABLE plano_etapas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE processos_padrao     ENABLE ROW LEVEL SECURITY;
ALTER TABLE planejamento_config   ENABLE ROW LEVEL SECURITY;
ALTER TABLE planejamento_dentistas ENABLE ROW LEVEL SECURITY;

-- POPULAÇÃO 4 do cutover: aprovados já REJEITADOS pela CRC antiga viram 'cancelado' (supressão do sync)
INSERT INTO plano_tratamento (clinicorp_estimate_id, paciente_clinicorp_id, paciente_nome, status, status_motivo, valor, entrada)
SELECT o.clinicorp_estimate_id, o.paciente_clinicorp_id, o.paciente_nome,
       'cancelado', 'rejeitado_conferencia', o.valor_particular, o.entrada_valor
FROM orcamentos o
WHERE o.revisao_status = 'rejeitado'
ON CONFLICT (clinicorp_estimate_id) DO NOTHING;
