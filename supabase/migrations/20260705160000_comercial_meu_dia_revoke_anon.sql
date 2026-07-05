-- Segurança: a RPC comercial_meu_dia (SECURITY INVOKER) lê leads (PII: nome/telefone)
-- e, com o EXECUTE default de PUBLIC, seria chamável pela anon key — e leads tem
-- policy de SELECT para {public}, então o anon puxaria dados. Mesma classe do
-- incidente pacientes2. O server chama via SUPABASE_SERVICE_ROLE_KEY (não afetado
-- pelo revoke). Fecha a porta para anon/authenticated diretos.
revoke execute on function public.comercial_meu_dia(uuid) from public;
revoke execute on function public.comercial_meu_dia(uuid) from anon;
revoke execute on function public.comercial_meu_dia(uuid) from authenticated;
