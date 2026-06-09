alter table public.mensagens
  add column if not exists editada_em timestamptz;
