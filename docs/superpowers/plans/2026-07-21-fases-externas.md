# Fases Externas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkboxes por step.

**Goal:** Fases que não são serviços Clinicorp (tomografia, exames) como itens `tipo='externo'` do plano — adicionáveis por CRC+planejadores, invisíveis ao re-sync, visíveis em modal/trilhas/sessão/tracker, segurando a conclusão do plano.

**Spec (fonte da verdade, ler antes de cada task):** `docs/superpowers/specs/2026-07-21-fases-externas-design.md`

## Global Constraints
- Worktree `clinica-crm/.claude/worktrees/planejamento`. NUNCA `.catch()` em builder. Rotas: `requireAuth`→`blockParceiro`→role→`rateLimit`. `esc()` em innerHTML. `npm test` baseline **496/500** (4 falhas pré-existentes lib/monitor+lib/nfse).
- ⚠️ Rota `POST /plano/:id/fase-externa` ANTES da genérica `/plano/:id/:acao` (~5362; mesma aridade — seria engolida). A rota `.../fase-externa/:itemId/remover` tem aridade diferente (não conflita), mas registrar junto.
- Migração: MCP `apply_migration` → renomear arquivo local p/ casar a version do `list_migrations`.

### Task 1 (controller): Migração
SQL da spec (§Dados): coluna `plano_itens.tipo` (default 'clinicorp', CHECK) + tabela `fases_externas_catalogo` (RLS on sem policy) + 3 seeds. Verificar colunas/seeds via `execute_sql`; arquivo `.sql` casando version; commit `feat(planejamento): migração fases externas (plano_itens.tipo + catálogo seedado)`.

### Task 2: Sync — externo invisível ao re-sync (unit test primeiro)
**Files:** `sync/clinicorp-sync.js` (~1107-1121), `lib/planejamento/estados.test.js`.
- Teste (append): monta `itensFmt` como o sync fará e roda `aplicarResync` — plano com 1 item clinicorp (price_id '10') + nada de externo no fmt; `itensNovos` só com o '10' → `acoes` vazio. (O filtro em si é no sync; o teste documenta o contrato: externo NUNCA entra em itensPlano.)
```js
test('resync: fase externa fora do itensFmt não gera remover/travar', () => {
  const { acoes } = aplicarResync({ plano: { status: 'em_andamento', trava_resync: null },
    itensPlano: [{ price_id: '10', quantidade: 1, etapas_executadas: false }],   // externo já filtrado fora
    itensNovos: [{ price_id: '10', quantidade: 1, procedure_name: 'X' }], statusClinicorp: 'APPROVED' });
  assert.equal(acoes.length, 0);
});
```
- Sync: no select do re-sync (~1107) adicionar `tipo`: `select('id, parent_id, tipo, price_id, quantidade, removido_em, plano_etapas(status)')`; no builder de `itensFmt`, o filtro de raízes vira `.filter(i => !i.parent_id && i.tipo !== 'externo')`. **Só isso** — `filhosPor`/`temExec` intocados.
- `node --check sync/clinicorp-sync.js` + `npm test` (497/501). Commit `fix(sync): fases externas invisíveis ao re-sync (tipo=externo fora do itensFmt)`.

### Task 3: Server — rotas fase-externa (add/remover) + `pode_planejar` no GET
**Files:** `server.js`.
- **GET /plano/:id** (~5130-5145): calcular e incluir no json: `fases_catalogo` (nomes com `ativo=true`, `.order('nome')`) e `pode_planejar: roles.some(r => ['dentista','gestor','admin','mod_planejamento'].includes(r))` (roles = `req.user.profile?.roles || []`).
- **Rota ADD** — colar IMEDIATAMENTE ANTES da genérica `/:acao`:
```js
// Fase externa (tomografia/exames — não é serviço Clinicorp): item tipo='externo', invisível ao re-sync.
// ANTES da genérica /:acao (mesma aridade). CRC Sucesso PODE adicionar (rota própria; PUT/executar seguem sem ela).
app.post('/api/planejamento/plano/:id/fase-externa', requireAuth, blockParceiro,
  requireRole('crc_sucesso', 'dentista', 'gestor', 'admin', 'mod_planejamento'), rateLimit, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const nome = sanitizeStr((req.body && req.body.nome) || '', 120).trim();
    if (!nome) return res.status(400).json({ error: 'nome é obrigatório' });
    const { data: plano } = await supabase.from('plano_tratamento')
      .select('id, status, trava_resync, dentista_avaliador_id').eq('id', id).maybeSingle();
    if (!plano) return res.status(404).json({ error: 'plano não encontrado' });
    if (plano.trava_resync) return res.status(409).json({ error: 'plano travado — a gestora precisa resolver antes' });
    if (['descartado', 'cancelado'].includes(plano.status)) return res.status(409).json({ error: `plano ${plano.status} — reative antes` });
    if (plano.status === 'concluido') return res.status(409).json({ error: 'plano concluído — adicionar fase reabriria o tratamento; fale com a gestora' });
    const roles = req.user.profile?.roles || [];
    const soDentista = roles.includes('dentista') && !roles.some(rl => ['gestor', 'admin', 'mod_planejamento'].includes(rl));
    if (soDentista && plano.dentista_avaliador_id !== req.user.id) return res.status(403).json({ error: 'plano de outro dentista' });
    const { data: raizes } = await supabase.from('plano_itens').select('ordem').eq('plano_id', id).is('parent_id', null).is('removido_em', null);
    const ordem = (raizes || []).reduce((m, r) => Math.max(m, Number(r.ordem) || 0), 0) + 1;
    const { data: novo, error } = await supabase.from('plano_itens').insert({
      plano_id: id, tipo: 'externo', price_id: null, procedure_name: nome, quantidade: 1, ordem }).select('id').single();
    if (error) throw error;
    if (req.body.salvar_lista) {   // best-effort: NUNCA derruba a criação do item
      try { await supabase.from('fases_externas_catalogo').upsert({ nome, criado_por: req.user.id }, { onConflict: 'nome', ignoreDuplicates: true }); }
      catch (eCat) { console.error('[fase-externa catálogo]', eCat.message); }
    }
    const plano_status = await avancarPlanoAposRegistro(id, plano.status);   // reavaliar SEMPRE
    res.json({ ok: true, item_id: novo.id, plano_status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/planejamento/plano/:id/fase-externa/:itemId/remover', requireAuth, blockParceiro,
  requireRole('crc_sucesso', 'dentista', 'gestor', 'admin', 'mod_planejamento'), rateLimit, async (req, res) => {
  try {
    const id = Number(req.params.id), itemId = Number(req.params.itemId);
    const { data: plano } = await supabase.from('plano_tratamento')
      .select('id, status, trava_resync, dentista_avaliador_id').eq('id', id).maybeSingle();
    if (!plano) return res.status(404).json({ error: 'plano não encontrado' });
    if (plano.trava_resync) return res.status(409).json({ error: 'plano travado — a gestora precisa resolver antes' });
    const roles = req.user.profile?.roles || [];
    const soDentista = roles.includes('dentista') && !roles.some(rl => ['gestor', 'admin', 'mod_planejamento'].includes(rl));
    if (soDentista && plano.dentista_avaliador_id !== req.user.id) return res.status(403).json({ error: 'plano de outro dentista' });
    const { data: item } = await supabase.from('plano_itens').select('id, tipo').eq('id', itemId).eq('plano_id', id).maybeSingle();
    if (!item || item.tipo !== 'externo') return res.status(404).json({ error: 'fase externa não encontrada neste plano' });
    const { data: exec } = await supabase.from('plano_etapas').select('id').eq('item_id', itemId).neq('status', 'pendente').limit(1);
    if (exec?.length) return res.status(409).json({ error: 'fase com execução registrada — desfazer é com a gestora' });
    const { error } = await supabase.from('plano_itens').delete().eq('id', itemId);   // pendentes caem por FK CASCADE
    if (error) throw error;
    const plano_status = await avancarPlanoAposRegistro(id, plano.status);   // CRÍTICO: pode CONCLUIR o plano agora
    res.json({ ok: true, plano_status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
```
- Verificar: `node --check`, `npm test`, `grep -n "fase-externa\|plano/:id/:acao'" server.js` (add antes da genérica). Commit `feat(planejamento): rotas fase-externa add/remover (CRC incluída, reavalia status, catálogo best-effort)`.

### Task 4: UI editor.js — "+ fase externa", selo, remover, pode_planejar
**Files:** `public/js/planejamento/editor.js`.
- Destructure do GET ganha `fases_catalogo, pode_planejar` (default `pode_planejar !== false` p/ cache velho).
- `const planejador = pode_planejar !== false;` — quando `false`: esconder `bt-salvar`/`bt-concluir`/`bt-descartar` (footer), `add-etapa`, `dividir`, botões de padrão, `✓`(et-exec/et-exec-filho/exec-todos) — condicionar os templates com `${planejador ? ... : ''}` (o `podeExecutar` vira `podeExecutar && planejador`). Mantém: `+ fase externa`, `× remover fase`, `bt-tracker`, `bt-fechar` (regenerar/revogar continuam — 403 amigável).
- Fieldset externo (`item.tipo === 'externo'`): selo `🧪 externa` na legend; **NÃO renderizar** o botão `.dividir` (hardcoded — condicionar `${item.tipo !== 'externo' && planejador ? '<button class="dividir">dividir em sub-lotes</button>' : ''}`; nos demais itens também ganha o gate `planejador`); botão `<button class="rm-fase">× remover fase</button>` no rodapé do fieldset.
- Botão global após `</div>` de `#itens`: `${!['descartado','cancelado','concluido'].includes(plano.status) ? '<button id="bt-add-fase" class="btn btn-ghost">+ fase externa</button>' : ''}`.
- Diálogo add (padrão do miniDialogoExec): select do catálogo + "outra…" revela input + checkbox salvar; confirm → `POST fase-externa` → `reabrir()`. Handler `rm-fase`: confirm → `POST .../remover` → `reabrir()` (+`onSaved?.()` nos dois — status pode ter mudado). try/catch local com `alert(e.message)`.
- `node --check`. Commit `feat(planejamento): + fase externa no modal (catálogo+livre+salvar), selo/remover, modal enxuto p/ CRC (pode_planejar)`.

### Task 5 (controller): Deploy + smoke
`npm test` + `node --check` ×3 → fetch/FF → push CredRead (memória feedback_git_push_headless) → deploy Easypanel → swap por conteúdo (`curl editor.js | grep bt-add-fase`) → smoke 401 na rota nova → ledger + memória + repassar os 8 testes manuais da spec ao Luiz.

## Self-Review
Cobertura: migração/catálogo (T1) · resync invisível+teste (T2) · rotas com todas as guardas da spec + avancar + catálogo atômico best-effort + pode_planejar/fases_catalogo no GET (T3) · UI completa incl. esconder dividir explícito e modal-CRC (T4) · deploy (T5). Nomes consistentes: `fase-externa`/`remover`, `fases_catalogo`, `pode_planejar`, `rm-fase`, `bt-add-fase`. Sem placeholders.
