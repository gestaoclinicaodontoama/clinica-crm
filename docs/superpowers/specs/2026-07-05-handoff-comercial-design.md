# Handoff Comercial + "Meu Dia" — Design

**Data:** 2026-07-05
**Contexto:** Item 3 da fila de melhorias do CRM (análise de pontas soltas 03/07). O CRM é "oco no meio": quando um lead vira "Compareceu" ninguém é avisado, `crc_comercial_id` está **zerado (0 de todos)** — logo é impossível medir a CRC comercial — e ela não tem home de trabalho (ao logar cai no primeiro item de menu visível). Momento mais caro do funil (paciente veio à clínica) fica sem dono e sem cobrança.

## Descobertas de dados/código (medidas em produção)

- `crc_comercial_id` preenchido em **0** leads. Nunca setado server-side; o único auto-set é client-side no mini-kanban do WhatsApp Comercial, restrito a `Em negociação`/`Fechou`/`Perdido` (`public/index.html:2884`), nunca em `Compareceu`.
- Status `Compareceu` tem **1.412 leads** — quase tudo backlog histórico/importado. O fluxo real é **~61/mês** (`status_mudou`→Compareceu nos últimos 30d) — ~2/dia.
- `Em negociação` agora = **26** (pipeline ativo).
- **2 CRC comerciais ativas:** Bruna Fernandes (`a42c4931-15da-4169-8813-8137d791a117`) e Gabriela Lorraine (`469ea2d5-dc68-463e-a4ed-02d2d019cd18`).
- 3 pontos server-side setam `status='Compareceu'`, todos gravam `data_comparecimento` + evento `status_mudou`, nenhum toca `crc_comercial_id` nem notifica: patch manual (`server.js:754`, tem `req.user`), sync 10min (`server.js:3933`/`3963`, autor null), webhook (`server.js:4137`, autor null). Todos guardam `_PODE_COMPARECER`/`PRE_COMPARECEU` (só promovem de Novo/Em qualificação/Avaliação agendada → dispara uma vez por lead).
- Padrão de "assumir dono se vazio" já existe: `assumirConversaSeSemDono` (`server.js:2037`, guard `.is(campo,null)`) — molde para o comercial.
- Kanban comercial: coluna `compareceu` já filtra `data_comparecimento >= hoje-30` (`server.js:966`); filtro por CRC é por `crc_comercial_nome` (`server.js:984`).
- `criarNotificacao(usuarioId, tipo, titulo, corpo, metadata)` (`server.js:7071`); constraint `notificacoes_tipo_check` (migração `20260705130000`) — tipo novo exige ampliar o CHECK.
- `proximo_contato` no `ALLOWED` do PATCH; "vencido" só cosmético nos cards do chat (`public/index.html:2842`) — não há query server-side de follow-ups vencendo.
- Padrão de página separada por-CRC (monitor-crc, kanban-comercial): pasta `public/<modulo>/` + `public/js/<modulo>/api.js` + item em `CRM_NAV` (nav-config.js) + `requireRole` no server (CLAUDE.md:39-125).

## Decisões do Luiz (brainstorm 05/07)

1. **Modelo de atribuição:** claim-first / pool (não rodízio forçado).
2. **Gatilho do claim:** botão "Pegar" no Meu Dia **E** automático ao trabalhar (mover card no kanban comercial / responder no WhatsApp comercial).
3. **Meu Dia = home padrão** ao logar como `crc_comercial`.
4. Backlog dos 1.412 antigos: não backfillar; fila "para pegar" limitada aos últimos 30 dias.
5. Egress: tudo server-side filtrado (cota Supabase 155%).

## Componentes

### 1. Migração

- Amplia `notificacoes_tipo_check` com `novo_comparecimento` (padrão da `20260705130000`, preservando todos os tipos atuais).
- `app_config.comercial_pool jsonb` — ids das CRC comerciais a notificar/exibir no pool. Semear por `roles @> array['crc_comercial']` ativos (idempotente, `where … is null`).

### 2. Aviso no Compareceu (handoff)

Helper server-side `notificarComercialCompareceu(lead)`:
- Só age quando o lead **entra** em Compareceu e `crc_comercial_id` está vazio.
- Lê `app_config.comercial_pool` e dispara `criarNotificacao(uid, 'novo_comparecimento', '🤝 Novo comparecido', '<nome> compareceu — pegar no Meu Dia', { url:'/meu-dia/', lead_id })` para cada CRC do pool.
- Fire-and-forget (não bloqueia a resposta; try/catch; nunca `.catch()` em builder).

Plugado nos 3 pontos, **dentro** do bloco que já garante a transição única (não em toda passada do sync): `server.js:754` (patch), `server.js:3933`/`3963` (sync), `server.js:4137` (webhook). Dedup natural: os 3 só rodam quando o lead sai de pré-comparecimento; um evento `status_mudou`→Compareceu por lead.

### 3. Claim-first do `crc_comercial_id`

Helper `assumirComercialSeSemDono(lead, userId)` (espelho de `assumirConversaSeSemDono`):
- `update leads set crc_comercial_id=userId, crc_comercial_nome=<nome> where id=lead.id and crc_comercial_id is null` (guard `.is` — nunca sobrescreve) + `logEvento('comercial_assumido', …, userId)`.
- `.then().catch()` sobre a promise (não `.catch()` no builder).

Chamado em (todos exigem `req.user` = a CRC logada):
- **Botão "Pegar"** (Meu Dia): endpoint `POST /api/comercial/pegar/:leadId` → `assumirComercialSeSemDono` + retorna ok. Requer role `crc_comercial`.
- **Drag no kanban comercial**: no `patchLead`, quando quem edita tem role `crc_comercial` (via `req.user.profile.roles` — confirmado disponível: `patchLead` já usa `req.user?.id`/`req.user?.profile?.nome` em `server.js:754`) e o status alvo é comercial (`Compareceu`/`Em negociação`) e `crc_comercial_id` vazio → assume. (Estender o `patchLead` server-side; o kanban-comercial já faz o PATCH no drop, `public/kanban-comercial/index.html:399`.)
- **WhatsApp comercial**: o mini-kanban já auto-seta em Em negociação/Fechou/Perdido (`public/index.html:2884`); estender o mesmo `COMERCIAL_STATUSES` client-side para incluir `Compareceu` (1 linha), mantendo o guard `!lead.crc_comercial_id`.

### 4. Tela "Meu Dia" (`/meu-dia/`)

Página separada (padrão kanban-comercial): `public/meu-dia/index.html` + `public/js/meu-dia/api.js`. Item novo em `CRM_NAV` na seção "CRC Comercial" (`roles: 'admin,gestor,crc_comercial'`). Endpoint único `GET /api/comercial/meu-dia` (`requireRole('crc_comercial','gestor','admin')`), filtrado por `req.user.id`, retornando 4 blocos numa RPC/consulta server-side (resultados pequenos):

- **📥 Para pegar** — `status='Compareceu'` AND `crc_comercial_id is null` AND `data_comparecimento >= hoje-30`, ordenado `data_comparecimento` desc. Cada item com botão **Pegar**. (Pool compartilhado; **34 no arranque** medido em prod — o backlog de 1.412 fica de fora pelo filtro de 30 dias.)
- **🤝 Meus comparecidos** — `status='Compareceu'` AND `crc_comercial_id = eu` (peguei, ainda não movi p/ negociação).
- **💬 Minhas negociações** — `status='Em negociação'` AND `crc_comercial_id = eu`, mostrando `etapa_negociacao` (D0–D5).
- **⏰ Follow-ups vencendo** — meus leads (`crc_comercial_id = eu`) com `proximo_contato <= hoje` (vira lista real; hoje só existe cosmético no chat). ⚠️ Medido: hoje **0 leads** têm `proximo_contato` preenchido (o campo é pouco usado — ver item 1 da análise). Logo o bloco **nasce vazio** e enche conforme as CRC marcarem follow-up; é esperado, não é bug. Estado vazio amigável ("nenhum follow-up marcado — use o 📅 no lead").

Cada card: nome, telefone (link WhatsApp), status/etapa, data relevante, `proximo_contato`; clicar → abre o lead (perfil/conversa via `?abrir_lead=`). **Gestor/admin (v1):** vê o agregado das duas CRC comerciais (blocos "Meus comparecidos"/"Minhas negociações"/"Follow-ups" = de ambas; "Para pegar" = os sem dono). Sem seletor de CRC no v1 (fica pro item de métricas por CRC, futuro).

**Home padrão:** ao logar como `crc_comercial`, o destino default passa a ser `/meu-dia/` em vez do "primeiro item visível" (`public/index.html:5930`). Ajuste mínimo no roteamento de landing (checar role → redirecionar).

## Erros e bordas

- Lead sem telefone → card sem link WhatsApp; não quebra.
- Dois cliques em "Pegar" concorrentes → o guard `.is(crc_comercial_id, null)` garante um dono só; o 2º update casa 0 linhas (a UI recarrega e mostra o dono real).
- Notificação duplicada no Compareceu → os 3 pontos só disparam na transição (guard de pré-comparecimento); sem risco de spam por passada de sync.
- Backlog 1.412: fila "para pegar" limitada a 30 dias → não aparece.
- Erro na notificação/claim não pode derrubar o fluxo de status (try/catch; fire-and-forget).
- NUNCA `.catch()` direto em builder Supabase — try/catch no await.
- Somas/filtros no SQL (RPC), nunca no JS (limite 1000 linhas).

## Testes

- `node:test` para a lógica pura que houver (ex.: montar os 4 blocos a partir de um conjunto de leads — se extraída para lib). O grosso é IO/SQL; validar via consulta em produção (leitura): os 4 blocos retornam contagens coerentes (para pegar ~60, negociações ~26 divididas).
- Verificação pós-deploy: (a) forçar um Compareceu de teste → o pool recebe notificação; (b) botão Pegar seta `crc_comercial_id`; (c) mover card no kanban por uma CRC comercial → auto-claim; (d) Meu Dia vira home ao logar como crc_comercial.

## Critérios de sucesso

1. Todo novo Compareceu notifica as CRC comerciais em ≤ (intervalo do caminho: instantâneo no patch/webhook, ≤10min no sync).
2. Botão "Pegar" e o trabalho no lead (kanban/WhatsApp) passam a popular `crc_comercial_id` — deixando a CRC comercial finalmente mensurável.
3. A CRC comercial loga e cai no Meu Dia com os 4 blocos, filtrados só pra ela, sem o backlog antigo.
4. Follow-ups vencendo viram uma lista acionável, não só um destaque no chat.

## Fora do escopo (v1)

Métricas/ranking por CRC comercial (depende de `crc_comercial_id` já populado — vem depois); alterar os dashboards agregados existentes (`/comercial/`); backfill dos 1.412 Compareceu antigos; SLA/estagnação de D0–D5 (item 4 da fila).
