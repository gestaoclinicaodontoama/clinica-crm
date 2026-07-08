-- Fase 2: tema do post (alimenta a quebra "por tema" do Desempenho)
alter table public.sm_posts
  add column if not exists tema text
  check (tema in ('depoimento','educativo','oferta','bastidor','institucional'));
