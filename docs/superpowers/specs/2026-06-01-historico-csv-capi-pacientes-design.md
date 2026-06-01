# Design: Migração Histórica CSV + CAPI Backfill + Módulo Pacientes

**Data:** 2026-06-01
**Status:** Aprovado

## Visão Geral

Três entregas independentes em um único ciclo de implementação:

1. **Script de importação** — processa CSVs do CRM antigo + Google Sheets → Supabase (roda uma única vez)
2. **CAPI backfill** — após importação, dispara eventos históricos para a Meta com datas e valores reais
3. **Módulo Pacientes** — nova página `/pacientes/` para a CRC de Sucesso do Cliente acompanhar tratamentos

Fluxo contínuo após a importação: aprovações na Conferência entram automaticamente no módulo Pacientes (sem duplicar registros já importados).

---

## Fontes de Dados

### CSVs — `P:\LUIZ\POWER BI\Dashboard\Dashboard\CSV`

| Pasta | Registros | Colunas relevantes |
|---|---|---|
| 01 - Leads | ~16.372 | Data de cadastro, Nome, Telefone, Origem |
| 02 - Agendamentos | ~5.721 | + Criação do agendamento, Data da consulta, Status agendamento |
| 03 - Comparecimentos | ~2.674 | + Alteração do status |
| 04 - Fechamentos | ~817 | + Data fechamento, Valor orçado, Valor fechado, Valor entrada, Tratamento |
| 05 - Orçamentos | ~2.561 | + Status (OPEN/APPROVED), Tratamento |

Separador: ponto e vírgula. Encoding: verificar na leitura (latin-1 ou utf-8).

### Google Sheets
URL: `https://docs.google.com/spreadsheets/d/1Is8LJJFKXjxT3gnwz9hK-GUEnqJ2m1FKLBJSNueXTtA`
Abas: **Acompanhamento** e **Invisalign**

Colunas do Sheets: P · NOME · TRATAMENTO · DATA DA VENDA · DATA DE ATUALIZAÇÃO · PRÓXIMO PASSO · DATA DE AGENDAMENTO · AVALIADOR · EXECUTOR · OBS · DIAS DESDE ATUALIZAÇÃO · STATUS

O Sheets é a **fonte primária** do módulo Pacientes. Pode conter pacientes não presentes nos CSVs.

---

## Parte 1: Script de Importação

### Endpoint
`POST /api/admin/import-historico` — protegido por `requireAdmin`.

Recebe os arquivos CSV via upload (multipart) ou lê do caminho configurado via env `HISTORICO_CSV_PATH`.

### Algoritmo de determinação de status

Para cada telefone encontrado nos CSVs, determina o **status mais avançado** na seguinte ordem de prioridade:

```
1. Aparece em 04-Fechamentos                           → Fechou
2. Aparece em 05-Orçamentos com status OPEN            → Reclassificar
3. Aparece em 02-Agendamentos mas NÃO em 03            → Faltou
4. Aparece apenas em 01-Leads                          → Nutrir
5. Aparece em 03-Comparecimentos sem orçamento         → (não entra nas filas das CRCs)
```

### Upsert de leads

- **Chave de deduplicação:** telefone (normalizado: só dígitos, sem country code)
- **Se o telefone JÁ existe no Supabase:** não altera o status atual. Apenas insere `lead_eventos` com o percurso histórico (se ainda não existirem).
- **Se o telefone NÃO existe:** insere novo lead com status calculado acima + `importado_historico: true`

### lead_eventos gerados por lead

Para cada transição confirmada nos CSVs:

| tipo | descricao | criado_em |
|---|---|---|
| `historico_lead_criado` | Lead histórico importado — origem X | data de cadastro do CSV |
| `historico_agendado` | Agendamento em DD/MM/YYYY | data do agendamento |
| `historico_compareceu` | Compareceu à consulta em DD/MM/YYYY | data da consulta |
| `historico_orcamento` | Orçamento criado: R$ X — Tratamento Y | data do orçamento |
| `historico_fechou` | Fechamento: R$ X (entrada: R$ Y) | data do fechamento |

### Novo status `Reclassificar`

Adicionar ao array `FUNIL` em `server.js` entre `D5` e `Em nutrição` (representa leads com orçamento aberto sem fechamento). Aparece na fila CRC Comercial com:
- Coluna visível: data do orçamento (do CSV)
- Ordenação: mais recente primeiro
- Badge "importado" para diferenciar dos leads atuais

---

## Parte 2: CAPI Backfill

Executado automaticamente ao final do script de importação.

### Eventos por status

| Status | Evento CAPI | event_time | Dados enviados |
|---|---|---|---|
| Fechou | `Purchase` | data do fechamento (CSV) | telefone + email (Supabase) + valor fechado |
| Reclassificar | `Schedule` | data do agendamento (CSV) | telefone |
| Faltou | `Schedule` | data do agendamento (CSV) | telefone |
| Nutrir | `LeadSubmitted` | data de cadastro (CSV) | telefone |

### Enriquecimento com email (somente Fechamentos)

Antes de disparar o Purchase, consulta a tabela `leads` no Supabase pelo telefone. Se houver email cadastrado, inclui `em: [sha256(email)]` no payload CAPI. Nenhuma chamada à API da Clinicorp.

### Proteção contra reenvio

Antes de disparar qualquer evento, verifica o array `eventos_meta_enviados` do lead. Se o evento já consta → pula. Permite re-execução segura do script.

### Configuração de event_time

O `event_time` usa a data real do CSV (não `Date.now()`). A Meta aceita eventos retroativos — o impacto é principalmente na construção de audiências (Lookalike de quem fechou, exclusão de pacientes ativos), não em atribuição de anúncios passados.

---

## Parte 3: Módulo Pacientes

### Nova tabela Supabase: `pacientes_sucesso`

```sql
create table pacientes_sucesso (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id),
  nome text not null,
  telefone text,
  tratamento text,
  data_venda date,
  valor_fechado numeric,
  data_atualizacao date,
  proximo_passo text,
  data_agendamento date,
  avaliador text,
  executor text,
  obs text,
  prioridade smallint default 0,
  is_alta boolean default false,
  importado_historico boolean default true,
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);
```

Status é **calculado** (não armazenado), baseado em `data_atualizacao` + `tratamento` + tabela de configuração.

### Nova tabela: `tratamentos_config`

```sql
create table tratamentos_config (
  tratamento text primary key,
  dias_atualizacao integer not null,
  observacao text,
  responsavel_padrao text
);
```

Valores iniciais (editáveis pelo gestor na UI):

| Tratamento | Dias |
|---|---|
| Prótese Protocolo | 10 |
| Prótese | 10 |
| Placa de Bruxismo | 10 |
| Cirurgia | 15 |
| Invisalign | 30 |
| Periodontia | 10 |
| Geral | 10 |
| Clareamento | 5 |
| Implantes | 15 |
| Pacote de Prevenção | 90 |
| Canal | 5 |
| Prótese sobre implante | 10 |
| Ortodontia | 30 |
| Tratamento Programado | 30 |
| ALTA | 365 |

### Cálculo de status (client-side, em tempo real)

```
se is_alta === true (marcado manualmente)         → ✅ ALTA
se data_atualizacao está vazia                    → ⚪ SEM DATA
dias = hoje - data_atualizacao
prazo = tratamentos_config[tratamento].dias
se dias > prazo                                   → 🔴 CRÍTICO
se dias > prazo - 5                               → 🟡 ATENÇÃO
senão                                             → 🟢 EM DIA
```

### Interface `/pacientes/`

- Tabela estilo planilha com colunas: **P · NOME · TRATAMENTO · DATA DA VENDA · DATA DE ATUALIZAÇÃO · PRÓXIMO PASSO · DATA DE AGENDAMENTO · AVALIADOR · EXECUTOR · OBS · DIAS · STATUS**
- Células editáveis inline: DATA DE ATUALIZAÇÃO, PRÓXIMO PASSO, DATA DE AGENDAMENTO, AVALIADOR, EXECUTOR, OBS
- Coluna P (prioridade): clique para marcar/desmarcar `is_alta` (toggle visual)
- STATUS calculado e colorido em tempo real (sem reload)
- Filtros: por status, por tratamento, por executor
- Botão WhatsApp em cada linha
- Acesso: roles `crc_sucesso`, `crc_comercial`, `gestor`, `admin`
- Novo role `crc_sucesso` criado no sistema de usuários (perfil base)

### Importação do Google Sheets

Leitura via Google Drive MCP (permissão de leitura já concedida pelo usuário).

```
Para cada linha das abas Acompanhamento + Invisalign:
  1. Normaliza telefone (se disponível) ou usa nome como fallback
  2. Busca lead_id no Supabase por telefone
  3. Busca data_venda + valor no CSV Fechamentos pelo mesmo telefone
  4. Insere em pacientes_sucesso preservando todos os campos já preenchidos no Sheets

Para cada linha do CSV Fechamentos que NÃO aparece no Sheets:
  → Insere em pacientes_sucesso com nome, telefone, tratamento, data_venda, valor (status = SEM DATA)
```

---

## Parte 4: Fluxo Contínuo (pós-importação)

Ao CRC aprovar um fechamento em `/comercial/conferencia/`:

```js
// Após update do lead para status Fechou:
const jaExiste = await supabase
  .from('pacientes_sucesso')
  .select('id')
  .eq('lead_id', lead.id)
  .maybeSingle();

if (!jaExiste.data) {
  await supabase.from('pacientes_sucesso').insert({
    lead_id: lead.id,
    nome: lead.nome,
    telefone: lead.telefone,
    tratamento: lead.tratamento || '',
    data_venda: new Date().toISOString().split('T')[0],
    valor_fechado: lead.valor,
    importado_historico: false,
  });
}
```

Leads já importados (histórico) não são duplicados. Novos fechamentos aprovados entram automaticamente no módulo.

---

## Migrações Supabase necessárias

1. `create table pacientes_sucesso` (definição acima)
2. `create table tratamentos_config` + insert dos valores iniciais
3. Adicionar `importado_historico boolean default false` na tabela `leads`
4. Adicionar role `crc_sucesso` à função `admin_create_user` e ao módulo de Usuários

---

## O que NÃO está no escopo

- Interface de configuração dos `tratamentos_config` (gestor edita diretamente na V2)
- Notificações automáticas quando status vira CRÍTICO (V2)
- Interface de configuração dos `tratamentos_config` via UI (gestor edita na V2)
- Histórico de edições das células do módulo Pacientes (V2)
