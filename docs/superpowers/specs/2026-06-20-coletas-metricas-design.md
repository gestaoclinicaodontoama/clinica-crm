# Coletas de Métricas — Design

**Data:** 2026-06-20
**Status:** Aprovado em brainstorm, aguardando revisão do spec
**Autor:** Claude + Luiz

---

## Contexto e problema

A Central de Tarefas atual modela tarefa como "título + um resultado" (`check` ou um único `numero`).
Isso é rígido demais para acompanhar a operação da clínica. O caso que motivou este projeto:

> Ao fim do dia, o gestor quer saber da CRC de leads: **quantas ligações foram feitas, quantos leads
> foram agendados e quantos compareceram** — e ver a **evolução disso ao longo da semana/mês**, com as
> **taxas de conversão** (% que agenda, % que comparece). As CRCs preencheriam isso em momentos do dia
> (ex.: antes do almoço e antes de ir embora).

Hoje não há como: (a) capturar **vários números juntos** num lançamento, (b) **somar lançamentos** do dia,
nem (c) ver **gráfico de evolução + funil**. Este projeto resolve exatamente isso.

## Visão maior e decomposição

"Algo nível Monday.com" foi decomposto em sub-projetos independentes. Este documento cobre **apenas o
Sub-projeto 1**, que é a fundação e o de maior valor imediato:

- **Sub-projeto 1 (ESTE):** Coletas de métricas — tarefas com vários campos numéricos + dashboard de
  evolução e funil de conversão.
- **Sub-projeto 2 (futuro):** Visões visuais — Kanban arrastável, calendário, carga por pessoa.
- **Sub-projeto 3 (futuro):** Automações — "quando X, faça Y" (ex.: comparecimento abaixo da meta → avisa
  gestor no WhatsApp).

Cada sub-projeto seguinte tem seu próprio spec quando chegar a vez.

## Objetivos (v1)

1. Gestor cria/edita **coletas** definindo livremente os campos a preencher (não chumbados no código).
2. Múltiplas coletas diferentes coexistem (CRC Leads, Discador, etc.), cada uma com seus campos e funil.
3. CRC preenche por **períodos** no dia (ex.: manhã e fim do dia); os lançamentos **somam** no total do dia.
4. Períodos são configuráveis **por dia da semana** (resolve sábado meio período).
5. Cards de coleta ficam disponíveis **desde o começo do dia** (não travados pelo horário).
6. Lembrete/alerta com **horário configurável, com exceção por pessoa**.
7. Dashboard do gestor: **totais, funil de conversão, evolução no tempo, e quebra por pessoa**.
8. CRC pode ver o próprio dashboard (liberação opcional por coleta).
9. Agregações feitas **no SQL do servidor** (não somar no navegador — evita o limite de 1000 linhas do Supabase).

## Não-objetivos (v1) — deferidos

- **Metas por campo** (ex.: 40 ligações/dia) e visualização de progresso/atingimento. *Deixamos um gancho
  barato no banco, mas sem UI nem gráfico de meta.*
- **Ranking/gamificação** dedicado entre CRCs (a tabela "por pessoa" já entrega ~90% disso).
- **Comparar dois períodos** (esta semana vs passada).
- **Exportar CSV/Excel.**
- Tipos de campo **dropdown/seleção** e **sim/não** (v1 fica em número, decimal/R$ e texto).
- **Integração automática com o CRM** para pré-preencher valores (ver "Visão futura").

## Visão futura (Fase 2) — registrar, não construir agora

Mais à frente, as métricas devem vir **direto do CRM**, que já registra esses dados. A CRC passaria de
*digitar* para apenas *confirmar* os valores puxados automaticamente. Hoje está bloqueado porque o sistema
de ligação ainda não está em uso pleno (a forma atual da ligação é um problema à parte).

**Acomodação de design já no v1 (custo zero):** cada lançamento guarda sua **origem** (`manual` por agora).
Quando a integração existir, o sistema pré-preenche e marca origem `auto`/`confirmado`, sem reescrever o
modelo de dados.

---

## Conceito central

Uma **Coleta** é um tipo novo de tarefa, construído **estendendo** o que já existe (`task_templates` +
`tasks` + geração diária + atribuição por cargo/pessoa + cron). Nada de sistema paralelo.

- O **template da coleta** (criado pelo gestor) define as métricas, as conversões, os períodos e para quem.
- Cada **período** configurado gera, por dia, **um card de tarefa** na tela "Hoje" da pessoa.
- Abrir o card mostra um **mini-formulário** com os campos; salvar grava os números e conclui o card.
- O **total do dia** é a soma dos lançamentos do dia; o **gráfico** soma ao longo do tempo.

---

## Modelo de dados

Sem tabelas novas. Apenas colunas adicionais (aditivo, não quebra o existente).

### `task_templates` (colunas novas)

- `tipo` text — `'tarefa'` (padrão, comportamento atual) ou `'coleta'`.
- `metricas` jsonb — lista ordenada de campos a preencher. Cada item:
  ```json
  { "chave": "ligacoes", "rotulo": "Ligações", "tipo_campo": "numero", "unidade": null, "ordem": 1, "meta": null }
  ```
  - `tipo_campo`: `"numero"` | `"decimal"` | `"texto"`.
  - `meta`: gancho deferido (sempre `null` no v1).
- `conversoes` jsonb — pares que viram taxa no funil. Cada item:
  ```json
  { "de": "ligacoes", "para": "agendados", "rotulo": "Taxa de agendamento" }
  ```
- `periodos` jsonb — momentos de cobrança no dia. Cada item:
  ```json
  { "chave": "manha", "rotulo": "Manhã", "dias_semana": [1,2,3,4,5,6], "hora_aviso": "12:00",
    "avisos_por_pessoa": { "<person_id>": "11:30" } }
  ```
  - `dias_semana`: 0=domingo … 6=sábado. Período só gera card nos dias listados.
  - `hora_aviso`: horário padrão do lembrete (HH:MM, fuso BR). `null` = sem lembrete.
  - `avisos_por_pessoa`: overrides opcionais por pessoa.
- `ver_proprio` boolean — se `true`, a pessoa atribuída vê o próprio dashboard. Default `false` (só gestor).

`task_templates` mantém as colunas atuais de atribuição/recorrência (`escopo`, `role`, `owner_id`,
`assignee_ids`, `frequencia`, `dias_semana`, `dia_mes`). Para coletas, a recorrência efetiva por dia é
determinada por `periodos[].dias_semana` (a coleta "vale hoje" se algum período vale hoje).

### `tasks` (colunas novas)

- `valores` jsonb — valores preenchidos no lançamento, ex.: `{ "ligacoes": 20, "agendados": 5, "compareceram": 0 }`.
- `periodo` text — `chave` do período que gerou o card (ex.: `"manha"`). `null` em tarefas comuns.
- `origem` text — `'manual'` no v1 (gancho para `auto`/`confirmado` na Fase 2).

`tasks.tipo_resultado` continua existindo para tarefas comuns; para coletas ele é irrelevante (os campos
vivem em `metricas`/`valores`).

### Constraints / migração

- Migração aditiva: `add column if not exists` para todas as colunas acima.
- `tasks.tipo` (já existe: `'rotina'`/`'pontual'`) **não** é o mesmo que `task_templates.tipo`. Para não
  confundir, o discriminador de coleta fica em `task_templates.tipo` e é propagado ao gerar o card via uma
  flag/coluna — usar `tasks.periodo IS NOT NULL` como sinal de "card de coleta" (simples e suficiente).
- Índice único parcial para evitar cards duplicados por período (corrige a corrida de geração já existente):
  ```sql
  create unique index if not exists tasks_coleta_periodo_uniq
    on public.tasks (template_id, assignee_id, data_ref, periodo)
    where periodo is not null;
  ```

---

## Tipos de campo (v1)

| tipo_campo | UI de preenchimento        | Agregação no dashboard            |
|------------|----------------------------|-----------------------------------|
| `numero`   | input numérico inteiro     | soma                              |
| `decimal`  | input numérico decimal/R$  | soma                              |
| `texto`    | input de texto curto       | não agrega (aparece no detalhe)   |
| (calculado)| — (não preenchido)         | taxa de conversão, exibida no funil |

---

## Construtor de coleta (gestor)

Tela na Gestão de Tarefas. Permite:

- Nome da coleta + descrição.
- **Campos**: adicionar/remover/renomear livremente; escolher `tipo_campo` e unidade; reordenar.
- **Conversões**: escolher pares `de → para` entre os campos numéricos e dar um rótulo.
- **Períodos**: adicionar períodos (rótulo, dias da semana, horário de aviso padrão).
- **Atribuição**: por cargo (`role`) ou pessoas específicas (`assignee_ids`) — reusa o seletor atual.
- **Ver próprio**: liga/desliga a visão do dashboard para a pessoa atribuída.
- (Override de horário por pessoa pode ficar numa ação secundária por pessoa; v1 mínimo aceita só o padrão,
  com os overrides preenchíveis depois — campo já existe no modelo.)

Permissão: criar/editar/excluir coleta = `admin`/`gestor`.

---

## Geração e recorrência

Estende `lib/tarefas/geracao.js` + cron existente.

- Na geração do dia para uma pessoa, para cada template de coleta atribuído a ela:
  - Para cada `periodo` cujo `dias_semana` inclui o dia-da-semana de hoje → gerar um card de tarefa
    (`titulo = "<coleta> — <rótulo do período>"`, `periodo = chave`, `status = pendente`, `valores = {}`).
  - Idempotência garantida pelo índice único `(template_id, assignee_id, data_ref, periodo)`.
- Cards nascem **na geração matinal** (e on-demand quando a pessoa abre "Hoje"), independentemente do
  horário do período → ficam disponíveis o dia todo.
- **Lembrete:** o cron (já roda a cada 15 min) verifica períodos cujo `hora_aviso` (ou override da pessoa)
  passou e cujo card ainda está pendente e não avisado → cria notificação. Marca um campo de "avisado"
  para não repetir (reusar/estender o padrão de `prazo_avisado_em`).

---

## Fluxo da CRC (preenchimento)

Tela "Hoje" atual, sem tela nova.

- Card aparece como `📊 Coleta CRC Leads — Manhã  [Preencher]`.
- Clicar abre mini-formulário (modal ou inline) com os campos definidos no template:
  ```
  Coleta CRC Leads — turno Manhã
    Ligações      [  20 ]
    Agendados     [   5 ]
    Compareceram  [   0 ]
                [ Salvar lançamento ]
  ```
- Salvar → card vira ✅ concluído; `valores` gravado; `origem = 'manual'`.
- Abaixo do card, **acumulado do dia** (soma dos lançamentos do dia + taxas):
  `Hoje até agora: 35 ligações · 8 agendados · 4 compareceram — 23% agendou · 50% compareceu`.
- **Editar/corrigir:** reabrir o lançamento (igual reabrir tarefa) e salvar de novo.
- **Esqueceu a manhã:** card fica "atrasado" como qualquer tarefa; ainda dá pra lançar.
- Número de cards no dia = número de períodos que valem para aquele dia da semana.

---

## Dashboard do gestor

Seção "Coletas" na Gestão de Tarefas. Controles no topo: **coleta**, **período de tempo**
(esta semana / mês / personalizado), **quem** (equipe toda ou uma pessoa).

Quatro blocos:

1. **Totais do período** — soma de cada métrica numérica no escopo.
2. **Funil de conversão** — etapas (campos numéricos) com as taxas configuradas em `conversoes`.
3. **Evolução no tempo** — gráfico por dia (ou por semana se o período for longo), com toggle por métrica.
   Ao olhar **um dia + uma pessoa**, detalha **manhã × tarde** (usa `periodo`).
4. **Por pessoa** — tabela de cada pessoa com seus totais e taxas.

- A CRC, se `ver_proprio = true`, acessa o mesmo dashboard travado nela mesma.
- **Fonte de dados:** agregação **no SQL** somando o jsonb `valores` (via RPC/SQL no servidor), nunca
  trazendo todas as linhas para o cliente. Endpoint dedicado (ex.: `GET /api/coletas/:templateId/dashboard`).

---

## Componentes / arquivos (visão preliminar)

Backend:
- Migração SQL: colunas novas + índice único.
- `lib/tarefas/geracao.js`: estender para gerar um card por período aplicável.
- `lib/tarefas/recorrencia.js`: helper "período vale hoje?" (por `dias_semana`).
- `server.js`: endpoints de coleta (CRUD do template de coleta; submit de lançamento via PATCH existente;
  dashboard com agregação SQL; lembrete no cron).

Frontend:
- `public/js/tarefas/central.js`: render do card de coleta + mini-formulário + acumulado do dia.
- `public/js/tarefas/gestao.js`: construtor de coleta + dashboard (gráfico/funil/tabela).
- Biblioteca de gráfico leve (a definir no plano; preferir algo sem peso, ex.: Chart.js via CDN ou SVG próprio).

## Testes

- **Unitário (lib):** "período vale hoje?" por dia da semana (incl. sábado só manhã); geração cria N cards
  por períodos aplicáveis; idempotência (rodar 2x não duplica).
- **Unitário (agregação):** soma de `valores` por dia/pessoa e cálculo de taxas de conversão a partir de
  lançamentos fixos.
- **Borda:** lançamento parcial (só manhã); correção via reabrir; coleta sem conversões; campo texto não
  entra na agregação numérica.

## Riscos / decisões em aberto para o plano

- Escolha da lib de gráfico (peso vs. recursos).
- Forma exata da agregação SQL sobre jsonb (função SQL dedicada vs. query parametrizada).
- Onde exatamente o override de horário por pessoa entra na UI do construtor (v1 pode aceitar só o padrão e
  deixar override para ajuste fino posterior — modelo já suporta).
