-- Renomeia tabelas do módulo Tarefas legado para backup (substituído pela Central de Tarefas)
alter table if exists public.tarefa_instancias rename to tarefa_instancias_legado_backup;
alter table if exists public.tarefas rename to tarefas_legado_backup;
