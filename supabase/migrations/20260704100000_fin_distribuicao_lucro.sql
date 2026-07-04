-- Distribuição de lucro aos sócios = grupo 6 da DRE, abaixo do Resultado Final.
-- Antes disso os lançamentos "Distribuição lucro <sócio>" caíam em receita (1.1/1.2),
-- dentistas sócios (3.2.1) e RH (4.1.1), distorcendo receita bruta, margens e PE.

alter table fin_contas drop constraint fin_contas_tipo_check;
alter table fin_contas add constraint fin_contas_tipo_check
  check (tipo = any (array['receita'::text, 'imposto'::text, 'custo'::text,
    'despesa'::text, 'financeiro'::text, 'investimento'::text, 'distribuicao'::text]));

insert into fin_contas (codigo, nome, grupo, tipo, ordem)
values ('6.1', 'Distribuição de lucro — sócios', '6 - DISTRIBUIÇÃO DE LUCRO', 'distribuicao', 90)
on conflict (codigo) do nothing;

-- Regras "exato" por sócio: o núcleo do normalizador descarta o "N/AAAA" e o
-- sufixo de empresa, então cada padrão casa a distribuição de QUALQUER mês futuro.
insert into fin_regras (metodo, padrao, conta_id, prioridade, origem, peso)
select 'exato', p, (select id from fin_contas where codigo = '6.1'), 0, 'manual', 1
from unnest(array[
  'distribuicao lucro luiz eduardo',
  'distribuicao lucro marcos',
  'distribuicao lucro joaquim',
  'distribuicao lucro dorinha',
  'distribuicao lucro maioni',
  'distribuicao lucro sirlene'
]) as p
on conflict (metodo, padrao) do update set conta_id = excluded.conta_id;

-- Reclassifica os lançamentos já sincronizados e trava contra reclassificação do sync.
update fin_lancamentos
set conta_id = (select id from fin_contas where codigo = '6.1'),
    classificacao_metodo = 'manual',
    override_manual = true
where fluxo = 'sai' and descricao ilike '%distribui%_o lucro%';
