-- ④ Tracker do paciente: link público tokenizado por plano. Sem tabela nova (RLS já ligada).
ALTER TABLE public.plano_tratamento ADD COLUMN IF NOT EXISTS tracker_token text;
ALTER TABLE public.plano_tratamento ADD COLUMN IF NOT EXISTS tracker_revogado_em timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS idx_plano_tracker_token ON public.plano_tratamento(tracker_token) WHERE tracker_token IS NOT NULL;
