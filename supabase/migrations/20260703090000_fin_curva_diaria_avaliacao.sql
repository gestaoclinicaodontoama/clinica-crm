-- Projeção calibrada + avaliação do consultor na DRE.
-- 1) Agregado diário (receita × saída DRE, sem financeiras/investimentos) p/ a
--    curva histórica do dia do mês que calibra a projeção do mês corrente.
create or replace function fin_agg_diario(p_from date, p_to date)
returns table(ym text, dia int, receita numeric, saida numeric)
language sql stable as $$
  select to_char(l.data, 'YYYY-MM') as ym, extract(day from l.data)::int as dia,
    coalesce(sum(l.valor) filter (where l.fluxo = 'entra'), 0) as receita,
    coalesce(sum(l.valor) filter (where l.fluxo = 'sai'
      and c.codigo not like '5%' and c.codigo not like '7%'), 0) as saida
  from fin_lancamentos l
  join fin_contas c on c.id = l.conta_id
  where l.ativo and l.data between p_from and p_to
  group by 1, 2
  order by 1, 2;
$$;

-- 2) Cache da avaliação do consultor (fatos calculados + texto da IA) por período.
create table if not exists fin_dre_avaliacoes (
  periodo text primary key,            -- 'YYYY-MM-DD~YYYY-MM-DD'
  fatos jsonb not null,
  texto jsonb,                         -- { resumo, pontos[], recomendacoes[] } ou null (IA indisponível)
  atualizado_em timestamptz not null default now()
);
alter table fin_dre_avaliacoes enable row level security;
