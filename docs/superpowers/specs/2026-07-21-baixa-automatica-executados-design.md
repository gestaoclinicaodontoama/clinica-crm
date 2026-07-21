# Baixa Automática de Executados (Clinicorp → plano) — Design

**Data:** 2026-07-21. Pedido do Luiz: "a ideia não é dar trabalho, é poupar" — o que o Clinicorp já mostra como Executado deve dar baixa sozinho no nosso plano; o `/sessao/` continua lembrando as ASBs do que não foi registrado (chair time).

## Comportamento hoje
`Executed=X` do orçamento só é aproveitado NA CRIAÇÃO do plano (`clinicorp-sync.js` ~1177: etapas de padrão nascem `concluida_retroativa` quando `executados >= quantidade`). Depois disso, execução no Clinicorp não reflete no plano — a equipe marca manual.

## Regra nova (fase do re-sync noturno + sync manual, `syncPlanejamento`)
Para cada plano ativo com orçamento casado — **PULANDO todo plano com `trava_resync` setada (⚠️ plano JÁ travado devolve `acoes:[]` do aplicarResync nas noites seguintes — o guard explícito é obrigatório, igual ao 409 do endpoint manual) E todo plano que recebeu QUALQUER ação do `aplicarResync` neste giro** (`acoes.length > 0`: travar/cancelar/regredir/ressuscitar/add/remove — o objeto `plano` em memória fica obsoleto após `executarAcoesResync`; baixar com status velho ressuscitaria plano recém-cancelado ou desfaria regressão; a baixa desses fica para a PRÓXIMA noite, com a estrutura assentada) — para cada **item raiz `tipo='clinicorp'`** casado por `price_id`:
- **Só item TOTALMENTE executado** (`novo.executados >= item.quantidade`) e ainda não concluído no nosso lado. Parcial fica pro manual/ASB (sub-lotes não são adivinháveis).
- **Fonte da data/executor: `producao_procedimentos`** (⚠️ o `orcamentos.procedure_list` NÃO carrega `ExecutedDate` — só 6 campos; `agruparItens` fica INTOCADO, usa-se só o `executados` que ele já tem). Lookup por `clinicorp_estimate_id` + `price_id`: `ultima_execucao = max(executed_date)`, `executor_nome = dentist_name` da linha mais recente. Borda: linha executada com `Amount<=0` ou fora da janela de 90d da produção não está lá → fallback `concluida_em = data do sync` (documentado, aceitável).
- **Baixa:** etapas pendentes do item **e dos sub-lotes filhos** → `status='concluida_retroativa'`, `concluida_em = ultima_execucao` (formato `YYYY-MM-DDT12:00:00-03:00`; fallback data do sync), `profissional_executor` = o da etapa (se tiver) → `executor_nome` da produção → executor do item; `asb_responsavel = NULL` (baixa automática), `tempo_real_min` = **[SUPERSEDIDO pelo Ajuste 21/07 abaixo: agora vem da AGENDA, por (dia, profissional)]**.
- Item **com ZERO etapas em item+filhos** (guard IDÊNTICO ao do "Executar procedimento" manual — evita colidir com sintética manual) → cria **1 sintética** (`ordem=999`, `descricao=procedure_name`, `concluida_retroativa`, mesmos campos). Idempotente nos dois sentidos: item já todo concluído (manual ou automático) → nada.
- Após qualquer baixa no plano: recalcular com `statusAposRegistro` da lib (**adicionar ao require do sync** — hoje só importa `aplicarResync` etc.). SEM guard — aqui HÁ execução real. ⚠️ **Escopo do recálculo = o PLANO INTEIRO, com dados FRESCOS**: re-query de TODAS as etapas de TODOS os itens raiz ativos (INCLUSIVE `tipo='externo'`) APÓS as escritas da baixa, replicando o cálculo de `temItemSemEtapa` do `avancarPlanoAposRegistro` do server (duplicação aceita — o helper não é exportável p/ o sync; o `itensPlano` em memória fica obsoleto pós-baixa e NÃO pode ser reusado). Sem isso, plano com fase externa pendente ou item não-executado concluiria indevidamente. Update com `atualizado_em`.
- **Fases externas (`tipo='externo'`) NUNCA são tocadas** (não têm par no orçamento — match por price_id já as ignora naturalmente; deixar comentário explícito).
- Contador no log do sync: `baixas automáticas: N etapas em M planos`.

## Lib
`agruparItens`/triagem **INTOCADOS** (o `executados` que ele já computa basta; data/executor vêm de `producao_procedimentos` — ver Regra).

## O que NÃO muda
- Marcação manual (✓ do modal) e registro da ASB continuam valendo e têm precedência natural (etapa já concluída = intocada).
- Filtro `tempo IS NOT NULL` de `jaRegistrouHoje`/`ja_registrado_hoje` intocado — **[Ajuste 21/07: a baixa agora grava tempo NOT NULL, então ela CONTA como registro e a ASB é liberada]**.
- Resync de estrutura (adicionar/remover/travar) intocado.
- **Efeitos colaterais documentados (intencionais):** (a) pós-baixa, um veredito CRC `duplicata`/`nao_venda` nesse plano passa a TRAVAR (veredito tardio) em vez de cancelar limpo — correto: se o Clinicorp mostra executado, não é venda-fantasma, decisão vira humana; (b) `etapas_executadas=true` amplia as travas legítimas do re-sync futuro (mudança/remoção do item passa a travar p/ gestora) — proteção desejada de trabalho executado.

## Segurança/robustez
- Nenhuma rota nova, nenhuma tabela; escrita só via service_role no sync. Sem `.catch()` em builder.
- Ordem dentro do `syncPlanejamento`: a baixa roda DEPOIS do `aplicarResync` do plano (estrutura primeiro) e é PULADA para qualquer plano com `plano.trava_resync` OU `acoes.length > 0` no giro (ver Regra) — cobre travado (nesta E nas noites seguintes)/cancelado/regredido/ressuscitado.

## Testes
- **Unit:** nenhum na lib (`agruparItens` intocado). A parte pura nova é mínima; cobertura fica no manual + idempotência.
- **Manual:** paciente com procedimento executado no Clinicorp (ex.: Vandercil 21493 — Documentação 30/06 e Raspagem 30/06) → rodar sync manual → itens ✅ com data 30/06 e executor na trilha/tracker; plano avança; **[Ajuste 21/07: /sessao/dia passa a mostrar o dia como registrado — ASB liberada]**; rodar de novo → idempotente; fase externa intocada.

## AJUSTE 21/07 (decisão Luiz pós-entrega): baixa carrega o TEMPO e libera a ASB
> "Se o sistema já está com a baixa, não tem porquê aparecer pra ASB fazer alguma coisa. O tempo deve ser capturado pelo tempo de agendamento dos dias. Atentar: pode ter mais de um procedimento no dia com o mesmo profissional e até profissionais diferentes."

**Reversão consciente da regra anterior** (tempo NULL p/ manter a cobrança): a baixa automática passa a gravar `tempo_real_min` da AGENDA — com tempo NOT NULL, `jaRegistrouHoje`/`ja_registrado_hoje` contam a baixa e o `/sessao/` **deixa de cobrar** a ASB pelo que o Clinicorp já baixou. O lembrete da ASB vale só para o que AINDA não tem baixa em lugar nenhum.

**Captura do tempo — algoritmo do CONSUMO DE AGENDAMENTOS (por paciente+dia):**
1. Universo: `agenda_appointments` do `plano.paciente_clinicorp_id` no `executed_date` (`deleted=false`; preferir `compareceu=true`, fallback aceitar sem check-in — a execução prova presença). Cada agendamento do dia pode ser **consumido no máximo 1×**.
2. **Pré-consumo pelo manual:** se existe registro com `tempo_real_min IS NOT NULL` naquele **paciente+dia** (etapa de QUALQUER plano do paciente via `concluida_em`, ou `sessao_avulsa`) → marcar como consumido o agendamento de **MAIOR duração** do dia (é o que `duracaoSessao` teria dado ao manual — decisão: opção "manual consumiu o maior"; a baixa por profissional pula só ESSE, preservando o agendamento do 2º profissional). Escopo por PACIENTE, não por plano (2 planos do mesmo paciente no dia não contam o agendamento 2×).
3. **Atribuição por profissional:** o select da produção passa a incluir **`dentist_person_id`** (⚠️ hoje só puxa executed_date/dentist_name). Casar `dentist_person_id` da produção × do agendamento → consome AQUELE agendamento; sem match (person_id NULL em qualquer lado — ambos são nullable; documentado: colapsa) → consome o de **maior duração ainda não consumido**; nada sobrando → tempo 0.
4. **`?? 0` SEMPRE:** agendamento casado com `duration_minutes` NULL → 0. Sem agendamento nenhum → 0. **NUNCA NULL** (tempo NULL faria `jaRegistrouHoje` ignorar a baixa e a ASB voltaria a ser cobrada — o oposto do ajuste).
5. **1ª etapa leva, demais 0 — escopo do grupo = o GIRO inteiro do plano:** o rastreio de consumo (mapa paciente+dia→agendamentos consumidos) vive na memória do processamento do plano e atravessa TODOS os itens baixados no giro (dois price_id do mesmo dia/profissional → só o primeiro leva a duração; o patch deixa de ser uniforme). "Primeira" = etapa de menor `ordem` (determinístico); a sintética entra no MESMO rastreio.
6. `planos` do select do syncPlanejamento ganha `paciente_clinicorp_id` (hoje não vem).
7. **Skew por-etapa documentado:** uma etapa carrega a sessão e as irmãs ficam 0 — o TOTAL do plano/dia bate com o chair time real (o que a fiscalização ③ consome); visão por-etapa individual não é métrica.

**Backfill (script node, NÃO SQL — reusa a MESMA função de cálculo da baixa):** alvo = `plano_etapas` com `status='concluida_retroativa'` + `asb_responsavel IS NULL` + `tempo_real_min IS NULL` — **inclui as retroativas da CRIAÇÃO do plano** (mesma assinatura; assumido: também são execução real, tratadas igual). Datas fora da janela da agenda (~30d) → 0, documentado. Rodar 1× no deploy.

**Testes (adicionais):** dia com 2 procedimentos do MESMO profissional → soma dos tempos = 1× a duração do agendamento; dia com 2 profissionais → cada agendamento contado 1×; ASB não vê mais no /sessao/ paciente cujo dia já foi baixado; fiscalização ③ passa a mostrar horas reais das baixas.
