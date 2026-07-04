-- Matheus (dentista, não-sócio) recebe R$6.000 fixos/mês — mesma natureza do
-- pró-labore do Marcos. A conta 3.2.3 vira genérica: "Dentistas — fixo mensal".
update fin_contas set nome = 'Dentistas — fixo mensal' where codigo = '3.2.3';

insert into fin_regras (metodo, padrao, conta_id, prioridade, origem, peso)
values ('exato', 'pagamento matheus',
  (select id from fin_contas where codigo = '3.2.3'), 0, 'manual', 1)
on conflict (metodo, padrao) do update set conta_id = excluded.conta_id;

update fin_lancamentos
set conta_id = (select id from fin_contas where codigo = '3.2.3'),
    classificacao_metodo = 'manual', override_manual = true
where fluxo = 'sai' and descricao ilike '%pagamento matheus%';
