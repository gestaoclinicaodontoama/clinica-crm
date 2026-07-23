-- Financeiro → Laboratórios (serviços protéticos). Aplicar REMOTO via MCP antes do deploy.
-- Fonte: notas dos 5 laboratórios (Ateliê Odonto, LAPROTEC, Dente & Arte, Búcio, Marcos Miranda).
-- A Clinicorp NÃO expõe o Controle Protético via API (401 com nosso token) — entrada é manual/importador IA.

CREATE TABLE IF NOT EXISTS protetico_notas (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  laboratorio text NOT NULL,
  referencia text NOT NULL,
  periodo_inicio date,
  periodo_fim date,
  emitida_em date,
  total_informado numeric(12,2),
  origem text NOT NULL DEFAULT 'import' CHECK (origem IN ('seed','import','manual')),
  criado_por text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (laboratorio, referencia)
);

CREATE TABLE IF NOT EXISTS protetico_itens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nota_id bigint NOT NULL REFERENCES protetico_notas(id) ON DELETE CASCADE,
  paciente_nome text NOT NULL,
  dentista_nome text,
  descricao_original text NOT NULL,
  categoria text NOT NULL,
  dente text,
  quantidade int NOT NULL DEFAULT 1 CHECK (quantidade > 0),
  valor_total numeric(12,2) NOT NULL,
  valor_unitario numeric(12,2) GENERATED ALWAYS AS (round(valor_total / quantidade, 2)) STORED,
  data_entrada date,
  data_prevista date,
  data_entrega date,
  atrasado boolean,
  reparo boolean NOT NULL DEFAULT false,
  conferir boolean NOT NULL DEFAULT false,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_protetico_itens_nota ON protetico_itens(nota_id);
CREATE INDEX IF NOT EXISTS idx_protetico_itens_datas ON protetico_itens(data_entrega, data_entrada);

CREATE TABLE IF NOT EXISTS protetico_categorias (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  padrao text NOT NULL UNIQUE,
  categoria text NOT NULL
);

ALTER TABLE protetico_notas ENABLE ROW LEVEL SECURITY;
ALTER TABLE protetico_itens ENABLE ROW LEVEL SECURITY;
ALTER TABLE protetico_categorias ENABLE ROW LEVEL SECURITY;

-- Data efetiva: entrega > entrada > emitida_em da nota (regra única — cards, matriz, séries, tabela)
CREATE OR REPLACE FUNCTION protetico_data_efetiva(i protetico_itens, n protetico_notas)
RETURNS date LANGUAGE sql IMMUTABLE AS
$$ SELECT COALESCE(i.data_entrega, i.data_entrada, n.emitida_em) $$;

CREATE OR REPLACE FUNCTION protetico_resumo(
  p_desde date DEFAULT NULL, p_ate date DEFAULT NULL,
  p_lab text DEFAULT NULL, p_categoria text DEFAULT NULL, p_dentista text DEFAULT NULL
) RETURNS jsonb LANGUAGE sql STABLE AS $$
WITH base AS (
  SELECT i.*, n.laboratorio, protetico_data_efetiva(i, n) AS data_ef
  FROM protetico_itens i JOIN protetico_notas n ON n.id = i.nota_id
  WHERE (p_desde IS NULL OR protetico_data_efetiva(i, n) >= p_desde)
    AND (p_ate   IS NULL OR protetico_data_efetiva(i, n) <= p_ate)
    AND (p_lab IS NULL OR n.laboratorio = p_lab)
    AND (p_categoria IS NULL OR i.categoria = p_categoria)
    AND (p_dentista IS NULL OR i.dentista_nome = p_dentista)
)
SELECT jsonb_build_object(
  'cards', (SELECT jsonb_build_object(
      'total', COALESCE(sum(valor_total),0),
      'itens', count(*),
      'ticket_medio', COALESCE(round(avg(valor_unitario) FILTER (WHERE valor_total > 0),2),0),
      'pct_atraso', round(100.0 * count(*) FILTER (WHERE atrasado) / NULLIF(count(*) FILTER (WHERE atrasado IS NOT NULL),0), 1),
      'pct_reparo', COALESCE(round(100.0 * count(*) FILTER (WHERE reparo) / NULLIF(count(*),0), 1),0)
    ) FROM base),
  'precos', COALESCE((SELECT jsonb_agg(row_to_json(p)) FROM (
      SELECT categoria, laboratorio,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY valor_unitario) AS mediana,
             count(*) AS n
      FROM base WHERE valor_total > 0 AND NOT reparo
      GROUP BY categoria, laboratorio ORDER BY categoria, laboratorio) p), '[]'::jsonb),
  'prazos', COALESCE((SELECT jsonb_agg(row_to_json(z)) FROM (
      SELECT laboratorio,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY (data_entrega - data_entrada)) AS dias_mediana,
             count(*) FILTER (WHERE data_entrega - data_entrada >= 60) AS itens_60d,
             round(100.0 * count(*) FILTER (WHERE atrasado) / NULLIF(count(*) FILTER (WHERE atrasado IS NOT NULL),0),1) AS pct_atraso,
             count(*) AS n
      FROM base WHERE data_entrega IS NOT NULL AND data_entrada IS NOT NULL
      GROUP BY laboratorio ORDER BY laboratorio) z), '[]'::jsonb),
  'dentistas', COALESCE((SELECT jsonb_agg(row_to_json(d)) FROM (
      SELECT COALESCE(dentista_nome,'(sem dentista)') AS dentista, sum(valor_total) AS total, count(*) AS n
      FROM base GROUP BY 1 ORDER BY 2 DESC) d), '[]'::jsonb),
  'mensal', COALESCE((SELECT jsonb_agg(row_to_json(m)) FROM (
      SELECT to_char(date_trunc('month', data_ef),'YYYY-MM') AS mes, laboratorio, sum(valor_total) AS total
      FROM base WHERE data_ef IS NOT NULL GROUP BY 1,2 ORDER BY 1,2) m), '[]'::jsonb),
  'labs', COALESCE((SELECT jsonb_agg(row_to_json(l)) FROM (
      SELECT laboratorio, sum(valor_total) AS total, count(*) AS n
      FROM base GROUP BY 1 ORDER BY 2 DESC) l), '[]'::jsonb)
);
$$;

REVOKE ALL ON FUNCTION protetico_resumo(date,date,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION protetico_resumo(date,date,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION protetico_data_efetiva(protetico_itens, protetico_notas) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION protetico_data_efetiva(protetico_itens, protetico_notas) TO service_role;
