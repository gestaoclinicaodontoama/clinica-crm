# Executor por procedimento + Marcar executado (no modal de planejamento) — Design

**Data:** 2026-07-20. Complementa o Modo de Planejamento ① (no ar) e conversa com o Registro por Sessão ② (`/sessao/`). Alimenta ③ (planejado×real) e ④ (tracker) sem nova fonte de dados.

## Motivação (pedido do Luiz, 20/07)
No modal "Planejar" (Trilhas / Planejamento) só existe **1 "Dentista responsável" por plano inteiro** e um executor **texto livre por etapa** (que nem aparece quando o procedimento não tem etapas). Como um plano cruza várias áreas da odontologia, **cada procedimento (ou etapa) precisa do seu próprio executor**. Além disso, quem está no modal quer poder **marcar um procedimento/etapa como executado ali mesmo**, escolhendo a **data**, e ter a opção de **anotar isso na ficha do Clinicorp** (escrita real fica para quando o usuário-robô estiver logando — aqui entregamos só o gancho).

## Princípio central
**"Executado" mora sempre na etapa (`plano_etapas`)** — a fonte única que auditoria (Task 9 / `classificarDia`), planejado×real (③) e tracker (④) já consomem. Não criamos estado de execução paralelo em `plano_itens`. A máquina de estados `avancarPorRegistro` (lib `lib/planejamento/estados.js`) é reusada — a mesma do `/sessao/etapa`.

## Decisões travadas (Luiz)
1. **Executor por procedimento**, em **dropdown** (não texto livre), que **herda para as etapas** vazias daquele procedimento; a etapa ainda pode trocar individualmente.
2. **Marcar executado**: seleção **manual, uma etapa por vez** (botão por etapa) **+ um botão "Executar todos"** por procedimento (conclui todas as etapas pendentes dele de uma vez).
3. **Histórico**: grava no **nosso sistema já** (data + quem executou + quem registrou). Deixa o **gancho** pronto para o robô escrever na ficha do Clinicorp depois. A pergunta "anotar na ficha?" fica registrada como intenção.

## Dados — 1 migração (só colunas; tabelas já com RLS ligada)
- `plano_itens` **+ `profissional_executor text`** — executor do procedimento (herda para as etapas).
- `plano_etapas` **+ `ficha_anotar boolean NOT NULL DEFAULT false`** **+ `ficha_escrita_em timestamptz`** — o gancho do robô.
  - O histórico-com-data no nosso sistema **já é** o `concluida_em` (existente).
  - `asb_responsavel uuid` (existente) = **quem registrou** (no modal, `req.user.id`).
  - `profissional_executor text` (existente) = **quem executou**.
- Nenhuma coluna de "executado" em `plano_itens`: execução vive na etapa.

Migração escrita como arquivo `.sql` casando a version, aplicada via MCP Supabase (project `mtqdpjhhqzvuklnlfpvi`), verificada com `list_migrations`.

## Executor — dropdown que herda
- **Fonte da lista:** `planejamento_dentistas` (já chega no modal como `dentistas`, cada um com `profissional_nome`, `user_id` podendo ser null). Guardamos o **nome** (`text`) — consistente com o que já existe (`plano_etapas.profissional_executor`, `processos_padrao.profissional_sugerido`) e cobre profissional sem login.
- **Procedimento:** cada `<fieldset>` de item ganha `<select class="item-prof">` populado de `dentistas` (option `value` = `profissional_nome`; + uma opção vazia; + a opção do valor salvo caso não esteja na lista, para não perder texto-livre legado). Valor inicial = `item.profissional_executor`.
- **Etapa:** o `<input class="et-prof">` (texto livre) **vira `<select class="et-prof">`** com as mesmas opções (idem para etapa nova e etapa vinda de padrão).
- **Herança:** ao mudar o `<select>` do procedimento, preenche o executor das etapas **vazias** daquele fieldset (não sobrescreve etapa já escolhida).
- **Persistência:** `coletar()` passa `profissional_executor` de cada item; o `PUT /api/planejamento/plano/:id` grava em `plano_itens.profissional_executor` (novo) e nas etapas (já grava). Sanitizar com `sanitizeStr(..., 120)`.

## Marcar executado
### UI (editor.js)
- **Por etapa pendente:** ao lado do `×`, um botão **"✓"** (executar esta etapa).
- **Por procedimento:** no rodapé do `<fieldset>`, um botão **"✓ Executar todos"** (conclui todas as etapas pendentes do procedimento; se o procedimento **não tem etapa**, ainda assim marca o procedimento como realizado).
- **Mini-diálogo** ao clicar (etapa ou "todos"): campo **data** (default hoje, `type=date`) + checkbox **"Anotar na ficha do Clinicorp"**. Confirmar dispara a chamada; **Cancelar** não faz nada.
- Após sucesso, **recarrega o plano no modal** (re-render) para refletir o novo status das etapas e do plano. Reflete sozinho em Trilhas/tracker/auditoria (todos leem `plano_etapas`).

### Endpoint (server.js)
`POST /api/planejamento/plano/:id/executar` — middlewares `requireAuth` → `blockParceiro` → `requirePlanejamento` → `rateLimit` (mesmo gate do PUT; CRC no Trilhas recebe o 403 amigável já tratado no editor).

Body: `{ etapa_id? , item_id? , data?, anotar_ficha? }` (exatamente um de `etapa_id`/`item_id`).

Validação e posse:
- `data` opcional, formato `YYYY-MM-DD` (mesma checagem do `/sessao/etapa`); default = hoje (America/Sao_Paulo).
- Carregar o plano por `:id`; recusar se `trava_resync` (409 "plano travado") ou status lateral `descartado`/`cancelado` (409 "reative antes"), igual `/sessao/etapa`.
- **Posse:** a etapa/o item precisa pertencer ao plano da URL (`plano_itens.plano_id = :id`); senão 404. Se `soDentista` e o plano é de outro dentista → 403 (mesmo padrão das outras rotas).

Efeito:
- **`etapa_id`:** se já `concluida`/`concluida_retroativa` → `{ ok:true, jaConcluida:true }` (idempotente). Senão `update` → `status='concluida'`, `concluida_em` (da data), `asb_responsavel=req.user.id`, `ficha_anotar=!!anotar_ficha`; **executor:** se a etapa está sem `profissional_executor`, herda do `plano_itens.profissional_executor`, senão do `plano_tratamento.dentista_avaliador_id` (nome via `planejamento_dentistas`). `tempo_real_min` fica **null** (marcação manual do dentista não mede cadeira; o `/sessao/` continua sendo a fonte de tempo real).
- **`item_id` ("executar todos"):**
  - Conclui **todas as etapas pendentes** do item (mesmo `update` acima, mesma data/`ficha_anotar`, executor herdado do item).
  - Se o item **não tem nenhuma etapa**, cria **1 etapa sintética** `descricao = procedure_name` (ou "Procedimento realizado" se vazio), `ordem=0`, já `status='concluida'`, com `concluida_em`, `asb_responsavel`, `profissional_executor` (do item/plano), `ficha_anotar`. Assim "executado" continua morando na etapa (fonte única) e o procedimento aparece feito em ③/④/auditoria.
- **Avança o plano:** após os updates, recalcula com `avancarPorRegistro(plano.status, statusesDeTodasAsEtapasDoPlano)` — aplicando **2×** quando sobe para `em_andamento` e todas já estão concluídas (aguardando/planejado → em_andamento → concluido), idêntico ao `/sessao/etapa`.

### Anti-duplicação (reuso obrigatório)
A rotina "após concluir etapa(s), reler todas as etapas do plano e avançar o status com `avancarPorRegistro` (até 2×)" é **idêntica** entre `/sessao/etapa` e o novo `executar`. Extrair um helper no server, ex.:

```
async function avancarPlanoAposRegistro(planoId, statusAtual) { /* relê etapas, aplica avancarPorRegistro até 2x, faz o update, retorna status final */ }
```

e chamar dos **dois** endpoints (o `/sessao/etapa` passa a usá-lo no lugar do bloco inline atual). Sem nova cópia da máquina de estados.

## Segurança / robustez
- `esc()` em toda interpolação de `innerHTML` (options de executor incluídas).
- Sem `.catch()` em builder do Supabase — `try/catch` no `await` (padrão do arquivo).
- Tabela nova? **Não** — só colunas; RLS já está ligada nas tabelas.
- Gancho robô: quando o usuário-robô entrar, ele consulta `plano_etapas WHERE ficha_anotar AND ficha_escrita_em IS NULL`, escreve na ficha do Clinicorp e carimba `ficha_escrita_em`. Fora do escopo desta entrega (login do robô pendente).

## Fora de escopo (confirmado)
- Escrita real na ficha do Clinicorp (usuário-robô, login não capturado). Entregamos só `ficha_anotar` + `ficha_escrita_em`.
- Nada muda no `/sessao/` da ASB além de passar a usar o helper compartilhado de avanço (comportamento idêntico).

## Testes
- **Unit (lib já coberta):** `avancarPorRegistro` não muda; cobrir o helper `avancarPlanoAposRegistro` com: 1 etapa concluída em plano `planejado` → `em_andamento`; última etapa → `concluido`; plano `descartado`/`cancelado`/travado → sem efeito.
- **Manual:**
  1. Escolher executor no procedimento → etapas vazias herdam; trocar em 1 etapa não é sobrescrito.
  2. "✓" em uma etapa (data de ontem, "anotar ficha" marcado) → etapa `concluida`, `concluida_em` = ontem, `asb_responsavel` = eu, `ficha_anotar=true`; plano sobe de estado.
  3. "✓ Executar todos" num procedimento **com** etapas → todas concluídas de uma vez.
  4. "✓ Executar todos" num procedimento **sem** etapas → cria etapa sintética concluída; procedimento aparece feito em Trilhas/auditoria.
  5. Reabrir o modal reflete os status; "Salvar rascunho" depois **não apaga** as etapas concluídas (o PUT só recria pendentes).
  6. CRC no Trilhas clicando executar → 403 amigável.
