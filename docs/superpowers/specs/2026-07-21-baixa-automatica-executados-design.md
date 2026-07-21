# Baixa Automática de Executados (Clinicorp → plano) — Design

**Data:** 2026-07-21. Pedido do Luiz: "a ideia não é dar trabalho, é poupar" — o que o Clinicorp já mostra como Executado deve dar baixa sozinho no nosso plano; o `/sessao/` continua lembrando as ASBs do que não foi registrado (chair time).

## Comportamento hoje
`Executed=X` do orçamento só é aproveitado NA CRIAÇÃO do plano (`clinicorp-sync.js` ~1177: etapas de padrão nascem `concluida_retroativa` quando `executados >= quantidade`). Depois disso, execução no Clinicorp não reflete no plano — a equipe marca manual.

## Regra nova (fase do re-sync noturno + sync manual, `syncPlanejamento`)
Para cada plano ativo (status NÃO lateral, sem `trava_resync`) com orçamento casado, para cada **item raiz `tipo='clinicorp'`** casado por `price_id`:
- **Só item TOTALMENTE executado** (`novo.executados >= item.quantidade`) e ainda não concluído no nosso lado. Parcial fica pro manual/ASB (sub-lotes não são adivinháveis).
- **Baixa:** etapas pendentes do item **e dos sub-lotes filhos** → `status='concluida_retroativa'`, `concluida_em = ultima_execucao` do grupo (max `ExecutedDate`, formato `YYYY-MM-DDT12:00:00-03:00`; sem data → data do sync), `profissional_executor` = etapa (se tiver) → executor resolvido do `Dentist_PersonId` (via `dentista_config`/`dnames`) → executor do item; `asb_responsavel = NULL` (ninguém registrou — foi baixa automática), `tempo_real_min = NULL` (não mede cadeira; e o filtro `IS NOT NULL` de `jaRegistrouHoje`/`ja_registrado_hoje` garante que **a ASB continua sendo cobrada no /sessao/** — exatamente a intenção).
- Item **sem etapa nenhuma** (própria/filhos) → cria **1 sintética** (`ordem=999`, `descricao=procedure_name`, `concluida_retroativa`, mesmos campos). Idempotente: item já todo concluído → nada.
- Após qualquer baixa no plano: recalcular status com `statusAposRegistro` da lib (SEM guard — aqui HÁ execução real: `planejado→em_andamento→concluido` é legítimo; `temItemSemEtapa` continua segurando conclusão se houver fase externa/item não executado). Update com `atualizado_em`.
- **Fases externas (`tipo='externo'`) NUNCA são tocadas** (não têm par no orçamento — match por price_id já as ignora naturalmente; deixar comentário explícito).
- Contador no log do sync: `baixas automáticas: N etapas em M planos`.

## Dados novos no `agruparItens` (lib/planejamento/triagem.js — pura, testada)
Acrescentar ao grupo: `ultima_execucao` (max `ExecutedDate` (`slice(0,10)`) das linhas `Executed==='X'`; null se nenhuma tem data) e `executor_person_id` (último `Dentist_PersonId` não-null das executadas). Campos novos são aditivos — `aplicarResync`/criação não mudam.

## O que NÃO muda
- Marcação manual (✓ do modal) e registro da ASB continuam valendo e têm precedência natural (etapa já concluída = intocada).
- `jaRegistrouHoje`/`ja_registrado_hoje` (tempo IS NOT NULL) → ASB segue vendo pendente no /sessao/ até registrar (chair time preservado — ressalva R1 vira feature: auditoria satisfeita, /sessao/ cobra).
- Resync de estrutura (adicionar/remover/travar) intocado.

## Segurança/robustez
- Nenhuma rota nova, nenhuma tabela; escrita só via service_role no sync. Sem `.catch()` em builder.
- Ordem dentro do `syncPlanejamento`: a baixa roda DEPOIS do `aplicarResync` do plano (estrutura primeiro; se o resync travar o plano, a baixa daquele plano é pulada nesta noite).

## Testes
- **Unit (triagem.test.js):** `agruparItens` com linhas Executed=X e ExecutedDate → `ultima_execucao`/`executor_person_id` certos; sem executados → null; campos antigos inalterados.
- **Manual:** paciente com procedimento executado no Clinicorp (ex.: Vandercil 21493 — Documentação 30/06 e Raspagem 30/06) → rodar sync manual → itens ✅ com data 30/06 e executor na trilha/tracker; plano avança; /sessao/dia AINDA mostra o paciente como não-registrado (cobrança da ASB viva); rodar de novo → idempotente; fase externa intocada.
