# Entrega ③ — Fiscalização da gestora (planejado × real) — Design

**Data:** 2026-07-20. Segue ① (planejamento) + ② (registro ASB, que alimenta o tempo real). Escopo (A): horas planejado×real + custo de hora clínica + alerta; margem CHEIA (com laboratório/imposto) fica pra depois (elo do valorLaboratorio ainda não destravado).

## Objetivo
Dar à gestora duas visões: (1) **cobertura** — a equipe está registrando as sessões? (2) **planejado × real** — cada tratamento está dentro do tempo de cadeira planejado, e quanto o tempo real custa a R$/hora.

## Dados (tudo já existe — SEM migração)
- Planejado: `SUM(plano_etapas.tempo_planejado_min)` por plano.
- Real: `SUM(plano_etapas.tempo_real_min)` por plano (a ② preenche pelo agendamento, deduplicado por sessão — somar dá o tempo real de cadeira correto).
- Config: `planejamento_config.custo_hora_clinica` (180), `margem_alvo_default` (20). A ③ finalmente expõe a UI de editar (a ① criou os campos).
- Cobertura: sessão = agendamento `compareceu` com plano ativo; "registrada" = tem etapa concluída no dia OU `sessao_avulsa` no dia (mesma lógica da auditoria da ②).

## Cálculo (lib pura, TDD)
`resumoPlano({ tempo_planejado_min, tempo_real_min, valor }, custoHora)`:
- `plan_h = planejado/60`, `real_h = real/60`.
- `delta_min = real - planejado`; `estouro = real > planejado` (só quando ambos > 0).
- `custo_cadeira = real_h * custoHora` (R$).
- `pct_receita_cadeira = valor > 0 ? custo_cadeira/valor : null` (quanto a CADEIRA consome da receita — NÃO é margem cheia; honesto na UI).
- Retorna esses campos + um flag de severidade (ok / atenção se estouro / crítico se custo_cadeira já passa de (1 - margem_alvo) da receita).

## API (`requireAuth` + `blockParceiro` + role `gestor,admin,mod_planejamento`; nunca `.catch()` no builder)
- `GET /api/fiscalizacao/planejado-real?from=&to=`: planos com status em (`planejado`,`em_andamento`,`concluido`) cujo período de atividade cai na janela → por plano: `{plano_id, paciente_nome, dentista, status, tipo_pagamento, planejado_min, real_min, valor}` + o resumo calculado. + um agregado geral (total planejado/real, nº estourando).
- `GET /api/fiscalizacao/cobertura?from=&to=`: por dentista → `{dentista, sessoes_com_plano, registradas, pct}`. Sessão = agenda compareceu+plano ativo; registrada = etapa concluída no dia ou avulso no dia.
- `GET /api/fiscalizacao/config` + `PUT` (só gestor/admin): `{custo_hora_clinica, margem_alvo_default}`. PUT valida números ≥ 0.

## UI `/producao/fiscalizacao/`
- Nav: seção Produção, `{ slug:'producao-fiscalizacao', label:'Fiscalização', roles:'gestor,admin,mod_planejamento', mode:'link', href:'/producao/fiscalizacao/' }`.
- Filtro de período (default últimos 30 dias).
- **Painel Config** (topo, gestor): custo hora clínica + margem-alvo, editável (salva no PUT).
- **Painel Cobertura:** tabela por dentista (sessões / registradas / %); barra visual; destaque quem está baixo.
- **Painel Planejado × Real:** tabela por tratamento — paciente, dentista, selo pgto, planejado (h), real (h), Δ, custo de cadeira (R$), % da receita que a cadeira consome; linhas que estouram destacadas (âmbar/vermelho). Rodapé com o total. Nota honesta: "custo de CADEIRA (tempo × hora clínica) — a margem completa inclui laboratório/imposto, em breve."
- Token `sb-*-auth-token`, retry 5xx, esc() em tudo.

## Fora de escopo
Margem cheia (laboratório do Controle Protético + imposto + profissional) — próxima camada, quando o valorLaboratorio destravar (ver ideias-ia-terminal-mcp-clinicorp / lucratividade-tratamento-360). Escrita/ação corretiva — a ③ é leitura/diagnóstico.

## Testes
Unit: `resumoPlano` (dentro/estouro/crítico/valor nulo/tempos zerados). Manual: página abre, config salva, números batem com um plano conhecido.
