-- 20260522000001_admin_confirm_on_create.sql
-- Garante que usuarios criados pelo painel admin ja nascem com email confirmado
-- Tambem adiciona funcao para confirmar usuarios existentes nao confirmados

-- Funcao para confirmar email de usuario pelo admin
CREATE OR REPLACE FUNCTION admin_confirm_user(
  p_admin_id uuid,
  p_email    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_admin_roles text[];
BEGIN
  SELECT roles INTO v_admin_roles FROM profiles WHERE id = p_admin_id;
  IF NOT (v_admin_roles @> ARRAY['admin']) THEN
    RETURN jsonb_build_object('error', 'Apenas admins podem confirmar usuarios');
  END IF;

  UPDATE auth.users
  SET email_confirmed_at = COALESCE(email_confirmed_at, now())
  WHERE email = p_email;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Usuario nao encontrado');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION admin_confirm_user(uuid, text) TO anon, authenticated;
