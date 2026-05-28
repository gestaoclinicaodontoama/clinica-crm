-- Fix RLS policies: drop wide-open policies and let service_role use its built-in BYPASSRLS privilege.
-- Anon and authenticated roles will have no direct access (all access goes through Express + service_role).

DROP POLICY IF EXISTS "service role bypass" ON ligacoes;
DROP POLICY IF EXISTS "service role bypass" ON ia_config;
DROP POLICY IF EXISTS "service role bypass" ON ia_uso_log;
