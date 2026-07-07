# Provisões na DRE — Grupo 9 (memorando fora do resultado)

**Data:** 2026-07-07
**Contexto:** [[project-financeiro-dre]]. O Clinicorp passou a ter lançamentos com
`Category = "Provisões"` (dinheiro reservado para gasto futuro: férias/13º, reforma,
lucro). Eles chegam ao sync como despesa (`PostType=EXPENSES`, `fluxo='sai'`) e, se
categorizados por keyword, contam ERRADO como saída de caixa (ex.: a "Provisão
Férias/13°" caiu no RH e inflou julho em R$19.000).

## Objetivo
Provisão **não é saída de caixa** — é reserva. Deve aparecer **identificada como
provisão**, num bloco informativo, **fora** do resultado e de todos os cálculos
(ponto de equilíbrio, projeção, anomalia, maior desvio, consultor). Espelha o
tratamento do **grupo 8 (Distribuição de Lucro)**.

Decisão do Luiz (2026-07-07): opção **Grupo 9** (bloco na DRE), não o "Cofre".
Só provisões **pagas** entram (as em aberto nem chegam pelo sync).

## Identificação
Gatilho = `btrim(raw->>'Category') = 'Provisões'` **e** paga
(`raw->>'PaidBookEntryAtomicDate'` ≠ 0). NÃO depende da descrição (a keyword "férias"
enganava o categorizador). Uma provisão não paga fica com `conta_id = NULL` (fora da
DRE), nunca vira saída.

## Modelo de dados
- Nova conta **9.1 "Provisões"**, grupo **"9 - PROVISÕES"**, tipo novo `provisao`.
- CHECK de `fin_contas.tipo` ampliado com `'provisao'`.
- Trigger `trg_fin_autoclassifica_provisao` (BEFORE INSERT/UPDATE): se
  `fluxo='sai'` e `override_manual` falso e `Category='Provisões'` → paga vira 9.1
  (`classificacao_metodo='regra-provisao'`), não paga vira `conta_id=NULL`. Respeita
  override manual. Espelha `fin_autoclassifica_fixos_dentista`.
- Backfill: reclassifica as provisões pagas já existentes (mesma regra do trigger).

## Cascata / cálculos (espelho do grupo 8)
- `taxonomia.js`: conta 9.1 + `GRUPOS_DRE` termina em `9`.
- `dre.js`: `resultado` (soma geral) **exclui** grupo 9 (provisão não afeta resultado).
  Grupo 8 segue incluído como hoje.
- `dre-analise.js`: `subtotais` NÃO muda (grupo 9 fora). `maiorDesvio` ignora `'9'`.
  PE/projeção/resumoSaidas já usam grupos específicos → 9 naturalmente fora.
- `dre-page.js` (`LINHAS`): linha de grupo `9` depois de "RESULTADO APÓS DISTRIBUIÇÕES",
  `semAnomalia:true`, **sem** subtotal depois (não cria "resultado após provisões").
- `avaliacao.js`: `topDesvios` ignora `'9'` (como o `'8'`). `contasDetalhadas` mantém
  (é só contexto para a pergunta livre, igual ao 8).
- RPC `fin_dre_agg_mensal`: genérica, pega a conta 9.1 sozinha. Sem mudança.

## Fora de escopo
- "Cofre/Reservas" com saldo acumulado e baixa (opção 1 do brainstorm) — não escolhida.
- Split do grupo 9 em subcontas (Férias/Reforma/Lucro): fica como drill-down por
  descrição (`agruparLancamentos`), conta única 9.1.

## Validação
- Testes: `taxonomia.test` (ordem dos grupos + conta 9.1), `dre.test` (grupo 9 não
  mexe em `resultado`), `dre-analise.test`/`avaliacao.test` (9 fora de desvio).
- Manual: DRE de julho/2026 — Provisões = R$30.610 no bloco, RH volta ao normal
  (−R$19.000), Resultado Final não muda por causa das provisões.
