-- Provisões na DRE = Grupo 9 (memorando fora do resultado). Spec 2026-07-07.
-- Provisão = reserva p/ gasto futuro (Category="Provisões" no Clinicorp); NÃO é saída de caixa.

-- 1) tipo 'provisao' no CHECK de fin_contas
ALTER TABLE public.fin_contas DROP CONSTRAINT fin_contas_tipo_check;
ALTER TABLE public.fin_contas ADD CONSTRAINT fin_contas_tipo_check
  CHECK (tipo = ANY (ARRAY['receita','imposto','custo','despesa','financeiro','investimento','distribuicao','provisao']));

-- 2) conta 9.1 Provisões (grupo 9)
INSERT INTO public.fin_contas (codigo, nome, grupo, tipo, ordem, ativo)
SELECT '9.1','Provisões','9 - PROVISÕES','provisao',100,true
WHERE NOT EXISTS (SELECT 1 FROM public.fin_contas WHERE codigo = '9.1');

-- 3) auto-classificação: Category="Provisões" paga -> conta 9.1; não paga -> fora da DRE.
--    Espelha fin_autoclassifica_fixos_dentista. Chaveia pela Category do Clinicorp
--    (não pela descrição: a keyword "férias" jogava a provisão no RH).
CREATE OR REPLACE FUNCTION public.fin_autoclassifica_provisao()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_conta_id bigint;
BEGIN
  IF NEW.fluxo = 'sai'
     AND NEW.override_manual IS NOT TRUE
     AND btrim(NEW.raw->>'Category') = 'Provisões'
  THEN
    IF COALESCE(NEW.raw->>'PaidBookEntryAtomicDate','0') NOT IN ('0','') THEN
      SELECT id INTO v_conta_id FROM public.fin_contas WHERE codigo = '9.1';
      NEW.conta_id := v_conta_id;
      NEW.classificacao_metodo := 'regra-provisao';
    ELSE
      -- provisão ainda não paga: fica fora da DRE (só o que já foi pago conta)
      NEW.conta_id := NULL;
      NEW.classificacao_metodo := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fin_autoclassifica_provisao ON public.fin_lancamentos;
CREATE TRIGGER trg_fin_autoclassifica_provisao
BEFORE INSERT OR UPDATE ON public.fin_lancamentos
FOR EACH ROW EXECUTE FUNCTION public.fin_autoclassifica_provisao();

-- 4) backfill: reclassifica as provisões PAGAS já existentes (mesma regra do trigger).
UPDATE public.fin_lancamentos
SET conta_id = (SELECT id FROM public.fin_contas WHERE codigo = '9.1'),
    classificacao_metodo = 'regra-provisao'
WHERE fluxo = 'sai'
  AND override_manual IS NOT TRUE
  AND btrim(raw->>'Category') = 'Provisões'
  AND COALESCE(raw->>'PaidBookEntryAtomicDate','0') NOT IN ('0','');
