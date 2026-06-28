-- Fase 1.5 follow-up: a marcacao de VIP agora e inline na Curva ABC (visivel a
-- crc_sucesso/crc_pos_tratamento). A RLS antiga liberava o role 'crc_pos' que NAO
-- existe em profiles -> recurso quebrado p/ a equipe de Pos Tratamento.
-- Alinha as policies aos mesmos roles do nav.
do $$
declare r text := 'array[''crc_pos_tratamento'',''crc_sucesso'',''gestor'',''admin'']';
begin
  execute 'alter policy vip_select on vip_pacientes using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.roles && '||r||'))';
  execute 'alter policy vip_insert on vip_pacientes with check (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.roles && '||r||'))';
  execute 'alter policy vip_update on vip_pacientes using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.roles && '||r||'))';
  execute 'alter policy vip_delete on vip_pacientes using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.roles && '||r||'))';
end $$;
