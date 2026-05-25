-- Remove the 2000-char CHECK constraint on insights_gestor; AI-generated insights can easily exceed it.
ALTER TABLE dentista_perfil_spin DROP CONSTRAINT IF EXISTS dentista_perfil_spin_insights_gestor_check;
