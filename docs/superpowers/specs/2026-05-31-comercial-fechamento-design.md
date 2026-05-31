# Dashboard Comercial — Sub-projeto 1: Fechamento, Entrada e Tempos por Fase

**Data:** 2026-05-31
**Status:** Design aprovado (decisões via brainstorming) — aguardando revisão do spec
**Pré-requisito:** Dashboard Comercial v1 já deployado (commit a9cb7a1). Spec base: `2026-05-31-dashboard-comercial-design.md`.

## Objetivo

Corrigir 3 distorções do funil v1 e adicionar analytics de fechamento:

1. **Descasamento de tempo:** quem foi avaliado num mês e fechou em outro precisa contar no **mês do fechamento**. Hoje o funil amarra tudo à coorte da avaliação e some com esses fechamentos.
2. **Convênio polui os valores:** os orçamentos incluem procedimentos de convênio (`BillType=CLAIM`). O objetivo comercial é **só particular**.
3. **Ruído na agenda do avaliador:** a equipe marca pacientes que não são para orçamento (encaixe/retorno), inflando agendamentos/comparecimentos.

E adicionar: **entrada** (1º pagamento, automático do Clinicorp), **tempos por fase** da jornada, e o bloco **"Fechamentos do mês"**.

## Decisões (definidas com o usuário)

| Tema | Decisão |
|---|---|
| Avaliação válida | Só conta avaliação se o paciente tem **orçamento particular criado** a partir da data da consulta (janela 60 dias). |
| "Fechou" | Orçamento **particular APPROVED**. Data de fechamento = `LastChange_Date`. |
| Valor fechado | Soma dos procedimentos **não-convênio** (não-`CLAIM`) do orçamento. |
| Entrada | **Primeiro pagamento** do paciente a partir da data do orçamento (`/payment/list`). |
| Convênio | **Fora deste dashboard** (tratado em outro lugar). |
| Estrutura | Topo do funil por **mês da avaliação**; bloco **"Fechamentos do mês"** por **data de fechamento**. |
| Conferência | Valores automáticos **rotulados "pendente de conferência"**. Portão de aprovação da CRC fica no **Sub-projeto 2**. |
| Cross-coorte | **Não** exibir um "% de conversão" que cruze comparecimento de um mês com fechamento de outro (engana). |

## Modelo de dados

### Migração `..._comercial_fechamento.sql`

**`orcamentos`** — novas colunas:
- `data_fechamento date` — `LastChange_Date` quando `Status='APPROVED'`, senão null
- `valor_particular numeric(12,2) not null default 0` — soma dos procedimentos não-convênio
- `eh_convenio boolean not null default false` — true quando `valor_particular = 0` e havia procedimentos (orçamento 100% convênio)
- `entrada_valor numeric(12,2)` — valor do 1º pagamento (nullable até casar)
- `entrada_data date` — data do 1º pagamento

**`avaliacoes`** — novas colunas:
- `agendado_em timestamptz` — `CreateDate` do agendamento (quando foi marcado)
- `comparecimento_em timestamptz` — `CheckinTime` (quando fez check-in)
- `tem_orcamento boolean not null default false` — true se o paciente tem orçamento particular criado em `[data, data+60d]`

Índices: `idx_orcamentos_fechamento on orcamentos(data_fechamento)`.

> Re-sync necessário após a migração para preencher os campos. Linhas antigas ficam com defaults até o próximo sync.

## Sync (`sync/clinicorp-sync.js`)

### `syncOrcamentos` (estende a função existente)
Para cada estimate, percorrer `ProcedureList`:
- `valor_particular` = soma de `FinalAmount` (ou `Amount`) dos procedimentos **sem** `ClaimNumber`/`BillType != 'CLAIM'`.
- `eh_convenio` = `valor_particular == 0 && ProcedureList.length > 0`.
- `data_fechamento` = `toDate(LastChange_Date)` se `Status='APPROVED'`, senão null.
- Mantém `valor` (total) e `status` como hoje.

### `syncEntradas` (nova fase)
- Buscar `/payment/list` na janela de 180d (fatias de 30d, `fetchRangeChunked`).
- Montar mapa `paciente_clinicorp_id → [pagamentos ordenados por data]`.
- Para cada orçamento APPROVED particular, `entrada` = primeiro pagamento com `data >= orcamento.data_criacao`. Setar `entrada_valor`/`entrada_data`.

### `syncAvaliacoes` (estende)
- Setar `agendado_em` = `CreateDate` do agendamento, `comparecimento_em` = ISO de `CheckinTime` (epoch ms → timestamptz).

### `marcarAvaliacoesComOrcamento` (nova fase, roda após orçamentos)
- Para cada avaliação, `tem_orcamento` = existe orçamento **particular** (`valor_particular > 0`) do mesmo `paciente_clinicorp_id` com `data_criacao` em `[avaliacao.data, avaliacao.data + 60d]`.
- Update em lote por paciente.

> Janela de pagamentos sobe para 180d → o sync do funil passa a usar ~18 chamadas Clinicorp. Aceitável dentro do rate limiter (pausa se exceder 24/h); avaliar mover a fase do funil para um job separado do sync pesado de pacientes (fora do escopo deste sub-projeto).

## Agregação (`lib/funil/`)

Funções puras, com testes `node:test`. Entradas já filtradas por período no endpoint.

### Topo do funil (por mês da avaliação) — `agregarFunil` ajustado
- Passa a contar **só avaliações com `tem_orcamento = true`**.
- Demais cards (leads, agendamentos, comparecimentos, %) inalterados na fórmula.

### Bloco "Fechamentos do mês" — `agregarFechamentos({ orcamentos, avaliacoesPorPaciente })`
Entrada: orçamentos **particulares aprovados com `data_fechamento` no período**.
- `fechamentos` = nº de **pacientes distintos** fechados
- `valor_fechado` = soma de `valor_particular`
- `entradas_recebidas` = soma de `entrada_valor`
- `ticket_medio` = `valor_fechado / fechamentos`
- `tempo_medio_ate_fechar` = média de dias `avaliacao.data → data_fechamento` (avaliação mais recente do paciente antes do fechamento; ignora sem avaliação)
- `origem_fechamento` = `{ mesmo_mes, meses_anteriores }` — para cada fechamento, a avaliação foi no mesmo mês do fechamento ou antes (contagem + %)

### Bloco "Tempos por fase" — `temposPorFase({ leads, avaliacoes, orcamentos })`
Média de dias por transição (ignora quem não atingiu a fase):
- **Clínica:** `agendou→compareceu` (`agendado_em → comparecimento_em`), `compareceu→fechou` (`comparecimento_em → data_fechamento` do orçamento do paciente)
- **Leads rastreados:** `lead→agendou` (`data_lead → data_agendamento`), `agendou→compareceu` (`data_agendamento → data_comparecimento`), `compareceu→fechou` (`data_comparecimento → data_fechamento` do orçamento vinculado)

## Endpoint `GET /api/comercial/funil`

Estende a resposta com `fechamentos_mes` e `tempos_fase`. Novas queries:
- Orçamentos **fechados no período**: `orcamentos` com `data_fechamento` em `[from,to]` e `valor_particular > 0`.
- Avaliações dos pacientes desses fechamentos (qualquer data) — para tempo-até-fechar e split. Coletar `paciente_clinicorp_id` dos fechados e buscar suas avaliações.
- Top funil passa a filtrar `tem_orcamento = true`.

Resposta: `{ ...atual, fechamentos_mes: {...}, tempos_fase: { clinica: {...}, leads: {...} } }`.

## UI (`public/comercial/`)

Abaixo das duas colunas atuais, dois blocos novos:

**"Fechamentos do mês"** (cards): Fechamentos · Valor fechado · Entradas recebidas · Ticket médio · Tempo médio até fechar · Origem (% no mês vs anteriores). Selo discreto **"automático — pendente de conferência"**.

**"Tempos por fase"**: duas linhas (Clínica / Leads) com os deltas em dias por transição.

Filtros de período e origem continuam valendo para todos os blocos.

## Fora de escopo (Sub-projeto 2)
- Fila de revisão + aprovação da CRC; status pendente/aprovado; valores ajustáveis; totais contando só aprovados.

## Riscos e verificações pendentes
- **Nomes de campos do Clinicorp** (`BillType`, `ClaimNumber`, `FinalAmount` por procedimento; `LastChange_Date`; campos de `/payment/list`) — validar no código quando o rate limit resetar (~1h). O desenho não muda; só confirmar os nomes.
- **Avaliação real sem orçamento** é excluída do funil (decisão consciente) — pode subestimar avaliações se algum dentista não cria orçamento na consulta.
- **`LastChange_Date`** como data de fechamento é proxy: edições pós-aprovação podem deslocar a data. Aceitável no v1.
- **Tempos por fase de leads** ficam esparsos até entrarem leads reais (hoje 8 leads de teste).
