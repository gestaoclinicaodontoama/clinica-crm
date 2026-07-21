# Baixa Automática de Executados (Clinicorp → plano) — Design

**Data:** 2026-07-21. Pedido do Luiz: "a ideia não é dar trabalho, é poupar" — o que o Clinicorp já mostra como Executado deve dar baixa sozinho no nosso plano; o `/sessao/` continua lembrando as ASBs do que não foi registrado (chair time).

## Comportamento hoje
`Executed=X` do orçamento só é aproveitado NA CRIAÇÃO do plano (`clinicorp-sync.js` ~1177: etapas de padrão nascem `concluida_retroativa` quando `executados >= quantidade`). Depois disso, execução no Clinicorp não reflete no plano — a equipe marca manual.

## Regra nova (fase do re-sync noturno + sync manual, `syncPlanejamento`)
Para cada plano ativo com orçamento casado — **PULANDO todo plano que recebeu QUALQUER ação do `aplicarResync` neste giro** (`acoes.length > 0`: travar/cancelar/regredir/ressuscitar/add/remove — o objeto `plano` em memória fica obsoleto após `executarAcoesResync`; baixar com status velho ressuscitaria plano recém-cancelado ou desfaria regressão; a baixa desses fica para a PRÓXIMA noite, com a estrutura assentada) — para cada **item raiz `tipo='clinicorp'`** casado por `price_id`:
- **Só item TOTALMENTE executado** (`novo.executados >= item.quantidade`) e ainda não concluído no nosso lado. Parcial fica pro manual/ASB (sub-lotes não são adivinháveis).
- **Fonte da data/executor: `producao_procedimentos`** (⚠️ o `orcamentos.procedure_list` NÃO carrega `ExecutedDate` — só 6 campos; `agruparItens` fica INTOCADO, usa-se só o `executados` que ele já tem). Lookup por `clinicorp_estimate_id` + `price_id`: `ultima_execucao = max(executed_date)`, `executor_nome = dentist_name` da linha mais recente. Borda: linha executada com `Amount<=0` ou fora da janela de 90d da produção não está lá → fallback `concluida_em = data do sync` (documentado, aceitável).
- **Baixa:** etapas pendentes do item **e dos sub-lotes filhos** → `status='concluida_retroativa'`, `concluida_em = ultima_execucao` (formato `YYYY-MM-DDT12:00:00-03:00`; fallback data do sync), `profissional_executor` = o da etapa (se tiver) → `executor_nome` da produção → executor do item; `asb_responsavel = NULL` (baixa automática), `tempo_real_min = NULL` (não mede cadeira; o filtro `IS NOT NULL` de `jaRegistrouHoje`/`ja_registrado_hoje` garante que **a ASB continua sendo cobrada no /sessao/** — exatamente a intenção).
- Item **com ZERO etapas em item+filhos** (guard IDÊNTICO ao do "Executar procedimento" manual — evita colidir com sintética manual) → cria **1 sintética** (`ordem=999`, `descricao=procedure_name`, `concluida_retroativa`, mesmos campos). Idempotente nos dois sentidos: item já todo concluído (manual ou automático) → nada.
- Após qualquer baixa no plano: recalcular com `statusAposRegistro` da lib (**adicionar ao require do sync** — hoje só importa `aplicarResync` etc.). SEM guard — aqui HÁ execução real. ⚠️ **Escopo do recálculo = o PLANO INTEIRO, com dados FRESCOS**: re-query de TODAS as etapas de TODOS os itens raiz ativos (INCLUSIVE `tipo='externo'`) APÓS as escritas da baixa, replicando o cálculo de `temItemSemEtapa` do `avancarPlanoAposRegistro` do server (duplicação aceita — o helper não é exportável p/ o sync; o `itensPlano` em memória fica obsoleto pós-baixa e NÃO pode ser reusado). Sem isso, plano com fase externa pendente ou item não-executado concluiria indevidamente. Update com `atualizado_em`.
- **Fases externas (`tipo='externo'`) NUNCA são tocadas** (não têm par no orçamento — match por price_id já as ignora naturalmente; deixar comentário explícito).
- Contador no log do sync: `baixas automáticas: N etapas em M planos`.

## Dados novos no `agruparItens` (lib/planejamento/triagem.js — pura, testada)
Acrescentar ao grupo: `ultima_execucao` (max `ExecutedDate` (`slice(0,10)`) das linhas `Executed==='X'`; null se nenhuma tem data) e `executor_person_id` (último `Dentist_PersonId` não-null das executadas). Campos novos são aditivos — `aplicarResync`/criação não mudam.

## O que NÃO muda
- Marcação manual (✓ do modal) e registro da ASB continuam valendo e têm precedência natural (etapa já concluída = intocada).
- `jaRegistrouHoje`/`ja_registrado_hoje` (tempo IS NOT NULL) → ASB segue vendo pendente no /sessao/ até registrar (chair time preservado — ressalva R1 vira feature: auditoria satisfeita, /sessao/ cobra).
- Resync de estrutura (adicionar/remover/travar) intocado.
- **Efeitos colaterais documentados (intencionais):** (a) pós-baixa, um veredito CRC `duplicata`/`nao_venda` nesse plano passa a TRAVAR (veredito tardio) em vez de cancelar limpo — correto: se o Clinicorp mostra executado, não é venda-fantasma, decisão vira humana; (b) `etapas_executadas=true` amplia as travas legítimas do re-sync futuro (mudança/remoção do item passa a travar p/ gestora) — proteção desejada de trabalho executado.

## Segurança/robustez
- Nenhuma rota nova, nenhuma tabela; escrita só via service_role no sync. Sem `.catch()` em builder.
- Ordem dentro do `syncPlanejamento`: a baixa roda DEPOIS do `aplicarResync` do plano (estrutura primeiro; se o resync travar o plano, a baixa daquele plano é pulada nesta noite).

## Testes
- **Unit:** nenhum na lib (`agruparItens` intocado). A parte pura nova é mínima; cobertura fica no manual + idempotência.
- **Manual:** paciente com procedimento executado no Clinicorp (ex.: Vandercil 21493 — Documentação 30/06 e Raspagem 30/06) → rodar sync manual → itens ✅ com data 30/06 e executor na trilha/tracker; plano avança; /sessao/dia AINDA mostra o paciente como não-registrado (cobrança da ASB viva); rodar de novo → idempotente; fase externa intocada.
