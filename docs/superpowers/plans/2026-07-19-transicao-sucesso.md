# Transição do Planejamento — Página da Sucesso — Plano (delta)

> Executar com subagent-driven-development sobre a branch `planejamento` (já contém o Modo de Planejamento ①). Base: 930df34.

**Goal:** rollout manso — backlog na Sucesso (nunca no dentista), página nova, selo conv/particular, inclusão manual, duplicata só sinaliza, `/pacientes/` intocada.

**Spec:** `docs/superpowers/specs/2026-07-19-transicao-sucesso-design.md`.

## Global Constraints
- Nunca `.catch()` no builder do Supabase; `requireAuth` antes de qualquer role; `sanitizeStr`/`esc()` em texto livre; chunk `.in()` ≤200; nada de escrita destrutiva em `pacientes_sucesso`.
- `origem`: `sync_novo` (fila do dentista) | `backlog` (só Sucesso) | `sucesso_manual` (só Sucesso).
- `tipo_pagamento`: particular (`valor_particular==valor`) | convenio (`valor_particular==0`) | misto (`0<valor_particular<valor`).
- Migração remota via MCP (controller); arquivo casando a version.

---

### Task A: Migração delta — colunas em plano_tratamento (controller)
Adicionar: `origem text NOT NULL DEFAULT 'sync_novo' CHECK (origem IN ('sync_novo','backlog','sucesso_manual'))`, `tipo_pagamento text CHECK (tipo_pagamento IN ('particular','convenio','misto'))`, `descricao_manual text`. Índice em `origem`. Aplicar remoto, escrever arquivo casando a version, verificar colunas.

---

### Task B: lib — `tipoPagamento(orc)` (TDD)
**Files:** add to `lib/planejamento/triagem.js` + test.
- `tipoPagamento({ valor, valor_particular })` → 'convenio' se valor_particular<=0; 'particular' se valor_particular>=valor; senão 'misto'. Guardas p/ null/0.
- Testes: particular puro, convênio puro (valor_particular 0), misto, valor null → null.
- Exportar. Manter as funções existentes intactas.

---

### Task C: sync delta — origem + tipo_pagamento + backfill backlog
**Files:** `sync/clinicorp-sync.js`, `scripts/backfill-planejamento.js`.
- Em `syncPlanejamento`, na criação de plano: `origem: 'sync_novo'`, `tipo_pagamento: tipoPagamento(o)`.
- No re-sync (executarAcoesResync value-mirror e/ou no loop de re-sync): atualizar `tipo_pagamento` junto do espelho de valor/entrada.
- `adicionar_item`/demais: sem mudança de origem.
- No `backfill-planejamento.js`: após rodar `syncPlanejamento()`, dar um UPDATE `plano_tratamento SET origem='backlog' WHERE origem='sync_novo' AND criado_em < now()` — não, mais preciso: marcar como backlog TODOS os planos que existem nesse 1º passe (o backfill roda uma vez, antes do 1º nightly). Implementação: capturar o conjunto de estimate_ids ANTES e marcar backlog os criados agora. Mais simples e robusto: o backfill roda `UPDATE plano_tratamento SET origem='backlog' WHERE origem='sync_novo'` como ÚLTIMO passo (tudo que existe no 1º passe é histórico). Documentar que isso PRECISA rodar antes do primeiro nightly (senão novos legítimos viram backlog). Logar a contagem.
- Testar: `node --check`, `require()` carrega, `npm test` baseline.

---

### Task D: API delta
**Files:** `server.js` (bloco /api/planejamento/*).
1. Fila `aba=planejar`: adicionar `.eq('origem','sync_novo')`.
2. Nova `aba=sucesso`: sem filtro de origem (todos), mas exclui `cancelado`; JOIN/anexo dos dados do paciente (nome, telefone, valor, entrada via plano espelho) + `tipo_pagamento` + `origem` + `plano_status`. Roles: liberar `crc_sucesso` (novo middleware `requirePlanejamentoOuSucesso = requireRole('dentista','gestor','admin','mod_planejamento','crc_comercial','crc_sucesso')` para a rota da fila; internamente, `aba=sucesso` exige um de crc_sucesso/gestor/admin/mod_planejamento/crc_comercial).
3. Veredito duplicata/nao_venda: **remover** o `pacientes_sucesso.update({excluido_em})`. Manter o set de status cancelado no PLANO + flag; NÃO tocar pacientes_sucesso. (Idem no cutover do `rejeitar` da conferência e no `executarAcoesResync` cancelar: parar de mexer em pacientes_sucesso — só marca o plano.) ⚠️ preservar o resto da lógica.
4. `GET /api/planejamento/buscar-paciente?q=`: busca em `pacientes` (nome ilike / telefone) → p/ cada paciente, seus `orcamentos` (clinicorp_estimate_id, procedure list resumida, valor, valor_particular, eh_convenio → selo via tipoPagamento). Roles requirePlanejamentoOuSucesso. sanitizeStr no q.
5. `POST /api/planejamento/incluir-manual` body `{ paciente_clinicorp_id, paciente_nome, telefone?, estimate_id?, descricao_manual?, tipo_pagamento? }`: dedup — se já existe plano do estimate_id, 409. Cria `pacientes_sucesso` (INSERT dedup por estimate_id se houver; senão insert por nome/telefone com clinicorp_estimate_id null) SEM sobrescrever existente; cria `plano_tratamento` `origem='sucesso_manual'`, `status='aguardando_planejamento'`, `tipo_pagamento`, `descricao_manual`. Roles crc_sucesso/gestor/admin/mod_planejamento.
6. `GET /api/pacientes` listing: anexar `tipo_pagamento` junto do `plano_status` já existente (mesmo laço chunked).

---

### Task E: reverter badge da Task 9 em /pacientes/ + selo no dentista e suspeitas
**Files:** `public/index.html` (ou onde a Task 9 pôs o badge `⏳ sem trilha` na lista de Pacientes) — REMOVER esse badge (página intocada; o dado fica só na API). `public/js/planejamento/app.js` — adicionar o selo `tipo_pagamento` (Particular/Convênio/Misto) no card da fila e na aba suspeitas.
- Confirmar via git o que a Task 9 tocou em `/pacientes/` UI e reverter só isso (não o server/lib/auditoria).

---

### Task F: página nova `/trilhas/` (Sucesso)
**Files:** `public/trilhas/index.html`, `public/js/trilhas/app.js`, nav em `nav-config.js` (seção CRC Sucesso: `{ slug:'trilhas', label:'Trilhas de Tratamento', roles:'crc_sucesso,crc_comercial,gestor,mod_planejamento', mode:'link', href:'/trilhas/' }`), registro Usuários se novo mod (reusa mod_planejamento).
- Shell copiado da página irmã (registro/index.html), esc() em tudo.
- Consome `GET /api/planejamento/fila?aba=sucesso`: lista com colunas paciente/contato/venda/planejamento + selo + filtros (todos/sem planejamento/em tratamento/protocolos).
- Abrir linha → drawer com a trilha (itens+etapas via `GET /api/planejamento/plano/:id`) + recado_sucesso + próximo passo.
- Botão "Planejar" → reusa o editor de plano (mesma tela/modal do /planejamento/ app; extrair p/ um js compartilhado OU replicar o modal). Simplest: importar o mesmo comportamento; se custoso, o botão abre `/planejamento/?plano=:id`.
- Botão "+ Adicionar paciente" → busca (`buscar-paciente`) → escolhe orçamento (mostra selo) OU descreve à mão → `POST incluir-manual` → recarrega.
- Referência visual: artifact df6600a0 (a tela da Sucesso).

---

## Ordem / execução
A (migração) → B (lib TDD) → C (sync) → D (API) → E (revert+selo) → F (página). Review por task; review final da branch; então merge+deploy+backfill ESPERAM o go do Luiz.
