# Monitor Diário das CRCs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Painel `/monitor-crc/` com métricas diárias por CRC (conversas, mensagens, templates, agendamentos, movimentações, ligações, anotações, 1ª resposta, fila sem resposta) + push automático às 18h30 para gestores.

**Architecture:** Agregador puro em `lib/monitor/crc.js` (testável, sem IO); endpoint `GET /api/monitor-crc` faz o IO (lead_eventos + mensagens + ligacoes + RPC de esperas abertas) e aplica escopo por role; página separada no padrão de módulo do CRM; cron in-process dispara o resumo via infra de push existente (`criarNotificacao`).

**Tech Stack:** Node/Express, Supabase (migrations via MCP), vanilla JS, `node --test`.

**Spec:** `docs/superpowers/specs/2026-06-11-monitor-crc-diario-design.md`

**Contexto para o executor:**
- Projeto: `C:\Users\Luiz Martins\Desktop\Projeto Claude Code\clinica-crm` (Windows, branch main — padrão do repo; commits locais, push só na última task).
- Migrations: versionar em `supabase/migrations/` E aplicar via MCP Supabase (`apply_migration`, project_id `mtqdpjhhqzvuklnlfpvi`) — se o subagente não tiver MCP, criar o arquivo e reportar DONE_WITH_CONCERNS para o controller aplicar.
- Commits: mensagem ASCII pura, single `-m` (PowerShell 5.1 quebra com aspas/emoji embutidos).
- Deploy (última task): `curl.exe -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`.
- Fatos verificados: `ligacoes` tem `usuario_id/status/modulo/duracao_segundos`; o discador do CRC grava `modulo: 'leads'` (server.js, rota `/api/leads/:id/ligar`); a tabela está vazia hoje → "atendida" = `duracao_segundos > 0`. Push: `sendPushToUser(usuarioId, title, body, data)` e `criarNotificacao(usuarioId, tipo, titulo, corpo, metadata)` já existem em server.js (~linha 4907). `app_config` tem linha única `id=1`. Brasil não tem horário de verão desde 2019 → offset fixo `-03:00` é o padrão já usado no repo (ver `/api/meta-agendamentos`).

---

### Task 1: Agregador puro `montarMonitorCrc` + `resumoCrcTexto` (TDD)

**Files:**
- Create: `lib/monitor/crc.js`
- Test: `lib/monitor/crc.test.js`

- [ ] **Step 1: Write the failing tests** — criar `lib/monitor/crc.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { montarMonitorCrc, resumoCrcTexto } = require('./crc');

const DIA = { from: '2026-06-11T00:00:00-03:00', to: '2026-06-11T23:59:59.999-03:00' };
const T = h => `2026-06-11T${h}:00-03:00`; // ex.: T('10:30') = 10h30 BRT
const ANA = 'aaaaaaaa-0000-0000-0000-000000000001';
const BIA = 'bbbbbbbb-0000-0000-0000-000000000002';

function ev(tipo, lead_id, usuario_id, criado_em, metadata = {}) {
  return { tipo, lead_id, usuario_id, criado_em, metadata };
}

test('conversas = leads distintos (mensagem OU template); mensagens e templates contam volume', () => {
  const m = montarMonitorCrc({ periodo: DIA, eventos: [
    ev('mensagem_enviada', 1, ANA, T('09:00')),
    ev('mensagem_enviada', 1, ANA, T('09:05')),
    ev('template_enviado', 2, ANA, T('10:00')),
    ev('mensagem_enviada', 3, BIA, T('11:00')),
  ] });
  const ana = m.porCrc.find(c => c.usuario_id === ANA);
  assert.strictEqual(ana.conversas, 2);   // leads 1 e 2
  assert.strictEqual(ana.mensagens, 2);
  assert.strictEqual(ana.templates, 1);
  assert.strictEqual(m.time.conversas, 3); // 1,2,3 (união, não soma)
});

test('eventos do sistema (usuario_id null) e fora da janela ficam de fora', () => {
  const m = montarMonitorCrc({ periodo: DIA, eventos: [
    ev('mensagem_enviada', 1, null, T('09:00')),                       // sistema
    ev('mensagem_enviada', 1, ANA, '2026-06-10T09:00:00-03:00'),       // ontem
    ev('status_mudou', 2, ANA, T('10:00'), { para: 'Agendado' }),
  ] });
  assert.strictEqual(m.porCrc.length, 1);
  assert.strictEqual(m.porCrc[0].mensagens, 0);
  assert.strictEqual(m.porCrc[0].agendamentos, 1);
});

test('movimentacoes com breakdown por destino; Agendado tambem conta em agendamentos', () => {
  const m = montarMonitorCrc({ periodo: DIA, eventos: [
    ev('status_mudou', 1, ANA, T('09:00'), { para: 'Agendado' }),
    ev('status_mudou', 2, ANA, T('09:10'), { para: 'Não tem Interesse' }),
    ev('status_mudou', 3, ANA, T('09:20'), { para: 'Não tem Interesse' }),
  ] });
  const ana = m.porCrc[0];
  assert.strictEqual(ana.movimentacoes.total, 3);
  assert.strictEqual(ana.movimentacoes.porDestino['Agendado'], 1);
  assert.strictEqual(ana.movimentacoes.porDestino['Não tem Interesse'], 2);
  assert.strictEqual(ana.agendamentos, 1);
});

test('anotacoes conta eventos nota_sdr_editada', () => {
  const m = montarMonitorCrc({ periodo: DIA, eventos: [
    ev('nota_sdr_editada', 1, ANA, T('09:00')),
    ev('nota_sdr_editada', 1, ANA, T('10:00')),
  ] });
  assert.strictEqual(m.porCrc[0].anotacoes, 2);
});

test('ligacoes: total e atendidas (duracao > 0)', () => {
  const m = montarMonitorCrc({ periodo: DIA, eventos: [], ligacoes: [
    { usuario_id: ANA, duracao_segundos: 35 },
    { usuario_id: ANA, duracao_segundos: 0 },
    { usuario_id: ANA, duracao_segundos: null },
  ] });
  assert.deepStrictEqual(m.porCrc[0].ligacoes, { total: 3, atendidas: 1 });
});

test('1a resposta: rajada de recebidas = UMA espera; media atribuida a quem respondeu', () => {
  const m = montarMonitorCrc({ periodo: DIA,
    recebidas: [
      { lead_id: 1, criada_em: T('09:00') },
      { lead_id: 1, criada_em: T('09:02') }, // rajada: não abre nova espera
    ],
    eventos: [ ev('mensagem_enviada', 1, ANA, T('09:30')) ],
  });
  const ana = m.porCrc[0];
  assert.strictEqual(ana.respostas, 1);
  assert.strictEqual(ana.primeiraRespostaMediaMin, 30); // desde 09:00, não 09:02
});

test('1a resposta: segunda espera depois de respondida; resposta de outro dia fecha espera do dia', () => {
  const m = montarMonitorCrc({ periodo: DIA,
    recebidas: [
      { lead_id: 1, criada_em: T('09:00') },
      { lead_id: 1, criada_em: T('14:00') }, // nova espera após resposta
    ],
    eventos: [
      ev('mensagem_enviada', 1, ANA, T('09:10')),                      // fecha a 1ª (10min)
      ev('mensagem_enviada', 1, BIA, '2026-06-12T08:00:00-03:00'),     // dia seguinte fecha a 2ª (18h = 1080min)
    ],
  });
  const ana = m.porCrc.find(c => c.usuario_id === ANA);
  const bia = m.porCrc.find(c => c.usuario_id === BIA);
  assert.strictEqual(ana.primeiraRespostaMediaMin, 10);
  assert.strictEqual(bia.respostas, 1);
  assert.strictEqual(bia.primeiraRespostaMediaMin, 1080);
  assert.strictEqual(m.time.respostas, 2);
});

test('espera aberta nao entra na media; sem respostas => media null', () => {
  const m = montarMonitorCrc({ periodo: DIA,
    recebidas: [{ lead_id: 9, criada_em: T('16:00') }],
    eventos: [ ev('mensagem_enviada', 8, ANA, T('10:00')) ], // outro lead
  });
  const ana = m.porCrc[0];
  assert.strictEqual(ana.respostas, 0); // a mensagem da ANA foi pro lead 8, não fecha a espera do lead 9
  assert.strictEqual(ana.primeiraRespostaMediaMin, null);
});

test('esperasAbertas passa direto para time.semResposta', () => {
  const abertas = [{ lead_id: 5, nome: 'Maria', desde: T('08:00') }];
  const m = montarMonitorCrc({ periodo: DIA, eventos: [], esperasAbertas: abertas });
  assert.deepStrictEqual(m.time.semResposta, abertas);
});

test('resumoCrcTexto monta o texto do push', () => {
  const m = montarMonitorCrc({ periodo: DIA, eventos: [
    ev('mensagem_enviada', 1, ANA, T('09:00')),
    ev('status_mudou', 1, ANA, T('09:30'), { para: 'Agendado' }),
    ev('mensagem_enviada', 2, BIA, T('10:00')),
  ], esperasAbertas: [{ lead_id: 7, nome: 'X', desde: T('07:00') }] });
  const txt = resumoCrcTexto(m, { [ANA]: 'Paola Cristine', [BIA]: 'Maria José' }, '11/06');
  assert.match(txt, /Resumo CRC 11\/06/);
  assert.match(txt, /2 conversas/);
  assert.match(txt, /1 agendamento/);
  assert.match(txt, /1 sem resposta/);
  assert.match(txt, /Paola 1c\/1a/);
  assert.match(txt, /Maria 1c\/0a/);
});
```

- [ ] **Step 2: Run to verify FAIL** — `node --test lib/monitor/crc.test.js` → "Cannot find module './crc'".

- [ ] **Step 3: Implement** — criar `lib/monitor/crc.js` (UTF-8 sem BOM):

```js
// lib/monitor/crc.js
// Monitor diário das CRCs — agregação PURA e testável (IO fica no endpoint).
// Entradas já são do dia consultado, EXCETO `eventos` de resposta (mensagem_enviada/
// template_enviado), que podem vir até "agora" para fechar esperas iniciadas no dia.
// Eventos de sistema (usuario_id null) não contam para nenhuma CRC.

const MS_MIN = 60000;

function _dentro(iso, periodo) {
  const t = new Date(iso).getTime();
  return t >= new Date(periodo.from).getTime() && t <= new Date(periodo.to).getTime();
}

function montarMonitorCrc({ periodo, eventos = [], recebidas = [], ligacoes = [], esperasAbertas = [] }) {
  const porCrc = new Map();
  const crc = (id) => {
    if (!porCrc.has(id)) porCrc.set(id, {
      usuario_id: id, conversasSet: new Set(), mensagens: 0, templates: 0,
      agendamentos: 0, movimentacoes: { total: 0, porDestino: {} },
      ligacoes: { total: 0, atendidas: 0 }, anotacoes: 0,
      respostas: 0, esperaMsTotal: 0,
    });
    return porCrc.get(id);
  };

  // ---- contagens do dia (só eventos de CRC dentro da janela) ----
  for (const e of eventos) {
    if (!e.usuario_id || !_dentro(e.criado_em, periodo)) continue;
    const c = crc(e.usuario_id);
    if (e.tipo === 'mensagem_enviada') { c.mensagens++; c.conversasSet.add(e.lead_id); }
    else if (e.tipo === 'template_enviado') { c.templates++; c.conversasSet.add(e.lead_id); }
    else if (e.tipo === 'status_mudou') {
      const para = (e.metadata && e.metadata.para) || '?';
      c.movimentacoes.total++;
      c.movimentacoes.porDestino[para] = (c.movimentacoes.porDestino[para] || 0) + 1;
      if (para === 'Agendado') c.agendamentos++;
    }
    else if (e.tipo === 'nota_sdr_editada') c.anotacoes++;
  }

  // ---- ligações (IO já filtrou dia + modulo='leads') ----
  for (const l of ligacoes) {
    if (!l.usuario_id) continue;
    const c = crc(l.usuario_id);
    c.ligacoes.total++;
    if ((l.duracao_segundos || 0) > 0) c.ligacoes.atendidas++;
  }

  // ---- 1ª resposta: espera abre na recebida sem espera pendente, fecha na
  // próxima resposta (mensagem OU template) do mesmo lead, por qualquer CRC ----
  const respPorLead = new Map();
  for (const e of eventos) {
    if (e.tipo !== 'mensagem_enviada' && e.tipo !== 'template_enviado') continue;
    if (!respPorLead.has(e.lead_id)) respPorLead.set(e.lead_id, []);
    respPorLead.get(e.lead_id).push(e); // respostas pós-dia também fecham esperas
  }
  for (const arr of respPorLead.values()) arr.sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em));
  const recPorLead = new Map();
  for (const r of recebidas) {
    if (!recPorLead.has(r.lead_id)) recPorLead.set(r.lead_id, []);
    recPorLead.get(r.lead_id).push(r);
  }
  for (const [leadId, recs] of recPorLead) {
    recs.sort((a, b) => new Date(a.criada_em) - new Date(b.criada_em));
    const resps = respPorLead.get(leadId) || [];
    let ri = 0, pendente = null;
    const fechar = (resp) => {
      if (resp.usuario_id) {
        const c = crc(resp.usuario_id);
        c.respostas++;
        c.esperaMsTotal += new Date(resp.criado_em).getTime() - pendente;
      }
      pendente = null;
    };
    for (const rec of recs) {
      const t = new Date(rec.criada_em).getTime();
      while (ri < resps.length && new Date(resps[ri].criado_em).getTime() < t) {
        if (pendente !== null) fechar(resps[ri]);
        ri++;
      }
      if (pendente === null) pendente = t; // rajada não abre nova espera
    }
    while (ri < resps.length && pendente !== null) { fechar(resps[ri]); ri++; }
    // pendente !== null aqui = espera aberta → vem pronta em esperasAbertas (IO)
  }

  // ---- saída ----
  const lista = [...porCrc.values()].map(c => ({
    usuario_id: c.usuario_id,
    conversas: c.conversasSet.size,
    mensagens: c.mensagens,
    templates: c.templates,
    agendamentos: c.agendamentos,
    movimentacoes: c.movimentacoes,
    ligacoes: c.ligacoes,
    anotacoes: c.anotacoes,
    respostas: c.respostas,
    primeiraRespostaMediaMin: c.respostas ? Math.round(c.esperaMsTotal / c.respostas / MS_MIN) : null,
  })).sort((a, b) => b.conversas - a.conversas);

  const todosLeads = new Set();
  for (const c of porCrc.values()) for (const id of c.conversasSet) todosLeads.add(id);
  const soma = (k) => lista.reduce((s, c) => s + c[k], 0);
  const esperaTotal = [...porCrc.values()].reduce((s, c) => s + c.esperaMsTotal, 0);
  const respTotal = soma('respostas');

  return {
    porCrc: lista,
    time: {
      conversas: todosLeads.size,
      mensagens: soma('mensagens'),
      templates: soma('templates'),
      agendamentos: soma('agendamentos'),
      movimentacoes: lista.reduce((s, c) => s + c.movimentacoes.total, 0),
      ligacoes: {
        total: lista.reduce((s, c) => s + c.ligacoes.total, 0),
        atendidas: lista.reduce((s, c) => s + c.ligacoes.atendidas, 0),
      },
      anotacoes: soma('anotacoes'),
      respostas: respTotal,
      primeiraRespostaMediaMin: respTotal ? Math.round(esperaTotal / respTotal / MS_MIN) : null,
      semResposta: esperasAbertas,
    },
  };
}

// Texto do push diário: "Resumo CRC 11/06 — 2 conversas, 1 agendamento, 1 sem resposta | Paola 1c/1a · Maria 1c/0a"
function resumoCrcTexto(monitor, nomes = {}, dataBR = '') {
  const t = monitor.time;
  const plural = (n, s, p) => n + ' ' + (n === 1 ? s : p);
  const cab = 'Resumo CRC ' + dataBR + ' — ' + plural(t.conversas, 'conversa', 'conversas') +
    ', ' + plural(t.agendamentos, 'agendamento', 'agendamentos') +
    ', ' + t.semResposta.length + ' sem resposta';
  const partes = monitor.porCrc.map(c => {
    const nome = (nomes[c.usuario_id] || 'CRC').split(' ')[0];
    return nome + ' ' + c.conversas + 'c/' + c.agendamentos + 'a';
  });
  return partes.length ? cab + ' | ' + partes.join(' · ') : cab;
}

module.exports = { montarMonitorCrc, resumoCrcTexto };
```

- [ ] **Step 4: Run to verify PASS** — `node --test lib/monitor/crc.test.js` (10 PASS) e `npm test` (todos PASS, suite sobe para ~82).

- [ ] **Step 5: Commit**

```bash
git add lib/monitor/crc.js lib/monitor/crc.test.js
git commit -m "feat(monitor-crc): agregador puro montarMonitorCrc e resumoCrcTexto com testes"
```

---

### Task 2: Evento `nota_sdr_editada` no patchLead

**Files:**
- Modify: `server.js` (função `patchLead`, ~linha 565)

- [ ] **Step 1: Capturar o valor anterior** — em `patchLead`, trocar:

```js
    const leadAntes = { status: lead.status };
```

por:

```js
    const leadAntes = { status: lead.status, notas_sdr: lead.notas_sdr };
```

- [ ] **Step 2: Logar o evento** — logo APÓS o bloco `if (statusMudou) { ... }` (antes do `res.json({ ok: true, lead: updated });`), adicionar:

```js
    // Monitor CRC: anotação SDR conta como trabalho da CRC (só quando mudou de fato)
    if (patch.notas_sdr !== undefined && (patch.notas_sdr || '') !== (leadAntes.notas_sdr || '')) {
      logEvento(updated.id, 'nota_sdr_editada', 'Anotação SDR atualizada',
        { tamanho: (patch.notas_sdr || '').length }, req.user?.id || null);
    }
```

- [ ] **Step 3: Verify** — `node --check server.js` e `npm test` (tudo PASS).

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(monitor-crc): evento nota_sdr_editada com autor no patchLead"
```

---

### Task 3: Migration (`app_config` + RPC esperas abertas) + endpoint `GET /api/monitor-crc`

**Files:**
- Create: `supabase/migrations/20260611000001_monitor_crc.sql`
- Modify: `server.js` (novo bloco de rotas, inserir antes do bloco `// ========== META CAPI ==========`)

- [ ] **Step 1: Migration** — criar `supabase/migrations/20260611000001_monitor_crc.sql`:

```sql
-- Monitor diário das CRCs
-- 1) Claim idempotente do resumo diário (push 18h30)
alter table public.app_config
  add column if not exists resumo_crc_ultimo_envio date;

-- 2) Esperas abertas: leads cuja conversa terminou em mensagem RECEBIDA sem
-- resposta posterior; `desde` = primeira recebida após a última enviada.
create or replace function public.esperas_abertas(fim timestamptz)
returns table(lead_id bigint, nome text, desde timestamptz)
language sql
stable
as $$
  select l.id, l.nome, w.desde
  from leads l
  join lateral (select max(criada_em) t from mensagens where lead_id = l.id and direcao = 'enviada') ue on true
  join lateral (select min(criada_em) desde from mensagens
                where lead_id = l.id and direcao = 'recebida'
                  and (ue.t is null or criada_em > ue.t)) w on true
  where w.desde is not null and w.desde <= fim
  order by w.desde;
$$;
```

- [ ] **Step 2: Aplicar via MCP** — `apply_migration` (name `monitor_crc`, project_id `mtqdpjhhqzvuklnlfpvi`) com o SQL acima; verificar com `execute_sql`: `select count(*) from esperas_abertas(now());` (deve retornar um número ≥ 0 sem erro).

- [ ] **Step 3: Endpoint + IO compartilhado** — em `server.js`, adicionar `const { montarMonitorCrc, resumoCrcTexto } = require('./lib/monitor/crc');` junto dos outros requires de `./lib/` no topo. Depois inserir o bloco (antes de `// ========== META CAPI ==========`):

```js
// ========== MONITOR DIÁRIO DAS CRCS ==========
// IO compartilhado entre o endpoint e o push diário. `data` = YYYY-MM-DD (BRT).
async function montarMonitorCrcDoDia(data) {
  const from = data + 'T00:00:00-03:00';
  const to = data + 'T23:59:59.999-03:00';
  // respostas até 72h após o dia fecham esperas iniciadas no dia (consulta retroativa)
  const fimRespostas = new Date(new Date(to).getTime() + 72 * 3600 * 1000).toISOString();
  const [evRes, recRes, ligRes, abertasRes] = await Promise.all([
    supabase.from('lead_eventos')
      .select('lead_id, tipo, metadata, usuario_id, criado_em')
      .in('tipo', ['mensagem_enviada', 'template_enviado', 'status_mudou', 'nota_sdr_editada'])
      .gte('criado_em', from).lte('criado_em', fimRespostas).limit(20000),
    supabase.from('mensagens').select('lead_id, criada_em')
      .eq('direcao', 'recebida').gte('criada_em', from).lte('criada_em', to).limit(20000),
    supabase.from('ligacoes').select('usuario_id, duracao_segundos')
      .eq('modulo', 'leads').gte('criada_em', from).lte('criada_em', to).limit(5000),
    supabase.rpc('esperas_abertas', { fim: to }),
  ]);
  for (const r of [evRes, recRes, ligRes, abertasRes]) if (r.error) throw r.error;
  const periodo = { from, to };
  const monitor = montarMonitorCrc({
    periodo,
    eventos: evRes.data || [],
    recebidas: recRes.data || [],
    ligacoes: ligRes.data || [],
    esperasAbertas: abertasRes.data || [],
  });
  // nomes das CRCs
  const ids = monitor.porCrc.map(c => c.usuario_id);
  let nomes = {};
  if (ids.length) {
    const { data: perfis } = await supabase.from('profiles').select('id, nome').in('id', ids);
    for (const p of perfis || []) nomes[p.id] = p.nome || '';
  }
  return { monitor, nomes };
}

app.get('/api/monitor-crc', requireAuth, rateLimit, async (req, res) => {
  try {
    const p = await loadProfile(req);
    const roles = p.roles || [];
    const gestor = roles.includes('admin') || roles.includes('gestor');
    if (!gestor && !roles.includes('crc_leads')) return res.status(403).json({ error: 'Acesso negado' });
    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const data = String(req.query.data || hoje);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ error: 'Data inválida (YYYY-MM-DD)' });
    if (data > hoje) return res.status(400).json({ error: 'Data futura' });
    const { monitor, nomes } = await montarMonitorCrcDoDia(data);
    if (!gestor) {
      // CRC vê só os próprios números — filtro NO SERVIDOR
      const meu = monitor.porCrc.find(c => c.usuario_id === req.user.id) || null;
      return res.json({ escopo: 'proprio', data, porCrc: meu ? [meu] : [], nomes: { [req.user.id]: nomes[req.user.id] || p.nome || '' } });
    }
    res.json({ escopo: 'time', data, ...monitor, nomes });
  } catch (e) {
    console.error('❌ monitor-crc:', e);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 4: Verify** — `node --check server.js`; `npm test` (PASS). Smoke local não é possível (sem env) — validação real na última task.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260611000001_monitor_crc.sql server.js
git commit -m "feat(monitor-crc): migration esperas_abertas + endpoint GET /api/monitor-crc com escopo por role"
```

---

### Task 4: Página `/monitor-crc/` + entradas no nav

**Files:**
- Create: `public/monitor-crc/index.html`
- Modify: `public/js/shared-nav.js` (seção CRC de Leads, ~linha 119)
- Modify: `public/index.html` (submenu CRC de Leads — localizar o botão `data-page="conv-agendamentos"`)

- [ ] **Step 1: Página** — criar `public/monitor-crc/index.html` (UTF-8 sem BOM):

```html
<!DOCTYPE html>
<html lang="pt-BR" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Monitor Diário CRC — CRM AMA</title>
<link rel="icon" href="/favicon.ico">
<style>
  :root { --bg:#0f1115; --bg2:#171a21; --bg3:#1f2330; --border:#2a2f3d; --text:#e8eaf0; --muted:#8b93a7; --accent:#4f8ef7; --green:#22c55e; --red:#ef4444; --yellow:#f59e0b; }
  [data-theme="light"] { --bg:#f5f6f8; --bg2:#fff; --bg3:#eef0f4; --border:#dde1e8; --text:#1a1d26; --muted:#6b7280; --accent:#2563eb; --green:#16a34a; --red:#dc2626; --yellow:#d97706; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--text); display:flex; min-height:100vh; }
  main { flex:1; padding:24px; max-width:1200px; }
  h1 { font-size:20px; margin-bottom:4px; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:16px; }
  .data-nav { display:flex; align-items:center; gap:8px; margin-bottom:18px; flex-wrap:wrap; }
  .data-nav button, .data-nav input { background:var(--bg2); border:1px solid var(--border); color:var(--text); border-radius:8px; padding:7px 12px; font-size:13px; cursor:pointer; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; margin-bottom:18px; }
  .card { background:var(--bg2); border:1px solid var(--border); border-radius:10px; padding:12px; }
  .card .num { font-size:22px; font-weight:700; }
  .card .lbl { font-size:11.5px; color:var(--muted); margin-top:2px; }
  .card.alerta { border-color:rgba(239,68,68,.5); background:rgba(239,68,68,.07); cursor:pointer; }
  .card.alerta .num { color:var(--red); }
  table { width:100%; border-collapse:collapse; background:var(--bg2); border:1px solid var(--border); border-radius:10px; overflow:hidden; font-size:13px; }
  th, td { padding:9px 10px; text-align:right; border-bottom:1px solid var(--border); white-space:nowrap; }
  th:first-child, td:first-child { text-align:left; }
  th { background:var(--bg3); color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.4px; }
  tr:last-child td { border-bottom:none; }
  #sem-resposta-lista { display:none; background:var(--bg2); border:1px solid var(--border); border-radius:10px; padding:12px; margin-bottom:18px; font-size:13px; }
  #sem-resposta-lista div { padding:4px 0; border-bottom:1px solid var(--border); }
  #sem-resposta-lista div:last-child { border-bottom:none; }
  .vazio { color:var(--muted); padding:30px; text-align:center; }
  @media (max-width:760px){ main{padding:14px} table{font-size:11.5px} th,td{padding:6px 6px} }
</style>
</head>
<body>
<script src="/js/shared-nav.js" data-active="monitor-crc"></script>
<main>
  <h1>📊 Monitor Diário das CRCs</h1>
  <div class="sub">Conversas, agendamentos e atendimento por CRC — fuso de Brasília</div>
  <div class="data-nav">
    <button onclick="mudarDia(-1)">◀</button>
    <input type="date" id="dia" onchange="carregar()">
    <button onclick="mudarDia(1)">▶</button>
    <button onclick="hoje()">Hoje</button>
    <button onclick="carregar()">🔄 Atualizar</button>
  </div>
  <div class="cards" id="cards"></div>
  <div id="sem-resposta-lista"></div>
  <div id="tabela"></div>
</main>
<script>
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function token() {
  const k = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
  try { return k ? JSON.parse(localStorage.getItem(k))?.access_token : null; } catch { return null; }
}
async function api(url) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token() } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('Erro ' + r.status));
  return j;
}
const hojeStr = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
function hoje() { document.getElementById('dia').value = hojeStr(); carregar(); }
function mudarDia(delta) {
  const el = document.getElementById('dia');
  const d = new Date((el.value || hojeStr()) + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  const novo = d.toISOString().slice(0, 10);
  if (novo > hojeStr()) return;
  el.value = novo; carregar();
}
const fmtMin = m => m == null ? '—' : (m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'min' : m + 'min');
const brt = iso => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

async function carregar() {
  const data = document.getElementById('dia').value || hojeStr();
  const cards = document.getElementById('cards');
  const tabela = document.getElementById('tabela');
  const srl = document.getElementById('sem-resposta-lista');
  cards.innerHTML = '<div class="card"><div class="num">…</div><div class="lbl">carregando</div></div>';
  tabela.innerHTML = ''; srl.style.display = 'none';
  try {
    const r = await api('/api/monitor-crc?data=' + data);
    const nomes = r.nomes || {};
    const nome = id => esc((nomes[id] || 'CRC').split(' ').slice(0, 2).join(' '));
    if (r.escopo === 'proprio') {
      const c = r.porCrc[0];
      cards.innerHTML = c ? cardsCrc(c) : '<div class="vazio">Sem atividade registrada neste dia.</div>';
      return;
    }
    const t = r.time;
    cards.innerHTML = [
      card(t.conversas, 'Conversas atendidas'), card(t.mensagens, 'Mensagens'),
      card(t.templates, 'Templates'), card(t.agendamentos, 'Agendamentos'),
      card(t.movimentacoes, 'Movimentações'), card(t.ligacoes.atendidas + '/' + t.ligacoes.total, 'Ligações (atend/total)'),
      card(t.anotacoes, 'Anotações SDR'), card(fmtMin(t.primeiraRespostaMediaMin), 'Média 1ª resposta'),
      `<div class="card alerta" onclick="toggleSemResposta()"><div class="num">⚠️ ${t.semResposta.length}</div><div class="lbl">Leads sem resposta — clique p/ ver</div></div>`,
    ].join('');
    srl.innerHTML = t.semResposta.length
      ? t.semResposta.map(s => `<div>⏳ <b>${esc(s.nome)}</b> — esperando desde ${brt(s.desde)}</div>`).join('')
      : '<div class="vazio">Nenhum lead esperando resposta 🎉</div>';
    if (!r.porCrc.length) { tabela.innerHTML = '<div class="vazio">Sem atividade de CRC neste dia.</div>'; return; }
    tabela.innerHTML = `<table><thead><tr>
      <th>CRC</th><th>Conversas</th><th>Msgs</th><th>Templates</th><th>Agendados</th>
      <th>Movimentações</th><th>Ligações</th><th>Anotações</th><th>1ª resposta</th>
    </tr></thead><tbody>` + r.porCrc.map(c => {
      const mov = Object.entries(c.movimentacoes.porDestino).map(([k, v]) => `${k}: ${v}`).join('\n');
      return `<tr>
        <td>${nome(c.usuario_id)}</td><td>${c.conversas}</td><td>${c.mensagens}</td>
        <td>${c.templates}</td><td><b>${c.agendamentos}</b></td>
        <td title="${esc(mov)}">${c.movimentacoes.total}</td>
        <td>${c.ligacoes.atendidas}/${c.ligacoes.total}</td><td>${c.anotacoes}</td>
        <td>${fmtMin(c.primeiraRespostaMediaMin)}</td>
      </tr>`;
    }).join('') + '</tbody></table>';
  } catch (e) {
    cards.innerHTML = ''; tabela.innerHTML = `<div class="vazio">❌ ${esc(e.message)}</div>`;
  }
}
function card(num, lbl) { return `<div class="card"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`; }
function cardsCrc(c) {
  return [
    card(c.conversas, 'Conversas atendidas'), card(c.mensagens, 'Mensagens'),
    card(c.templates, 'Templates'), card(c.agendamentos, 'Agendamentos'),
    card(c.movimentacoes.total, 'Movimentações'), card(c.ligacoes.atendidas + '/' + c.ligacoes.total, 'Ligações'),
    card(c.anotacoes, 'Anotações SDR'), card(fmtMin(c.primeiraRespostaMediaMin), 'Média 1ª resposta'),
  ].join('');
}
function toggleSemResposta() {
  const el = document.getElementById('sem-resposta-lista');
  el.style.display = el.style.display === 'none' || !el.style.display ? 'block' : 'none';
}
hoje();
</script>
</body>
</html>
```

- [ ] **Step 2: shared-nav** — em `public/js/shared-nav.js`, na seção `section('crc-leads', ...)`, adicionar após a linha do `'WhatsApp API Oficial'`:

```js
      link('/monitor-crc/','admin,gestor,crc_leads','monitor-crc',IC.dashboard,'Monitor Diário') +
```

(Atenção à concatenação com `+` — manter a expressão válida.)

- [ ] **Step 3: index.html nav** — em `public/index.html`, localizar o botão `data-page="conv-agendamentos"` (submenu CRC de Leads) e adicionar logo após a linha do botão "WhatsApp API Oficial" (mesmo submenu):

```html
      <a class="nav-subitem" href="/monitor-crc/" data-roles="admin,gestor,crc_leads">Monitor Diário</a>
```

- [ ] **Step 4: Verify** — abrir `public/monitor-crc/index.html` e conferir sintaxe JS com `node --check` num extract não é possível (é HTML) — em vez disso: `node -e "const fs=require('fs');const m=fs.readFileSync('public/monitor-crc/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/g);new Function(m[m.length-1].replace(/<\/?script>/g,''));console.log('JS ok')"` → `JS ok`. `npm test` PASS.

- [ ] **Step 5: Commit**

```bash
git add public/monitor-crc/index.html public/js/shared-nav.js public/index.html
git commit -m "feat(monitor-crc): pagina /monitor-crc/ com cards, tabela por CRC e fila sem resposta + nav"
```

---

### Task 5: Push diário 18h30 + endpoint interno de teste + sw.js abre a URL

**Files:**
- Modify: `server.js` (após o endpoint `/api/monitor-crc` da Task 3)
- Modify: `public/sw.js`

- [ ] **Step 1: Cron + envio** — em `server.js`, logo após o endpoint GET /api/monitor-crc, adicionar:

```js
// Push diário 18h30 (BRT) para admin/gestor com o resumo do dia.
// Claim em app_config.resumo_crc_ultimo_envio: idempotente a restart e a múltiplas instâncias.
async function enviarResumoCrcDiario(force = false) {
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  if (!force) {
    const { data: claimed, error } = await supabase.from('app_config')
      .update({ resumo_crc_ultimo_envio: hoje }).eq('id', 1)
      .or('resumo_crc_ultimo_envio.is.null,resumo_crc_ultimo_envio.neq.' + hoje)
      .select('id');
    if (error || !claimed?.length) return false;
  } else {
    await supabase.from('app_config').update({ resumo_crc_ultimo_envio: hoje }).eq('id', 1);
  }
  const { monitor, nomes } = await montarMonitorCrcDoDia(hoje);
  const dataBR = hoje.split('-').reverse().slice(0, 2).join('/');
  const texto = resumoCrcTexto(monitor, nomes, dataBR);
  const { data: gestores } = await supabase.from('profiles').select('id')
    .or('roles.cs.{admin},roles.cs.{gestor}');
  for (const g of gestores || []) {
    await criarNotificacao(g.id, 'resumo_crc', '📊 Resumo diário das CRCs', texto, { url: '/monitor-crc/' });
  }
  console.log('📊 Resumo CRC enviado (' + (gestores?.length || 0) + ' gestores): ' + texto.slice(0, 120));
  return true;
}

setInterval(() => {
  const hhmm = new Date().toLocaleTimeString('sv-SE', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  if (hhmm >= '18:30') enviarResumoCrcDiario().catch(e => console.error('[resumo-crc]', e.message));
}, 60000);

// Disparo manual para teste (mesmo padrão dos outros crons internos)
app.post('/api/internal/cron/resumo-crc', requireCronSecret, async (req, res) => {
  try {
    const ok = await enviarResumoCrcDiario(req.query.force === '1');
    res.json({ ok: true, enviado: ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

NOTA (verificado): `criarNotificacao` existe em server.js ~linha 4926 e `requireCronSecret` ~linha 3686 (valida o header `x-cron-secret` contra `process.env.EASYPANEL_CRON_SECRET`; é function declaration, então pode ser usada antes da posição textual).

- [ ] **Step 2: sw.js abre a URL do payload** — substituir o handler `notificationclick` em `public/sw.js` por:

```js
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url
    ? new URL(e.notification.data.url, self.registration.scope).href
    : self.registration.scope;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const crm = cs.find(c => c.url.includes(self.registration.scope));
    if (crm) {
      crm.focus();
      if (e.notification.data?.url && crm.navigate) return crm.navigate(url).catch(() => {});
      return;
    }
    return clients.openWindow(url);
  }));
});
```

- [ ] **Step 3: Verify** — `node --check server.js`; `node --check public/sw.js`; `npm test` PASS.

- [ ] **Step 4: Commit**

```bash
git add server.js public/sw.js
git commit -m "feat(monitor-crc): push diario 18h30 para gestores + cron interno de teste + sw abre url do payload"
```

---

### Task 6: Push, deploy e validação

- [ ] **Step 1: Testes finais** — `npm test` + `node --test whatsapp.test.js` + `node --check server.js` → tudo PASS.

- [ ] **Step 2: Push + deploy**

```bash
git push
curl.exe -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

Aguardar e conferir `https://plataformaama-plataforma.uc5as5.easypanel.host/health` → `{"ok":true}` e `/api/version` com `deployedAt` recente.

- [ ] **Step 3: Validação em produção (controller/Luiz)**

1. Logar como gestor → menu CRC de Leads → "Monitor Diário" → painel de hoje carrega; números de Agendados por CRC devem bater com os chips de meta da lista de conversas.
2. Navegar para ontem/anteontem (métricas retroativas funcionam; anotações = 0 antes do deploy — esperado).
3. Editar uma anotação SDR num lead → recarregar o monitor → anotação contada.
4. Card "⚠️ sem resposta" → lista abre com leads e "desde".
5. Forçar o push: `curl.exe -s -X POST -H "x-cron-secret: <EASYPANEL_CRON_SECRET do Easypanel>" "https://plataformaama-plataforma.uc5as5.easypanel.host/api/internal/cron/resumo-crc?force=1"` → notificação chega no celular do gestor e clicar abre /monitor-crc/.
6. Logar como CRC (`crc_leads`) → página mostra só os próprios cards.
7. Atualizar `pending_tests.md` da memória com a validação pendente do Luiz.
