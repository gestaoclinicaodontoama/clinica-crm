# Entrega ② — Registro por Sessão (ASB) — Design

**Data:** 2026-07-20. Segue o Modo de Planejamento ① + Transição (no ar). Alimenta ③ (planejado×real) e ④ (tracker).

## Objetivo
A ASB registra, pelo celular, o que foi feito na sessão — clicando a etapa do plano em vez de digitar. Fica gravado qual ASB, quando, e o tempo real. Isso torna a auditoria fina (por sessão, não por paciente) e dá matéria-prima pro planejado×real.

## Decisões (Luiz, 20/07)
- Perfil base **`asb`** — a gestora cria os logins no módulo de Usuários. Tela **mobile-first**.
- Lista = **todos que compareceram hoje** (com ou sem plano) + **busca para registro retroativo** (paciente por nome / dia passado — cobre os protocolos em curso).
- Fora do plano / sem plano = **(b)** "Atendimento realizado" + observação livre (rápido; dentista/Mônica ajusta o plano depois).
- Gestora/Mônica também acessam (cobrir + conferir quem registrou).

## Dados
- Reusa `plano_etapas` (já tem `tempo_real_min`, `asb_responsavel uuid`, `concluida_em`, `status`). Marcar etapa = update aqui (status→`concluida`).
- Nova tabela `sessao_avulsa` (o caso b + registro de comparecimento sem etapa):
  `id, paciente_clinicorp_id text, paciente_nome text, data date, asb_user_id uuid, obs text, plano_id bigint null, criado_em timestamptz`. RLS on, sem policy.

## API (`requireAuth` + `blockParceiro` + role `asb,gestor,admin,mod_planejamento`)
- `GET /api/sessao/dia?data=YYYY-MM-DD` (default hoje): agenda `compareceu=true, deleted=false` do dia → por paciente: `{paciente_clinicorp_id, nome, horario, plano:{id,status} | null, itens_etapas:[...], ja_registrado_hoje:bool}`. Resolve plano ativo por `paciente_clinicorp_id`.
- `GET /api/sessao/buscar?q=` (retroativo): busca paciente (nome/telefone) → plano ativo + etapas, pra registrar sessão de qualquer data.
- `POST /api/sessao/etapa` `{etapa_id, tempo_real_min?, data?}`: marca etapa `concluida` + `asb_responsavel=req.user.id` + `concluida_em`. Avança o plano: `planejado`/`aguardando`→`em_andamento` no 1º registro; se TODAS as etapas do plano viram concluída/retroativa → `concluido` (via `transicaoValida`). Idempotente (marcar de novo não duplica).
- `POST /api/sessao/avulso` `{paciente_clinicorp_id, paciente_nome, obs, data?, plano_id?}`: insert em `sessao_avulsa`. É o (b).

## Auditoria (refina a Task 9)
`classificarDia` passa a considerar **registro por sessão do dia**: paciente compareceu e há etapa concluída OU `sessao_avulsa` naquele dia = **registrado**; compareceu + plano ativo + nada registrado = **pendência real**. Substitui a dispensa grosseira "por paciente com plano ativo".

## UI `/sessao/` (mobile-first)
- Nav: seção nova ou dentro de Produção — item `{ slug:'sessao', label:'Registrar Sessão', roles:'asb,gestor,mod_planejamento', mode:'link', href:'/sessao/' }`.
- Usuários: registrar perfil base `asb` (padrão dinâmico `_ALL_ROLES_DEF`/`_ROLE_LABELS`), + `requireRole` no servidor.
- Cartões grandes tocáveis: nome + horário + selo do plano. Toque → etapas (checkbox grande + tempo pré-preenchido) OU botão "Atendimento realizado" (b) com campo obs. Busca no topo pro retroativo. Token `sb-*-auth-token`, retry 5xx, esc() em tudo.

## Fora de escopo
Escrita na ficha da Clinicorp (usuário-robô, pende login). Tracker ④ (vem depois, alimentado por esta).

## Testes
Unit: avanço de estado (marca etapa → em_andamento; última → concluido); classificarDia com registro por sessão. Manual: ASB registra no celular (etapa + avulso + retroativo); auditoria reflete; plano conclui.
