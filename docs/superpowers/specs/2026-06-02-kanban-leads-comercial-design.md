# Kanban Leads + Kanban Comercial — Design Spec
**Data:** 2026-06-02
**Status:** Aprovado

---

## Visão geral

Dois módulos Kanban independentes para gestão do pipeline de leads da Clínica AMA:

- **Kanban Leads** (`/kanban-leads/`) — foco em leads que ainda não chegaram à clínica
- **Kanban Comercial** (`/kanban-comercial/`) — foco em pacientes que compareceram e estão em negociação

Ambos resolvem a limitação do kanban embutido no Chat (que carrega todos os leads em memória e não escala com 13k+ registros).

---

## Kanban Leads — 9 colunas

### Mapeamento de colunas

| Coluna | Status no banco | Critério de tempo | Exclui |
|--------|----------------|-------------------|--------|
| **Lead** | qualquer não-comercial¹ | `criado_em >= hoje−30d` | — |
| **Nutrir 30–180d** | `Lead`, `Nutrir`, `Reclassificar` | `criado_em` entre hoje−180d e hoje−30d | `Aguardando` |
| **Nutrir 180–365d** | `Lead`, `Nutrir`, `Reclassificar` | `criado_em` entre hoje−365d e hoje−180d | `Aguardando` |
| **Nutrir 365+** | `Lead`, `Nutrir`, `Reclassificar` | `criado_em < hoje−365d` | `Aguardando` |
| **Aguardando** | `Aguardando` | — | — |
| **Agendado** | `Agendado` | — | — |
| **Faltou** | `Faltou` ← novo status | — | — |
| **Compareceu** | `Compareceu` | `data_comparecimento >= hoje−30d` | — |
| **Não tem interesse** | `Não tem Interesse` | — | — |

¹ *"não-comercial"* = exclui `Agendado`, `Faltou`, `Compareceu`, `Não tem Interesse`, `D0`–`D5`, `Em nutrição`, `Fechou`, `Perdido`.

### Ordenação dos cards

- Colunas **Lead / Nutrir**: `criado_em DESC` (mais recente primeiro)
- **Agendado**: `data_agendamento ASC` (próximo agendamento primeiro)
- **Compareceu**: `data_comparecimento DESC`
- Demais: `criado_em DESC`

### Nota de duplicidade intencional

Leads com `status = 'Compareceu'` e `data_comparecimento <= hoje−30d` **não aparecem** no Kanban Leads (a coluna Compareceu só mostra os últimos 30 dias). Esses mesmos leads aparecem no Kanban Comercial (Em nutrição). Isso é intencional — times diferentes usam boards diferentes.

---

## Kanban Comercial — 12 colunas

### Mapeamento de colunas

| Coluna | Critério |
|--------|----------|
| **Compareceu** | `status = 'Compareceu'` E `data_comparecimento >= hoje−30d` |
| **D0** | `status = 'D0'` |
| **D1** | `status = 'D1'` |
| **D2** | `status = 'D2'` |
| **D3** | `status = 'D3'` |
| **D4** | `status = 'D4'` |
| **D5** | `status = 'D5'` |
| **Em nutrição 30–180d** | ver abaixo |
| **Em nutrição 180–365d** | ver abaixo |
| **Em nutrição 365+** | ver abaixo |
| **Fechou** | `status = 'Fechou'` E `data_fechamento >= hoje−30d` |
| **Perdido** | `status = 'Perdido'` |

### Critério detalhado das sub-colunas Em nutrição

A referência de tempo é `COALESCE(data_comparecimento, data_orcamento, criado_em)` (fallback para leads que entraram em Em nutrição sem passar pelo fluxo Compareceu → D0).

| Coluna | Critério completo |
|--------|-------------------|
| **Em nutrição 30–180d** | (`status = 'Em nutrição'` OU (`status = 'Compareceu'` E ref < hoje−30d)) E ref >= hoje−180d |
| **Em nutrição 180–365d** | mesmas condições de status E ref entre hoje−365d e hoje−180d |
| **Em nutrição 365+** | mesmas condições de status E ref < hoje−365d |

### Fluxo esperado das CRCs

```
Compareceu → D0 → D1 → D2 → D3 → D4 → D5 → Fechou
                                            ↘ Perdido
              ↘ Em nutrição (se não evoluir em 30d, cai automaticamente)
```

Se a CRC não mover o lead de Compareceu em 30 dias, ele migra automaticamente para **Em nutrição 30–180d** (por critério de query — sem alteração de status no banco).

---

## Arquitetura

### Arquivos novos

```
public/kanban-leads/index.html
public/kanban-comercial/index.html
```

Ambos incluem `shared-nav.js` com `data-active` correspondente.

### Alterações existentes

- `server.js` linha 46: adicionar `'Faltou'` ao array `FUNIL`
- `public/index.html`: adicionar links de nav para os dois kanbans
- `public/js/shared-nav.js`: adicionar entradas para os dois kanbans
- Módulo de Usuários: registrar `mod_kanban_leads` e `mod_kanban_comercial`

### Endpoints backend — 4 novos

```
GET /api/kanban/leads/counts
  → { lead, nutrir_30, nutrir_180, nutrir_365, aguardando, agendado,
      faltou, compareceu, nao_tem_interesse }
  Implementação: SQL COUNT por coluna numa única query (CASE WHEN)

GET /api/kanban/leads/:coluna
  Query params: page=0, q= (busca), crc=
  Colunas válidas: lead | nutrir_30 | nutrir_180 | nutrir_365 |
                   aguardando | agendado | faltou | compareceu | nao_tem_interesse
  → array de 30 leads ordenados + { total, page, hasMore }

GET /api/kanban/comercial/counts
  → { compareceu, d0, d1, d2, d3, d4, d5,
      nutricao_30, nutricao_180, nutricao_365, fechou, perdido }

GET /api/kanban/comercial/:coluna
  Query params: page=0, q= (busca), crc=
  Colunas válidas: compareceu | d0 | d1 | d2 | d3 | d4 | d5 |
                   nutricao_30 | nutricao_180 | nutricao_365 | fechou | perdido
  → array de 30 leads + { total, page, hasMore }
```

**Drag-and-drop** usa o `PATCH /api/leads/:id` já existente com `{ status: novoStatus }`.

### Campos retornados por card

```json
{
  "id": 123,
  "nome": "João Silva",
  "telefone": "31999999999",
  "origem": "Facebook",
  "status": "Nutrir",
  "valor": 8500,
  "criado_em": "2025-08-15T...",
  "data_comparecimento": null,
  "data_agendamento": null,
  "data_fechamento": null,
  "crc_agendamento_nome": "Ana",
  "crc_comercial_nome": null
}
```

---

## Layout e UX

### Estrutura visual

```
[Sidebar 220px] | [Board — scroll horizontal]
                  ┌─────────┐ ┌─────────┐ ┌─────────┐  ···
                  │  Lead   │ │Nutrir   │ │Nutrir   │
                  │   4     │ │30-180d  │ │180-365d │
                  │  ────   │ │ 2.341   │ │  5.102  │
                  │ [card]  │ │ [card]  │ │ [card]  │
                  │ [card]  │ │ [card]  │ │ [card]  │
                  │         │ │  + 30   │ │  + 30   │
                  └─────────┘ └─────────┘ └─────────┘
```

- Colunas: **280px** largura fixa
- Board: scroll horizontal
- Cada coluna: scroll vertical interno, máximo viewport height
- Paginação: botão **"+ 30"** no rodapé da coluna (appenda cards, não substitui)

### Card

```
┌──────────────────────────────┐
│ João Silva            3d atrás│
│ (31) 99999-9999               │
│ [Facebook]       R$ 8.500     │
│              [💬 WhatsApp]    │
└──────────────────────────────┘
```

- **Tempo na coluna**: calculado no frontend a partir do campo de data relevante:
  - Kanban Leads: `criado_em`
  - Kanban Comercial Compareceu/Em nutrição: `data_comparecimento`
  - D0–D5: `data_avaliacao`
  - Fechou: `data_fechamento`
- **Valor**: exibido apenas se preenchido
- **CRC**: exibido apenas se preenchido
- Click no card → abre chat do lead (mesmo comportamento do kanban de Conversas)

### Drag-and-drop

| Tipo de coluna | Drop zone | Drag out |
|----------------|-----------|----------|
| Nutrir 30/180/365 | ✗ (time-based) | ✓ |
| Em nutrição 30/180/365 | ✗ (time-based) | ✓ |
| Todas as demais | ✓ | ✓ |

Ao soltar: `PATCH /api/leads/:id` com novo status. Card some da coluna origem e aparece na destino imediatamente (otimista).

### Filtros

- **Busca** (topo do board): nome ou telefone, server-side, debounce 300ms — recarrega todos os counts e cards
- **CRC** (dropdown): filtra por `crc_agendamento_nome` (Kanban Leads) ou `crc_comercial_nome` (Kanban Comercial)

### Collapse de coluna

- Click no header colapsa a coluna para `48px` de largura (só ícone + count)
- Estado salvo em `localStorage` por board
- Útil para Nutrir 365+ e Em nutrição 365+ (grandes, baixa prioridade)

### Cores por urgência

| Coluna | Cor de destaque |
|--------|----------------|
| Lead | `--accent` (azul) |
| Nutrir 30–180d | `--yellow` (amarelo) |
| Nutrir 180–365d | `--orange` (laranja) |
| Nutrir 365+ | `--red` (vermelho) |
| Aguardando | `--muted` (cinza) |
| Agendado | `--yellow` (âmbar) |
| Faltou | `--orange` (laranja) |
| Compareceu | `--purple` (roxo) |
| Não tem interesse | `--muted` (cinza) |
| D0–D5 | `--accent` → `--green` (gradiente por índice) |
| Em nutrição 30–180d | `--yellow` |
| Em nutrição 180–365d | `--orange` |
| Em nutrição 365+ | `--red` |
| Fechou | `--green` (verde) |
| Perdido | `--muted` (cinza) |

### Mobile

Scroll horizontal com touch (mesmo padrão do kanban de Conversas existente). Sem breakpoint especial.

---

## Roles e acesso

| Módulo | Roles com acesso |
|--------|-----------------|
| Kanban Leads | `admin`, `crc`, `mod_kanban_leads` |
| Kanban Comercial | `admin`, `crc`, `mod_kanban_comercial` |

Registrar `mod_kanban_leads` e `mod_kanban_comercial` no módulo de Usuários (checkboxes em Módulos Extras + `_ROLE_LABELS` + `criarUsuario()`).

---

## Fora do escopo (MVP)

- Notificações em tempo real quando card muda de coluna
- Filtro por período customizado (janelas são fixas por design)
- Métricas/analytics por coluna
- Kanban em modo tela cheia (sem sidebar)
