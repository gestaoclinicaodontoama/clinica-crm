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

Migração escrita como arquivo `.sql` casando a version, aplicada via MCP Supabase (project `mtqdpjhhqzvuklnlfpvi`), verificada com `list_migrations`. ⚠️ Timestamp precisa vir **depois de `20260720180000`** (já existem 3 migrações de 20/07).

## Executor — dropdown que herda
- **Fonte da lista:** `planejamento_dentistas` (já chega no modal como `dentistas`, cada um com `profissional_nome`, `user_id` podendo ser null). Guardamos o **nome** (`text`) — consistente com o que já existe (`plano_etapas.profissional_executor`, `processos_padrao.profissional_sugerido`) e cobre profissional sem login.
- **Procedimento:** cada `<fieldset>` de item ganha `<select class="item-prof">` populado de `dentistas` (option `value` = `profissional_nome`; + uma opção vazia; + a opção do valor salvo caso não esteja na lista, para não perder texto-livre legado). Valor inicial = `item.profissional_executor`.
- **Etapa:** o `<input class="et-prof">` (texto livre) **vira `<select class="et-prof">`** com as mesmas opções (idem para etapa nova e etapa vinda de padrão).
- **Herança:** ao mudar o `<select>` do procedimento, preenche o executor das etapas **vazias** daquele fieldset (não sobrescreve etapa já escolhida).
- **Persistência:** `coletar()` passa `profissional_executor` de cada item; o `PUT /api/planejamento/plano/:id` grava em `plano_itens.profissional_executor` (novo) e nas etapas (já grava). Sanitizar com `sanitizeStr(..., 120)`.

## Marcar executado
### UI (editor.js)
- **Por etapa pendente:** ao lado do `×`, um botão **"✓"** (executar esta etapa).
- **Por procedimento:** no rodapé do `<fieldset>`, um botão **"✓ Executar todos"** (conclui todas as etapas pendentes do procedimento; se o procedimento **não tem etapa**, ainda assim marca o procedimento como realizado). O editor só renderiza fieldsets dos itens **raiz** — num item dividido, as etapas dos sub-lotes filhos são concluídas pelo servidor via o mesmo botão (ver endpoint).
- **Mini-diálogo** ao clicar (etapa ou "todos"): campo **data** (default hoje, `type=date`) + checkbox **"Anotar na ficha do Clinicorp"**. Confirmar dispara a chamada; **Cancelar** não faz nada.
- ⚠️ **Salvar-antes-de-executar (obrigatório):** o re-render descartaria trabalho não salvo do modal — etapas novas (`li.nova`), textos e a divisão em sub-lotes (que só existe em `dataset.sublotes` até o PUT). Ao confirmar o mini-diálogo, o editor dispara **o mesmo `PUT` do "Salvar rascunho" (`coletar()`)** antes de executar. Isso também elimina o risco de `data-status` stale: após o re-render, a etapa concluída volta com `status='concluida'` e o filtro do PUT a preserva.
- ⚠️ **O pré-PUT invalida os ids de TODAS as etapas pendentes** (o PUT deleta e recria as pendentes com ids novos — server.js ~5203-5208 — e recria com `ordem = índice` na lista enviada). Portanto o "✓" de etapa **nunca usa o id do DOM** após o pré-PUT. Fluxo obrigatório: **① captura alvo = (item_id, índice) — o índice é a posição do li entre os lis PENDENTES/NOVOS do fieldset (mesmo predicado do filtro do PUT: `li.nova` ou `data-status='pendente'`; concluídas e filhos read-only NÃO contam — o PUT gera `ordem: i` sobre o array já filtrado, server.js ~5204, então contar concluídas deslocaria o índice e executaria a etapa ERRADA) → ② PUT `coletar()` → ③ re-fetch do plano (`GET /plano/:id`) → ④ resolve o id novo: etapa `pendente` do item com `ordem == índice`; se não achar E o PUT enviou `sublotes` (item dividido nesta sessão — as etapas coletadas vão pro 1º sub-lote, server.js ~5198-5201), procura a `pendente` com `ordem == índice` no `sublotes[0]` do re-fetch → ⑤ `executar {etapa_id novo}` → ⑥ re-render.** Se a resolução ainda falhar, **não executa**: re-render + aviso "plano atualizado — clique ✓ novamente". O "Executar todos" não sofre disso (ids de `plano_itens` sobrevivem ao PUT) e usa `item_id` direto. O "✓" de etapa de **filho** (read-only, fora do `coletar()`) usa o id que veio do GET — sobrevive ao pré-PUT, exceto se houve re-divisão na sessão (aí cai no mesmo fallback do 404: re-render + aviso).
- Após sucesso, **recarrega o plano no modal** (re-render) para refletir o novo status das etapas e do plano. Reflete sozinho em Trilhas/tracker/auditoria (todos leem `plano_etapas`).
- **Etapas de sub-lotes filhos:** o editor passa a renderizar, dentro do fieldset do item raiz dividido, as etapas dos filhos em modo **somente leitura** (agrupadas por rótulo do sub-lote), cada uma com o seu botão **"✓"** individual (o endpoint já aceita `etapa_id` de filho). **Mecanismo obrigatório para ficarem fora do `coletar()`:** o li do filho usa o atributo **`data-etapa-filho`** (NUNCA `data-etapa`) — o seletor do `coletar()` é `[data-etapa], li.nova` (editor.js ~104) e capturaria o filho, fazendo o PUT duplicar a pendente do filho na raiz. O "✓" lê o id de `data-etapa-filho`.
- **Etapa concluída = somente leitura:** inputs/select de etapa com `status !== 'pendente'` são renderizados `disabled` (hoje ficam editáveis e o PUT descarta a edição em silêncio — ilusão que o dropdown de executor agravaria).
- **Plano `concluido`, `descartado` ou `cancelado` não mostra botões de executar** ("✓" e "✓ Executar todos" escondidos nos três): o pré-PUT obrigatório levaria a um 409 confuso ("plano X — reative antes de editar", server.js ~5152) antes de chegar ao endpoint. Quem precisar mexer usa o fluxo existente de reativação (laterais já caem no rodapé só-Reativar; esconder o "✓" nelas também, pois os fieldsets renderizam incondicionalmente).

### Endpoint (server.js)
`POST /api/planejamento/plano/:id/executar` — middlewares `requireAuth` → `blockParceiro` → `requirePlanejamento` → `rateLimit` (mesmo gate do PUT; CRC no Trilhas recebe o 403 amigável já tratado no editor).

⚠️ **Ordem de registro:** a rota genérica `POST /api/planejamento/plano/:id/:acao` (server.js ~5216) casa com `/plano/:id/executar` e responderia `400 'ação inválida'` com gate errado (`requirePlanejamentoOuCRC`). A rota `executar` **deve ser registrada ANTES** da genérica no arquivo (Express casa na ordem de registro).

Body: `{ etapa_id? , item_id? , data?, anotar_ficha? }` (exatamente um de `etapa_id`/`item_id`).

Validação e posse:
- `data` opcional, formato `YYYY-MM-DD` (mesma checagem do `/sessao/etapa`); default = hoje (America/Sao_Paulo).
- Carregar o plano por `:id`; recusar se `trava_resync` (409 "plano travado") ou status lateral `descartado`/`cancelado` (409 "reative antes"), igual `/sessao/etapa`.
- **Posse:** a etapa/o item precisa pertencer ao plano da URL (`plano_itens.plano_id = :id`); senão 404. Se `soDentista` e o plano é de outro dentista → 403 (mesmo padrão das outras rotas).

Efeito:
- **`etapa_id`:** se já `concluida`/`concluida_retroativa` → `{ ok:true, jaConcluida:true }` (idempotente). Senão `update` → `status='concluida'`, `concluida_em` (da data), `asb_responsavel=req.user.id`, `ficha_anotar=!!anotar_ficha`; **executor (cascata, primeiro não-vazio):** ① `profissional_executor` da própria etapa; ② `profissional_executor` do item (raiz, se a etapa está num sub-lote filho); ③ nome do dentista responsável — `planejamento_dentistas` com `user_id = plano.dentista_avaliador_id` e `ativo=true`, **determinístico**: `.order('profissional_nome').limit(1)` (`user_id` é nullable e não-único na tabela); sem match → deixa null. `tempo_real_min` fica **null** (marcação manual do dentista não mede cadeira; o `/sessao/` continua sendo a fonte de tempo real).
- **`item_id` ("executar todos"):**
  - **Sub-lotes:** após dividir, as etapas pendentes moram nos itens **filhos** (`plano_itens.parent_id = item_id`) — `planCarregarPlano` retorna só raízes com `sublotes` aninhados. O endpoint conclui as etapas pendentes **do item E dos filhos dele** (alvo = `[item_id, ...filhos]`).
  - Conclui **todas as etapas pendentes** dos alvos (mesmo `update` acima, mesma data/`ficha_anotar`, executor herdado do item raiz quando a etapa está sem).
  - Se **nem o item nem os filhos** têm etapa alguma, cria **1 etapa sintética** no próprio item: `descricao = procedure_name` (ou "Procedimento realizado" se vazio), `ordem = 999` (constante — ela só nasce em item sem etapa nenhuma, e `max+1` sobre conjunto vazio recriaria a colisão com o `ordem=0` das pendentes futuras que o PUT reindexa), já `status='concluida'`, com `concluida_em`, `asb_responsavel`, `profissional_executor` (do item/plano), `ficha_anotar`. Assim "executado" continua morando na etapa (fonte única) e o procedimento aparece feito em ③/④/auditoria.
  - **Efeito no re-sync (intencional):** etapa concluída (sintética inclusive) conta como `etapas_executadas` no `aplicarResync` — mudança de quantidade/remoção do item no Clinicorp passa a **travar** o plano para decisão da gestora, em vez de atualizar/regredir silenciosamente. Trabalho executado merece essa proteção.
  - **Idempotente:** se não há pendentes mas já existe etapa concluída → `{ ok:true, jaConcluida:true }` (não cria sintética, não duplica).
- **Avança o plano:** após os updates, recalcula com `avancarPorRegistro(plano.status, statusesDeTodasAsEtapasDoPlano)` — aplicando **2×** quando sobe para `em_andamento` e todas já estão concluídas (aguardando/planejado → em_andamento → concluido), idêntico ao `/sessao/etapa`.

### Anti-duplicação (reuso obrigatório)
A rotina "após concluir etapa(s), reler todas as etapas do plano e avançar o status com `avancarPorRegistro` (até 2×)" é **idêntica** entre `/sessao/etapa` e o novo `executar`. Extrair um helper no server, ex.:

```
async function avancarPlanoAposRegistro(planoId, statusAtual) { /* relê etapas, aplica avancarPorRegistro até 2x, faz o update, retorna status final */ }
```

e chamar dos **dois** endpoints (o `/sessao/etapa` passa a usá-lo no lugar do bloco inline atual). Sem nova cópia da máquina de estados.

## Fixes acoplados (obrigatórios nesta entrega)
1. **`jaRegistrouHoje` não pode ser envenenado pela marcação manual.** Hoje (server.js ~5328) ele retorna `true` para **qualquer** etapa `concluida` com `concluida_em` no dia — uma marcação manual de manhã (tempo_real_min null) faria o registro real da ASB à tarde computar `tempo_real_min = 0`, perdendo o chair time do agendamento para sempre (insumo do planejado×real ③). **Fix:** `jaRegistrouHoje` passa a contar só etapas com `tempo_real_min IS NOT NULL` (e o análogo em `sessao_avulsa` permanece como está — avulsa sempre carrega tempo). Aplicar o mesmo filtro no `ja_registrado_hoje` do `GET /api/sessao/dia`, para a ASB não ser induzida a pular o registro.
2. **Re-sync cego aos sub-lotes filhos.** `syncPlanejamento` monta `etapas_executadas` só com as etapas do item **raiz** (`sync/clinicorp-sync.js` ~1107) — etapas concluídas nos filhos não protegem o item de `remover_item`/`atualizar_quantidade`, e a remoção da raiz esconderia trabalho executado de Trilhas/auditoria/tracker. Buraco pré-existente (alcançável pelo `/sessao/`), mas o "Executar todos" o torna rotineiro. **Fix:** computar `etapas_executadas` considerando também as etapas dos filhos (`parent_id = raiz.id`).

## Segurança / robustez
- `esc()` em toda interpolação de `innerHTML` (options de executor incluídas).
- Sem `.catch()` em builder do Supabase — `try/catch` no `await` (padrão do arquivo).
- Tabela nova? **Não** — só colunas; RLS já está ligada nas tabelas.
- Gancho robô: quando o usuário-robô entrar, ele consulta `plano_etapas WHERE ficha_anotar AND ficha_escrita_em IS NULL`, escreve na ficha do Clinicorp e carimba `ficha_escrita_em`. Fora do escopo desta entrega (login do robô pendente).

## Fora de escopo (confirmado)
- Escrita real na ficha do Clinicorp (usuário-robô, login não capturado). Entregamos só `ficha_anotar` + `ficha_escrita_em`.
- No `/sessao/` da ASB, as únicas mudanças são as declaradas: helper compartilhado de avanço (comportamento idêntico) + filtro `tempo_real_min IS NOT NULL` em `jaRegistrouHoje`/`ja_registrado_hoje` (fix acoplado 1). Nenhuma mudança de UI da ASB.

## Testes
- **Unit (lib já coberta):** `avancarPorRegistro` não muda; cobrir o helper `avancarPlanoAposRegistro` com: 1 etapa concluída em plano `planejado` → `em_andamento`; última etapa → `concluido`; plano `descartado`/`cancelado`/travado → sem efeito.
- **Manual:**
  1. Escolher executor no procedimento → etapas vazias herdam; trocar em 1 etapa não é sobrescrito.
  2. "✓" em uma etapa (data de ontem, "anotar ficha" marcado) → etapa `concluida`, `concluida_em` = ontem, `asb_responsavel` = eu, `ficha_anotar=true`; plano sobe de estado.
  3. "✓ Executar todos" num procedimento **com** etapas → todas concluídas de uma vez.
  4. "✓ Executar todos" num procedimento **sem** etapas → cria etapa sintética concluída; procedimento aparece feito em Trilhas/auditoria.
  5. Reabrir o modal reflete os status; "Salvar rascunho" depois **não apaga** as etapas concluídas (o PUT só recria pendentes). Fluxo sujo: dividir em sub-lotes + digitar etapas + clicar "✓" direto → nada se perde (salvar-antes-de-executar).
  6. CRC no Trilhas clicando executar → 403 amigável.
  7. **Chair time preservado:** marcar "✓" no modal de manhã e a ASB registrar no `/sessao/` à tarde no mesmo dia → o registro da ASB ainda captura a duração do agendamento (`tempo_real_min` > 0), e `/sessao/dia` não mostrou o paciente como já registrado.
  8. Item dividido: etapas dos filhos aparecem read-only no fieldset da raiz com "✓" individual; "Executar todos" conclui raiz+filhos; re-sync com quantidade alterada num item com etapa concluída (inclusive de filho) → trava para a gestora.
