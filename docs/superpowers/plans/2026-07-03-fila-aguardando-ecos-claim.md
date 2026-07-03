# Fila ⏰ Aguardando + Ecos IA/app + Claim-first — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Respostas enviadas pela IA da Meta/app aparecem na thread do CRM; filtro ⏰ mostra conversas esperando resposta 30+ min (número que bate com a lista); lead ganha dono ao ser respondido pelo CRM; Maria (17:30) e Paola (18:00) recebem varredura de fim de dia.

**Architecture:** Parser puro de ecos em `lib/wa/echoes.js` (testável); ingestão no webhook existente (`server.js POST /webhooks/whatsapp`) com dedup por `wa_id`; regra canônica de "aguardando" numa função SQL (`conversas_aguardando`); filtro ⏰ client-side no mesmo `filtrarChats()` dos filtros 🔔/⏳/sem-CRC; claim e varredura no server reusando `criarNotificacao` e o padrão do resumo 18:30.

**Tech Stack:** Node/Express, Supabase (MCP p/ migrations, project `mtqdpjhhqzvuklnlfpvi`), front vanilla, `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-03-fila-aguardando-ecos-claim-design.md`

## Global Constraints

- NUNCA `.catch()` direto em builder Supabase (derrubou o CRM) — try/catch no await, ou `.then(...).catch(...)`.
- Somas/filtros grandes no SQL, nunca no JS (limite de 1000 linhas do client).
- Front é vanilla — sem lib nova.
- Erro na ingestão de um eco NÃO pode derrubar o webhook (try/catch por item).
- Status ativos canônicos: `Novo`, `Em qualificação`, `Avaliação agendada`, `Compareceu`, `Em negociação`. Limite da fila: 30 minutos.
- Valores de `canal` já usados em `mensagens`: `sdr`, `agendada`, `broadcast`. O novo é `app`.
- Deploy: `git push` → `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`.
- Working dir compartilhado com outras sessões: commitar SÓ os arquivos deste plano; nunca `git add -A`.

---

### Task 1: Parser de ecos (`lib/wa/echoes.js`) — TDD

**Files:**
- Create: `lib/wa/echoes.js`
- Test: `lib/wa/echoes.test.js` (o glob do `npm test` é `lib/**/*.test.js`, já pega)

**Interfaces:**
- Produces: `parseEchoes(body) -> Array<{to, wamid, tipo, texto, phone_number_id, timestamp}>` — `to`=telefone do lead (string), `wamid`=id da mensagem, `tipo`=type do WA (`text`, `image`…), `texto`=body ou rótulo `[tipo]`, `timestamp`=ISO string ou `null`. Reactions e itens sem `to`/`wamid` são descartados.

- [ ] **Step 1: Escrever os testes (falhando)**

```js
// lib/wa/echoes.test.js
const test = require('node:test');
const assert = require('node:assert');
const { parseEchoes } = require('./echoes');

// Payload REAL capturado em webhook_wa_debug (03/07/2026) — não inventado
const PAYLOAD_REAL = { entry: [{ changes: [{ field: 'smb_message_echoes', value: {
  contacts: [{ wa_id: '553199206744', user_id: 'BR.2805644406472492' }],
  metadata: { phone_number_id: '993441140514749', display_phone_number: '553196492873' },
  message_echoes: [{ id: 'wamid.HBgMNTUzMTk5MjA2NzQ0FQIAERggQTVBQjZDODFCNUUzRjYxNTQ4NTlCNTkyMTcyQ0YwOTEA',
    to: '553199206744', from: '553196492873',
    text: { body: 'Bom dia Sandra! Tudo bem?' }, type: 'text',
    timestamp: '1783088335', to_user_id: 'BR.2805644406472492' }],
  messaging_product: 'whatsapp' } }] }] };

test('extrai eco de texto do payload real', () => {
  const r = parseEchoes(PAYLOAD_REAL);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].to, '553199206744');
  assert.strictEqual(r[0].texto, 'Bom dia Sandra! Tudo bem?');
  assert.strictEqual(r[0].phone_number_id, '993441140514749');
  assert.match(r[0].wamid, /^wamid\./);
  assert.strictEqual(r[0].timestamp, new Date(1783088335 * 1000).toISOString());
});

test('eco de mídia vira rótulo [tipo]', () => {
  const b = structuredClone(PAYLOAD_REAL);
  b.entry[0].changes[0].value.message_echoes[0] = { id: 'wamid.X', to: '5531999', type: 'image', image: { id: 'm1' }, timestamp: '1783088335' };
  const r = parseEchoes(b);
  assert.strictEqual(r[0].texto, '[image]');
  assert.strictEqual(r[0].tipo, 'image');
});

test('reaction é descartada; field messages é ignorado; body vazio não quebra', () => {
  const b = structuredClone(PAYLOAD_REAL);
  b.entry[0].changes[0].value.message_echoes[0].type = 'reaction';
  assert.strictEqual(parseEchoes(b).length, 0);
  assert.strictEqual(parseEchoes({ entry: [{ changes: [{ field: 'messages', value: {} }] }] }).length, 0);
  assert.strictEqual(parseEchoes(null).length, 0);
  assert.strictEqual(parseEchoes({}).length, 0);
});

test('aceita field message_echoes (variante sem smb_)', () => {
  const b = structuredClone(PAYLOAD_REAL);
  b.entry[0].changes[0].field = 'message_echoes';
  assert.strictEqual(parseEchoes(b).length, 1);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/wa/echoes.test.js`
Expected: FAIL — `Cannot find module './echoes'`

- [ ] **Step 3: Implementar**

```js
// lib/wa/echoes.js
// Ecos de mensagens enviadas pelo app WhatsApp Business / IA da Meta (coexistência).
// O webhook principal só trata field='messages'; sem este parser, respostas dadas
// fora do CRM não existem no banco (spec 2026-07-03-fila-aguardando-ecos-claim).
const FIELDS = new Set(['smb_message_echoes', 'message_echoes']);

function parseEchoes(body) {
  const out = [];
  try {
    for (const entry of (Array.isArray(body?.entry) ? body.entry : [])) {
      for (const change of (Array.isArray(entry?.changes) ? entry.changes : [])) {
        if (!FIELDS.has(change?.field)) continue;
        const v = change.value || {};
        for (const e of (Array.isArray(v.message_echoes) ? v.message_echoes : [])) {
          const tipo = e.type || 'text';
          out.push({
            to: String(e.to || ''),
            wamid: e.id || '',
            tipo,
            texto: e.text?.body || (tipo !== 'text' ? '[' + tipo + ']' : ''),
            phone_number_id: v.metadata?.phone_number_id || '',
            timestamp: e.timestamp ? new Date(Number(e.timestamp) * 1000).toISOString() : null,
          });
        }
      }
    }
  } catch { /* nunca quebra o webhook */ }
  return out.filter(e => e.to && e.wamid && e.tipo !== 'reaction');
}

module.exports = { parseEchoes };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/wa/echoes.test.js`
Expected: 4 testes PASS. Rodar também `npm test` (suíte inteira verde).

- [ ] **Step 5: Commit**

```bash
git add lib/wa/echoes.js lib/wa/echoes.test.js
git commit -m "feat(wa): parser de ecos do app/IA da Meta (smb_message_echoes)"
```

---

### Task 2: Ingestão dos ecos no webhook (`server.js`)

**Files:**
- Modify: `server.js` — rota `POST /webhooks/whatsapp` (~linha 2689) e extração de helper do match por telefone (~linhas 2736-2752)

**Interfaces:**
- Consumes: `parseEchoes` (Task 1).
- Produces: helper `acharLeadPorTelefone(fone) -> lead|null` (usado pela Task 4); linhas em `mensagens` com `canal='app'`, `direcao='enviada'`, `wa_id` único.

- [ ] **Step 1: Extrair o helper de match (mesmo comportamento do código inline atual)**

Adicionar acima da rota `POST /webhooks/whatsapp` (o código é o MESMO que está inline nas linhas ~2736-2752 — exato→sufixo-8/`chaveTelefone`):

```js
// Match de lead por telefone: exato → sufixo 8 dígitos + chaveTelefone (base
// legada sem DDI/9º dígito; preserva a separação intencional de familiares).
async function acharLeadPorTelefone(fone) {
  const { data: rows } = await supabase.from('leads').select('*')
    .eq('telefone', fone).order('id').limit(1);
  let lead = rows?.[0] || null;
  if (!lead) {
    const suf = String(fone).slice(-8);
    const alvo = chaveTelefone(fone);
    if (suf.length === 8 && alvo) {
      const { data: cands } = await supabase.from('leads').select('*')
        .like('telefone', '%' + suf).order('id').limit(20);
      lead = (cands || []).find(c => chaveTelefone(c.telefone) === alvo) || null;
    }
  }
  return lead;
}
```

Na rota, substituir o bloco inline (do `let { data: leadRows }` até o fim do fallback) por:

```js
    let lead = await acharLeadPorTelefone(m.from);
```

- [ ] **Step 2: Adicionar a ingestão de ecos**

No `require` do topo (junto dos outros requires de `lib/`): `const { parseEchoes } = require('./lib/wa/echoes');`

Dentro da rota, logo APÓS o bloco de `coletarEventosDebug` (que termina em `catch (e) { console.error('webhook debug log:', e.message); }`) e ANTES de `const m = whatsapp.parseMensagemRecebida(req.body);`:

```js
    // Ecos do app/IA da Meta → entram na thread como enviada canal='app'.
    // Dedup por wa_id (protege contra reentrega e eco de msg enviada via API).
    try {
      for (const eco of parseEchoes(req.body)) {
        try {
          const { data: dup } = await supabase.from('mensagens')
            .select('id').eq('wa_id', eco.wamid).limit(1);
          if (dup?.length) continue;
          const leadEco = await acharLeadPorTelefone(eco.to);
          if (!leadEco) { console.log('[eco-app] sem lead p/ …' + eco.to.slice(-8)); continue; }
          const { error: ecoErr } = await supabase.from('mensagens').insert({
            lead_id: leadEco.id, direcao: 'enviada', canal: 'app',
            texto: sanitizeStr(eco.texto, 4000), wa_id: eco.wamid,
            tipo: eco.tipo,
            wa_number_id: sanitizeStr(eco.phone_number_id || '', 50),
            ...(eco.timestamp ? { criada_em: eco.timestamp } : {}),
          });
          if (ecoErr) console.error('❌ eco-app insert:', ecoErr.message);
        } catch (e) { console.error('❌ eco-app item:', e.message); }
      }
    } catch (e) { console.error('❌ eco-app:', e.message); }
```

- [ ] **Step 3: Verificar sintaxe e suíte**

Run: `node --check server.js && npm test`
Expected: sem erro de sintaxe; suíte verde.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(wa): ingere ecos do app/IA na thread (canal=app, dedup por wa_id)"
```

---

### Task 3: Selo "via app/IA" no balão do chat

**Files:**
- Modify: `public/index.html` — render das mensagens em `carregarMensagensChat` (~linhas 3621-3646)

**Interfaces:**
- Consumes: `mensagens.canal='app'` (Task 2). O `GET /api/leads/:id/mensagens` usa `select('*')` — `canal` já vem na resposta, nada a mudar no server.

- [ ] **Step 1: Ler o bloco atual**

Ler `public/index.html` linhas 3615-3650 para ver como `waLabel` é montado e onde é interpolado no template do balão.

- [ ] **Step 2: Adicionar o selo**

Logo após a definição do `const waLabel = ...` (linha ~3621), adicionar:

```js
      const appLabel = m.direcao === 'enviada' && m.canal === 'app'
        ? '<span style="font-size:9px;opacity:.8;font-weight:600"> · via app/IA</span>' : '';
```

E interpolar `${appLabel}` imediatamente ao lado de onde `${waLabel}` aparece no template do balão (mesmo elemento de metadados hora/status).

- [ ] **Step 3: Verificação manual local**

Run: `node --check server.js` (sanidade) e abrir a página no navegador logado após o deploy final (Task 9). Não há teste automatizado de UI neste projeto — validação visual fica na Task 9.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(chat): selo 'via app/IA' em mensagem ingerida por eco"
```

---

### Task 4: Backfill dos ecos históricos (`webhook_wa_debug` → `mensagens`)

**Files:**
- Create: `scripts/backfill-ecos-app.js`

**Interfaces:**
- Consumes: `parseEchoes` (Task 1). NÃO reusa `acharLeadPorTelefone` do server (importar server.js sobe o app) — o script replica o match com o MESMO código, importando `chaveTelefone` de `lib/funil/telefone.js`.

- [ ] **Step 1: Escrever o script**

```js
// scripts/backfill-ecos-app.js — ingere ecos históricos (webhook_wa_debug) em
// mensagens. Idempotente: dedup por wa_id. Rodar: node scripts/backfill-ecos-app.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { parseEchoes } = require('../lib/wa/echoes');
const { chaveTelefone } = require('../lib/funil/telefone');

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

async function acharLeadPorTelefone(fone) {
  const { data: rows } = await supabase.from('leads').select('id, telefone')
    .eq('telefone', fone).order('id').limit(1);
  let lead = rows?.[0] || null;
  if (!lead) {
    const suf = String(fone).slice(-8);
    const alvo = chaveTelefone(fone);
    if (suf.length === 8 && alvo) {
      const { data: cands } = await supabase.from('leads').select('id, telefone')
        .like('telefone', '%' + suf).order('id').limit(20);
      lead = (cands || []).find(c => chaveTelefone(c.telefone) === alvo) || null;
    }
  }
  return lead;
}

(async () => {
  let inseridos = 0, duplicados = 0, semLead = 0, offset = 0;
  for (;;) {
    const { data: rows, error } = await supabase.from('webhook_wa_debug')
      .select('id, payload').order('id').range(offset, offset + 199);
    if (error) throw error;
    if (!rows?.length) break;
    offset += rows.length;
    for (const row of rows) {
      // payload gravado é o change; parseEchoes espera o body completo
      for (const eco of parseEchoes({ entry: [{ changes: [row.payload] }] })) {
        const { data: dup } = await supabase.from('mensagens').select('id').eq('wa_id', eco.wamid).limit(1);
        if (dup?.length) { duplicados++; continue; }
        const lead = await acharLeadPorTelefone(eco.to);
        if (!lead) { semLead++; continue; }
        const { error: insErr } = await supabase.from('mensagens').insert({
          lead_id: lead.id, direcao: 'enviada', canal: 'app',
          texto: (eco.texto || '').slice(0, 4000), wa_id: eco.wamid, tipo: eco.tipo,
          wa_number_id: (eco.phone_number_id || '').slice(0, 50),
          ...(eco.timestamp ? { criada_em: eco.timestamp } : {}),
        });
        if (insErr) console.error('insert', eco.wamid.slice(-12), insErr.message);
        else inseridos++;
      }
    }
  }
  console.log(`✅ backfill ecos: ${inseridos} inseridos, ${duplicados} já existiam, ${semLead} sem lead`);
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Rodar contra produção**

Run: `node scripts/backfill-ecos-app.js` (na raiz do clinica-crm, `.env` local tem as chaves)
Expected: `✅ backfill ecos: N inseridos, ...` com N > 0 (havia 486 eventos; parte é de pacientes sem lead — `sem lead` alto é normal).

- [ ] **Step 3: Conferir no banco (via MCP Supabase)**

```sql
select count(*), min(criada_em)::date, max(criada_em)::date from mensagens where canal='app';
```
Expected: count = N do passo 2, datas entre 2026-06-29 e hoje. Rodar 2ª vez o script → `0 inseridos` (idempotência).

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-ecos-app.js
git commit -m "feat(wa): backfill dos ecos historicos do app/IA"
```

---

### Task 5: Migration — `conversas_aguardando()` + `nao_ligar` na RPC de conversas + config da varredura

**Files:**
- Create: `supabase/migrations/20260703120000_fila_aguardando.sql`
- Aplicar via MCP Supabase (`apply_migration`, project `mtqdpjhhqzvuklnlfpvi`); conferir com `list_migrations`.

**Interfaces:**
- Produces: RPC `conversas_aguardando(minutos int default 30)` → `(lead_id bigint, nome text, telefone text, status text, ultima_recebida timestamptz, espera_min int, crc_agendamento_id uuid)`, ordenada da espera mais longa p/ mais curta (Task 8 consome). `conversas_com_preview` ganha coluna `nao_ligar boolean` NO FIM do retorno (Task 6 consome). `app_config` ganha `varredura_aguardando jsonb` e `varredura_aguardando_envios jsonb` (Task 8 consome).

- [ ] **Step 1: Escrever a migration**

```sql
-- Fila "aguardando resposta" (spec 2026-07-03-fila-aguardando-ecos-claim).
-- Regra CANÔNICA em um lugar só: status ativo, sem nao_ligar, última mensagem
-- da conversa é 'recebida' há >= N minutos. O filtro ⏰ do cliente espelha isso.
create or replace function public.conversas_aguardando(minutos int default 30)
returns table(lead_id bigint, nome text, telefone text, status text,
              ultima_recebida timestamptz, espera_min int, crc_agendamento_id uuid)
language sql stable as $$
  select l.id, l.nome, l.telefone, l.status, m.criada_em,
         floor(extract(epoch from (now() - m.criada_em)) / 60)::int,
         l.crc_agendamento_id
  from leads l
  join lateral (select direcao, criada_em from mensagens
                where lead_id = l.id order by id desc limit 1) m on true
  where l.status in ('Novo','Em qualificação','Avaliação agendada','Compareceu','Em negociação')
    and coalesce(l.nao_ligar, false) = false
    and m.direcao = 'recebida'
    and m.criada_em <= now() - make_interval(mins => minutos)
  order by m.criada_em asc;
$$;

-- conversas_com_preview: + nao_ligar (o filtro ⏰ do cliente precisa dele).
-- DROP necessário: assinatura de retorno muda.
drop function if exists public.conversas_com_preview(text);
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
  ultima_recebida_em timestamptz, nao_ligar boolean
)
language sql stable as $function$
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
    ur.criada_em AS ultima_recebida_em,
    l.nao_ligar
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

-- Config da varredura fim de dia (17:30 Maria Eduarda, 18:00 Paola)
alter table app_config
  add column if not exists varredura_aguardando jsonb,
  add column if not exists varredura_aguardando_envios jsonb default '{}'::jsonb;

update app_config set varredura_aguardando = (
  select coalesce(jsonb_agg(jsonb_build_object('usuario_id', p.id, 'hora', v.hora)), '[]'::jsonb)
  from (values ('Maria Eduarda%', '17:30'), ('Paola%', '18:00')) as v(padrao, hora)
  join profiles p on p.nome ilike v.padrao
) where id = 1 and varredura_aguardando is null;
```

- [ ] **Step 2: Aplicar via MCP e verificar**

Aplicar com `apply_migration` (name `fila_aguardando`). Depois:

```sql
select * from conversas_aguardando(30) limit 5;
select varredura_aguardando from app_config where id=1;
select nao_ligar from conversas_com_preview(null) limit 1;
```
Expected: 1ª retorna linhas ordenadas por espera (leads reais); 2ª retorna array com 2 entradas (uuids de Maria Eduarda e Paola — se vier `[]` ou >2, ajustar os padrões `ilike` conferindo `select id, nome from profiles`); 3ª roda sem erro.

- [ ] **Step 3: Sanity da UI existente**

A RPC mudou de assinatura (coluna a mais no fim) — abrir `/api/conversas` logado (ou `curl` autenticado) e conferir 200 com `nao_ligar` no JSON. O server não referencia colunas por posição, então nada mais muda.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260703120000_fila_aguardando.sql
git commit -m "feat(db): rpc conversas_aguardando + nao_ligar no preview + config varredura"
```

---

### Task 6: Filtro ⏰ + badge + chip de espera + deep-link (`public/index.html`)

**Files:**
- Modify: `public/index.html` — botão (~linha 697), `filtrarChats()` (~linha 2737), `renderChatList` (~linha 2772), bloco de filtros JS (~linha 3788), init deep-link (~linha 5822)

**Interfaces:**
- Consumes: campos `ultima_mensagem_direcao`, `ultima_mensagem_em`, `status`, `nao_ligar` do payload de `/api/conversas` (Task 5).
- Produces: `_isAguardando(l)`, `toggleFiltroAguardando()`, `_fmtEsperaMin(min)` (usados só aqui).

- [ ] **Step 1: Botão com badge ao lado do ⏳ (linha ~697)**

```html
      <button id="btn-filtro-aguardando" onclick="toggleFiltroAguardando()" title="Aguardando resposta há 30+ min" style="width:32px;height:32px;border-radius:8px;border:1px solid var(--border);background:var(--bg2);color:var(--muted);font-size:16px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .2s;position:relative">⏰<span id="badge-aguardando" style="position:absolute;top:-5px;right:-5px;background:#dc2626;color:#fff;font-size:9px;font-weight:700;border-radius:8px;padding:0 4px;min-width:14px;line-height:14px;display:none"></span></button>
```

- [ ] **Step 2: Lógica JS (junto dos outros toggles, ~linha 3788)**

```js
// ============ FILTRO AGUARDANDO (⏰ 30+ min sem resposta) ============
// Espelha a regra canônica da RPC conversas_aguardando (migration 20260703120000)
const STATUS_AGUARDANDO = new Set(['Novo','Em qualificação','Avaliação agendada','Compareceu','Em negociação']);
const AGUARDANDO_MIN = 30;
let _filtroAguardando = false;

function _isAguardando(l) {
  return l.ultima_mensagem_direcao === 'recebida'
    && !l.nao_ligar
    && STATUS_AGUARDANDO.has(l.status)
    && !!l.ultima_mensagem_em
    && (Date.now() - new Date(l.ultima_mensagem_em).getTime()) >= AGUARDANDO_MIN * 60 * 1000;
}

function _fmtEsperaMin(ms) {
  const min = Math.floor(ms / 60000);
  return min >= 60 ? Math.floor(min / 60) + 'h' + String(min % 60).padStart(2, '0') : min + 'min';
}

function _syncBtnAguardando() {
  const btn = document.getElementById('btn-filtro-aguardando');
  if (!btn) return;
  btn.style.background = _filtroAguardando ? '#dc2626' : 'var(--bg2)';
  btn.style.color = _filtroAguardando ? '#fff' : 'var(--muted)';
}

function toggleFiltroAguardando() {
  _filtroAguardando = !_filtroAguardando;
  _syncBtnAguardando();
  filtrarChats();
}
```

- [ ] **Step 3: Integrar no `filtrarChats()` (linha ~2737)**

Logo após `let base = _filtrarParaModo(chatLeads);` adicionar a atualização do badge (da MESMA base do modo — é isso que garante badge = lista):

```js
  const _nAguard = base.filter(_isAguardando).length;
  const _bAg = document.getElementById('badge-aguardando');
  if (_bAg) { _bAg.textContent = _nAguard; _bAg.style.display = _nAguard ? 'block' : 'none'; }
```

E junto dos outros filtros (após a linha do `_filtroSemCrc`):

```js
  if (_filtroAguardando) {
    base = base.filter(_isAguardando)
      .sort((a, b) => new Date(a.ultima_mensagem_em) - new Date(b.ultima_mensagem_em));
  }
```

- [ ] **Step 4: Chip "aguarda Xh" no card (renderChatList, junto do `janChip` ~linha 2776)**

```js
    const aguardaChip = _filtroAguardando && _isAguardando(l)
      ? `<span style="font-size:9.5px;font-weight:700;color:#dc2626;background:rgba(239,68,68,.12);border-radius:4px;padding:1px 5px;white-space:nowrap">aguarda ${_fmtEsperaMin(Date.now() - new Date(l.ultima_mensagem_em).getTime())}</span>`
      : '';
```

Interpolar `${aguardaChip}` ao lado de `${janChip}` no template (linha ~2790).

- [ ] **Step 5: Deep-link `?filtro=aguardando` (init, ANTES do bloco `_pageParam` ~linha 5822)**

```js
  // Deep-link da varredura: /?page=conv-agendamentos&filtro=aguardando liga o ⏰
  if (new URLSearchParams(location.search).get('filtro') === 'aguardando') {
    _filtroAguardando = true;
    _syncBtnAguardando();
  }
```

(O bloco `_pageParam` logo abaixo já clica na aba `conv-agendamentos`; quando as conversas carregam, `filtrarChats()` roda com o filtro já ligado.)

- [ ] **Step 6: Verificação de sintaxe**

Run: `node --check server.js` e abrir `public/index.html` num validador rápido: `node -e "const s=require('fs').readFileSync('public/index.html','utf8'); if(!s.includes('toggleFiltroAguardando')) throw new Error('faltou'); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "feat(conversas): filtro ⏰ aguardando resposta com badge, chip de espera e deep-link"
```

---

### Task 7: Claim-first + chip "sem dono"

**Files:**
- Modify: `server.js` — rotas `POST /api/leads/:id/whatsapp` (~linha 2033), `POST /api/leads/:id/whatsapp/midia` (~linha 2086), `POST /api/leads/:id/broadcast` (~linha 2366)
- Modify: `public/index.html` — `renderChatList` linha de chips (~linha 2796-2800)

**Interfaces:**
- Consumes: `req.user.id` e `req.user.profile?.nome` (o `requireAuth`/`loadProfile` já popula — mesmo padrão usado no set automático do agendamento em `patchLead`).
- Produces: evento `conversa_assumida` em `lead_eventos`; `crc_agendamento_id/nome` preenchidos no 1º envio.

- [ ] **Step 1: Helper no server (acima da rota `/api/leads/:id/whatsapp`)**

```js
// Claim-first: 1ª resposta pelo CRM torna o usuário dono da conversa.
// Só preenche quando vazio (guard .is no update) — nunca sobrescreve.
function assumirConversaSeSemDono(lead, user) {
  if (!lead || lead.crc_agendamento_id || !user?.id) return;
  const nomeCrc = sanitizeStr(user.profile?.nome || '', 100);
  supabase.from('leads')
    .update({ crc_agendamento_id: user.id, crc_agendamento_nome: nomeCrc })
    .eq('id', lead.id).is('crc_agendamento_id', null)
    .then(({ error }) => {
      if (!error) logEvento(lead.id, 'conversa_assumida',
        'Conversa assumida por ' + (nomeCrc || 'CRC'), {}, user.id);
    })
    .catch(() => {});
}
```

- [ ] **Step 2: Chamar nas 3 rotas de envio**

Em cada rota, logo após o `res.json({ ok: true })` (envio já confirmado):
- `/api/leads/:id/whatsapp` (~linha 2064): `assumirConversaSeSemDono(lead, req.user);`
- `/api/leads/:id/whatsapp/midia` (~linha 2125): a query do lead nessa rota é `select('id,telefone,wa_number_id')` — **adicionar `crc_agendamento_id` ao select** e então `assumirConversaSeSemDono(lead, req.user);`
- `/api/leads/:id/broadcast`: localizar o `res.json` de sucesso da rota (após envio de template) e adicionar a mesma chamada (a rota já faz `select('*')`).

- [ ] **Step 3: Chip "sem dono" no card (index.html, linha ~2799)**

Na div de badges do card (onde já aparece o chip da CRC), adicionar antes do chip da CRC:

```js
        ${(!l.crc_agendamento_id && !l.crc_comercial_id) ? '<span style="font-size:9.5px;color:var(--muted);background:var(--bg3);border:1px dashed var(--border);border-radius:4px;padding:1px 5px;white-space:nowrap">sem dono</span>' : ''}
```

- [ ] **Step 4: Verificar e commitar**

Run: `node --check server.js && npm test`
Expected: verde.

```bash
git add server.js public/index.html
git commit -m "feat(conversas): claim-first no envio pelo CRM + chip 'sem dono'"
```

---

### Task 8: Varredura fim de dia (17:30 Maria, 18:00 Paola)

**Files:**
- Modify: `server.js` — junto do `enviarResumoCrcDiario` (~linha 2897)

**Interfaces:**
- Consumes: RPC `conversas_aguardando(minutos)` (Task 5, ordenada da mais antiga p/ mais nova); `criarNotificacao(usuarioId, tipo, titulo, corpo, metadata)` (~linha 6804, já existe); colunas `app_config.varredura_aguardando` / `varredura_aguardando_envios` (Task 5).

- [ ] **Step 1: Implementar (colar logo após o `setInterval` do resumo-crc ~linha 2923)**

```js
// Varredura de fim de dia: notifica CRCs configuradas (app_config.varredura_aguardando
// = [{usuario_id, hora}]) sobre conversas aguardando resposta (spec 2026-07-03).
function _fmtEsperaMin(min) {
  return min >= 60 ? Math.floor(min / 60) + 'h' + String(min % 60).padStart(2, '0') : min + 'min';
}

async function enviarVarreduraAguardando() {
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const hhmm = new Date().toLocaleTimeString('sv-SE', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  const { data: cfg } = await supabase.from('app_config')
    .select('varredura_aguardando, varredura_aguardando_envios').eq('id', 1).maybeSingle();
  const lista = Array.isArray(cfg?.varredura_aguardando) ? cfg.varredura_aguardando : [];
  if (!lista.length) return;
  const envios = cfg?.varredura_aguardando_envios || {};
  let mudou = false;
  for (const item of lista) {
    if (!item?.usuario_id || !item?.hora) continue;
    if (hhmm < item.hora || envios[item.usuario_id] === hoje) continue;
    envios[item.usuario_id] = hoje; mudou = true;
    const { data: rows, error } = await supabase.rpc('conversas_aguardando', { minutos: 30 });
    if (error) { console.error('[varredura-aguardando] rpc:', error.message); continue; }
    if (!rows?.length) continue;
    const top = rows.slice(0, 5)
      .map(r => (r.nome || r.telefone || '?') + ' (' + _fmtEsperaMin(r.espera_min) + ')').join(', ');
    const corpo = rows.length + ' conversa' + (rows.length > 1 ? 's' : '') +
      ' aguardando resposta. Mais antigas: ' + top +
      (rows.length > 5 ? ' e mais ' + (rows.length - 5) + '…' : '');
    await criarNotificacao(item.usuario_id, 'aguardando_resposta',
      '⏰ Conversas aguardando resposta', corpo,
      { url: '/?page=conv-agendamentos&filtro=aguardando' });
    console.log('[varredura-aguardando] ' + item.usuario_id.slice(0, 8) + ': ' + rows.length + ' conversas');
  }
  if (mudou) await supabase.from('app_config')
    .update({ varredura_aguardando_envios: envios }).eq('id', 1);
}

setInterval(function() {
  enviarVarreduraAguardando().catch(function(e) { console.error('[varredura-aguardando]', e.message); });
}, 60000);
```

⚠️ Conferir se já não existe outro `_fmtEsperaMin` no server (não existe hoje); se a Task 6 rodou antes, o dela é no front — sem conflito.

- [ ] **Step 2: Verificar**

Run: `node --check server.js && npm test`
Expected: verde.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(conversas): varredura fim de dia notifica CRCs sobre fila aguardando"
```

---

### Task 9: Deploy + validação ponta-a-ponta

**Files:** nenhum novo (push + deploy + verificação).

- [ ] **Step 1: Push + deploy (regra do projeto: deploy imediato, sem perguntar)**

```bash
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```
Se o push divergir de outra sessão: `git pull --rebase` primeiro; se conflitar de verdade, isolar os commits em branch de origin/main (regra da memória do projeto — não forçar).

- [ ] **Step 2: Smoke test no ar**

```bash
curl -s -o /dev/null -w "%{http_code}" https://plataformaama-plataforma.uc5as5.easypanel.host/
curl -s -o /dev/null -w "%{http_code}" https://plataformaama-plataforma.uc5as5.easypanel.host/api/conversas
```
Expected: `200` e `401` (rota exige auth). Conferir log do container (Easypanel) sem erro de boot.

- [ ] **Step 3: Validar ingestão ao vivo**

Aguardar (ou provocar) uma resposta pelo app/IA no 2873 e conferir via MCP:

```sql
select lead_id, texto, canal, criada_em from mensagens
where canal='app' order by id desc limit 3;
```
Expected: novas linhas chegando em tempo real (não só do backfill).

- [ ] **Step 4: Forçar a varredura uma vez (teste controlado)**

```sql
-- zera o envio de hoje p/ retestar e coloca hora no passado p/ disparar no próximo minuto
update app_config set varredura_aguardando_envios = '{}'::jsonb where id=1;
```
Ajustar temporariamente uma `hora` no JSON p/ um minuto à frente (via SQL), aguardar o tick, e conferir `select * from notificacoes order by criada_em desc limit 2` → notificação `aguardando_resposta` criada p/ o usuário certo. Reverter a hora ao valor real (17:30/18:00).

- [ ] **Step 5: Registrar pendências de validação manual do Luiz**

Adicionar à memória `pending_tests.md`: validar logado o filtro ⏰ (badge = nº de cards ao clicar), selo "via app/IA" nos balões, chip "sem dono" sumindo após responder pelo CRM, e as notificações de 17:30/18:00 chegando pra Maria/Paola com deep-link abrindo o filtro.

---

## Self-review (feito na escrita)

- **Cobertura do spec:** Componente 1 → Tasks 1-4; Componente 2 → Tasks 5-6; Componente 3 → Task 7; Componente 4 → Tasks 5+8; critérios de sucesso → Task 9. Bordas do spec: reentrega/dedup (T2/T4), mídia (T1), família/0 à esquerda (helper preserva `chaveTelefone`), timestamp epoch (T1), try/catch por item (T2), proibição de `.catch` em builder (T7 usa `.then().catch()` sobre promise real).
- **Consistência de nomes:** `parseEchoes`, `acharLeadPorTelefone`, `conversas_aguardando`, `_isAguardando`, `assumirConversaSeSemDono`, `enviarVarreduraAguardando` — cada um definido numa task e consumido com o mesmo nome nas seguintes.
- **Sem placeholders:** todo step de código tem o código; os dois pontos que dependem de leitura in-loco (interpolação do `${appLabel}` no template do balão e o `res.json` do broadcast) têm instrução exata de onde ler e o código a inserir.
