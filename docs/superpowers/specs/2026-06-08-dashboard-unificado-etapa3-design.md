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

### 4.2 ⚠️ Regra de era POR LEAD (o ponto mais importante)
Um lead pode ter eventos das duas eras (ex.: importado em junho **e** mexido no CRM Novo em teste). Para **não contar duas vezes**:

> **Cada lead pertence a UMA era.** Se o lead tem `historico_lead_criado` → é **CRM Antigo** (usa só os eventos `historico_*` dele). Senão → é **CRM Novo** (usa `lead_criado`/`status_mudou`).

Assim o funil de cada lead vem de **um único vocabulário**, e os totais somam sem sobreposição. A data de criação (pra coorte/período) é a do evento de criação da era escolhida.

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

## 6. Pré-requisito (Etapa 2 valida isto antes)
O monitor da Etapa 2 precisa mostrar **cobertura ✅ nos 5 sinais** do CRM Novo — em especial **resolver a lacuna do "Orçou"** (hoje o CRM Novo não tem status/evento de orçamento). Sem o sinal de orçamento, a etapa "Orçou" do funil unificado fica subcontada na parte CRM Novo. Decisão pendente: criar um status "Orçado" ou um evento `orcamento_criado` no CRM Novo.

---

## 7. Riscos / decisões em aberto

- **Regra de era: "1 era por lead" vs "união de etapas" (DECIDIR na fiação).** O `normalizar.js` hoje usa **1 vocabulário por lead** (tem `historico_*` → só era antiga). Evita dupla contagem, **mas** um lead histórico que avança no CRM Novo em julho não tem o avanço contado. **Alternativa:** contar a **união das etapas** (o `montarCoorte` deduplica por `Set` de lead/etapa → não dobra a contagem de etapa) e aplicar a regra de era **só para a Venda** (que é somada). Recomendação: união de etapas + era só na venda — capta progresso cross-era sem dobrar. Os testes do `normalizar` mudam conforme a escolha.
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
