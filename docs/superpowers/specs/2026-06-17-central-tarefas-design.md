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
9. **Registrar quantidade** = a tarefa pode pedir um número ao concluir (`tipo_resultado`),
   com unidade e meta opcionais. A tarefa é a camada de **captura** do dado; gráficos de
   tendência/metas elaboradas ficam para um futuro módulo "Indicadores" que lê desses
   valores. Sininho usa `visto_em` (estado de leitura real).

## Arquitetura geral

Segue o padrão existente do CRM:
- **Back-end:** rotas em `server.js` (Express), protegidas por `requireAuth` + `requireRole`.
- **Banco:** Supabase (Postgres).
- **Front-end:** páginas HTML em `/public/tarefas/`, navegação por `data-roles`,
  header compartilhado (`shared-nav.js`) e tabbar mobile (`mobile-nav.js`).
- **Notificações:** `web-push` (VAPID já configurado) + service worker (`sw.js`).
  O `sw.js` **já trata** `push` e `notificationclick`; o back-end deve enviar o payload
  no formato existente: `{ title, body, data: { url, tipo } }` — onde `url` leva pra
  `/tarefas/` e `tipo` vira a `tag` da notificação.
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
| `dias_semana` | int[] null | 0–6, **0=domingo** (convenção `Date.getDay()`); usado em diária (subset de dias) e semanal |
| `dia_mes` | int null | 1–31; usado em mensal |
| `hora_sugerida` | time null | |
| `prioridade` | text | `'alta'` \| `'normal'` \| `'baixa'` (default normal) |
| `categoria` | text null | de uma lista pré-definida (ver "Categorias") — evita fragmentar o painel |
| `tipo_resultado` | text | `'check'` (default) \| `'numero'` |
| `unidade` | text null | rótulo do número quando `tipo_resultado=numero` (ex.: "ligações", "R$") |
| `meta` | numeric null | alvo do dia quando `tipo_resultado=numero` (ex.: 50) |
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
| `categoria` | text null | da lista pré-definida |
| `tipo_resultado` | text | `'check'` \| `'numero'` (herdado do molde) |
| `unidade` | text null | rótulo do número (herdado) |
| `meta` | numeric null | alvo (herdado) |
| `valor_resultado` | numeric null | valor digitado na conclusão (quando `tipo_resultado=numero`) |
| `prazo` | timestamptz null | opcional |
| `lead_id` | bigint null | vínculo opcional com lead (FK `leads(id)` ON DELETE SET NULL) |
| `paciente_clinicorp_id` | text null | vínculo opcional com paciente (id transversal Clinicorp, sem FK) |
| `arrasta` | bool | herdado do molde ou definível na pontual |
| `status` | text | `'pendente'` \| `'concluida'` |
| `concluida_em` | timestamptz null | |
| `concluida_por` | uuid null | |
| `obs_conclusao` | text null | observação opcional no check |
| `visto_em` | timestamptz null | quando o assignee viu a tarefa (alimenta o contador do sininho) |
| `prazo_avisado_em` | timestamptz null | quando o push de prazo já foi enviado (dedup) |
| `created_at` | timestamptz | |

Índices: `(assignee_id, data_ref, status)`, `(status, prazo)`, `(template_id, assignee_id, status)`.

**Categorias (lista pré-definida v1):** Leads, Comercial, Pacientes, Financeiro,
Administrativo, Marketing. Editável no código; mantida como enum/lista pra o filtro do
painel não fragmentar.

### Push e notificações — **reuso de infra existente** (sem tabela nova)
O CRM já tem tudo pronto, então a Central **reusa**:
- Tabela `push_subscriptions` + endpoints `POST/DELETE /api/push/subscribe`.
- Tabela `notificacoes` (sininho global no `index.html`) — o check de `tipo` já aceita
  `'tarefa_atribuida'` e `'tarefa_vencendo'`; adicionamos `'tarefa_resumo'` (manhã).
- Helpers `sendPushToUser(usuarioId, title, body, data)` e
  `criarNotificacao(usuarioId, tipo, titulo, corpo, metadata)` (grava no sininho + push).

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
  logou. Depois dispara o **push da manhã** ("você tem N tarefas hoje"). A varredura busca
  moldes **em lote** (um SELECT por escopo, não um por usuário) para evitar N+1.
- **Snapshot:** editar/desativar um molde **não** reescreve tarefas já geradas — elas
  guardam título/categoria/etc. do momento da geração (comportamento intencional).
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
- **Editar molde role** afeta só gerações futuras (snapshot — tarefas já criadas não mudam).

## Telas

### `/tarefas/` — a Central (todas as roles)
- **Hoje:** tarefas do dia agrupadas — atrasadas no topo (vermelho), pendentes
  (ordenadas por prioridade depois hora/prazo), concluídas recolhidas embaixo.
- Item: check, título, etiqueta de categoria, badge de prioridade, hora/prazo e, se houver
  vínculo, link "↗ abrir lead/paciente" (abre conversa/ficha). Ao marcar o check, abre
  campo opcional de observação e grava `concluida_em`/`concluida_por`.
- **Tarefa de número** (`tipo_resultado=numero`): em vez de só check, concluir **exige
  digitar o valor** (com a `unidade` como rótulo); se houver `meta`, o item mostra
  "X / meta Y". O valor grava em `valor_resultado`.
- **+ Nova tarefa:** cria pontual; para si mesma (qualquer role) ou, se admin/gestor,
  escolhe **um ou vários destinatários** (fan-out: uma tarefa por pessoa).
- Ao abrir a lista, as tarefas exibidas são marcadas com `visto_em` (zera o sininho).
- **Minha rotina:** a pessoa gerencia seus moldes pessoais.

### `/tarefas/gestao/` — admin/gestor
- **Painel da equipe:** % de conclusão do dia por pessoa, atrasadas por pessoa, total
  pendente. Para tarefas de número, mostra soma/média de `valor_resultado` por pessoa e
  período, comparada à `meta` quando houver.
- **Atribuir tarefa:** pontual para um ou vários funcionários de uma vez.
- **Moldes por cargo:** CRUD da rotina padrão de cada role.
- **Histórico:** filtros por pessoa / período / categoria.

### Navegação
- Nova seção/menu "Tarefas". `/tarefas/` visível a todas as roles operacionais;
  `/tarefas/gestao/` apenas `admin,gestor`.
- Central de Tarefas entra como candidata na tabbar mobile personalizável.

## Notificações

- **Sininho** no header compartilhado (`shared-nav.js`): contador = tarefas pendentes
  com `visto_em IS NULL` atribuídas por terceiro **+** atrasadas. Abrir a Central marca as
  exibidas com `visto_em` (zera o contador). Aparece em qualquer tela.
- **Push do SO** via `web-push` (já configurado): registro reusa `POST /api/push/subscribe`
  (já existe e é usado pelo `index.html`). O `sw.js` já trata `push`/`notificationclick`.
- **Gatilhos** (todos via `criarNotificacao`, que grava no sininho global + dispara push):
  1. **Atribuição:** ao criar `tipo=pontual` com `assignee_id ≠ created_by` →
     `criarNotificacao(assignee, 'tarefa_atribuida', ...)`.
  2. **Manhã:** cron dispara `criarNotificacao(user, 'tarefa_resumo', ...)` por usuário.
  3. **Prazo:** cron verifica `status=pendente` com `prazo` vencendo/vencido e
     `prazo_avisado_em IS NULL` → `criarNotificacao(assignee, 'tarefa_vencendo', ...)`,
     grava `prazo_avisado_em` (dedup).

## API (rotas em `server.js`)

| método | rota | acesso | descrição |
|---|---|---|---|
| GET | `/api/tarefas?data=hoje` | auth | gera-sob-demanda + retorna tarefas do dia; marca `visto_em` |
| GET | `/api/tarefas/historico?de=&ate=` | auth | histórico próprio do usuário por período |
| POST | `/api/tarefas` | auth | cria pontual; aceita `assignee_ids[]` (fan-out — 1 tarefa/pessoa); atribuir a outro = gestor/admin |
| PATCH | `/api/tarefas/:id` | auth | concluir (com `valor_resultado` se número) / reabrir / editar |
| DELETE | `/api/tarefas/:id` | auth | só `created_by` **e** só se `status=pendente` (não apaga concluída — preserva histórico) |
| GET | `/api/tarefas/templates` | auth | moldes do usuário (pessoais + role) |
| POST | `/api/tarefas/templates` | auth | cria molde (role ⇒ gestor/admin) |
| PATCH | `/api/tarefas/templates/:id` | auth | edita (dono ou gestor/admin p/ role) |
| DELETE | `/api/tarefas/templates/:id` | auth | remove |
| GET | `/api/tarefas/gestao` | admin/gestor | painel + histórico da equipe (filtros) |

(Push usa o já existente `POST/DELETE /api/push/subscribe` — sem rota nova.)

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
  (grava `concluida_por`); funcionário não atribui a colega; DELETE bloqueado em concluída.
- Painel do gestor reflete tarefas pré-geradas pelo cron de quem não logou.
- Fuso: virada do dia consistente para acesso perto da meia-noite.
- Tarefa de número: concluir sem `valor_resultado` é rejeitado; soma/média no painel.
- Atribuição multi-pessoa (`assignee_ids[]`) gera uma tarefa por destinatário.
- Push: subscription expirada (410/404) é removida; `prazo_avisado_em` evita push repetido.
- Sininho: `visto_em` zera o contador ao abrir a Central.

## Fora de escopo (v1 / YAGNI)

- Subtarefas/checklists aninhados.
- Reatribuição em massa / fluxos de aprovação.
- Comentários/conversa dentro da tarefa.
- Anexos.
- Hierarquia de equipes (gestor vê todos; clínica é pequena).
- Módulo "Indicadores": gráficos de tendência, evolução mês a mês, metas com bônus,
  comparativos — lê dos `valor_resultado` no futuro. v1 só captura o dado.
