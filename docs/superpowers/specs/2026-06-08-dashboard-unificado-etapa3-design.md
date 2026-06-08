# Spec — Dashboard Unificado CRM Antigo + CRM Novo (Etapa 3)

**Data:** 2026-06-08
**Status:** Em revisão pelo Luiz
**Escopo:** Etapa 3 de 3. Pré-requisitos: Etapa 1 (dashboard do CRM Antigo) validada; Etapa 2 (monitor) confirmou que o CRM Novo gera os sinais no padrão certo.

---

## 1. Objetivo

A partir de **julho/2026**, ter **uma única tela** comercial que mostra o funil contínuo de **fim-2023 até hoje**, juntando o histórico (**CRM Antigo**) com o que o nosso sistema gera (**CRM Novo**) — sem o usuário precisar saber de qual era veio cada número.

---

## 2. Princípio (a resposta à pergunta "um banco entende os dois?")

**Uma dashboard, uma camada de métricas canônica — NÃO um banco cru unificado.** Os dois conjuntos de eventos continuam com vocabulários diferentes em `lead_eventos`; um **adaptador** traduz ambos para as **5 etapas canônicas** (Leads → Agendou → Compareceu → Orçou → Fechou). A tela (a mesma da Etapa 1) lê o canônico e não muda.

Como o **CRM Novo foi alinhado para emitir no mesmo padrão** do CRM Antigo (decisão do Luiz), a tradução é direta — não há reconciliação de formatos divergentes, só dois vocabulários de evento mapeados para o mesmo funil.

---

## 3. Fonte de dados

Tudo em `leads` + `lead_eventos` (nunca Clinicorp). Duas eras, separadas pelo **tipo de evento**:

| Era | Eventos | Venda |
|---|---|---|
| **CRM Antigo** (até junho/2026) | `historico_lead_criado/agendado/compareceu/orcamento/fechou` | `historico_fechou.metadata.valor` |
| **CRM Novo** (julho+) | `lead_criado`, `status_mudou` (para Agendado/Compareceu/Fechou) | `leads.valor` |

---

## 4. Normalização canônica + regra de era (evita DUPLA CONTAGEM)

### 4.1 Mapa de evento → etapa
```
historico_lead_criado | lead_criado                      → leads
historico_agendado    | status_mudou(para='Agendado')    → agendou
historico_compareceu  | status_mudou(para='Compareceu')  → compareceu
historico_orcamento   | (CRM Novo: sinal de orçamento — ver §7) → orcou
historico_fechou      | status_mudou(para='Fechou')      → fechou
```

### 4.2 ✅ DECISÃO: UNIÃO de etapas (captura o dado mais real) + 4 regras de reconciliação
Um lead pode ter eventos das duas eras (ex.: importado em junho **e** trabalhado no CRM Novo em julho). Em vez de descartar uma era (que perderia o progresso novo de leads históricos), contamos a **união das etapas** das duas eras, deduplicada — com 4 regras explícitas que evitam os efeitos colaterais:

1. **Etapas = união, deduplicada por `Set` de (lead, etapa).** Não há dupla contagem de etapa: se o lead alcançou "compareceu" nas duas eras, conta **uma vez**.
2. **Data da etapa = primeira ocorrência.** Quando a etapa aparece nas duas eras, vale a **data mais antiga** (a 1ª vez que o lead chegou ali). Vale pra coorte/período e tempos entre fases.
3. **Funil = "chegou na etapa" (não "está na etapa hoje").** Reabertura/regressão de status no CRM Novo não desconta um fechamento já alcançado.
4. **Venda = UMA fonte por lead (nunca soma as duas eras).** Se o lead tem `historico_fechou` → usa o valor da planilha; senão → `leads.valor`. Evita inflar receita quando a mesma venda foi registrada nas duas eras.

> ⚠️ **Magnitude:** quase todo o risco só existe para leads que aparecem **nas duas eras**. O passo 1 (§8) mede quantos são — se for um punhado (provável), a união é segura.

---

## 5. Arquitetura

Reusa quase tudo da Etapa 1; o novo é o adaptador e uma query unificada.

```
lib/funil/
  normalizar.js   ★ NOVO: eventoParaEtapa(evento) + eraDoLead(eventosDoLead) + vendaDoLead(...)
                    (puro, testável — cobre os dois vocabulários e a regra de era)
  eventos.js        buscarCoorte evolui: busca historico_* E lead_criado/status_mudou; aplica regra de era
  montarCoorte      passa a usar normalizar.js (mesma saída canônica de hoje)
  dashboard.js      sem mudança (já consome o canônico)
server.js           /api/comercial/dashboard ganha eventos das duas eras (mesma rota)
public/comercial/
  dashboard.html    + marca visual "início do CRM Novo" (linha/legenda) na série temporal
```

A tela e o payload canônico **não mudam de forma** — só passam a incluir as duas eras. Isso é o que torna a Etapa 1 reaproveitável.

---

## 6. Requisito obrigatório: CRM Novo tem TODAS as etapas do Antigo
**Decisão do Luiz:** o CRM Novo **precisa gerar as mesmas 5 etapas** do CRM Antigo. Hoje falta o **"Orçou"** (não há status/evento de orçamento na era nova). Sem ele, a etapa "Orçou" do funil unificado fica populada só pelos leads históricos.
→ **Tarefa pré-Etapa 3:** criar no CRM Novo o sinal de orçamento — um status "Orçado" no funil **ou** um evento `orcamento_criado` em `lead_eventos` (a definir na implementação). O monitor da Etapa 2 (cobertura) confirma quando os 5 sinais aparecem ✅.

## 6.1 Funcionalidades adicionais (pedidos do Luiz)
- **Edição de valores (Venda):** a tela deve permitir **corrigir manualmente o valor de uma venda** (override), pros casos de divergência entre planilha e `leads.valor` ou erro de digitação. Sugestão: gravar o valor corrigido em `leads.valor` (com log do evento) e a Venda passa a usar esse valor como fonte da verdade.
- **Seletor de data nas análises:** no dashboard, um controle pra **escolher qual data seguir** (ex.: data de criação do lead × data de fechamento) — muda a base do período e dos gráficos sem mudar o cálculo. Default = primeira ocorrência (§4.2 regra 2).

---

## 7. Riscos / decisões em aberto

- ✅ **Regra de era — DECIDIDO (Luiz): UNIÃO de etapas + 4 regras** (ver §4.2). O `normalizar.js` precisa ser refatorado de "1 era por lead" para a união (emite etapas das duas eras, dedup por primeira ocorrência; Venda de uma fonte só). Testes do `normalizar` mudam conforme.
- **Integração `montarCoorte`:** hoje consome eventos crus `{tipo}`; na Etapa 3 passa a consumir os canônicos `{etapa}` do `normalizar`. A origem do lead deve vir do evento canônico de criação (`etapa='leads'`), não dos demais.
- **Lacuna "Orçou" no CRM Novo** (§6) — bloqueia a etapa de orçamento na era nova. Resolver antes de julho.
- **Transição de junho** — junho pode ter dado das duas eras; a regra de era por lead (§4.2) cobre, mas vale validar no monitor.
- **Venda mista** — CRM Antigo usa valor da planilha (contrato cheio); CRM Novo usa `leads.valor`. Confirmar que o CRM Novo preenche `leads.valor` com o mesmo conceito (valor de contrato), senão a série de Venda fica inconsistente na virada.
- **Performance** — período "tudo" agora soma as duas eras; manter a paginação + considerar pré-cálculo (já anotado na Etapa 1).

---

## 8. Primeiro passo da implementação
Antes de codar: medir no banco **quantos leads têm AMBOS** `historico_lead_criado` **e** `lead_criado` (dimensiona o risco de dupla contagem que a regra de era resolve) e confirmar os valores de `status_mudou.metadata.para` usados. Leitura só do nosso banco.

---

## 9. Roadmap
1. Etapa 1 — Dashboard do CRM Antigo ✅ (código pronto; falta validação ao vivo).
2. Etapa 2 — Monitor do CRM Novo ✅ (código pronto; falta validação ao vivo + resolver lacuna "Orçou").
3. **Etapa 3 — este dashboard unificado (julho).**
