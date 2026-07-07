-- Enriquece leads.email a partir de pacientes.email (Clinicorp), casando por
-- sufixo-8 do telefone + primeiro nome. Guardas:
--   * e-mail sintaticamente válido;
--   * primeiro nome do lead == primeiro nome do paciente (sem acento) — o telefone
--     é compartilhado pela família, mas o e-mail é pessoal; o primeiro nome
--     distingue quem é quem (sobrenome a família compartilha, não serve);
--   * 1 e-mail distinto por (sufixo, primeiro nome) — anti-colisão;
--   * leads com dígitos iniciando em 0 são pulados (convenção da casa: 0 à esquerda
--     = familiar usando o número do titular);
--   * primeiro nome com >= 2 letras (descarta lixo tipo "." e iniciais soltas).
-- Só preenche leads sem e-mail — nunca sobrescreve. Retorna nº de atualizados.
create or replace function public.enriquecer_emails_leads()
returns integer
language sql
as $$
with pac as (
  select right(regexp_replace(coalesce(telefone_celular, ''), '\D', '', 'g'), 8) as suf8,
         lower(trim(email)) as email,
         translate(lower(split_part(trim(nome), ' ', 1)),
                   'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc') as pnome
  from pacientes
  where email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    and length(regexp_replace(coalesce(telefone_celular, ''), '\D', '', 'g')) >= 8
    and length(translate(lower(split_part(trim(coalesce(nome, '')), ' ', 1)),
               'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')) >= 2
),
unicos as (
  -- por (sufixo, primeiro nome): 1 e-mail distinto = sem ambiguidade
  select suf8, pnome, min(email) as email
  from pac
  group by suf8, pnome
  having count(distinct email) = 1
),
alvo as (
  select l.id, u.email
  from leads l
  join unicos u
    on u.suf8 = right(regexp_replace(l.telefone, '\D', '', 'g'), 8)
   and u.pnome = translate(lower(split_part(trim(l.nome), ' ', 1)),
                           'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')
  where (l.email is null or l.email = '')
    and l.telefone is not null
    and regexp_replace(l.telefone, '\D', '', 'g') !~ '^0'
    and length(regexp_replace(l.telefone, '\D', '', 'g')) >= 8
    and length(translate(lower(split_part(trim(coalesce(l.nome, '')), ' ', 1)),
               'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')) >= 2
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
