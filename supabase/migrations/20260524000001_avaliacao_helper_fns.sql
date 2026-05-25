-- 20260524000001_avaliacao_helper_fns.sql
-- Funções auxiliares para rotas de Avaliação Dentista (rate limit atômico + token counter)

-- Rate limit atômico: retorna contador se permitido, NULL se bloqueado.
-- O WHERE condicional no ON CONFLICT faz o INSERT tornar-se DO NOTHING quando bloqueado,
-- resultando em NULL no RETURNING.
CREATE OR REPLACE FUNCTION check_and_increment_rate_limit(
  p_chave   text,
  p_max     integer,
  p_expira  timestamptz
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_contador integer;
BEGIN
  DELETE FROM rate_limits WHERE chave = p_chave AND expira_em < now();

  INSERT INTO rate_limits (chave, contador, expira_em)
    VALUES (p_chave, 1, p_expira)
  ON CONFLICT (chave) DO UPDATE
    SET contador = rate_limits.contador + 1
  WHERE rate_limits.expira_em > now()
    AND rate_limits.contador  < p_max
  RETURNING contador INTO v_contador;

  RETURN v_contador;
END $$;

REVOKE EXECUTE ON FUNCTION check_and_increment_rate_limit(text, integer, timestamptz) FROM public;
GRANT  EXECUTE ON FUNCTION check_and_increment_rate_limit(text, integer, timestamptz) TO service_role;

-- Token counter: upsert condicional que soma no mês atual ou reseta se mês mudou.
CREATE OR REPLACE FUNCTION increment_token_counter(p_dentista uuid, p_tokens integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_mes char(7) := to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM');
BEGIN
  INSERT INTO dentista_perfil_spin (dentista_id, tokens_mes_ref, tokens_mes_atual, updated_at)
    VALUES (p_dentista, v_mes, p_tokens, now())
  ON CONFLICT (dentista_id) DO UPDATE
    SET tokens_mes_ref   = v_mes,
        tokens_mes_atual = CASE
          WHEN dentista_perfil_spin.tokens_mes_ref = v_mes
          THEN dentista_perfil_spin.tokens_mes_atual + p_tokens
          ELSE p_tokens
        END,
        updated_at = now();
END $$;

REVOKE EXECUTE ON FUNCTION increment_token_counter(uuid, integer) FROM public;
GRANT  EXECUTE ON FUNCTION increment_token_counter(uuid, integer) TO service_role;
