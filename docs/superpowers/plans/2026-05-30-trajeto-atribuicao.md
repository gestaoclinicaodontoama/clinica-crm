# Trajeto do Paciente + Atribuição por Anúncio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar rastreio completo da jornada do lead (lead_eventos), campo "Anúncio" no perfil, aba "Trajeto" e página de atribuição por anúncio/campanha.

**Architecture:** Três novas tabelas Supabase (lead_eventos, pixel_sessions, anuncios) alimentadas por hooks fire-and-forget em server.js. O frontend consome APIs REST para exibir o Trajeto no painel do lead e a Atribuição numa página separada.

**Tech Stack:** Node.js/Express (server.js), Supabase (Postgres), HTML/CSS/JS vanilla, MCP Supabase para migrations.

---

## Mapa de arquivos

| Arquivo | Ação | Responsabilidade |
|---------|------|-----------------|
| `server.js` | Modificar | logEvento helper, hooks, /t, /track.js, APIs trajeto/atribuição/anúncios |
| `public/index.html` | Modificar | Enriquecer Campo Anúncio, adicionar aba Trajeto, nav /atribuicao/ |
| `public/js/shared-nav.js` | Modificar | Entrada nav para /atribuicao/ |
| `public/atribuicao/index.html` | Criar | Página completa de atribuição + catálogo |
| `.env` / `.env.example` | Modificar | PIXEL_TRACK_TOKEN |

---

## Task 1: Migrations Supabase

**Files:** Supabase project `mtqdpjhhqzvuklnlfpvi` — aplicar via MCP `apply_migration`

- [ ] **Step 1: Aplicar migration lead_eventos**

```sql
CREATE TABLE lead_eventos (
  id            bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  lead_id       bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tipo          text NOT NULL,
  descricao     text NOT NULL,
  metadata      jsonb DEFAULT '{}',
  usuario_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  criado_em     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_lead_eventos_lead_id ON lead_eventos(lead_id, criado_em DESC);
```

Usar MCP tool `apply_migration` com project_id `mtqdpjhhqzvuklnlfpvi` e a query acima.

- [ ] **Step 2: Verificar migration lead_eventos**

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'lead_eventos' ORDER BY ordinal_position;
```

Esperado: 7 colunas — id, lead_id, tipo, descricao, metadata, usuario_id, criado_em.

- [ ] **Step 3: Aplicar migration pixel_sessions**

```sql
CREATE TABLE pixel_sessions (
  id        bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  fbclid    text NOT NULL,
  lead_id   bigint REFERENCES leads(id) ON DELETE SET NULL,
  pagina    text NOT NULL,
  evento    text NOT NULL DEFAULT 'PageView',
  metadata  jsonb DEFAULT '{}',
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pixel_sessions_fbclid ON pixel_sessions(fbclid);
CREATE INDEX idx_pixel_sessions_lead_id ON pixel_sessions(lead_id);
```

- [ ] **Step 4: Aplicar migration anuncios + trigger**

```sql
CREATE TABLE anuncios (
  id            bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  fonte         text NOT NULL CHECK (fonte IN ('meta', 'google')),
  chave         text NOT NULL UNIQUE,
  nome          text NOT NULL,
  descricao     text DEFAULT '',
  ativo         boolean DEFAULT true,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION update_anuncios_atualizado_em()
RETURNS TRIGGER AS $$
BEGIN NEW.atualizado_em = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_anuncios_atualizado_em ON anuncios;
CREATE TRIGGER trg_anuncios_atualizado_em
BEFORE UPDATE ON anuncios
FOR EACH ROW EXECUTE FUNCTION update_anuncios_atualizado_em();
```

- [ ] **Step 5: Verificar as 3 tabelas**

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('lead_eventos','pixel_sessions','anuncios')
ORDER BY table_name;
```

Esperado: 3 linhas retornadas.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: migrations lead_eventos, pixel_sessions, anuncios"
```

---

## Task 2: Helper logEvento + hooks lead_criado

**Files:** Modify `server.js`

- [ ] **Step 1: Localizar onde supabase é inicializado em server.js**

Procurar pela linha que contém `createClient` — é logo no início do arquivo. Adicionar `logEvento` imediatamente após essa linha.

- [ ] **Step 2: Adicionar helper logEvento em server.js**

Após a linha que inicializa `const supabase = createClient(...)`, adicionar:

```js
function logEvento(leadId, tipo, descricao, metadata = {}, usuarioId = null) {
  if (!leadId) return;
  supabase.from('lead_eventos').insert({
    lead_id: leadId, tipo, descricao, metadata,
    usuario_id: usuarioId || null,
  }).then(() => {}).catch(e => console.error('[logEvento]', e.message));
}
```

- [ ] **Step 3: Hook lead_criado — criação via landing page `/lead`**

Na função do endpoint `GET /api/leads` que cria o lead (após `lead = inserted;`), adicionar:

```js
logEvento(lead.id, 'lead_criado',
  'Entrou via ' + origem + (m?.ctwa_clid ? ' (CTWA ✓)' : '') + (campanha ? ' — ' + campanha : ''),
  { origem, campanha: campanha || '', ctwa_clid: ctwa_clid || '', fbclid: fbclid || '' }
);
```

- [ ] **Step 4: Hook lead_criado — criação manual via POST /api/leads**

No handler `app.post('/api/leads', ...)`, após `res.json({ ok: true, lead })`, adicionar:

```js
logEvento(lead.id, 'lead_criado', 'Lead criado manualmente — ' + lead.origem,
  { origem: lead.origem }, req.user?.id || null);
```

- [ ] **Step 5: Hook lead_criado — criação via webhook WhatsApp**

No webhook `app.post('/webhooks/whatsapp', ...)`, após o `lead = inserted;` do novo lead via WA, adicionar:

```js
logEvento(lead.id, 'lead_criado',
  m.ctwa_clid ? 'Entrou via anúncio Meta (CTWA ✓)' : 'Primeira mensagem via WhatsApp',
  { origem: lead.origem, campanha: lead.campanha || '', ctwa_clid: m.ctwa_clid || '' }
);
```

- [ ] **Step 6: Verificar manualmente**

Criar um lead de teste via `http://2.24.94.120:3000/lead?name=Teste&phone=5531900000001&utm_source=meta`. Depois:

```sql
SELECT * FROM lead_eventos ORDER BY criado_em DESC LIMIT 5;
```

Esperado: 1 linha com `tipo = 'lead_criado'`.

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat: logEvento helper + hooks lead_criado"
```

---

## Task 3: Hooks status_mudou + mensagens

**Files:** Modify `server.js`

- [ ] **Step 1: Hook status_mudou em patchLead**

Na função `patchLead`, dentro do bloco `if (statusMudou)`, após a linha `const evtNome = EVENTOS_FUNIL[updated.status];`, adicionar:

```js
logEvento(updated.id, 'status_mudou',
  'Status: ' + leadAntes.status + ' → ' + updated.status,
  { de: leadAntes.status, para: updated.status },
  req.user?.id || null
);
```

- [ ] **Step 2: Hook mensagem_recebida + detecção template_respondido no webhook WA**

No webhook `app.post('/webhooks/whatsapp', ...)`, antes do `res.status(200).send('ok')`, adicionar:

```js
if (lead) {
  logEvento(lead.id, 'mensagem_recebida',
    'Mensagem recebida: "' + (m.texto || '').slice(0, 80) + (m.texto?.length > 80 ? '…' : '') + '"',
    { wa_id: m.id || '', tipo: m.tipo }
  );
  // Detectar resposta a template (janela 48h)
  const h48ago = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  supabase.from('lead_eventos')
    .select('id, metadata')
    .eq('lead_id', lead.id)
    .eq('tipo', 'template_enviado')
    .gte('criado_em', h48ago)
    .order('criado_em', { ascending: false })
    .limit(1)
    .then(async ({ data: tevts }) => {
      if (!tevts?.length) return;
      const { data: tresps } = await supabase.from('lead_eventos')
        .select('id').eq('lead_id', lead.id).eq('tipo', 'template_respondido')
        .gte('criado_em', tevts[0].criado_em).limit(1);
      if (tresps?.length) return; // já registrou resposta
      const minutos = Math.round((Date.now() - new Date(tevts[0].criado_em).getTime()) / 60000);
      logEvento(lead.id, 'template_respondido',
        'Respondeu ao template "' + (tevts[0].metadata?.template || '') + '" (' + minutos + ' min depois)',
        { template: tevts[0].metadata?.template || '', tempo_resposta_min: minutos }
      );
    }).catch(() => {});
}
```

- [ ] **Step 3: Hook mensagem_enviada em POST /api/leads/:id/whatsapp**

No handler `app.post('/api/leads/:id/whatsapp', ...)`, após o `res.json({ ok: true, resultado })`, adicionar:

```js
if (templateName) {
  // Buscar categoria do template
  supabase.from('templates').select('categoria').eq('nome', templateName).maybeSingle()
    .then(({ data: tpl }) => {
      logEvento(id, 'template_enviado',
        'Template enviado: ' + templateName,
        { template: templateName, categoria: tpl?.categoria || 'MARKETING' },
        req.user?.id || null
      );
    }).catch(() => {});
} else {
  logEvento(id, 'mensagem_enviada',
    'Mensagem enviada: "' + (texto || '').slice(0, 80) + (texto?.length > 80 ? '…' : '') + '"',
    {}, req.user?.id || null
  );
}
```

- [ ] **Step 4: Hook mensagem_enviada em POST /api/leads/:id/whatsapp/midia**

No handler `app.post('/api/leads/:id/whatsapp/midia', ...)`, após a resposta de sucesso, adicionar:

```js
logEvento(id, 'mensagem_enviada', 'Mídia enviada: ' + (originalname || 'arquivo'),
  { tipo: mimetype }, req.user?.id || null);
```

- [ ] **Step 5: Verificar manualmente**

Abrir uma conversa no CRM, mudar status do lead e enviar uma mensagem. Depois:

```sql
SELECT tipo, descricao, criado_em FROM lead_eventos
WHERE lead_id = <id_do_lead_teste>
ORDER BY criado_em DESC LIMIT 10;
```

Esperado: linhas com `status_mudou` e `mensagem_enviada`.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: hooks status_mudou, mensagem_recebida, template_respondido, mensagem_enviada"
```

---

## Task 4: Hooks template + ligacao + capi + clinicorp + periódicos

**Files:** Modify `server.js`

- [ ] **Step 1: Hook ligacao em POST /api/leads/:id/ligar**

No handler `app.post('/api/leads/:id/ligar', ...)`, após `res.json({ ok: true, ... })`, adicionar:

```js
logEvento(leadId, 'ligacao', 'Ligação iniciada via 3cplus',
  { threec_call_id: callId || '' }, req.user?.id || null);
```

- [ ] **Step 2: Hook capi_disparado em dispararConversaoMeta**

Na função `dispararConversaoMeta`, dentro do bloco `if (json.events_received)`, após o `console.log`, adicionar:

```js
logEvento(lead.id, 'capi_disparado',
  'CAPI: ' + eventName + ' enviado à Meta' + (parseFloat(lead.valor) > 0 ? ' (R$ ' + parseFloat(lead.valor).toFixed(2) + ')' : ''),
  { evento: eventName, valor: parseFloat(lead.valor) || 0 }
);
```

- [ ] **Step 3: Hook clinicorp_agendado em POST /api/leads/:id/agendar-clinicorp**

No handler `app.post('/api/leads/:id/agendar-clinicorp', ...)`, após `res.json({ ok: true, ... })`, adicionar:

```js
logEvento(leadId, 'clinicorp_agendado',
  'Agendado no Clinicorp: ' + dentista.nome + ' — ' + data,
  { dentista: dentista.nome, data, hora: hora_inicio, clinicorp_appointment_id },
  req.user?.id || null
);
```

- [ ] **Step 4: Estender syncComparecimentos com clinicorp_faltou e template_sem_resposta**

Localizar a função `syncComparecimentos` e, dentro do loop `for (const lead of leads)`, após o bloco de checkin, adicionar a detecção de faltou:

```js
// Detectar falta: appointment existe mas passou 24h sem checkin
const aptTime = new Date(apt.date || apt.Date || apt.AppointmentDate || 0);
const passou24h = Date.now() - aptTime.getTime() > 24 * 3600 * 1000;
const naoChegou = !chegou;
if (passou24h && naoChegou) {
  const { data: jaFaltou } = await supabase.from('lead_eventos')
    .select('id').eq('lead_id', lead.id).eq('tipo', 'clinicorp_faltou').limit(1);
  if (!jaFaltou?.length) {
    logEvento(lead.id, 'clinicorp_faltou',
      'Não compareceu à consulta agendada para ' + (apt.date || apt.Date || '').slice(0, 10),
      { clinicorp_appointment_id: lead.clinicorp_appointment_id }
    );
  }
}
```

Após o loop, adicionar detecção de template_sem_resposta:

```js
// Detectar templates sem resposta após 48h
try {
  const h48ago = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const { data: templatesExpirados } = await supabase.from('lead_eventos')
    .select('id, lead_id, metadata, criado_em')
    .eq('tipo', 'template_enviado')
    .lt('criado_em', h48ago)
    .limit(100);
  for (const te of (templatesExpirados || [])) {
    const { data: resp } = await supabase.from('lead_eventos')
      .select('id').eq('lead_id', te.lead_id)
      .in('tipo', ['template_respondido', 'template_sem_resposta'])
      .gte('criado_em', te.criado_em).limit(1);
    if (!resp?.length) {
      logEvento(te.lead_id, 'template_sem_resposta',
        'Sem resposta ao template "' + (te.metadata?.template || '') + '" após 48h',
        { template: te.metadata?.template || '' }
      );
    }
  }
} catch(e) { console.error('[sync] template_sem_resposta:', e.message); }
```

- [ ] **Step 5: Verificar manualmente — capi_disparado**

Mudar um lead de teste para "Agendado":

```sql
SELECT tipo, descricao, metadata FROM lead_eventos
WHERE tipo IN ('capi_disparado','clinicorp_agendado','ligacao')
ORDER BY criado_em DESC LIMIT 10;
```

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: hooks ligacao, capi_disparado, clinicorp_agendado, clinicorp_faltou, template_sem_resposta"
```

---

## Task 5: Endpoint /t + pixel_sessions + rota /track.js

**Files:** Modify `server.js`, `.env`, `.env.example`

- [ ] **Step 1: Gerar PIXEL_TRACK_TOKEN e adicionar ao .env**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copiar o valor gerado. Adicionar ao `.env`:

```
PIXEL_TRACK_TOKEN=<valor_gerado>
```

Adicionar ao `.env.example`:

```
PIXEL_TRACK_TOKEN=
```

- [ ] **Step 2: Adicionar rota /track.js em server.js**

Antes da linha `app.listen(...)`, adicionar:

```js
// ========== PIXEL RASTREIO ==========
app.get('/track.js', (req, res) => {
  const token = process.env.PIXEL_TRACK_TOKEN || '';
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Access-Control-Allow-Origin', 'https://clinicaodontoama.com.br');
  res.send(`(function(){
  var p=new URLSearchParams(location.search);
  var f=p.get('fbclid')||localStorage.getItem('_ama_fbclid');
  if(f)localStorage.setItem('_ama_fbclid',f);
  if(!f)return;
  fetch('https://plataformaama-plataforma.uc5as5.easypanel.host/t',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token:${JSON.stringify(token)},fbclid:f,evento:'PageView',pagina:location.pathname,referrer:document.referrer})
  }).catch(function(){});
})();`);
});
```

- [ ] **Step 3: Adicionar endpoint /t em server.js**

Logo após a rota `/track.js`, adicionar:

```js
app.post('/t', rateLimit, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://clinicaodontoama.com.br');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  const { token, fbclid, evento = 'PageView', pagina = '/', referrer = '' } = req.body || {};
  if (!token || token !== process.env.PIXEL_TRACK_TOKEN) return res.status(401).send('');
  if (!fbclid || typeof fbclid !== 'string' || fbclid.length > 500) return res.status(400).send('');
  const safeFbclid = fbclid.slice(0, 500);
  const safePagina = String(pagina).slice(0, 200);
  res.status(204).send('');
  try {
    const { data: sessao } = await supabase.from('pixel_sessions').insert({
      fbclid: safeFbclid, pagina: safePagina, evento,
      metadata: { referrer: String(referrer).slice(0, 200) },
    }).select().single();
    if (!sessao) return;
    // Tentar vincular a lead existente pelo fbclid
    const { data: lead } = await supabase.from('leads')
      .select('id').eq('fbclid', safeFbclid).maybeSingle();
    if (lead) {
      await supabase.from('pixel_sessions').update({ lead_id: lead.id }).eq('id', sessao.id);
      logEvento(lead.id, 'pixel_pagina',
        'Visitou: ' + safePagina + (referrer ? ' (via ' + String(referrer).replace(/^https?:\/\//, '').split('/')[0] + ')' : ''),
        { pagina: safePagina, referrer: String(referrer).slice(0, 200) }
      );
    }
  } catch(e) { console.error('[/t]', e.message); }
});

app.options('/t', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://clinicaodontoama.com.br');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.status(204).send('');
});
```

- [ ] **Step 4: Vincular pixel_sessions ao criar lead com fbclid**

Na função que cria lead via landing page (`GET /lead`), após `lead = inserted;`, adicionar:

```js
if (fbclid) {
  supabase.from('pixel_sessions')
    .update({ lead_id: lead.id })
    .eq('fbclid', fbclid).is('lead_id', null)
    .then(async () => {
      const { data: sessoes } = await supabase.from('pixel_sessions')
        .select('pagina, metadata, criado_em').eq('fbclid', fbclid).eq('lead_id', lead.id)
        .order('criado_em', { ascending: true });
      for (const s of (sessoes || [])) {
        logEvento(lead.id, 'pixel_pagina',
          'Visitou: ' + s.pagina,
          { pagina: s.pagina, referrer: s.metadata?.referrer || '' }
        );
      }
    }).catch(() => {});
}
```

- [ ] **Step 5: Verificar /track.js**

```bash
curl -s https://plataformaama-plataforma.uc5as5.easypanel.host/track.js | head -5
```

Esperado: começa com `(function(){`.

- [ ] **Step 6: Verificar /t com token correto**

```bash
TOKEN=$(grep PIXEL_TRACK_TOKEN .env | cut -d= -f2)
curl -s -o /dev/null -w "%{http_code}" -X POST \
  https://plataformaama-plataforma.uc5as5.easypanel.host/t \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\",\"fbclid\":\"test123\",\"pagina\":\"/implante\"}"
```

Esperado: `204`.

- [ ] **Step 7: Commit + deploy**

```bash
git add server.js .env.example
git commit -m "feat: /track.js e /t endpoint para rastreio site"
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

---

## Task 6: Backend APIs — Trajeto, Atribuição, Catálogo de Anúncios

**Files:** Modify `server.js`

- [ ] **Step 1: API GET /api/leads/:id/trajeto**

Adicionar antes do `app.listen`:

```js
app.get('/api/leads/:id/trajeto', requireAuth, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const offset = parseInt(req.query.offset, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const { data, error, count } = await supabase.from('lead_eventos')
      .select('*', { count: 'exact' })
      .eq('lead_id', id)
      .order('criado_em', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    res.json({ eventos: data || [], total: count || 0, offset, limit });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 2: API GET /api/atribuicao**

```js
app.get('/api/atribuicao', requireRole('admin', 'gestor'), rateLimit, async (req, res) => {
  try {
    const periodo = parseInt(req.query.periodo, 10) || 30;
    const desde = req.query.desde
      ? new Date(req.query.desde).toISOString()
      : new Date(Date.now() - periodo * 86400000).toISOString();
    const ate = req.query.ate ? new Date(req.query.ate).toISOString() : new Date().toISOString();

    const { data: leads, error } = await supabase.from('leads')
      .select('id,campanha,ctwa_clid,fbclid,gclid,status,valor,data_agendamento,data_comparecimento,criado_em')
      .gte('criado_em', desde).lte('criado_em', ate);
    if (error) throw error;

    const { data: catalog } = await supabase.from('anuncios').select('chave,nome,fonte').eq('ativo', true);
    const catalogMap = {};
    (catalog || []).forEach(a => { catalogMap[a.chave.toLowerCase()] = { nome: a.nome, fonte: a.fonte }; });

    const grupos = {};
    const addGrupo = (chave, fonte) => {
      if (!grupos[chave]) grupos[chave] = { chave, fonte, nome: catalogMap[chave.toLowerCase()]?.nome || chave, leads: 0, agendados: 0, compareceu: 0, fechados: 0, receita: 0 };
    };

    for (const l of leads) {
      let chave, fonte;
      if ((l.campanha && (l.ctwa_clid || l.fbclid))) { chave = l.campanha; fonte = 'meta'; }
      else if (l.ctwa_clid && !l.campanha) { chave = '__meta_sem_campanha__'; fonte = 'meta'; }
      else if (l.gclid) { chave = l.campanha || '__google__'; fonte = 'google'; }
      else { chave = '__organico__'; fonte = '-'; }

      addGrupo(chave, fonte);
      const g = grupos[chave];
      g.leads++;
      if (l.data_agendamento) g.agendados++;
      if (l.data_comparecimento) g.compareceu++;
      if (l.status === 'Fechou') { g.fechados++; if (l.valor) g.receita += parseFloat(l.valor); }
    }

    // Corrigir nomes especiais
    if (grupos['__meta_sem_campanha__']) grupos['__meta_sem_campanha__'].nome = 'Meta Ads (sem campanha)';
    if (grupos['__organico__']) grupos['__organico__'].nome = 'Orgânico / Direto';
    if (grupos['__google__']) grupos['__google__'].nome = 'Google (sem campanha)';

    const lista = Object.values(grupos).sort((a, b) => b.leads - a.leads);
    const totais = lista.reduce((acc, g) => {
      if (g.chave !== '__organico__') {
        acc.leads += g.leads; acc.agendados += g.agendados;
        acc.fechados += g.fechados; acc.receita += g.receita;
      }
      return acc;
    }, { leads: 0, agendados: 0, fechados: 0, receita: 0 });

    res.json({ grupos: lista, totais, periodo, desde, ate });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 3: APIs CRUD catálogo de anúncios**

```js
app.get('/api/anuncios', requireAuth, rateLimit, async (req, res) => {
  try {
    const { data, error } = await supabase.from('anuncios').select('*').order('criado_em', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/anuncios', requireRole('admin'), rateLimit, async (req, res) => {
  try {
    const { fonte, chave, nome, descricao = '' } = req.body;
    if (!fonte || !chave || !nome) return res.status(400).json({ error: 'fonte, chave e nome obrigatórios' });
    if (!['meta', 'google'].includes(fonte)) return res.status(400).json({ error: 'fonte inválida' });
    const { data, error } = await supabase.from('anuncios')
      .insert({ fonte, chave: String(chave).toLowerCase().trim(), nome: String(nome).trim(), descricao })
      .select().single();
    if (error) throw error;
    res.json({ ok: true, anuncio: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/anuncios/:id', requireRole('admin'), rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { nome, descricao, ativo } = req.body;
    const patch = {};
    if (nome !== undefined) patch.nome = String(nome).trim();
    if (descricao !== undefined) patch.descricao = String(descricao).trim();
    if (ativo !== undefined) patch.ativo = Boolean(ativo);
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada para atualizar' });
    const { data, error } = await supabase.from('anuncios').update(patch).eq('id', id).select().single();
    if (error) throw error;
    res.json({ ok: true, anuncio: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 4: Verificar APIs**

```bash
# Testar trajeto
curl -s -H "Authorization: Bearer <token>" \
  "http://2.24.94.120:3000/api/leads/5/trajeto" | head -c 200

# Testar atribuição
curl -s -H "Authorization: Bearer <token>" \
  "http://2.24.94.120:3000/api/atribuicao?periodo=30" | head -c 300
```

- [ ] **Step 5: Commit + deploy**

```bash
git add server.js
git commit -m "feat: APIs trajeto, atribuicao e catalogo de anuncios"
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

---

## Task 7: Campo Anúncio — enriquecer painel direito

**Files:** Modify `public/index.html`

O DOM já existe (`painel-anuncio-wrap` e `painel-anuncio`, linhas 762-765). Só precisamos enriquecer o JavaScript que o preenche.

- [ ] **Step 1: Localizar a função que preenche painel-anuncio**

Procurar por `painel-anuncio-wrap` no JS do index.html — está por volta da linha 2335.

O código atual é:
```js
const wrap = document.getElementById('painel-anuncio-wrap');
const el = document.getElementById('painel-anuncio');
const anuncio = lead.campanha || lead.ctwa_clid || '';
wrap.style.display = anuncio ? '' : 'none';
if (el) el.textContent = anuncio;
```

- [ ] **Step 2: Substituir a lógica do campo Anúncio**

Substituir o bloco identificado no Step 1 por:

```js
const wrap = document.getElementById('painel-anuncio-wrap');
const el = document.getElementById('painel-anuncio');
const temAnuncio = !!(lead.campanha || lead.ctwa_clid || lead.fbclid || lead.gclid);
wrap.style.display = temAnuncio ? '' : 'none';
if (el && temAnuncio) {
  let badge = '', link = '', cor = '#718096';
  if (lead.ctwa_clid) {
    badge = '<span style="background:rgba(34,197,94,.15);color:#16a34a;border-radius:4px;font-size:10px;font-weight:700;padding:2px 6px;margin-left:4px">CTWA ✓</span>';
    link = 'https://adsmanager.facebook.com'; cor = '#16a34a';
  } else if (lead.gclid) {
    badge = '<span style="background:rgba(59,130,246,.15);color:#2563eb;border-radius:4px;font-size:10px;font-weight:700;padding:2px 6px;margin-left:4px">Google</span>';
    link = 'https://ads.google.com'; cor = '#2563eb';
  } else if (lead.fbclid) {
    badge = '<span style="background:rgba(107,114,128,.15);color:#4b5563;border-radius:4px;font-size:10px;font-weight:700;padding:2px 6px;margin-left:4px">Meta (fbclid)</span>';
    link = 'https://adsmanager.facebook.com';
  }
  const chave = (lead.campanha || '').toLowerCase();
  // Lookup no catálogo
  api('/api/anuncios').then(catalog => {
    const entrada = (catalog || []).find(a => a.chave === chave && a.ativo);
    const nome = entrada?.nome || lead.campanha || (lead.ctwa_clid ? 'Meta Ads (sem campanha)' : lead.fbclid ? 'Meta Ads' : 'Google Ads');
    const esc2 = s => String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const nomeEsc = esc2(nome);
  const linkHtml = link
      ? `<a href="${esc2(link)}" target="_blank" rel="noopener" style="color:${cor};text-decoration:none;word-break:break-all">${nomeEsc} ↗</a>`
      : `<span style="word-break:break-all">${nomeEsc}</span>`;
    el.innerHTML = linkHtml + badge;
  }).catch(() => {
    el.innerHTML = `<span style="word-break:break-all">${lead.campanha || 'Meta Ads'}</span>` + badge;
  });
}
```

- [ ] **Step 3: Verificar no browser**

Abrir o CRM → WhatsApp CRC Lead → clicar num lead que veio de anúncio. O painel direito deve mostrar o campo "Anúncio / Campanha" com badge verde "CTWA ✓" ou azul "Google".

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: campo Anuncio enriquecido com badge e lookup catalogo"
```

---

## Task 8: Aba Trajeto no painel do lead

**Files:** Modify `public/index.html`

- [ ] **Step 1: Adicionar tabs no topo do chat-painel**

Localizar a linha do `<div id="chat-painel"` (linha ~753). Imediatamente após a abertura dessa div, adicionar o seletor de tabs e wrappear o conteúdo existente:

```html
<!-- Tabs Perfil / Trajeto -->
<div style="display:flex;border-bottom:1px solid var(--border);margin:-14px -14px 14px;padding:0 4px">
  <button id="tab-btn-perfil" onclick="switchPainelTab('perfil')"
    style="flex:1;padding:9px 4px;font-size:12px;font-weight:600;border:none;background:none;cursor:pointer;border-bottom:2px solid var(--accent);color:var(--accent)">Perfil</button>
  <button id="tab-btn-trajeto" onclick="switchPainelTab('trajeto')"
    style="flex:1;padding:9px 4px;font-size:12px;font-weight:600;border:none;background:none;cursor:pointer;border-bottom:2px solid transparent;color:var(--muted)">Trajeto</button>
</div>
<div id="painel-tab-perfil" style="display:flex;flex-direction:column;gap:14px">
  <!-- TODO: mover aqui todo o conteúdo atual do chat-painel (STATUS até ANOTAÇÕES SDR) -->
</div>
<div id="painel-tab-trajeto" style="display:none;flex-direction:column;gap:8px">
  <div id="trajeto-lista" style="display:flex;flex-direction:column;gap:6px;font-size:12px"></div>
  <button id="trajeto-mais" onclick="carregarMaisTrajeto()" style="display:none;width:100%;padding:6px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:11.5px;color:var(--muted)">Carregar mais</button>
</div>
```

Envolver o conteúdo existente (STATUS, ORIGEM, ANÚNCIO, DISC, CLINICORP, PRÓXIMO CONTATO, ANOTAÇÕES) dentro do `div#painel-tab-perfil`.

- [ ] **Step 2: Adicionar JS para as tabs e renderização do Trajeto**

No bloco de scripts do `index.html`, adicionar:

```js
function switchPainelTab(tab) {
  const isPerfil = tab === 'perfil';
  document.getElementById('painel-tab-perfil').style.display = isPerfil ? 'flex' : 'none';
  document.getElementById('painel-tab-perfil').style.flexDirection = 'column';
  document.getElementById('painel-tab-trajeto').style.display = isPerfil ? 'none' : 'flex';
  document.getElementById('tab-btn-perfil').style.borderBottomColor = isPerfil ? 'var(--accent)' : 'transparent';
  document.getElementById('tab-btn-perfil').style.color = isPerfil ? 'var(--accent)' : 'var(--muted)';
  document.getElementById('tab-btn-trajeto').style.borderBottomColor = !isPerfil ? 'var(--accent)' : 'transparent';
  document.getElementById('tab-btn-trajeto').style.color = !isPerfil ? 'var(--accent)' : 'var(--muted)';
  if (!isPerfil && chatLeadAtual) carregarTrajeto(chatLeadAtual.id, 0);
}

const _TRAJETO_ICONES = {
  lead_criado:'🟢', status_mudou:'🔄', mensagem_recebida:'💬', mensagem_enviada:'📤',
  template_enviado:'📋', template_respondido:'↩️', template_sem_resposta:'⏳',
  ligacao:'📞', capi_disparado:'📡', clinicorp_agendado:'📅', clinicorp_faltou:'❌', pixel_pagina:'🌐'
};

let _trajetoOffset = 0;
let _trajetoTotal = 0;
let _trajetoLeadId = null;

function _formatBR(iso) {
  const d = new Date(iso);
  const opts = { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
  const parts = new Intl.DateTimeFormat('pt-BR', opts).formatToParts(d);
  const p = {};
  parts.forEach(x => p[x.type] = x.value);
  return p.day + '/' + p.month + ' ' + p.hour + ':' + p.minute;
}

async function carregarTrajeto(leadId, offset = 0) {
  _trajetoLeadId = leadId;
  if (offset === 0) {
    document.getElementById('trajeto-lista').innerHTML = '<div style="color:var(--muted);font-size:11px;text-align:center;padding:12px">Carregando...</div>';
    _trajetoOffset = 0;
  }
  try {
    const r = await api('/api/leads/' + leadId + '/trajeto?offset=' + offset + '&limit=50');
    _trajetoTotal = r.total;
    _trajetoOffset = offset + r.eventos.length;
    const lista = document.getElementById('trajeto-lista');
    if (offset === 0) lista.innerHTML = '';
    if (!r.eventos.length && offset === 0) {
      lista.innerHTML = '<div style="color:var(--muted);font-size:11px;text-align:center;padding:12px">Nenhum evento ainda.</div>';
      return;
    }
    const esc = s => String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    r.eventos.forEach(ev => {
      const icone = _TRAJETO_ICONES[ev.tipo] || '•';
      const hora = _formatBR(ev.criado_em);
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;gap:6px;align-items:flex-start;padding:5px 0;border-bottom:1px solid var(--border)';
      div.innerHTML = `<span style="font-size:13px;flex-shrink:0">${icone}</span><div><div style="color:var(--muted);font-size:10.5px">${hora}</div><div style="line-height:1.4">${esc(ev.descricao)}</div></div>`;
      lista.appendChild(div);
    });
    const btnMais = document.getElementById('trajeto-mais');
    btnMais.style.display = _trajetoOffset < _trajetoTotal ? '' : 'none';
  } catch(e) {
    document.getElementById('trajeto-lista').innerHTML = '<div style="color:var(--red);font-size:11px">Erro ao carregar trajeto.</div>';
  }
}

function carregarMaisTrajeto() {
  if (_trajetoLeadId) carregarTrajeto(_trajetoLeadId, _trajetoOffset);
}
```

- [ ] **Step 3: Resetar tab ao abrir novo lead**

Na função `abrirChat(leadId)`, adicionar no início:

```js
switchPainelTab('perfil');
```

- [ ] **Step 4: Verificar no browser**

Abrir CRM → clicar em um lead → verificar que aparecem as tabs "Perfil" e "Trajeto" no painel direito. Clicar em "Trajeto" — deve mostrar os eventos já registrados para o lead.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: aba Trajeto no painel do lead com timeline paginada"
```

---

## Task 9: Página /atribuicao/ + catálogo de anúncios

**Files:** Create `public/atribuicao/index.html`, Modify `public/index.html` and `public/js/shared-nav.js`

- [ ] **Step 1: Criar public/atribuicao/index.html**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Atribuição — CRM AMA</title>
  <link rel="stylesheet" href="/style.css">
  <script src="/js/shared-nav.js" data-active="atribuicao" defer></script>
</head>
<body class="crm-shell">
<main style="flex:1;padding:28px 32px;overflow-y:auto;max-width:1100px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px">
    <h1 style="font-size:20px;font-weight:700;margin:0">Atribuição por Anúncio</h1>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <select id="fil-periodo" onchange="aplicarFiltro()" style="padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px">
        <option value="7">Últimos 7 dias</option>
        <option value="30" selected>Últimos 30 dias</option>
        <option value="90">Últimos 90 dias</option>
        <option value="0">Período personalizado</option>
      </select>
      <input type="date" id="fil-desde" style="display:none;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px" onchange="aplicarFiltro()">
      <input type="date" id="fil-ate" style="display:none;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px" onchange="aplicarFiltro()">
    </div>
  </div>

  <!-- Cards resumo -->
  <div id="cards-resumo" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:28px"></div>

  <!-- Tabela -->
  <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:28px">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="border-bottom:1px solid var(--border);background:var(--bg3)">
          <th style="padding:10px 14px;text-align:left;font-weight:600;color:var(--muted)">Fonte</th>
          <th style="padding:10px 14px;text-align:left;font-weight:600;color:var(--muted)">Anúncio / Campanha</th>
          <th style="padding:10px 14px;text-align:right;font-weight:600;color:var(--muted)">Leads</th>
          <th style="padding:10px 14px;text-align:right;font-weight:600;color:var(--muted)">Agendados</th>
          <th style="padding:10px 14px;text-align:right;font-weight:600;color:var(--muted)">Compareceu</th>
          <th style="padding:10px 14px;text-align:right;font-weight:600;color:var(--muted)">Fechados</th>
          <th style="padding:10px 14px;text-align:right;font-weight:600;color:var(--muted)">Receita</th>
          <th style="padding:10px 14px;text-align:right;font-weight:600;color:var(--muted)">Conv.</th>
        </tr>
      </thead>
      <tbody id="tabela-atribuicao"></tbody>
    </table>
  </div>

  <!-- Catálogo de anúncios (admin) -->
  <div id="catalogo-wrap" style="display:none">
    <details style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:16px">
      <summary style="font-weight:700;font-size:14px;cursor:pointer;user-select:none">Catálogo de Anúncios</summary>
      <div style="margin-top:14px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select id="cat-fonte" style="padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px">
            <option value="meta">Meta</option><option value="google">Google</option>
          </select>
          <input id="cat-chave" placeholder="Chave (ad_id ou utm_campaign)" style="flex:1;min-width:160px;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px">
          <input id="cat-nome" placeholder="Nome legível" style="flex:1;min-width:160px;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px">
          <input id="cat-desc" placeholder="Descrição (opcional)" style="flex:1;min-width:140px;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px">
          <button onclick="adicionarAnuncio()" style="padding:6px 14px;background:var(--accent);color:white;border:none;border-radius:8px;cursor:pointer;font-size:13px">Adicionar</button>
        </div>
        <div id="catalogo-lista" style="display:flex;flex-direction:column;gap:6px"></div>
      </div>
    </details>
  </div>
</main>

<script>
const TOKEN_KEY = [...Object.keys(localStorage)].find(k=>k.startsWith('sb-')&&k.endsWith('-auth-token'));
const _tkn = TOKEN_KEY ? JSON.parse(localStorage.getItem(TOKEN_KEY)||'{}')?.access_token : null;
const _api = (path, opts={}) => fetch(path, { headers: { 'Authorization': 'Bearer ' + _tkn, 'Content-Type': 'application/json', ...(opts.headers||{}) }, ...opts }).then(r=>{ if(!r.ok) throw new Error(r.status); return r.json(); });
const esc = s => String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const brl = v => 'R$ ' + Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:0});

function getFiltroParams() {
  const p = document.getElementById('fil-periodo').value;
  if (p === '0') {
    const desde = document.getElementById('fil-desde').value;
    const ate = document.getElementById('fil-ate').value;
    return desde && ate ? `desde=${desde}&ate=${ate}` : 'periodo=30';
  }
  return 'periodo=' + p;
}

document.getElementById('fil-periodo').addEventListener('change', function() {
  const custom = this.value === '0';
  document.getElementById('fil-desde').style.display = custom ? '' : 'none';
  document.getElementById('fil-ate').style.display = custom ? '' : 'none';
});

async function aplicarFiltro() {
  try {
    const params = getFiltroParams();
    const [dados, catalog] = await Promise.all([
      _api('/api/atribuicao?' + params),
      _api('/api/anuncios')
    ]);
    renderCards(dados.totais);
    renderTabela(dados.grupos);

    // Mostrar catálogo só para admin
    const perfRes = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + _tkn }});
    if (perfRes.ok) {
      const perf = await perfRes.json();
      if (perf?.roles?.includes('admin')) {
        document.getElementById('catalogo-wrap').style.display = '';
        renderCatalogo(catalog);
      }
    }
  } catch(e) { console.error(e); }
}

function renderCards(t) {
  document.getElementById('cards-resumo').innerHTML = [
    ['Leads via anúncio', t.leads, ''],
    ['Agendados', t.agendados, ''],
    ['Fechados', t.fechados, ''],
    ['Receita atribuída', brl(t.receita), '💰'],
  ].map(([l,v,ic]) => `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:16px">
      <div style="font-size:12px;color:var(--muted);margin-bottom:6px">${ic} ${l}</div>
      <div style="font-size:22px;font-weight:700">${esc(String(v))}</div>
    </div>`).join('');
}

function renderTabela(grupos) {
  const fonteLabel = { meta: '📘 Meta', google: '🔍 Google', '-': '—' };
  document.getElementById('tabela-atribuicao').innerHTML = grupos.map(g => {
    const conv = g.leads ? Math.round(g.fechados / g.leads * 100) : 0;
    return `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:10px 14px;color:var(--muted)">${esc(fonteLabel[g.fonte]||g.fonte)}</td>
      <td style="padding:10px 14px;font-weight:500">${esc(g.nome)}</td>
      <td style="padding:10px 14px;text-align:right">${g.leads}</td>
      <td style="padding:10px 14px;text-align:right">${g.agendados}</td>
      <td style="padding:10px 14px;text-align:right">${g.compareceu}</td>
      <td style="padding:10px 14px;text-align:right">${g.fechados}</td>
      <td style="padding:10px 14px;text-align:right">${brl(g.receita)}</td>
      <td style="padding:10px 14px;text-align:right;color:${conv>=30?'var(--green)':conv>=15?'var(--text)':'var(--red)'}">${conv}%</td>
    </tr>`;
  }).join('');
}

function renderCatalogo(catalog) {
  document.getElementById('catalogo-lista').innerHTML = catalog.map(a => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg3);border-radius:8px;font-size:13px">
      <span style="color:var(--muted);font-size:11px;min-width:45px">${esc(a.fonte)}</span>
      <span style="color:var(--muted);font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(a.chave)}">${esc(a.chave)}</span>
      <span style="font-weight:600;flex:1">${esc(a.nome)}</span>
      <span style="color:${a.ativo?'var(--green)':'var(--red)'};font-size:11px">${a.ativo?'ativo':'inativo'}</span>
      <button onclick="toggleAnuncio(${a.id},${!a.ativo})" style="padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:none;cursor:pointer;font-size:11px;color:var(--muted)">${a.ativo?'Desativar':'Ativar'}</button>
    </div>`).join('') || '<div style="color:var(--muted);font-size:12px">Nenhum anúncio catalogado.</div>';
}

async function adicionarAnuncio() {
  const fonte = document.getElementById('cat-fonte').value;
  const chave = document.getElementById('cat-chave').value.trim();
  const nome = document.getElementById('cat-nome').value.trim();
  const descricao = document.getElementById('cat-desc').value.trim();
  if (!chave || !nome) return alert('Chave e nome são obrigatórios.');
  try {
    await _api('/api/anuncios', { method:'POST', body: JSON.stringify({ fonte, chave, nome, descricao }) });
    document.getElementById('cat-chave').value = '';
    document.getElementById('cat-nome').value = '';
    document.getElementById('cat-desc').value = '';
    aplicarFiltro();
  } catch(e) { alert('Erro: ' + e.message); }
}

async function toggleAnuncio(id, ativo) {
  try {
    await _api('/api/anuncios/' + id, { method:'PATCH', body: JSON.stringify({ ativo }) });
    aplicarFiltro();
  } catch(e) { alert('Erro: ' + e.message); }
}

aplicarFiltro();
</script>
</body>
</html>
```

- [ ] **Step 2: Adicionar /atribuicao/ ao nav do index.html**

No `index.html`, localizar o bloco de nav-btns. Antes do botão de "Usuários" (ou antes do último botão), adicionar:

```html
<a class="nav-btn" href="/atribuicao/" data-roles="admin,gestor">
  <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
  Atribuição
</a>
```

- [ ] **Step 3: Adicionar /atribuicao/ ao shared-nav.js**

Localizar o array de links em `shared-nav.js` e adicionar a entrada correspondente para a sidebar funcionar em páginas separadas. Procurar por onde os links são definidos no arquivo e adicionar:

```js
{ href: '/atribuicao/', label: 'Atribuição', slug: 'atribuicao', roles: ['admin','gestor'],
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>' }
```

- [ ] **Step 4: Verificar no browser**

Acessar `http://2.24.94.120:3000/atribuicao/` — deve mostrar a página com cards e tabela. Logar como admin para ver o catálogo de anúncios.

- [ ] **Step 5: Commit + deploy**

```bash
git add public/atribuicao/index.html public/index.html public/js/shared-nav.js
git commit -m "feat: pagina /atribuicao/ com cards, tabela e catalogo de anuncios"
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

---

## Task 10: Verificação final e instruções site

**Files:** Verificações manuais + instrução para o site

- [ ] **Step 1: Verificar fluxo completo**

```sql
-- Ver todos os tipos de eventos sendo gerados
SELECT tipo, count(*) FROM lead_eventos GROUP BY tipo ORDER BY count DESC;
```

- [ ] **Step 2: Verificar página de Atribuição**

Acessar `/atribuicao/` como admin e gestor. Confirmar:
- Cards mostram valores corretos
- Tabela agrupa por campanha
- Catálogo permite adicionar/desativar

- [ ] **Step 3: Verificar aba Trajeto**

Abrir um lead com eventos. Clicar em "Trajeto". Confirmar timeline em ordem decrescente com horários no formato `DD/MM HH:MM` em horário Brasília.

- [ ] **Step 4: Adicionar script ao site clinicaodontoama.com.br**

Instruir o responsável pelo site a adicionar no `<head>` de todas as páginas:

```html
<script src="https://plataformaama-plataforma.uc5as5.easypanel.host/track.js" defer></script>
```

- [ ] **Step 5: Commit final**

```bash
git add -A
git commit -m "feat: trajeto + atribuicao completos - verificacao final"
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

---

## Self-Review do Plano

### Cobertura do spec:

| Seção do spec | Tarefa |
|---|---|
| Tabela lead_eventos | Task 1 |
| Tabela pixel_sessions | Task 1 |
| Tabela anuncios + trigger | Task 1 |
| Helper logEvento | Task 2 |
| Hook lead_criado (3 paths) | Task 2 |
| Hook status_mudou | Task 3 |
| Hook mensagem_recebida + template_respondido | Task 3 |
| Hook mensagem_enviada | Task 3 |
| Hook template_enviado | Task 3 |
| Hook ligacao | Task 4 |
| Hook capi_disparado | Task 4 |
| Hook clinicorp_agendado | Task 4 |
| Hook clinicorp_faltou + template_sem_resposta | Task 4 |
| /track.js dinâmico com token | Task 5 |
| /t endpoint com CORS + rate limit | Task 5 |
| pixel_sessions linking | Task 5 |
| API GET /api/leads/:id/trajeto | Task 6 |
| API GET /api/atribuicao | Task 6 |
| APIs CRUD /api/anuncios | Task 6 |
| Campo Anúncio com badge + catalog lookup | Task 7 |
| Aba Trajeto com timeline paginada | Task 8 |
| Timezone America/Sao_Paulo | Task 8 |
| Página /atribuicao/ com cards + tabela | Task 9 |
| Catálogo de anúncios (admin) | Task 9 |
| Nav sidebar + shared-nav.js | Task 9 |
| Script no site | Task 10 |

Todas as seções do spec cobertas. ✅

### Verificação de consistência de tipos:
- `logEvento(leadId, tipo, descricao, metadata, usuarioId)` — assinatura consistente em todas as Tasks 2-4 ✅
- `lead_id bigint` em lead_eventos e pixel_sessions — consistente com `leads.id bigint` ✅
- `chave` sempre lowercase via `.toLowerCase()` — consistente entre Task 1 SQL e Task 6 JS ✅
- API `/api/leads/:id/trajeto` retorna `{ eventos, total, offset, limit }` — consumido corretamente na Task 8 ✅
