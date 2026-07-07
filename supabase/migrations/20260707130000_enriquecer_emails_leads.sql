-- Enriquece leads.email a partir de pacientes.email (Clinicorp), casando por
-- sufixo-8 do telefone. Guardas: e-mail válido; 1 e-mail distinto por sufixo
-- (anti-colisão de família); leads com dígitos iniciando em 0 são pulados
-- (convenção da casa: 0 à esquerda = familiar usando o número do titular).
-- Só preenche leads sem e-mail — nunca sobrescreve. Retorna nº de atualizados.
create or replace function public.enriquecer_emails_leads()
returns integer
language sql
as $$
with pac as (
  select right(regexp_replace(coalesce(telefone_celular, ''), '\D', '', 'g'), 8) as suf8,
         lower(trim(email)) as email
  from pacientes
  where email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    and length(regexp_replace(coalesce(telefone_celular, ''), '\D', '', 'g')) >= 8
),
unicos as (
  -- 2+ pacientes com o MESMO e-mail contam como 1 (ok); e-mails distintos
  -- no mesmo sufixo = ambíguo, fica de fora.
  select suf8, min(email) as email
  from pac
  group by suf8
  having count(distinct email) = 1
),
alvo as (
  select l.id, u.email
  from leads l
  join unicos u
    on u.suf8 = right(regexp_replace(l.telefone, '\D', '', 'g'), 8)
  where (l.email is null or l.email = '')
    and l.telefone is not null
    and regexp_replace(l.telefone, '\D', '', 'g') !~ '^0'
    and length(regexp_replace(l.telefone, '\D', '', 'g')) >= 8
),
upd as (
  update leads l
  set email = a.email
  from alvo a
  where l.id = a.id
  returning 1
)
select coalesce(count(*), 0)::int from upd;
$$;

-- Trancada por padrão (regra do CLAUDE.md): só o servidor (service_role) executa.
revoke all on function public.enriquecer_emails_leads() from public, anon, authenticated;
grant execute on function public.enriquecer_emails_leads() to service_role;
