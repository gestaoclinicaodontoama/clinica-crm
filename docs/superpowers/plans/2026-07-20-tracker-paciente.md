# Tracker do Paciente (④) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Página pública tokenizada `GET /t/:token` onde o paciente acompanha o tratamento (procedimentos + progresso + datas + executor + próxima consulta), com botão "copiar link" no /trilhas/ e no modal Planejar, e revogação pegajosa pela gestora.

**Architecture:** Página 100% renderizada no servidor (sem API JSON pública). Lógica pura (progresso, primeiro nome, render HTML) numa lib nova testável (`lib/planejamento/tracker.js`); a rota só faz IO com colunas explícitas. Token permanente em `plano_tratamento`.

**Tech Stack:** Node/Express (`server.js`), lib pura + `node --test`, Supabase (MCP, project `mtqdpjhhqzvuklnlfpvi`), vanilla JS no front.

**Spec:** `docs/superpowers/specs/2026-07-20-tracker-paciente-design.md` — fonte da verdade; ler antes de cada task.

## Global Constraints

- Worktree `clinica-crm/.claude/worktrees/planejamento` (branch `planejamento`).
- NUNCA `.catch()` em builder Supabase — try/catch no await.
- Rotas autenticadas: `requireAuth` → `blockParceiro` → role → `rateLimit`. Rota pública: SÓ `rateLimit` (por IP; `trust proxy` já ativo).
- ⚠️ `GET /t/:token` registrada no bloco do planejamento (~5000-5600) — ANTES do `express.static`/catch-all da SPA (~8300). ⚠️ `POST .../tracker-link` ANTES da genérica `POST /plano/:id/:acao`. Conferir ambos com grep.
- Página pública: `esc()` em TODA interpolação; seleção EXPLÍCITA de colunas em `plano_tratamento` (nunca `select('*')` — valor/orientacao_clinica/recado_sucesso não podem nem chegar à memória da rota); headers `X-Robots-Tag: noindex, nofollow` + `Cache-Control: no-store`.
- Revogação pegajosa: `copiar` NUNCA ressuscita link revogado (409); só `regenerar` (gestor/admin).
- Testes: `npm test` — baseline **489/493** (4 falhas pré-existentes em lib/monitor + lib/nfse; falha nova = sua).
- Migração: MCP `apply_migration` → arquivo `.sql` renomeado para casar a version do `list_migrations`.

---

### Task 1: Migração — token do tracker

**Files:**
- Create: `supabase/migrations/<version>_tracker_paciente.sql` (version = a que o MCP gerar)

**Interfaces:**
- Produces: colunas `plano_tratamento.tracker_token text` + `tracker_revogado_em timestamptz` + índice único parcial. Usadas pelas Tasks 3-4.

- [ ] **Step 1: Aplicar via MCP** (`apply_migration`, name `tracker_paciente`):

```sql
-- ④ Tracker do paciente: link público tokenizado por plano. Sem tabela nova (RLS já ligada).
ALTER TABLE public.plano_tratamento ADD COLUMN IF NOT EXISTS tracker_token text;
ALTER TABLE public.plano_tratamento ADD COLUMN IF NOT EXISTS tracker_revogado_em timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS idx_plano_tracker_token ON public.plano_tratamento(tracker_token) WHERE tracker_token IS NOT NULL;
```

- [ ] **Step 2: Verificar** — `list_migrations` (version nova no fim) + `execute_sql`: `SELECT column_name FROM information_schema.columns WHERE table_name='plano_tratamento' AND column_name LIKE 'tracker%';` → 2 linhas.

- [ ] **Step 3: Escrever o arquivo `.sql`** com a version exata e commitar:

```bash
git add supabase/migrations/*_tracker_paciente.sql
git commit -m "feat(tracker): migração token do tracker do paciente (tracker_token + tracker_revogado_em + índice único parcial)"
```

---

### Task 2: Lib `lib/planejamento/tracker.js` (TDD)

**Files:**
- Create: `lib/planejamento/tracker.js`
- Test: `lib/planejamento/tracker.test.js`

**Interfaces:**
- Produces (module.exports): `primeiroNome(nome) -> string` · `resumoTracker(raizes, fallbackExecutor) -> { pct, procedimentos: [{nome, status:'concluido'|'em_andamento'|'a_fazer', executor|null, sessoes:[{descricao|null, data|null}]}] }` · `renderTracker({nome, concluido, resumo, proxima}) -> string HTML` · `renderNeutro() -> string HTML`. Consumidas pela Task 3.
- `raizes` = shape de itens raiz: `{procedure_name, ordem, profissional_executor, plano_etapas:[{descricao,status,concluida_em,ordem}], sublotes:[{plano_etapas:[...]}]}`.

- [ ] **Step 1: Testes que falham** (`lib/planejamento/tracker.test.js`):

```js
const test = require('node:test');
const assert = require('node:assert');
const { primeiroNome, resumoTracker, renderTracker, renderNeutro } = require('./tracker');

test('primeiroNome: remove sufixo (id) do fim, preserva parênteses no meio, aguenta vazio', () => {
  assert.equal(primeiroNome('Jeysa Vanessa Rocha Magalhaes Reis (10551)'), 'Jeysa');
  assert.equal(primeiroNome('Maria Silva'), 'Maria');                       // inclusão manual, sem sufixo
  assert.equal(primeiroNome('Ana (Bia) Souza (99)'), 'Ana');
  assert.equal(primeiroNome(''), '');
  assert.equal(primeiroNome(null), '');
});

test('resumoTracker: progresso conta item sem etapa como 1 pendente (filosofia temItemSemEtapa)', () => {
  const r = resumoTracker([
    { procedure_name: 'Doc', profissional_executor: 'Thais', plano_etapas: [{ descricao: 'Procedimento realizado', status: 'concluida', concluida_em: '2026-07-18T15:00:00Z', ordem: 999 }], sublotes: [] },   // sintética detectada SÓ pelo ordem 999 (descricao ≠ nome — teste mais forte)
    { procedure_name: 'Prevenção', profissional_executor: null, plano_etapas: [], sublotes: [] },
  ], 'Marcos');
  assert.equal(r.pct, 50);                                    // 1 concluída ÷ (1 etapa + 1 item sem etapa)
  assert.equal(r.procedimentos[0].status, 'concluido');
  assert.equal(r.procedimentos[0].sessoes[0].descricao, null); // sintética (ordem 999 / descricao==nome) → só data
  assert.equal(r.procedimentos[1].status, 'a_fazer');
  assert.equal(r.procedimentos[1].executor, 'Marcos');         // fallback = dentista responsável
});

test('resumoTracker: em_andamento + etapas de sub-lotes agregadas na raiz', () => {
  const r = resumoTracker([{ procedure_name: 'Facetas', profissional_executor: 'Lígia', plano_etapas: [],
    sublotes: [{ plano_etapas: [{ descricao: 'moldagem', status: 'concluida', concluida_em: '2026-07-01T12:00:00Z', ordem: 0 }, { descricao: 'cimentação', status: 'pendente', ordem: 1 }] }] }], null);
  assert.equal(r.pct, 50);
  assert.equal(r.procedimentos[0].status, 'em_andamento');
  assert.equal(r.procedimentos[0].sessoes.length, 1);          // pendente NÃO listada
  assert.equal(r.procedimentos[0].sessoes[0].descricao, 'moldagem');
});

test('renderTracker: nunca contém financeiro/interno; escapa nome; 100% dá parabéns', () => {
  const html = renderTracker({ nome: '<b>Jeysa</b>', concluido: true,
    resumo: { pct: 100, procedimentos: [{ nome: 'Doc', status: 'concluido', executor: 'Thais', sessoes: [{ descricao: null, data: '18/07/2026' }] }] },
    proxima: { appointment_date: '2026-07-25', from_time: '14:00' } });
  assert.ok(!/R\$|valor|entrada|orientac|recado/i.test(html));
  assert.ok(html.includes('&lt;b&gt;Jeysa&lt;/b&gt;'));
  assert.ok(/100%/.test(html) && /Parab/i.test(html));
  assert.ok(html.includes('25/07') && html.includes('14:00'));
  assert.ok(/noindex/.test(html));
});

test('renderNeutro: página neutra sem dados', () => {
  const html = renderNeutro();
  assert.ok(/inválido|não disponível/i.test(html) && /noindex/.test(html));
});
```

- [ ] **Step 2: Rodar e ver falhar** — `npm test` → falhas novas de `tracker.test.js` (module not found).

- [ ] **Step 3: Implementar `lib/planejamento/tracker.js`:**

```js
// lib/planejamento/tracker.js — entrega ④: página pública do paciente. Lógica PURA (sem IO/Supabase):
// resumo do plano (progresso/sessões) + render HTML. A rota em server.js só faz as queries e chama aqui.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Primeiro nome p/ saudação: tira o sufixo "(id)" do FIM (padrão Clinicorp) e pega o 1º token. */
function primeiroNome(nome) {
  const limpo = String(nome || '').replace(/\s*\(\d+\)\s*$/, '').trim();
  return limpo.split(/\s+/)[0] || '';
}

const _conc = s => s === 'concluida' || s === 'concluida_retroativa';
const fmtData = iso => { const d = new Date(iso); return isNaN(d) ? null : d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }); };

/**
 * Progresso: etapas concluídas ÷ (todas as etapas + itens raiz sem NENHUMA etapa) —
 * item não detalhado conta 1 pendente (mesma filosofia do temItemSemEtapa da máquina de estados).
 * Etapa sintética (ordem 999 ou descricao == nome do procedimento) vira sessão sem descrição (só a data).
 * Etapas PENDENTES não são listadas (só contam no total) — não expor passo-a-passo futuro.
 */
function resumoTracker(raizes, fallbackExecutor) {
  let done = 0, total = 0;
  const procedimentos = (raizes || []).map(item => {
    const etapas = [...(item.plano_etapas || []), ...((item.sublotes || []).flatMap(s => s.plano_etapas || []))];
    const concluidas = etapas.filter(e => _conc(e.status));
    if (etapas.length) { total += etapas.length; done += concluidas.length; } else { total += 1; }
    const status = etapas.length && concluidas.length === etapas.length ? 'concluido'
      : (concluidas.length ? 'em_andamento' : 'a_fazer');
    const sessoes = concluidas
      .slice().sort((a, b) => String(a.concluida_em || '').localeCompare(String(b.concluida_em || '')))
      .map(e => ({
        descricao: (e.ordem === 999 || e.descricao === item.procedure_name) ? null : (e.descricao || null),
        data: e.concluida_em ? fmtData(e.concluida_em) : null,
      }));
    return { nome: item.procedure_name || '', status, executor: item.profissional_executor || fallbackExecutor || null, sessoes };
  });
  const pct = total ? Math.round((done / total) * 100) : 0;
  return { pct, procedimentos };
}

const ICONE = { concluido: '✅', em_andamento: '🔵', a_fazer: '⚪' };
const ROTULO = { concluido: 'Concluído', em_andamento: 'Em andamento', a_fazer: 'A fazer' };

function _shell(body) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Seu tratamento — Clínica AMA</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f6f8fb;color:#1c2733}
  .wrap{max-width:520px;margin:0 auto;padding:20px 16px 48px}
  h1{font-size:1.35rem;margin:.2em 0}.sub{color:#5b6b7b;margin:0 0 18px}
  .barra{background:#e3e9f0;border-radius:999px;height:14px;overflow:hidden;margin:6px 0 4px}
  .barra i{display:block;height:100%;background:#2f7d4f;border-radius:999px}
  .pct{font-weight:700;color:#2f7d4f}
  .card{background:#fff;border:1px solid #e3e9f0;border-radius:12px;padding:12px 14px;margin:10px 0}
  .card h3{margin:0 0 2px;font-size:1rem}.exec{color:#5b6b7b;font-size:.85rem;margin:0}
  .sess{margin:8px 0 0;padding-left:18px;color:#33414f;font-size:.9rem}.sess li{margin:2px 0}
  .prox{background:#eef6ff;border-color:#cfe3f8}
  .parabens{background:#effaf1;border-color:#bfe6c8;text-align:center;font-weight:600}
  footer{margin-top:22px;color:#5b6b7b;font-size:.85rem;text-align:center}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

function renderTracker({ nome, concluido, resumo, proxima }) {
  const procs = (resumo.procedimentos || []).map(p => `
    <div class="card"><h3>${ICONE[p.status] || ''} ${esc(p.nome)} <small style="color:#5b6b7b;font-weight:400">· ${ROTULO[p.status] || ''}</small></h3>
      ${p.executor ? `<p class="exec">Profissional: ${esc(p.executor)}</p>` : ''}
      ${p.sessoes.length ? `<ul class="sess">${p.sessoes.map(s =>
        `<li>${s.descricao ? `${esc(s.descricao)} — ` : 'Realizado em '}${esc(s.data || '')}</li>`).join('')}</ul>` : ''}
    </div>`).join('');
  const prox = proxima ? `<div class="card prox">📅 Sua próxima consulta: <b>${esc(fmtData(`${proxima.appointment_date}T12:00:00-03:00`) || '')}${proxima.from_time ? ` às ${esc(String(proxima.from_time).slice(0, 5))}` : ''}</b></div>` : '';
  return _shell(`
    <h1>Olá${nome ? `, ${esc(nome)}` : ''}!</h1><p class="sub">Acompanhe seu tratamento na Clínica AMA</p>
    <div class="barra"><i style="width:${Math.max(0, Math.min(100, Number(resumo.pct) || 0))}%"></i></div>
    <p class="pct">${Math.max(0, Math.min(100, Number(resumo.pct) || 0))}% concluído</p>
    ${concluido ? '<div class="card parabens">🎉 Parabéns — seu tratamento foi concluído!</div>' : ''}
    ${prox}${procs}
    <footer>Dúvidas? Fale com a gente no WhatsApp da clínica 💬</footer>`);
}

function renderNeutro() {
  return _shell(`<h1>Link inválido ou tratamento não disponível</h1>
    <p class="sub">Fale com a clínica para receber um novo link de acompanhamento.</p>`);
}

module.exports = { primeiroNome, resumoTracker, renderTracker, renderNeutro };
```

- [ ] **Step 4: Rodar e ver passar** — `npm test` → 5 testes novos PASS, baseline 4 falhas antigas inalterado.

- [ ] **Step 5: Commit**

```bash
git add lib/planejamento/tracker.js lib/planejamento/tracker.test.js
git commit -m "feat(tracker): lib pura do tracker do paciente (progresso, primeiro nome, render HTML) — TDD"
```

---

### Task 3: Server — rota pública `GET /t/:token` + `POST tracker-link`

**Files:**
- Modify: `server.js` — require da lib junto do require de estados (~4998); rota pública no bloco planejamento (logo após `avancarPlanoAposRegistro`); rota tracker-link IMEDIATAMENTE ANTES de `app.post('/api/planejamento/plano/:id/:acao'`.

**Interfaces:**
- Consumes: lib da Task 2; colunas da Task 1; `crypto` (já requerido na linha 10); `rateLimit`; `requireRole('crc_sucesso','gestor','admin','mod_planejamento','dentista')`.
- Produces: `GET /t/:token` (HTML público) e `POST /api/planejamento/plano/:id/tracker-link` body `{acao?:'regenerar'|'revogar'}` → `{url}` | `{revogado:true}` | 409/403. Usados pela Task 4.

- [ ] **Step 1: Require da lib** (junto do require de `./lib/planejamento/estados`):

```js
const trackerLib = require('./lib/planejamento/tracker');
```

- [ ] **Step 2: Rota pública** — colar logo APÓS a função `avancarPlanoAposRegistro` (bloco planejamento; o catch-all da SPA em ~8300 engoliria a rota se ela fosse registrada depois dele):

```js
// ④ Tracker do paciente — página PÚBLICA tokenizada (sem login; rate limit por IP).
// Registrada AQUI (antes do express.static/catch-all da SPA ~8300, que casaria /t/<token> e serviria o login).
// Não colide com o POST /t do pixel (métodos diferentes). Colunas EXPLÍCITAS: financeiro/textos internos
// não podem nem chegar à memória desta rota.
app.get('/t/:token', rateLimit, async (req, res) => {
  res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
  const neutro = () => res.status(200).send(trackerLib.renderNeutro());
  try {
    const token = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return neutro();
    const { data: plano, error } = await supabase.from('plano_tratamento')
      .select('id, status, paciente_nome, paciente_clinicorp_id, dentista_avaliador_id')
      .eq('tracker_token', token).is('tracker_revogado_em', null).maybeSingle();
    if (error) throw error;
    if (!plano || ['descartado', 'cancelado'].includes(plano.status)) return neutro();

    const { data: itensRaw, error: eIt } = await supabase.from('plano_itens')
      .select('id, parent_id, procedure_name, ordem, profissional_executor, plano_etapas(descricao, status, concluida_em, ordem)')
      .eq('plano_id', plano.id).is('removido_em', null).order('ordem');
    if (eIt) throw eIt;
    const raizes = (itensRaw || []).filter(i => !i.parent_id).map(r => ({
      ...r, sublotes: (itensRaw || []).filter(i => i.parent_id === r.id) }));

    // fallback do executor = dentista responsável (mesmo lookup determinístico do endpoint executar)
    let respNome = null;
    if (plano.dentista_avaliador_id) {
      const { data: dd } = await supabase.from('planejamento_dentistas').select('profissional_nome')
        .eq('user_id', plano.dentista_avaliador_id).eq('ativo', true).order('profissional_nome').limit(1);
      respNome = dd?.[0]?.profissional_nome || null;
    }

    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    let proxima = null;
    if (plano.paciente_clinicorp_id) {
      const { data: ag, error: eAg } = await supabase.from('agenda_appointments')
        .select('appointment_date, from_time')
        .eq('paciente_clinicorp_id', plano.paciente_clinicorp_id).eq('deleted', false)
        .gte('appointment_date', hoje).order('appointment_date').order('from_time').limit(1);
      if (eAg) throw eAg;
      proxima = ag?.[0] || null;
    }

    res.send(trackerLib.renderTracker({
      nome: trackerLib.primeiroNome(plano.paciente_nome),
      concluido: plano.status === 'concluido',
      resumo: trackerLib.resumoTracker(raizes, respNome),
      proxima,
    }));
  } catch (e) { console.error('[tracker]', e.message); return neutro(); }   // erro interno também não vaza nada
});
```

- [ ] **Step 3: Rota tracker-link** — colar IMEDIATAMENTE ANTES de `app.post('/api/planejamento/plano/:id/:acao'` (a genérica engoliria com gate errado):

```js
// ④ Gera/copia/regenera/revoga o link do tracker. ANTES da genérica /plano/:id/:acao (ordem = requisito).
// Revogação PEGAJOSA: copiar nunca ressuscita link revogado — só regenerar (gestor/admin).
app.post('/api/planejamento/plano/:id/tracker-link', requireAuth, blockParceiro,
  requireRole('crc_sucesso', 'gestor', 'admin', 'mod_planejamento', 'dentista'), rateLimit, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const acao = (req.body && req.body.acao) || null;    // 'regenerar' | 'revogar' | null (copiar)
    const { data: plano } = await supabase.from('plano_tratamento')
      .select('id, status, tracker_token, tracker_revogado_em').eq('id', id).maybeSingle();
    if (!plano) return res.status(404).json({ error: 'plano não encontrado' });
    if (['descartado', 'cancelado'].includes(plano.status)) return res.status(409).json({ error: 'tratamento não ativo' });
    const roles = req.user.profile?.roles || [];
    const gestor = roles.some(r => ['gestor', 'admin'].includes(r));
    const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const now = new Date().toISOString();

    if (acao === 'revogar') {
      if (!gestor) return res.status(403).json({ error: 'revogar é da gestora' });
      const { error } = await supabase.from('plano_tratamento')
        .update({ tracker_revogado_em: now, atualizado_em: now }).eq('id', id);
      if (error) throw error;
      return res.json({ revogado: true });
    }
    if (acao === 'regenerar') {
      if (!gestor) return res.status(403).json({ error: 'regenerar é da gestora' });
      const t = crypto.randomBytes(24).toString('base64url');
      const { error } = await supabase.from('plano_tratamento')
        .update({ tracker_token: t, tracker_revogado_em: null, atualizado_em: now }).eq('id', id);
      if (error) throw error;
      return res.json({ url: `${base}/t/${t}` });
    }
    if (acao) return res.status(400).json({ error: 'ação inválida' });

    // copiar (default)
    if (plano.tracker_revogado_em) return res.status(409).json({ error: 'link revogado — peça à gestora para regenerar' });
    if (plano.tracker_token) return res.json({ url: `${base}/t/${plano.tracker_token}` });
    const t = crypto.randomBytes(24).toString('base64url');
    const { error } = await supabase.from('plano_tratamento')
      .update({ tracker_token: t, atualizado_em: now }).eq('id', id);
    if (error) throw error;
    res.json({ url: `${base}/t/${t}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
```

- [ ] **Step 4: Verificar**

```bash
node --check server.js
npm test          # baseline: 4 falhas antigas apenas
grep -n "app.get('/t/:token'\|express.static\|plano/:id/tracker-link\|plano/:id/:acao'" server.js
# esperado: /t/:token e tracker-link com linha MENOR que a do express.static e da genérica /:acao
```

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(tracker): rota pública /t/:token (server-rendered, noindex, colunas explícitas) + tracker-link (copiar/regenerar/revogar pegajoso)"
```

---

### Task 4: UI — botão 🔗 no /trilhas/ + links no modal Planejar

**Files:**
- Modify: `public/js/trilhas/app.js` (função `copiarTracker` + export no `window.TrilhasUI`, ~linha 247)
- Modify: `public/trilhas/index.html` (botão na linha da tabela ~705-713; branch no dispatcher de ações ~926-940)
- Modify: `public/js/planejamento/editor.js` (rodapé do modal + handlers)

**Interfaces:**
- Consumes: `POST /api/planejamento/plano/:id/tracker-link` (Task 3); `api()` privado do app.js; `window.TrilhasUI` (padrão existente — o inline chama `TrilhasUI.abrirPlanejar`, seguimos igual).

- [ ] **Step 1: `app.js` — função + export.** Dentro da IIFE (perto de `abrirPlanejar`):

```js
  // ④ copia (ou regenera/revoga — gestora) o link público do tracker do paciente
  async function copiarTracker(planoId, acao) {
    try {
      const r = await api(`/api/planejamento/plano/${planoId}/tracker-link`, { method: 'POST', body: JSON.stringify(acao ? { acao } : {}) });
      if (r.revogado) return alert('Link revogado — o paciente não acessa mais.');
      try { await navigator.clipboard.writeText(r.url); alert('Link copiado — cole no WhatsApp do paciente.'); }
      catch { prompt('Copie o link:', r.url); }
    } catch (e) { alert(e.message); }
  }
```

E **SUBSTITUIR** (não duplicar) a linha existente `window.TrilhasUI = { abrirDrawer, abrirPlanejar };` (~247) por: `window.TrilhasUI = { abrirDrawer, abrirPlanejar, copiarTracker };`

- [ ] **Step 2: `index.html` — botão na linha.** Logo após o bloco do botão `planejar` (~713, `tdActs.appendChild(planejar);`):

```js
  const tlink = document.createElement('button');
  tlink.className = 'pac-act';
  tlink.textContent = '🔗';
  tlink.dataset.id = r.id;
  tlink.dataset.act = 'tracker';
  tlink.dataset.plano = r.plano_id || '';
  tlink.title = r.plano_id ? 'Copiar link de acompanhamento do paciente' : 'Ainda sem planejamento vinculado';
  if (!r.plano_id) tlink.disabled = true;
  tdActs.appendChild(tlink);
```

- [ ] **Step 3: `index.html` — dispatcher.** No handler de cliques das ações (~926-940, junto do case que chama `TrilhasUI.abrirPlanejar`), adicionar ANTES dos outros cases o branch:

```js
      if (actBtn.dataset.act === 'tracker') { if (window.TrilhasUI?.copiarTracker) window.TrilhasUI.copiarTracker(actBtn.dataset.plano); return; }
```

(Seguir o formato exato dos branches vizinhos — se usam `if/else if` sem `return`, adaptar mantendo o estilo.)

- [ ] **Step 4: `editor.js` — rodapé + handlers.** ⚠️ O `bt-fechar` fica FORA do ternário lateral/não-lateral — NÃO colar na linha dele (os botões apareceriam em plano cancelado). Colar **dentro da string do ramo NÃO-lateral do ternário** (a que tem `bt-salvar`/`bt-concluir`/`bt-descartar`), após o `bt-descartar`:

```js
             <button id="bt-tracker" class="btn btn-ghost" title="Copiar link de acompanhamento do paciente">🔗 link do paciente</button>
             <button id="bt-tracker-regen" class="btn btn-ghost" title="Gera um link novo; o antigo para de funcionar (gestora)">regenerar</button>
             <button id="bt-tracker-revogar" class="btn btn-ghost" title="Mata o link sem emitir outro (gestora)">revogar</button>
```

No `dlg.onclick` (junto dos outros ifs) — try/catch LOCAL para o 403 mostrar a mensagem do servidor (o catch global trocaria por MSG_SEM_PERMISSAO, que é sobre planejar):

```js
        if (b.id === 'bt-tracker' || b.id === 'bt-tracker-regen' || b.id === 'bt-tracker-revogar') {
          const acao = b.id === 'bt-tracker-regen' ? 'regenerar' : (b.id === 'bt-tracker-revogar' ? 'revogar' : null);
          if (acao && !confirm('O link atual vai parar de funcionar. Continuar?')) return;
          try {
            const r = await api(`/api/planejamento/plano/${id}/tracker-link`, { method: 'POST', body: JSON.stringify(acao ? { acao } : {}) });
            if (r.revogado) alert('Link revogado — o paciente não acessa mais.');
            else { try { await navigator.clipboard.writeText(r.url); alert('Link copiado — cole no WhatsApp do paciente.'); } catch { prompt('Copie o link:', r.url); } }
          } catch (e2) { alert(e2.message); }
          return;
        }
```

- [ ] **Step 5: Verificar** — `node --check public/js/trilhas/app.js` e `node --check public/js/planejamento/editor.js` (index.html é HTML — conferir o inline visualmente no diff).

- [ ] **Step 6: Commit**

```bash
git add public/js/trilhas/app.js public/trilhas/index.html public/js/planejamento/editor.js
git commit -m "feat(tracker): botão copiar link no /trilhas/ (TrilhasUI.copiarTracker) + link do paciente/regenerar/revogar no modal Planejar"
```

---

### Task 5: Deploy + smoke

- [ ] **Step 1:** `npm test` (baseline) + `node --check` nos 3 JS.
- [ ] **Step 2:** `git fetch origin main` + `git merge-base --is-ancestor origin/main HEAD` (FF-OK; senão rebase). Push via método CredRead comprovado (memória `feedback_git_push_headless.md`): P/Invoke `CredReadW` numa chamada só de PowerShell, URL embutida, helpers desligados, token sanitizado; confirmar por `git rev-list --count origin/main..HEAD` = 0.
- [ ] **Step 3:** `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"` → aguardar swap **pelo conteúdo servido**: `curl -s https://plataformaama-plataforma.uc5as5.easypanel.host/t/tokeninventadoquenaoexiste123` deve retornar a **página neutra do tracker** (contém "Link inválido") e NÃO a SPA (não contém `id="app"` do login) — isso valida o fix do catch-all em produção.
- [ ] **Step 4:** Smoke: `curl -s -o /dev/null -w "%{http_code}" -X POST .../api/planejamento/plano/1/tracker-link` → 401.
- [ ] **Step 5:** Ledger + repassar ao Luiz os 9 testes manuais da spec.

---

## Self-Review (feito na escrita)
- **Cobertura da spec:** migração (T1) · lib progresso/nome/render + nunca-financeiro testado (T2) · rota pública antes do catch-all, colunas explícitas, neutro-200, noindex/no-store, próxima consulta, fallback executor (T3) · copiar/regenerar/revogar pegajoso + ordem antes da genérica (T3) · botão /trilhas/ via TrilhasUI (resolve a ressalva do IIFE seguindo o padrão abrirPlanejar) + modal com 403 local (T4) · deploy com validação do catch-all em produção (T5). Sem lacunas.
- **Placeholders:** nenhum.
- **Consistência:** `trackerLib.{primeiroNome,resumoTracker,renderTracker,renderNeutro}` batem entre T2 e T3; shape `raizes`/`sublotes` = o mesmo do `planCarregarPlano`; body `{acao}` bate entre T3 e T4.
