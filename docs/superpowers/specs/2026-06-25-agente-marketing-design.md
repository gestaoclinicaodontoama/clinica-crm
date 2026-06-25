# Agente de Marketing — Design

**Data:** 2026-06-25
**Status:** Aprovado (brainstorm), pendente revisão da spec escrita
**Bloco:** 3 (Agentes de IA) — **1º agente** da camada própria
**Relaciona:** `2026-06-23-crm-reestruturacao-leads-agentes-design.md`, memórias `project_agentes`, `reference_clinicorp_financial_api`, `feedback_telefone_zero_familia`, `project_trajeto_atribuicao`

---

## 1. Objetivo e natureza

Substituir o "achismo" de verba do Meta por uma leitura de **ROI real por campanha**, cruzando **gasto do Meta Ads** com **faturamento e caixa reais do Clinicorp** (não o `leads.valor` auto-reportado que a página de Atribuição usa hoje).

**Natureza do agente (decisões do brainstorm):**
- **Read-only.** NÃO toca no Meta (não pausa, não muda orçamento). Só lê e recomenda; o Luiz executa.
- **Determinístico, sem LLM.** Motor de regras com selos. Custo zero, resultado previsível e auditável. (Alinha com "o 1º agente estruturado não precisa de LLM".)
- **Princípio mestre: "mostra o serviço".** Nenhum número sem rastro clicável. O painel **é** a auditoria — toda recomendação drilla até os leads/pacientes/pagamentos que a geraram.
- **Sem alertas proativos, sem ação automática, sem Google Ads** (YAGNI v1).

**Onde vive:** página nova `/marketing-agente/`, setor **Marketing** da sidebar, roles `admin,gestor`. **Aposenta o item "Atribuição"** do menu (o agente faz tudo que ela fazia, com receita real).

---

## 2. Pipeline de dados

Para cada **campanha** do Meta (conta `945699087658457`), agregando seus anúncios:

| Métrica | Fonte | Observação |
|---|---|---|
| **Gasto** | Meta Ads API via `/api/meta-insights` (ao vivo, suporta `periodo`/`desde`/`ate`) | Já existe; agrega `spend` por `campaign_name` |
| **Leads** | `leads` onde `campanha = ad_id` | `leads.campanha` guarda o `ad_id`; mapeia p/ campanha via `campaign_name` do insights |
| **Faturamento (safra)** | `fin_lancamentos` `post_type='REVENUE'` (competência) dos pacientes vinculados | ROI real da campanha |
| **Caixa (entradas)** | `fin_lancamentos` `post_type='RECEIVED'` por `data` (recebimento) | Injeção de caixa real |
| **ROAS real** | Faturamento ÷ Gasto | Só na lente Safra |
| **Cobertura** | % dos leads da campanha que casaram com um paciente + nº de vínculos incertos | Honestidade do número |

### Cadeia de vínculo (lead → receita)
```
lead.campanha (ad_id)
  → lead  (telefone, últimos 8 dígitos)
    → pacientes.clinicorp_id
      → fin_lancamentos.paciente_id  (filtra post_type)
```

### Regra de desempate para famílias (telefone com 0 à esquerda)
Um telefone (últimos 8 díg.) pode casar **vários leads** — estratégia intencional de família no mesmo WhatsApp (ver `feedback_telefone_zero_familia`). Para não atribuir receita à campanha errada:

1. Quando o paciente vinculado casa com **>1 lead**, a receita vai para o lead que:
   - tenha `campanha` preenchida (origem Meta) **E**
   - tenha `criado_em` mais próximo-**antes** do 1º lançamento REVENUE do paciente.
2. Se nenhum lead candidato tem `campanha` → receita é tratada como **orgânica** (não entra em campanha nenhuma).
3. Se há empate/ambiguidade real → o paciente entra na contagem **"vínculo incerto"**: a receita dele **não** soma no ROAS de nenhuma campanha, mas aparece no drill como "incerto" para conferência manual. Nunca infla número.

### Definição de Cobertura (honesta)
- **Cobertura = (leads da campanha que resolveram para 1 paciente) ÷ (total de leads da campanha).**
- Exibida por campanha + um contador de **vínculos incertos**.
- Leitura: cobertura baixa ⇒ "pode haver receita que não estou vendo, confira na mão antes de decidir".
- NÃO é "% da receita rastreada" (incalculável sem conhecer a receita não-rastreada).

---

## 3. Semântica do período (difere por lente)

| Lente | "Período" filtra… | Gasto | Receita exibida | Selos |
|---|---|---|---|---|
| **Safra (faturamento)** | quando o **lead entrou** (`criado_em`) | gasto **no período** | **todo** o REVENUE (lifetime) dos pacientes desses leads | **ativos** |
| **Caixa (entradas)** | quando o **dinheiro entrou** (`data` do RECEIVED) | gasto no período (proxy) | RECEIVED no período, atribuído à campanha de origem do lead do paciente | **mutados** (ranking de caixa, não ROAS limpo) |

- **Safra** responde: "a verba que coloquei nessa janela já gerou quanto de contrato?" → decisão de escalar/cortar.
- **Caixa** responde: "qual campanha de origem está injetando dinheiro no caixa AGORA?" → mistura safras de propósito (o Luiz pediu essa visão explicitamente).
- A UI deixa explícito, em cada lente, o que o período está medindo (evita interpretação errada).

---

## 4. Motor de regras (selos) — lente Safra

Cada campanha recebe **1 selo**, e o card mostra **o número que disparou a regra**:

| Selo | Condição | Significado |
|---|---|---|
| 🟢 **Escalar** | `ROAS ≥ meta` **e** gasto ≥ mínimo **e** safra madura | retorno comprovado, vale pôr mais verba |
| 🔴 **Cortar/revisar** | `ROAS < meta` **e** gasto ≥ mínimo **e** safra madura | está queimando dinheiro |
| 🟡 **Observar** | safra **imatura** (mais nova que a janela de maturação) **ou** gasto < mínimo | dado ainda não confiável p/ decidir |
| ⚪ **Cobertura baixa** | cobertura abaixo do piso de confiança | rastreou pouco; confira antes de confiar |

### Parâmetros configuráveis (defaults aprovados)
Guardados em tabela `marketing_config` (1 linha, editável por admin na própria página):

| Parâmetro | Default | Papel |
|---|---|---|
| `meta_roas` | **3,0** | piso de ROAS (faturamento ÷ gasto) p/ 🟢 |
| `gasto_minimo` | **R$ 200** | gasto mínimo no período p/ julgar (evita ruído) |
| `maturacao_dias` | **21** | abaixo disso, safra = 🟡 imatura |
| `cobertura_minima` | **60%** | abaixo disso, selo ⚪ |

> Nota de calibração: ROAS de faturamento numa clínica tende a ser alto (contrato cheio ÷ custo do lead). O default 3,0 é um piso conservador; recalibrar após ver os primeiros números reais.

---

## 5. Tela e drill-down auditável

**Topo:**
- Seletor de **lente** (Safra ⇄ Caixa) e de **período**.
- Resumo do período: gasto total, faturamento real, caixa, ROAS geral, cobertura média.
- Botão "⚙️ Parâmetros" (edita `marketing_config`) e "🔄 Atualizar dados" (padrão dos módulos Clinicorp — dispara o sync se necessário).

**Lista de campanhas** (ordenada por selo/impacto), cada uma um card com números + selo.

**Drill-down (a auditoria):**
- **Nível 1 — campanha:** clicar expande os **anúncios/criativos** dentro (gasto, leads, faturamento por anúncio).
- **Nível 2 — leads:** clicar no faturamento de uma campanha → lista os **leads** daquela campanha.
- **Nível 3 — paciente/pagamentos:** clicar num lead → **qual paciente casou** + **quais lançamentos** (`fin_lancamentos`: data, valor, post_type). É aqui que o Luiz valida "isso é real?".
- Cada bloco exibe sua **cobertura** + vínculos incertos.

---

## 6. Arquitetura técnica

**Sem LLM. Sem novo loop de agente.** v1 é cálculo set-based em SQL + endpoint + página estática (mesmo padrão dos outros módulos).

### Banco (migração nova)
- `marketing_config` — 1 linha com os 4 parâmetros + `atualizado_em`.
- **RPC `marketing_campanhas(p_desde, p_ate, p_lente)`** — retorna a tabela agregada por campanha: gasto NÃO (vem do Meta no backend), leads, faturamento/caixa, cobertura, incertos. Faz o join `leads → pacientes (telefone 8 díg.) → fin_lancamentos (post_type)` e aplica a regra de desempate de família.
- **RPC `marketing_drill_leads(p_campanha, ...)`** — leads de uma campanha com status do vínculo (casado/incerto/sem paciente).
- **RPC `marketing_drill_paciente(p_lead_id)`** — paciente + lançamentos (reusa lógica de `perfil_clinicorp`).

> Decisão: o **gasto** é buscado ao vivo do Meta no backend (`/api/meta-insights` já faz) e **mesclado** com o resultado das RPCs por `campaign_name`/`ad_id`. As RPCs cuidam só do lado receita (que está no Supabase). Snapshot diário de gasto (`meta_gasto_diario`) fica para v1.1 (trend histórico) — **YAGNI no v1**.

### Backend (`server.js`)
- `GET /marketing-agente/` → serve a página (requireAuth + requireRole admin,gestor).
- `GET /api/marketing/campanhas?lente=&desde=&ate=` → chama a RPC de receita + busca gasto no Meta + mescla + aplica selos (regras em JS, lendo `marketing_config`).
- `GET /api/marketing/drill/leads?campanha=&...` e `GET /api/marketing/drill/paciente?lead_id=`.
- `GET/PUT /api/marketing/config` → lê/edita `marketing_config` (admin).

### Frontend
- `public/marketing-agente/index.html` + `js/marketing-agente/*` (api.js no padrão de auth de páginas separadas).
- Inclui `shared-nav.js` com `data-active="marketing-agente"`.

### Nav / Usuários (CLAUDE.md, padrão obrigatório)
- Adicionar item em `CRM_NAV` (seção marketing) — `mode:'link'`, `href:'/marketing-agente/'`, roles `admin,gestor`.
- **Remover** o item `atribuicao` do `CRM_NAV`.
- Não cria novo perfil base (usa admin/gestor); sem `mod_` novo necessário no v1.

---

## 7. Riscos e validações durante o build

1. **REVENUE pode ser esparso.** O `post_type='REVENUE'` é guardado "para Fase 2" e ainda não foi validado em uso. **Validar** que o total REVENUE por paciente bate com o esperado; se vier furado, a lente Safra cai num fallback (valor de orçamento/contrato) — decidir com dado na mão.
2. **Cobertura real baixa.** Só ~4.063/15.847 leads casam paciente — mas leads de **campanha Meta** (CTWA recentes) tendem a casar melhor. A métrica de cobertura vai revelar o número real por campanha; o painel é honesto sobre isso por design.
3. **Mapeamento ad_id → campanha.** Anúncios deletados no Meta somem do insights; leads antigos podem ficar "órfãos" de nome de campanha. Mostrar como "Campanha desconhecida (ad_id X)" em vez de descartar.
4. **Performance.** Restringir a RPC a leads com `campanha IS NOT NULL` (subconjunto) e indexar `fin_lancamentos(paciente_id, post_type, data)`.

---

## 8. Fora de escopo (v1)

- Ação automática no Meta (pausar/realocar via API).
- Alertas proativos (WhatsApp/notificação).
- Leitura escrita por LLM.
- Google Ads.
- Snapshot histórico de gasto / gráficos de tendência (v1.1).
- Atribuição multi-touch (v1 é last-campaign por safra do lead).

---

## 9. Critérios de pronto (v1)

- Página `/marketing-agente/` no menu Marketing; "Atribuição" removida.
- Tabela por campanha com gasto (Meta) + faturamento + caixa + ROAS + cobertura, nas 2 lentes.
- Selos por regra com parâmetros editáveis (`marketing_config`).
- Drill-down 3 níveis (campanha → anúncio → lead → paciente/pagamentos) funcionando e batendo com o Clinicorp numa conferência manual de pelo menos 1 campanha.
- Regra de desempate de família aplicada; vínculos incertos visíveis e fora do ROAS.
