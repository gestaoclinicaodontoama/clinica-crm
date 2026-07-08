# Análise de Receita — Entrada nova × Base recorrente

**Data:** 2026-07-08 · **Status:** aprovado no brainstorm, aguardando plano
**Página nova:** `/financeiro/receita/` ("Análise de Receita") · roles `admin,gestor`

## Problema

O Luiz avalia todo mês "quanto entra de dinheiro novo (venda daquele mês) vs quanto
é a carteira antiga pagando (boletos e parcelas de cartão)". Hoje essa separação
não existe em lugar nenhum do CRM — a barra "Recebido no mês" da página Saúde
mistura tudo. Ele quer: (a) essa separação, (b) metas de venda do mês derivadas
dela e (c) saber quando a base recorrente cobre as contas — aí toda entrada vira
lucro.

## Definições (as duas moedas)

Fonte: itens do `/payment/list` da Clinicorp (mesmos 24 meses já baixados 1x/dia
pelo `fetchInadimplentesBackground`). Convênio NÃO passa por esse endpoint — o
dado já é 100% particular, sem precisar filtrar.

- **Entrada nova** = parcela `InstallmentNumber === 0` recebida (à vista ou
  entrada de parcelamento). `Canceled === 'X'` fora.
- **Base recorrente** = parcelas `InstallmentNumber >= 1` (boleto, cartão, etc.).
- **Recebida** = critério existente de `analise-parcelas.js` (`PaymentReceived==='X'`
  ou `ReceivedDate` válida).
- **Valor** = `AmountWithDiscounts || Amount || TotalPostAmount` (padrão da casa).

Validado com dado real (jun/26): total R$ 301.318 = barra verde do gráfico da
Saúde; entrada R$ 128k (43%) + recorrente R$ 173k (57%).

## Números derivados (calculados 1x/dia, funções puras)

Módulo novo **`lib/financeiro/receita-motor.js`** (padrão `analise-parcelas.js`:
funções puras + `receita-motor.test.js`).

1. **Decomposição 12m** — por mês de `ReceivedDate`: `{ mes, entrada, recorrente }`.
2. **Taxa de realização** — média dos últimos 6 meses FECHADOS: Σ(parcelas 1+ com
   vencimento no mês E recebidas **dentro do mesmo mês**) ÷ Σ(parcelas 1+ com
   vencimento no mês). Conservadora: pagou atrasado = recuperação, não realização.
   Calculada no agregado e separada por `PaymentForm` (boleto × cartão × demais).
3. **Recorrente previsto do mês corrente** — Σ parcelas 1+ não canceladas com
   `DueDate` no mês × taxa de realização. Guardar também o valor cru (sem taxa) e
   o **recorrente já recebido no mês** (para o progresso vivo). Parcelas vencidas
   de meses anteriores que caírem no mês são upside não contado (conservador).
4. **Réguas (degraus)** — vindas da DRE, médias dos últimos 6 meses fechados:
   - Degrau 1 = **fixas médias**: `fixasDe()` do `dre-analise.js` (grupo 4 +
     conta 3.2.3), que o servidor já importa (`_DREAnalise`).
   - Degrau 2 = **saída total média**: Σ|saídas| dos meses fechados (mesma fonte).
   - Decisão: NÃO usar o `a_pagar` do `fin_fluxo_futuro` como régua — esvazia
     conforme as contas do mês são pagas e sub-registra; médias da DRE são
     estáveis e comparáveis entre si.
5. **Convênio médio** — média 6m da conta 1.1 da DRE (o convênio também paga
   contas; entra no alvo como receita não-gerenciável).
6. **Razão entrada÷venda** — média 6m de: entrada recebida no mês ÷ vendas
   fechadas no mês (`orcamentos` APPROVED, `valor_particular > 0`, não rejeitado,
   ≥ R$ 1.000 — mesmo critério de fechamento do Painel do Gestor).
7. **Colchão (24m)** — parcelas 1+ não recebidas com vencimento futuro, por mês,
   × realização. NÃO usar `fin_recebiveis_mensal` (mistura entradas futuras).
   Colchão em meses = quantos meses seguidos esse escorrimento cobre a régua 1.
8. **Rumo ao degrau** — regressão linear simples sobre o recorrente recebido dos
   últimos 12 meses fechados; cruzamento com cada régua → "~N meses (≈ mmm/aa)".
   Casos: já cruzou (celebrar, apontar degrau 2); inclinação ≤ 0 e abaixo →
   "no ritmo atual não cruza".

## Meta do mês (bloco 2)

- **Alvo Empatar** = saída total média (régua 2).
- **Alvo com lucro** = régua 2 + `lucro_alvo` do mês (editável).
- **Meta de entrada do mês** = alvo − convênio médio − recorrente previsto.
- **Progresso vivo** = meta de entrada − entrada já recebida no mês. Traduzido em:
  - R$ de vendas necessárias = restante ÷ razão entrada÷venda;
  - ~N fechamentos = vendas necessárias ÷ ticket (mesma conta do Painel do
    Gestor: média dos aprovados ≥ R$ 1.000 do período);
  - dias úteis restantes (seg–sex + sábado contando 0,5).

`lucro_alvo` por mês na tabela nova **`fin_receita_metas`**
(`mes date PK, lucro_alvo numeric, atualizado_em`). Sem meta definida → card
mostra só "Empatar" + convite para definir.

## Armazenamento e API

- Tabela nova **`fin_receita_analises`** (`id int PK` (=1), `dados jsonb`,
  `atualizado_em timestamptz`) — 1 linha sobrescrita, padrão `fin_saude_analises`.
- Escrita: função `atualizarAnaliseReceita(items, today)` chamada dentro do
  `fetchInadimplentesBackground` (mesmos itens; zero chamada extra à Clinicorp),
  com try/catch isolado como as demais fases.
- **RLS ligada nas duas tabelas, SEM policy** (só o servidor via service_role lê
  e escreve — regra de segurança do CLAUDE.md).
- `GET /api/analise-receita` (`requireAuth` + `requireGestor`): junta
  `fin_receita_analises.dados` + meta do mês + ticket (query em `orcamentos` do
  mês corrente) + dias úteis restantes calculados na hora.
- `POST /api/analise-receita/meta` (`requireAuth` + `requireGestor`):
  `{ mes: 'YYYY-MM-01', lucro_alvo: number ≥ 0 }` → upsert.
- `POST /api/analise-receita/sync` (`requireAuth` + `requireGestor`): dispara
  `fetchInadimplentesBackground()` (guard interno já impede concorrência) e
  responde 202 — botão "Atualizar dados" (obrigatório em módulo Clinicorp).

## Página `/financeiro/receita/`

Padrões da casa: `shared-nav.js` (`data-active="analise-receita"`), item novo na
seção Financeiro do `CRM_NAV` (`nav-config.js`, fonte única, roles `admin,gestor`,
`mode:'link'`), `api.js` com token `sb-*-auth-token`, retry 5xx (1,5s/3s, 2x),
Chart.js (já usado na Saúde). Sem role `mod_` nova nesta fase.

Blocos, de cima pra baixo:

1. **🫀 Faixa-síntese** — "Julho já nasceu **X% pago**" + duas barras de degrau
   (fixas / saída total) com semáforo; data da última atualização + botão
   "Atualizar dados".
2. **🎯 Meta do mês** — toggle Empatar / Empatar+lucro (campo R$ editável, salvo
   por mês); progresso: "faltam R$ X de entrada · ~N fechamentos · D dias úteis".
3. **📊 Decomposição 12m** — barras empilhadas Entrada × Recorrente + tabela.
4. **📈 Rumo ao degrau** — linha do recorrente 12m × linhas horizontais das
   réguas; texto do cruzamento.
5. **🛡️ Colchão da carteira** — área do recorrente futuro (24m) × régua 1;
   "~N meses de fixas garantidos".
6. **🧪 Qualidade do recorrente** — realização % por mês (6m), boleto × cartão.

Cada bloco com "▸ entenda" em linguagem simples. **Sem sigla financeira** (regra
do Luiz): nada de PE/MC/ROI — tudo por extenso ("ponto de equilíbrio" ok).
Números estimados sempre com o cru ao lado (ex.: "R$ 118k previstos · R$ 127k
contratados × 93% de realização").

## Erros e casos-limite

- DRE sem meses fechados suficientes → réguas indisponíveis: blocos 1/2/4/5
  degradam com aviso "réguas indisponíveis — DRE sem histórico", sem quebrar.
- Divisão por zero (ticket, razão, realização sem base) → "—" com tooltip.
- `dados` com `atualizado_em` > 36h → tarja amarela "dados desatualizados".
- Mês novo sem `lucro_alvo` → modo Empatar apenas.
- Timezone: datas via slice(0,10) ISO, padrão dos módulos financeiros.

## Testes

`lib/financeiro/receita-motor.test.js` (node:test, padrão da pasta): decomposição
(parcela 0 vs 1+, cancelada fora, sem InstallmentNumber), realização (recebida no
mês vs atrasada vs não recebida), previsto do mês, colchão (só 1+, só futuras),
rumo ao degrau (cruza / já cruzou / não cruza), meta (com e sem lucro_alvo,
progresso negativo → "meta batida").

## Fase 2 (fora deste escopo)

- Card do **Painel do Gestor** (provável: faixa-síntese "nasceu X% pago") —
  decidir depois que a página rodar.
- **Renegociados na Inadimplência**: card (R$ renegociado, reincidência) + chip
  "quebrou renegociação" na lista da CRC. Detecção: parcela cancelada + reemitida
  no mesmo `TreatmentId`+`InstallmentNumber`.
- **Análise de safra**: quanto cada mês de venda planta de recorrente futuro.
