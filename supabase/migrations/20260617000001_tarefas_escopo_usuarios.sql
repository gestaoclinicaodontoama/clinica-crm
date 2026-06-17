-- Adiciona suporte a rotinas por pessoas específicas

alter table public.task_templates
  add column if not exists assignee_ids jsonb;

-- Atualiza constraint de escopo
alter table public.task_templates
  drop constraint if exists task_templates_escopo_check;

alter table public.task_templates
  add constraint task_templates_escopo_check
  check (escopo in ('role', 'pessoal', 'usuarios'));

-- Atualiza constraint composta
alter table public.task_templates
  drop constraint if exists task_templates_check;

alter table public.task_templates
  add constraint task_templates_check
  check (
    (escopo = 'role'     and role          is not null) or
    (escopo = 'pessoal'  and owner_id      is not null) or
    (escopo = 'usuarios' and assignee_ids  is not null)
  );
