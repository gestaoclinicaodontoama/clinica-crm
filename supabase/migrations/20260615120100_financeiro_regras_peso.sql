-- Coluna de peso para regras de categorização tipo keyword (votação por token).
-- (Já aplicada no projeto via MCP; este arquivo garante reprodutibilidade do schema.)
alter table fin_regras add column if not exists peso int not null default 1;
