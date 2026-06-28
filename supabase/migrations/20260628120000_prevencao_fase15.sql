alter table pacientes_abc
  add column if not exists perio boolean default false,
  add column if not exists ultima_prevencao_perio date;

alter table vip_pacientes
  add column if not exists intervalo_dias integer;
