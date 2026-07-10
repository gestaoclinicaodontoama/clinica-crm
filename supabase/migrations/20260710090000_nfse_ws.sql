-- 20260710090000_nfse_ws.sql
alter table public.notas_fiscais
  add column if not exists rps_numero int,
  add column if not exists rps_serie text not null default '1',
  add column if not exists codigo_verificacao text,
  add column if not exists xml_envio text,
  add column if not exists xml_retorno text,
  add column if not exists ambiente text not null default 'producao',
  add column if not exists drive_link text;

create table if not exists public.nf_emissores (
  sistema text primary key,              -- 'Vieira' | 'Martins'
  razao_social text not null,
  cnpj text not null,
  inscricao_municipal text not null,
  regime_tributario int not null default 6,   -- código ABRASF (6 = Simples Nacional ME/EPP)
  optante_simples int not null default 1,     -- 1=sim 2=não
  item_lista_servico text not null default '4.12',
  cnae text,
  codigo_tributacao_municipio text,
  aliquota numeric not null default 3.00,
  aliquota_simples numeric,
  cnbs text default '123012300',
  descricao_padrao text default 'Serviços odontológicos',
  drive_folder_id text,
  ativo boolean not null default true
);
alter table public.nf_emissores enable row level security;

create table if not exists public.nf_rps_seq (
  sistema text primary key references public.nf_emissores(sistema),
  proximo_rps int not null default 1
);
alter table public.nf_rps_seq enable row level security;

create or replace function public.nf_reservar_rps(p_sistema text)
returns int language sql security definer set search_path = public as $$
  update public.nf_rps_seq set proximo_rps = proximo_rps + 1
  where sistema = p_sistema
  returning proximo_rps - 1;
$$;
revoke all on function public.nf_reservar_rps(text) from public, anon, authenticated;
grant execute on function public.nf_reservar_rps(text) to service_role;

insert into public.nf_emissores (sistema, razao_social, cnpj, inscricao_municipal) values
  ('Vieira',  'Vieira e Vidigal Martins LTDA', '05617377000108', '8439700'),
  ('Martins', 'Clinica Odontologica Martins',  '33967625000186', 'PREENCHER_IM_MARTINS')
on conflict (sistema) do nothing;

insert into public.nf_rps_seq (sistema) values ('Vieira'), ('Martins')
on conflict (sistema) do nothing;
