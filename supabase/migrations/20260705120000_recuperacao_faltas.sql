-- Recuperação de falta (spec 2026-07-05). Tabela de controle + RPCs de matching.
create table if not exists public.recuperacao_faltas (
  id bigserial primary key,
  clinicorp_appt_id text unique not null,
  patient_name text,
  category text,
  dentist_name text,
  appointment_date date,
  telefone text,
  lead_id bigint references public.leads(id),
  crc_responsavel_id uuid references public.profiles(id),
  status text not null default 'aberta',   -- aberta | recuperada | perdida | encerrada
  toques_enviados int not null default 0,
  ultimo_toque_em timestamptz,
  task_id uuid references public.tasks(id),   -- tasks.id é uuid (brief dizia bigint; corrigido p/ casar a FK)
  criada_em timestamptz not null default now(),
  recuperada_em timestamptz
);
alter table public.recuperacao_faltas enable row level security;
-- leitura p/ papéis internos (mesmo padrão das outras tabelas do CRM)
drop policy if exists recuperacao_faltas_read on public.recuperacao_faltas;
create policy recuperacao_faltas_read on public.recuperacao_faltas for select using (auth.role() = 'authenticated');

-- normaliza telefone (só dígitos, últimos 8) — casa lead por sufixo
create or replace function public._sufixo8(t text) returns text
language sql immutable as $$ select right(regexp_replace(coalesce(t,''),'\D','','g'), 8) $$;

-- Faltas de avaliação novas (não presentes em recuperacao_faltas), enriquecidas.
create or replace function public.detectar_faltas_avaliacao(dias int default 30)
returns table(clinicorp_appt_id text, patient_name text, category text, dentist_name text,
              appointment_date date, telefone text, lead_id bigint, crc_agendamento_id uuid)
language sql stable as $$
  with faltas as (
    select a.clinicorp_appt_id, a.patient_name, a.category, a.dentist_name, a.appointment_date
    from agenda_appointments a
    where a.appointment_date < current_date
      and a.appointment_date >= current_date - dias
      and not a.deleted
      and (a.checkin_time is null or a.checkin_time = '')
      and a.category ilike 'Avalia%'
      and not exists (select 1 from recuperacao_faltas r where r.clinicorp_appt_id = a.clinicorp_appt_id)
  ),
  comtel as (
    select f.*,
      (select regexp_replace(p.telefone_celular,'\D','','g') from pacientes p
       where lower(trim(p.nome)) = lower(trim(f.patient_name)) and coalesce(p.telefone_celular,'') <> '' limit 1) as tel
    from faltas f
  )
  select c.clinicorp_appt_id, c.patient_name, c.category, c.dentist_name, c.appointment_date,
    c.tel as telefone,
    l.id as lead_id,
    l.crc_agendamento_id
  from comtel c
  left join lateral (
    select id, crc_agendamento_id from leads l2
    where c.tel is not null and public._sufixo8(l2.telefone) = public._sufixo8(c.tel)
    order by id desc limit 1
  ) l on true;
$$;

-- Recuperada? consulta posterior com check-in OU futura marcada OU lead avançou.
create or replace function public.falta_esta_recuperada(p_appt_id text)
returns boolean language sql stable as $$
  with r as (select * from recuperacao_faltas where clinicorp_appt_id = p_appt_id)
  select coalesce((
    -- consulta posterior à falta: com check-in (voltou) ou futura (remarcou)
    exists (
      select 1 from agenda_appointments a, r
      where lower(trim(a.patient_name)) = lower(trim(r.patient_name))
        and not a.deleted
        and a.appointment_date > r.appointment_date
        and ((a.checkin_time is not null and a.checkin_time <> '') or a.appointment_date >= current_date)
    )
    or exists (
      select 1 from leads l, r
      where l.id = r.lead_id and l.status in ('Compareceu','Em negociação','Fechou')
    )
  ), false);
$$;

-- Append idempotente de etiqueta no lead.
create or replace function public.lead_add_etiqueta(p_lead_id bigint, p_tag text)
returns void language sql as $$
  update leads set etiquetas =
    (select array(select distinct e from unnest(coalesce(etiquetas,'{}') || array[p_tag]) e))
  where id = p_lead_id and not (coalesce(etiquetas,'{}') @> array[p_tag]);
$$;

-- Config
alter table app_config
  add column if not exists recuperacao_falta_crc_leads jsonb,
  add column if not exists recuperacao_falta_crc_pos uuid,
  add column if not exists recuperacao_falta_rodizio_idx int default 0;

update app_config set recuperacao_falta_crc_leads = (
  select coalesce(jsonb_agg(id order by nome), '[]'::jsonb) from profiles
  where roles @> array['crc_leads']::text[] and coalesce(ativo,true)
) where id = 1 and recuperacao_falta_crc_leads is null;

update app_config set recuperacao_falta_crc_pos = (
  select id from profiles where roles @> array['crc_pos_tratamento']::text[] and coalesce(ativo,true) order by nome limit 1
) where id = 1 and recuperacao_falta_crc_pos is null;

-- Amplia o CHECK de notificacoes.tipo (estava restrito; bloquearia os tipos novos)
alter table notificacoes drop constraint if exists notificacoes_tipo_check;
alter table notificacoes add constraint notificacoes_tipo_check check (tipo = any (array[
  'visita_lead','tarefa_atribuida','tarefa_vencendo','tarefa_resumo','sistema','conferencia_pendente',
  'resumo_crc','capi_alerta','aguardando_resposta','falta_sem_responsavel','falta_recuperar_lembrete'
]));
