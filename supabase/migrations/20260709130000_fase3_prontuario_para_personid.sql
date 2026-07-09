-- Fase 3 fix: o "(id)" do nome é o PRONTUÁRIO (curto); payment/list e RPCs usam
-- o PersonId (16 dígitos). Converte via pacientes.numero_prontuario — SÓ quando o
-- prontuário é ÚNICO na tabela (ambíguo fica curto, rastreável). Trigger durável
-- faz o mesmo para linhas futuras (o sync grava o prontuário; o trigger resolve).
with unicos as (
  select numero_prontuario::text as pront, min(clinicorp_id::text) as pid
    from public.pacientes
   where numero_prontuario is not null
   group by numero_prontuario::text
  having count(*) = 1
)
update public.producao_procedimentos pp
   set paciente_clinicorp_id = u.pid
  from unicos u
 where pp.paciente_clinicorp_id ~ '^\d{1,6}$'
   and u.pront = pp.paciente_clinicorp_id;

create or replace function public.producao_resolve_prontuario()
returns trigger
language plpgsql
set search_path = public
as $$
declare v text;
begin
  if new.paciente_clinicorp_id ~ '^\d{1,6}$' then
    select min(p.clinicorp_id::text) into v
      from public.pacientes p
     where p.numero_prontuario::text = new.paciente_clinicorp_id
    having count(*) = 1;
    if v is not null then new.paciente_clinicorp_id := v; end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_producao_resolve_prontuario on public.producao_procedimentos;
create trigger trg_producao_resolve_prontuario
  before insert or update of paciente_clinicorp_id on public.producao_procedimentos
  for each row execute function public.producao_resolve_prontuario();
