-- 20260514000000_crc_pos_base_tables.sql
-- Tabelas base para o modulo CRC Pos Tratamento
-- RLS usa profiles.roles (Auth Hook ainda nao configurado)

-- 1. PACIENTES
CREATE TABLE pacientes (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinicorp_id     bigint      UNIQUE,
  nome             text        NOT NULL,
  data_nascimento  date        CHECK (data_nascimento IS NULL OR (data_nascimento < CURRENT_DATE AND data_nascimento >= '1920-01-01')),
  telefone_celular text,
  telefone_fixo    text,
  email            text,
  cidade           text,
  estado           text,
  bairro           text,
  como_conheceu    text,
  plano_saude      text,
  ativo            boolean     DEFAULT true,
  inserido_em      timestamptz,
  criado_em        timestamptz DEFAULT now(),
  atualizado_em    timestamptz DEFAULT now()
);
ALTER TABLE pacientes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pacientes_select" ON pacientes FOR SELECT USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (roles && ARRAY['crc_pos','crc_sucesso','gestor','admin']))
);
CREATE POLICY "pacientes_delete_admin" ON pacientes FOR DELETE USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles @> ARRAY['admin'])
);

-- 2. PACIENTES_ABC
CREATE TABLE pacientes_abc (
  id                   uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  paciente_id          uuid    UNIQUE REFERENCES pacientes(id) ON DELETE CASCADE,
  clinicorp_id         bigint  NOT NULL,
  nome                 text,
  telefone             text,
  total_receita        numeric,
  ultima_visita        date,
  ultimo_pagamento     date,
  qtd_procedimentos    int,
  qtd_comparecimentos  int,
  classe               char(1),
  pct_acumulado        numeric,
  proxima_consulta     date,
  proximo_dentista     text,
  dias_sem_visita      int,
  sincronizado_em      timestamptz
);
ALTER TABLE pacientes_abc ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pacientes_abc_select" ON pacientes_abc FOR SELECT USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (roles && ARRAY['crc_pos','crc_sucesso','gestor','admin']))
);
CREATE POLICY "pacientes_abc_delete_admin" ON pacientes_abc FOR DELETE USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles @> ARRAY['admin'])
);

-- 3. RECALL_LOGS
CREATE TABLE recall_logs (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  paciente_id    uuid        REFERENCES pacientes(id),
  tipo           text        CHECK (tipo IN ('aniversario','recall_180','recall_360')),
  contactado_por uuid        REFERENCES profiles(id),
  canal          text        CHECK (canal IN ('whatsapp','ligacao','outro')) DEFAULT 'whatsapp',
  data_contato   timestamptz DEFAULT now(),
  date_contato   date        NOT NULL DEFAULT CURRENT_DATE,
  mensagem_id    uuid,
  status_envio   text        CHECK (status_envio IN ('pendente','enviado','falha')) DEFAULT 'enviado',
  obs            text
);
ALTER TABLE recall_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "recall_logs_select" ON recall_logs FOR SELECT USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (roles && ARRAY['crc_pos','gestor','admin']))
);
CREATE POLICY "recall_logs_insert" ON recall_logs FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (roles && ARRAY['crc_pos','gestor','admin']))
);
CREATE POLICY "recall_logs_update" ON recall_logs FOR UPDATE USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (roles && ARRAY['crc_pos','gestor','admin']))
);
CREATE POLICY "recall_logs_delete_admin" ON recall_logs FOR DELETE USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles @> ARRAY['admin'])
);

-- 4. AUDIT_LOG
CREATE TABLE audit_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tabela       text,
  registro_id  uuid,
  acao         text        CHECK (acao IN ('INSERT','UPDATE','DELETE')),
  actor_id     uuid        REFERENCES profiles(id),
  source       text        CHECK (source IN ('frontend','webhook','cron','trigger')),
  dados_antes  jsonb,
  dados_depois jsonb,
  ip           text,
  criado_em    timestamptz DEFAULT now()
);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_log_select" ON audit_log FOR SELECT USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (roles && ARRAY['admin','gestor']))
  OR actor_id = auth.uid()
);

-- 5. VIP_PACIENTES
CREATE TABLE vip_pacientes (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  paciente_id    uuid        REFERENCES pacientes(id),
  adicionado_por uuid        REFERENCES profiles(id),
  adicionado_em  timestamptz DEFAULT now(),
  obs            text        CHECK (obs IS NULL OR char_length(obs) <= 500)
);
ALTER TABLE vip_pacientes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vip_select" ON vip_pacientes FOR SELECT USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (roles && ARRAY['crc_pos','gestor','admin']))
);
CREATE POLICY "vip_insert" ON vip_pacientes FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (roles && ARRAY['crc_pos','gestor','admin']))
);
CREATE POLICY "vip_update" ON vip_pacientes FOR UPDATE USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (roles && ARRAY['crc_pos','gestor','admin']))
);
CREATE POLICY "vip_delete" ON vip_pacientes FOR DELETE USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (roles && ARRAY['crc_pos','gestor','admin']))
);

-- 6. INDEXES
CREATE INDEX idx_abc_classe_dias       ON pacientes_abc(classe, dias_sem_visita);
CREATE INDEX idx_abc_proxima_consulta  ON pacientes_abc(proxima_consulta);
CREATE INDEX idx_pacientes_nascimento  ON pacientes(data_nascimento);
CREATE INDEX idx_pacientes_telefone    ON pacientes(telefone_celular);
CREATE INDEX idx_vip_paciente          ON vip_pacientes(paciente_id);
CREATE INDEX idx_recall_logs_paciente  ON recall_logs(paciente_id, data_contato);
CREATE INDEX idx_recall_logs_tipo_data ON recall_logs(tipo, data_contato);