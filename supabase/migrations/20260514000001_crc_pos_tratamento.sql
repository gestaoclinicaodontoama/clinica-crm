-- 20260514000001_crc_pos_tratamento.sql
-- Schema especifico do modulo CRC Pos Tratamento
-- NOTA: recall_logs.date_contato date adicionado (vs spec original que usava expressao ::date)
--       shared.js deve incluir date_contato: new Date().toISOString().slice(0,10) no INSERT
-- NOTA: RLS usa profiles.roles (Auth Hook pendente de configuracao no dashboard Supabase)

-- 1. UNIQUE index em date_contato (coluna ja criada em 000000)
CREATE UNIQUE INDEX IF NOT EXISTS recall_logs_paciente_tipo_date_uniq ON recall_logs (paciente_id, tipo, date_contato);

-- 2. vip no CHECK de tipo
ALTER TABLE recall_logs DROP CONSTRAINT IF EXISTS recall_logs_tipo_check;
ALTER TABLE recall_logs ADD CONSTRAINT recall_logs_tipo_check
  CHECK (tipo IN ('aniversario','recall_180','recall_360','vip'));

-- 3. mensagens_padrao_crc
CREATE TABLE mensagens_padrao_crc (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  chave          text        NOT NULL UNIQUE CHECK (chave IN ('aniversario','recall','vip')),
  corpo          text        NOT NULL,
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  atualizado_por uuid        REFERENCES profiles(id)
);
ALTER TABLE mensagens_padrao_crc ENABLE ROW LEVEL SECURITY;
CREATE POLICY "select_mensagens_padrao" ON mensagens_padrao_crc FOR SELECT USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (roles && ARRAY['crc_pos','gestor','admin']))
);
CREATE POLICY "update_mensagens_padrao" ON mensagens_padrao_crc FOR UPDATE
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (roles && ARRAY['crc_pos','gestor','admin'])))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (roles && ARRAY['crc_pos','gestor','admin'])));

-- 4. Trigger: protege chave + atualiza atualizado_em
CREATE OR REPLACE FUNCTION mensagens_padrao_crc_protect_chave() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.chave <> OLD.chave THEN RAISE EXCEPTION 'mensagens_padrao_crc.chave nao pode ser alterada apos criacao'; END IF;
  NEW.atualizado_em := now(); RETURN NEW;
END; $$;
CREATE TRIGGER trg_mensagens_padrao_protect BEFORE UPDATE ON mensagens_padrao_crc
  FOR EACH ROW EXECUTE FUNCTION mensagens_padrao_crc_protect_chave();

-- 5. Trigger: audit_log
CREATE OR REPLACE FUNCTION mensagens_padrao_crc_audit() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO audit_log (tabela, registro_id, acao, actor_id, source, dados_antes, dados_depois)
  VALUES ('mensagens_padrao_crc', OLD.id, 'UPDATE', auth.uid(), 'frontend', to_jsonb(OLD), to_jsonb(NEW));
  RETURN NULL;
END; $$;
CREATE TRIGGER trg_mensagens_padrao_audit AFTER UPDATE ON mensagens_padrao_crc
  FOR EACH ROW EXECUTE FUNCTION mensagens_padrao_crc_audit();

-- 6. Helpers IMMUTABLE para index funcional
CREATE OR REPLACE FUNCTION pac_mes_nasc(d date) RETURNS int LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT date_part('month', d)::int; $$;
CREATE OR REPLACE FUNCTION pac_dia_nasc(d date) RETURNS int LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT date_part('day', d)::int; $$;

-- 7. Index birthday_window
CREATE INDEX idx_pac_nasc_mes_dia ON pacientes (pac_mes_nasc(data_nascimento), pac_dia_nasc(data_nascimento))
  WHERE data_nascimento IS NOT NULL;

-- 8. RPC birthday_window
CREATE OR REPLACE FUNCTION birthday_window(offset_start int, offset_end int)
RETURNS TABLE (paciente_id uuid, nome text, data_nascimento date, telefone_celular text,
  classe text, qtd_comparecimentos int, ultima_visita date, proxima_consulta date,
  dias_sem_visita int, mes_nasc int, dia_nasc int)
LANGUAGE sql SECURITY INVOKER STABLE AS $$
  SELECT p.id, p.nome, p.data_nascimento, p.telefone_celular,
    pa.classe::text, pa.qtd_comparecimentos, pa.ultima_visita, pa.proxima_consulta,
    pa.dias_sem_visita, pac_mes_nasc(p.data_nascimento), pac_dia_nasc(p.data_nascimento)
  FROM pacientes p JOIN pacientes_abc pa ON pa.paciente_id = p.id
  WHERE p.data_nascimento IS NOT NULL
    AND (pac_mes_nasc(p.data_nascimento), pac_dia_nasc(p.data_nascimento))
    IN (SELECT date_part('month',(CURRENT_DATE+s))::int, date_part('day',(CURRENT_DATE+s))::int
        FROM generate_series(offset_start, offset_end) s);
$$;

-- 9. Seed templates
INSERT INTO mensagens_padrao_crc (chave, corpo) VALUES
  ('aniversario','Ola {nome}! A equipe da Clinica AMA deseja um feliz aniversario! Que seja um dia muito especial. Ficamos a disposicao para o que precisar.'),
  ('recall','Ola {nome}, tudo bem? Sou da Clinica AMA e notamos que faz um tempo que nao te vemos por aqui. Que tal marcarmos uma consulta de retorno? Temos horarios disponiveis essa semana!'),
  ('vip','Ola {nome}! A equipe da Clinica AMA esta entrando em contato para saber como voce esta e se podemos ajuda-lo com algo. Sera que conseguimos um horario esta semana?')
ON CONFLICT (chave) DO NOTHING;