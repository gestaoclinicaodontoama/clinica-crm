-- Pesquisa de Satisfação via WhatsApp Flow (spec 2026-07-17)
-- Uma linha por ENVIO; a resposta (nfm_reply) atualiza a mesma linha.
-- Linha "órfã" = resposta sem envio pendente (enviado_em/wa_id nulos).
CREATE TABLE public.pesquisas_satisfacao (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id bigint REFERENCES public.leads(id),
  paciente_clinicorp_id text,
  paciente_nome text,
  telefone text NOT NULL,
  dentista_nome text,
  origem text CHECK (origem IN ('tratamento','avaliacao')),
  enviado_em timestamptz,
  wa_id text,
  wa_id_resposta text,
  status text NOT NULL DEFAULT 'enviado' CHECK (status IN ('enviado','respondido','falhou')),
  erro text,
  respondido_em timestamptz,
  nps smallint,
  motivo_principal text,
  avaliacao_recepcao smallint,
  avaliacao_dentista smallint,
  avaliacao_espera smallint,
  avaliacao_limpeza smallint,
  avaliacao_explicacoes smallint,
  comentario text,
  resposta_raw jsonb,
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- Busca da resposta: envio pendente mais recente por telefone (webhook)
CREATE INDEX pesquisas_satisfacao_tel_idx ON public.pesquisas_satisfacao (telefone, status, enviado_em DESC);
-- Dedup 3 meses + listagens por período
CREATE INDEX pesquisas_satisfacao_env_idx ON public.pesquisas_satisfacao (enviado_em DESC);
-- Dedup de reentrega do webhook
CREATE UNIQUE INDEX pesquisas_satisfacao_waresp_uq ON public.pesquisas_satisfacao (wa_id_resposta) WHERE wa_id_resposta IS NOT NULL;
-- Ficha do paciente
CREATE INDEX pesquisas_satisfacao_pac_idx ON public.pesquisas_satisfacao (paciente_clinicorp_id);

-- Regra do projeto: RLS ligada, SEM policy (acesso só pelo servidor/service_role)
ALTER TABLE public.pesquisas_satisfacao ENABLE ROW LEVEL SECURITY;
