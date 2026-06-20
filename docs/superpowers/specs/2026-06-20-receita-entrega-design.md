# Spec: Módulo Receita x Entrega (Produção)

**Data:** 2026-06-20  
**Status:** Aprovado  
**Role de acesso:** `mod_financeiro`, `admin`

---

## Objetivo

Comparar o valor dos procedimentos odontológicos **realizados** (produção clínica) com a **receita recebida em caixa** (RECEIVED) no mesmo período. A taxa de alinhamento indica se a clínica está entregando mais ou menos do que recebeu.

| % Alinhamento | Interpretação |
|---|---|
| ~100% | Alinhado — cobrando e entregando na mesma proporção |
| >100% | Entregando mais do que cobrou → lucro real menor que o contábil |
| <100% | Dívida de serviço → receita à frente da entrega |

**Fontes:**
- **Produção** = `estimates/list` da Clinicorp → `ProcedureList[]` onde `Executed="X"`, agrupado por `ExecutedDate`
- **Receita** = `fin_lancamentos` (já sincronizado) onde `post_type='RECEIVED'`, agrupado por `data`

---

## Modelo de Dados

### Nova tabela: `producao_procedimentos`

```sql
CREATE TABLE producao_procedimentos (
  id                    bigserial PRIMARY KEY,
  clinicorp_estimate_id text        NOT NULL,
  clinicorp_treatment_id text,
  price_id              text,
  procedure_name        text,
  specialty_id          text,
  dentist_person_id     text,
  dentist_name          text,
  executed_date         date        NOT NULL,
  amount                numeric     NOT NULL DEFAULT 0,
  bill_type             text,        -- 'CLAIM' = convênio, outro = particular
  paciente_nome         text,
  atualizado_em         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (clinicorp_estimate_id, price_id, executed_date, dentist_person_id)
);

CREATE INDEX ON producao_procedimentos (executed_date);
CREATE INDEX ON producao_procedimentos (dentist_person_id);
CREATE INDEX ON producao_procedimentos (clinicorp_estimate_id);
```

A chave de unicidade `(clinicorp_estimate_id, price_id, executed_date, dentist_person_id)` garante idempotência nos upserts do sync.

---

## Sync

### Sync automático diário

Entra como nova fase no batch diário do `clinicorp-sync.js`, após `orcamentos_funil`.

- **Janela:** últimos 90 dias em chunks de ≤30 dias (mesmo padrão do financeiro)
- **Reaproveitamento:** reutiliza o request de `estimates/list` já feito pelo sync de orçamentos — não duplica chamadas no rate limit
- **Fluxo por chunk:**
  1. Itera `ProcedureList[]` de cada estimate
  2. Filtra `Executed === "X"` e `Amount > 0`
  3. Resolve `procedure_name` via catálogo `procedures/list` (cacheado em memória por sessão de sync; 96,6% de cobertura por `PriceId`; itens sem nome recebem string vazia — não bloqueiam)
  4. Upsert em lote de 500 na `producao_procedimentos`

### Backfill histórico

Script `scripts/backfill-producao.js <ano>` — roda manualmente uma vez por ano.

**Rate limit Clinicorp: 25 chamadas/hora.**

| Ano | Chamadas |
|---|---|
| 2026 (Jan–Mai) | 5 |
| 2025 (Jan–Dez) | 12 |
| **Total** | **17** — cabe em 1 hora com folga |

**Ordem recomendada:** rodar 2026 primeiro, depois 2025. O script espaça as chamadas automaticamente para não estourar o limite.

---

## API

### `GET /api/producao/resumo?from=YYYY-MM-DD&to=YYYY-MM-DD`

Retorna totais consolidados e breakdown por dentista.

```json
{
  "from": "2026-06-01",
  "to": "2026-06-30",
  "producao_total": 125000,
  "receita_total": 130000,
  "percentual": 96.2,
  "por_dentista": [
    { "dentist_person_id": "...", "dentist_name": "Marcos", "producao": 80000, "participacao_pct": 64.0 },
    { "dentist_person_id": "...", "dentist_name": "Matheus", "producao": 45000, "participacao_pct": 36.0 }
  ]
}
```

A receita não é detalhada por dentista porque `fin_lancamentos` não tem vínculo com dentista — lançamentos financeiros são da clínica, não do profissional. O comparativo Produção vs Receita existe apenas no nível consolidado (cards de resumo). O breakdown por dentista mostra produção e participação proporcional na produção total.

### `GET /api/producao/procedimentos?from=YYYY-MM-DD&to=YYYY-MM-DD&page=1&limit=100`

Lista paginada de procedimentos realizados.

```json
{
  "total": 342,
  "page": 1,
  "data": [
    {
      "executed_date": "2026-06-15",
      "dentist_name": "Marcos",
      "procedure_name": "Implante unitário",
      "paciente_nome": "João Silva",
      "amount": 2800,
      "bill_type": "PARTICULAR"
    }
  ]
}
```

**Autenticação:** ambos os endpoints exigem `requireAuth` + `requireFinanceiro` (role `mod_financeiro` ou `admin`).

---

## UI — `/producao/`

### Estrutura da página

Segue o padrão visual do `/financeiro/` (sidebar, fonte, cards).

**Topo:**
- Seletor de mês (padrão = mês atual)
- Botão "Range livre" → abre dois datepickers (de / até)
- Botão "🔄 Atualizar dados" → chama `POST /api/admin/sync-clinicorp` (padrão de todos os módulos)

**Cards de resumo (3 cards horizontais):**

| Card | Conteúdo |
|---|---|
| Produção | R$ total realizado no período |
| Receita | R$ total recebido no período (RECEIVED) |
| Alinhamento | % = Produção / Receita × 100 |

Cor do card Alinhamento:
- Verde: 90–110%
- Amarelo: 80–89% ou 111–125%
- Vermelho: <80% ou >125%

**Tabela por dentista:**

| Dentista | Produção | % da produção total |
|---|---|---|
| Marcos | R$80.000 | 64% |
| Matheus | R$45.000 | 36% |

> Receita por dentista não é exibida na tabela (dado não disponível no Clinicorp por dentista). Só a produção e participação proporcional.

**Tabela de procedimentos realizados** (lazy-load, expansível):

| Data | Dentista | Procedimento | Paciente | Valor |
|---|---|---|---|---|
| 15/06 | Marcos | Implante unitário | João Silva | R$2.800 |

- Ordenado por data DESC
- Paginação (100 por página)
- Totais no rodapé

---

## Navegação e Acesso

- URL: `/producao/`
- Entrada no menu lateral: seção "Financeiro" → "Receita x Entrega"
- Role: `mod_financeiro` ou `admin` (mesmo guard do módulo financeiro)

---

## Fora do escopo (versão 1)

- Breakdown por convênio vs particular
- Breakdown por especialidade
- Alertas automáticos quando alinhamento sai da faixa
- Comparativo mês a mês (gráfico de evolução)
- Integração com DRE
