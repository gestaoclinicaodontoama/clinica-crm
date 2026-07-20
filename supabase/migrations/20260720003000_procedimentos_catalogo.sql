-- Catálogo de procedimentos da Clinicorp (nome por PriceId) — fonte de nome p/ planos
-- Aplicada REMOTO via MCP 2026-07-20. (o sync noturno já baixa o catálogo; agora persiste. Zero chamadas extras.)
CREATE TABLE IF NOT EXISTS procedimentos_catalogo (
  price_id text PRIMARY KEY,
  procedure_name text NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE procedimentos_catalogo ENABLE ROW LEVEL SECURITY;
