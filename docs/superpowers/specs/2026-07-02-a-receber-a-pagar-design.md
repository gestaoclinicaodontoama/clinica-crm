# Módulo "A Receber / A Pagar" — saúde financeira 24 meses

**Data:** 2026-07-02 · **Status:** aprovado no brainstorm (Luiz) · **Página:** `/financeiro/saude/`

## Objetivo

Mostrar, mês a mês pelos próximos 24 meses, quanto a clínica tem **a receber** (parcelas de pacientes a vencer) contra quanto tem **a pagar** (contas lançadas no Clinicorp), como medida de saúde financeira. Decisões do brainstorm: agregado mensal (sem drill conta a conta), **sem** linha acumulada, **sem** caixa inicial manual, página própria no menu Financeiro.

## Fonte de dados (validada ao vivo em 2026-07-02)

`GET /financial/list_cash_flow?from=<hoje>&to=<fim do 24º mês à frente>` — **1 chamada cobre a janela inteira** (barato para o rate limit de 25/h).

- `in_forecast` = a receber do mês (parcelas a vencer já contratadas).
- `out_forecast` = a pagar do mês (contas lançadas com vencimento futuro).
- Semântica: é o **já contratado/lançado**, não previsão de vendas. Meses distantes caem naturalmente — para "compromissos assumidos" isso é o correto.
- ✅ Testado jul–dez/2026: out_forecast R$170k–215k/mês, in_forecast R$90k–153k/mês. Virada de ano (nov/26–mar/27) funciona.
- ⚠️ **A resposta NÃO tem ano** — cada item vem só com `month:"July"`. A ordem é cronológica a partir do `from`; o ano é derivado da **posição** no array + mês do `from`. (Pegadinha central do parser.)
- ⚠️ **Mês corrente** vem com `in`/`out` (realizado) E `in_forecast`/`out_forecast` (pendente restante). Usamos só os forecasts — o painel é "o que ainda vai acontecer".
- ⚠️ `list_summary` de mês futuro retorna vazio — **não existe detalhe conta a conta** disponível hoje. Drill do a pagar fica fora do escopo até acharmos o endpoint (3 dos 6 endpoints `financial` seguem não mapeados; pedir swagger ao suporte Clinicorp quando oportuno).
- ⚠️ **Horizonte de lançamento assimétrico**: out_forecast despenca após ~6 meses (dez/26 R$194k → fev/27 R$51k) porque as contas a pagar são lançadas com horizonte mais curto que os recebíveis. Sem aviso, os meses distantes parecem artificialmente saudáveis → a página exibe uma **nota fixa** explicando isso.
- ⚠️ **Horizonte real: a API devolve no máximo ~12 meses de forecast** (descoberto na implementação, 2026-07-02: janela pedida de 25 meses retornou 12 itens, jul/26→jun/27). O sync continua pedindo 24m — se a Clinicorp estender, ganhamos de graça — e a UI mostra o horizonte disponível dinamicamente ("próximos N meses"). Se o Luiz quiser 24m de verdade no lado receber, complementar depois com agregação por DueDate do `/payment/list` (fase futura).

## Dados

Migração `20260702100000_fin_fluxo_futuro.sql`:

```sql
create table fin_fluxo_futuro (
  mes date primary key,            -- dia 1 do mês
  a_receber numeric not null default 0,
  a_pagar numeric not null default 0,
  atualizado_em timestamptz not null default now()
);
-- RLS no mesmo padrão das demais tabelas fin_* (acesso via service role do servidor)
```

Mesma migração cria RPC `fin_vencido_total()` → `sum(total_vencido)` de `pacientes_financeiro` (SUM no SQL — o client JS trunca em 1000 linhas, nunca somar no JS).

## Sync

Nova função `syncFluxoFuturo()` em `sync/financeiro-sync.js` (exportada ao lado de `syncPeriodo`):

1. Janela: `from` = hoje (fuso BR, via `dataLocal`), `to` = último dia do 24º mês à frente.
2. 1 chamada `list_cash_flow`; parse com derivação de ano pela posição (lib pura, ver abaixo).
3. Upsert por `mes` (24–25 linhas) + delete de tudo FORA da janela `[mês corrente, 24º mês]` — limpa o passado e qualquer linha órfã além do horizonte (a tabela guarda só o futuro; sem histórico de snapshots — YAGNI).

Chamadas:
- **Sync diário 02h**: novo bloco `try/catch` próprio ao lado do `syncFinanceiro` existente (server.js ~4470) — erro não derruba as demais fases.
- **`POST /api/financeiro/sync`** (botão "Atualizar dados", mesmo endpoint que a DRE já usa): passa a rodar também o `syncFluxoFuturo`.

## Backend

`GET /api/financeiro/saude` — `requireAuth, requireFinanceiro`. Lê `fin_fluxo_futuro` (ordenado por mês) + `fin_vencido_total()`. Responde:

```json
{ "meses": [{ "mes": "2026-07", "a_receber": 153087.75, "a_pagar": 170368.61 }],
  "vencido": 279000, "atualizado_em": "..." }
```

Zero chamada Clinicorp ao vivo na página. Se a tabela estiver vazia (pré-primeiro-sync), `meses: []` e o front orienta clicar em "Atualizar dados".

## Lib pura + testes

`lib/financeiro/fluxo-futuro.js` (padrão dual browser/Node dos demais):
- `parseCashFlow(resposta, fromISO)` → `[{mes:'YYYY-MM', a_receber, a_pagar}]` — derivação do ano pela posição; ignora meses fora da janela.
- `totais(meses)` → `{ receber, pagar, diferenca }`.

`fluxo-futuro.test.js`: virada de ano, array vazio, mês corrente, janela de 24 meses.

## Front — `/financeiro/saude/`

`public/financeiro/saude/index.html` + `saude-page.js`, tema claro/escuro do sistema, sidebar via `shared-nav.js` (item novo SÓ em `nav-config.js`):

```js
{ slug: 'financeiro-saude', label: 'A Receber / A Pagar', roles: 'financeiro,mod_financeiro', mode: 'link', href: '/financeiro/saude/' }
```

(entra na seção `financeiro-sec`, abaixo de "Financeiro (DRE)")

1. **Cards:** Total a receber 24m · Total a pagar 24m · Diferença (verde se ≥0, vermelho se <0) · **Vencido a receber** (dinheiro parado; link abre a aba Inadimplentes do CRM — deep-link do index, mesmo mecanismo da sidebar).
2. **Gráfico de barras** (Chart.js, já no projeto): receber × pagar lado a lado, 24 meses.
3. **Tabela mensal:** mês · a receber · a pagar · diferença; linha destacada quando pagar > receber.
4. **Nota fixa** sobre o horizonte assimétrico ("contas a pagar são lançadas com poucos meses de antecedência; meses distantes mostram menos saída do que haverá").
5. Botão **"Atualizar dados"** → `POST /api/financeiro/sync` (padrão da DRE) + recarrega.

## Fase 2 — receber em 24 meses de verdade (2026-07-02, pedido do Luiz no mesmo dia)

O lado **a receber** deixou de usar o `in_forecast` do cash_flow (limitado a ~12m) e passou
a vir das **parcelas do `/payment/list` agrupadas por mês de vencimento** — a mesma fonte
do `pacientes_financeiro`, reaproveitando os MESMOS itens que o `fetchInadimplentesBackground`
já baixa (zero chamadas extras à API):

- Lib: `agruparParcelasPorMes(items, hojeISO)` → range completo `[mês corrente, +24m]` (25
  entradas) com zeros; mesmos fallbacks de campo e critério de "recebida" do
  `atualizarPacientesFinanceiro`; vencidas (due < hoje) ficam FORA (são o card Vencido).
- Tabela: `fin_recebiveis_mensal (mes date pk, valor, atualizado_em)` — migração
  `20260702110000`. Escrita por `atualizarRecebiveisMensais()` dentro do
  `fetchInadimplentesBackground` (sync 02h + abrir Inadimplentes + botão da página).
- Endpoint `/saude`: `a_receber` = fin_recebiveis_mensal (24m); `a_pagar` = fin_fluxo_futuro
  (~12m), **null além do horizonte** (a UI mostra "—", não zero falso). Fallback: se
  fin_recebiveis_mensal ainda estiver vazio, serve o comportamento antigo (in_forecast).
- Botão "Atualizar dados": além do sync da DRE + fluxo, dispara `fetchInadimplentesBackground`
  em background (fire-and-forget; guard `_inadimplentesRefreshing` impede concorrência —
  são 12 chamadas /payment/list, por isso não é await).
- Página: card A receber = 24m; A pagar e Diferença calculados só nos meses COM previsão de
  saída (subtítulos dinâmicos); tabela com "—" nos meses sem dado de pagar; header mostra
  o range real ("jul/26 → jul/28").
- `fin_fluxo_futuro.a_receber` (in_forecast) continua sendo gravado (cross-check/fallback),
  mas a página não o usa quando há recebíveis.

## Fora de escopo (registrado, não construído)

- Drill conta a conta do a pagar (sem endpoint hoje).
- Linha de saldo acumulado / caixa inicial manual (Luiz optou pelo simples).
- Previsão do resto do ano e faturamento×recebido — seguem no backlog da DRE.

## Critérios de aceite

1. Sync das 02h (ou botão) popula `fin_fluxo_futuro` com todos os meses que a API devolver (hoje 12); os valores batem com a API na data do teste.
2. Página carrega para role `mod_financeiro`; cards, gráfico e tabela consistentes entre si (mesmos números).
3. Card Vencido bate com `sum(total_vencido)` feito direto no SQL.
4. Virada de ano correta na tabela (jan/2027 após dez/2026, não "January/2026").
5. Testes da lib pura verdes.
