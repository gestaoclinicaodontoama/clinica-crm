-- ====== SISTEMA DE FUNÇÕES (RBAC) ======

-- 1. Tabela de funções (cargos)
CREATE TABLE funcoes (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome  text NOT NULL,
  roles text[] NOT NULL DEFAULT '{}'
);

-- 2. Atribuição usuário ↔ funções (N:N)
CREATE TABLE user_funcoes (
  user_id   uuid REFERENCES profiles(id) ON DELETE CASCADE,
  funcao_id uuid REFERENCES funcoes(id)  ON DELETE CASCADE,
  PRIMARY KEY (user_id, funcao_id)
);

-- 3. Permissões individuais por usuário (além das funções)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS roles_extra text[] NOT NULL DEFAULT '{}';

-- 4. Migração: preservar roles existentes em roles_extra
--    (antes dos triggers, para não disparar recálculo desnecessário)
UPDATE profiles SET roles_extra = roles
WHERE roles IS NOT NULL AND array_length(roles, 1) > 0;

-- 5. Função de recálculo: profiles.roles = union(funcoes.roles) ∪ roles_extra
CREATE OR REPLACE FUNCTION recalculate_user_roles(p_user_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE profiles SET roles = (
    SELECT COALESCE(ARRAY_AGG(DISTINCT r), '{}')
    FROM (
      SELECT UNNEST(f.roles) AS r
      FROM funcoes f
      JOIN user_funcoes uf ON uf.funcao_id = f.id
      WHERE uf.user_id = p_user_id
      UNION
      SELECT UNNEST(p.roles_extra)
      FROM profiles p WHERE p.id = p_user_id
    ) sub
  )
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. Trigger: atribuição de função ao usuário mudou
CREATE OR REPLACE FUNCTION trg_user_funcoes_changed()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM recalculate_user_roles(OLD.user_id);
  ELSE
    PERFORM recalculate_user_roles(NEW.user_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_user_funcoes
AFTER INSERT OR UPDATE OR DELETE ON user_funcoes
FOR EACH ROW EXECUTE FUNCTION trg_user_funcoes_changed();

-- 7. Trigger: roles de uma função foram editadas → atualiza TODOS os usuários dela
CREATE OR REPLACE FUNCTION trg_funcao_roles_changed()
RETURNS trigger AS $$
DECLARE
  uid uuid;
BEGIN
  FOR uid IN
    SELECT user_id FROM user_funcoes WHERE funcao_id = NEW.id
  LOOP
    PERFORM recalculate_user_roles(uid);
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_funcao_roles
AFTER UPDATE OF roles ON funcoes
FOR EACH ROW EXECUTE FUNCTION trg_funcao_roles_changed();

-- 8. Trigger: roles_extra de um usuário foi editado → recalcula
CREATE OR REPLACE FUNCTION trg_profile_roles_extra_changed()
RETURNS trigger AS $$
BEGIN
  PERFORM recalculate_user_roles(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profile_roles_extra
AFTER UPDATE OF roles_extra ON profiles
FOR EACH ROW EXECUTE FUNCTION trg_profile_roles_extra_changed();

-- 9. RPC para admin atualizar funcoes + roles_extra de um usuário (em transação)
CREATE OR REPLACE FUNCTION admin_update_user_funcoes(
  p_admin_id    uuid,
  p_user_id     uuid,
  p_funcao_ids  uuid[],
  p_roles_extra text[],
  p_nome        text DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_admin_id AND roles @> ARRAY['admin']
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Atualiza nome se fornecido
  IF p_nome IS NOT NULL THEN
    UPDATE profiles SET nome = p_nome WHERE id = p_user_id;
  END IF;

  -- Substitui funções do usuário
  DELETE FROM user_funcoes WHERE user_id = p_user_id;
  IF p_funcao_ids IS NOT NULL AND array_length(p_funcao_ids, 1) > 0 THEN
    INSERT INTO user_funcoes (user_id, funcao_id)
    SELECT p_user_id, UNNEST(p_funcao_ids);
  END IF;

  -- Atualiza roles_extra → trigger recalcula profiles.roles automaticamente
  UPDATE profiles
  SET roles_extra = COALESCE(p_roles_extra, '{}')
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 10. RLS para funcoes
ALTER TABLE funcoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "funcoes_select_authenticated" ON funcoes
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "funcoes_admin_write" ON funcoes
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles @> ARRAY['admin']))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles @> ARRAY['admin']));

-- 11. RLS para user_funcoes
ALTER TABLE user_funcoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_funcoes_select_authenticated" ON user_funcoes
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "user_funcoes_admin_write" ON user_funcoes
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles @> ARRAY['admin']))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND roles @> ARRAY['admin']));
