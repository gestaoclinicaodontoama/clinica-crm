-- Central de Tarefas: moldes de rotina + ocorrências
create table if not exists public.task_templates (
  id            uuid primary key default gen_random_uuid(),
  titulo        text not null,
  descricao     text,
  escopo        text not null check (escopo in ('role','pessoal')),
  role          text,
  owner_id      uuid references auth.users(id) on delete cascade,
  frequencia    text not null check (frequencia in ('diaria','semanal','mensal')),
  dias_semana   int[],
  dia_mes       int check (dia_mes between 1 and 31),
  hora_sugerida time,
  prioridade    text not null default 'normal' check (prioridade in ('alta','normal','baixa')),
  categoria     text,
  tipo_resultado text not null default 'check' check (tipo_resultado in ('check','numero')),
  unidade       text,
  meta          numeric,
  arrasta       boolean not null default false,
  ativo         boolean not null default true,
  created_by    uuid not null,
  created_at    timestamptz not null default now(),
  check ((escopo = 'role' and role is not null) or (escopo = 'pessoal' and owner_id is not null))
);

create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  titulo        text not null,
  descricao     text,
  tipo          text not null check (tipo in ('rotina','pontual')),
  template_id   uuid references public.task_templates(id) on delete set null,
  data_ref      date not null,
  assignee_id   uuid not null,
  created_by    uuid not null,
  prioridade    text not null default 'normal' check (prioridade in ('alta','normal','baixa')),
  categoria     text,
  tipo_resultado text not null default 'check' check (tipo_resultado in ('check','numero')),
  unidade       text,
  meta          numeric,
  valor_resultado numeric,
  prazo         timestamptz,
  lead_id       bigint references public.leads(id) on delete set null,
  paciente_clinicorp_id text,
  arrasta       boolean not null default false,
  status        text not null default 'pendente' check (status in ('pendente','concluida')),
  concluida_em  timestamptz,
  concluida_por uuid,
  obs_conclusao text,
  visto_em      timestamptz,
  prazo_avisado_em timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists idx_tasks_assignee_dataref on public.tasks(assignee_id, data_ref, status);
create index if not exists idx_tasks_status_prazo on public.tasks(status, prazo);
create index if not exists idx_tasks_template_open on public.tasks(template_id, assignee_id, status);

alter table public.task_templates enable row level security;
alter table public.tasks          enable row level security;

-- Permite o tipo de notificação de resumo diário (sininho)
alter table public.notificacoes drop constraint if exists notificacoes_tipo_check;
alter table public.notificacoes add constraint notificacoes_tipo_check
  check (tipo = any (array['visita_lead','tarefa_atribuida','tarefa_vencendo','tarefa_resumo','sistema','conferencia_pendente']));
