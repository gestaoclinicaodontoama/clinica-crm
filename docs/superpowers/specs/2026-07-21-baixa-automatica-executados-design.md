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

**Captura do tempo (por dia de execução do plano):**
1. `executed_date` da produção define o dia. Buscar `agenda_appointments` do `plano.paciente_clinicorp_id` naquele dia (`deleted=false`; preferir `compareceu=true`, aceitar sem check-in como fallback — a execução prova presença).
2. **Atribuição POR PROFISSIONAL**: casar `dentist_person_id` da produção com o do agendamento → a `duration_minutes` DAQUELE agendamento vai para a PRIMEIRA etapa baixada daquele (dia, profissional); demais etapas do mesmo (dia, profissional) = **0** (anti-duplicação, mesma convenção do /sessao/). Profissionais DIFERENTES no mesmo dia = cada um consome o próprio agendamento.
3. Sem match por profissional → agendamento do dia ainda não consumido (maior duração primeiro); sem agendamento nenhum → **0** (não NULL — a ASB não deve ser cobrada por algo já baixado; sem agendamento não há chair time a perder).
4. **Consumo cruzado com registro manual**: antes de atribuir, verificar se já existe registro com tempo NOT NULL naquele (plano, dia) — etapa (via `concluida_em`) ou `sessao_avulsa` — → dia já consumido → 0 (precedência do que veio primeiro, igual hoje).
5. `planos` do select do syncPlanejamento precisa incluir `paciente_clinicorp_id` (hoje não vem).

**Backfill imediato:** etapas `concluida_retroativa` com `asb_responsavel IS NULL` e `tempo_real_min IS NULL` (criadas pela baixa antes deste ajuste) → recalcular o tempo pela mesma regra, via script/SQL único no deploy.

**Testes (adicionais):** dia com 2 procedimentos do MESMO profissional → soma dos tempos = 1× a duração do agendamento; dia com 2 profissionais → cada agendamento contado 1×; ASB não vê mais no /sessao/ paciente cujo dia já foi baixado; fiscalização ③ passa a mostrar horas reais das baixas.
