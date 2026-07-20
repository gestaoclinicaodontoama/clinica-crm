# Executor por Procedimento + Marcar Executado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No modal "Planejar" (Trilhas/Planejamento): dropdown de executor por procedimento (herda p/ etapas) + botões "✓" por etapa e "✓ Executar todos" por procedimento, com data + intenção "anotar na ficha" (gancho do robô Clinicorp).

**Architecture:** "Executado" mora sempre em `plano_etapas` (fonte única de auditoria/③/④). Novo endpoint `executar` reusa a máquina de estados via helper compartilhado com `/sessao/etapa`. UI usa salvar-antes-de-executar com resolução de id por (item, índice-entre-pendentes), porque o PUT recria as pendentes com ids novos.

**Tech Stack:** Node/Express (`server.js`), vanilla JS (`public/js/planejamento/editor.js`), Supabase (migração via MCP, project `mtqdpjhhqzvuklnlfpvi`), `node --test` para a lib.

**Spec:** `docs/superpowers/specs/2026-07-20-executor-e-execucao-planejamento-design.md` — ler antes de cada task.

## Global Constraints

- Worktree: `clinica-crm/.claude/worktrees/planejamento` (branch `planejamento`). Commitar lá.
- NUNCA `.catch()` em builder do Supabase — `try/catch` no `await`.
- Toda rota: `requireAuth` → `blockParceiro` → role → `rateLimit`.
- `esc()` em TUDO que interpola em `innerHTML`.
- Migração: timestamp **depois de `20260720180000`**; aplicar via MCP `apply_migration` e conferir `list_migrations`; arquivo `.sql` no repo casando a version.
- Testes: `npm test` (= `node --test "lib/**/*.test.js"`), rodar do root do worktree.
- Sanitização de strings do body: `sanitizeStr(valor, max)` (helper existente no server.js).
- Front: vanilla, sem libs novas.

---

### Task 1: Migração — colunas novas

**Files:**
- Create: `supabase/migrations/20260720190000_executor_execucao_planejamento.sql`

**Interfaces:**
- Produces: colunas `plano_itens.profissional_executor text`, `plano_etapas.ficha_anotar boolean NOT NULL DEFAULT false`, `plano_etapas.ficha_escrita_em timestamptz` — usadas pelas Tasks 4-6.

- [ ] **Step 1: Escrever o arquivo da migração**

```sql
-- Executor por procedimento + gancho "anotar na ficha" (robô Clinicorp futuro).
-- Sem tabela nova: RLS já ligada em plano_itens/plano_etapas (migração 20260719042125).
ALTER TABLE public.plano_itens  ADD COLUMN IF NOT EXISTS profissional_executor text;
ALTER TABLE public.plano_etapas ADD COLUMN IF NOT EXISTS ficha_anotar boolean NOT NULL DEFAULT false;
ALTER TABLE public.plano_etapas ADD COLUMN IF NOT EXISTS ficha_escrita_em timestamptz;
```

- [ ] **Step 2: Aplicar no remoto via MCP Supabase**

`mcp__plugin_supabase_supabase__apply_migration` com `name: "executor_execucao_planejamento"` e a query acima (o MCP gera a version; se a version gerada ≠ `20260720190000`, **renomear o arquivo local** para casar com a version que o `list_migrations` mostrar).

- [ ] **Step 3: Verificar**

`mcp__plugin_supabase_supabase__list_migrations` → a migração aparece após `20260720180000`. Depois `execute_sql`: `SELECT column_name FROM information_schema.columns WHERE table_name IN ('plano_itens','plano_etapas') AND column_name IN ('profissional_executor','ficha_anotar','ficha_escrita_em');` → 4 linhas (profissional_executor existe nas duas tabelas… atenção: em `plano_etapas` ela JÁ existia; esperado ver as 3 novas + a antiga).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/*executor_execucao*.sql
git commit -m "feat(planejamento): migração executor por item + gancho ficha (ficha_anotar/ficha_escrita_em)"
```

---

### Task 2: Lib — `statusAposRegistro` (parte pura do helper de avanço)

**Files:**
- Modify: `lib/planejamento/estados.js` (após `avancarPorRegistro`, ~linha 76)
- Test: `lib/planejamento/estados.test.js`

**Interfaces:**
- Consumes: `avancarPorRegistro(statusAtual, etapasStatus)` (existente no mesmo arquivo).
- Produces: `statusAposRegistro(statusAtual, etapasStatus) -> string` — SEMPRE retorna o status final (o próprio `statusAtual` se nada muda). Usada pela Task 3 no server. Exportar no `module.exports`.

- [ ] **Step 1: Escrever os testes que falham** (append em `estados.test.js`)

```js
test('statusAposRegistro: todas concluídas em planejado/aguardando → concluido (2 degraus numa chamada)', () => {
  assert.equal(statusAposRegistro('planejado', ['concluida']), 'concluido');
  assert.equal(statusAposRegistro('aguardando_planejamento', ['concluida', 'concluida_retroativa']), 'concluido');
});
test('statusAposRegistro: resta pendente → sobe 1 degrau só', () => {
  assert.equal(statusAposRegistro('planejado', ['concluida', 'pendente']), 'em_andamento');
});
test('statusAposRegistro: em_andamento com pendente → inalterado', () => {
  assert.equal(statusAposRegistro('em_andamento', ['concluida', 'pendente']), 'em_andamento');
});
test('statusAposRegistro: concluido/laterais → inalterado', () => {
  assert.equal(statusAposRegistro('concluido', ['concluida']), 'concluido');
  assert.equal(statusAposRegistro('descartado', ['concluida']), 'descartado');
  assert.equal(statusAposRegistro('cancelado', ['concluida']), 'cancelado');
});
```

E incluir `statusAposRegistro` no `require('./estados')` do topo do test.

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test` — Expected: FAIL (`statusAposRegistro is not a function`).

- [ ] **Step 3: Implementar em `estados.js`**

```js
/**
 * Status final do plano após um registro (aplica avancarPorRegistro até 2 degraus:
 * aguardando/planejado → em_andamento → concluido na mesma chamada). Sempre retorna
 * um status (o próprio statusAtual quando nada muda) — o chamador compara p/ decidir o update.
 */
function statusAposRegistro(statusAtual, etapasStatus) {
  let s = statusAtual;
  const n1 = avancarPorRegistro(s, etapasStatus);
  if (n1) {
    s = n1;
    const n2 = avancarPorRegistro(s, etapasStatus);
    if (n2) s = n2;
  }
  return s;
}
```

E adicionar ao `module.exports`.

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test` — Expected: PASS (todos, incluindo os antigos).

- [ ] **Step 5: Commit**

```bash
git add lib/planejamento/estados.js lib/planejamento/estados.test.js
git commit -m "feat(planejamento): statusAposRegistro — avanço de até 2 degraus numa chamada (lib pura, testada)"
```

---

### Task 3: Server — helper `avancarPlanoAposRegistro` + refactor do `/sessao/etapa`

**Files:**
- Modify: `server.js` — require na ~linha 4998; novo helper perto de `jaRegistrouHoje` (~5342); `/api/sessao/etapa` ~5484-5504.

**Interfaces:**
- Consumes: `statusAposRegistro` da Task 2.
- Produces: `async function avancarPlanoAposRegistro(planoId, statusAtual) -> string` (status final; faz o UPDATE em `plano_tratamento` quando muda). Usada pela Task 4.

- [ ] **Step 1: Atualizar o require (~linha 4998)**

```js
const { transicaoValida: planTransicao, validarSubLotes: planValidarSubLotes, avancarPorRegistro, statusAposRegistro: planStatusAposRegistro } = require('./lib/planejamento/estados');
```

- [ ] **Step 2: Adicionar o helper (logo após `jaRegistrouHoje`, ~linha 5342)**

```js
// Relê TODAS as etapas do plano e avança o status pela máquina (até 2 degraus). Retorna o status final.
// Compartilhado por /api/sessao/etapa e /api/planejamento/plano/:id/executar — sem cópia da máquina de estados.
async function avancarPlanoAposRegistro(planoId, statusAtual) {
  const { data: todas, error } = await supabase.from('plano_etapas')
    .select('status, plano_itens!inner(plano_id)').eq('plano_itens.plano_id', planoId);
  if (error) throw error;
  const final = planStatusAposRegistro(statusAtual, (todas || []).map(e => e.status));
  if (final !== statusAtual) {
    const { error: eUp } = await supabase.from('plano_tratamento')
      .update({ status: final, atualizado_em: new Date().toISOString() }).eq('id', planoId);
    if (eUp) throw eUp;
  }
  return final;
}
```

- [ ] **Step 3: Refatorar `/api/sessao/etapa`**

Substituir o bloco das linhas ~5484-5504 (do comentário "// avança o plano com o status ATUAL..." até o `res.json`) por:

```js
    const planoStatusFinal = await avancarPlanoAposRegistro(planoId, plano.status);
    res.json({ ok: true, plano_status: planoStatusFinal });
```

(Comportamento idêntico: o helper faz 1 UPDATE direto ao status final em vez de 2 UPDATEs encadeados — o resultado observável é o mesmo `plano_status`.)

- [ ] **Step 4: Verificar sintaxe + testes**

Run: `node --check server.js` → sem saída. `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "refactor(sessao): avanço do plano extraído p/ avancarPlanoAposRegistro (compartilhado com o executar do modal)"
```

---

### Task 4: Server — fixes acoplados + endpoint `executar` + PUT grava executor do item

**Files:**
- Modify: `server.js` — `jaRegistrouHoje` ~5335-5339; `/api/sessao/dia` ~5383-5385; PUT `/api/planejamento/plano/:id` ~5175; nova rota ANTES de `/api/planejamento/plano/:id/:acao` (~5216).
- Modify: `sync/clinicorp-sync.js` ~1107-1113.

**Interfaces:**
- Consumes: `avancarPlanoAposRegistro` (Task 3); colunas da Task 1.
- Produces: `POST /api/planejamento/plano/:id/executar` body `{ etapa_id? | item_id?, data?, anotar_ficha? }` → `{ ok, plano_status }` ou `{ ok, jaConcluida:true, plano_status }`. Usada pela Task 5 (UI).

- [ ] **Step 1: Fix acoplado 1a — `jaRegistrouHoje` só conta etapa com tempo real**

No select de `plano_etapas` dentro de `jaRegistrouHoje` (~5335), trocar por:

```js
    const { data: etapas, error: eEt } = await supabase.from('plano_etapas')
      .select('concluida_em, plano_itens!inner(plano_id)')
      .eq('plano_itens.plano_id', planoId).in('status', ['concluida', 'concluida_retroativa'])
      .not('tempo_real_min', 'is', null);   // marcação manual (tempo null) não consome o chair time do dia
```

- [ ] **Step 2: Fix acoplado 1b — `/api/sessao/dia` idem**

No loop `planosConcluidosHoje` (~5383), adicionar o mesmo filtro à query:

```js
      const { data: etapas, error: eEt } = await supabase.from('plano_etapas')
        .select('concluida_em, plano_itens!inner(plano_id)')
        .in('plano_itens.plano_id', chunk).in('status', ['concluida', 'concluida_retroativa'])
        .not('tempo_real_min', 'is', null);   // manual não marca o dia como registrado p/ a ASB
```

- [ ] **Step 3: Fix acoplado 2 — re-sync enxerga etapas dos filhos**

Em `sync/clinicorp-sync.js` (~1107), substituir a query + `itensFmt` por:

```js
    const { data: itensPlano } = await supabase.from('plano_itens')
      .select('id, parent_id, price_id, quantidade, removido_em, plano_etapas(status)')
      .eq('plano_id', plano.id).is('removido_em', null);
    const filhosPor = new Map();
    for (const i of (itensPlano || [])) {
      if (!i.parent_id) continue;
      if (!filhosPor.has(i.parent_id)) filhosPor.set(i.parent_id, []);
      filhosPor.get(i.parent_id).push(i);
    }
    const temExec = i => (i.plano_etapas || []).some(e => e.status !== 'pendente');
    const itensFmt = (itensPlano || []).filter(i => !i.parent_id).map(i => ({
      price_id: i.price_id, quantidade: i.quantidade,
      // etapas moram nas FOLHAS: item dividido tem execução nos filhos — protege a raiz do resync
      etapas_executadas: temExec(i) || (filhosPor.get(i.id) || []).some(temExec),
    }));
```

- [ ] **Step 4: PUT grava `profissional_executor` do item**

No PUT `/api/planejamento/plano/:id` (~5175), trocar o update de ordem do item por:

```js
      await supabase.from('plano_itens').update({
        ordem: idxItem,
        // condicional ('x' in item, padrão do próprio PUT ~5158-5160): editor antigo em cache não manda
        // o campo — gravar incondicional apagaria executores já preenchidos a cada Salvar.
        ...('profissional_executor' in item
          ? { profissional_executor: sanitizeStr(item.profissional_executor || '', 120) || null } : {}),
      }).eq('id', item.id).eq('plano_id', id);
```

- [ ] **Step 5: Nova rota `executar` — colar IMEDIATAMENTE ANTES de `app.post('/api/planejamento/plano/:id/:acao', ...)` (~5216)**

⚠️ A ordem importa: a genérica `/:acao` engoliria `/executar` com gate errado.

```js
// Marcar executado direto no modal de planejamento (uma etapa OU "executar todos" de um item).
// "Executado" mora na etapa (fonte única de auditoria/planejado×real/tracker) — sem estado paralelo no item.
// ⚠️ registrada ANTES da rota genérica /plano/:id/:acao (Express casa na ordem; a genérica daria 400 c/ gate errado).
app.post('/api/planejamento/plano/:id/executar', requireAuth, blockParceiro, requirePlanejamento, rateLimit, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const etapaId = b.etapa_id ? Number(b.etapa_id) : null;
    const itemId = b.item_id ? Number(b.item_id) : null;
    if ((etapaId ? 1 : 0) + (itemId ? 1 : 0) !== 1) return res.status(400).json({ error: 'informe exatamente um de etapa_id/item_id' });
    const dataStr = b.data ? String(b.data).slice(0, 10) : null;
    if (dataStr && !/^\d{4}-\d{2}-\d{2}$/.test(dataStr)) return res.status(400).json({ error: 'data inválida (YYYY-MM-DD)' });

    const { data: plano } = await supabase.from('plano_tratamento')
      .select('id, status, trava_resync, dentista_avaliador_id').eq('id', id).maybeSingle();
    if (!plano) return res.status(404).json({ error: 'plano não encontrado' });
    const roles = req.user.profile?.roles || [];
    const soDentista = roles.includes('dentista') && !roles.some(rl => ['gestor', 'admin', 'mod_planejamento'].includes(rl));
    if (soDentista && plano.dentista_avaliador_id !== req.user.id) return res.status(403).json({ error: 'plano de outro dentista' });
    if (plano.trava_resync) return res.status(409).json({ error: 'plano travado — a gestora precisa resolver antes de registrar' });
    if (['descartado', 'cancelado'].includes(plano.status)) return res.status(409).json({ error: `plano ${plano.status} — reative antes de registrar` });

    const concluidaEm = dataStr ? `${dataStr}T12:00:00-03:00` : new Date().toISOString();
    // tempo_real_min NÃO é gravado (fica null): marcação manual não mede cadeira — /sessao/ é a fonte de tempo real.
    const patchBase = { status: 'concluida', concluida_em: concluidaEm, asb_responsavel: req.user.id, ficha_anotar: !!b.anotar_ficha };

    // cascata do executor (primeiro não-vazio): etapa → item raiz → dentista responsável (determinístico) → null
    async function executorFallback(itemRaiz) {
      if (itemRaiz?.profissional_executor) return itemRaiz.profissional_executor;
      if (!plano.dentista_avaliador_id) return null;
      const { data: dd } = await supabase.from('planejamento_dentistas').select('profissional_nome')
        .eq('user_id', plano.dentista_avaliador_id).eq('ativo', true).order('profissional_nome').limit(1);
      return dd?.[0]?.profissional_nome || null;
    }

    if (etapaId) {
      const { data: etapa, error: eEt } = await supabase.from('plano_etapas')
        .select('id, status, profissional_executor, plano_itens!inner(id, plano_id, parent_id, profissional_executor)')
        .eq('id', etapaId).eq('plano_itens.plano_id', id).maybeSingle();
      if (eEt) throw eEt;
      if (!etapa) return res.status(404).json({ error: 'etapa não encontrada neste plano' });
      if (['concluida', 'concluida_retroativa'].includes(etapa.status)) return res.json({ ok: true, jaConcluida: true, plano_status: plano.status });
      let raiz = etapa.plano_itens;
      if (raiz.parent_id) {                                    // etapa de sub-lote herda executor do item RAIZ
        const { data: pai } = await supabase.from('plano_itens').select('id, profissional_executor').eq('id', raiz.parent_id).maybeSingle();
        if (pai) raiz = pai;
      }
      const executor = etapa.profissional_executor || await executorFallback(raiz);
      const { error: eUp } = await supabase.from('plano_etapas')
        .update({ ...patchBase, profissional_executor: executor }).eq('id', etapaId);
      if (eUp) throw eUp;
    } else {
      const { data: raiz } = await supabase.from('plano_itens')
        .select('id, procedure_name, profissional_executor').eq('id', itemId).eq('plano_id', id).is('removido_em', null).maybeSingle();
      if (!raiz) return res.status(404).json({ error: 'item não encontrado neste plano' });
      const { data: filhos } = await supabase.from('plano_itens').select('id').eq('parent_id', raiz.id).is('removido_em', null);
      const alvos = [raiz.id, ...(filhos || []).map(f => f.id)];   // etapas moram nas folhas: raiz + sub-lotes
      const { data: etapas, error: eEts } = await supabase.from('plano_etapas').select('id, status, profissional_executor').in('item_id', alvos);
      if (eEts) throw eEts;
      const pendentes = (etapas || []).filter(e => e.status === 'pendente');
      if (!pendentes.length) {
        if ((etapas || []).length) return res.json({ ok: true, jaConcluida: true, plano_status: plano.status });   // idempotente
        // item (e filhos) sem etapa nenhuma → 1 etapa sintética já concluída.
        // ordem=999: constante — max+1 sobre conjunto vazio recriaria colisão com o reindex 0..n do PUT.
        const executor = await executorFallback(raiz);
        const { error: eIns } = await supabase.from('plano_etapas').insert({
          item_id: raiz.id, ordem: 999, descricao: raiz.procedure_name || 'Procedimento realizado',
          profissional_executor: executor, ...patchBase });
        if (eIns) throw eIns;
      } else {
        const executorItem = await executorFallback(raiz);
        for (const p of pendentes) {
          const { error: eUp } = await supabase.from('plano_etapas')
            .update({ ...patchBase, profissional_executor: p.profissional_executor || executorItem }).eq('id', p.id);
          if (eUp) throw eUp;
        }
      }
    }

    const plano_status = await avancarPlanoAposRegistro(id, plano.status);
    res.json({ ok: true, plano_status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
```

- [ ] **Step 6: Verificar**

Run: `node --check server.js` e `node --check sync/clinicorp-sync.js` → sem saída. `npm test` → PASS.
Conferir a ordem: `grep -n "plano/:id/executar\|plano/:id/:acao" server.js` → a linha de `executar` vem ANTES da `:acao`.

- [ ] **Step 7: Commit**

```bash
git add server.js sync/clinicorp-sync.js
git commit -m "feat(planejamento): endpoint executar (etapa/todos, sintética, gancho ficha) + fixes: jaRegistrouHoje ignora manual, resync enxerga filhos, PUT grava executor do item"
```

---

### Task 5: UI — editor.js (dropdown executor, herança, ✓/Executar todos, mini-diálogo, resolução de id)

**Files:**
- Modify: `public/js/planejamento/editor.js` (arquivo inteiro tem 164 linhas — ler antes)

**Interfaces:**
- Consumes: `GET /api/planejamento/plano/:id` (retorna `{plano, itens (raízes com sublotes[] e plano_etapas[]), dentistas, padroes}`); `PUT /api/planejamento/plano/:id` (aceita `itens[].profissional_executor` após Task 4); `POST /api/planejamento/plano/:id/executar` (Task 4).
- Produces: nada consumido por outras tasks (última de código).

- [ ] **Step 1: Helper de options + flag `podeExecutar`**

Adicionar após `fmtBRL` (~linha 10):

```js
  // options do dropdown de executor (nomes de planejamento_dentistas); valor legado texto-livre vira option p/ não se perder
  function optionsExecutor(dentistas, valor) {
    const nomes = (dentistas || []).map(d => d.profissional_nome).filter(Boolean);
    const v = valor || '';
    if (v && !nomes.includes(v)) nomes.unshift(v);
    return '<option value=""></option>' + nomes.map(n =>
      `<option value="${esc(n)}"${n === v ? ' selected' : ''}>${esc(n)}</option>`).join('');
  }
```

Dentro de `abrir`, após o fetch do plano:

```js
    const podeExecutar = !['concluido', 'descartado', 'cancelado'].includes(plano.status);
```

- [ ] **Step 2: Mini-diálogo de execução (data + anotar ficha)**

Adicionar como função top-level (junto de `garantirDialog`):

```js
  // mini-diálogo do "✓": data (default hoje) + intenção de anotar na ficha do Clinicorp (gancho do robô)
  function miniDialogoExec() {
    return new Promise(resolve => {
      let d = document.getElementById('dlg-exec-data');
      if (!d) { d = document.createElement('dialog'); d.id = 'dlg-exec-data'; document.body.appendChild(d); }
      const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
      d.innerHTML = `<h3>Marcar como executado</h3>
        <label>Data <input id="ex-data" type="date" value="${hoje}"></label>
        <label><input id="ex-ficha" type="checkbox"> Anotar na ficha do Clinicorp</label>
        <footer><button id="ex-ok" class="btn btn-primario">Confirmar ✓</button>
        <button id="ex-cancel" class="btn btn-ghost">Cancelar</button></footer>`;
      d.onclick = ev => {
        // resolve ANTES do close: se algum engine disparasse 'close' síncrono, o onclose (null) venceria.
        // resolve duplo é no-op — o primeiro ganha.
        if (ev.target.id === 'ex-ok') { resolve({ data: d.querySelector('#ex-data').value || hoje, anotar: d.querySelector('#ex-ficha').checked }); d.close(); }
        if (ev.target.id === 'ex-cancel') { resolve(null); d.close(); }
      };
      d.onclose = () => resolve(null);   // Esc fecha = cancelar
      d.showModal();
    });
  }
```

- [ ] **Step 3: Render — select do item, select da etapa, disabled, ✓, Executar todos, filhos read-only**

No template do fieldset (hoje linhas 77-87), substituir o bloco `<div id="itens">...` por:

```js
      <div id="itens">${(itens || []).map(item => `
        <fieldset data-item="${esc(item.id)}"${item.price_id ? ` data-price-id="${esc(item.price_id)}" data-proc-name="${esc(item.procedure_name)}"` : ''}><legend>${esc(item.procedure_name)} × ${esc(item.quantidade)}
            <span class="item-mover"><button type="button" class="mv-up" title="Subir na ordem de execução">▲</button><button type="button" class="mv-down" title="Descer na ordem de execução">▼</button></span></legend>
          <label class="item-exec">Executor <select class="item-prof">${optionsExecutor(dentistas, item.profissional_executor)}</select></label>
          <ol class="etapas">${(item.plano_etapas || []).sort((a, b) => a.ordem - b.ordem).map(e => {
            const pend = e.status === 'pendente';
            return `
            <li data-etapa="${esc(e.id)}" data-status="${esc(e.status)}"><input class="et-desc" value="${esc(e.descricao)}"${pend ? '' : ' disabled'}>
              <select class="et-prof"${pend ? '' : ' disabled'}>${optionsExecutor(dentistas, e.profissional_executor)}</select>
              <input class="et-min" type="number" placeholder="min" value="${esc(e.tempo_planejado_min ?? '')}" style="width:70px"${pend ? '' : ' disabled'}> min
              ${pend ? `${podeExecutar ? '<button class="et-exec" title="Marcar executado">✓</button>' : ''}<button class="et-rm">×</button>` : `<em>(${esc(e.status)})</em>`}</li>`; }).join('')}
          </ol>
          ${(item.sublotes || []).map(sl => {
            const ets = (sl.plano_etapas || []).sort((a, b) => a.ordem - b.ordem);
            return ets.length ? `<div class="sublote-bloco"><b>${esc(sl.rotulo || sl.procedure_name || '')}</b><ul class="etapas-filho">${ets.map(e => `
              <li data-etapa-filho="${esc(e.id)}"><span>${esc(e.descricao)}</span> <small>${esc(e.profissional_executor || '')}</small>
                ${e.status === 'pendente' ? (podeExecutar ? '<button class="et-exec-filho" title="Marcar executado">✓</button>' : '') : `<em>(${esc(e.status)})</em>`}</li>`).join('')}</ul></div>` : '';
          }).join('')}
          <button class="add-etapa">+ etapa</button> <button class="dividir">dividir em sub-lotes</button>${podeExecutar ? ' <button class="exec-todos">✓ Executar todos</button>' : ''}${botoesPadrao(item, padroes)}
        </fieldset>`).join('') || '<p class="vazio">Sem itens de orçamento vinculados.</p>'}</div>
```

⚠️ Filhos usam `data-etapa-filho` (NUNCA `data-etapa`) e `<ul class="etapas-filho">` separada — fora do seletor do `coletar()` (`[data-etapa], li.nova`) e fora da contagem de índice (`.etapas li`).

- [ ] **Step 4: Templates de etapa nova (add-etapa e aplicar-padrao) viram select**

`add-etapa` (linha ~126) — a etapa nova já nasce com o executor do item (herda no nascimento, não só no `change`):

```js
          `<li class="nova"><input class="et-desc" placeholder="descrição"><select class="et-prof">${optionsExecutor(dentistas, fs.querySelector('.item-prof')?.value || '')}</select><input class="et-min" type="number" style="width:70px"> min ${podeExecutar ? '<button class="et-exec" title="Marcar executado">✓</button>' : ''}<button class="et-rm">×</button></li>`
```

`aplicar-padrao` (linha ~138):

```js
                `<li class="nova"><input class="et-desc" placeholder="descrição" value="${esc(e.descricao || '')}"><select class="et-prof">${optionsExecutor(dentistas, e.profissional_sugerido || '')}</select><input class="et-min" type="number" style="width:70px" value="${esc(e.tempo_sugerido_min ?? '')}"> min ${podeExecutar ? '<button class="et-exec" title="Marcar executado">✓</button>' : ''}<button class="et-rm">×</button></li>`
```

(`.et-prof` era `<input>`; `.value` de `<select>` funciona igual no `coletar()` e no `salvar-padrao` — nada mais muda neles.)

- [ ] **Step 5: `coletar()` passa o executor do item**

No objeto de item dentro de `coletar()` (linha ~101) — versão completa (só a linha `profissional_executor` é nova; o resto fica como está hoje):

```js
      itens: [...dlg.querySelectorAll('[data-item]')].map(f => ({
        id: Number(f.dataset.item),
        profissional_executor: f.querySelector('.item-prof')?.value || '',
        sublotes: JSON.parse(f.dataset.sublotes || 'null') || undefined,
        etapas: [...f.querySelectorAll('[data-etapa], li.nova')].map(li => ({
          id: li.dataset.etapa ? Number(li.dataset.etapa) : null, status: li.dataset.status || 'pendente',
          descricao: li.querySelector('.et-desc').value,
          profissional_executor: li.querySelector('.et-prof').value,
          tempo_planejado_min: Number(li.querySelector('.et-min').value) || null })) })),
```

- [ ] **Step 6: Herança do executor (change no select do item)**

Após `dlg.showModal()`:

```js
    dlg.onchange = ev => {
      if (ev.target.classList && ev.target.classList.contains('item-prof')) {
        // herda p/ etapas VAZIAS do fieldset (não sobrescreve escolha individual)
        ev.target.closest('fieldset').querySelectorAll('select.et-prof:not([disabled])')
          .forEach(s => { if (!s.value) s.value = ev.target.value; });
      }
    };
```

- [ ] **Step 7: Fluxo executar (salvar-antes + resolução de id por índice)**

Adicionar dentro de `abrir` (antes do `dlg.onclick`):

```js
    const reabrir = () => abrir(id, opts);   // re-render completo com dados frescos
    // alvo: {todos:true, itemId} | {etapaFilhoId} | {itemId, etapaIndex}
    // ⚠️ o pré-PUT deleta e recria TODAS as pendentes (ids novos, ordem = índice na lista enviada) —
    // nunca usar o id do DOM p/ etapa; resolve pós-PUT por (item, ordem == índice-entre-pendentes).
    async function executarFluxo(alvo) {
      const escolha = await miniDialogoExec();
      if (!escolha) return;
      await api(`/api/planejamento/plano/${id}`, { method: 'PUT', body: JSON.stringify(coletar()) });   // salvar-antes: nada do modal se perde
      let payload;
      if (alvo.todos) payload = { item_id: alvo.itemId };            // id de item sobrevive ao PUT
      else if (alvo.etapaFilhoId) payload = { etapa_id: alvo.etapaFilhoId };   // filho está fora do coletar(): id sobrevive (salvo re-divisão → cai no 404 amigável)
      else {
        const fresco = await api(`/api/planejamento/plano/${id}`);
        const item = (fresco.itens || []).find(i => i.id === alvo.itemId);
        const acha = lst => (lst || []).find(e => e.status === 'pendente' && e.ordem === alvo.etapaIndex);
        let achada = item ? acha(item.plano_etapas) : null;
        if (!achada && item && (item.sublotes || []).length) achada = acha(item.sublotes[0].plano_etapas);   // dividido nesta sessão: etapas foram pro 1º sub-lote
        if (!achada) { alert('Plano atualizado — clique ✓ novamente.'); return reabrir(); }
        payload = { etapa_id: achada.id };
      }
      try {
        await api(`/api/planejamento/plano/${id}/executar`, { method: 'POST',
          body: JSON.stringify({ ...payload, data: escolha.data, anotar_ficha: escolha.anotar }) });
      } catch (e) {
        if (/não encontrada|nao encontrada|404/i.test(String(e.message || ''))) { alert('Plano atualizado — clique ✓ novamente.'); return reabrir(); }
        throw e;
      }
      if (onSaved) onSaved();   // status do plano pode ter mudado → recarrega a fila/Trilhas atrás do modal
      return reabrir();
    }
```

- [ ] **Step 8: Handlers de clique**

Dentro do `dlg.onclick` (junto dos outros `if`):

```js
        if (b.classList.contains('exec-todos')) { await executarFluxo({ todos: true, itemId: Number(b.closest('fieldset').dataset.item) }); }
        if (b.classList.contains('et-exec-filho')) { await executarFluxo({ etapaFilhoId: Number(b.closest('li').dataset.etapaFilho) }); }
        if (b.classList.contains('et-exec')) {
          const fs = b.closest('fieldset'); const li = b.closest('li');
          // índice ENTRE PENDENTES/NOVAS (mesmo predicado do filtro do PUT) — concluídas e filhos NÃO contam
          const pendentes = [...fs.querySelectorAll('.etapas li')].filter(x => x.classList.contains('nova') || x.dataset.status === 'pendente');
          await executarFluxo({ itemId: Number(fs.dataset.item), etapaIndex: pendentes.indexOf(li) });
        }
```

- [ ] **Step 9: Verificar sintaxe**

Run: `node --check public/js/planejamento/editor.js` → sem saída.

- [ ] **Step 10: Commit**

```bash
git add public/js/planejamento/editor.js
git commit -m "feat(planejamento): executor em dropdown (item herda p/ etapas) + ✓ por etapa / Executar todos com data e gancho ficha no modal"
```

---

### Task 6: Deploy + smoke em produção

**Files:** nenhum novo (regras da casa).

- [ ] **Step 1: Testes + sintaxe final**

Run: `npm test` (PASS) · `node --check server.js` · `node --check sync/clinicorp-sync.js` · `node --check public/js/planejamento/editor.js`.

- [ ] **Step 2: Fetch + fast-forward + push**

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD && echo FF-OK || echo DIVERGIU   # se DIVERGIU: rebase origin/main antes
```

**Push (método comprovado 2026-07-07, memória `feedback_git_push_headless.md` — GCM trava headless; `CredRead` é API Win32, NÃO cmdlet):** via ferramenta PowerShell, **tudo numa chamada só** (o `Add-Type` não persiste): P/Invoke `CredReadW` (advapi32) no target `git:https://github.com` → extrair `$user`/`$token` → push com credencial embutida na URL e helpers desligados:

```powershell
# ... Add-Type do CredRead + leitura de $user/$token (uma chamada só) ...
$remote=(git remote get-url origin).Trim()
$hp=[regex]::Match($remote,'^https://(?:[^@/]+@)?(.+)$').Groups[1].Value
$pushUrl="https://$user`:$token@$hp"
git -c credential.helper= -c core.askPass= push $pushUrl planejamento:main 2>&1 |
  ForEach-Object { $_ -replace [regex]::Escape($token),'***' } | Select-Object -Last 8
```

⚠️ NUNCA imprimir o token. Exit code do PowerShell pode vir 1 pelo stderr nativo — **confirmar sucesso SEMPRE por** `git fetch origin main; git rev-list --count origin/main..HEAD` (esperado `0`).

- [ ] **Step 3: Deploy Easypanel + verificação do SWAP pelo conteúdo servido**

```bash
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
# aguardar ~60-90s e conferir que o build novo está NO AR pelo conteúdo:
curl -s https://plataformaama-plataforma.uc5as5.easypanel.host/js/planejamento/editor.js | grep -c "exec-todos"   # esperado: >=1
```

Se o grep vier 0: swap travado — Stop→Start no Easypanel e conferir de novo (regra da casa).

- [ ] **Step 4: Smoke API (sem login = 401)**

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST https://plataformaama-plataforma.uc5as5.easypanel.host/api/planejamento/plano/1/executar   # esperado: 401
```

- [ ] **Step 5: Atualizar ledger + avisar Luiz do checklist manual**

Append em `.superpowers/sdd/progress.md` com o resumo das tasks/commits. Reportar ao Luiz os 8 testes manuais da spec (seção Testes) para validação logada.

---

## Self-Review (feito na escrita)

- **Cobertura da spec:** migração (T1) · dropdown+herança+persistência (T4 passo 4, T5) · ✓/Executar todos/mini-diálogo/salvar-antes/resolução índice/filhos read-only/disabled/esconder botões (T5) · endpoint antes da genérica, cascata executor, sintética 999, idempotência, avanço 2× (T4) · helper compartilhado (T2+T3) · fixes acoplados 1 e 2 (T4 passos 1-3) · deploy+swap (T6). Sem lacunas.
- **Placeholders:** nenhum TBD; todo passo de código tem o código.
- **Consistência de nomes:** `statusAposRegistro` (lib) / `planStatusAposRegistro` (alias no server) / `avancarPlanoAposRegistro(planoId, statusAtual)` / rota `executar` `{etapa_id|item_id, data, anotar_ficha}` / classes `item-prof`, `et-prof`, `et-exec`, `et-exec-filho`, `exec-todos`, `data-etapa-filho` — batem entre T4 e T5.
