-- Permite o tipo de notificação da conferência comercial
alter table public.notificacoes drop constraint if exists notificacoes_tipo_check;
alter table public.notificacoes add constraint notificacoes_tipo_check
  check (tipo = any (array['visita_lead','tarefa_atribuida','tarefa_vencendo','sistema','conferencia_pendente']));
