# Inadimplência 2.0 — Fase 3 — Ponto de Desistência

> Spec de design (brainstorm 2026-07-05). Segue as Fases 0+1 e 2 (no ar). Adiciona um
> bloco "Ponto de Desistência" na aba Inadimplência: **em que parcela as pessoas param
> de pagar**. Aditivo, computado dos dados que já são coletados.

## Objetivo

Responder a pergunta do Luiz: os planos parcelados travam **na 1ª? na 10ª? faltando duas?**
Mostrar a distribuição do ponto de parada por dois cortes — do começo ("parou na parcela N")
e do fim ("faltando N pro fim") — pra informar a política de venda/contrato (ex.: exigir
entrada maior, ou reforçar a cobrança logo na 1ª falha).

## Achados de dados (sondagem 2026-07-05, 1 chamada /payment/list, 1640 itens / 224 tratamentos)

- **`InstallmentNumber` vem 100% preenchido.** É **0-based**: posição 0 = entrada/1º boleto,
  1 = 1ª parcela, etc.
- **`MaxInstallmentsCount` é INUTILIZÁVEL** — só vem em 35% dos itens e vem errado (diz "1"
  para planos de 25 parcelas, "15" para um de 18; provavelmente é nº de parcelas do cartão).
  **Não usar.** O tamanho do plano é derivado do dado: `max(InstallmentNumber) + 1` por tratamento.
- **Renegociação** gera parcelas duplicadas por posição (ex.: 26 itens para posições 0–23) e
  cancela as antigas. **Filtrar `Canceled`** e **deduplicar por posição** é obrigatório.
- A última parcela paga por tratamento reconstrói limpo o ponto de parada.

## O que mostra (bloco "Ponto de Desistência")

Um bloco novo na aba (abaixo do "Resultado da Cobrança"), com **dois mini-gráficos de barras**
(SVG inline, mesmo padrão da Fase 2) + um resumo em destaque:

1. **Parou na parcela N** (do começo) — histograma: quantos planos travaram na entrada, na 1ª,
   na 2ª… Resumo: "a maioria trava na parcela X" (a moda). Responde "1ª? 10ª?".
2. **Faltando N pro fim** (do fim) — histograma agrupado em faixas (faltando 1, 2, 3 … e "10+").
   Destaca "quase quitou e desistiu". Responde "faltando duas?".

## Reconstrução (por tratamento)

Da coleta de 24 meses do `/payment/list` (planos iniciados nesse período ficam completos):

1. Agrupar itens por `TreatmentId`. **Descartar** itens com `Canceled` verdadeiro.
2. **Deduplicar por `InstallmentNumber`**: uma posição conta como **paga** se qualquer item
   não-cancelado naquela posição foi recebido (`PaymentReceived==='X'` ou `ReceivedDate` válida).
3. `planLen = max(InstallmentNumber) + 1`.
4. `ultimaPaga` = maior `InstallmentNumber` **pago** (null se nada pago).
5. **Travou?** existe posição **não paga e vencida** (`DueDate < hoje`) **após** `ultimaPaga`.
   - Se sim: `parouEm = ultimaPaga + 1` (a 1ª parcela que ele falhou; 0 se nunca pagou nada).
   - `faltando = planLen - parouEm` (parcelas da falha até o fim, inclusive).
6. **Coorte** = só os que travaram. **Fora:** planos quitados (sem parcela em aberto) e os que
   ainda pagam em dia (a próxima em aberto ainda não venceu).

Agregar: distribuição de `parouEm` (0,1,2,…) e de `faltando` (1,2,…,"10+"), contagem de planos
travados, e a moda de `parouEm` para o resumo.

## Arquitetura

- **Lib pura** — nova função `pontoDesistencia(items, hojeISO) -> { parouEm: [{parcela, planos}],
  faltando: [{faltam, planos}], totalTravados, modaParouEm }` em `lib/financeiro/recuperacao.js`
  (mesma família "resultado"; reusa `dia/valor/recebida` de lá — sem 3º arquivo). Pura, testada,
  `.slice(0,10)` nas datas.
- **Server** — anexar `resultado.desistencia = pontoDesistencia(allItems, today)` dentro do
  `fetchInadimplentesBackground` que já roda (junto de `recuperacao/vencido/aging`). **Zero
  chamada Clinicorp nova.** Sobrevive ao `mergeInadimplentesNotas` (spread).
- **Frontend** — bloco "Ponto de Desistência" na aba `page-inadimplentes`, lendo
  `data.resultado.desistencia`. Dois SVG de barras (reusar/adaptar `_svgRecuperacao` como base de
  histograma). Rótulos: posição 0 = "entrada", 1 = "1ª", etc. Esconde se `desistencia` ausente
  (cache velho) ou `totalTravados === 0`.

## Isolamento e testes (TDD na função pura)

- `parouEm` correto: plano que pagou 0,1,2 e falhou a 3 (vencida) → parouEm 3, planLen do maior
  InstallmentNumber+1, faltando = planLen-3.
- `faltando` e o agrupamento "10+".
- **Dedup de renegociação:** posição duplicada com uma paga → conta como paga; itens `Canceled`
  ignorados.
- **Exclui** quitado (sem parcela em aberto) e em-dia (próxima em aberto não vencida).
- Nunca-pagou com entrada vencida → parouEm 0 ("entrada").

## Fora de escopo (YAGNI)

- Sem drill por tratamento/paciente (é visão agregada; drill = fase futura).
- Sem cruzar com forma de pagamento (isso é a Fase 4).
- `MaxInstallmentsCount` **não** é usado (dado furado).

## Riscos / ressalvas

- Planos iniciados há mais de 24 meses não ficam completos na janela — a análise cobre planos
  recentes (documentar como nota discreta na UI).
- A derivação `planLen = maxInst+1` pode subestimar se a renegociação estendeu o plano; aceitável.
- Renegociação é ruído conhecido — tratada por `Canceled` + dedup por posição.
