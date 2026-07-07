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

1. **Escopo:** só comercial — `Compareceu` (prazo 3 dias) e `Em negociação`/D0–D5 (prazo **por passo do D: ~2 dias no MESMO D**). Prazos configuráveis. ⚠️ **Regra D0–D5 (Playbook Pós-D5 do Luiz):** D0→D5 é uma cadência de ~8–10 dias com ~5 toques = ~1 toque a cada ~2 dias. Logo a estagnação em negociação NÃO é "X dias em negociação" e sim "parado no mesmo D sem toque > ~2 dias". Avançar o D (D1→D2) conta como toque e reseta o relógio.
2. **"Parado" =** sem nenhum evento de **ATIVIDADE REAL** há mais que o prazo da etapa. ⚠️ NÃO conta qualquer `lead_eventos` — eventos de sistema/broadcast resetariam o relógio falsamente (medido em 30d: `capi_disparado` 982, `disparo_massa` 103, `leads_mesclados` 71, `lead_criado` 824). Atividade real = allowlist: **`mensagem_enviada`, `mensagem_recebida`, `ligacao`, `status_mudou`, `etapa_mudou`, `nota_sdr_editada`, `template_enviado`, `conversa_assumida`, `comercial_assumido`, `mensagem_falhou`** (tentativa de contato). Exclui quem tem `proximo_contato` marcado no FUTURO (a CRC já tem plano — não é abandono).
3. **Superfície:** bloco ⚠️ Parados no Meu Dia (topo) + card vermelho no kanban comercial + cobrança diária por notificação.
4. Egress: tudo server-side filtrado (cota Supabase 155%).

## Componentes

### 0. Pré-requisito — logar o avanço do D (`etapa_mudou`)

⚠️ Medido no código: `patchLead` só loga `status_mudou` quando o **status** muda (`server.js:823`); mover D1→D2 (só muda `etapa_negociacao`, status segue "Em negociação") **não gera evento nenhum**. Sem isso, a regra "parado no mesmo D > 2 dias" contaria como parada uma CRC que está avançando o D corretamente. Correção obrigatória: no `patchLead`, quando `etapa_negociacao` muda de valor (e não é uma troca de status), logar `logEvento(id, 'etapa_mudou', 'Etapa: D_ant → D_novo', {de,para}, req.user?.id)`. Esse tipo entra na allowlist de atividade. (Leads que já estão num D antes desta feature não têm `etapa_mudou` histórico — o relógio deles cai no `coalesce` até o próximo toque; aceitável.)

### 1. Config (`app_config`)

`parado_prazo_compareceu_dias int default 3`, `parado_prazo_negociacao_dias int default 2` (por passo do D — ~2 dias/toque da cadência), `parado_notif_hora text default '09:00'` (horário da cobrança diária, America/São_Paulo). Adicionar via migração com `add column if not exists` + defaults.

### 2. Detecção — estender a RPC `comercial_meu_dia`

A RPC do item 3 (`comercial_meu_dia(p_uid uuid)`) já devolve jsonb com `para_pegar / meus_comparecidos / minhas_negociacoes / followups`. Adicionar um 5º bloco **`parados`** — assim o Meu Dia continua num round-trip só (egress). Um lead entra em `parados` se, para a CRC (`p_uid`, ou agregado se null):

- `status='Compareceu'` E sem evento de atividade há ≥ `parado_prazo_compareceu_dias` dias, **ou**
- `status='Em negociação'` E sem evento de atividade há ≥ `parado_prazo_negociacao_dias` dias (2 dias — "parado no mesmo D"; como avançar o D gera `etapa_mudou` que está na allowlist, mover o D reseta o relógio),

e em ambos: `crc_comercial_id` bate (p_uid) e **NÃO** tem `proximo_contato` no futuro. A RPC lê os prazos de `app_config`. Campos por item: `id, nome, telefone, status, etapa, dias_parado` (dias desde a última atividade real). Ordenado por `dias_parado` desc (mais parado no topo). Matching 100% no Postgres — LATERAL para `max(lead_eventos.criado_em)` **filtrado pela allowlist de tipos de atividade** (não conta capi/broadcast/criação); `coalesce` com `data_comparecimento`/`data_avaliacao`/`criado_em` quando não há evento de atividade. Payload pequeno.

⚠️ A RPC `comercial_meu_dia` tem `execute` revogado de anon/public (item 3) — a nova versão deve **manter o revoke** (recriar a função re-concede execute a PUBLIC por default; re-aplicar o revoke na mesma migração) e **continuar SECURITY INVOKER** (NÃO adicionar `SECURITY DEFINER` — há alerta sistêmico de ~27 RPCs abertas pra anon [[project-rpc-anon-exposure]]; INVOKER + revoke é o padrão seguro aqui, e a mesma regra vale para a nova RPC `leads_ultima_atividade`).

### 3. Bloco ⚠️ Parados no Meu Dia

Novo bloco **no topo** da tela `public/meu-dia/index.html` (antes de "Para pegar"), consumindo `d.parados`. Cada card: nome (escapado com `escHtml`), telefone (link wa.me), etapa, e "parado há X dias" em vermelho. Clicar → abre o lead. Estado vazio amigável ("🎉 Nada parado — tudo em dia."). Reusa o `render()` existente (passa um flag de "urgente" para o estilo vermelho).

### 4. Card vermelho no kanban comercial

⚠️ Os cards do kanban são carregados por **PostgREST builder** (`buildComercialColFilter` → `supabase.from('leads').select(CARD_FIELDS)`, `server.js:978`), NÃO por SQL cru — logo **não dá pra computar `ultima_atividade` inline** (PostgREST não faz agregação lateral no select). Solução: **consulta-companheira** — depois de carregar os ~30 cards de uma coluna comercial (Compareceu e D0–D5), a rota faz UMA chamada a uma RPC `leads_ultima_atividade(p_ids bigint[])` que devolve `(lead_id, ultima_atividade)` (max `lead_eventos.criado_em` **filtrado pela allowlist de tipos**) para aqueles ids. A rota anexa `dias_parado` a cada card. Egress mínimo (1 query por coluna, ~30 ids, resultado pequeno). No front (`public/kanban-comercial/index.html`), o card ganha selo/borda **vermelha "parado Xd"** quando `dias_parado` passa do prazo da etapa (3d Compareceu, **2d nas colunas D**). Mesmo critério do bloco do Meu Dia — as duas telas não se contradizem. Não altera ordenação/filtros/paginação existentes. RPC `leads_ultima_atividade` também com `execute` revogado de anon/public.

### 5. Cobrança diária (varredura)

Uma função `varrerLeadsParados()` num `setInterval` (padrão da varredura de fim de dia do item 1): no horário `parado_notif_hora` (America/São_Paulo), para cada CRC comercial do `comercial_pool`, conta os parados dela (via a mesma lógica da RPC) e, se N>0, dispara `criarNotificacao(uid, 'lead_parado', '⚠️ Leads parados', 'Você tem N leads parados — resolva no Meu Dia', { url:'/meu-dia/' })`. Dedup diário (grava último-envio por CRC em `app_config`, padrão do item 1). Tipo `lead_parado` precisa entrar no constraint `notificacoes_tipo_check` (migração, mesmo padrão).

## Erros e bordas

- ⚠️ **O bloco `parados` nasce em ~0 e isso é correto:** ele exige dono (`crc_comercial_id`), que começou a popular no item 3 (hoje=0). Os 44 travados SEM dono (medido 06/07) são cobertos por "para_pegar" (Meu Dia) e pelo card vermelho do kanban (que NÃO exige dono). O bloco enche conforme as CRC pegarem leads.

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
