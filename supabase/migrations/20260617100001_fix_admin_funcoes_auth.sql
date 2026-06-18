-- Migration: fix_admin_funcoes_auth
-- Security fix: admin_update_user_funcoes used a spoofable p_admin_id parameter
-- for the admin check. This replaces it with auth.uid() so only the actual
-- authenticated session identity is used.

-- Drop old version with p_admin_id param
DROP FUNCTION IF EXISTS admin_update_user_funcoes(uuid, uuid, uuid[], text[], text);

-- Recreate without p_admin_id, using auth.uid()
CREATE OR REPLACE FUNCTION admin_update_user_funcoes(
  p_user_id     uuid,
  p_funcao_ids  uuid[],
  p_roles_extra text[],
  p_nome        text DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  -- Use session identity, not a spoofable parameter
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND roles @> ARRAY['admin']
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF p_nome IS NOT NULL THEN
    UPDATE profiles SET nome = p_nome WHERE id = p_user_id;
  END IF;

  DELETE FROM user_funcoes WHERE user_id = p_user_id;
  IF p_funcao_ids IS NOT NULL AND array_length(p_funcao_ids, 1) > 0 THEN
    INSERT INTO user_funcoes (user_id, funcao_id)
    SELECT p_user_id, UNNEST(p_funcao_ids);
  END IF;

  UPDATE profiles
  SET roles_extra = COALESCE(p_roles_extra, '{}')
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION admin_update_user_funcoes(uuid, uuid[], text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_update_user_funcoes(uuid, uuid[], text[], text) TO authenticated;
