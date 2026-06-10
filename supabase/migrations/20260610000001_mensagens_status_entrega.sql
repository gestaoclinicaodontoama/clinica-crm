-- Status de entrega do WhatsApp (webhook statuses: sent/delivered/read/failed).
-- "failed" é a única forma de saber que a Meta descartou uma mensagem aceita
-- pela API (ex.: erro 131047 — fora da janela de 24h).
alter table public.mensagens
  add column if not exists wa_status text,
  add column if not exists wa_erro text;

-- O webhook atualiza o status localizando a mensagem pelo wa_id
create index if not exists mensagens_wa_id_idx
  on public.mensagens (wa_id) where wa_id <> '';
