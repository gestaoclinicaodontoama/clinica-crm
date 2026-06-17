# Central de Tarefas — Design

**Data:** 2026-06-17
**Status:** Aprovado (brainstorming) — pronto para plano de implementação

## Objetivo

Cada usuário do CRM tem uma "Central de Tarefas" com as tarefas que precisa fazer:
rotinas diárias/semanais/mensais e tarefas pontuais. A pessoa marca o check quando
conclui (gravando data/hora), recebe notificação no computador quando o gestor/admin
lhe atribui algo, e tudo fica registrado num histórico que o gestor consegue acompanhar.

Substitui controles informais (papel, memória, planilha) por uma fila de trabalho
operacional integrada ao CRM.

## Decisões de produto (do brainstorming)

1. **Rotinas diárias** = combinação: molde padrão por cargo (definido pelo admin/gestor)
   + itens extras que a própria pessoa adiciona.
2. **Tarefas pontuais** = gestor/admin atribui aos funcionários; cada pessoa também pode
   criar pra si mesma. (Funcionário **não** atribui para colegas.)
3. **Notificações** = push do SO (web-push) **+** sininho dentro do CRM.
4. **Gatilhos de notificação** = (a) tarefa atribuída a você; (b) lembrete da manhã;
   (c) tarefa com prazo vencendo/vencida. Prazo e horário são **opcionais**.
5. **Histórico** = painel completo pro gestor (conclusão do dia por pessoa, atrasadas,
   pendências) + cada um vê o seu.
6. **Virada do dia** = configurável por molde: tarefa "arrasta" (continua aparecendo como
   atrasada até ser feita) ou "zera" (fica registrada como não-feita naquele dia).
7. **Frequência das rotinas** = diária / dias da semana / semanal / mensal.
8. **Extras na v1** = vínculo com lead/paciente, prioridade, categoria/etiqueta,
   observação ao concluir.

## Arquitetura geral

Segue o padrão existente do CRM:
- **Back-end:** rotas em `server.js` (Express), protegidas por `requireAuth` + `requireRole`.
- **Banco:** Supabase (Postgres).
- **Front-end:** páginas HTML em `/public/tarefas/`, navegação por `data-roles`,
  header compartilhado (`shared-nav.js`) e tabbar mobile (`mobile-nav.js`).
- **Notificações:** `web-push` (VAPID já configurado) + service worker (`sw.js`).
- **Recorrência:** geração sob demanda + cron leve (pré-geração matinal e push).
- **Fuso:** todo cálculo de "dia"/`data_ref`/cron usa `nowLocal()` (America/Sao_Paulo).

## Modelo de dados

### `task_templates` — moldes de rotina
| campo | tipo | descrição |
|---|---|---|
| `id` | uuid PK | |
| `titulo` | text | |
| `descricao` | text null | |
| `escopo` | text | `'role'` ou `'pessoal'` |
| `role` | text null | cargo alvo quando escopo=role (ex.: `crc_leads`) |
| `owner_id` | uuid null | dono quando escopo=pessoal (FK profiles) |
| `frequencia` | text | `'diaria'` \| `'semanal'` \| `'mensal'` |
| `dias_semana` | int[] null | 0–6; usado em diária (subset de dias) e semanal |
| `dia_mes` | int null | 1–31; usado em mensal |
| `hora_sugerida` | time null | |
| `prioridade` | text | `'alta'` \| `'normal'` \| `'baixa'` (default normal) |
| `categoria` | text null | |
| `arrasta` | bool | default false |
| `ativo` | bool | default true |
| `created_by` | uuid | |
| `created_at` | timestamptz | |

Regras de frequência (avaliadas para uma `data_ref`):
- `diaria`: vale todo dia; se `dias_semana` preenchido, só nesses dias da semana.
- `semanal`: vale nos `dias_semana` indicados (ex.: toda segunda = `[1]`).
- `mensal`: vale quando `dia_mes` == dia do mês (se `dia_mes` > último dia do mês,
  cai no último dia do mês).

### `tasks` — ocorrências reais (rotina gerada + pontuais)
| campo | tipo | descrição |
|---|---|---|
| `id` | uuid PK | |
| `titulo` | text | |
| `descricao` | text null | |
| `tipo` | text | `'rotina'` \| `'pontual'` |
| `template_id` | uuid null | FK task_templates (nulo se pontual) |
| `data_ref` | date | dia a que a tarefa pertence |
| `assignee_id` | uuid | de quem é a tarefa (FK profiles) |
| `created_by` | uuid | quem criou/atribuiu |
| `prioridade` | text | `'alta'`/`'normal'`/`'baixa'` |
| `categoria` | text null | |
| `prazo` | timestamptz null | opcional |
| `lead_id` | bigint null | vínculo opcional com lead |
| `paciente_id` | uuid null | vínculo opcional com paciente |
| `arrasta` | bool | herdado do molde ou definível na pontual |
| `status` | text | `'pendente'` \| `'concluida'` |
| `concluida_em` | timestamptz null | |
| `concluida_por` | uuid null | |
| `obs_conclusao` | text null | observação opcional no check |
| `created_at` | timestamptz | |

Índices: `(assignee_id, data_ref, status)`, `(status, prazo)`, `(template_id, assignee_id, data_ref)`.

### `task_push_subs` — assinaturas de push
| campo | tipo | descrição |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | FK profiles |
| `subscription` | jsonb | endpoint/keys do navegador |
| `created_at` | timestamptz | |

Único por `(user_id, subscription->>'endpoint')`.

## Lógica de recorrência e virada do dia

**Geração de ocorrências (idempotente)** — função `gerarTarefasDoDia(userId, dataRef)`:
1. Lista moldes que valem para `dataRef` e `userId`: escopo=pessoal com `owner_id=userId`,
   mais escopo=role cujo `role` está nas roles do usuário; filtra por `ativo` e frequência.
2. Para cada molde, verifica se já existe `task` correspondente:
   - Molde **não-arrasta**: existe `task` com `(template_id, assignee_id, data_ref)`?
     Se não, cria com `data_ref = dataRef`.
   - Molde **arrasta**: existe alguma `task` **aberta** (`status=pendente`) desse
     `(template_id, assignee_id)`? Se sim, **não cria** (a antiga reaparece como atrasada,
     mantendo a `data_ref` original). Se não, cria com `data_ref = dataRef`.
3. Nunca duplica.

**Quando roda:**
- **Cron leve (madrugada, horário de Brasília):** chama `gerarTarefasDoDia` para
  **todos os usuários ativos** → alimenta o painel do gestor mesmo para quem ainda não
  logou. Depois dispara o **push da manhã** ("você tem N tarefas hoje").
- **Sob demanda:** `GET /api/tarefas` chama `gerarTarefasDoDia(userAtual, hoje)` como rede
  de segurança (conta nova, ou acesso antes do cron rodar). Não-crítico se o cron falhar.

**Atrasada / não-feita (definições para listas e painel):**
- **Atrasada:** `status=pendente` e (`data_ref < hoje` **ou** `prazo < agora`). Aparece no
  topo, em vermelho. Tarefas que arrastam de dias anteriores entram aqui.
- **Não-feita:** `status=pendente` e `data_ref < hoje` e `arrasta=false`. Fica registrada
  no histórico daquele dia; não reaparece na lista de hoje.

## Permissões

- **Concluir/reabrir:** o `assignee` da tarefa. O gestor/admin também pode concluir no
  lugar de alguém (grava `concluida_por` ≠ `assignee_id` para honestidade no histórico).
- **Editar/excluir:** somente `created_by`. Quem recebe uma tarefa atribuída **não** pode
  excluí-la — só concluir/reabrir.
- **Tarefa pessoal** (criada por si para si): o dono faz tudo.
- **Atribuir a outra pessoa:** somente admin/gestor.
- **Moldes role:** criar/editar somente admin/gestor. **Moldes pessoais:** o próprio dono.
- **Painel/histórico da equipe:** admin/gestor.

## Telas

### `/tarefas/` — a Central (todas as roles)
- **Hoje:** tarefas do dia agrupadas — atrasadas no topo (vermelho), pendentes
  (ordenadas por prioridade depois hora/prazo), concluídas recolhidas embaixo.
- Item: check, título, etiqueta de categoria, badge de prioridade, hora/prazo e, se houver
  vínculo, link "↗ abrir lead/paciente" (abre conversa/ficha). Ao marcar o check, abre
  campo opcional de observação e grava `concluida_em`/`concluida_por`.
- **+ Nova tarefa:** cria pontual; para si mesma (qualquer role) ou, se admin/gestor,
  escolhe destinatário(s).
- **Minha rotina:** a pessoa gerencia seus moldes pessoais.

### `/tarefas/gestao/` — admin/gestor
- **Painel da equipe:** % de conclusão do dia por pessoa, atrasadas por pessoa, total
  pendente.
- **Atribuir tarefa:** pontual para um ou vários funcionários de uma vez.
- **Moldes por cargo:** CRUD da rotina padrão de cada role.
- **Histórico:** filtros por pessoa / período / categoria.

### Navegação
- Nova seção/menu "Tarefas". `/tarefas/` visível a todas as roles operacionais;
  `/tarefas/gestao/` apenas `admin,gestor`.
- Central de Tarefas entra como candidata na tabbar mobile personalizável.

## Notificações

- **Sininho** no header compartilhado (`shared-nav.js`): contador de tarefas
  atribuídas não vistas / atrasadas; aparece em qualquer tela.
- **Push do SO** via `web-push`: ao entrar pela 1ª vez na Central, pede permissão e salva
  em `task_push_subs` via `POST /api/tarefas/push-sub`. O `sw.js` trata o evento `push`
  e o clique (abre `/tarefas/`).
- **Gatilhos:**
  1. **Atribuição:** ao criar `tipo=pontual` com `assignee_id ≠ created_by` → push imediato.
  2. **Manhã:** cron dispara um push-resumo por usuário com tarefas no dia.
  3. **Prazo:** cron periódico verifica `status=pendente` com `prazo` vencendo/vencido →
     push (com proteção anti-duplicação: marca que já avisou).

## API (rotas em `server.js`)

| método | rota | acesso | descrição |
|---|---|---|---|
| GET | `/api/tarefas?data=hoje` | auth | gera-sob-demanda + retorna tarefas do usuário |
| POST | `/api/tarefas` | auth | cria pontual (valida atribuição a outro = gestor/admin) |
| PATCH | `/api/tarefas/:id` | auth | concluir / reabrir / editar (conforme permissões) |
| DELETE | `/api/tarefas/:id` | auth | só `created_by` |
| GET | `/api/tarefas/templates` | auth | moldes do usuário (pessoais + role) |
| POST | `/api/tarefas/templates` | auth | cria molde (role ⇒ gestor/admin) |
| PATCH | `/api/tarefas/templates/:id` | auth | edita (dono ou gestor/admin p/ role) |
| DELETE | `/api/tarefas/templates/:id` | auth | remove |
| GET | `/api/tarefas/gestao` | admin/gestor | painel + histórico da equipe (filtros) |
| POST | `/api/tarefas/push-sub` | auth | salva assinatura de push |

Cron leve no mesmo padrão do scheduler existente, com proteção anti-duplicação de push
e idempotência na geração.

## Tratamento de erros

- Geração sob demanda nunca derruba o GET: se falhar, loga e retorna o que já existe.
- Cron self-healing: falha não impede a geração sob demanda (não é o único responsável).
- Atribuir a usuário inexistente/inativo → 400 com mensagem clara.
- Permissão negada (editar/excluir tarefa de terceiro) → 403.
- Push com assinatura expirada (410/404 do endpoint) → remove a subscription.

## Testes

- Recorrência: diária com `dias_semana`, semanal, mensal (incluindo `dia_mes` > último dia).
- Idempotência: chamar `gerarTarefasDoDia` 2x não duplica.
- Arrasta vs zera: tarefa que arrasta reaparece como atrasada com `data_ref` original;
  tarefa que zera vira "não-feita" e não reaparece.
- Permissões: assignee não exclui tarefa atribuída; gestor conclui no lugar de outro
  (grava `concluida_por`); funcionário não atribui a colega.
- Painel do gestor reflete tarefas pré-geradas pelo cron de quem não logou.
- Fuso: virada do dia consistente para acesso perto da meia-noite.

## Fora de escopo (v1 / YAGNI)

- Subtarefas/checklists aninhados.
- Reatribuição em massa / fluxos de aprovação.
- Comentários/conversa dentro da tarefa.
- Anexos.
- Hierarquia de equipes (gestor vê todos; clínica é pequena).
