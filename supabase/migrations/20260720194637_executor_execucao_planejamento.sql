-- Executor por procedimento + gancho "anotar na ficha" (robô Clinicorp futuro).
-- Sem tabela nova: RLS já ligada em plano_itens/plano_etapas (migração 20260719042125).
ALTER TABLE public.plano_itens  ADD COLUMN IF NOT EXISTS profissional_executor text;
ALTER TABLE public.plano_etapas ADD COLUMN IF NOT EXISTS ficha_anotar boolean NOT NULL DEFAULT false;
ALTER TABLE public.plano_etapas ADD COLUMN IF NOT EXISTS ficha_escrita_em timestamptz;
