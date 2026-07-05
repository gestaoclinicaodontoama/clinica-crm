-- Completa notificacoes_tipo_check: a migração 20260705120000 recriou o CHECK
-- mas deixou de fora 3 tipos que o server.js JÁ insere ativamente
-- (whatsapp_saude server.js:4881, capi_resumo :4930, coleta_lembrete :7489).
-- Como o supabase-js .insert() não lança em violação de CHECK (devolve {error}
-- ignorado por criarNotificacao), essas notificações a gestores/CRCs vinham
-- sendo perdidas em silêncio. Aqui a lista fica completa (todos os tipos em uso).
alter table notificacoes drop constraint if exists notificacoes_tipo_check;
alter table notificacoes add constraint notificacoes_tipo_check check (tipo = any (array[
  'visita_lead','tarefa_atribuida','tarefa_vencendo','tarefa_resumo','sistema','conferencia_pendente',
  'resumo_crc','capi_alerta','aguardando_resposta','falta_sem_responsavel','falta_recuperar_lembrete',
  'whatsapp_saude','capi_resumo','coleta_lembrete'
]));
