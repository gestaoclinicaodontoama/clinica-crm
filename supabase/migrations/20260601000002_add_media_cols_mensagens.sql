alter table public.mensagens
  add column if not exists tipo text not null default 'text',
  add column if not exists media_id text,
  add column if not exists mime text,
  add column if not exists media_filename text;

comment on column public.mensagens.tipo is 'text | audio | image | video | document | sticker';
comment on column public.mensagens.media_id is 'ID da midia na Meta Cloud API (proxy sob demanda)';
