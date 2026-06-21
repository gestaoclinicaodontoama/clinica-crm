# Disparo — Seletor de Número + Filtro de Conversas por Campanha — Plano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir escolher o número de WhatsApp na hora do Disparo em Massa (padrão 2873) e filtrar as Conversas por campanha de disparo.

**Architecture:** Estende o módulo Disparo em Massa existente. `enviarBroadcast()` passa a aceitar o número; o runner usa o número gravado na campanha; um guardrail pausa a campanha se o template não existir naquele número. Nas Conversas, um filtro opcional `?campanha_id` restringe a lista aos leads que receberam aquele disparo.

**Tech Stack:** Node.js + Express (`server.js`), HTML/JS vanilla (`public/index.html`), Supabase (Postgres), WhatsApp Cloud API (Meta). Testes com `node:test`.

## Global Constraints

- Project Supabase: `mtqdpjhhqzvuklnlfpvi`. Migrações via MCP Supabase, ordem crescente de timestamp.
- Deploy: após `git push`, deploy Easypanel CRM: `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`.
- Número padrão do disparo = **2873** = `whatsapp.defaultPhoneId()`.
- Só números **com token** (`getPhoneNumbers()` = 2873 e 8700) podem disparar; nunca os IDs auto-descobertos.
- Supabase JS trunca em 1000 linhas: paginar qualquer leitura que possa passar disso.
- `enviarBroadcast` sem `phoneNumberId` DEVE manter o comportamento atual (número de broadcast).
- Testes em `lib/**` rodam com `npm test`. Testes de `whatsapp.js` (raiz) rodam explícitos: `node --test whatsapp.broadcast.test.js`.

---

### Task 1: `enviarBroadcast` aceita `phoneNumberId`

**Files:**
- Modify: `whatsapp.js:90-104` (função `enviarBroadcast`)
- Test: `whatsapp.broadcast.test.js` (criar na raiz)

**Interfaces:**
- Produces: `enviarBroadcast({ para, templateName, lang='pt_BR', variaveis=[], phoneNumberId })` — `phoneNumberId` opcional; ausente ⇒ usa `WA_BROADCAST_PHONE_ID`. O token é resolvido por `_tokenForPhone(pid)` (broadcast token se `pid===WA_BROADCAST_PHONE_ID`, senão `WA_TOKEN`).

- [ ] **Step 1: Write the failing test**

Criar `whatsapp.broadcast.test.js`:

```js
// Env precisa existir ANTES do require (tokens lidos no load do módulo).
process.env.WHATSAPP_API_TOKEN = 'sdr-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '2873id';
process.env.WHATSAPP_BROADCAST_TOKEN = 'bcast-token';
process.env.WHATSAPP_BROADCAST_PHONE_ID = '8700id';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const wa = require('./whatsapp');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function mockCapture() {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, auth: opts?.headers?.Authorization, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.X' }] }) };
  };
  return calls;
}

test('sem phoneNumberId usa o número de broadcast (8700) e seu token', async () => {
  const calls = mockCapture();
  await wa.enviarBroadcast({ para: '5531999990000', templateName: 'tpl', variaveis: ['Ana'] });
  assert.ok(calls[0].url.includes('/8700id/messages'), calls[0].url);
  assert.strictEqual(calls[0].auth, 'Bearer bcast-token');
  assert.strictEqual(calls[0].body.template.name, 'tpl');
});

test('com phoneNumberId do 2873 envia por ele com o token do SDR', async () => {
  const calls = mockCapture();
  await wa.enviarBroadcast({ para: '5531999990000', templateName: 'tpl', variaveis: ['Ana'], phoneNumberId: '2873id' });
  assert.ok(calls[0].url.includes('/2873id/messages'), calls[0].url);
  assert.strictEqual(calls[0].auth, 'Bearer sdr-token');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test whatsapp.broadcast.test.js`
Expected: o 2º teste FALHA (envia pelo 8700id mesmo passando `phoneNumberId`), porque a função ainda ignora o parâmetro.

- [ ] **Step 3: Write minimal implementation**

Substituir `whatsapp.js:90-104` por:

```js
// Número de template (broadcast). phoneNumberId opcional: dispara por outro número
// configurado (ex.: 2873). Sem ele, usa o número de broadcast padrão (8700).
async function enviarBroadcast({ para, templateName, lang = 'pt_BR', variaveis = [], phoneNumberId }) {
  const pid = phoneNumberId || WA_BROADCAST_PHONE_ID;
  const token = _tokenForPhone(pid);
  if (!pid || !token) throw new Error('Número de envio (template) não configurado');
  const numero = limparNumero(para);
  return _post(pid, token, {
    messaging_product: 'whatsapp', to: numero,
    type: 'template',
    template: {
      name: templateName,
      language: { code: lang },
      ...(variaveis.length > 0 && {
        components: [{ type: 'body', parameters: variaveis.map(v => ({ type: 'text', text: String(v) })) }],
      }),
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test whatsapp.broadcast.test.js`
Expected: PASS (2 testes).

- [ ] **Step 5: Run a regressão do envio existente**

Run: `node --test whatsapp.envio.test.js`
Expected: PASS (5 testes) — nada quebrou.

- [ ] **Step 6: Commit**

```bash
git add whatsapp.js whatsapp.broadcast.test.js
git commit -m "feat(whatsapp): enviarBroadcast aceita phoneNumberId (dispara por número escolhido)"
```

---

### Task 2: Migração — coluna `wa_number_id` em `disparos_campanhas`

**Files:**
- Create: `supabase/migrations/20260620000000_disparos_wa_number.sql`

**Interfaces:**
- Produces: coluna `disparos_campanhas.wa_number_id text` (nullable). `NULL` = comportamento antigo (broadcast).

- [ ] **Step 1: Criar o arquivo de migração**

`supabase/migrations/20260620000000_disparos_wa_number.sql`:

```sql
-- Número de WhatsApp escolhido para o disparo (phone_number_id da Meta).
-- NULL = usa o número de broadcast padrão (comportamento anterior).
ALTER TABLE disparos_campanhas ADD COLUMN IF NOT EXISTS wa_number_id text;
```

- [ ] **Step 2: Aplicar via MCP Supabase**

Aplicar a migração (`apply_migration`, name `disparos_wa_number`, project `mtqdpjhhqzvuklnlfpvi`).

- [ ] **Step 3: Verificar**

Rodar `list_migrations` (MCP) e confirmar `20260620000000` presente. E:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name='disparos_campanhas' AND column_name='wa_number_id';
```
Expected: 1 linha.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260620000000_disparos_wa_number.sql
git commit -m "feat(disparos): migracao coluna wa_number_id na campanha"
```

---

### Task 3: Helper de detecção de erro de template indisponível

**Files:**
- Create: `lib/disparos/erro-template.js`
- Test: `lib/disparos/erro-template.test.js`

**Interfaces:**
- Produces: `templateIndisponivel(err) -> boolean`. `true` quando o erro da Meta indica template inexistente/pausado no número (códigos `132001`/`132007`, ou texto com "template" + "does not exist"/"not found"). Consome `err.code` e `err.metaMessage`/`err.message` (forma produzida por `_erroMeta` em `whatsapp.js`).

- [ ] **Step 1: Write the failing test**

`lib/disparos/erro-template.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { templateIndisponivel } = require('./erro-template');

test('code 132001 (template não existe) é template indisponível', () => {
  assert.strictEqual(templateIndisponivel({ code: 132001, message: 'x' }), true);
});

test('code 132007 (template pausado/rejeitado) é template indisponível', () => {
  assert.strictEqual(templateIndisponivel({ code: 132007 }), true);
});

test('mensagem textual sem code também é detectada', () => {
  assert.strictEqual(templateIndisponivel({ metaMessage: 'Template name does not exist in the translation' }), true);
});

test('erro comum (janela 24h, code 131047) NÃO é template indisponível', () => {
  assert.strictEqual(templateIndisponivel({ code: 131047, message: 'Re-engagement message' }), false);
});

test('erro sem code nem texto relevante NÃO casa', () => {
  assert.strictEqual(templateIndisponivel({ message: 'rede caiu' }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/disparos/erro-template.test.js`
Expected: FAIL ("Cannot find module './erro-template'").

- [ ] **Step 3: Write minimal implementation**

`lib/disparos/erro-template.js`:

```js
// Detecta erro da Meta de "template indisponível no número" (WABA diferente,
// template inexistente/pausado). Usado pelo runner para pausar a campanha
// inteira em vez de queimar todos os contatos.
const CODES = new Set([132001, 132007]);

function templateIndisponivel(err) {
  if (!err) return false;
  if (CODES.has(err.code)) return true;
  const texto = String(err.metaMessage || err.message || '').toLowerCase();
  return texto.includes('template') && (texto.includes('does not exist') || texto.includes('not found'));
}

module.exports = { templateIndisponivel };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/disparos/erro-template.test.js`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/disparos/erro-template.js lib/disparos/erro-template.test.js
git commit -m "feat(disparos): helper templateIndisponivel para guardrail de WABA"
```

---

### Task 4: Runner usa o número da campanha + guardrail

**Files:**
- Modify: `lib/disparos/runner.js:69-72` (chamada `enviarBroadcast`), `:75-79` (insert em `mensagens`), `:92-100` (catch)

**Interfaces:**
- Consumes: `enviarBroadcast({ ..., phoneNumberId })` (Task 1), `templateIndisponivel(err)` (Task 3), `camp.wa_number_id` (Task 2).

> Sem harness de teste para o runner (segue o padrão do codebase: runner não é unit-testado; a lógica testável foi extraída para os helpers das Tasks 1 e 3). Verificação aqui é por leitura + teste real no deploy (Task 9 / verificação final).

- [ ] **Step 1: Passar o número no envio**

Em `lib/disparos/runner.js`, substituir a chamada (linhas 69-72):

```js
      const resultado = await whatsapp.enviarBroadcast({
        para: contato.telefone, templateName: camp.template_nome,
        lang: camp.lang, variaveis,
      });
```
por:
```js
      const resultado = await whatsapp.enviarBroadcast({
        para: contato.telefone, templateName: camp.template_nome,
        lang: camp.lang, variaveis,
        phoneNumberId: camp.wa_number_id || undefined,
      });
```

- [ ] **Step 2: Registrar a mensagem no número certo**

Na inserção em `mensagens` (linha 78), trocar:
```js
        wa_id: waId, wa_number_id: whatsapp.broadcastPhoneId() || '',
```
por:
```js
        wa_id: waId, wa_number_id: camp.wa_number_id || whatsapp.broadcastPhoneId() || '',
```

- [ ] **Step 3: Guardrail no catch**

No topo do arquivo, ao lado de `const { resolverLead } = require('./matching');`, adicionar:
```js
const { templateIndisponivel } = require('./erro-template');
```

Substituir o bloco `catch (e) { ... }` (linhas 92-100) por:
```js
    } catch (e) {
      // Template indisponível neste número (WABA diferente): pausa a campanha
      // inteira preservando os 'pendente', em vez de queimar todos os contatos.
      if (templateIndisponivel(e)) {
        const motivo = 'Template "' + camp.template_nome + '" indisponível no número escolhido — verifique a WABA. ' + String(e.message || e);
        await supabase.from('disparos_contatos').update({
          status: 'falha', erro: motivo.slice(0, 300),
        }).eq('id', contato.id);
        await supabase.from('disparos_campanhas')
          .update({ status: 'pausada', auto_pausada: true, falhas: camp.falhas + 1 })
          .eq('id', campanhaId);
        console.error('⛔ disparo pausado (template indisponível) campanha', campanhaId, e.message);
        return; // encerra o loop; usuário troca o número e Retoma
      }
      await supabase.from('disparos_contatos').update({
        status: 'falha', erro: String(e.message || e).slice(0, 300),
      }).eq('id', contato.id);
      camp.falhas = camp.falhas + 1;
      await supabase.from('disparos_campanhas')
        .update({ falhas: camp.falhas }).eq('id', campanhaId);
      console.warn('⚠️ disparo falhou contato', contato.id, e.message);
    }
```

- [ ] **Step 4: Sanidade — require resolve e suite passa**

Run: `node -e "require('./lib/disparos/runner.js'); console.log('ok')"`
Expected: imprime `ok` (sem erro de require).
Run: `npm test`
Expected: PASS (inclui `erro-template.test.js`, `matching.test.js`, `parser.test.js`).

- [ ] **Step 5: Commit**

```bash
git add lib/disparos/runner.js
git commit -m "feat(disparos): runner dispara pelo numero da campanha + guardrail de template/WABA"
```

---

### Task 5: `/api/config/wa` expõe `sendable` + `/api/disparos/criar` valida `wa_number_id`

**Files:**
- Modify: `server.js:216` (retorno de `/api/config/wa`), `server.js:1321-1349` (`/api/disparos/criar`)

**Interfaces:**
- Consumes: `whatsapp.getPhoneNumbers()` (chaves = números com token), `whatsapp.defaultPhoneId()`.
- Produces: `/api/config/wa` retorna `{ numbers, defaultPhoneId, sendable: string[] }`. `/api/disparos/criar` aceita `wa_number_id` no corpo e o grava na campanha.

> Endpoints do `server.js` não têm harness de teste no codebase — verificação manual via curl (Step 4).

- [ ] **Step 1: Adicionar `sendable` ao `/api/config/wa`**

Em `server.js:216`, trocar:
```js
    res.json({ numbers, defaultPhoneId });
```
por:
```js
    const sendable = Object.keys(await whatsapp.getPhoneNumbers());
    res.json({ numbers, defaultPhoneId, sendable });
```

- [ ] **Step 2: Validar e gravar `wa_number_id` no `criar`**

Em `server.js`, dentro de `/api/disparos/criar`, logo após a linha `const lang = sanitizeStr(req.body.lang || 'pt_BR', 12);` (linha 1325), inserir:
```js
    // Número de envio: ausente = default (compat); presente precisa ter token (2873/8700).
    const sendable = await whatsapp.getPhoneNumbers();
    let wa_number_id = sanitizeStr(req.body.wa_number_id || '', 50);
    if (!wa_number_id) wa_number_id = whatsapp.defaultPhoneId() || '';
    else if (!sendable[wa_number_id]) {
      return res.status(400).json({ error: 'Número sem credencial de envio configurada' });
    }
```

Depois, no insert de `disparos_campanhas` (linhas 1335-1338), trocar:
```js
    const { data: camp, error: cErr } = await supabase.from('disparos_campanhas').insert({
      nome, template_nome, lang, total: contatos.length,
      status: 'rascunho', criado_por: req.user.id,
    }).select().single();
```
por:
```js
    const { data: camp, error: cErr } = await supabase.from('disparos_campanhas').insert({
      nome, template_nome, lang, total: contatos.length, wa_number_id,
      status: 'rascunho', criado_por: req.user.id,
    }).select().single();
```

- [ ] **Step 3: Sanidade — server sobe**

Run: `node -e "require('./server.js')" ` — *não* roda (precisa de env); em vez disso checar sintaxe:
Run: `node --check server.js`
Expected: sem saída (sintaxe ok).

- [ ] **Step 4: Verificação manual (após deploy ou local com env)**

Com a app rodando e logado, no console do navegador:
```js
fetch('/api/config/wa', {headers:{Authorization:'Bearer '+_token()}}).then(r=>r.json()).then(console.log)
```
Expected: objeto com `sendable` listando 2 IDs (2873 e 8700) e `defaultPhoneId` = id do 2873.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(disparos): config/wa expoe sendable e criar valida/grava wa_number_id"
```

---

### Task 6: Seletor de número na tela de Disparo em Massa

**Files:**
- Modify: `public/index.html:1047-1051` (form do disparo), `public/index.html:~3915` (carregamento de templates/config), `public/index.html:3968-3977` (`dispCriarEIniciar`)

**Interfaces:**
- Consumes: `/api/config/wa` (`sendable`, `numbers`, `defaultPhoneId`), `/api/disparos/criar` (campo `wa_number_id`).

> Frontend vanilla sem harness — verificação manual (Step 4).

- [ ] **Step 1: Adicionar o `<select>` no formulário**

Em `public/index.html`, dentro do `.form-row` do disparo (após o `form-group` do template, linha 1050), adicionar um novo grupo:
```html
      <div class="form-group" style="margin-bottom:0">
        <label>Disparar pelo número</label>
        <select id="disp-numero"><option value="">Carregando...</option></select>
      </div>
```

- [ ] **Step 2: Popular o select ao abrir a página de Disparos**

Localizar a função que popula `#disp-template` (perto de `const sel = document.getElementById('disp-template');`, ~linha 3919). No fim dessa função (após preencher os templates), adicionar o carregamento dos números:
```js
  try {
    const cfg = await api('/api/config/wa');
    const selN = document.getElementById('disp-numero');
    const ids = (cfg.sendable && cfg.sendable.length) ? cfg.sendable : Object.keys(cfg.numbers || {});
    selN.innerHTML = ids.map(id =>
      `<option value="${id}">${(cfg.numbers && cfg.numbers[id]) || id}</option>`).join('');
    if (cfg.defaultPhoneId && ids.includes(cfg.defaultPhoneId)) selN.value = cfg.defaultPhoneId;
  } catch (e) { console.error('disp numeros:', e); }
```

- [ ] **Step 3: Enviar `wa_number_id` no criar**

Em `dispCriarEIniciar` (linhas 3968-3977), onde monta o corpo do `POST /api/disparos/criar`:
```js
    const r = await api('/api/disparos/criar', { method: 'POST', body: JSON.stringify({ nome, template_nome, texto }) });
```
trocar por (lendo o select):
```js
    const wa_number_id = document.getElementById('disp-numero').value;
    const r = await api('/api/disparos/criar', { method: 'POST', body: JSON.stringify({ nome, template_nome, texto, wa_number_id }) });
```

- [ ] **Step 4: Verificação manual**

Run: `node --check` não se aplica a HTML. Abrir a app (deploy ou local), ir em **Disparos**:
- O select "Disparar pelo número" aparece com 2 opções e o **2873 pré-selecionado**.
- Subir uma lista de 1 contato (seu próprio número), template aprovado, **Iniciar**.
- Confirmar no banco que a campanha gravou `wa_number_id` do 2873:
```sql
SELECT id, nome, wa_number_id FROM disparos_campanhas ORDER BY id DESC LIMIT 1;
```
- Confirmar que a mensagem de teste chegou pelo 2873.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(disparos): seletor de numero no disparo em massa (padrao 2873)"
```

---

### Task 7: Helper de paginação dos leads de uma campanha

**Files:**
- Create: `lib/disparos/leads-da-campanha.js`
- Test: `lib/disparos/leads-da-campanha.test.js`

**Interfaces:**
- Produces: `coletarLeadIds(fetchPage) -> Promise<Set<number>>`, onde `fetchPage(offset, limit)` retorna um array de `{ lead_id }`. Pagina de 1000 em 1000 até a última página parcial. `PAGINA = 1000`.

- [ ] **Step 1: Write the failing test**

`lib/disparos/leads-da-campanha.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { coletarLeadIds, PAGINA } = require('./leads-da-campanha');

test('coleta ids de uma única página parcial', async () => {
  const set = await coletarLeadIds(async () => [{ lead_id: 1 }, { lead_id: 2 }, { lead_id: 2 }]);
  assert.deepStrictEqual([...set].sort(), [1, 2]);
});

test('ignora lead_id nulo', async () => {
  const set = await coletarLeadIds(async () => [{ lead_id: 5 }, { lead_id: null }]);
  assert.deepStrictEqual([...set], [5]);
});

test('pagina quando a primeira página vem cheia', async () => {
  const p1 = Array.from({ length: PAGINA }, (_, i) => ({ lead_id: i + 1 }));
  const p2 = [{ lead_id: 99999 }];
  const paginas = [p1, p2];
  let chamadas = 0;
  const set = await coletarLeadIds(async () => paginas[chamadas++] || []);
  assert.strictEqual(set.size, PAGINA + 1);
  assert.ok(set.has(99999));
  assert.strictEqual(chamadas, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/disparos/leads-da-campanha.test.js`
Expected: FAIL ("Cannot find module './leads-da-campanha'").

- [ ] **Step 3: Write minimal implementation**

`lib/disparos/leads-da-campanha.js`:

```js
// Coleta o conjunto de lead_id de uma campanha paginando (evita o corte de 1000
// linhas do cliente Supabase). fetchPage(offset, limit) -> array de { lead_id }.
const PAGINA = 1000;

async function coletarLeadIds(fetchPage) {
  const ids = new Set();
  for (let offset = 0; ; offset += PAGINA) {
    const linhas = await fetchPage(offset, PAGINA);
    for (const r of linhas) if (r.lead_id != null) ids.add(r.lead_id);
    if (linhas.length < PAGINA) break;
  }
  return ids;
}

module.exports = { coletarLeadIds, PAGINA };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/disparos/leads-da-campanha.test.js`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/disparos/leads-da-campanha.js lib/disparos/leads-da-campanha.test.js
git commit -m "feat(disparos): helper coletarLeadIds com paginacao (limite 1000)"
```

---

### Task 8: Filtro `?campanha_id` em `/api/conversas`

**Files:**
- Modify: `server.js` (topo, require) e `server.js:2010-2027` (`/api/conversas`)

**Interfaces:**
- Consumes: `coletarLeadIds` (Task 7). O RPC `conversas_com_preview` expõe o id do lead em `r.id` (vindo de `l.id`).

> Endpoint sem harness — verificação manual (Step 3).

- [ ] **Step 1: Importar o helper**

Junto dos demais `require` no topo do `server.js` (perto de onde `runner`/`matching` de disparos são importados), adicionar:
```js
const { coletarLeadIds } = require('./lib/disparos/leads-da-campanha');
```

- [ ] **Step 2: Aplicar o filtro por campanha**

Em `/api/conversas`, logo após o bloco do `mode` (depois da linha 2026, antes de `res.json(rows)`), inserir:
```js
    const campanhaId = parseInt(req.query.campanha_id, 10);
    if (!Number.isNaN(campanhaId)) {
      const leadIds = await coletarLeadIds(async (offset, limit) => {
        const { data } = await supabase.from('disparos_contatos')
          .select('lead_id').eq('campanha_id', campanhaId).eq('status', 'enviado')
          .not('lead_id', 'is', null).range(offset, offset + limit - 1);
        return data || [];
      });
      rows = rows.filter(r => leadIds.has(r.id));
    }
```

- [ ] **Step 3: Sanidade + verificação manual**

Run: `node --check server.js`
Expected: sem saída (sintaxe ok).

Manual (app rodando, logado), no console:
```js
fetch('/api/conversas?campanha_id=<ID_DA_CAMPANHA_DE_TESTE>', {headers:{Authorization:'Bearer '+_token()}}).then(r=>r.json()).then(d=>console.log(d.length, d.map(x=>x.id)))
```
Expected: retorna só os leads que receberam o disparo daquela campanha (no teste, o seu número).

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(conversas): filtro opcional por campanha de disparo (campanha_id)"
```

---

### Task 9: Dropdown "📢 Campanha" na aba Conversas

**Files:**
- Modify: `public/index.html:845-847` (área dos filtros do header de Conversas), `public/index.html:2604-2607` (`loadConversas`)

**Interfaces:**
- Consumes: `GET /api/disparos` (lista de campanhas, já existe), `/api/conversas?campanha_id=N` (Task 8).

> Frontend vanilla — verificação manual (Step 4).

- [ ] **Step 1: Adicionar o dropdown no header**

Em `public/index.html`, após o `<select id="filtro-crc">` (linha 847), adicionar:
```html
      <select id="filtro-campanha" class="filter-select" style="font-size:12px;height:32px" onchange="loadConversas()">
        <option value="">Todas as campanhas</option>
      </select>
```

- [ ] **Step 2: Popular o dropdown uma vez (lazy)**

Adicionar uma função e chamá-la quando a página de Conversas abre. Junto das funções de Conversas (perto de `loadConversas`), adicionar:
```js
let _campanhasCarregadas = false;
async function carregarFiltroCampanhas() {
  if (_campanhasCarregadas) return;
  try {
    const camps = await api('/api/disparos');
    const sel = document.getElementById('filtro-campanha');
    for (const c of (camps || [])) {
      const dt = c.criado_em ? new Date(c.criado_em).toLocaleDateString('pt-BR') : '';
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.nome + (dt ? ' (' + dt + ')' : '');
      sel.appendChild(opt);
    }
    _campanhasCarregadas = true;
  } catch (e) { console.error('filtro campanhas:', e); }
}
```

Chamar `carregarFiltroCampanhas()` dentro do `loadConversas` (no início da função, linha ~2605), de forma não-bloqueante:
```js
  carregarFiltroCampanhas();
```

- [ ] **Step 3: Incluir `campanha_id` na chamada**

Em `loadConversas` (linhas 2606-2607), trocar:
```js
    const modeParam = _chatMode === 'oficial' ? '?mode=oficial' : _chatMode === 'agendamentos' ? '?mode=lead' : '';
    const convs = await api('/api/conversas' + modeParam);
```
por:
```js
    const modeParam = _chatMode === 'oficial' ? '?mode=oficial' : _chatMode === 'agendamentos' ? '?mode=lead' : '';
    const campId = (document.getElementById('filtro-campanha') || {}).value || '';
    const sep = modeParam ? '&' : '?';
    const convs = await api('/api/conversas' + modeParam + (campId ? sep + 'campanha_id=' + encodeURIComponent(campId) : ''));
```

- [ ] **Step 4: Verificação manual**

Abrir a app → **Conversas**:
- O dropdown "Todas as campanhas" aparece e lista a campanha de teste.
- Selecionar a campanha de teste → a lista mostra só os leads que receberam aquele disparo.
- Voltar para "Todas as campanhas" → lista volta ao normal.
- O filtro convive com as abas (Oficial/Agendamentos) sem erro no console.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(conversas): dropdown de filtro por campanha de disparo"
```

---

## Verificação final (antes de soltar os 52 de Invisalign)

- [ ] `npm test` verde (helpers de disparos) + `node --test whatsapp.broadcast.test.js whatsapp.envio.test.js` verde.
- [ ] Deploy Easypanel CRM feito.
- [ ] **Teste de WABA:** disparar 1 template pelo **2873** para o próprio número. Chegou ⇒ a WABA do 2873 tem os templates Invisalign; pode soltar os 52. Se a campanha **pausar sozinha** com aviso de "template indisponível", a WABA não bate — disparar pelo 8700 ou aprovar os templates na WABA do 2873.
- [ ] Conferir no perfil de um lead de teste a aba "📢 Disparos" e a conversa nascendo no inbox do 2873.

## Self-Review (feita)

- **Cobertura da spec:** Parte 1 (seletor) → Tasks 1,2,5,6 + runner Task 4. Parte 2 (filtro conversas) → Tasks 7,8,9. Guardrail/WABA → Tasks 3,4 + verificação final. `sendable`/número-sem-token → Task 5. Paginação 1000 → Task 7. `r.id` do RPC → Task 8.
- **Placeholders:** nenhum — todo passo tem código/comando concreto.
- **Consistência de tipos:** `enviarBroadcast({...phoneNumberId})` (Task 1) usado igual no runner (Task 4); `templateIndisponivel` (Task 3) idem; `coletarLeadIds(fetchPage)` (Task 7) idem no endpoint (Task 8); `sendable` (Task 5) consumido no front (Task 6).
