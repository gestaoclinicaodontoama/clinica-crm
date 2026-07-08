-- Calculadora do mês (Análise de Receita Fase 2) — campos editáveis por mês.
-- lucro_alvo (R$) já existe; lucro_alvo_pct não nulo = modo % (fração 0–0,95).
alter table public.fin_receita_metas
  add column if not exists meta_faturamento numeric null check (meta_faturamento is null or meta_faturamento >= 0),
  add column if not exists lucro_alvo_pct numeric null check (lucro_alvo_pct is null or (lucro_alvo_pct >= 0 and lucro_alvo_pct < 0.95)),
  add column if not exists recebiveis_override numeric null check (recebiveis_override is null or recebiveis_override >= 0),
  add column if not exists pagar_override numeric null check (pagar_override is null or pagar_override >= 0);
