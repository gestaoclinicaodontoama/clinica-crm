# Alerta de Lead Parado (estagnação comercial) — Design

**Data:** 2026-07-06
**Contexto:** Item 4 da fila de melhorias do CRM (análise de pontas soltas 03/07). Complementa o item 3 (handoff comercial, que deu dono via `crc_comercial_id`): agora que o lead comercial tem dono, este item **cobra o dono** quando o lead trava numa etapa sem ninguém mexer. Hoje não há SLA nem alerta — leads apodrecem na coluna.

## Descobertas de dados (medidas em produção, leads ativos não-importados)

| Etapa | Total | Parados 3d+ | Parados 7d+ |
|---|---|---|---|
| Compareceu | 25 | 21 (84%) | 21 |
| Em negociação (D0–D5) | 21 | 4 | 3 (saudável) |
| Em qualificação (SDR) | 105 | 93 | 73 |
| Avaliação agendada | 61 | 52 | 40 |

- **Compareceu é o alvo:** 84% parados — o momento mais caro (paciente veio à clínica) sem cobrança.
- **Em negociação está saudável** (17 de 21 ativos) — mas quando uma trava, vale avisar.
- **Em qualificação (SDR)** fica FORA: o item 1 já deu o filtro ⏰ de conversas sem resposta.
- **Avaliação agendada** fica FORA: parado ali é quase sempre "esperando a consulta"; a falta é coberta pelo item 2.
- "Parado" = medido por ausência de `lead_eventos` recente (mesmo sinal usado nos itens 1/2).

## Decisões do Luiz (brainstorm 06/07)

1. **Escopo:** só comercial — `Compareceu` (prazo 3 dias) e `Em negociação`/D0–D5 (prazo 5 dias). Prazos configuráveis.
2. **"Parado" =** sem nenhum evento de **ATIVIDADE REAL** há mais que o prazo da etapa. ⚠️ NÃO conta qualquer `lead_eventos` — eventos de sistema/broadcast resetariam o relógio falsamente (medido em 30d: `capi_disparado` 982, `disparo_massa` 103, `leads_mesclados` 71, `lead_criado` 824). Atividade real = allowlist: **`mensagem_enviada`, `mensagem_recebida`, `ligacao`, `status_mudou`, `nota_sdr_editada`, `template_enviado`, `conversa_assumida`, `comercial_assumido`, `mensagem_falhou`** (tentativa de contato). Exclui quem tem `proximo_contato` marcado no FUTURO (a CRC já tem plano — não é abandono).
3. **Superfície:** bloco ⚠️ Parados no Meu Dia (topo) + card vermelho no kanban comercial + cobrança diária por notificação.
4. Egress: tudo server-side filtrado (cota Supabase 155%).

## Componentes

### 1. Config (`app_config`)

`parado_prazo_compareceu_dias int default 3`, `parado_prazo_negociacao_dias int default 5`, `parado_notif_hora text default '09:00'` (horário da cobrança diária, America/São_Paulo). Adicionar via migração com `add column if not exists` + defaults.

### 2. Detecção — estender a RPC `comercial_meu_dia`

A RPC do item 3 (`comercial_meu_dia(p_uid uuid)`) já devolve jsonb com `para_pegar / meus_comparecidos / minhas_negociacoes / followups`. Adicionar um 5º bloco **`parados`** — assim o Meu Dia continua num round-trip só (egress). Um lead entra em `parados` se, para a CRC (`p_uid`, ou agregado se null):

- `status='Compareceu'` E sem `lead_eventos` há ≥ `parado_prazo_compareceu_dias` dias, **ou**
- `status='Em negociação'` E sem `lead_eventos` há ≥ `parado_prazo_negociacao_dias` dias,

e em ambos: `crc_comercial_id` bate (p_uid) e **NÃO** tem `proximo_contato` no futuro. A RPC lê os prazos de `app_config`. Campos por item: `id, nome, telefone, status, etapa, dias_parado` (dias desde a última atividade real). Ordenado por `dias_parado` desc (mais parado no topo). Matching 100% no Postgres — LATERAL para `max(lead_eventos.criado_em)` **filtrado pela allowlist de tipos de atividade** (não conta capi/broadcast/criação); `coalesce` com `data_comparecimento`/`data_avaliacao`/`criado_em` quando não há evento de atividade. Payload pequeno.

⚠️ A RPC `comercial_meu_dia` tem `execute` revogado de anon/public (item 3) — a nova versão deve **manter o revoke** (recriar a função re-concede execute a PUBLIC por default; re-aplicar o revoke na mesma migração).

### 3. Bloco ⚠️ Parados no Meu Dia

Novo bloco **no topo** da tela `public/meu-dia/index.html` (antes de "Para pegar"), consumindo `d.parados`. Cada card: nome (escapado com `escHtml`), telefone (link wa.me), etapa, e "parado há X dias" em vermelho. Clicar → abre o lead. Estado vazio amigável ("🎉 Nada parado — tudo em dia."). Reusa o `render()` existente (passa um flag de "urgente" para o estilo vermelho).

### 4. Card vermelho no kanban comercial

A query dos cards do kanban comercial (`buildComercialColFilter` / RPCs de coluna em `server.js`) passa a trazer `ultima_atividade` (max `lead_eventos.criado_em` **filtrado pela mesma allowlist de tipos de atividade** — não capi/broadcast/criação) por card — um timestamp por card (egress mínimo). No front (`public/kanban-comercial/index.html`), o card ganha selo/borda **vermelha "parado Xd"** quando `now - ultima_atividade` passa do prazo da etapa (3d Compareceu, 5d colunas D). Mesmo critério do bloco do Meu Dia (última atividade), pra as duas telas não se contradizerem. Não altera ordenação nem filtros existentes.

### 5. Cobrança diária (varredura)

Uma função `varrerLeadsParados()` num `setInterval` (padrão da varredura de fim de dia do item 1): no horário `parado_notif_hora` (America/São_Paulo), para cada CRC comercial do `comercial_pool`, conta os parados dela (via a mesma lógica da RPC) e, se N>0, dispara `criarNotificacao(uid, 'lead_parado', '⚠️ Leads parados', 'Você tem N leads parados — resolva no Meu Dia', { url:'/meu-dia/' })`. Dedup diário (grava último-envio por CRC em `app_config`, padrão do item 1). Tipo `lead_parado` precisa entrar no constraint `notificacoes_tipo_check` (migração, mesmo padrão).

## Erros e bordas

- Lead sem nenhum evento de atividade real (só teve capi/criação) → `ultima_atividade` cai no `coalesce` (data_comparecimento/data_avaliacao/criado_em), então conta desde aí — correto (nunca foi trabalhado = parado).
- `proximo_contato` no futuro exclui o lead do "parado" (respeitando o plano da CRC); se a data passar sem atividade, volta a contar.
- Duas telas (Meu Dia bloco + kanban card) usam o MESMO critério (última atividade + prazo da etapa) — consistência garantida.
- Erro na varredura/notificação não derruba nada (try/catch, fire-and-forget; nunca `.catch()` em builder Supabase).
- Recriar `comercial_meu_dia` sem re-aplicar o revoke reabriria o vazamento de PII — a migração re-aplica o revoke.
- Somas/filtros no SQL (RPC), nunca no JS (limite 1000 linhas).

## Testes

- `node:test` para a lógica pura, se houver (ex.: dado `dias_parado` e prazo da etapa → é parado?). O grosso é SQL/IO; validar via consulta em produção (leitura): a RPC devolve `parados` com contagens coerentes (Compareceu ~21, negociação ~3).
- Verificação pós-deploy: (a) o bloco ⚠️ Parados aparece no Meu Dia; (b) card vermelho no kanban para leads parados; (c) a varredura no horário dispara a notificação de resumo; (d) marcar `proximo_contato` no futuro tira o lead do "parado".

## Critérios de sucesso

1. A CRC comercial abre o Meu Dia e vê, no topo, os leads dela travados além do prazo, com há quantos dias.
2. O card no kanban comercial fica vermelho quando o lead passa do prazo, pelo mesmo critério.
3. Uma vez por dia, quem tem leads parados recebe a cobrança com link pro Meu Dia.
4. Marcar um follow-up futuro (ou trabalhar o lead) tira ele da lista de parados.

## Fora do escopo (v1)

Etapas SDR (item 1) e Avaliação agendada/falta (item 2); mover lead parado automaticamente de etapa (só alerta, a CRC decide); métricas de "tempo médio parado por CRC" (item de métricas, futuro); SLA para a carteira Dra. Izabela (fora do funil comercial).
