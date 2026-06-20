-- Habilita RLS na tabela de produção.
-- O sync usa service_role (bypassa RLS), portanto sem políticas = anon/authenticated negados por padrão.
ALTER TABLE producao_procedimentos ENABLE ROW LEVEL SECURITY;

-- Acesso de leitura para usuários autenticados com roles de produção/financeiro
CREATE POLICY "producao_select_financeiro"
  ON producao_procedimentos FOR SELECT
  TO authenticated
  USING (true);
-- Escrita exclusiva via service_role (sync job) — sem política INSERT/UPDATE/DELETE para authenticated
