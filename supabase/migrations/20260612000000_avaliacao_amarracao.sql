-- Amarração das avaliações: agendamento + data da consulta + paciente Clinicorp
alter table public.consultas_spin
  add column if not exists clinicorp_appointment_id text,
  add column if not exists clinicorp_patient_id     text,
  add column if not exists data_consulta            date;

comment on column public.consultas_spin.clinicorp_appointment_id is 'id do agendamento no Clinicorp (origem da amarração)';
comment on column public.consultas_spin.data_consulta is 'data real da consulta (≠ created_at, que é quando foi salva)';

create index if not exists idx_consultas_spin_data_consulta on public.consultas_spin (data_consulta);

-- Mapeamento usuário do CRM (dentista) ↔ Dentist_PersonId do Clinicorp
create table if not exists public.dentista_clinicorp_map (
  dentista_id        uuid primary key references auth.users(id) on delete cascade,
  clinicorp_person_id bigint not null,
  nome               text,
  updated_at         timestamptz not null default now(),
  updated_by         uuid
);

comment on table public.dentista_clinicorp_map is 'liga o login do dentista no CRM ao seu Dentist_PersonId no Clinicorp, para puxar a agenda do dia';
