# Recuperação de Falta (no-show de avaliação) — Design

**Data:** 2026-07-05
**Contexto:** Item 2 da fila de melhorias do CRM (análise de pontas soltas 03/07). O CRM é "oco no meio": depois que o paciente comparece — ou falta — nada acontece automaticamente. Show rate de avaliação medido: **41–46% de falta** (Avaliação leads internet 46%, CRC Leads Frios 43%, CRC Pós 41%), ~140 faltas de avaliação/mês, com custo de aquisição já gasto. Hoje o detector de falta existe (`syncComparecimentos`, server.js ~3913) mas só grava um evento `clinicorp_faltou` que **nunca dispara na prática** (0 eventos no banco) e não gera nenhuma ação.

## Descobertas de dados que fundamentam o desenho (medidas em produção)

- **O vínculo lead↔agendamento está zerado:** `leads.clinicorp_appointment_id` preenchido em **0** leads. Agendamentos são criados **direto no Clinicorp** pela equipe, não pelo CRM. Logo, não há "CRC que agendou aquela consulta" registrado, nem link confiável falta→lead pelo id.
- **A fonte confiável de falta é `agenda_appointments`** (sync diário do Clinicorp): falta = `appointment_date` passada, `deleted=false`, `checkin_time` vazio, `category ILIKE 'Avalia%'`. Confiável: manutenção (paciente em tratamento) falta só 11%, então "sem check-in" não é ruído.
- **Cadeia de enriquecimento (90 dias, 426 faltas de avaliação):** casa com o cadastro `pacientes` por nome (mesmo sistema Clinicorp) em **377 (88%)**; desses, **375 têm telefone (88%)**; reencontra o **lead por telefone** (sufixo 8 dígitos) em **327 (77%)**.
- **Identificação da responsável:** das faltas de categoria de leads (311/90d), só **65 (21%)** têm CRC dona identificável (via `crc_agendamento_nome` do lead reencontrado); **246 (79%)** não têm → caem no "notifica as três".

## Decisões do Luiz (brainstorm 04–05/07)

1. **Escopo:** só avaliações (categorias `Avalia%`: leads internet, CRC Leads Frios, CRC Pós). Tratamento/manutenção fora (é o fluxo de recall/pós).
2. **Ação:** tarefa + etiqueta (cobra a CRC ativamente E marca o lead no funil).
3. **Cadência:** 3 toques (D+0, D+3, D+7) + auto-Perdido ~D+10 com trava.
4. **Atribuição:** por categoria → time. Descobrir a responsável quando possível; se não souber, notificar as três CRC de Leads com aviso "responsável desconhecida — alguém assume". CRC Pós → sempre Cristiane.
5. **WhatsApp de lado:** recuperação é trabalho da CRC (ligar/remarcar), sem mensagem automática ao paciente.

## Componentes

### 1. Tabela de controle `recuperacao_faltas`

Estado da cadência por falta, uma linha por agendamento faltado. Chave natural: `clinicorp_appt_id` (UNIQUE — nunca duplica).

Colunas: `id` bigserial; `clinicorp_appt_id text unique not null`; `patient_name text`; `category text`; `dentist_name text`; `appointment_date date`; `telefone text`; `lead_id bigint references leads(id)`; `crc_responsavel_id uuid references profiles(id)` (null = desconhecida); `status text` ('aberta' | 'recuperada' | 'perdida' | 'encerrada'); `toques_enviados int default 0`; `ultimo_toque_em timestamptz`; `task_id bigint references tasks(id)`; `criada_em timestamptz default now()`; `recuperada_em timestamptz`.

RLS: habilitada, política de leitura para papéis internos (padrão do projeto). Nunca exposta a anon.

### 2. Detecção (motor diário)

Função `varrerFaltasAvaliacao()`, hospedada num `setInterval` **próprio e dedicado** (padrão dos outros crons do server; intervalo de ~3h — os dados de `agenda_appointments` só atualizam no sync 02h, então frequência baixa basta). Passo:

1. **Novas faltas:** seleciona faltas de avaliação (janela ~30 dias para trás, para não reprocessar histórico antigo) que ainda não estão em `recuperacao_faltas`. Para cada uma:
   - Enriquece: telefone via `pacientes` (nome), lead via telefone (sufixo 8 dígitos + `chaveTelefone`, respeitando separação de familiares), CRC responsável via `lead.crc_agendamento_id` **se for papel `crc_leads`**.
   - Insere linha (`status='aberta'`, `toques_enviados=0`).
   - Executa o **toque D+0** (seção 3).
2. **Recuperação:** para linhas `status='aberta'`, checa se recuperou (seção 4) → marca `recuperada`, fecha a tarefa, para a cadência.
3. **Cadência:** para linhas `aberta` não recuperadas, avança os toques por idade (seção 3).

Janela de segurança: só cria faltas com `appointment_date >= hoje-30` (evita gerar centenas de tarefas retroativas ao ligar a feature pela 1ª vez — o backfill histórico não é objetivo; foco é o fluxo daqui pra frente).

### 3. Toques (cadência de 3 + auto-Perdido)

- **D+0 (na detecção):**
  - Etiqueta **"Faltou"** no lead reencontrado (array `etiquetas` via read-modify-write ou RPC; idempotente, não duplica).
  - Cria **1 tarefa** em `tasks`: `titulo` "Recuperar falta — {paciente}", `descricao` com telefone/categoria/dentista/data da falta, `lead_id`, `categoria`='recuperacao_falta', `prazo` = hoje+1 dia, `prioridade` alta.
  - **Atribuição:** `crc_responsavel_id` identificada → `assignee_id` = ela. Categoria CRC Pós → Cristiane (id configurável em `app_config`). Desconhecida → tarefa fica **sem dono** (`assignee_id` null, visível ao time) + `criarNotificacao` para as **três CRC de Leads** (ids configuráveis) tipo `falta_sem_responsavel`, corpo "Falta sem responsável identificada — {paciente}, {categoria}. Alguém assume." Guarda `task_id` na linha de controle.
- **D+3 e D+7 (se ainda `aberta` e tarefa `pendente`):** renotifica (não cria tarefa nova — evita spam) a responsável, ou as três se sem dono. Incrementa `toques_enviados`, atualiza `ultimo_toque_em`.
- **~D+10 (se ainda `aberta`):** **auto-Perdido** — só se TODAS: lead foi achado **E** `lead.status` em fase pré-fechamento (não `Fechou`/`Perdido`) **E** paciente sem consulta futura marcada **E** a tarefa de recuperação **não foi concluída pela CRC**. Faz `update leads {status:'Perdido', motivo_perda:'Faltou e não retornou'}` + `logEvento('status_mudou')` + fecha a tarefa. Marca linha `perdida`. **Se a CRC já concluiu a tarefa** (trabalhou a falta e o paciente ainda não voltou) → o sistema **respeita a decisão dela**: marca linha `encerrada`, NÃO auto-perde. Se o lead não foi achado (23%) → também marca `encerrada` (encerra a cadência sem mexer no funil).

Timezone: idades calculadas em America/São_Paulo (padrão dos outros crons).

### 4. Definição de "recuperado"

Linha `aberta` vira `recuperada` (para a cadência, fecha tarefa) se qualquer um:
- Paciente (por nome no `agenda_appointments`) tem consulta **posterior à falta** com check-in **ou** consulta **futura** marcada (remarcou).
- Lead reencontrado avançou para `Compareceu`, `Em negociação` ou `Fechou`.

### 5. Notificações

Reusa `criarNotificacao(usuarioId, tipo, titulo, corpo, metadata)`. Tipos novos: `falta_sem_responsavel`, `falta_recuperar_lembrete`. ⚠️ Verificar/ajustar o CHECK `notificacoes_tipo_check` no banco antes (pode precisar de `ALTER ... DROP CONSTRAINT` — o constraint foi relaxado ao vivo antes). Deep-link da notificação → Central de Tarefas.

### 6. Config (`app_config`)

`recuperacao_falta_crc_leads jsonb` (ids das três CRC de Leads a notificar quando sem dono) e `recuperacao_falta_crc_pos uuid` (Cristiane). Semear na migração por `nome ILIKE`. Editável sem deploy.

## Erros e bordas

- Nome do paciente não casa cadastro (12%) → linha sem telefone/lead; tarefa ainda é criada com o nome + categoria (a CRC busca no Clinicorp). Não bloqueia.
- Telefone com 0 à esquerda (família) → `chaveTelefone` preserva a separação; nunca mescla.
- Homônimos no match por nome → aceitar o risco no telefone (a CRC confirma ao ligar); o auto-Perdido tem trava por consulta futura para não encerrar o paciente errado.
- Falta já processada → UNIQUE em `clinicorp_appt_id` impede duplicata; toques idempotentes por `toques_enviados`/idade.
- Erro numa falta não pode derrubar o passo das outras (try/catch por item).
- NUNCA `.catch()` direto em builder Supabase — try/catch no await.
- Somas/filtros no SQL, nunca no JS (limite de 1000 linhas do client) — a varredura usa RPC/SQL para casar agenda×pacientes×leads.

## Testes

- `node:test` puro para: cálculo de idade/toque (dado uma falta com data X e hoje Y → qual toque), a regra de "recuperado" (fixtures de agenda/lead), a trava do auto-Perdido (não perde se tem consulta futura / se já Fechou / se lead não achado).
- Verificação em produção (leitura, sem escrever): a RPC de detecção lista as faltas de avaliação dos últimos 30d com telefone/lead/CRC preenchidos nas proporções medidas (88%/77%/21%).

## Critérios de sucesso

1. Toda falta de avaliação nova vira uma linha de controle + uma tarefa em ≤ 1 dia, sem duplicar.
2. A etiqueta "Faltou" aparece no lead reencontrado e a coluna "Faltou" do kanban passa a se preencher sozinha.
3. Tarefa vai para a CRC certa quando identificável; senão as três são notificadas com o aviso de responsável desconhecida.
4. Cadência avança D+0/D+3/D+7 e o auto-Perdido D+10 só encerra quem realmente não voltou (trava validada).
5. Quando o paciente remarca/comparece, a cadência para e a tarefa fecha.

## Fora do escopo (v1)

Remarcar automático no Clinicorp (API não tem cancelar/atualizar; "reagendar" hoje cria duplicado — remarcação fica manual); mensagem automática ao paciente (WhatsApp de lado, decisão do Luiz); backfill retroativo de faltas antigas; faltas de tratamento/manutenção (fluxo de recall/pós).
