-- 1) Pró-labore do Marcos = despesa FIXA (decisão do Luiz 04/07/26).
--    Continua no grupo 3.2 na cascata; as fórmulas tratam 3.2.3 como fixa
--    (FIXAS_CONTAS em dre-analise.js). Joaquim segue variável em 3.2.1.
insert into fin_contas (codigo, nome, grupo, tipo, ordem)
values ('3.2.3', 'Pró-labore sócios — fixo', '3.2 - MÃO DE OBRA DENTISTA', 'custo', 42)
on conflict (codigo) do nothing;

insert into fin_regras (metodo, padrao, conta_id, prioridade, origem, peso)
values ('exato', 'pro labore marcos vinicius',
  (select id from fin_contas where codigo = '3.2.3'), 0, 'manual', 1)
on conflict (metodo, padrao) do update set conta_id = excluded.conta_id;

-- Reclassifica o histórico inteiro (backfill 2024–2026) e trava contra o sync.
update fin_lancamentos
set conta_id = (select id from fin_contas where codigo = '3.2.3'),
    classificacao_metodo = 'manual', override_manual = true
where fluxo = 'sai' and descricao ilike '%pro labore marcos%';

-- 2) Faturamento (competência): soma mensal dos lançamentos REVENUE do Clinicorp —
--    linha 0 da DRE + análise vertical própria (% Fat.).
create or replace function fin_faturamento_mensal(p_from date, p_to date)
returns table(ym text, total numeric)
language sql stable security definer
set search_path = public as $$
  select to_char(data, 'YYYY-MM'), sum(valor)
  from fin_lancamentos
  where ativo and fluxo = 'entra' and post_type = 'REVENUE'
    and data between p_from and p_to
  group by 1;
$$;

-- security definer NÃO pode ficar chamável por anon (auditoria RPC 07/2026):
revoke execute on function fin_faturamento_mensal(date, date) from public, anon, authenticated;
grant execute on function fin_faturamento_mensal(date, date) to service_role;
