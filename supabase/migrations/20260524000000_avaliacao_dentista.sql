-- 20260524000000_avaliacao_dentista.sql
-- Módulo: Avaliação - Dentista (PR 1)
-- Tabelas + RLS + triggers + funções SECURITY DEFINER + seeds + backfill profiles.roles

-- ROLLBACK (executar em ordem reversa em ambiente isolado se necessário):
-- DROP FUNCTION IF EXISTS dashboard_avaliacao_dentista(date, date);
-- DROP FUNCTION IF EXISTS tokens_efetivos_mes(uuid);
-- DROP FUNCTION IF EXISTS sync_consulta_spin_nota_final() CASCADE;
-- DROP TABLE IF EXISTS rate_limits;
-- DROP TABLE IF EXISTS benchmark_spin_planos;
-- DROP TABLE IF EXISTS benchmark_spin;
-- DROP TABLE IF EXISTS dentista_perfil_spin;
-- DROP TABLE IF EXISTS consultas_spin;
-- DROP TABLE IF EXISTS tipos_tratamento;
-- DROP TABLE IF EXISTS avaliacao_dentista_config;
-- ALTER TABLE pacientes
--   DROP COLUMN IF EXISTS consentimento_gravacao_versao,
--   DROP COLUMN IF EXISTS consentimento_gravacao_em,
--   DROP COLUMN IF EXISTS consentimento_gravacao;
-- -- Para reverter o backfill de roles: trabalhar caso a caso, não há rollback automático.


-- ── 1. TIPOS_TRATAMENTO ─────────────────────────────────────────────────────

CREATE TABLE tipos_tratamento (
  id    integer  PRIMARY KEY,
  nome  text     NOT NULL UNIQUE,
  ativo boolean  NOT NULL DEFAULT true
);

ALTER TABLE tipos_tratamento ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tipos_tratamento_select_auth" ON tipos_tratamento
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "tipos_tratamento_write_admin" ON tipos_tratamento
  FOR ALL
  USING  (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles @> ARRAY['admin']))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles @> ARRAY['admin']));


-- ── 2. AVALIACAO_DENTISTA_CONFIG ────────────────────────────────────────────

CREATE TABLE avaliacao_dentista_config (
  chave       text       PRIMARY KEY,
  valor       text,
  updated_by  uuid       REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at  timestamptz DEFAULT now()
);

ALTER TABLE avaliacao_dentista_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "config_select_auth" ON avaliacao_dentista_config
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "config_insert_gestor" ON avaliacao_dentista_config
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles && ARRAY['gestor','admin'])
  );

CREATE POLICY "config_update_gestor" ON avaliacao_dentista_config
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles && ARRAY['gestor','admin'])
  );


-- ── 3. RATE_LIMITS ──────────────────────────────────────────────────────────

CREATE TABLE rate_limits (
  chave      text        PRIMARY KEY,
  contador   integer     NOT NULL DEFAULT 0,
  expira_em  timestamptz NOT NULL
);

CREATE INDEX idx_rate_limits_expira ON rate_limits (expira_em);

-- Sem RLS: acessado apenas via service_role no servidor.


-- ── 4. CONSULTAS_SPIN ───────────────────────────────────────────────────────

CREATE TABLE consultas_spin (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  id_legacy_localstorage      text,
  dentista_id                 uuid        NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  paciente_id                 uuid        REFERENCES pacientes(id) ON DELETE SET NULL,
  paciente_nome               text        NOT NULL,
  paciente_vinculado          boolean     NOT NULL DEFAULT true,
  lead_id                     bigint      REFERENCES leads(id) ON DELETE SET NULL,
  modo                        text        NOT NULL CHECK (modo IN ('deepgram','audio','texto')),
  started_at                  timestamptz NOT NULL,
  ended_at                    timestamptz,
  transcript                  jsonb,
  transcript_purgado_em       timestamptz,
  analysis                    jsonb       NOT NULL,
  analysis_schema_version     smallint    NOT NULL DEFAULT 1,
  uso                         jsonb,
  transcript_stats            jsonb,
  nota_final                  numeric(4,2),
  tipo_tratamento_id          integer     REFERENCES tipos_tratamento(id) ON DELETE SET NULL,
  tipo_tratamento_outro       text        CHECK (tipo_tratamento_outro IS NULL OR char_length(tipo_tratamento_outro) <= 100),
  tratamento_valor_cents      integer     CHECK (tratamento_valor_cents IS NULL OR tratamento_valor_cents >= 0),
  tratamento_valor_label      text        CHECK (tratamento_valor_label IS NULL OR char_length(tratamento_valor_label) <= 80),
  planejamento_em             timestamptz,
  feedback_ia                 jsonb,
  feedback_ia_em              timestamptz,
  consentimento_manual_versao text,
  consentimento_manual_em     timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tipo_tratamento_exclusivo CHECK (
    tipo_tratamento_id IS NULL OR tipo_tratamento_outro IS NULL
  ),
  -- Consentimento manual obrigatório para paciente não vinculado em modo gravado.
  -- Validação para paciente VINCULADO é aplicacional (servidor checa pacientes.consentimento_gravacao).
  CONSTRAINT consentimento_manual_obrigatorio CHECK (
    paciente_vinculado = true
    OR modo = 'texto'
    OR consentimento_manual_versao IS NOT NULL
  )
);

-- UNIQUE INDEX parcial: CONSTRAINT UNIQUE com NULL não deduplica em Postgres.
-- Permite múltiplas consultas novas (NULL) e impede duplicata de import por dentista.
CREATE UNIQUE INDEX consultas_spin_legacy_unique
  ON consultas_spin (dentista_id, id_legacy_localstorage)
  WHERE id_legacy_localstorage IS NOT NULL;

CREATE INDEX idx_consultas_spin_dentista_data ON consultas_spin (dentista_id, created_at DESC);
CREATE INDEX idx_consultas_spin_lead          ON consultas_spin (lead_id)             WHERE lead_id          IS NOT NULL;
CREATE INDEX idx_consultas_spin_paciente      ON consultas_spin (paciente_id)          WHERE paciente_id      IS NOT NULL;
CREATE INDEX idx_consultas_spin_tipo          ON consultas_spin (tipo_tratamento_id)   WHERE tipo_tratamento_id IS NOT NULL;
CREATE INDEX idx_consultas_spin_analysis_gin  ON consultas_spin USING GIN (analysis);
CREATE INDEX idx_consultas_spin_nota          ON consultas_spin (nota_final)           WHERE nota_final       IS NOT NULL;

ALTER TABLE consultas_spin ENABLE ROW LEVEL SECURITY;

-- 'admin' pode gravar consulta de demo e ler de volta
CREATE POLICY "consultas_spin_select_own" ON consultas_spin FOR SELECT USING (
  dentista_id = auth.uid()
  AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles && ARRAY['dentista','admin'])
);
CREATE POLICY "consultas_spin_select_gestor" ON consultas_spin FOR SELECT USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles && ARRAY['gestor','admin'])
);
CREATE POLICY "consultas_spin_insert_own" ON consultas_spin FOR INSERT WITH CHECK (
  dentista_id = auth.uid()
  AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles && ARRAY['dentista','admin'])
);
CREATE POLICY "consultas_spin_update_own" ON consultas_spin FOR UPDATE
  USING     (dentista_id = auth.uid())
  WITH CHECK (dentista_id = auth.uid());
CREATE POLICY "consultas_spin_delete_admin" ON consultas_spin FOR DELETE USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles @> ARRAY['admin'])
);


-- ── 5. DENTISTA_PERFIL_SPIN ─────────────────────────────────────────────────

CREATE TABLE dentista_perfil_spin (
  dentista_id         uuid        PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  areas_fracas        text[],
  contexto_prompt     text        CHECK (contexto_prompt IS NULL OR char_length(contexto_prompt) <= 2000),
  insights_gestor     text        CHECK (insights_gestor IS NULL OR char_length(insights_gestor) <= 2000),
  insights_updated_at timestamptz,
  tokens_mes_atual    integer     NOT NULL DEFAULT 0,
  tokens_mes_ref      char(7)     NOT NULL DEFAULT to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM'),
  updated_at          timestamptz DEFAULT now()
);

ALTER TABLE dentista_perfil_spin ENABLE ROW LEVEL SECURITY;

CREATE POLICY "perfil_spin_select_own" ON dentista_perfil_spin FOR SELECT
  USING (dentista_id = auth.uid());
CREATE POLICY "perfil_spin_select_gestor" ON dentista_perfil_spin FOR SELECT USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles && ARRAY['gestor','admin'])
);
CREATE POLICY "perfil_spin_insert_own" ON dentista_perfil_spin FOR INSERT
  WITH CHECK (dentista_id = auth.uid());
CREATE POLICY "perfil_spin_update_own" ON dentista_perfil_spin FOR UPDATE
  USING     (dentista_id = auth.uid())
  WITH CHECK (dentista_id = auth.uid());
CREATE POLICY "perfil_spin_delete_admin" ON dentista_perfil_spin FOR DELETE USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles @> ARRAY['admin'])
);


-- ── 6. BENCHMARK_SPIN ───────────────────────────────────────────────────────

CREATE TABLE benchmark_spin (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  gerado_em      timestamptz NOT NULL DEFAULT now(),
  gerado_por     uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  periodo_inicio date        NOT NULL,
  periodo_fim    date        NOT NULL,
  resultado      jsonb,
  custo_usd      numeric(8,4),
  CONSTRAINT periodo_valido CHECK (periodo_inicio <= periodo_fim)
);

CREATE INDEX idx_benchmark_gerado_em ON benchmark_spin (gerado_em DESC);

ALTER TABLE benchmark_spin ENABLE ROW LEVEL SECURITY;

CREATE POLICY "benchmark_select_gestor" ON benchmark_spin FOR SELECT USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles && ARRAY['gestor','admin'])
);
CREATE POLICY "benchmark_insert_gestor" ON benchmark_spin FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles && ARRAY['gestor','admin'])
);
CREATE POLICY "benchmark_delete_admin" ON benchmark_spin FOR DELETE USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles @> ARRAY['admin'])
);


-- ── 7. BENCHMARK_SPIN_PLANOS ────────────────────────────────────────────────

CREATE TABLE benchmark_spin_planos (
  benchmark_id uuid NOT NULL REFERENCES benchmark_spin(id) ON DELETE CASCADE,
  dentista_id  uuid NOT NULL REFERENCES profiles(id)       ON DELETE CASCADE,
  plano        text NOT NULL,
  PRIMARY KEY (benchmark_id, dentista_id)
);

CREATE INDEX idx_benchmark_planos_dentista ON benchmark_spin_planos (dentista_id);

ALTER TABLE benchmark_spin_planos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "benchmark_planos_select_own" ON benchmark_spin_planos FOR SELECT
  USING (dentista_id = auth.uid());
CREATE POLICY "benchmark_planos_select_gestor" ON benchmark_spin_planos FOR SELECT USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles && ARRAY['gestor','admin'])
);
CREATE POLICY "benchmark_planos_insert_gestor" ON benchmark_spin_planos FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles && ARRAY['gestor','admin'])
);


-- ── 8. PACIENTES — colunas LGPD ─────────────────────────────────────────────
-- NULL = nunca perguntado; false = perguntado e recusado; true = consentiu.
-- Pacientes legados ficam NULL; UI exibe termo na próxima consulta gravada.

ALTER TABLE pacientes
  ADD COLUMN consentimento_gravacao         boolean,
  ADD COLUMN consentimento_gravacao_em      timestamptz,
  ADD COLUMN consentimento_gravacao_versao  text;


-- ── 9. FUNÇÕES ──────────────────────────────────────────────────────────────

-- Trigger: sincroniza nota_final desnormalizada a partir de analysis->>'nota_final'
CREATE OR REPLACE FUNCTION sync_consulta_spin_nota_final()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.analysis IS NOT NULL AND NEW.analysis ? 'nota_final' THEN
    NEW.nota_final := (NEW.analysis->>'nota_final')::numeric;
  END IF;
  RETURN NEW;
END $$;

-- Token counter: retorna tokens do mês corrente, tratando reset de mês e dentista sem linha.
-- COALESCE garante 0 para dentista sem linha em dentista_perfil_spin.
CREATE OR REPLACE FUNCTION tokens_efetivos_mes(p_dentista uuid)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT CASE
      WHEN tokens_mes_ref = to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM')
      THEN tokens_mes_atual
      ELSE 0
    END
    FROM dentista_perfil_spin
    WHERE dentista_id = p_dentista
  ), 0);
$$;

-- Dashboard KPI: SECURITY DEFINER para evitar N+1 RLS subqueries por linha.
-- Guard interno obrigatório: bypassa RLS, então checa role aqui dentro.
CREATE OR REPLACE FUNCTION dashboard_avaliacao_dentista(
  p_desde date DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date - 30,
  p_ate   date DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date
)
RETURNS TABLE (
  dentista_id        uuid,
  dentista_nome      text,
  total_consultas    bigint,
  nota_media         numeric,
  consultas_com_lead bigint,
  fechadas           bigint,
  taxa_fechamento    numeric,
  custo_total_usd    numeric
)
LANGUAGE plpgsql SECURITY DEFINER STABLE AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND roles && ARRAY['gestor','admin']
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    cs.dentista_id,
    p.nome,
    count(*)                                                AS total_consultas,
    round(avg(cs.nota_final)::numeric, 2)                   AS nota_media,
    count(*) FILTER (WHERE cs.lead_id IS NOT NULL)          AS consultas_com_lead,
    count(*) FILTER (WHERE l.status = 'Fechou')             AS fechadas,
    CASE WHEN count(*) FILTER (WHERE cs.lead_id IS NOT NULL) > 0
         THEN round(100.0 * count(*) FILTER (WHERE l.status = 'Fechou')
                        / count(*) FILTER (WHERE cs.lead_id IS NOT NULL), 1)
         ELSE NULL END                                      AS taxa_fechamento,
    round(sum((cs.uso->>'custo_usd')::numeric)::numeric, 4) AS custo_total_usd
  FROM consultas_spin cs
  LEFT JOIN leads l    ON l.id  = cs.lead_id
  LEFT JOIN profiles p ON p.id  = cs.dentista_id
  -- Filtro sargable (ativa idx_consultas_spin_dentista_data) com semântica de dia em fuso BR
  WHERE cs.created_at >= (p_desde::timestamp     AT TIME ZONE 'America/Sao_Paulo')
    AND cs.created_at <  ((p_ate + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
  GROUP BY cs.dentista_id, p.nome
  ORDER BY total_consultas DESC;
END $$;

-- Defesa em profundidade: retirar acesso de public, dar só a authenticated.
-- Guard interno (acima) impede uso por não-gestores mesmo via supabase.rpc().
REVOKE EXECUTE ON FUNCTION dashboard_avaliacao_dentista(date, date) FROM public;
GRANT  EXECUTE ON FUNCTION dashboard_avaliacao_dentista(date, date) TO authenticated;


-- ── 10. TRIGGERS ────────────────────────────────────────────────────────────

CREATE TRIGGER trg_sync_nota_final
  BEFORE INSERT OR UPDATE ON consultas_spin
  FOR EACH ROW EXECUTE FUNCTION sync_consulta_spin_nota_final();


-- ── 11. SEEDS ───────────────────────────────────────────────────────────────

INSERT INTO tipos_tratamento (id, nome) VALUES
  (1, 'Implante'),
  (2, 'Ortodontia'),
  (3, 'Prótese'),
  (4, 'Canal'),
  (5, 'Clareamento'),
  (6, 'Periodontia'),
  (7, 'Restauração')
ON CONFLICT (id) DO NOTHING;

INSERT INTO avaliacao_dentista_config (chave, valor) VALUES
  ('modulo_ativo',                         'false'),
  ('retencao_audio_dias',                  '365'),
  ('tokens_max_dentista_mes',              '5000000'),
  ('detalhar_max_por_dia',                 '20'),
  ('benchmark_max_por_dia',               '3'),
  ('termo_lgpd_versao_atual',              'v1-2026-05-24'),
  ('rate_limit_deepgram_token_por_hora',   '120')
ON CONFLICT (chave) DO NOTHING;


-- ── 12. BACKFILL profiles.roles ─────────────────────────────────────────────
-- Popula roles de profiles a partir de auth.users user_metadata / app_metadata.
-- Não sobrescreve array já preenchido; não sobrescreve por array vazio.

INSERT INTO profiles (id, nome, roles)
SELECT
  u.id,
  COALESCE(u.raw_user_meta_data->>'nome', u.email),
  ARRAY(
    SELECT jsonb_array_elements_text(
      COALESCE(u.raw_user_meta_data->'roles', u.raw_app_meta_data->'roles', '[]'::jsonb)
    )
  )
FROM auth.users u
LEFT JOIN profiles p ON p.id = u.id
WHERE p.id IS NULL
   OR p.roles IS NULL
   OR cardinality(p.roles) = 0
ON CONFLICT (id) DO UPDATE
  SET roles = EXCLUDED.roles
  WHERE (profiles.roles IS NULL OR cardinality(profiles.roles) = 0)
    AND cardinality(EXCLUDED.roles) > 0;
