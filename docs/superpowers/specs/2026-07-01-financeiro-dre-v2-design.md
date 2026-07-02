# Financeiro / DRE v2 — cascata, visão mensal, análises e painel de decisão

**Data:** 2026-07-01 · **Status:** aprovado pelo Luiz (opção B do brainstorm)
**Página:** `public/financeiro/index.html` (`/financeiro/`) · **Roles:** `financeiro`, `admin`, `mod_financeiro` (inalterado)

## Objetivo

Evoluir a DRE de "tabela Conta × Total" para um painel de leitura e decisão:
cascata com subtotais, uma coluna por mês, análise vertical/horizontal, média com
destaque de anomalia, drill-down até o lançamento, ponto de equilíbrio e projeção
do mês corrente.

**Fora do escopo (backlog):** metas/orçamento por grupo, gráficos de evolução,
forecast do resto do ano, faturamento×recebido, recebíveis/saídas 24m
(ver memória `project_modulo_a_receber`), regime caixa×competência.

## 1. Backend

### 1.1 RPC nova `fin_dre_agg_mensal(p_from date, p_to date)`

Cópia da `fin_dre_agg` (migração `20260615120200`) com o mês no retorno:

```sql
returns table(ym text, conta_codigo text, fluxo text, total numeric)
-- select to_char(l.data,'YYYY-MM'), c.codigo, l.fluxo, sum(l.valor)
-- ... where l.ativo = true and l.data between p_from and p_to and l.conta_id is not null
-- group by 1, 2, 3
```

Migração nova `20260701090000_financeiro_dre_mensal.sql`, aplicada via MCP.

### 1.2 Endpoint novo `GET /api/financeiro/dre-mensal?from&to`

- Mesma validação de datas e guards do `/api/financeiro/dre` (regex `YYYY-MM-DD`, `from <= to`).
- Mesmos middlewares: `requireAuth, requireFinanceiro`.
- Chama a RPC, agrupa as linhas por `ym` e roda o `montarDRE` existente
  (`lib/financeiro/dre.js`) uma vez por mês.
- Inclui também o **resumo de não categorizados** do período (count + soma de
  `fin_lancamentos` com `fluxo='sai'`, `ativo=true`, `conta_id is null`,
  `data between from/to`) para o aviso da seção 3.6.
- Resposta:

```json
{
  "meses": [ { "ym": "2026-05", "receita": ..., "grupos": [...], "resultado": ... }, ... ],
  "sem_categoria": { "qtd": 12, "total": 3450.10 }
}
```

Meses sem lançamento dentro do período entram com grupos vazios/zero (o front
itera o range de meses do filtro, não só os que a RPC devolveu).

O endpoint antigo `/api/financeiro/dre` continua existindo (não quebra nada).

### 1.3 Front — `public/js/financeiro/api.js`

`dreMensal: (from, to) => api(\`/api/financeiro/dre-mensal?from=${from}&to=${to}\`)`.

Sem outras mudanças de backend. **Drill-down usa o endpoint existente**
`/api/financeiro/lancamentos?conta_id&from&to` — o front mapeia
`codigo → conta_id` via `FinAPI.contas()` (carregado uma vez, em memória).

## 2. Cálculos (todos no front, a partir de `meses[]`)

### 2.1 Cascata com subtotais

A ordem dos grupos vem do `GRUPOS_DRE`. Linhas de subtotal intercaladas
(soma acumulada dos grupos, que já vêm com sinal do `montarDRE`):

| Degrau | Fórmula | Margem exibida |
|---|---|---|
| Receita Bruta | grupo 1 | — |
| **Receita Líquida** | + grupo 2 (impostos, negativo) | % da Receita Bruta |
| **Lucro Bruto** | + grupos 3.0, 3.1, 3.2, 3.3 | % da Receita Bruta |
| **Resultado Operacional** | + grupo 4 | % da Receita Bruta |
| **Resultado Final** | + grupos 5 e 7 | % da Receita Bruta |

Resultado Final ≡ `resultado` que o `montarDRE` já devolve (mesmo número de hoje).

### 2.2 Análise vertical (AV%)

Coluna AV% = `valor / receitaBrutaTotal` do período, para grupos, contas e
subtotais. Receita bruta 0 → exibir "–".

### 2.3 Análise horizontal (▲▼ por mês)

Em cada célula mensal (grupos e subtotais; contas também, quando expandidas):
variação % vs o mês anterior **dentro do período**. Primeiro mês do período: sem
seta. Mês anterior com valor 0: "–".
**Cor por melhor/pior, não por sinal:** linhas de receita/resultado → subir =
verde, cair = vermelho; linhas de saída (grupos 2–7) → subir (em módulo) =
vermelho, cair = verde.

### 2.4 Média do período e anomalia

- Coluna **Média** = média dos **meses completos** do período. O mês corrente,
  se incompleto (hoje < último dia), entra como coluna mas **fica fora da média
  e da anomalia** (senão contamina tudo pra baixo e acende falso alarme).
- **Anomalia** (só para contas/grupos de saída, e só quando há ≥3 meses completos):
  célula com |valor| > 125% da média → fundo âmbar; > 150% → fundo vermelho.
  Tooltip: "R$ X vs média R$ Y (+Z%)".

### 2.5 Ponto de equilíbrio (PE)

Baseado no `tipo` da taxonomia (`lib/financeiro/taxonomia.js`):

- **Variáveis:** `imposto` + `custo` (grupos 2, 3.0–3.3).
  ⚠️ Premissa a validar com o Luiz no uso real: inclui Técnicos (3.3) e MO
  dentistas-sócios (3.2.1). Se o pró-labore dos sócios for fixo na prática,
  reclassificamos depois (constante no front, fácil de mudar).
- **Fixas:** `despesa` (grupo 4).
- **Fora do PE:** `financeiro` + `investimento` (abaixo da linha operacional).

Cálculo sobre os meses completos do período:
`MC% = 1 − (|variáveis| / receitaBruta)`; `PE = |fixas médias mensais| / MC%`.
Guardas: receita 0 ou MC% ≤ 0 → card mostra "–" com aviso "margem de
contribuição não positiva no período".

### 2.6 Projeção do mês corrente (run-rate)

Só quando o período inclui o mês corrente e ele está incompleto:

- **Receita projetada** = receita até agora ÷ dias corridos × dias do mês.
- **Variáveis projetadas** = receita projetada × (% variáveis médio dos meses
  completos do período; fallback: % do próprio mês parcial).
- **Fixas projetadas** = média das fixas dos meses completos do período
  (fallback, se não houver nenhum: fixas do mês parcial ÷ dias corridos × dias
  do mês — pior aproximação, marcada no tooltip).
- **Resultado projetado** = receita − variáveis − fixas (financeiras/invest.
  ficam fora, com nota no tooltip).

## 3. UI

Mantém o visual atual (tema claro/escuro, DM Sans, `shared-nav.js`). Vanilla,
sem lib nova.

### 3.1 Cards de KPI (topo, acima da tabela)

1. **Receita Bruta** (total do período)
2. **Resultado Final** (total + margem líquida %)
3. **Ponto de equilíbrio**: "Faturamento mínimo/mês: R$ X" + no mês corrente,
   barra de progresso `receita do mês / PE` (verde quando ≥100%)
4. **Projeção do mês** (condicional, seção 2.6) com selo "projeção"
5. **Maior desvio**: conta de saída com maior estouro % vs média no último mês
   completo — clicável → abre o drill-down. Some se não há ≥3 meses completos.

### 3.2 Tabela

- Colunas: `Conta | <um mês por coluna> | Média | Total | AV%`.
  Com 1 mês selecionado: `Conta | Total | AV%` (sem Média, sem ▲▼).
- Linhas: grupos **colapsados por padrão** (chevron ▸ expande as contas);
  estado de expansão lembrado em `localStorage`. Subtotais da cascata em
  destaque (linha mais escura + margem % pequena abaixo do valor).
- Célula mensal: valor + ▲▼% pequeno embaixo (seção 2.3) + fundo de anomalia
  (seção 2.4).
- Scroll horizontal no wrapper quando não couber (`min-width` por coluna);
  primeira coluna (Conta) fixa (`position: sticky; left: 0`).

### 3.3 Drill-down

Clicar no valor de uma **conta** (não grupo) em um mês → modal com os
lançamentos daquela conta naquele mês (`data`, `descricao`, `valor`),
ordenados por valor desc, com soma no rodapé (deve bater com a célula).
Clicar na coluna Total → lançamentos do período inteiro. Fonte:
`FinAPI.lancamentos({ conta_id, from, to })` (limite 2000 — suficiente para
1 conta/mês; se vier 2000, mostrar aviso "lista truncada").

### 3.4 Filtros

Mantém `De`/`Até` (inputs `type=month`) + "Ver DRE" + "Atualizar dados".
Período máximo: 24 meses (guarda no front com mensagem).

### 3.5 Erros

Como hoje: mensagem no `#dreMsg`. Falha no drill-down → toast/mensagem dentro
do modal, sem derrubar a tabela.

### 3.6 Aviso de não categorizados

Se `sem_categoria.qtd > 0`: faixa âmbar acima da tabela —
"⚠️ N lançamentos sem categoria no período (R$ X fora da DRE)" com link para
`/financeiro/a-categorizar.html`. Sem isso a DRE superestima o resultado em
silêncio.

## 4. Testes

- `lib/financeiro/dre-mensal.test.js` (ou extensão do `dre.test.js`): agrupamento
  por mês reusa `montarDRE` — testar o agrupador do endpoint (função pura extraída
  para `lib/financeiro/` — ex.: `montarDREMensal(rows)`).
- Funções puras de front testáveis em Node (mesmo padrão dos módulos em
  `lib/financeiro/`): cascata/subtotais, AV%, horizontal (cores melhor/pior),
  média excluindo mês parcial, anomalia, PE (incl. guardas MC≤0), run-rate
  (incl. fallbacks). **Decisão:** colocar em `lib/financeiro/dre-analise.js` +
  `.test.js`, escrito para rodar nos dois mundos: exporta via
  `if (typeof module !== 'undefined') module.exports = ...` (testes Node) e
  define `window.DREAnalise` quando há `window` (a página inclui o arquivo com
  `<script src="/lib-financeiro/dre-analise.js">` — servir via rota estática ou
  cópia em `public/js/financeiro/`; preferir **cópia única em
  `public/js/financeiro/dre-analise.js`** com o teste importando esse caminho,
  para não criar rota estática nova).
- Smoke manual: 1 mês, 3+ meses, período com mês corrente parcial, período sem
  lançamentos, conta com lançamento estornado.

## 5. Riscos / decisões registradas

- **Classificação variável×fixo do PE é premissa** (seção 2.5) — validar com uso.
- Anomalia por limiar fixo (125%/150%) é heurística inicial; calibrar depois.
- Run-rate linear por dias corridos ignora sazonalidade intra-mês (dias úteis,
  picos de início de mês) — aceito para v1, o selo "projeção" comunica.
- `montarDRE` faz matching de grupo por prefixo do título — inalterado, os
  subtotais são calculados sobre os totais de grupo já prontos.
