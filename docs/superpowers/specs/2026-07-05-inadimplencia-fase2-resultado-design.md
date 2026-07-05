# Inadimplência 2.0 — Fase 2 — Resultado da Cobrança

> Spec de design (brainstorm 2026-07-05). Segue a Fase 0+1 (já no ar). Entrega a
> **opção 3 (medir resultado)**: uma seção nova "Resultado da Cobrança" no topo da aba
> Inadimplência, com painel de recuperação, curva do vencido no tempo e um aging compacto.
> **Tudo aditivo — nada é removido do módulo A Receber / A Pagar.**

## Objetivo

Responder, dentro da própria Inadimplência: **a cobrança está funcionando?** Quanto entrou
em atraso, quanto foi recuperado, a que taxa, e se a carteira vencida está encolhendo ou
crescendo. Hoje o módulo mostra *quem* cobrar, mas não mede *resultado*.

## Decisão de escopo (mudança em relação à Fase 0+1)

A Fase 0+1 previa **relocar** aging/taxa de perda do A Receber para cá. Isso **mudou**:
uma sessão paralela deployou (05/07) um **"Diagnóstico da Saúde Financeira"** no A Receber
(`public/js/financeiro/diagnostico-saude.js` + `saude-page.js`) que interpreta justamente
aging, taxa de perda, concentração, renovação e tendência (semáforo + "entenda"). Ou seja,
essas métricas **ganharam um lar e um propósito** no A Receber. Mover quebraria essa feature
recém-lançada.

**Decisão (aprovada): não mover. Espelhar compacto.** As métricas de carteira permanecem no
A Receber; a Inadimplência ganha o que é genuinamente novo (painel de recuperação, curva do
vencido) e um **aging compacto espelhado da mesma lib** (`lib/financeiro/analise-parcelas.js`),
sem duplicar cálculo nem remover nada de lá.

## Fonte de dados

Tudo sai dos **mesmos itens de 24 meses do `/payment/list`** que o `fetchInadimplentesBackground`
já coleta. **Zero chamada nova à Clinicorp.** Cada parcela traz `DueDate`, `ReceivedDate`,
`PaymentReceived`, `Amount/AmountWithDiscounts/TotalPostAmount` — suficiente para reconstruir
os fluxos e a curva retroativamente.

## Componentes da seção "Resultado da Cobrança"

### 1. Painel de recuperação (o coração)

Por mês (últimos 12), por **coorte do mês de vencimento**:

- **Venceu e atrasou (R$)** — parcelas cujo vencimento cai no mês M e que **furaram o prazo**
  (não recebidas, ou recebidas depois do vencimento: `ReceivedDate > DueDate`).
- **Já recuperado (R$ e %)** — dessas, quanto **já foi pago** até hoje (mesmo atrasado).
- **Taxa de recuperação do mês** = recuperado ÷ venceu-e-atrasou (por coorte).
- **Manchete:** taxa geral de recuperação (soma das coortes maduras) + se está melhorando.

Visual: barras mensais em **SVG inline** (venceu-e-atrasou × recuperado, lado a lado).

⚠️ **Coorte imatura:** meses recentes ainda estão em cobrança, então sua taxa aparece
naturalmente mais baixa (parte ainda vai ser recuperada). A UI deve sinalizar os meses
recentes como "ainda em cobrança" (ex.: barra mais clara / nota), para não ler como piora.

### 2. Curva do vencido no tempo

Saldo **vencido em aberto no fim de cada mês**, reconstruído retroativamente (24 meses):
no fim do mês X, parcelas com `DueDate <= X` e ainda não recebidas até X
(`não recebida` ou `ReceivedDate > X`). Linha em **SVG inline**. Responde: "a carteira
vencida está encolhendo ou crescendo?".

**Decisão (ajuste da revisão):** usar **apenas a reconstrução retroativa** (método único,
consistente, 24 pontos mensais já disponíveis). **Não** misturar com o snapshot diário
`fin_saude_snapshots` (só 4 dias hoje) — a mistura criaria uma descontinuidade no ponto de
junção. O snapshot diário fica como **evolução futura** (granularidade diária) quando
acumular história real.

⚠️ **Aproximação:** parcelas renegociadas/canceladas somem do `/payment/list` atual, então
a reconstrução histórica subestima levemente meses antigos — mesma limitação que o
`carteiraRetroativa` do A Receber já assume. Documentar na UI (nota discreta).

### 3. Aging compacto (espelhado)

As faixas de atraso (1–30 / 31–60 / 61–90 / 91–180 / 180+) numa **barra horizontal
compacta**, vindas de `analise-parcelas.agingVencido(items, hoje)` — a **mesma função** que
o A Receber usa. Sem duplicar cálculo, sem remover de lá. Só o "quanto do vencido está em
cada idade", em forma resumida, ao lado do painel de recuperação.

## Arquitetura

- **Lib pura nova** `lib/financeiro/recuperacao.js` (padrão de `analise-parcelas.js`, testada):
  - `recuperacaoPorMes(items, hojeISO, nMeses = 12) -> [{ mes, atrasou, recuperado, taxa }]`
  - `vencidoRetroativo(items, hojeISO, nMeses = 24) -> [{ mes, vencido }]`
  - Puras: recebem os itens crus + data `YYYY-MM-DD`, normalizam `.slice(0,10)`, arredondam
    a 2 casas. Sem IO, sem relógio além do `hoje` passado.
- **Aging:** reusar `analise-parcelas.agingVencido` — não reimplementar.
- **Server:** dentro do `fetchInadimplentesBackground` (que já tem `allItems` de 24m), após
  montar os grupos, calcular `resultado = { recuperacao: recuperacaoPorMes(...), vencido:
  vencidoRetroativo(...), aging: agingVencido(...) }` e anexá-lo ao objeto do cache
  (`processado.resultado`). `mergeInadimplentesNotas` faz `{ ...resultado, grupo1: ... }`,
  então `resultado` sobrevive intacto até a resposta do `/api/inadimplentes`. **Nenhum
  endpoint novo, nenhuma chamada Clinicorp nova.**
- **Frontend (SPA `public/index.html`, aba `page-inadimplentes`):** seção nova "Resultado da
  Cobrança" no topo da aba (antes dos cards/grupos), lendo `data.resultado`. Gráficos em
  **SVG inline** (barras + linha) — **sem Chart.js** (o A Receber usa Chart.js via CDN numa
  página separada; a SPA fica leve, sem novo script externo). Helpers de render próprios.

## Isolamento e testes

- A lib nova tem uma responsabilidade só (agregar recuperação/vencido) e é testável isolada.
- **TDD** nas duas funções puras: coortes de recuperação (atrasou/recuperado/taxa, incluindo
  coorte imatura e mês sem atraso → taxa null/0), e curva do vencido (parcela recebida em dia
  não conta; recebida atrasada conta como vencida até a data de recebimento).
- Frontend verificado manualmente (login → Inadimplência → seção nova) pós-deploy — o padrão
  do projeto (sem harness de front).

## Fora de escopo (YAGNI)

- Não mover nada do A Receber (decisão acima).
- Sem snapshot diário na curva agora (fica pra quando acumular história).
- Sem drill por mês/paciente no painel de recuperação (é visão agregada; drill = fase futura).
- Fases 3 (ponto de desistência) e 4 (forma de pagamento) seguem como planos próprios depois.

## Dependências / riscos

- Depende de os itens de `/payment/list` continuarem trazendo `ReceivedDate`/`DueDate`
  (confirmado na Fase 0+1).
- A aproximação retroativa (renegociação/cancelamento) é aceitável e documentada.
- Peso da SPA: SVG inline evita novo script; manter os helpers pequenos e focados.
