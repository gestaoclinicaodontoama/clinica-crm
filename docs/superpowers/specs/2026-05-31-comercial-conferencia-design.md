# Dashboard Comercial — Sub-projeto 2: Conferência da CRC

**Data:** 2026-05-31
**Status:** Design aprovado (decisões via brainstorming) — aguardando revisão do spec
**Pré-requisito:** Sub-1 deployado (commit f8f1272): bloco "Fechamentos do mês" mostra valores automáticos rotulados "pendente de conferência".

## Objetivo

Adicionar um portão de conferência: todo fechamento (orçamento particular aprovado) nasce **pendente**. A CRC comercial revisa cada um e **Aprova / Edita+Aprova / Rejeita**. Só os aprovados entram no número "Confirmado" do dashboard; os não revisados aparecem como "Pendente"; rejeitados saem de tudo. Se o valor/entrada mudar no Clinicorp depois de aprovado, volta para pendente (reaprovação).

## Decisões (definidas com o usuário)

| Tema | Decisão |
|---|---|
| Ações da CRC | **Aprovar** (confirma automáticos), **Editar+Aprovar** (corrige valor e/ou entrada), **Rejeitar** (não foi venda válida; motivo opcional). |
| Totais no dashboard | "Fechamentos do mês" mostra **Confirmado** (aprovados) **e Pendente** (não revisados) lado a lado. Rejeitado sai de tudo. |
| Local | Página própria **`/comercial/conferencia/`** (link no menu). |
| Unidade de revisão | Por **orçamento** (cada orçamento particular aprovado é uma linha na fila). |
| Fila | Compartilhada: qualquer `crc_comercial`/`gestor`/`admin` resolve. |
| Mudança no Clinicorp | Se o valor/entrada automático divergir do retrato salvo na aprovação, **volta para pendente**. |

## Modelo de dados

### Migração `..._comercial_conferencia.sql`

**`orcamentos`** — novas colunas:
- `revisao_status text not null default 'pendente'` — `pendente` | `aprovado` | `rejeitado`
- `valor_aprovado numeric(12,2)` — valor confirmado/editado pela CRC
- `entrada_aprovada numeric(12,2)` — entrada confirmada/editada pela CRC
- `revisado_por uuid` — id do usuário que revisou
- `revisado_em timestamptz`
- `revisao_motivo text` — opcional (rejeição)
- `revisao_ref_valor numeric(12,2)` — retrato do `valor_particular` no momento da aprovação
- `revisao_ref_entrada numeric(12,2)` — retrato do `entrada_valor` no momento da aprovação
- `paciente_nome text` — nome do paciente (para a fila; hoje só temos o id)

Índice: `idx_orcamentos_revisao on orcamentos(revisao_status)`.

> Linhas existentes recebem `revisao_status='pendente'` (default). RLS: `select`/`update` para `authenticated` (o handler valida o papel). Nenhuma policy nova de escrita é necessária além das já existentes; a escrita passa pelo endpoint com service role do servidor.

## Sync (`sync/clinicorp-sync.js`)

- **`syncOrcamentos`**: passar a gravar `paciente_nome: o.PatientName || ''`. (O upsert não inclui as colunas de revisão, então elas são preservadas.)
- **Nova fase `reavaliarFechamentos`** (após `syncEntradas`): reverte para pendente os aprovados cujo valor/entrada automático divergiu do retrato salvo na aprovação. Implementação em JS (o cliente Supabase não compara coluna-com-coluna): buscar (via `selectAll`) os `revisao_status='aprovado'` com `clinicorp_estimate_id, valor_particular, entrada_valor, revisao_ref_valor, revisao_ref_entrada`; para cada um, se `valor_particular !== revisao_ref_valor` **ou** `entrada_valor !== revisao_ref_entrada` (comparação numérica, tratando null), dar `update({ revisao_status: 'pendente' })`. Logar quantos voltaram.

## Endpoints (`server.js`)

Reusar `requireDashboardAvaliacao` (gestor/admin/crc_comercial).

- **`GET /api/comercial/conferencia?status=pendente`** (default pendente; aceita `aprovado`/`rejeitado`): lista orçamentos particulares aprovados com `data_fechamento`, filtrados por `revisao_status`. Campos: `clinicorp_estimate_id, paciente_nome, profissional_nome, valor_particular, entrada_valor, data_fechamento, valor_aprovado, entrada_aprovada, revisao_status`. Ordenar por `data_fechamento desc`.

- **`POST /api/comercial/conferencia/:estimateId`** body `{ acao, valor, entrada, motivo }`:
  - `acao='aprovar'`: `revisao_status='aprovado'`, `valor_aprovado = (valor ?? valor_particular)`, `entrada_aprovada = (entrada ?? entrada_valor)`, `revisao_ref_valor = valor_particular`, `revisao_ref_entrada = entrada_valor`, `revisado_por = req.user.id`, `revisado_em = now()`, `revisao_motivo = null`.
  - `acao='rejeitar'`: `revisao_status='rejeitado'`, `revisao_motivo = motivo || null`, `revisado_por`, `revisado_em`.
  - Validar `acao`; sanitizar `valor`/`entrada` (números >= 0); `motivo` string curta.

- **`GET /api/comercial/funil`** (ajuste): o `fechamentos_mes` passa a ser `{ confirmado, pendente }`.
  - Buscar `fechados` no período (já existe) agora também com `revisao_status, valor_aprovado, entrada_aprovada`.
  - `confirmado` = `agregarFechamentos` sobre os `revisao_status='aprovado'`, **mapeando** `valor_particular→valor_aprovado` e `entrada_valor→entrada_aprovada`.
  - `pendente` = `agregarFechamentos` sobre os `revisao_status='pendente'` (valores automáticos).
  - Rejeitados são ignorados.

## Agregação (`lib/funil/fechamentos.js`)

- Ajuste em `agregarFechamentos`: a entrada por paciente passa a ser contada **uma vez** (usar o maior `entrada_valor` do paciente, não a soma) para evitar dobra quando um paciente tem mais de um orçamento com o mesmo 1º pagamento. (Teste atual tem 1 orçamento por paciente → continua verde; adicionar teste com 2 orçamentos do mesmo paciente comprovando que a entrada não dobra.)

## UI

- **Dashboard** (`public/comercial/app.js`): o bloco "Fechamentos do mês" renderiza **dois grupos** — "Confirmado" e "Pendente de conferência" — cada um com os cards (fechamentos, valor, entradas, ticket, tempo médio, origem). Remover o selo antigo; o rótulo passa a ser o título de cada grupo.

- **Página nova `public/comercial/conferencia/index.html`** + `public/js/comercial/conferencia.js` (+ reusa `api.js`): lista de pendentes (paciente, profissional, data, valor, entrada) com, por linha, **Aprovar**, **Editar** (campos de valor/entrada inline) e **Rejeitar** (motivo opcional). Após a ação, remove a linha da lista. Mostra contador de pendentes. Filtro de status (pendente/aprovado/rejeitado).

- **Nav**: link "Conferência" em `index.html` e `shared-nav.js` (roles `admin,gestor,crc_comercial`), slug `conferencia`.

## Fora de escopo
- Atribuição da venda a uma CRC específica (comissão/ranking) — projeto futuro.
- Histórico/auditoria de edições além do último revisor.

## Riscos e verificações
- Re-sync deve preservar as colunas de revisão (upsert sem elas no payload) — verificar após o primeiro sync pós-deploy que aprovados não viram pendente sem motivo.
- A fase `reavaliarFechamentos` roda em todo sync; conferir que só re-pende quando o valor realmente mudou.
- Entrada por paciente contada uma vez (evitar dobra) — coberto por teste novo.
