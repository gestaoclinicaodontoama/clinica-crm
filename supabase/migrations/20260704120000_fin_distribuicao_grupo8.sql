-- Distribuição de lucro renumerada 6 → 8 (pedido do Luiz: "6" depois do "7 - INVESTIMENTOS"
-- quebrava a leitura da cascata). fin_regras/fin_lancamentos apontam por conta_id — intactos.
update fin_contas
set codigo = '8.1', grupo = '8 - DISTRIBUIÇÃO DE LUCRO'
where codigo = '6.1';

-- "Pagamento Joaquim - AMA" de 15/04/2026 (R$ 5.000) foi lançado como pró-labore (3.2.1)
-- mas era distribuição de lucro. Caso pontual — o pró-labore recorrente (N/12) fica onde está.
update fin_lancamentos
set conta_id = (select id from fin_contas where codigo = '8.1'),
    classificacao_metodo = 'manual',
    override_manual = true
where clinicorp_id = (
  select clinicorp_id from fin_lancamentos
  where id = 15389 and descricao = 'Pagamento de Conta: Pagamento Joaquim - AMA'
    and valor = 5000.00 and data = '2026-04-15'
);
