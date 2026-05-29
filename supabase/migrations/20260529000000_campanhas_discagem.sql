CREATE TABLE campanhas_discagem (
  id                 SERIAL PRIMARY KEY,
  tipo               TEXT NOT NULL CHECK (tipo IN ('abc','indicacoes','recentes','frios')),
  threec_campaign_id INTEGER NOT NULL,
  contatos_total     INTEGER NOT NULL DEFAULT 0,
  contatos_json      JSONB,
  status             TEXT NOT NULL DEFAULT 'ativa'
                     CHECK (status IN ('ativa','pausada','encerrada')),
  usuario_id         UUID REFERENCES auth.users(id),
  iniciada_em        TIMESTAMPTZ DEFAULT NOW(),
  pausada_em         TIMESTAMPTZ,
  encerrada_em       TIMESTAMPTZ
);

ALTER TABLE campanhas_discagem ENABLE ROW LEVEL SECURITY;

CREATE POLICY "campanhas_discagem_select" ON campanhas_discagem FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND (roles && ARRAY['crc_leads','crc_comercial','gestor','admin'])
  )
);

CREATE POLICY "campanhas_discagem_insert" ON campanhas_discagem FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND (roles && ARRAY['crc_leads','crc_comercial','gestor','admin'])
  )
);

CREATE POLICY "campanhas_discagem_update" ON campanhas_discagem FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND (roles && ARRAY['crc_leads','crc_comercial','gestor','admin'])
  )
);
