-- 1) Config dos selos (1 linha)
create table if not exists marketing_config (
  id int primary key default 1,
  meta_roas numeric not null default 3.0,
  gasto_minimo numeric not null default 200,
  maturacao_dias int not null default 21,
  cobertura_minima numeric not null default 0.60,
  atualizado_em timestamptz not null default now(),
  constraint marketing_config_singleton check (id = 1)
);
insert into marketing_config (id) values (1) on conflict (id) do nothing;

-- 2) RPC principal: receita por ad_id, atribuída à safra (coorte) do lead.
-- Faturamento = REVENUE all-time (competência). Caixa = pacientes_financeiro.total_pago
-- (recebido all-time por paciente; fonte confiável, mesma do Perfil 360 — o RECEIVED de
-- fin_lancamentos usa RelatedPersonId/responsável e não casa o paciente). p_lente é mantido
-- na assinatura para compat, mas o filtro de coorte vale para as duas lentes (período = safra).
create or replace function marketing_campanhas(p_desde date, p_ate date, p_lente text)
returns json
language sql stable security definer
as $function$
  with meta_leads as (
    select l.id as lead_id, l.campanha as ad_id, l.criado_em,
           right(regexp_replace(l.telefone,'\D','','g'),8) as suf,
           length(regexp_replace(l.telefone,'\D','','g')) as tlen
    from leads l
    where l.campanha ~ '^\d{6,}$'
  ),
  pares as (
    select ml.lead_id, ml.ad_id, ml.criado_em, p.clinicorp_id as cid,
           row_number() over (partition by p.clinicorp_id order by ml.criado_em desc) as rn
    from meta_leads ml
    join pacientes p
      on ml.tlen >= 8
     and right(regexp_replace(p.telefone_celular,'\D','','g'),8) = ml.suf
  ),
  pac_ncamp as (
    select cid, count(distinct ad_id) as n_camp from pares group by cid
  ),
  owner as (  -- 1 paciente -> 1 lead dono (mais recente), dentro da coorte; incerto se >1 campanha
    select pr.lead_id, pr.ad_id, pr.criado_em, pr.cid, (pn.n_camp > 1) as incerto
    from pares pr join pac_ncamp pn on pn.cid = pr.cid
    where pr.rn = 1
      and pr.criado_em >= p_desde and pr.criado_em < (p_ate + 1)
  ),
  cohort as (
    select campanha as ad_id, count(*) as leads_total, max(criado_em) as lead_recente
    from leads
    where campanha ~ '^\d{6,}$'
      and criado_em >= p_desde and criado_em < (p_ate + 1)
    group by campanha
  ),
  receita as (
    select o.ad_id,
      count(distinct o.lead_id) filter (where not o.incerto) as leads_casados,
      count(distinct o.lead_id) filter (where o.incerto)     as incertos,
      coalesce(sum((select sum(f.valor) from fin_lancamentos f
                    where f.ativo and f.post_type='REVENUE' and f.paciente_id = o.cid::text))
               filter (where not o.incerto), 0) as faturamento,
      coalesce(sum((select pf.total_pago+pf.total_vencido+pf.total_futuro
                    from pacientes_financeiro pf where pf.clinicorp_id = o.cid::text))
               filter (where not o.incerto), 0) as total_contratado,
      coalesce(sum((select pf.total_pago from pacientes_financeiro pf
                    where pf.clinicorp_id = o.cid::text))
               filter (where not o.incerto), 0) as caixa
    from owner o
    group by o.ad_id
  )
  select coalesce(json_agg(row_to_json(r)), '[]'::json) from (
    select c.ad_id,
           c.leads_total,
           coalesce(rc.leads_casados,0) as leads_casados,
           coalesce(rc.incertos,0)      as incertos,
           coalesce(rc.faturamento,0)   as faturamento,
           coalesce(rc.total_contratado,0) as total_contratado,
           coalesce(rc.caixa,0)         as caixa,
           c.lead_recente
    from cohort c
    left join receita rc on rc.ad_id = c.ad_id
  ) r;
$function$;
