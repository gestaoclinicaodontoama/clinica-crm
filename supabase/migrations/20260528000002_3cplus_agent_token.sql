-- Adiciona colunas para token e ramal do agente 3cplus por CRC
-- O token é do próprio agente (diferente do token gestor em THREEC_TOKEN env var)
-- Dados inseridos via SQL direto (não no git por segurança)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS threec_agent_token TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS threec_agent_ramal TEXT;
