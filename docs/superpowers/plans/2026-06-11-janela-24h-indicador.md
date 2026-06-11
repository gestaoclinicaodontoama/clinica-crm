# Indicador da Janela de 24h — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar às CRCs, no chat/lista/kanban do WhatsApp, se a janela de 24h do lead está aberta, fechando (com tempo restante) ou fechada — com bloqueio visual + botão de template quando fechada e filtro "Vencendo" na lista.

**Architecture:** O front calcula o estado da janela com uma função pura (`estadoJanela`) a partir da última mensagem recebida. No chat, o timestamp vem das mensagens já carregadas; na lista/kanban, vem da nova coluna `ultima_recebida_em` da RPC `conversas_com_preview` (que ganha o parâmetro `sdr_phone`). O servidor permanece a autoridade do envio (`janela24hAberta` já bloqueia, commit 44192ae).

**Tech Stack:** Node/Express (`server.js`), Supabase Postgres (RPC via migration MCP), front vanilla JS em `public/index.html`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-06-11-janela-24h-indicador-design.md`

**Contexto que o executor precisa saber:**
- Projeto: `C:\Users\Luiz Martins\Desktop\Projeto Claude Code\clinica-crm` (branch main).
- Migrations são aplicadas via MCP Supabase (`apply_migration`, project_id `mtqdpjhhqzvuklnlfpvi`) E versionadas em `supabase/migrations/`.
- Deploy: após `git push`, rodar `curl.exe -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"` (regra do CLAUDE.md). Fazer push+deploy UMA vez, no final.
- `_waDefaultId` (front) = phone_number_id do número SDR 2873, carregado async de `/api/config/wa`; pode estar vazio nos primeiros ms — tratar como "sem filtro de número".
- Testes: `npm test` roda `node --test "lib/**/*.test.js"`.

---

### Task 1: Função pura `estadoJanela` (TDD)

**Files:**
- Create: `public/js/janela24h.js`
- Test: `lib/janela24h.test.js`

- [ ] **Step 1: Write the failing test**

Criar `lib/janela24h.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { estadoJanela, _fmtRestante } = require('../public/js/janela24h');

const H = 3600 * 1000;

test('sem mensagem recebida = fechada', () => {
  const j = estadoJanela(null, Date.now());
  assert.strictEqual(j.estado, 'fechada');
  assert.strictEqual(j.restanteMs, 0);
});

test('recebida há 2h = aberta com ~22h restantes', () => {
  const agora = Date.now();
  const j = estadoJanela(new Date(agora - 2 * H).toISOString(), agora);
  assert.strictEqual(j.estado, 'aberta');
  assert.ok(j.restanteMs > 21 * H && j.restanteMs <= 22 * H);
  assert.match(j.label, /fecha em 21h|fecha em 22h/);
});

test('recebida há 20h = fechando (resta menos que o aviso de 6h)', () => {
  const agora = Date.now();
  const j = estadoJanela(new Date(agora - 20 * H).toISOString(), agora);
  assert.strictEqual(j.estado, 'fechando');
  assert.match(j.label, /responda logo/);
});

test('recebida há 25h = fechada', () => {
  const agora = Date.now();
  const j = estadoJanela(new Date(agora - 25 * H).toISOString(), agora);
  assert.strictEqual(j.estado, 'fechada');
});

test('_fmtRestante: 23h / 5h 32min / 47min / 4h em ponto sem "0min"', () => {
  assert.strictEqual(_fmtRestante(23 * H + 10 * 60000), '23h');
  assert.strictEqual(_fmtRestante(5 * H + 32 * 60000), '5h 32min');
  assert.strictEqual(_fmtRestante(47 * 60000), '47min');
  assert.strictEqual(_fmtRestante(4 * H), '4h');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/janela24h.test.js`
Expected: FAIL — `Cannot find module '../public/js/janela24h'`

- [ ] **Step 3: Write minimal implementation**

Criar `public/js/janela24h.js` (script de navegador com export opcional p/ testes node):

```js
// Janela de atendimento da Meta (24h após a última mensagem RECEBIDA do lead).
// Mesma regra de janela24hAberta() no server.js — aqui é só exibição; o
// servidor continua bloqueando o envio se o front divergir.
const JANELA_TOTAL_MS = 24 * 3600 * 1000;
const JANELA_AVISO_MS = 6 * 3600 * 1000; // 'fechando' quando restar menos que isso

function _fmtRestante(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 10) return h + 'h';
  if (h >= 1) return m > 0 ? h + 'h ' + m + 'min' : h + 'h';
  return m + 'min';
}

// ultimaRecebidaEm: ISO string da última mensagem recebida (já filtrada pelo
// número SDR) ou null. agora: epoch ms (injetável p/ teste; default Date.now()).
function estadoJanela(ultimaRecebidaEm, agora) {
  const now = agora || Date.now();
  if (!ultimaRecebidaEm) return { estado: 'fechada', restanteMs: 0, label: 'Janela de 24h fechada' };
  const restanteMs = new Date(ultimaRecebidaEm).getTime() + JANELA_TOTAL_MS - now;
  if (restanteMs <= 0) return { estado: 'fechada', restanteMs: 0, label: 'Janela de 24h fechada' };
  if (restanteMs <= JANELA_AVISO_MS) {
    return { estado: 'fechando', restanteMs, label: '⏳ Janela fecha em ' + _fmtRestante(restanteMs) + ' — responda logo' };
  }
  return { estado: 'aberta', restanteMs, label: 'Janela aberta — fecha em ' + _fmtRestante(restanteMs) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { estadoJanela, _fmtRestante, JANELA_TOTAL_MS, JANELA_AVISO_MS };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/janela24h.test.js`
Expected: 5 PASS. Depois `npm test` — todos os existentes continuam passando (o glob `lib/**` agora inclui o novo teste).

- [ ] **Step 5: Incluir o script no index.html**

Em `public/index.html`, localizar a linha que carrega o supabase (grep `supabase.min.js`, ~linha 546) e adicionar na linha seguinte, **SEM `defer`** (o mobile-nav.js usa defer; este não pode — precisa estar definido antes dos scripts inline):

```html
<script src="/js/janela24h.js"></script>
```

- [ ] **Step 6: Commit**

```bash
git add public/js/janela24h.js lib/janela24h.test.js public/index.html
git commit -m "feat(janela24h): funcao pura estadoJanela com testes"
```

---

### Task 2: RPC `conversas_com_preview` com `sdr_phone` + `ultima_recebida_em`

**Files:**
- Create: `supabase/migrations/20260611000000_conversas_ultima_recebida.sql`
- Modify: `server.js` (rota `GET /api/conversas`, grep `conversas_com_preview`)

- [ ] **Step 1: Criar a migration**

Conteúdo COMPLETO de `supabase/migrations/20260611000000_conversas_ultima_recebida.sql`:

```sql
-- Indicador da janela de 24h: a lista de conversas precisa da última mensagem
-- RECEBIDA (no número SDR) de cada lead. sdr_phone é passado pelo server
-- (whatsapp.defaultPhoneId()); null = sem filtro de número (fallback).
-- DROP necessário: CREATE com assinatura nova criaria um overload ambíguo no PostgREST.
drop function if exists public.conversas_com_preview();

create or replace function public.conversas_com_preview(sdr_phone text default null)
returns table(
  id bigint, nome text, telefone text, status text, ctwa_clid text,
  texto text, direcao text, criada_em timestamptz, total bigint,
  crc_agendamento_id uuid, crc_agendamento_nome text,
  data_agendamento date, clinicorp_appointment_id text,
  crc_comercial_id uuid, crc_comercial_nome text,
  proximo_contato timestamptz, notas_sdr text, notas_comercial text,
  origem text, perfil_disc text, campanha text, fbclid text, gclid text,
  referral_data jsonb, eventos_meta_enviados text[],
  wa_number_id text, ultima_wa_number_id text, conversa_fixada boolean,
  ultima_recebida_em timestamptz
)
language sql
stable
as $function$
  SELECT l.id, l.nome, l.telefone, l.status, l.ctwa_clid,
    m.texto, m.direcao, m.criada_em, c.total,
    l.crc_agendamento_id, l.crc_agendamento_nome,
    l.data_agendamento, l.clinicorp_appointment_id,
    l.crc_comercial_id, l.crc_comercial_nome, l.proximo_contato,
    l.notas_sdr, l.notas_comercial,
    l.origem, l.perfil_disc, l.campanha, l.fbclid, l.gclid,
    l.referral_data, l.eventos_meta_enviados,
    l.wa_number_id, m.wa_number_id AS ultima_wa_number_id,
    l.conversa_fixada,
    ur.criada_em AS ultima_recebida_em
  FROM leads l
  JOIN LATERAL (SELECT texto, direcao, criada_em, wa_number_id FROM mensagens WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) m ON true
  JOIN LATERAL (SELECT COUNT(*) AS total FROM mensagens WHERE lead_id = l.id) c ON true
  LEFT JOIN LATERAL (
    SELECT criada_em FROM mensagens
    WHERE lead_id = l.id AND direcao = 'recebida'
      AND (sdr_phone IS NULL OR wa_number_id IS NULL OR wa_number_id = '' OR wa_number_id = sdr_phone)
    ORDER BY id DESC LIMIT 1
  ) ur ON true
  ORDER BY l.conversa_fixada DESC, m.criada_em DESC;
$function$;
```

- [ ] **Step 2: Aplicar via MCP Supabase**

`apply_migration` com name `conversas_ultima_recebida`, project_id `mtqdpjhhqzvuklnlfpvi`, query = o SQL acima. Verificar com `list_migrations`.

- [ ] **Step 3: Verificar a RPC no banco**

`execute_sql`: `select id, nome, ultima_recebida_em from conversas_com_preview('993441140514749'::text) limit 5;`
Expected: 5 linhas; `ultima_recebida_em` preenchida para conversas com mensagens recebidas, null para leads que nunca responderam.

- [ ] **Step 4: server.js passa o sdr_phone**

Em `server.js`, na rota `GET /api/conversas`, trocar:

```js
const { data, error } = await supabase.rpc('conversas_com_preview');
```

por:

```js
const { data, error } = await supabase.rpc('conversas_com_preview',
  { sdr_phone: whatsapp.defaultPhoneId() || null });
```

- [ ] **Step 5: Verificar sintaxe e testes**

Run: `node --check server.js` e `npm test`
Expected: sem erro de sintaxe; todos os testes PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260611000000_conversas_ultima_recebida.sql server.js
git commit -m "feat(janela24h): RPC conversas_com_preview com sdr_phone e ultima_recebida_em"
```

---

### Task 3: Faixa da janela no chat + bloqueio quando fechada

**Files:**
- Modify: `public/index.html` (HTML do composer + JS do chat)

- [ ] **Step 1: Dar id ao container do composer e inserir a faixa**

Localizar `<textarea id="chat-input"` (grep). Identificar o `<div>` pai imediato que envolve toda a área de digitação (input + botões 🎙️ 😀 📎 etc.). Adicionar a esse div o id `chat-composer` (se já tiver id, manter o existente e usar esse id no JS do Step 2). Imediatamente ANTES desse div, inserir:

```html
<div id="chat-janela-bar" style="display:none;padding:5px 12px;font-size:11.5px;font-weight:600;border-top:1px solid var(--border)"></div>
```

- [ ] **Step 2: JS — atualizar a faixa e bloquear o composer**

Em `public/index.html`, logo após a função `renderMensagensFixadas` (grep `function renderMensagensFixadas`), adicionar:

```js
// ============ JANELA DE 24H (faixa no chat) ============
let _chatUltimaRecebida = null;

function atualizarJanelaBar(msgs) {
  // última recebida no número SDR (vazio/null = legado, conta como SDR)
  const ultIn = [...(msgs || [])].reverse().find(m =>
    m.direcao === 'recebida' && (!m.wa_number_id || !_waDefaultId || m.wa_number_id === _waDefaultId));
  _chatUltimaRecebida = ultIn ? ultIn.criada_em : null;
  _renderJanelaBar();
}

function _renderJanelaBar() {
  const bar = document.getElementById('chat-janela-bar');
  const composer = document.getElementById('chat-composer');
  if (!bar || !composer) return;
  if (!chatLeadAtual) { bar.style.display = 'none'; composer.style.display = ''; return; }
  const j = estadoJanela(_chatUltimaRecebida);
  bar.style.display = '';
  if (j.estado === 'fechada') {
    composer.style.display = 'none';
    bar.style.background = 'rgba(239,68,68,.12)';
    bar.style.color = 'var(--red)';
    bar.innerHTML = '🔒 Janela de 24h fechada — este número não recebe mensagem livre. ' +
      '<button class="btn" onclick="abrirModalTemplate()" style="margin-left:8px;font-size:12px;background:var(--red);color:#fff;border:none">📢 Enviar template</button>';
  } else {
    composer.style.display = '';
    if (j.estado === 'fechando') {
      bar.style.background = 'rgba(245,158,11,.12)';
      bar.style.color = '#b45309';
    } else {
      bar.style.background = 'rgba(16,185,129,.08)';
      bar.style.color = '#10b981';
    }
    bar.textContent = j.label;
  }
}

// contador anda sozinho (o texto muda mesmo sem mensagens novas)
setInterval(_renderJanelaBar, 60000);
```

- [ ] **Step 3: Ligar nos pontos de atualização**

a) Em `carregarMensagensChat`, logo após a linha `_chatMsgsSig = sig;` (ANTES do early-return `if (!msgs.length)` — senão conversa sem mensagens nunca atualiza a faixa), adicionar:

```js
    atualizarJanelaBar(msgs);
```

b) Em `abrirChat`, logo após a linha `_chatMsgsSig = '';`, adicionar (reset visual: evita mostrar o estado — inclusive composer bloqueado — da conversa anterior enquanto as mensagens da nova carregam):

```js
  _chatUltimaRecebida = null;
  const _jb = document.getElementById('chat-janela-bar');
  if (_jb) _jb.style.display = 'none';
  const _jc = document.getElementById('chat-composer');
  if (_jc) _jc.style.display = '';
```

- [ ] **Step 4: Verificação local**

Run: `node --check server.js` (sanidade) e abrir busca no index.html por `chat-janela-bar` — deve haver 1 ocorrência no HTML e ≥2 no JS. Conferir que `abrirModalTemplate` existe (grep `function abrirModalTemplate`).

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(janela24h): faixa com tempo restante no chat + bloqueio e botao template quando fechada"
```

---

### Task 4: Chips na lista e no kanban

**Files:**
- Modify: `public/index.html` (`renderChatList` e `renderKanban`)

- [ ] **Step 1: Chip na lista**

Em `renderChatList`, dentro do template do item, localizar:

```js
          <span style="font-size:10.5px;color:var(--muted)">${_horaOuData(l.ultima_mensagem_em)}</span>
```

Adicionar imediatamente ANTES dessa linha (dentro do mesmo `<div>` de hora/pin), o cálculo + chip. No início do `leads.map(l => {`, junto de `const unread = _isUnread(l);`, adicionar:

```js
    // guard: se /js/janela24h.js falhar ao carregar, a lista não pode quebrar
    const jan = typeof estadoJanela === 'function' ? estadoJanela(l.ultima_recebida_em) : { estado: 'aberta', restanteMs: 0 };
    const janChip = jan.estado === 'fechando'
      ? `<span style="font-size:9.5px;font-weight:700;color:#b45309;background:rgba(245,158,11,.15);border-radius:4px;padding:1px 5px;white-space:nowrap" title="Janela de 24h fecha em ${_fmtRestante(jan.restanteMs)}">⏳ ${_fmtRestante(jan.restanteMs)}</span>`
      : jan.estado === 'fechada'
      ? `<span style="font-size:9.5px;color:var(--muted);background:rgba(239,68,68,.10);border-radius:4px;padding:1px 5px;white-space:nowrap" title="Janela de 24h fechada — só template">fechada</span>`
      : '';
```

E inserir `${janChip}` antes do span da hora:

```js
          ${janChip}
          <span style="font-size:10.5px;color:var(--muted)">${_horaOuData(l.ultima_mensagem_em)}</span>
```

- [ ] **Step 2: Chip no kanban**

Em `renderKanban`, no template do card, adicionar o MESMO cálculo (`jan`/`janChip`, copiar o bloco do Step 1) junto de `const unread = _isUnread(l);`, e no rodapé do card localizar:

```js
        <div class="kconv-foot">
          <span style="font-size:10px;color:var(--muted)">${_horaOuData(l.ultima_mensagem_em)}</span>
          ${unread ? '<span class="unread-dot"></span>' : ''}
        </div>
```

e incluir o chip:

```js
        <div class="kconv-foot">
          <span style="font-size:10px;color:var(--muted)">${_horaOuData(l.ultima_mensagem_em)}</span>
          ${janChip}
          ${unread ? '<span class="unread-dot"></span>' : ''}
        </div>
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat(janela24h): chips de janela fechando/fechada na lista e no kanban"
```

---

### Task 5: Filtro "⏳ Vencendo" na lista

**Files:**
- Modify: `public/index.html` (HTML do botão + `filtrarChats`)

- [ ] **Step 1: Botão no HTML**

Localizar o botão `id="btn-filtro-nao-lidas"` (grep). Imediatamente APÓS ele, adicionar (copiando o estilo inline do botão de não lidas, trocando texto/handler):

```html
<button id="btn-filtro-vencendo" onclick="toggleFiltroVencendo()" title="Mostrar apenas janelas vencendo" style="font-size:11px;padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--muted);cursor:pointer;white-space:nowrap">⏳ Vencendo</button>
```

(Se o botão de não lidas usar classes em vez de style inline, replicar exatamente o mesmo padrão dele.)

- [ ] **Step 2: JS do toggle + filtro**

Logo após a função `toggleFiltroNaoLidas` (grep `function toggleFiltroNaoLidas`), adicionar:

```js
let _filtroVencendo = false;

function toggleFiltroVencendo() {
  _filtroVencendo = !_filtroVencendo;
  const btn = document.getElementById('btn-filtro-vencendo');
  if (btn) {
    btn.style.background = _filtroVencendo ? '#b45309' : 'var(--bg2)';
    btn.style.color = _filtroVencendo ? '#fff' : 'var(--muted)';
    btn.title = _filtroVencendo ? 'Mostrar todas' : 'Mostrar apenas janelas vencendo';
  }
  filtrarChats();
}
```

Em `filtrarChats`, após a linha `if (_filtroNaoLidas) base = base.filter(l => _isUnread(l));`, adicionar:

```js
  if (_filtroVencendo && typeof estadoJanela === 'function') base = base.filter(l => estadoJanela(l.ultima_recebida_em).estado === 'fechando');
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat(janela24h): filtro Vencendo na lista de conversas"
```

---

### Task 6: Push, deploy e validação manual

- [ ] **Step 1: Testes finais**

Run: `npm test` e `node --test whatsapp.test.js` e `node --check server.js`
Expected: tudo PASS.

- [ ] **Step 2: Push + deploy**

```bash
git push
curl.exe -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

Aguardar e conferir: `https://plataformaama-plataforma.uc5as5.easypanel.host/health` → `{"ok":true}` e `/api/version` com `deployedAt` recente.

- [ ] **Step 3: Validação manual (roteiro do spec)**

1. Lead que respondeu há pouco → faixa 🟢 verde com tempo correto; sem chip na lista.
2. Lead com resposta entre 18h e 24h atrás → faixa 🟡 + chip `⏳ Xh` na lista/kanban; filtro "Vencendo" exibe só ele.
3. Lead da lista de não-entregues (ex.: David #14458) → faixa 🔴, composer oculto, botão "📢 Enviar template" abre o modal.
4. Teste com número próprio: responder no WhatsApp → em ≤8s a faixa muda pra 🟢 e o composer reaparece sem recarregar.
5. Atualizar item nas pendências (`pending_tests.md` da memória) com o que falta o Luiz validar.
