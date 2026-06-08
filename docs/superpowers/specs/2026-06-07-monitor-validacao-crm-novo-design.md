# Spec — Monitor de Validação Diária do CRM Novo (Etapa 2)

**Data:** 2026-06-07
**Status:** Em revisão pelo Luiz
**Escopo:** Etapa 2 de 3 do roadmap do Dashboard Comercial (ver Etapa 1: `2026-06-06-dashboard-crm-antigo-design.md`)

---

## 1. Objetivo

Durante **junho/2026**, dar ao Luiz uma tela onde ele confere **todo dia** se o **CRM Novo** está gerando os dados comerciais **no mesmo padrão do CRM Antigo**. É uma ferramenta de *validação de dado*, não um dashboard de gestão. Se alguma etapa do funil não estiver sendo registrada corretamente (ex.: troca de status não gera evento, fechamento sem valor), o monitor mostra na hora — e a gente corrige antes de virar a chave em julho.

**Critério de sucesso:** ao fim de junho, o CRM Novo gera, com qualidade, os 5 sinais que o CRM Antigo tem (lead criado com origem; transições agendou/compareceu/orçou/fechou com data; fechamento com valor+entrada). Aí a Etapa 3 (dashboard unificado) pode confiar nos dados novos.

---

## 2. Fonte de dados (CRM Novo)

Só o nosso banco (`leads` + `lead_eventos`), eventos da era nova — **NÃO** `historico_*` (esses são CRM Antigo) e **NÃO** Clinicorp.

| Sinal | Evento (`lead_eventos.tipo`) | Conteúdo |
|---|---|---|
| Lead novo | `lead_criado` | `metadata.origem`, `metadata.campanha`, `metadata.ctwa_clid` |
| Transição de etapa | `status_mudou` | `metadata.de`, `metadata.para`, `usuario_id`, `criado_em` |
| Fechamento | `status_mudou` com `para='Fechou'` | + `leads.valor` (preenchido na ficha) |

**Mapa status → etapa do funil** (a confirmar no passo 1 da implementação, lendo os valores reais de `metadata.para`):
`Agendado` → agendou · `Compareceu` → compareceu · `Fechou` → fechou.

⚠️ **Lacuna provável a investigar:** o CRM Novo pode **não ter um status de "Orçou"** (a `FUNIL` no `server.js` não tem etapa de orçamento explícita). O monitor deve **expor essa lacuna** — é justamente o tipo de coisa que ele existe pra revelar. Idem: o **valor do fechamento** depende de preenchimento manual em `leads.valor`; o monitor mostra fechamentos **sem valor**.

---

## 3. O que o monitor mostra

Filtro de período (default: **junho/2026**, com navegação por dia). Para o intervalo:

### 3.1 Atividade por dia (tabela)
Uma linha por dia com: **leads novos**, **agendou**, **compareceu**, **orçou** (se existir), **fechou**, **Venda do dia** (soma de `leads.valor` dos que fecharam no dia).

### 3.2 Saúde do dado (cards de alerta)
- **Leads sem origem** (origem vazia/“Sem origem”) — % do dia.
- **Fechamentos sem valor** (status virou `Fechou` mas `leads.valor` nulo/0).
- **Transições "órfãs"** — sinais de que uma etapa não está sendo registrada (ex.: leads que aparecem em `Compareceu` sem ter passado por `Agendado`).
- **Cobertura de etapas:** quais dos 5 sinais do CRM Antigo já aparecem no CRM Novo (checklist verde/vermelho).

### 3.3 Comparação de padrão (CRM Novo vs CRM Antigo)
Um quadro lado a lado: para cada um dos 5 sinais, "✅ presente / ⚠️ ausente ou incompleto" no CRM Novo. É o termômetro de "estamos prontos pra julho?".

---

## 4. Arquitetura

Reusa o padrão e a infra da Etapa 1.

```
lib/monitor/
  queries.js     ★ lê lead_eventos da era nova (lead_criado, status_mudou) paginado + timeout
                   (reusa withTimeout de lib/funil/eventos.js)
  diario.js      ★ puro: agrega atividade por dia + saúde do dado + cobertura de etapas (testável)
server.js
  GET /api/comercial/monitor?from=&to=   ★ rota fina (auth requireDashboardAvaliacao)
public/comercial/
  monitor.html + monitor.js              ★ tabela por dia + cards de saúde (sem Chart.js obrigatório)
```

Mesmas regras: `server.js` casca fina; lógica pura testável em `lib/monitor/diario.js` com `node:test`; tokens/origem nunca normalizados via UTM; paginação `.range`.

---

## 5. Fora de escopo
- Não corrige o CRM Novo — só **revela** o que falta (as correções viram tarefas conforme aparecerem em junho).
- Não é a tela de gestão (essa é a Etapa 1 / Etapa 3).
- Descartável: ao virar julho com dado confiável, o monitor pode ser aposentado ou virar uma aba de "saúde do dado".

---

## 6. Primeiro passo da implementação
Antes de codar: **inventariar os valores reais de `metadata.para` nos eventos `status_mudou`** (quais status existem) e checar se há algum sinal de "orçamento" — pra cravar o mapa status→etapa e confirmar a lacuna do orçamento. Leitura só do nosso banco.

---

## 7. Roadmap (lembrete)
1. Etapa 1 — Dashboard do CRM Antigo (em finalização; falta validação ao vivo).
2. **Etapa 2 — este monitor (junho).**
3. Etapa 3 — Dashboard unificado CRM Antigo + CRM Novo (julho).
