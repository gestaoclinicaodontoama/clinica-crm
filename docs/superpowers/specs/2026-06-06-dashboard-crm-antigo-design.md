# Spec — Dashboard Comercial do CRM Antigo (Etapa 1)

**Data:** 2026-06-06
**Status:** Em revisão pelo Luiz
**Escopo:** Etapa 1 de 3 (ver "Roadmap" no fim)

---

## 1. Objetivo

Entregar um **dashboard comercial "bonitinho"** sobre os dados históricos do **CRM Antigo** (fim-2023 → junho/2026), pra clínica entender a parte comercial com clareza: funil de conversão, gargalos, evolução no tempo e comparação entre períodos. Hoje a visualização é confusa, sem filtro de período global e sem gráficos de tendência.

Este é um pedido antigo do Luiz, com insatisfação demonstrada com o estado atual.

---

## 2. Vocabulário (nomes oficiais do projeto)

| Nome | O que é | Onde vive |
|---|---|---|
| **CRM Antigo** | Funil comercial histórico (lead → agendou → compareceu → orçou → fechou), fim-2023 → junho/2026. Importado das 5 pastas `P:\LUIZ\POWER BI\Dashboard\Dashboard\CSV` (export direto do CRM atual da clínica) via `scripts/import-historico.js`. **Fonte deste dashboard.** | `leads` + `lead_eventos` (Supabase) |
| **Base em Tratamento** | Acompanhamento de pacientes em tratamento (ex-planilha Monica). Outro objetivo, fora deste escopo. | `pacientes_sucesso` |
| **CRM Novo** | Dados que nosso sistema gera de jun/jul em diante, alinhados ao mesmo padrão do CRM Antigo. Entra nas Etapas 2 e 3. | `leads` + `lead_eventos` (eventos `status_mudou`/`lead_criado`) |

**Regra absoluta:** este dashboard NÃO usa dados de leads do Clinicorp (tabelas `avaliacoes`/`orcamentos`) — são inconsistentes (`lead_id` 0%). Fonte única = CRM Antigo.

**Fronteira CRM Antigo × CRM Novo (mesmas tabelas):** o que separa as duas eras é o **tipo de evento**. Etapa 1 lê **somente eventos `historico_*`** (CRM Antigo). Eventos `lead_criado`/`status_mudou` (CRM Novo, fase de testes em maio/junho) ficam de fora até a Etapa 3 — senão atividade de teste vaza pro dashboard histórico.

---

## 3. Fonte de dados (CRM Antigo)

O funil sai dos eventos `historico_*` em `lead_eventos` (datas reais) + atributos do `leads`:

| Etapa do funil | Evento (`lead_eventos.tipo`) | Data | Atribuição |
|---|---|---|---|
| Lead criado | `historico_lead_criado` | `criado_em` | `leads.origem` (100%) |
| Agendou | `historico_agendado` | `criado_em` | idem |
| Compareceu | `historico_compareceu` | `criado_em` | idem |
| Orçou | `historico_orcamento` | `criado_em` | idem |
| Fechou | `historico_fechou` | `criado_em` | idem; `metadata.valor` + `metadata.entrada` |

**Vantagem vs Clinicorp:** `lead_eventos.lead_id` está sempre preenchido e `leads.origem` é 100% → **atribuição por origem É possível** neste dashboard.

### Caveats de dado (assumir e rotular na tela)
- **`historico_compareceu` usa a data do agendamento** como `criado_em` (`import-historico.js:228`) → o timing "compareceu" reflete a data do agendamento, não a do comparecimento real. Rotular como aproximação.
- **Receita = `historico_fechou.metadata.valor`** = **Venda (valor de contrato)**, KPI de destaque. A **entrada** (`metadata.entrada`) é caixa, vai num card secundário. NÃO é o mesmo que valor que entrou.
- **Cobertura desigual das etapas:** um lead pode ter `historico_fechou` sem `historico_orcamento` (faltou a data na planilha). Se uma etapa posterior tiver mais leads que a anterior, a conversão passaria de 100% — nesse caso **mostrar um flag de qualidade de dado** ("N fechamentos sem orçamento registrado"), nunca um % furado. Ligado ao inventário do passo 1.
- **`origem` precisa de normalização** — reusar o mapa que já existe no `server.js` (whatsapp/indicação/referral → canônico), senão variações viram origens duplicadas no filtro.
- **Teto de 1.000 linhas** do PostgREST é real → paginação por `.range()` obrigatória em todas as leituras de período largo.
- **`data_lead`/`criado_em` da tabela `leads` não são confiáveis** como data histórica (foram backfillados recentemente). A linha do tempo vem SEMPRE de `lead_eventos.criado_em` dos eventos `historico_*`.

---

## 4. O que o dashboard mostra (escopo da Etapa 1)

### 4.1 Filtro de período global (prioridade nº 1)
Um seletor único (hoje · 7d · 30d · mês · personalizado) que filtra **todo** o dashboard. Padrão = últimos 30 dias (guardrail de performance; "tudo/ano" mostra aviso de carga).

### 4.2 Funil de conversão + gargalo (foco do dashboard geral)
5 etapas encadeadas, contadas em **leads distintos** (`lead_id`):
`Leads → Agendados → Compareceram → Orçaram → Fecharam`
- Cada etapa: `n`, `% do topo`, `conv. da etapa anterior`.
- **Gargalo** destacado automaticamente = menor `conv. da etapa anterior`.
- **Definição = COORTE por data de criação do lead:** "Leads do período" = leads cujo `historico_lead_criado` cai no período; as etapas seguintes contam esses mesmos leads, independentemente de quando a etapa ocorreu. Como o CRM Antigo é histórico maduro, não há viés de lead recente sem tempo de converter.

### 4.3 KPIs do período
- **KPI de destaque: Venda (valor de contrato)** — soma de `historico_fechou.metadata.valor` no período.
- Secundários: **entrada** (caixa, `metadata.entrada`) num card à parte, leads, agendamentos, comparecimentos, orçamentos, fechamentos, ticket médio (Venda ÷ fechamentos), tempo médio até fechar.

### 4.4 Gráfico de tendência
Linha/barra de atividade por **dia** (≤60d) ou **semana** (>60d): leads, comparecimentos, fechamentos. Rotular como "atividade por dia" (eventos do dia, não coorte).

### 4.5 Comparação com período anterior
% de variação por KPI vs período imediatamente anterior de mesma duração.

### 4.6 Quebra por dia da semana
Leads e fechamentos por dia da semana (identificar melhores dias).

> Disponível mas **fora do foco inicial** (ship depois, mesma fundação): recortes por **origem/campanha**, **avaliador**, **CRC**. A arquitetura já deixa pronto.

### 4.7 Gráficos
**Chart.js** (CDN, JS puro). NÃO usar React/Recharts nesta etapa.

---

## 5. Modelo canônico de métricas (reusado na Etapa 3)

Toda métrica declara as 3 dimensões que a definem (antídoto pro "não bate"):
**(unidade: leads | eventos) × (data-base: qual evento `historico_*`) × (filtro: origem?)**

Exposto no payload e em tooltips na tela. Dois números que diferem sempre têm explicação ("um é por data de criação, outro por data de fechamento").

O dashboard lê esse modelo canônico, **não** as tabelas cruas direto — assim a Etapa 3 só adiciona o adaptador do CRM Novo sem mexer na tela.

---

## 6. Arquitetura

Estende o módulo existente `lib/funil/` (já tem funções puras testadas) — NÃO cria módulo paralelo.

```
lib/funil/
  agregar.js, fechamentos.js, orcamento.js, telefone.js   # JÁ EXISTEM (mantém)
  periodo.js     ★ presets de período → {from, to, anterior:{from,to}}; trata fuso UTC-3
  eventos.js     ★ lê lead_eventos historico_* paginado (.range), monta funil por lead distinto
  series.js      ★ série temporal (dia/semana) + quebra por dia da semana
  comparacao.js  ★ período atual vs anterior (% por KPI)
  conversao.js   ★ taxa entre etapas + gargalo
  dashboard.js   ★ orquestra tudo num payload canônico
  (+ um *.test.js por arquivo novo)

server.js
  GET /api/comercial/dashboard?from=&to=&origem=   ★ rota nova (casca fina: auth + valida + chama dashboard.js)
  reusa gate requireDashboardAvaliacao; rotas antigas seguem vivas na transição

public/comercial/index.html  # evolui pra visão nova + filtro de período global + Chart.js (CDN)
```

**Princípio:** `server.js` só como casca; lógica testável em `lib/funil/`. Queries saem do monólito pra `eventos.js`.

---

## 7. Fora de escopo (Etapas seguintes)

- **Etapa 2 (junho):** "Monitor de Validação Diária" do CRM Novo — confere todo dia se o dado novo nasce no padrão do CRM Antigo.
- **Etapa 3 (julho):** Dashboard unificado = esta mesma tela + adaptador do CRM Novo, mostrando CRM Antigo + CRM Novo contínuos.
- Recortes por avaliador e CRC (a fundação já suporta; UI depois).
- Ponte Clinicorp→valor de orçamento pra CRC validar (Etapa 3).

---

## 8. Roadmap (3 etapas)

1. **Etapa 1 (esta):** Dashboard bonitinho do CRM Antigo (até junho/2026).
2. **Etapa 2:** Monitor diário do CRM Novo (junho).
3. **Etapa 3:** Dashboard unificado (julho).

---

## 9. Primeiro passo da implementação

Antes de codar a tela: **inventariar as contagens reais** dos eventos `historico_agendado/compareceu/orcamento/fechou` em `lead_eventos` (leitura só do NOSSO banco, nunca Clinicorp) — confirmar volume por etapa e o range de datas, pra calibrar o funil e os eixos dos gráficos. **Em especial:** medir quantos `historico_fechou` NÃO têm `historico_orcamento` no mesmo lead (dimensiona o flag de cobertura desigual).

### Otimização (CRM Antigo é congelado)
Como o CRM Antigo só muda quando o Luiz enviar o export de junho, os agregados podem ser **pré-calculados/cacheados** (ex.: tabela de resumo ou cache em memória com invalidação manual) em vez de paginar ~22k eventos a cada carregamento de período largo ("tudo").

---

## 10. Testes

- Funções puras (`periodo`, `conversao`, `series`, `comparacao`) com Vitest, seguindo o padrão de `lib/funil/*.test.js`.
- Casos de borda: período sem dados, etapa com 0 leads (sem divisão por zero), conversão > 100% (não deve ocorrer com contagem por lead distinto), paginação > 1.000 linhas.
