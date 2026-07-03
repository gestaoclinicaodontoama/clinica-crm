-- Tendência da saúde financeira: snapshot diário dos totais (a partir do mês
-- seguinte ao vigente) + cache das análises da carteira de parcelas.
create table if not exists fin_saude_snapshots (
  data date primary key,                    -- dia do snapshot
  receber numeric not null default 0,       -- a receber próximos 24m (mês seguinte em diante)
  pagar numeric not null default 0,         -- a pagar idem
  resultado numeric not null default 0,     -- receber - pagar
  vencido numeric not null default 0,
  origem text not null default 'diario'
);
alter table fin_saude_snapshots enable row level security;

-- Análises recalculadas a cada refresh das parcelas (aging, taxa de perda,
-- renovação, top pagadores, carteira retroativa) — 1 linha JSON.
create table if not exists fin_saude_analises (
  id int primary key default 1,
  dados jsonb not null,
  atualizado_em timestamptz not null default now()
);
alter table fin_saude_analises enable row level security;
