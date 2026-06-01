# Dashboard Comercial Sub-2 — Conferência da CRC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar o portão de conferência da CRC: cada fechamento nasce pendente, a CRC aprova/edita/rejeita numa página própria, só aprovados contam como "Confirmado" no dashboard, e a CRC é avisada na central de notificação.

**Architecture:** Colunas de revisão em `orcamentos`. Sync grava `paciente_nome`/`clinicorp_lastchange`, reabre aprovados cujo tratamento mudou (compara `LastChange_Date`) e notifica a CRC dos pendentes novos. Endpoints de conferência (listar/revisar). O `fechamentos_mes` do funil vira `{confirmado, pendente}`. Página `/comercial/conferencia/`.

**Tech Stack:** Node.js + Express (`server.js`), Supabase, JS vanilla, `node --test`. Spec: `docs/superpowers/specs/2026-05-31-comercial-conferencia-design.md`.

**Pré-requisito:** Sub-1 deployado (f8f1272). Tabela `orcamentos` com `valor_particular`, `data_fechamento`, `entrada_valor`; `lib/funil/fechamentos.js` com `agregarFechamentos`; sync com `selectAll`; `criarNotificacao`/tabela `notificacoes`/`profiles.roles` já existem.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20260601000000_comercial_conferencia.sql` | Colunas de revisão em `orcamentos` |
| `lib/funil/fechamentos.js` (+ `.test.js`) | entrada contada 1x por paciente |
| `sync/clinicorp-sync.js` | grava `paciente_nome`/`clinicorp_lastchange`; `reavaliarFechamentos`; `notificarPendentes` |
| `server.js` | endpoints de conferência + `fechamentos_mes` `{confirmado,pendente}` |
| `public/js/comercial/api.js` | `listarConferencia`, `revisarConferencia` |
| `public/comercial/app.js`, `public/comercial/index.html` | dashboard mostra Confirmado + Pendente |
| `public/comercial/conferencia/index.html`, `public/js/comercial/conferencia.js` | página da fila |
| `public/index.html`, `public/js/shared-nav.js` | link "Conferência" no nav |

---

## Task 1: Migração — colunas de revisão

**Files:**
- Create: `supabase/migrations/20260601000000_comercial_conferencia.sql`

- [ ] **Step 1: Escrever a migração**

```sql
alter table public.orcamentos
  add column if not exists revisao_status         text not null default 'pendente',
  add column if not exists valor_aprovado         numeric(12,2),
  add column if not exists entrada_aprovada       numeric(12,2),
  add column if not exists revisado_por           uuid,
  add column if not exists revisado_em            timestamptz,
  add column if not exists revisao_motivo         text,
  add column if not exists clinicorp_lastchange   timestamptz,
  add column if not exists revisao_ref_lastchange timestamptz,
  add column if not exists revisao_notificado     boolean not null default false,
  add column if not exists paciente_nome          text;

create index if not exists idx_orcamentos_revisao on public.orcamentos (revisao_status);
```

- [ ] **Step 2: Aplicar via MCP Supabase**

`apply_migration` (project_id `mtqdpjhhqzvuklnlfpvi`, name `comercial_conferencia`, query = acima). Verificar com `list_tables` (verbose) que as 10 colunas existem.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260601000000_comercial_conferencia.sql
git commit -m "feat(comercial): migracao colunas de revisao/conferencia"
```

---

## Task 2: `agregarFechamentos` — entrada contada 1x por paciente

**Files:**
- Modify: `lib/funil/fechamentos.js`
- Modify: `lib/funil/fechamentos.test.js`

- [ ] **Step 1: Adicionar o teste que falha**

Acrescentar em `lib/funil/fechamentos.test.js`:

```js
test('entrada do paciente conta uma vez (não dobra com 2 orçamentos)', () => {
  const r = agregarFechamentos({
    orcamentos: [
      { paciente_clinicorp_id: 'A', valor_particular: 5000, entrada_valor: 2000, data_fechamento: '2026-05-10' },
      { paciente_clinicorp_id: 'A', valor_particular: 3000, entrada_valor: 2000, data_fechamento: '2026-05-12' },
    ],
    avaliacoesPorPaciente: new Map([['A', [{ data: '2026-05-01' }]]]),
  });
  assert.strictEqual(r.fechamentos, 1);            // 1 paciente
  assert.strictEqual(r.valor_fechado, 8000);       // soma dos tratamentos
  assert.strictEqual(r.entradas_recebidas, 2000);  // entrada uma vez (não 4000)
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/funil/fechamentos.test.js`
Expected: FAIL no novo teste (`entradas_recebidas` = 4000, esperado 2000).

- [ ] **Step 3: Trocar a soma por máximo na entrada**

Em `lib/funil/fechamentos.js`, dentro de `agregarFechamentos`, na montagem do `porPaciente`, trocar a linha da entrada:

```js
    acc.valor   += Number(o.valor_particular || 0);
    acc.entrada = Math.max(acc.entrada, Number(o.entrada_valor || 0));
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/funil/fechamentos.test.js`
Expected: PASS (6 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/funil/fechamentos.js lib/funil/fechamentos.test.js
git commit -m "fix(comercial): entrada contada uma vez por paciente no fechamento"
```

---

## Task 3: Sync — paciente_nome, clinicorp_lastchange, reavaliar e notificar

**Files:**
- Modify: `sync/clinicorp-sync.js`

- [ ] **Step 1: Gravar `paciente_nome` e `clinicorp_lastchange` em `syncOrcamentos`**

No objeto `byId.set(id, {...})` de `syncOrcamentos`, acrescentar (após `data_fechamento`):

```js
      paciente_nome:         o.PatientName || '',
      clinicorp_lastchange:  o.LastChange_Date || null,
```

- [ ] **Step 2: Adicionar `reavaliarFechamentos` e `notificarPendentes`** (antes de `runSync`)

```js
// Reabre (pendente) os aprovados cujo orçamento mudou no Clinicorp (LastChange_Date diferente do retrato).
async function reavaliarFechamentos() {
  const aprovados = await selectAll('orcamentos',
    'clinicorp_estimate_id, clinicorp_lastchange, revisao_ref_lastchange',
    q => q.eq('revisao_status', 'aprovado'));
  let n = 0;
  for (const o of aprovados) {
    const atual = o.clinicorp_lastchange ? new Date(o.clinicorp_lastchange).getTime() : null;
    const ref   = o.revisao_ref_lastchange ? new Date(o.revisao_ref_lastchange).getTime() : null;
    if (atual !== ref) {
      await supabase.from('orcamentos')
        .update({ revisao_status: 'pendente', revisao_notificado: false })
        .eq('clinicorp_estimate_id', o.clinicorp_estimate_id);
      n++;
    }
  }
  log(`Fechamentos reabertos (tratamento mudou): ${n}`);
  return n;
}

// Avisa os crc_comercial dos fechamentos pendentes ainda não notificados (uma notificação agregada).
async function notificarPendentes() {
  const pend = await selectAll('orcamentos', 'clinicorp_estimate_id',
    q => q.eq('status', 'APPROVED').gt('valor_particular', 0).not('data_fechamento', 'is', null)
          .eq('revisao_status', 'pendente').eq('revisao_notificado', false));
  if (!pend.length) { log('notificarPendentes: nenhum novo'); return 0; }

  const { data: crcs } = await supabase.from('profiles').select('id').contains('roles', ['crc_comercial']);
  const corpo = `${pend.length} fechamento(s) aguardando sua conferência`;
  const rows = (crcs || []).map(u => ({
    usuario_id: u.id, tipo: 'conferencia_pendente',
    titulo: '📋 Fechamentos para conferir', corpo,
    metadata: { url: '/comercial/conferencia/' },
  }));
  if (rows.length) {
    const { error } = await supabase.from('notificacoes').insert(rows);
    if (error) log(`ERRO notificacoes: ${error.message}`);
  }

  const ids = pend.map(p => p.clinicorp_estimate_id);
  for (let i = 0; i < ids.length; i += 500) {
    await supabase.from('orcamentos').update({ revisao_notificado: true })
      .in('clinicorp_estimate_id', ids.slice(i, i + 500));
  }
  log(`notificarPendentes: ${pend.length} pendentes, ${rows.length} CRC avisados`);
  return pend.length;
}
```

- [ ] **Step 3: Chamar as fases no `runSync`** (após a Fase 10 `marcarAvaliacoesComOrcamento`)

```js
    // Fase 11: reabrir aprovados cujo tratamento mudou
    result.steps.fechamentos_reabertos = await reavaliarFechamentos();

    // Fase 12: notificar CRC dos pendentes novos
    result.steps.pendentes_notificados = await notificarPendentes();
```

- [ ] **Step 4: Atualizar exports**

```js
module.exports = { runSync, loadFunilConfig, syncAvaliacoes, syncOrcamentos, vincularLeads, syncEntradas, marcarAvaliacoesComOrcamento, reavaliarFechamentos, notificarPendentes };
```

- [ ] **Step 5: Verificar sintaxe**

Run: `node --check sync/clinicorp-sync.js`
Expected: sem erro. (Verificação com dados reais fica para a Task 8, pós-reset do rate limit.)

- [ ] **Step 6: Commit**

```bash
git add sync/clinicorp-sync.js
git commit -m "feat(comercial): sync grava lastchange/nome, reabre e notifica conferencia"
```

---

## Task 4: Endpoints de conferência

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Adicionar as rotas** (logo após o handler `app.get('/api/comercial/funil', ...)`, antes de `// ── Lista CRCs`)

```js
// ===== Conferência da CRC =====
// GET /api/comercial/conferencia?status=pendente|aprovado|rejeitado
app.get('/api/comercial/conferencia', requireAuth, requireDashboardAvaliacao, rateLimit, async (req, res) => {
  try {
    const status = ['pendente', 'aprovado', 'rejeitado'].includes(req.query.status) ? req.query.status : 'pendente';
    const { data, error } = await supabase.from('orcamentos')
      .select('clinicorp_estimate_id, paciente_nome, profissional_nome, valor_particular, entrada_valor, data_fechamento, valor_aprovado, entrada_aprovada, revisao_status, revisao_motivo')
      .eq('status', 'APPROVED').gt('valor_particular', 0).not('data_fechamento', 'is', null)
      .eq('revisao_status', status)
      .order('data_fechamento', { ascending: false }).limit(500);
    if (error) throw error;
    res.json({ status, fechamentos: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/comercial/conferencia/:estimateId  body { acao:'aprovar'|'rejeitar', valor?, entrada?, motivo? }
app.post('/api/comercial/conferencia/:estimateId', requireAuth, requireDashboardAvaliacao, rateLimit, async (req, res) => {
  try {
    const id = String(req.params.estimateId);
    const { acao } = req.body;
    if (!['aprovar', 'rejeitar'].includes(acao)) return res.status(400).json({ error: 'acao inválida' });

    const { data: orc } = await supabase.from('orcamentos')
      .select('valor_particular, entrada_valor, clinicorp_lastchange')
      .eq('clinicorp_estimate_id', id).maybeSingle();
    if (!orc) return res.status(404).json({ error: 'Fechamento não encontrado' });

    const now = new Date().toISOString();
    let patch;
    if (acao === 'aprovar') {
      const num = (v, fb) => (v === undefined || v === null || v === '' || isNaN(Number(v))) ? fb : Math.max(0, Number(v));
      patch = {
        revisao_status: 'aprovado',
        valor_aprovado: num(req.body.valor, Number(orc.valor_particular || 0)),
        entrada_aprovada: num(req.body.entrada, Number(orc.entrada_valor || 0)),
        revisao_ref_lastchange: orc.clinicorp_lastchange || null,
        revisao_motivo: null,
        revisado_por: req.user.id, revisado_em: now,
      };
    } else {
      const motivo = sanitizeStr(req.body.motivo || '', 500).trim();
      if (!motivo) return res.status(400).json({ error: 'motivo é obrigatório para rejeitar' });
      patch = { revisao_status: 'rejeitado', revisao_motivo: motivo, revisado_por: req.user.id, revisado_em: now };
    }
    const { error } = await supabase.from('orcamentos').update(patch).eq('clinicorp_estimate_id', id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
```

- [ ] **Step 2: Verificar sintaxe + smoke (sem token = 401)**

Run: `node --check server.js` → SYNTAX OK.
Run: `node server.js &` ; `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/comercial/conferencia` → `401`; parar o servidor.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(comercial): endpoints de conferencia (listar e revisar)"
```

---

## Task 5: `fechamentos_mes` → `{confirmado, pendente}` no funil

**Files:**
- Modify: `server.js` (handler `GET /api/comercial/funil`)

- [ ] **Step 1: Incluir `revisao_status`/aprovados na query `fechados`**

No handler `/api/comercial/funil`, trocar o `select` da query `fechados` por:

```js
    const { data: fechados } = await supabase.from('orcamentos')
      .select('paciente_clinicorp_id, valor_particular, entrada_valor, data_fechamento, lead_id, revisao_status, valor_aprovado, entrada_aprovada')
      .eq('status', 'APPROVED').gt('valor_particular', 0)
      .gte('data_fechamento', from).lte('data_fechamento', to);
```

- [ ] **Step 2: Construir maps só com não-rejeitados e separar confirmado/pendente**

Trocar o trecho que monta `fechamentoPorPaciente`/`fechamentoPorLead` e calcula `fechamentos_mes` por:

```js
    const naoRejeitados = (fechados || []).filter(f => f.revisao_status !== 'rejeitado');
    const fechamentoPorPaciente = new Map();
    const fechamentoPorLead = new Map();
    for (const f of naoRejeitados) {
      const cur = fechamentoPorPaciente.get(f.paciente_clinicorp_id);
      if (!cur || f.data_fechamento > cur) fechamentoPorPaciente.set(f.paciente_clinicorp_id, f.data_fechamento);
      if (f.lead_id != null) {
        const c2 = fechamentoPorLead.get(f.lead_id);
        if (!c2 || f.data_fechamento > c2) fechamentoPorLead.set(f.lead_id, f.data_fechamento);
      }
    }

    const aprovados = naoRejeitados.filter(f => f.revisao_status === 'aprovado')
      .map(f => ({ ...f, valor_particular: f.valor_aprovado, entrada_valor: f.entrada_aprovada }));
    const pendentes = naoRejeitados.filter(f => f.revisao_status === 'pendente');

    const orcTopo = (orcCriados || []).map(o => ({ ...o, valor: o.valor_particular }));
    const resultado = agregarFunil({ leads: leads || [], avaliacoes: avaliacoes || [], orcamentos: orcTopo, origem });
    const fechamentos_mes = {
      confirmado: agregarFechamentos({ orcamentos: aprovados, avaliacoesPorPaciente }),
      pendente:   agregarFechamentos({ orcamentos: pendentes, avaliacoesPorPaciente }),
    };
    const tempos_fase = temposPorFase({ avaliacoes: avaliacoes || [], fechamentoPorPaciente, leads: leads || [], fechamentoPorLead });
```

> Remover a antiga linha `const fechamentoPorPaciente = new Map(); ... for (const f of (fechados||[])) {...}` e a antiga `const fechamentos_mes = agregarFechamentos({...})` — substituídas pelo bloco acima. O `res.json({... fechamentos_mes, tempos_fase})` continua igual.

- [ ] **Step 3: Verificar sintaxe**

Run: `node --check server.js` → SYNTAX OK.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(comercial): fechamentos_mes separa confirmado e pendente"
```

---

## Task 6: Dashboard — mostrar Confirmado e Pendente

**Files:**
- Modify: `public/comercial/index.html`
- Modify: `public/js/comercial/app.js`

- [ ] **Step 1: Trocar o bloco de fechamentos no `index.html`**

Substituir o bloco atual de "Fechamentos do mês" por:

```html
  <div class="bloco">
    <h2>Fechamentos do mês</h2>
    <h3 class="grupo-titulo">✅ Confirmado pela CRC</h3>
    <div class="cards" id="cards-fech-confirmado"></div>
    <h3 class="grupo-titulo">🕓 Pendente de conferência</h3>
    <div class="cards" id="cards-fech-pendente"></div>
  </div>
```

E no `<style>` adicionar:

```css
  .grupo-titulo { font-size:13px; font-weight:700; margin:14px 0 8px; }
```

(O `.selo` antigo pode ficar no CSS sem uso; não é preciso remover.)

- [ ] **Step 2: Atualizar o render no `app.js`**

Substituir a função `renderFechamentos` por uma que recebe os dois grupos, e ajustar a chamada em `carregar`:

```js
function cardsFech(f) {
  return [
    ['Fechamentos no mês', NUM(f.fechamentos)],
    ['Valor fechado', BRL(f.valor_fechado)],
    ['Entradas recebidas', BRL(f.entradas_recebidas)],
    ['Ticket médio', BRL(f.ticket_medio)],
    ['Tempo médio até fechar', DIAS(f.tempo_medio_ate_fechar)],
    ['Origem do fechamento', `${PCT(f.origem_fechamento.pct_mesmo_mes)} no mês · ${f.origem_fechamento.meses_anteriores} de antes`],
  ];
}
function renderFechamentosGrupo(el, f) {
  el.innerHTML = cardsFech(f)
    .map(([r, val]) => `<div class="card"><div class="rotulo">${r}</div><div class="valor">${val}</div></div>`)
    .join('');
}
```

E em `carregar`, trocar a linha `renderFechamentos(document.getElementById('cards-fechamentos'), data.fechamentos_mes);` por:

```js
  renderFechamentosGrupo(document.getElementById('cards-fech-confirmado'), data.fechamentos_mes.confirmado);
  renderFechamentosGrupo(document.getElementById('cards-fech-pendente'), data.fechamentos_mes.pendente);
```

> Remover a antiga função `renderFechamentos` (substituída por `cardsFech` + `renderFechamentosGrupo`).

- [ ] **Step 3: Smoke test local**

Run: `node --check public/js/comercial/app.js` → OK. `node server.js &` ; `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/comercial/` → 200; parar o servidor.

- [ ] **Step 4: Commit**

```bash
git add public/comercial/index.html public/js/comercial/app.js
git commit -m "feat(comercial): dashboard mostra fechamentos confirmados e pendentes"
```

---

## Task 7: Página de Conferência + nav

**Files:**
- Modify: `public/js/comercial/api.js`
- Create: `public/comercial/conferencia/index.html`
- Create: `public/js/comercial/conferencia.js`
- Modify: `public/index.html`, `public/js/shared-nav.js`

- [ ] **Step 1: Adicionar funções à `api.js`**

Antes da linha `window.ComercialApi = { getFunil };`, inserir:

```js
async function listarConferencia(status) {
  const r = await fetch(`/api/comercial/conferencia?status=${status || 'pendente'}`, {
    headers: { Authorization: `Bearer ${_token()}` },
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
async function revisarConferencia(id, body) {
  const r = await fetch(`/api/comercial/conferencia/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token()}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
```

E trocar a última linha por:

```js
window.ComercialApi = { getFunil, listarConferencia, revisarConferencia };
```

- [ ] **Step 2: Criar `public/comercial/conferencia/index.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Conferência — CRM AMA</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
  :root[data-theme="dark"] { --bg:#0f1117; --bg2:#181b24; --bg3:#1e2230; --border:#2a2f42; --text:#e8eaf0; --muted:#6b7280; --accent:#4f8ef7; --accent-hover:#3a78e0; --green:#22c55e; --red:#ef4444; }
  :root[data-theme="light"] { --bg:#f7f8fa; --bg2:#fff; --bg3:#f1f3f7; --border:#e3e6ed; --text:#1a1d29; --muted:#6b7280; --accent:#3b82f6; --accent-hover:#2563eb; --green:#16a34a; --red:#dc2626; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:'DM Sans',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; }
  .topo { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:16px; }
  .topo select { padding:6px 10px; border-radius:8px; border:1px solid var(--border); background:var(--bg2); color:var(--text); font-size:13px; }
  .conta { font-size:12.5px; color:var(--muted); }
  .linha { display:grid; grid-template-columns:1.4fr 1fr 90px 130px 130px auto; gap:10px; align-items:center;
           background:var(--bg2); border:1px solid var(--border); border-radius:10px; padding:10px 12px; margin-bottom:8px; }
  @media (max-width:820px){ .linha{ grid-template-columns:1fr 1fr; } }
  .linha .nome { font-weight:600; font-size:13.5px; }
  .linha .sub { font-size:11.5px; color:var(--muted); }
  .linha input { width:100%; padding:6px 8px; border-radius:7px; border:1px solid var(--border); background:var(--bg3); color:var(--text); font-size:13px; }
  .linha .lbl { font-size:10.5px; color:var(--muted); display:block; margin-bottom:2px; }
  .acoes { display:flex; gap:6px; }
  .btn { padding:7px 12px; border-radius:8px; border:none; font-size:12.5px; font-weight:600; cursor:pointer; color:#fff; }
  .btn-ok { background:var(--green); } .btn-no { background:var(--red); }
  .vazio { color:var(--muted); font-size:14px; padding:30px 0; text-align:center; }
  </style>
  <script src="/js/shared-nav.js" data-active="conferencia" defer></script>
</head>
<body class="crm-shell">
<main style="flex:1;padding:28px 32px;overflow-y:auto;max-width:1100px">
  <h1 style="font-size:20px;font-weight:700;margin:0 0 6px">Conferência de Fechamentos</h1>
  <p style="font-size:12.5px;color:var(--muted);margin:0 0 18px">Confira valor e entrada de cada fechamento antes de contar no dashboard.</p>
  <div class="topo">
    <label>Status
      <select id="f-status">
        <option value="pendente">Pendentes</option>
        <option value="aprovado">Aprovados</option>
        <option value="rejeitado">Rejeitados</option>
      </select>
    </label>
    <span class="conta" id="conta"></span>
  </div>
  <div id="lista"></div>
  <script src="/js/comercial/api.js"></script>
  <script src="/js/comercial/conferencia.js"></script>
</main>
</body>
</html>
```

- [ ] **Step 3: Criar `public/js/comercial/conferencia.js`**

```js
const BRL = v => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style:'currency', currency:'BRL' }));
const fmtData = d => (d ? d.split('-').reverse().join('/') : '—');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

async function carregar() {
  const status = document.getElementById('f-status').value;
  const lista = document.getElementById('lista');
  lista.innerHTML = '<div class="vazio">Carregando...</div>';
  let data;
  try { data = await ComercialApi.listarConferencia(status); }
  catch (e) { lista.innerHTML = `<div class="vazio">Erro: ${e.message}</div>`; return; }

  const itens = data.fechamentos || [];
  document.getElementById('conta').textContent = `${itens.length} ${status}(s)`;
  if (!itens.length) { lista.innerHTML = '<div class="vazio">Nada por aqui.</div>'; return; }

  lista.innerHTML = itens.map(f => {
    const valor   = f.revisao_status === 'aprovado' ? f.valor_aprovado   : f.valor_particular;
    const entrada = f.revisao_status === 'aprovado' ? f.entrada_aprovada : f.entrada_valor;
    const acoes = status === 'pendente'
      ? `<div class="acoes">
           <button class="btn btn-ok" data-id="${f.clinicorp_estimate_id}" data-acao="aprovar">Aprovar</button>
           <button class="btn btn-no" data-id="${f.clinicorp_estimate_id}" data-acao="rejeitar">Rejeitar</button>
         </div>`
      : `<div class="sub">${esc(f.revisao_status)}${f.revisao_motivo ? ' · ' + esc(f.revisao_motivo) : ''}</div>`;
    return `<div class="linha" data-row="${f.clinicorp_estimate_id}">
      <div><div class="nome">${esc(f.paciente_nome) || '(sem nome)'}</div><div class="sub">${fmtData(f.data_fechamento)}</div></div>
      <div class="sub">${esc(f.profissional_nome)}</div>
      <div class="sub">${BRL(valor)}</div>
      <div><span class="lbl">Valor (R$)</span><input type="number" step="0.01" id="v-${f.clinicorp_estimate_id}" value="${Number(valor || 0)}" ${status !== 'pendente' ? 'disabled' : ''}></div>
      <div><span class="lbl">Entrada (R$)</span><input type="number" step="0.01" id="e-${f.clinicorp_estimate_id}" value="${Number(entrada || 0)}" ${status !== 'pendente' ? 'disabled' : ''}></div>
      ${acoes}
    </div>`;
  }).join('');

  lista.querySelectorAll('button[data-acao]').forEach(btn => {
    btn.addEventListener('click', () => acao(btn.dataset.id, btn.dataset.acao));
  });
}

async function acao(id, tipo) {
  try {
    if (tipo === 'aprovar') {
      const valor = parseFloat(document.getElementById('v-' + id).value);
      const entrada = parseFloat(document.getElementById('e-' + id).value);
      await ComercialApi.revisarConferencia(id, { acao: 'aprovar', valor, entrada });
    } else {
      const motivo = (prompt('Motivo da rejeição:') || '').trim();
      if (!motivo) { alert('Motivo é obrigatório.'); return; }
      await ComercialApi.revisarConferencia(id, { acao: 'rejeitar', motivo });
    }
    const row = document.querySelector(`.linha[data-row="${id}"]`);
    if (row) row.remove();
  } catch (e) { alert('Erro: ' + e.message); }
}

document.getElementById('f-status').addEventListener('change', carregar);
carregar();
```

- [ ] **Step 4: Link "Conferência" no `public/index.html`** (logo após o link "Comercial")

```html
  <a class="nav-btn" href="/comercial/conferencia/" data-roles="admin,gestor,crc_comercial">
    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
    Conferência
  </a>
```

- [ ] **Step 5: Link no `public/js/shared-nav.js`** (logo após a entrada `navLink('/comercial/', ...)`)

```js
    ${navLink('/comercial/conferencia/', 'admin,gestor,crc_comercial', 'conferencia',
      `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
      'Conferência')}
```

- [ ] **Step 6: Smoke test local**

Run: `node --check public/js/comercial/conferencia.js` → OK. `node server.js &` ; `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/comercial/conferencia/` → 200; `curl ... /js/comercial/conferencia.js` → 200; parar o servidor.

- [ ] **Step 7: Commit**

```bash
git add public/js/comercial/api.js public/comercial/conferencia/ public/js/comercial/conferencia.js public/index.html public/js/shared-nav.js
git commit -m "feat(comercial): pagina de conferencia da CRC + link no nav"
```

---

## Task 8: Re-sync, deploy e validação

**Files:** nenhum (operacional)

- [ ] **Step 1: Re-sync (após reset do rate limit ~1h)** para preencher `clinicorp_lastchange`/`paciente_nome` e rodar reavaliar/notificar

```bash
node -e "const s=require('./sync/clinicorp-sync'); (async()=>{const c=await s.loadFunilConfig(); await s.syncAvaliacoes(c); await s.syncOrcamentos(); await s.vincularLeads(); await s.syncEntradas(); await s.marcarAvaliacoesComOrcamento(); console.log('reabertos', await s.reavaliarFechamentos()); console.log('notificados', await s.notificarPendentes());})()"
```
Expected: logs sem erro; "notificarPendentes: N pendentes". MCP `execute_sql`:
`select revisao_status, count(*) from orcamentos where status='APPROVED' and valor_particular>0 and data_fechamento is not null group by revisao_status;`
(esperado: maioria `pendente`). Conferir que `paciente_nome` e `clinicorp_lastchange` estão preenchidos.

- [ ] **Step 2: Push + deploy**

```bash
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

- [ ] **Step 3: Validar em produção**

`/comercial/conferencia/` sem token → 401; `/comercial/conferencia/` página → 200. Logado como gestor/crc_comercial: abrir Conferência, aprovar/editar/rejeitar um fechamento, e ver o "Confirmado" do dashboard refletir. Conferir a notificação na central. Avisar o usuário para validação visual.

---

## Self-Review (cobertura do spec)

- Colunas de revisão → Task 1 ✓
- Ações Aprovar/Editar+Aprovar/Rejeitar (motivo obrigatório) → Task 4 (POST) + Task 7 (UI) ✓
- Totais Confirmado + Pendente lado a lado → Tasks 5, 6 ✓
- Página própria /comercial/conferencia/ → Task 7 ✓
- Unidade por orçamento → Tasks 4, 7 ✓
- Reabrir em mudança do tratamento (LastChange_Date) → Task 3 (`reavaliarFechamentos`) ✓
- Notificar crc_comercial na central → Task 3 (`notificarPendentes`) ✓
- Entrada contada 1x por paciente → Task 2 ✓
- Sync preserva revisão (upsert sem essas colunas) → Task 3 (não inclui no payload) ✓
- Fora de escopo (comissão/auditoria) → não implementado ✓

**Riscos:** nomes de campos do Clinicorp (`PatientName`, `LastChange_Date`) confirmados na Task 8; push real depende de VAPID configurado no Easypanel (a notificação na central funciona sem isso); primeira execução notifica todos os pendentes existentes (uma notificação agregada — esperado).
