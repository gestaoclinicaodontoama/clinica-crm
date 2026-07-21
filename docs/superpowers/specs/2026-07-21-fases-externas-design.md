# Fases Externas no Planejamento — Design

**Data:** 2026-07-21. Extensão da ① (Modo de Planejamento). Caso motivador (Luiz): antes da cirurgia de protocolo pedimos tomografia e SEMPRE exames de sangue — hoje o plano só tem itens do orçamento Clinicorp; precisa dar pra acrescentar fases que não são serviços da clínica.

## Decisões (Luiz, 21/07)
1. **Tracker:** fase externa aparece pro paciente como qualquer fase (jornada completa; conta no progresso).
2. **Adição:** lista pronta das comuns + campo livre. Lista cresce organicamente: ao digitar livre, checkbox "salvar na lista p/ próxima vez" (padrão do "salvar como padrão"). Remoção/edição do catálogo = fora de escopo v1 (pedir ao Claude).
3. **Permissão:** planejadores (dentista/gestor/admin/mod_planejamento) **+ CRC Sucesso** adicionam/removem fases. Executar/planejar etapas continua só dos planejadores (gates atuais intocados).

## Modelo
Fase externa = **item raiz normal** de `plano_itens` com `tipo='externo'` (price_id null, quantidade 1). Ganha de graça: ordem ▲▼, executor (dropdown, opcional), etapas opcionais, "✓ Executar procedimento" (sintética = "exame entregue"), aparece em Trilhas/Sessão/Tracker/auditoria e conta no progresso e no `temItemSemEtapa` (fase pendente segura a conclusão do plano — correto).

## Dados — 1 migração
```sql
ALTER TABLE public.plano_itens ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'clinicorp'
  CHECK (tipo IN ('clinicorp','externo'));
CREATE TABLE IF NOT EXISTS public.fases_externas_catalogo (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome text NOT NULL UNIQUE,
  ativo boolean NOT NULL DEFAULT true,
  criado_por uuid, criado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.fases_externas_catalogo ENABLE ROW LEVEL SECURITY;  -- sem policy (só service_role via /api)
INSERT INTO public.fases_externas_catalogo (nome) VALUES
  ('Tomografia'), ('Exames de sangue'), ('Avaliação médica / risco cirúrgico')
ON CONFLICT (nome) DO NOTHING;
```
Timestamp depois da última (`20260721021940`); MCP + arquivo casando a version.

## ⚠️ Re-sync (o coração do design)
O sync noturno compara itens do plano × orçamento Clinicorp por `price_id` — um item `externo` (price_id null) seria visto como "removido no Clinicorp" → `remover_item`/`travar` indevido. **Fix obrigatório:** em `sync/clinicorp-sync.js`, ao montar `itensFmt` (hoje ~`filter(i => !i.parent_id)`), **excluir também `i.tipo === 'externo'`** — fases externas são invisíveis pro re-sync (nunca removidas/travadas/contadas por ele). O select correspondente passa a incluir a coluna `tipo`. `etapas_executadas` de filhos (fix anterior) permanece.
Nota: itens legados têm `tipo='clinicorp'` pelo DEFAULT — comportamento atual intacto.

## API — 2 rotas novas (⚠️ ANTES da genérica `POST /plano/:id/:acao`, mesma armadilha de sempre; conferir com grep)
`POST /api/planejamento/plano/:id/fase-externa` — `requireAuth` → `blockParceiro` → `requireRole('crc_sucesso','dentista','gestor','admin','mod_planejamento')` → `rateLimit`.
- Body `{ nome, salvar_lista?: bool }`. `nome` = `sanitizeStr(...,120)`, obrigatório.
- Plano inexistente → 404; lateral (`descartado`/`cancelado`) → 409; `trava_resync` → 409. `soDentista` → 403 se plano de outro dentista (fórmula das irmãs).
- Insere `plano_itens { plano_id, tipo:'externo', price_id:null, procedure_name:nome, quantidade:1, ordem: max(ordem dos raízes)+1 }`.
- `salvar_lista` → upsert em `fases_externas_catalogo` (`ON CONFLICT (nome) DO NOTHING` via select-then-insert; `criado_por=req.user.id`).
- Retorna `{ ok:true, item_id }`.

`POST /api/planejamento/plano/:id/fase-externa/:itemId/remover` — mesmos middlewares/checagens.
- Item precisa: pertencer ao plano, `tipo='externo'`, e **sem etapa não-pendente** (própria; externo não tem sub-lote) → senão 409 "fase com execução registrada — desfazer é com a gestora/Claude". Remove com `DELETE` físico do item (etapas pendentes caem por FK CASCADE) — externo nunca veio do Clinicorp, não precisa de soft-delete de espelho.

`GET /api/planejamento/plano/:id` passa a incluir `fases_catalogo` (nomes ativos, ordenados) no payload — o modal usa no diálogo de adicionar.

## UI (modal Planejar — `editor.js`)
- Botão **"+ fase externa"** no nível do plano (após o `<div id="itens">`), visível sempre que o plano não é lateral — **CRC Sucesso vê e usa** (rota própria autoriza; nada do gate do PUT muda).
- Mini-diálogo: `<select>` com o catálogo + opção "outra…" que revela input livre + checkbox "salvar na lista p/ próxima vez". Confirmar → POST → re-render (o item novo aparece como fieldset normal no fim).
- Fieldset de item `tipo='externo'`: selo "🧪 externa" na legend; **esconder** "dividir em sub-lotes" (não se aplica; `botoesPadrao` já se esconde sozinho por não ter price_id); botão **"× remover fase"** (chama a rota remover; confirm). O resto (executor, + etapa, ✓, ▲▼) funciona como qualquer item. GET precisa mandar `tipo` nos itens (planCarregarPlano usa `select('*')` — já vem).
- **Coletar()/PUT**: nada muda — item externo passa pelo PUT como os demais (ordem/executor/etapas). CRC não salva o PUT (gate atual); a fase adicionada pela CRC já nasce persistida pela rota própria.

## Fora de escopo
- CRUD do catálogo pela gestora (v1: cresce pelo "salvar na lista"; remoção via Claude).
- Fase externa com valor/custo; notificação ao paciente.

## Testes
- **Unit (sync):** `aplicarResync` não recebe externos — testar o filtro no builder de `itensFmt` (caso: plano com 1 item clinicorp + 1 externo; itensNovos só com o clinicorp → NENHUMA ação de remover/travar).
- **Manual:** 1) + fase "Exames de sangue" da lista → aparece no modal/trilhas/tracker/sessão, plano não conclui sem ela; 2) fase livre + salvar na lista → aparece no catálogo na próxima; 3) ✓ Executar procedimento na fase → sintética concluída, tracker mostra "Realizado em…"; 4) remover fase sem execução OK; com execução → 409; 5) CRC Sucesso adiciona e remove; CRC não vê erro 403 ao adicionar; 6) rodar sync manual → fase externa intocada (sem travar/remover); 7) dentista-só não mexe em plano alheio (403).
