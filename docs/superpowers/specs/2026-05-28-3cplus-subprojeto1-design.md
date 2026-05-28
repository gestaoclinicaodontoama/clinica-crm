# 3cplus Sub-projeto 1 — Core + Click-to-call

**Data:** 2026-05-28  
**Status:** Aprovado  
**Escopo:** Integração base com o 3cplus — registro de ligações, click-to-call no painel do lead, processamento de gravação com IA e migração do módulo de Avaliação do Dentista de Deepgram para Gemini.

---

## Seção 1 — Arquitetura

### Fluxo principal (A + B)

**Fluxo A — Webhook imediato:**
1. CRC clica em "Ligar" no painel do lead → `POST /api/leads/:id/ligar`
2. Servidor chama API do 3cplus, recebe `call_id`, salva registro em `ligacoes`
3. 3cplus conecta a chamada; ao encerrar, dispara `POST /api/webhooks/3cplus`
4. Handler atualiza o registro em `ligacoes` e dispara processamento de IA (fire-and-forget)

**Fluxo B — Job fallback:**
- Cron a cada 1h busca ligações com `gravacao_url` preenchida, sem transcrição e com menos de 3 tentativas — reprocessa silenciosamente

### Decisões de tecnologia

- **IA de áudio:** Gemini direto (sem Deepgram) — transcreve e analisa em uma única chamada
- **Assíncrono:** fire-and-forget no processo Express; cron de 1h como safety net
- **Softphone:** CRC usa o softphone do 3cplus (independente do CRM)

### Arquivos novos

- `src/3cplus.js` — cliente da API do 3cplus (click-to-call, download de gravação)
- Tabelas: `ligacoes`, `ia_config`, `ia_uso_log`
- Endpoints: `POST /api/leads/:id/ligar`, `POST /api/webhooks/3cplus`, `POST /api/ligacoes/:id/analisar`

---

## Seção 2 — Banco de dados

### Tabela `ligacoes`

```sql
id                  uuid PK default gen_random_uuid()
lead_id             uuid references leads(id)
usuario_id          uuid references profiles(id)
threec_call_id      text unique
status              text  -- iniciada | atendida | nao_atendida | ocupado | falha_gravacao
duracao_segundos    int
gravacao_url        text
tentativas_gravacao int default 0
transcricao         text
analise_ia          jsonb  -- { resumo, pontos_fortes[], pontos_melhora[], score }
modulo              text   -- leads | agendamentos | avaliacao_dentista
criada_em           timestamptz default now()
analisada_em        timestamptz
```

### Tabela `ia_config` (uma linha por módulo)

```sql
modulo              text PK  -- leads | agendamentos | avaliacao_dentista
auto_analise_ativo  bool default true
min_duracao_s       int  default 60
limite_diario       int  default 50
limite_semanal      int  default 200
```

Seeds iniciais: uma linha para cada módulo.

### Tabela `ia_uso_log`

```sql
id                  uuid PK default gen_random_uuid()
modulo              text
duracao_audio_s     int
tokens_entrada      int
tokens_saida        int
custo_estimado      numeric(10,4)
criado_em           timestamptz default now()
```

### Campo novo em `profiles`

```sql
threec_agent_id     text
```

---

## Seção 3 — Click-to-call no painel do lead

### Quem vê o botão

Perfis com role `crc_lead` e `crc_comercial`.

### Fluxo do botão

1. CRC clica no ícone de telefone no painel do lead
2. Se `profiles.threec_agent_id` for null → exibe erro: _"Configure seu ID de agente no 3cplus em Configurações → Perfil"_
3. Se configurado → `POST /api/leads/:id/ligar`
   - Servidor chama API do 3cplus com `agent_id` e telefone do lead
   - 3cplus liga para a CRC primeiro; ao atender, conecta ao lead
   - Salva registro em `ligacoes` com `threec_call_id` e `status = 'iniciada'`
4. Feedback imediato na tela: _"Ligação iniciada"_

### Histórico de ligações no painel do lead

Lista simples abaixo do botão:

```
[status badge]  [data e hora]        [duração]  [→ ver mais]
Atendida        28/05 14:32          4min 12s   →
Não atendida    27/05 13:10          —          →
```

Clique em "→" abre o modal da Seção 5.

---

## Seção 4 — Webhook + Processamento de Gravação + IA

### 4.1 — Recebimento do webhook

**Endpoint:** `POST /api/webhooks/3cplus`  
**Auth:** header `X-Webhook-Token` comparado com `process.env.THREEC_WEBHOOK_TOKEN`

Payload esperado do 3cplus:
```json
{
  "threec_call_id": "...",
  "agent_id": "...",
  "status": "atendida",
  "duracao_segundos": 272,
  "gravacao_url": "https://..."
}
```

Handler (síncrono e rápido, responde 200 em < 1s):
1. Valida token — 401 se inválido
2. Busca registro em `ligacoes` pelo `threec_call_id`
3. Atualiza `status`, `duracao_segundos`, `gravacao_url`
4. Dispara `processarGravacao(ligacao)` sem await (fire-and-forget)
5. Retorna 200

### 4.2 — Pipeline assíncrono de processamento

Função `processarGravacao(ligacao)` avalia elegibilidade para análise automática:

**Critérios:**
- `status === 'atendida'`
- `duracao_segundos >= ia_config.min_duracao_s`
- Análises do dia < `ia_config.limite_diario`
- Análises da semana < `ia_config.limite_semanal`
- `ia_config.auto_analise_ativo === true`

**Se elegível:**
1. GET na `gravacao_url` para baixar o áudio
2. Se URL indisponível: incrementa `tentativas_gravacao` e encerra — o cron de 1h reprocessa automaticamente
3. Após 3 tentativas sem sucesso: `status = 'falha_gravacao'`
4. Se download ok: envia áudio ao Gemini com prompt de análise
5. Salva `transcricao`, `analise_ia`, `analisada_em` em `ligacoes`
6. Registra em `ia_uso_log`

**Se não elegível:** ligação salva normalmente, sem análise. Botão "Analisar agora" fica disponível no modal.

### 4.3 — Prompt Gemini

```
Você é um avaliador de qualidade de atendimento de uma clínica odontológica.
Transcreva e analise a chamada a seguir em português.
Retorne APENAS JSON válido (sem markdown), no formato:
{
  "transcricao": "texto completo da conversa...",
  "resumo": "...",
  "pontos_fortes": ["...", "..."],
  "pontos_melhora": ["...", "..."],
  "score": 8
}
```

Uma única chamada à API retorna transcrição e análise. O campo `transcricao` é salvo em `ligacoes.transcricao`; os demais campos em `ligacoes.analise_ia`.

### 4.4 — Job fallback (cron 1h)

Busca ligações onde:
- `gravacao_url IS NOT NULL`
- `transcricao IS NULL`
- `tentativas_gravacao > 0 AND tentativas_gravacao < 3`
- `status != 'falha_gravacao'`

O filtro `tentativas_gravacao > 0` garante que o cron só reprocessa falhas de download — chamadas puladas por limite diário/semanal têm `tentativas_gravacao = 0` e não são retentadas aqui.

Reprocessa silenciosamente cada uma.

---

## Seção 5 — Modal "Ver mais" (detalhes de uma ligação)

Modal read-only aberto ao clicar "→" no histórico.

### Estrutura

**Cabeçalho:**
Nome do lead · Data e hora · Duração (ex: 4min 32s) · Status (badge colorido)

**Bloco 1 — Áudio:**
- Player HTML5 com `gravacao_url`
- Se null ou `falha_gravacao`: _"Gravação não disponível"_
- "Ainda processando" = `gravacao_url IS NOT NULL AND transcricao IS NULL AND tentativas_gravacao < 3 AND status != 'falha_gravacao'` → spinner _"Aguardando gravação..."_

**Bloco 2 — Transcrição:**
- Caixa com scroll, fonte mono, fundo diferenciado
- Se não analisada e `status = 'atendida'`: _"Análise pendente"_ + botão **"Analisar agora"** → `POST /api/ligacoes/:id/analisar`
- Se `status != 'atendida'`: sem botão, sem transcrição
- Se em andamento: spinner

**Bloco 3 — Análise IA:**
- **Score:** badge numérico grande com cor (≥7 verde · 4–6 amarelo · <4 vermelho)
- **Resumo:** parágrafo de texto
- **Pontos fortes:** lista com ✓
- **Pontos de melhora:** lista com △

**Rodapé:** _"Analisado em [data hora]"_ (vazio se não analisado)

---

## Seção 5.5 — Detalhes das Chamadas (visão gerencial)

Tela dedicada acessível por gestor e admin. Mostra todas as chamadas de todos os módulos.

### Tabela principal

Colunas: **Data/hora · CRC · Lead · Setor · Origem · Status · Duração · Score IA**

Clique em qualquer linha abre o modal da Seção 5. Paginação de 50 por página com total visível.

### Filtros

| Filtro | Valores |
|---|---|
| Período | date range picker |
| CRC | select com todas as funcionárias |
| Setor | Leads / Agendamentos / Avaliação Dentista / Todos |
| Status | Atendida / Não atendida / Ocupado / Falha |
| Origem | Indicação / Google / Instagram / etc. |
| Score IA | Todos / Alto (≥7) / Médio (4–6) / Baixo (<4) |

Filtro por Campanha: adicionado no Sub-projeto 2.

**Nota:** Ligações do módulo `avaliacao_dentista` não possuem `lead_id` — as colunas Lead e Origem ficam vazias para essas linhas.

### Cards de resumo (topo)

Para o período filtrado: **Total de ligações · Atendidas · Taxa de atendimento · Duração média · Score médio IA**

---

## Seção 6 — Painel de custo e controles (admin/gestor)

### 6.1 — Controles por módulo

Tabela com uma linha por módulo (Leads, Agendamentos, Avaliação Dentista):

| Campo | Descrição |
|---|---|
| Análise automática | Toggle on/off |
| Duração mínima | Input em segundos (padrão: 60) |
| Limite diário | Nº máximo de análises automáticas/dia (padrão: 50) |
| Limite semanal | Nº máximo de análises automáticas/semana (padrão: 200) |

Desligar análise automática não impede o botão "Analisar agora" no modal — esse é manual e sempre disponível (registrado em `ia_uso_log` mas não conta nos limites automáticos).

### 6.2 — Monitoramento de custo

**Cards do mês atual:**
Análises realizadas · Minutos processados · Custo estimado (R$) · Projeção até fim do mês

**Tabela de uso (últimos 30 dias):**
Colunas: Data · Módulo · Análises · Minutos · Custo estimado

Inclui os três módulos: Leads, Agendamentos e Avaliação Dentista.

### 6.3 — Custo estimado

Constante configurável via variável de ambiente `GEMINI_COST_PER_MIN` (padrão: `0.016`).  
Exibida na tela como referência: _"~R$ 0,016/min de áudio (Gemini)"_.  
Não consultado dinamicamente da API do Gemini.

---

## Seção 7 — Migração Deepgram → Gemini (Avaliação Dentista)

### O que muda

| Hoje | Após migração |
|---|---|
| Deepgram → transcrição | Gemini → transcrição + análise em uma chamada |
| Gemini → análise do texto | Removido |
| Custo: Deepgram + Gemini | Custo: apenas Gemini |

### O que não muda

- Interface do usuário — nenhuma alteração visível
- Estrutura do banco do módulo de Avaliação Dentista — os campos de transcrição e análise na tabela própria do módulo permanecem iguais; esta migração afeta apenas a camada de IA, não o schema
- Lógica de quando analisar — os mesmos gatilhos atuais

### Impacto no Painel de Custo

O módulo `avaliacao_dentista` passa a aparecer nos controles (Seção 6.1) e no monitoramento de custo (Seção 6.2) usando o mesmo `GEMINI_COST_PER_MIN`.

### Risco

Gemini pode ter latência ligeiramente maior que Deepgram para transcrição isolada. Mitigação: processamento já é assíncrono — não impacta o usuário diretamente.

---

## Pendências para implementação

- **Token do webhook 3cplus** — pedir ao usuário no início da implementação
- **Referência visual CDR** — screenshot do 3cplus (appcrc.com.br/callcenter/cdr) como referência para a Seção 5.5

---

## Fora do escopo (Sub-projetos futuros)

- **Filtro por campanha** na Seção 5.5 → Sub-projeto 2
- **"Quem agenda mais / fecha mais"** → Sub-projeto 3
- **Análise qualitativa por CRC** (ranking, histórico evolutivo) → Sub-projeto 3
