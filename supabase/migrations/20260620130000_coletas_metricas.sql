-- Coletas de Métricas (Sub-projeto 1)

-- task_templates: tipo + definição da coleta
alter table public.task_templates add column if not exists tipo text not null default 'tarefa';
alter table public.task_templates add column if not exists metricas jsonb;
alter table public.task_templates add column if not exists conversoes jsonb;
alter table public.task_templates add column if not exists periodos jsonb;
alter table public.task_templates add column if not exists ver_proprio boolean not null default false;
alter table public.task_templates drop constraint if exists task_templates_tipo_check;
alter table public.task_templates add constraint task_templates_tipo_check
  check (tipo in ('tarefa', 'coleta'));

-- tasks: valores preenchidos + período + origem
alter table public.tasks add column if not exists valores jsonb;
alter table public.tasks add column if not exists periodo text;
alter table public.tasks add column if not exists origem text;

-- Evita cards de coleta duplicados por período (corrige corrida de geração)
create unique index if not exists tasks_coleta_periodo_uniq
  on public.tasks (template_id, assignee_id, data_ref, periodo)
  where periodo is not null;

-- Soma genérica de campos numéricos do jsonb `valores` (ignora texto via regex).
-- Total geral por métrica, no período, opcionalmente filtrado por pessoa.
create or replace function public.coleta_totais(
  p_template_id uuid, p_de date, p_ate date, p_pessoa uuid default null
) returns table(chave text, total numeric)
language sql stable as $$
  select e.key as chave, sum((e.value)::numeric) as total
  from public.tasks t
  cross join lateral jsonb_each_text(coalesce(t.valores, '{}'::jsonb)) as e(key, value)
  where t.template_id = p_template_id
    and t.data_ref between p_de and p_ate
    and t.periodo is not null
    and (p_pessoa is null or t.assignee_id = p_pessoa)
    and e.value ~ '^-?[0-9]+(\.[0-9]+)?$'
  group by e.key;
$$;

-- Total por pessoa e métrica (para a tabela "por pessoa").
create or replace function public.coleta_por_pessoa(
  p_template_id uuid, p_de date, p_ate date
) returns table(assignee_id uuid, chave text, total numeric)
language sql stable as $$
  select t.assignee_id, e.key as chave, sum((e.value)::numeric) as total
  from public.tasks t
  cross join lateral jsonb_each_text(coalesce(t.valores, '{}'::jsonb)) as e(key, value)
  where t.template_id = p_template_id
    and t.data_ref between p_de and p_ate
    and t.periodo is not null
    and e.value ~ '^-?[0-9]+(\.[0-9]+)?$'
  group by t.assignee_id, e.key;
$$;

-- Série temporal por bucket (dia/semana) e métrica (para o gráfico de evolução).
create or replace function public.coleta_serie(
  p_template_id uuid, p_de date, p_ate date, p_pessoa uuid default null, p_gran text default 'dia'
) returns table(bucket date, chave text, total numeric)
language sql stable as $$
  select date_trunc(case when p_gran = 'semana' then 'week' else 'day' end, t.data_ref)::date as bucket,
         e.key as chave, sum((e.value)::numeric) as total
  from public.tasks t
  cross join lateral jsonb_each_text(coalesce(t.valores, '{}'::jsonb)) as e(key, value)
  where t.template_id = p_template_id
    and t.data_ref between p_de and p_ate
    and t.periodo is not null
    and (p_pessoa is null or t.assignee_id = p_pessoa)
    and e.value ~ '^-?[0-9]+(\.[0-9]+)?$'
  group by 1, e.key
  order by 1;
$$;
