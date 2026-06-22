CREATE TABLE producao_imposto_aliquota (
  ano           int PRIMARY KEY,
  aliquota      numeric(5,2) NOT NULL CHECK (aliquota >= 0 AND aliquota <= 100),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
