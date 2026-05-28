-- 20260528000000_3cplus_ligacoes.sql
-- 3cplus Sub-projeto 1: ligacoes, ia_config, ia_uso_log, profiles.threec_agent_id

-- ROLLBACK:
-- DROP TABLE IF EXISTS ia_uso_log;
-- DROP TABLE IF EXISTS ia_config;
-- DROP TABLE IF EXISTS ligacoes;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS threec_agent_id;

-- ── 1. CAMPO threec_agent_id em profiles ────────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS threec_agent_id text;

-- ── 2. TABELA ligacoes ───────────────────────────────────────────────────────
CREATE TABLE ligacoes (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             bigint      REFERENCES leads(id) ON DELETE SET NULL,
  usuario_id          uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  threec_call_id      text        UNIQUE,
  status              text        NOT NULL DEFAULT 'iniciada',
  -- status: iniciada | atendida | nao_atendida | ocupado | falha_gravacao
  duracao_segundos    integer,
  gravacao_url        text,
  tentativas_gravacao integer     NOT NULL DEFAULT 0,
  transcricao         text,
  analise_ia          jsonb,
  -- analise_ia: { resumo, pontos_fortes[], pontos_melhora[], score }
  modulo              text        NOT NULL DEFAULT 'leads',
  -- modulo: leads | agendamentos | avaliacao_dentista
  criada_em           timestamptz NOT NULL DEFAULT now(),
  analisada_em        timestamptz
);

CREATE INDEX idx_ligacoes_lead_id    ON ligacoes (lead_id);
CREATE INDEX idx_ligacoes_usuario_id ON ligacoes (usuario_id);
CREATE INDEX idx_ligacoes_criada_em  ON ligacoes (criada_em DESC);
CREATE INDEX idx_ligacoes_modulo     ON ligacoes (modulo);

-- RLS: service_role tem acesso total via bypass; anon não acessa
ALTER TABLE ligacoes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role bypass" ON ligacoes USING (true) WITH CHECK (true);

-- ── 3. TABELA ia_config ──────────────────────────────────────────────────────
CREATE TABLE ia_config (
  modulo              text    PRIMARY KEY,
  -- modulo: leads | agendamentos | avaliacao_dentista
  auto_analise_ativo  boolean NOT NULL DEFAULT true,
  min_duracao_s       integer NOT NULL DEFAULT 60,
  limite_diario       integer NOT NULL DEFAULT 50,
  limite_semanal      integer NOT NULL DEFAULT 200
);

ALTER TABLE ia_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role bypass" ON ia_config USING (true) WITH CHECK (true);

-- Seeds
INSERT INTO ia_config (modulo) VALUES
  ('leads'),
  ('agendamentos'),
  ('avaliacao_dentista')
ON CONFLICT (modulo) DO NOTHING;

-- ── 4. TABELA ia_uso_log ─────────────────────────────────────────────────────
CREATE TABLE ia_uso_log (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  modulo           text        NOT NULL,
  duracao_audio_s  integer,
  tokens_entrada   integer,
  tokens_saida     integer,
  custo_estimado   numeric(10,4),
  criado_em        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ia_uso_log_criado_em ON ia_uso_log (criado_em DESC);
CREATE INDEX idx_ia_uso_log_modulo    ON ia_uso_log (modulo);

ALTER TABLE ia_uso_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role bypass" ON ia_uso_log USING (true) WITH CHECK (true);
