-- Drill nível 2: leads de um conjunto de ad_ids (coorte do período), com vínculo + receita por lead
create or replace function marketing_drill_leads(p_ad_ids text[], p_desde date, p_ate date, p_lente text)
returns json
language sql stable security definer
as $function$
  with base as (
    select l.id as lead_id, l.nome, l.campanha as ad_id, l.criado_em, l.status,
           right(regexp_replace(l.telefone,'\D','','g'),8) as suf,
           length(regexp_replace(l.telefone,'\D','','g')) as tlen
    from leads l
    where l.campanha = any(p_ad_ids)
      and l.criado_em >= p_desde and l.criado_em < (p_ate + 1)
  ),
  vinc as (
    select b.*, p.clinicorp_id as cid, p.nome as paciente_nome,
           count(*) over (partition by p.clinicorp_id) as n_leads_no_pac
    from base b
    left join lateral (
      select p.* from pacientes p
      where b.tlen >= 8
        and right(regexp_replace(p.telefone_celular,'\D','','g'),8) = b.suf
      order by p.atualizado_em desc nulls last limit 1
    ) p on true
  )
  select coalesce(json_agg(row_to_json(r) order by r.faturamento desc nulls last), '[]'::json) from (
    select v.lead_id, v.nome, v.ad_id, v.criado_em, v.status,
           v.paciente_nome,
           case when v.cid is null then 'sem_paciente'
                when v.n_leads_no_pac > 1 then 'incerto'
                else 'casado' end as vinculo,
           coalesce((select sum(f.valor) from fin_lancamentos f
                     where f.ativo and f.post_type='REVENUE' and f.paciente_id = v.cid::text), 0) as faturamento,
           coalesce((select pf.total_pago from pacientes_financeiro pf
                     where pf.clinicorp_id = v.cid::text), 0) as caixa
    from vinc v
  ) r;
$function$;

-- Drill nível 3: paciente + resumo financeiro + lançamentos REVENUE (auditoria)
create or replace function marketing_drill_paciente(p_lead_id bigint)
returns json
language sql stable security definer
as $function$
  with l as (
    select right(regexp_replace(telefone,'\D','','g'),8) as suf,
           length(regexp_replace(telefone,'\D','','g')) as tlen
    from leads where id = p_lead_id
  ),
  pac as (
    select p.* from pacientes p join l on true
    where l.tlen >= 8 and right(regexp_replace(p.telefone_celular,'\D','','g'),8) = l.suf
    order by p.atualizado_em desc nulls last limit 1
  )
  select coalesce(
    (select json_build_object(
       'vinculado', true,
       'paciente', json_build_object('nome', pac.nome, 'clinicorp_id', pac.clinicorp_id),
       'financeiro', coalesce((
         select json_build_object('pago', total_pago, 'vencido', total_vencido, 'futuro', total_futuro)
         from pacientes_financeiro pf where pf.clinicorp_id = pac.clinicorp_id::text
       ), json_build_object('pago',0,'vencido',0,'futuro',0)),
       'lancamentos', coalesce((
         select json_agg(json_build_object('data', f.data, 'descricao', f.descricao,
                  'valor', f.valor, 'tipo', f.post_type) order by f.data desc)
         from fin_lancamentos f
         where f.ativo and f.paciente_id = pac.clinicorp_id::text and f.post_type = 'REVENUE'
       ), '[]'::json)
     ) from pac),
    json_build_object('vinculado', false)
  );
$function$;
