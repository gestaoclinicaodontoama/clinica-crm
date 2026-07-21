ALTER TABLE public.plano_itens ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'clinicorp'
  CHECK (tipo IN ('clinicorp','externo'));
CREATE TABLE IF NOT EXISTS public.fases_externas_catalogo (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome text NOT NULL UNIQUE,
  ativo boolean NOT NULL DEFAULT true,
  criado_por uuid, criado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.fases_externas_catalogo ENABLE ROW LEVEL SECURITY;
INSERT INTO public.fases_externas_catalogo (nome) VALUES
  ('Tomografia'), ('Exames de sangue'), ('Avaliação médica / risco cirúrgico')
ON CONFLICT (nome) DO NOTHING;
