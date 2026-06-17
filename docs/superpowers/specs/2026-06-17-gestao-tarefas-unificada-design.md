# Spec — Gestão de Tarefas Unificada

**Data:** 2026-06-17
**Módulo:** Central de Tarefas — Gestão (`/tarefas/gestao.html`)
**Objetivo:** Unificar as abas "Atribuir" e "Moldes por cargo" em uma única aba "Criar", simplificando o fluxo do gestor de 4 para 3 abas.

---

## Problema

O gestor hoje precisa decidir entre duas abas conceitualmente separadas:
- **Atribuir** → tarefa pontual, para pessoas específicas
- **Moldes por cargo** → tarefa recorrente, para todos de um cargo

A separação é técnica (como o sistema armazena), não conceitual (o que o gestor quer fazer). O resultado é confusão sobre onde ir para "criar uma tarefa".

---

## Solução

Introduzir o conceito de **tipo de atividade** como decisão primária do formulário:

- **Demanda** — realizada uma única vez, por pessoas específicas
- **Rotina** — recorrente (diária/semanal/mensal), por cargo ou pessoas específicas

---

## Estrutura de Navegação

### Antes (4 abas)
```
Painel  |  Atribuir  |  Moldes por cargo  |  Histórico
```

### Depois (3 abas)
```
Painel  |  Criar  |  Histórico
```

---

## Aba "Criar" — Formulário Unificado

### Toggle no topo
Dois botões pill-toggle, seleção exclusiva:
```
[ Demanda ]  [ Rotina ]
```
O formulário abaixo adapta dinamicamente ao tipo selecionado.

### Campos comuns (sempre visíveis)
| Campo | Tipo | Notas |
|---|---|---|
| Título | text | obrigatório |
| Descrição | textarea | opcional |
| Prioridade | select | normal / alta / baixa |
| Categoria | select | lista existente |
| Tipo de resultado | select | check / número |
| Unidade + Meta | text + number | visível só quando tipo = número |
| Arrasta | checkbox | "se não concluída hoje, aparece amanhã" |

### Campos exclusivos — Demanda
| Campo | Tipo | Notas |
|---|---|---|
| Prazo | datetime-local | opcional |
| Pessoas | checkbox list | ao menos uma obrigatória; botão "Selecionar todos" |

### Campos exclusivos — Rotina
| Campo | Tipo | Notas |
|---|---|---|
| Frequência | radio/select | Diária / Semanal / Mensal |
| Dias da semana | checkbox grid | visível quando freq = Semanal |
| Dia do mês | number (1–31) | visível quando freq = Mensal |
| Destino | radio | "Por cargo" ↔ "Pessoas específicas" |
| Cargo | select (roles) | visível quando destino = Por cargo |
| Pessoas | checkbox list | visível quando destino = Pessoas específicas |

**Botão de ação:** "Criar tarefa(s)" (mesma label nos dois modos)

---

## Aba "Painel" — Seção "Rotinas Ativas"

No topo do Painel, antes das stats da equipe, uma seção colapsável **"Rotinas ativas (N)"**.

Cada item exibe:
- Ícone 🔁, título, frequência, destino (cargo ou nomes), botão `[×]`

### Exclusão de rotina — modal de confirmação
Ao clicar `[×]`:

> **Excluir rotina "X"?**
>
> ○ Excluir só o molde — tarefas abertas hoje continuam
> ○ Excluir molde + fechar todas as instâncias abertas
>
> [ Cancelar ]  [ Excluir ]

---

## Backend

### Sem migração de banco
A tabela `task_templates` já suporta todos os campos necessários (`escopo`, `role`, `arrasta`, `tipo_resultado`, etc.). Nenhuma coluna nova.

### Nova funcionalidade no endpoint de delete
`DELETE /api/tarefas/templates/:id`

Adicionar suporte ao parâmetro body `fechar_instancias: boolean`:
- `false` (padrão) → deleta só o template
- `true` → deleta o template + faz `UPDATE tasks SET status='cancelada' WHERE template_id = :id AND status IN ('pendente','atrasada')`

### Rotinas por pessoas específicas (novo)
Hoje `task_templates` só tem `escopo: 'role'`. Para rotinas por pessoas específicas, usar `escopo: 'usuarios'` + coluna `assignee_ids` (jsonb, já existe em `tasks`).

A geração em `lib/tarefas/geracao.js` já suporta fan-out por `assignee_ids`. Só precisa do branch `escopo === 'usuarios'` no gerador.

---

## Frontend — Arquivos Alterados

| Arquivo | Mudança |
|---|---|
| `public/tarefas/gestao.html` | Remove aba "Atribuir" e "Moldes por cargo"; adiciona aba "Criar" |
| `public/js/tarefas/gestao.js` | Substitui `renderAtribuirForm()` + lógica de moldes por `renderCriarForm()` unificado; adiciona `_onTipoAtividadeChange()`; move lista de rotinas para `renderPainel()` |
| `server.js` | Adiciona `fechar_instancias` no `DELETE /api/tarefas/templates/:id`; suporte a `escopo: 'usuarios'` na criação de templates |
| `lib/tarefas/geracao.js` | Branch para `escopo === 'usuarios'` no gerador de instâncias |

---

## O que NÃO muda

- Tabelas do banco (`task_templates`, `tasks`) — sem migração
- Endpoint `POST /api/tarefas` (demandas) — sem alteração
- Endpoint `POST /api/tarefas/templates` (criação de moldes) — sem alteração na assinatura, apenas o front passa `escopo: 'usuarios'` quando necessário
- Aba "Painel" e aba "Histórico" — sem mudança estrutural (Painel ganha só a seção de rotinas no topo)
- `public/tarefas/index.html` (Central do usuário) — sem alteração

---

## Critérios de Sucesso

1. Gestor cria uma Demanda para 3 pessoas — todas recebem na Central
2. Gestor cria uma Rotina diária por cargo — gera instâncias no próximo cron
3. Gestor cria uma Rotina semanal para pessoas específicas — gera para essas pessoas
4. Gestor deleta rotina com opção "fechar instâncias" — tarefas abertas somem da Central
5. Gestor deleta rotina sem fechar instâncias — tarefas de hoje permanecem, amanhã não gera
6. Seção "Rotinas ativas" no Painel lista todas as rotinas com frequência e destino corretos
