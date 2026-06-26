# Softphone padrão SDK 3C — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o click-to-call do CRM confiável trocando o iframe "burro" pelo padrão do SDK 3C — iframe SIP oculto + eventos Socket.io + reconexão automática + checagem de prontidão antes de discar.

**Architecture:** O disparo via API (`/api/leads/:id/ligar` → `enter`→`dial`) e o cron de polling de log permanecem inalterados. A mudança é só na gestão do ramal WebRTC no front: uma conexão Socket.io (`https://socket.3c.plus`) acompanha o estado do agente (`agent-is-connected`, `agent-was-logged-out`, `call-was-*`), uma máquina de estado baseada em flags decide se está "pronto", e a queda do iframe/socket dispara reconexão com backoff. Liberado por usuário via `profiles.softphone_modo` ('iframe' default | 'sdk'); só a Paola entra no modo novo primeiro.

**Tech Stack:** Node.js + Express (`server.js`), front HTML/JS puro (`public/index.html`), Supabase (Postgres), socket.io-client v4.7.2 via CDN.

## Global Constraints

- Front-end é JS vanilla dentro de `public/index.html` — sem framework, sem bundler, sem test runner. Verificação é por console do navegador + teste manual.
- Socket.io client: **exatamente v4.7.2** (`https://cdn.socket.io/4.7.2/socket.io.min.js`, com `integrity="sha384-mZLF4UVrpi/QTWPA7BjNPEnkIfRFn4ZEO3Qt/HFklTJBj/gBOV8G3HcKn4NfQblz" crossorigin="anonymous"`) — casar com o servidor do 3C; v2/v3 são incompatíveis.
- Base do iframe SIP: `https://clnicaama.3c.plus/extension?api_token=<agentToken>` (domínio "clnicaama", sem 'i' — já confirmado em produção).
- Socket: `io('https://socket.3c.plus', { transports:['websocket'], query:{ token: <agentToken> } })`.
- **Não** alterar `lib/3cplus.js` nem `/api/leads/:id/ligar`.
- O caminho 'iframe' atual (widget arrastável) deve continuar funcionando intacto para quem não está em 'sdk'.
- Supabase project_id: `mtqdpjhhqzvuklnlfpvi`. Migrações aplicadas via MCP Supabase.
- Deploy: após `git push`, `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`.
- ⚠️ Working dir compartilhado entre sessões: checar branch antes de commitar; `git add` só os arquivos desta feature.

---

### Task 1: Migração — coluna `softphone_modo` em `profiles`

**Files:**
- Migration aplicada via MCP Supabase (nome: `add_softphone_modo_to_profiles`).

**Interfaces:**
- Produces: coluna `profiles.softphone_modo text not null default 'iframe'` (valores usados: `'iframe'`, `'sdk'`).

- [ ] **Step 1: Inspecionar a tabela `profiles`**

Use a tool MCP Supabase `list_tables` (schema `public`) e confirme que `profiles` existe e ainda não tem `softphone_modo`.

- [ ] **Step 2: Aplicar a migração**

Via MCP Supabase `apply_migration`, name `add_softphone_modo_to_profiles`, query:

```sql
alter table public.profiles
  add column if not exists softphone_modo text not null default 'iframe';

comment on column public.profiles.softphone_modo is
  'Modo do softphone 3cplus: iframe (legado) | sdk (padrão SDK com socket.io + reconexão)';
```

- [ ] **Step 3: Verificar a coluna e ligar a Paola no modo sdk**

Via MCP Supabase `execute_sql`:

```sql
update public.profiles p
set softphone_modo = 'sdk'
where p.id in (
  select id from public.profiles
  where threec_agent_ramal = '1002'    -- Paola Cristine (ramal 1002)
     or lower(nome) like 'paola%'
);

select id, nome, threec_agent_ramal, softphone_modo
from public.profiles
where softphone_modo = 'sdk';
```

Expected: a linha da Paola aparece com `softphone_modo = 'sdk'`. Se nenhuma linha voltar, ajustar o filtro (confirmar o nome/ramal da Paola na tabela) e repetir.

- [ ] **Step 4: Commit (registro da migração)**

Se a migração gerar arquivo local em `supabase/migrations/`, commitar:

```bash
git add supabase/migrations/
git commit -m "feat(softphone): coluna softphone_modo em profiles (gate iframe|sdk)"
```

Se o MCP não gerar arquivo local, pular o commit (a migração já está no banco) e seguir.

---

### Task 2: Backend — expor `softphone_modo` em `loadProfile` e `/api/me`

**Files:**
- Modify: `server.js` (função `loadProfile`, ~linha 322-328; handler `/api/me`, ~linha 240-248)

**Interfaces:**
- Consumes: coluna `profiles.softphone_modo` (Task 1).
- Produces: `/api/me` retorna `softphone_modo: 'iframe'|'sdk'`; `req.user.profile.softphone_modo` disponível nos handlers.

- [ ] **Step 1: Incluir a coluna no select de `loadProfile`**

Em `server.js`, no `.select(...)` de `loadProfile` (atualmente `'id, nome, roles, threec_agent_token, threec_agent_ramal, threec_agent_id'`), adicionar `softphone_modo`:

```js
const { data } = await supabase.from('profiles')
  .select('id, nome, roles, threec_agent_token, threec_agent_ramal, threec_agent_id, softphone_modo').eq('id', req.user.id).maybeSingle();
```

- [ ] **Step 2: Devolver `softphone_modo` no `/api/me`**

No objeto de resposta do handler `GET /api/me` (junto de `threec_agent_token`/`threec_agent_ramal`), adicionar:

```js
      threec_agent_token: profile?.threec_agent_token || null,
      threec_agent_ramal: profile?.threec_agent_ramal || null,
      softphone_modo: profile?.softphone_modo || 'iframe',
```

- [ ] **Step 3: Verificar (lint de sintaxe + boot)**

Run: `node -c server.js`
Expected: sem erro de sintaxe.

(O retorno real do `/api/me` exige login; será validado na Task 7 com a Paola.)

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(softphone): /api/me e loadProfile expõem softphone_modo"
```

---

### Task 3: Front — carregar socket.io e montar iframe oculto + pílula de status

**Files:**
- Modify: `public/index.html` (adicionar `<script>` do socket.io no topo; adicionar elementos do modo sdk perto do `#softphone-widget`, ~linha 5842-5854)

**Interfaces:**
- Produces: no DOM — `#sip-extension-frame` (iframe oculto), `#sip-status-pill` com `#sip-status-dot`, `#sip-status-text`, `#sip-reconnect-btn`; `window.io` disponível (socket.io v4.7.2).

- [ ] **Step 1: Adicionar o script do socket.io-client**

No `<head>` do `public/index.html` (ou logo antes do primeiro `<script>` próprio), adicionar (com Subresource Integrity — hash sha384 já computado para o arquivo v4.7.2):

```html
<script src="https://cdn.socket.io/4.7.2/socket.io.min.js"
  integrity="sha384-mZLF4UVrpi/QTWPA7BjNPEnkIfRFn4ZEO3Qt/HFklTJBj/gBOV8G3HcKn4NfQblz"
  crossorigin="anonymous"></script>
```

- [ ] **Step 2: Adicionar iframe oculto + pílula de status do modo sdk**

Logo após o bloco `<div id="softphone-widget" ...>...</div>` (que termina ~linha 5854), adicionar:

```html
<!-- Softphone modo SDK: iframe SIP oculto + pílula de status (só para softphone_modo === 'sdk') -->
<iframe id="sip-extension-frame"
  style="position:absolute;width:1px;height:1px;left:-9999px;top:-9999px;opacity:0;pointer-events:none"
  allow="microphone; autoplay"></iframe>
<div id="sip-status-pill" style="display:none;position:fixed;bottom:16px;right:16px;z-index:9000;align-items:center;gap:8px;background:#1a1a2e;color:#fff;padding:8px 14px;border-radius:20px;font-size:13px;box-shadow:0 2px 10px rgba(0,0,0,.25)">
  <span id="sip-status-dot" style="font-size:14px;color:#d97706">●</span>
  <span id="sip-status-text">Conectando…</span>
  <button id="sip-reconnect-btn" title="Reconectar" style="display:none;background:none;border:none;color:#fff;cursor:pointer;font-size:15px;padding:0 2px">↻</button>
</div>
```

- [ ] **Step 3: Verificar no navegador**

Abrir o CRM logado como admin (que NÃO é 'sdk') → a pílula deve ficar **escondida** (`display:none`) e nada deve quebrar. No console:

Run (no console do navegador): `typeof io`
Expected: `"function"` (socket.io carregou).
Run: `document.getElementById('sip-extension-frame') && document.getElementById('sip-status-pill')`
Expected: retorna um elemento (não `null`).

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(softphone): socket.io v4.7.2 + iframe SIP oculto e pílula de status (modo sdk)"
```

---

### Task 4: Front — módulo `SoftphoneSDK` (socket + máquina de estado por flags)

**Files:**
- Modify: `public/index.html` (adicionar o módulo num `<script>`, perto do `initSoftphone` existente, ~linha 5856-5875)

**Interfaces:**
- Consumes: `#sip-extension-frame`, `#sip-status-pill` e filhos (Task 3); `window.io` (Task 3).
- Produces: `window.SoftphoneSDK` com `init(agentToken)`, `isPronto()`, `getEstado()`, `reconnect()`.

- [ ] **Step 1: Adicionar o módulo `SoftphoneSDK`**

Adicionar este `<script>` no `public/index.html` (perto do `initSoftphone`):

```html
<script>
// Softphone modo SDK — padrão do SDK oficial 3C (github.com/wosiak/3cplus-sdk):
// iframe SIP oculto + socket.io para estado do agente + reconexão automática.
// Estado por flags (evita chicken-and-egg: o agente só loga em campanha no discar,
// então "pronto" = socket conectado + iframe SIP carregado, sem logout pendente).
window.SoftphoneSDK = (function () {
  const BACKOFF = [1000, 3000, 10000, 30000];
  let socket = null, token = null;
  let socketConnected = false, iframeLoaded = false, loggedOut = false, inCall = false;
  let reconnectAttempt = 0, reconnectTimer = null;

  function setPill(cor, label, showBtn) {
    const dot = document.getElementById('sip-status-dot');
    const txt = document.getElementById('sip-status-text');
    const btn = document.getElementById('sip-reconnect-btn');
    if (dot) dot.style.color = cor;
    if (txt) txt.textContent = label;
    if (btn) btn.style.display = showBtn ? 'inline-block' : 'none';
  }

  function estado() {
    if (inCall) return 'em_ligacao';
    if (loggedOut) return 'desconectado';
    if (socketConnected && iframeLoaded) return 'pronto';
    return 'conectando';
  }

  function render() {
    const e = estado();
    if (e === 'em_ligacao') setPill('#16a34a', 'Em ligação', false);
    else if (e === 'pronto') setPill('#16a34a', 'Softphone conectado', false);
    else if (e === 'desconectado') setPill('#dc2626', 'Desconectado', true);
    else setPill('#d97706', 'Reconectando…', false);
  }

  function loadIframe() {
    const iframe = document.getElementById('sip-extension-frame');
    if (!iframe || !token) return;
    iframeLoaded = false;
    iframe.src = 'https://clnicaama.3c.plus/extension?api_token=' + encodeURIComponent(token);
  }

  function connectSocket() {
    if (typeof io === 'undefined') { console.warn('[sip] socket.io não carregado'); return; }
    if (socket) { try { socket.disconnect(); } catch (e) {} socket = null; }
    socketConnected = false;
    socket = io('https://socket.3c.plus', { transports: ['websocket'], query: { token } });
    socket.on('connect', () => { socketConnected = true; loggedOut = false; render(); console.log('[sip] socket conectado'); });
    socket.on('disconnect', () => { socketConnected = false; render(); agendarReconexao(); });
    socket.on('agent-is-connected', () => { loggedOut = false; render(); });
    socket.on('agent-is-idle', () => { if (!inCall) { loggedOut = false; render(); } });
    socket.on('call-was-connected', () => { inCall = true; render(); });
    ['call-was-finished', 'call-was-not-answered', 'call-was-failed'].forEach(ev =>
      socket.on(ev, () => { inCall = false; render(); }));
    socket.on('agent-was-logged-out', () => { loggedOut = true; render(); reconnect(); });
    socket.on('error', (e) => console.warn('[sip] socket error', e));
    socket.on('exception', (e) => console.warn('[sip] socket exception', e));
  }

  function agendarReconexao() {
    if (reconnectTimer) return;
    const delay = BACKOFF[Math.min(reconnectAttempt, BACKOFF.length - 1)];
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; reconnect(); }, delay);
  }

  function reconnect() {
    render();
    loadIframe();
    connectSocket();
  }

  function init(agentToken) {
    token = agentToken;
    reconnectAttempt = 0;
    const pill = document.getElementById('sip-status-pill');
    if (pill) pill.style.display = 'flex';
    const btn = document.getElementById('sip-reconnect-btn');
    if (btn) btn.onclick = () => { reconnectAttempt = 0; reconnect(); };
    const iframe = document.getElementById('sip-extension-frame');
    if (iframe) iframe.addEventListener('load', () => { iframeLoaded = true; render(); console.log('[sip] iframe SIP carregado'); });
    reconnect();
  }

  return { init, isPronto: () => estado() === 'pronto' || estado() === 'em_ligacao', getEstado: estado, reconnect };
})();
</script>
```

- [ ] **Step 2: Verificar sintaxe via navegador**

Abrir o CRM, console:
Run: `typeof SoftphoneSDK.init`
Expected: `"function"`. Sem erros de parse no console.

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat(softphone): módulo SoftphoneSDK (socket.io + máquina de estado por flags)"
```

---

### Task 5: Front — ligar o modo sdk no `initSoftphone` e no `_garantirSoftfoneAberto`

**Files:**
- Modify: `public/index.html` — `initSoftphone` (~linha 5858-5875) e `_garantirSoftfoneAberto` (~linha 2328-2340)

**Interfaces:**
- Consumes: `window.SoftphoneSDK` (Task 4); `/api/me` agora com `softphone_modo` (Task 2).
- Produces: variável `_softphoneSdkMode` (bool) usada pelo gate de discagem.

- [ ] **Step 1: Branch do modo sdk no `initSoftphone`**

Localizar `let _softphoneInited = false;` e adicionar logo abaixo:

```js
let _softphoneSdkMode = false;
```

Dentro de `initSoftphone`, logo após `if (!me?.threec_agent_token) return;` e `_softphoneInited = true;`, inserir o desvio para o modo sdk **antes** do código do iframe legado:

```js
    _softphoneInited = true;
    if (me.softphone_modo === 'sdk') {
      _softphoneSdkMode = true;
      SoftphoneSDK.init(me.threec_agent_token);
      return;
    }
    // --- caminho legado (iframe widget) abaixo, inalterado ---
```

- [ ] **Step 2: Gate de prontidão no `_garantirSoftfoneAberto`**

No início de `_garantirSoftfoneAberto()`, antes da lógica atual do widget, inserir:

```js
function _garantirSoftfoneAberto() {
  if (_softphoneSdkMode) {
    if (SoftphoneSDK.isPronto()) return true;
    SoftphoneSDK.reconnect();
    toast('📞 Softfone reconectando. Aguarde o indicador ficar verde e tente de novo.', true);
    return false;
  }
  // --- lógica legada do widget abaixo, inalterada ---
```

- [ ] **Step 3: Verificar (admin não-sdk segue normal)**

Logado como usuário NÃO-sdk: a pílula fica escondida, o widget legado continua igual, e `_softphoneSdkMode` é `false` no console. Sem erros.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(softphone): initSoftphone e gate de discagem respeitam softphone_modo=sdk"
```

---

### Task 6: Deploy + smoke test (sem CRC ainda)

**Files:** nenhum (deploy).

- [ ] **Step 1: Push + deploy**

```bash
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

Expected: deploy aceito. Aguardar o serviço subir.

- [ ] **Step 2: Smoke test logado como admin (não-sdk)**

Abrir o CRM em produção logado como admin. Confirmar:
- A pílula `#sip-status-pill` está escondida.
- O softphone widget legado (📞) aparece como antes.
- Console sem erros novos; `typeof io === 'function'`.

Se algo quebrou para o admin, **parar** e corrigir antes de envolver a Paola (o caminho legado não pode regredir).

---

### Task 7: Validação com a Paola (modo sdk, ligação real)

**Files:** nenhum (validação manual + possíveis ajustes).

> Esta é a tarefa que resolve os riscos do spec (auth do socket, sinal de SIP registrado). Fazer junto com a Paola, com o console do navegador aberto.

- [ ] **Step 1: Confirmar `/api/me` da Paola**

Logada como Paola, no console: `fetch('/api/me').then(r=>r.json()).then(j=>console.log(j.softphone_modo, !!j.threec_agent_token))`
Expected: `sdk true`.

- [ ] **Step 2: 🔴 Risco #1 — auth do socket**

Observar o console ao abrir o CRM. Esperado: `[sip] socket conectado` e (idealmente) a pílula virar 🟢 "Softphone conectado".
- Se o socket **conecta** → risco #1 resolvido (api_token estático serve).
- Se o socket **não conecta / desconecta na hora** → registrar o erro do `socket.on('error'/'exception')`. Acionar o Plano B do spec (endpoint `authenticate` no servidor) numa tarefa futura — **não** improvisar guardando senha aqui.

- [ ] **Step 3: Confirmar o sinal de "SIP registrado"**

Observar quais eventos chegam após o `iframe SIP carregado` (logar todos com um listener temporário se preciso). Anotar qual evento de fato indica que o áudio está pronto. Ajustar a definição de `pronto` em `SoftphoneSDK` se o observado divergir (ex.: exigir `agent-is-connected` além das flags). Commitar o ajuste se houver.

- [ ] **Step 4: Ligação real**

Com a pílula 🟢, a Paola clica "📞 Ligar" num lead de teste (o telefone dela). Esperado: o telefone toca, conecta no destino, `call-was-connected` no console, pílula vira "Em ligação", e ao desligar volta a 🟢.

- [ ] **Step 5: Teste de recuperação**

Paola navega para uma página separada do CRM (ex.: abrir um módulo `mode:'link'`) e volta, ou dá F5. Esperado: a pílula reconecta sozinha em segundos e o "Ligar" volta a funcionar sem ação manual. Testar também o botão ↻ da pílula.

- [ ] **Step 6: Teste de bloqueio**

Forçar desconexão (desligar wifi 5s / `SoftphoneSDK` em 🔴) e clicar "Ligar". Esperado: não dispara a API, mostra o toast "Softfone reconectando…".

- [ ] **Step 7: Registrar resultado**

Anotar no spec/memória o resultado dos riscos (#1 socket auth, sinal de SIP). Se tudo ok → próxima tarefa (fora deste plano): ligar as outras 4 CRCs em 'sdk' e aposentar o caminho legado.

---

## Notas de execução

- **Ordem:** Tasks 1→6 podem ser feitas numa sessão; a Task 7 depende da Paola disponível.
- **Rollback seguro:** enquanto só a Paola está em 'sdk', reverter é trivial — `update profiles set softphone_modo='iframe' where ...` devolve ela ao caminho legado sem deploy.
- **Fase 2 (fora deste plano):** log/análise em tempo real via `call-was-finished`/`call-history-was-created`; status ao vivo no painel do lead; UI de admin pra alternar o modo por usuário; rollout para as 5 CRCs + aposentar o iframe legado.
