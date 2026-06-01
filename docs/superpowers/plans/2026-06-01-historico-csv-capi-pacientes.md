# Migração Histórica CSV + CAPI Backfill + Módulo Pacientes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Importar ~16k leads históricos de CSVs do CRM antigo + Google Sheets para o Supabase, disparar eventos CAPI retroativos para a Meta, e construir o módulo `/pacientes/` para a CRC de Sucesso do Cliente.

**Architecture:** Script local Node.js faz o one-time import (CSV + Sheets → Supabase). O CRM ganha 3 novos endpoints (`/api/pacientes`), 1 hook no fluxo de Conferência, e uma nova página HTML. Duas novas tabelas Supabase: `pacientes_sucesso` e `tratamentos_config`.

**Tech Stack:** Node.js, @supabase/supabase-js (já instalado), vanilla JS, Meta Conversions API v21.0

**Spec:** `docs/superpowers/specs/2026-06-01-historico-csv-capi-pacientes-design.md`

---

## Mapa de Arquivos

| Ação | Arquivo |
|---|---|
| Criar | `scripts/import-historico.js` |
| Criar | `scripts/sheets-data.json` (gerado no Task 2) |
| Criar | `public/pacientes/index.html` |
| Criar | `public/js/pacientes/api.js` |
| Modificar | `server.js` (FUNIL, endpoints, hook Conferência) |
| Modificar | `public/index.html` (nav link Pacientes) |
| Modificar | `public/js/shared-nav.js` (nav link Pacientes) |
| Migrações Supabase | 3 scripts SQL via MCP |

**Nota importante:** O role `crc_sucesso` JÁ EXISTE no código (Usuarios, nav, shared-nav). Nenhuma alteração necessária para o role em si.

---

## Task 1: Migrações Supabase

**Files:**
- Supabase MCP: aplicar 3 migrações em ordem

- [ ] **Step 1.1: Criar tabela `pacientes_sucesso`**

```sql
create table pacientes_sucesso (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete set null,
  nome text not null,
  telefone text,
  tratamento text,
  data_venda date,
  valor_fechado numeric,
  data_atualizacao date,
  proximo_passo text,
  data_agendamento date,
  avaliador text,
  executor text,
  obs text,
  prioridade smallint default 0,
  is_alta boolean default false,
  importado_historico boolean default true,
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);
create index on pacientes_sucesso(lead_id);
create index on pacientes_sucesso(telefone);
create index on pacientes_sucesso(is_alta);
```

Aplicar via MCP Supabase → `apply_migration` com timestamp `20260601001`.

- [ ] **Step 1.2: Criar tabela `tratamentos_config` com dados iniciais**

```sql
create table tratamentos_config (
  tratamento text primary key,
  dias_atualizacao integer not null,
  observacao text,
  responsavel_padrao text
);

insert into tratamentos_config (tratamento, dias_atualizacao, observacao, responsavel_padrao) values
  ('Prótese Protocolo', 10, 'Acompanhamento frequente devido a etapas próximas', 'Monica'),
  ('Prótese', 10, 'Acompanhamento regular entre provas', 'Monica'),
  ('Placa de Bruxismo', 10, 'Após entrega, acompanhamento mensal', 'Monica'),
  ('Cirurgia', 15, 'Pós-operatório imediato exige atenção', 'Monica'),
  ('Invisalign', 30, 'Acompanhamento baseado em trocas de placas', 'Monica'),
  ('Periodontia', 10, 'Retornos mensais', 'Monica'),
  ('Geral', 10, 'Tratamento geral', 'Monica'),
  ('Clareamento', 5, 'Processo curto, acompanhamento próximo', 'Monica'),
  ('Implantes', 15, 'Fase de osseointegração requer monitoramento', 'Monica'),
  ('Pacote de Prevenção', 90, 'Retornos semestrais', 'Monica'),
  ('Canal', 5, 'Entre sessões de endodontia', 'Monica'),
  ('Prótese sobre implante', 10, 'Similar a prótese regular', 'Monica'),
  ('Ortodontia', 30, 'Manutenção mensal', 'Monica'),
  ('Tratamento Programado', 30, 'Conforme cronograma definido', 'Monica'),
  ('ALTA', 365, 'Retorno anual para manutenção', 'Monica');
```

Aplicar via MCP → timestamp `20260601002`.

- [ ] **Step 1.3: Adicionar `importado_historico` à tabela `leads`**

```sql
alter table leads add column if not exists importado_historico boolean default false;
```

Aplicar via MCP → timestamp `20260601003`.

- [ ] **Step 1.4: Verificar migrações**

Chamar `list_migrations` no MCP. Confirmar que as 3 aparecem com status aplicado.

---

## Task 2: Exportar Google Sheets → scripts/sheets-data.json

**Files:**
- Criar: `scripts/sheets-data.json`

O Google Drive MCP exporta o Sheets. Salvar as abas Acompanhamento e Invisalign como JSON estruturado para uso no import script.

- [ ] **Step 2.1: Ler o Sheets via Google Drive MCP**

Usar `mcp__claude_ai_Google_Drive__read_file_content` com o file ID `1Is8LJJFKXjxT3gnwz9hK-GUEnqJ2m1FKLBJSNueXTtA`.

Caso a ferramenta retorne conteúdo por aba, ler as abas **Acompanhamento** e **Invisalign** separadamente.

- [ ] **Step 2.2: Processar e salvar como JSON**

Para cada linha das duas abas, extrair os campos mapeados para `pacientes_sucesso`. Salvar em `clinica-crm/scripts/sheets-data.json` no formato:

```json
[
  {
    "nome": "Nome do Paciente",
    "telefone": "31999990000",
    "tratamento": "Invisalign",
    "data_venda": "2024-03-15",
    "data_atualizacao": "2025-01-10",
    "proximo_passo": "Entregar alinhadores",
    "data_agendamento": "2025-02-01",
    "avaliador": "Dr. Marcos",
    "executor": "Monica",
    "obs": "Paciente em dia",
    "status": "EM DIA"
  }
]
```

Coluna **P** do Sheets mapeada para `prioridade` (número ou 0 se vazio).
Coluna **STATUS** = `"ALTA"` → `is_alta: true` ao inserir.

Se o Sheets não tiver coluna Telefone, usar nome como fallback (campo `telefone` vazio).

- [ ] **Step 2.3: Commit**

```bash
git add scripts/sheets-data.json
git commit -m "data: export Google Sheets Acompanhamento+Invisalign para scripts/sheets-data.json"
```

---

## Task 3: server.js — Reclassificar + API Pacientes + Hook Conferência

**Files:**
- Modify: `server.js`

- [ ] **Step 3.1: Adicionar `Reclassificar` ao FUNIL**

Em `server.js` linha 46, alterar para:

```js
const FUNIL = ['Lead', 'Aguardando', 'Agendado', 'Compareceu', 'Nutrir', 'Não tem Interesse', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'Reclassificar', 'Em nutrição', 'Fechou', 'Perdido'];
```

- [ ] **Step 3.2: Adicionar `Reclassificar` ao EVENTOS_FUNIL**

Em `server.js` após a linha `'D5': null,` (por volta de linha 1696), adicionar:

```js
'Reclassificar':     null,
```

- [ ] **Step 3.3: Adicionar middleware `requireCrcSucesso`**

Após a linha `const requireGestor = requireRole('gestor', 'admin');` (em torno de linha 247), adicionar:

```js
const requireCrcSucesso = requireRole('crc_sucesso', 'crc_comercial', 'gestor', 'admin');
```

- [ ] **Step 3.4: Adicionar endpoints GET /api/pacientes/config e GET/PATCH /api/pacientes**

Adicionar após o bloco de Conferência (após linha ~2611), antes das outras rotas:

```js
// ========== MÓDULO PACIENTES (Sucesso do Cliente) ==========
app.get('/api/pacientes/config', requireAuth, requireCrcSucesso, rateLimit, async (req, res) => {
  try {
    const { data, error } = await supabase.from('tratamentos_config').select('*').order('tratamento');
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pacientes', requireAuth, requireCrcSucesso, rateLimit, async (req, res) => {
  try {
    const { status, tratamento, executor } = req.query;
    let q = supabase.from('pacientes_sucesso').select('*').order('data_venda', { ascending: false, nullsFirst: false });
    if (tratamento) q = q.eq('tratamento', tratamento);
    if (executor) q = q.eq('executor', executor);
    const { data, error } = await q.limit(2000);
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/pacientes/:id', requireAuth, requireCrcSucesso, rateLimit, async (req, res) => {
  try {
    const allowed = ['data_atualizacao','proximo_passo','data_agendamento','avaliador','executor','obs','is_alta','prioridade','tratamento'];
    const patch = {};
    for (const k of allowed) { if (k in req.body) patch[k] = req.body[k] === '' ? null : req.body[k]; }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nada para atualizar' });
    patch.atualizado_em = new Date().toISOString();
    const { data, error } = await supabase.from('pacientes_sucesso').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 3.5: Hook Conferência → pacientes_sucesso**

No endpoint `POST /api/comercial/conferencia/:estimateId` (linha ~2585), alterar o select do orcamento para incluir campos necessários:

```js
// ANTES:
const { data: orc } = await supabase.from('orcamentos')
  .select('valor_particular, entrada_valor, clinicorp_lastchange')
  .eq('clinicorp_estimate_id', id).maybeSingle();

// DEPOIS:
const { data: orc } = await supabase.from('orcamentos')
  .select('valor_particular, entrada_valor, clinicorp_lastchange, lead_id, paciente_nome, data_fechamento')
  .eq('clinicorp_estimate_id', id).maybeSingle();
```

E logo após `if (error) throw error;` da linha do update (linha ~2607), antes do `res.json({ ok: true })`, adicionar:

```js
if (acao === 'aprovar' && orc.lead_id) {
  try {
    const { data: jaExiste } = await supabase.from('pacientes_sucesso')
      .select('id').eq('lead_id', orc.lead_id).maybeSingle();
    if (!jaExiste) {
      const { data: lead } = await supabase.from('leads')
        .select('telefone').eq('id', orc.lead_id).maybeSingle();
      await supabase.from('pacientes_sucesso').insert({
        lead_id: orc.lead_id,
        nome: orc.paciente_nome || '',
        telefone: lead?.telefone || '',
        data_venda: orc.data_fechamento,
        valor_fechado: patch.valor_aprovado,
        importado_historico: false,
      });
    }
  } catch (hookErr) { console.error('Hook pacientes_sucesso:', hookErr.message); }
}
```

- [ ] **Step 3.6: Commit**

```bash
git add server.js
git commit -m "feat: Reclassificar no funil, endpoints /api/pacientes, hook Conferencia->pacientes_sucesso"
```

---

## Task 4: Nav — link Pacientes

**Files:**
- Modify: `public/index.html`
- Modify: `public/js/shared-nav.js`

- [ ] **Step 4.1: Adicionar link no nav de `public/index.html`**

Encontrar o botão de Usuários em `public/index.html` (procurar por `data-page="usuarios"` ou texto "Usuários"). Adicionar ANTES dele:

```html
<a class="nav-btn" href="/pacientes/" data-roles="crc_sucesso,crc_comercial,gestor,admin">
  <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><path d="M12 11v4"/><path d="M10 13h4"/></svg>
  Pacientes
</a>
```

- [ ] **Step 4.2: Adicionar link no `public/js/shared-nav.js`**

Seguir o padrão existente de `navLink` no arquivo. Adicionar entry para `/pacientes/` com slug `pacientes` e roles `crc_sucesso,crc_comercial,gestor,admin`, com o mesmo ícone acima.

- [ ] **Step 4.3: Commit**

```bash
git add public/index.html public/js/shared-nav.js
git commit -m "feat: link Pacientes no nav (crc_sucesso, crc_comercial, gestor, admin)"
```

---

## Task 5: Script de Importação

**Files:**
- Criar: `scripts/import-historico.js`

- [ ] **Step 5.1: Criar o script**

Criar `clinica-crm/scripts/import-historico.js` com o conteúdo abaixo:

```js
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const CSV_BASE = 'P:\\LUIZ\\POWER BI\\Dashboard\\Dashboard\\CSV';
const SHEETS_JSON = path.join(__dirname, 'sheets-data.json');

function sha256(s) { return crypto.createHash('sha256').update(String(s).toLowerCase().trim()).digest('hex'); }

function normalizeTel(raw) {
  let t = String(raw || '').replace(/\D/g, '');
  if (t.startsWith('55') && t.length >= 12) t = t.slice(2);
  if (t.length === 10) t = t.slice(0, 2) + '9' + t.slice(2);
  return t;
}

function parseDate(s) {
  if (!s || s === '') return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function toDateStr(d) { return d ? d.toISOString().split('T')[0] : null; }

function readCSVDir(dir) {
  const rows = [];
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.csv')).sort();
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(path.join(dir, f), 'latin1'); }
    catch { content = fs.readFileSync(path.join(dir, f), 'utf8'); }
    const lines = content.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim());
    if (lines.length < 2) continue;
    const headers = lines[0].split(';').map(h => h.replace(/^"|"$/g, '').trim());
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(';').map(v => v.replace(/^"|"$/g, '').trim());
      const row = {};
      headers.forEach((h, j) => { row[h] = vals[j] !== undefined ? vals[j] : ''; });
      rows.push(row);
    }
  }
  return rows;
}

async function main() {
  console.log('📂 Lendo CSVs...');
  const leadsCSV    = readCSVDir(path.join(CSV_BASE, '01 - Leads'));
  const agendCSV    = readCSVDir(path.join(CSV_BASE, '02 - Agendamentos'));
  const compCSV     = readCSVDir(path.join(CSV_BASE, '03 - Comparecimentos'));
  const fechCSV     = readCSVDir(path.join(CSV_BASE, '04 - Fechamentos'));
  const orcCSV      = readCSVDir(path.join(CSV_BASE, '05 - Orçamentos'));
  const sheetsRows  = fs.existsSync(SHEETS_JSON) ? JSON.parse(fs.readFileSync(SHEETS_JSON, 'utf8')) : [];

  console.log(`Leads:${leadsCSV.length} Agend:${agendCSV.length} Comp:${compCSV.length} Fech:${fechCSV.length} Orc:${orcCSV.length} Sheets:${sheetsRows.length}`);

  // ── maps por telefone normalizado ──────────────────────────────
  const mapFech = new Map();
  for (const r of fechCSV) {
    const t = normalizeTel(r['Telefone']);
    if (!t) continue;
    const ex = mapFech.get(t);
    if (!ex || parseDate(r['Data fechamento']) > parseDate(ex['Data fechamento'])) mapFech.set(t, r);
  }

  const mapOrcOpen = new Map();
  for (const r of orcCSV) {
    const t = normalizeTel(r['Telefone']);
    if (t && r['Status'] === 'OPEN' && !mapFech.has(t) && !mapOrcOpen.has(t)) mapOrcOpen.set(t, r);
  }

  const telsComp = new Set(compCSV.map(r => normalizeTel(r['Telefone'])).filter(Boolean));

  const mapAgend = new Map();
  for (const r of agendCSV) {
    const t = normalizeTel(r['Telefone']);
    if (t && !mapAgend.has(t)) mapAgend.set(t, r);
  }

  // ── leads únicos (mais recente por telefone) ───────────────────
  const mapLead = new Map();
  for (const r of [...leadsCSV, ...fechCSV]) {
    const t = normalizeTel(r['Telefone']);
    if (!t) continue;
    const ex = mapLead.get(t);
    if (!ex || parseDate(r['Data de cadastro']) > parseDate(ex['Data de cadastro'])) mapLead.set(t, r);
  }

  console.log(`Telefones únicos: ${mapLead.size}`);

  // ── buscar existentes no Supabase ──────────────────────────────
  const allTels = [...mapLead.keys()];
  // Supabase .in() tem limite de 1000; processar em chunks
  const existing = [];
  for (let i = 0; i < allTels.length; i += 800) {
    const { data } = await supabase.from('leads')
      .select('id, telefone, status, eventos_meta_enviados, email, valor')
      .in('telefone', allTels.slice(i, i + 800));
    if (data) existing.push(...data);
  }
  const mapExisting = new Map(existing.map(l => [l.telefone, l]));
  console.log(`Já existem no Supabase: ${mapExisting.size}`);

  const stats = { Fechou:0, Reclassificar:0, Faltou:0, Nutrir:0, CompSemOrc:0, Novo:0, Existente:0 };
  const processed = []; // { leadId, tel, status, extraData, existingLead }

  for (const [tel, leadRow] of mapLead) {
    const fRow  = mapFech.get(tel);
    const oRow  = mapOrcOpen.get(tel);
    const aRow  = mapAgend.get(tel);
    const isComp = telsComparecimento.has(tel);

    let status, extraData = {};

    if (fRow) {
      status = 'Fechou'; stats.Fechou++;
      extraData = {
        valor: parseFloat(fRow['Valor fechado']) || 0,
        entrada: parseFloat(fRow['Valor entrada']) || 0,
        tratamento: fRow['Tratamento'] || '',
        dataCadastro: parseDate(fRow['Data de cadastro']),
        dataAgendamento: parseDate(fRow['Criação do agendamento']),
        dataOrcamento: parseDate(fRow['Criação do orçamento']),
        dataFechamento: parseDate(fRow['Data fechamento']) || parseDate(fRow['Data de cadastro']),
      };
    } else if (oRow) {
      status = 'Reclassificar'; stats.Reclassificar++;
      extraData = {
        tratamento: oRow['Tratamento'] || '',
        dataCadastro: parseDate(oRow['Data de cadastro']),
        dataAgendamento: parseDate(oRow['Criação do agendamento']),
        dataOrcamento: parseDate(oRow['Criação do orçamento']),
      };
    } else if (isComp) {
      status = null; stats.CompSemOrc++;
      extraData = { dataCadastro: parseDate(leadRow['Data de cadastro']), dataAgendamento: aRow ? parseDate(aRow['Criação do agendamento']) : null };
    } else if (aRow) {
      status = 'Faltou'; stats.Faltou++;
      extraData = {
        dataCadastro: parseDate(leadRow['Data de cadastro']),
        dataAgendamento: parseDate(aRow['Data da consulta']) || parseDate(aRow['Criação do agendamento']),
      };
    } else {
      status = 'Nutrir'; stats.Nutrir++;
      extraData = { dataCadastro: parseDate(leadRow['Data de cadastro']) };
    }

    const existingLead = mapExisting.get(tel);
    let leadId;

    if (existingLead) {
      leadId = existingLead.id;
      stats.Existente++;
    } else {
      if (!status) continue; // comp sem orc e sem lead existente → pula
      const { data: ins, error } = await supabase.from('leads').insert({
        nome: leadRow['Nome'] || 'Sem nome',
        telefone: tel,
        origem: leadRow['Origem'] || 'Importado',
        status,
        importado_historico: true,
        ...(extraData.dataCadastro && { criado_em: extraData.dataCadastro.toISOString() }),
        ...(extraData.valor ? { valor: extraData.valor } : {}),
      }).select('id, eventos_meta_enviados, email, valor').single();
      if (error) { console.error(`Erro ao inserir ${tel}:`, error.message); continue; }
      leadId = ins.id;
      mapExisting.set(tel, { ...ins, telefone: tel });
      stats.Novo++;
    }

    // lead_eventos (apenas históricos, sem duplicar)
    const evts = [];
    const dc = extraData.dataCadastro || new Date();
    evts.push({ lead_id: leadId, tipo: 'historico_lead_criado', descricao: `Lead histórico — ${leadRow['Origem'] || 'Importado'}`, metadata: { importado: true }, criado_em: dc.toISOString() });
    if (extraData.dataAgendamento) evts.push({ lead_id: leadId, tipo: 'historico_agendado', descricao: `Agendamento histórico em ${extraData.dataAgendamento.toLocaleDateString('pt-BR')}`, metadata: { importado: true }, criado_em: extraData.dataAgendamento.toISOString() });
    if (isComp && extraData.dataAgendamento) evts.push({ lead_id: leadId, tipo: 'historico_compareceu', descricao: 'Compareceu à consulta (histórico)', metadata: { importado: true }, criado_em: extraData.dataAgendamento.toISOString() });
    if (extraData.dataOrcamento) evts.push({ lead_id: leadId, tipo: 'historico_orcamento', descricao: `Orçamento: R$ ${extraData.valor || 0} — ${extraData.tratamento}`, metadata: { importado: true }, criado_em: extraData.dataOrcamento.toISOString() });
    if (extraData.dataFechamento && status === 'Fechou') evts.push({ lead_id: leadId, tipo: 'historico_fechou', descricao: `Fechamento: R$ ${extraData.valor} (entrada: R$ ${extraData.entrada})`, metadata: { valor: extraData.valor, entrada: extraData.entrada, tratamento: extraData.tratamento, importado: true }, criado_em: extraData.dataFechamento.toISOString() });

    const { data: existEvts } = await supabase.from('lead_eventos').select('tipo').eq('lead_id', leadId).like('tipo', 'historico_%');
    const existTypes = new Set((existEvts || []).map(e => e.tipo));
    const novos = evts.filter(e => !existTypes.has(e.tipo));
    if (novos.length) {
      const { error: ee } = await supabase.from('lead_eventos').insert(novos);
      if (ee) console.error(`Erro eventos ${tel}:`, ee.message);
    }

    processed.push({ leadId, tel, status, extraData, existingLead: mapExisting.get(tel) });
  }

  console.log('\n📊 Stats leads:', stats);

  // ── pacientes_sucesso ──────────────────────────────────────────
  await upsertPacientes(processed, sheetsRows, mapFech);

  // ── CAPI backfill ──────────────────────────────────────────────
  await capiBackfill(processed);

  console.log('\n✅ Importação concluída!');
}

async function upsertPacientes(processed, sheetsRows, mapFech) {
  console.log('\n📋 Inserindo pacientes_sucesso...');
  const processedTels = new Set();
  const mapProcessed = new Map(processed.map(p => [p.tel, p]));

  for (const row of sheetsRows) {
    const tel = normalizeTel(row.telefone || '');
    const nome = (row.nome || '').trim();
    if (!nome) continue;

    const checkQ = tel
      ? supabase.from('pacientes_sucesso').select('id').eq('telefone', tel).maybeSingle()
      : supabase.from('pacientes_sucesso').select('id').eq('nome', nome).maybeSingle();
    const { data: ex } = await checkQ;
    if (ex) { if (tel) processedTels.add(tel); continue; }

    const fRow = tel ? mapFech.get(tel) : null;
    const p = tel ? mapProcessed.get(tel) : null;

    try {
      await supabase.from('pacientes_sucesso').insert({
        lead_id: p?.leadId || null,
        nome, telefone: tel || null,
        tratamento: row.tratamento || null,
        data_venda: row.data_venda || (fRow ? toDateStr(parseDate(fRow['Data fechamento'])) : null),
        valor_fechado: fRow ? parseFloat(fRow['Valor fechado']) || null : null,
        data_atualizacao: row.data_atualizacao || null,
        proximo_passo: row.proximo_passo || null,
        data_agendamento: row.data_agendamento || null,
        avaliador: row.avaliador || null,
        executor: row.executor || null,
        obs: row.obs || null,
        is_alta: row.status === 'ALTA' || row.is_alta === true,
        prioridade: parseInt(row.prioridade) || 0,
        importado_historico: true,
      });
    } catch (e) { console.error('pacientes_sucesso sheets:', e.message); }
    if (tel) processedTels.add(tel);
  }

  // CSV fechamentos não cobertos pelo Sheets
  for (const [tel, fRow] of mapFech) {
    if (processedTels.has(tel)) continue;
    const { data: ex } = await supabase.from('pacientes_sucesso').select('id').eq('telefone', tel).maybeSingle();
    if (ex) continue;
    const p = mapProcessed.get(tel) || {};
    try {
      await supabase.from('pacientes_sucesso').insert({
        lead_id: p.leadId || null,
        nome: fRow['Nome'] || '',
        telefone: tel,
        tratamento: fRow['Tratamento'] || null,
        data_venda: toDateStr(parseDate(fRow['Data fechamento'])),
        valor_fechado: parseFloat(fRow['Valor fechado']) || null,
        importado_historico: true,
      });
    } catch (e) { console.error('pacientes_sucesso csv:', e.message); }
  }
  console.log('✅ pacientes_sucesso ok');
}

async function capiBackfill(processed) {
  const PIXEL = process.env.META_PIXEL_ID;
  const TOKEN = process.env.META_ACCESS_TOKEN;
  if (!PIXEL || !TOKEN) { console.log('⚠️  CAPI: META_PIXEL_ID ou META_ACCESS_TOKEN ausentes — pulando'); return; }
  console.log('\n📤 CAPI backfill...');

  const CAPI_MAP = { Fechou: 'Purchase', Reclassificar: 'Schedule', Faltou: 'Schedule', Nutrir: 'LeadSubmitted' };

  for (const { leadId, tel, status, extraData, existingLead } of processed) {
    const eventName = CAPI_MAP[status];
    if (!eventName) continue;
    if ((existingLead?.eventos_meta_enviados || []).includes(eventName)) continue;

    let eventTime = status === 'Fechou' ? extraData.dataFechamento
      : (status === 'Reclassificar' || status === 'Faltou') ? (extraData.dataAgendamento || extraData.dataCadastro)
      : extraData.dataCadastro;
    if (!eventTime) eventTime = new Date();

    const user_data = {};
    if (tel) user_data.ph = [sha256(tel)];
    if (existingLead?.email) user_data.em = [sha256(existingLead.email)];

    const payload = { data: [{ event_name: eventName, event_time: Math.floor(eventTime.getTime() / 1000), action_source: 'website', event_id: `hist_${leadId}_${eventName}`, user_data, custom_data: { currency: 'BRL', value: parseFloat(extraData.valor) || 0 } }] };

    try {
      const r = await fetch(`https://graph.facebook.com/v21.0/${PIXEL}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN }, body: JSON.stringify(payload) });
      const json = await r.json();
      if (json.events_received) {
        console.log(`  ✓ ${eventName} lead ${leadId} (${toDateStr(eventTime)})`);
        const evs = [...(existingLead?.eventos_meta_enviados || [])];
        if (!evs.includes(eventName)) evs.push(eventName);
        const upd = { eventos_meta_enviados: evs };
        if (eventName === 'Purchase') upd.enviado_meta = true;
        await supabase.from('leads').update(upd).eq('id', leadId);
      } else {
        console.error(`  ✗ ${eventName} lead ${leadId}:`, JSON.stringify(json).slice(0, 150));
      }
    } catch (e) { console.error(`  ✗ CAPI ${eventName} lead ${leadId}:`, e.message); }
    await new Promise(r => setTimeout(r, 50));
  }
  console.log('✅ CAPI backfill ok');
}

function toDateStr(d) { return d ? d.toISOString().split('T')[0] : null; }

// corrigir referência ao telsComparecimento (definir antes do loop)
const telsComparecimento = new Set(); // preenchido em main() — ver Step 5.1

main().catch(e => { console.error('💥', e); process.exit(1); });
```

> **ATENÇÃO:** A linha `const telsComparecimento = new Set()` no final é um placeholder — no script final, ela DEVE ser a variável já declarada dentro de `main()` como `const telsComp`. Renomear todas as referências de `telsComparecimento` para `telsComp` para consistência com o corpo do script.

- [ ] **Step 5.2: Corrigir consistência de nomes no script**

No script gerado no Step 5.1, garantir que a variável `telsComparecimento` (usada nos loops) seja a mesma `telsComp` declarada em `main()`. Fazer find-replace: `telsComparecimento` → `telsComp` em todo o arquivo.

- [ ] **Step 5.3: Commit**

```bash
git add scripts/import-historico.js
git commit -m "feat: script de importacao historica CSV + CAPI backfill"
```

---

## Task 6: Executar o Script de Importação

**Pré-requisito:** Tasks 1–5 completas. `.env` com `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `META_PIXEL_ID`, `META_ACCESS_TOKEN`.

- [ ] **Step 6.1: Dry-run — verificar leitura dos CSVs**

```powershell
cd "C:\Users\Luiz Martins\Desktop\Projeto Claude Code\clinica-crm"
node -e "
const p = require('path');
require('dotenv').config();
const fs = require('fs');
function readCSVDir(dir) {
  return fs.readdirSync(dir).filter(f=>f.endsWith('.csv')).reduce((acc,f)=>{
    const lines = fs.readFileSync(p.join(dir,f),'latin1').split('\n').filter(l=>l.trim());
    return acc + lines.length - 1;
  },0);
}
const base = 'P:\\\\LUIZ\\\\POWER BI\\\\Dashboard\\\\Dashboard\\\\CSV';
['01 - Leads','02 - Agendamentos','03 - Comparecimentos','04 - Fechamentos','05 - Orçamentos'].forEach(d => {
  console.log(d, readCSVDir(p.join(base, d)));
});
"
```

Saída esperada: contagens ~16372, ~5721, ~2674, ~817, ~2561.

- [ ] **Step 6.2: Executar o script completo**

```powershell
node scripts/import-historico.js
```

Monitorar o output. O script loga stats ao final:
```
📊 Stats leads: { Fechou: ~817, Reclassificar: ~N, Faltou: ~N, Nutrir: ~N, ... }
✅ pacientes_sucesso ok
✅ CAPI backfill ok
✅ Importação concluída!
```

- [ ] **Step 6.3: Verificar contagens no Supabase**

```powershell
node -e "
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  const { count: leads } = await s.from('leads').select('*', { count:'exact', head:true }).eq('importado_historico', true);
  const { count: pac } = await s.from('pacientes_sucesso').select('*', { count:'exact', head:true });
  const { count: evts } = await s.from('lead_eventos').select('*', { count:'exact', head:true }).like('tipo', 'historico_%');
  console.log({ leads_importados: leads, pacientes_sucesso: pac, lead_eventos_historicos: evts });
})();
"
```

Verificar que `leads_importados` > 0, `pacientes_sucesso` > 0 (deve ser ~total Sheets + fechamentos não no Sheets), `lead_eventos_historicos` > 0.

---

## Task 7: Frontend — Módulo Pacientes

**Files:**
- Criar: `public/pacientes/index.html`
- Criar: `public/js/pacientes/api.js`

- [ ] **Step 7.1: Criar `public/js/pacientes/api.js`**

```js
// public/js/pacientes/api.js
let _token = null;
function getToken() {
  if (_token) return _token;
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
      try { _token = JSON.parse(localStorage.getItem(k))?.access_token; } catch {}
    }
  }
  return _token;
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken(), ...(opts.headers || {}) },
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
  return r.json();
}

window.PacientesAPI = {
  listar: (q = {}) => api('/api/pacientes?' + new URLSearchParams(q)),
  atualizar: (id, body) => api('/api/pacientes/' + id, { method: 'PATCH', body: JSON.stringify(body) }),
  config: () => api('/api/pacientes/config'),
};
```

- [ ] **Step 7.2: Criar `public/pacientes/index.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pacientes — AMA</title>
<link rel="stylesheet" href="/style.css">
<style>
  .pac-wrap { padding: 16px; max-width: 100%; }
  .pac-header { display:flex; align-items:center; gap:12px; margin-bottom:16px; flex-wrap:wrap; }
  .pac-header h2 { margin:0; font-size:18px; }
  .pac-filters { display:flex; gap:8px; flex-wrap:wrap; }
  .pac-filters select { padding:4px 8px; border:1px solid var(--border); border-radius:6px; font-size:13px; background:var(--card); color:var(--text); }
  .pac-table-wrap { overflow-x:auto; }
  table.pac { border-collapse:collapse; width:100%; font-size:13px; }
  table.pac th { background:var(--bg); padding:8px 10px; text-align:left; font-size:11px; font-weight:600; color:var(--text-muted); border-bottom:2px solid var(--border); white-space:nowrap; position:sticky; top:0; z-index:1; }
  table.pac td { padding:7px 10px; border-bottom:1px solid var(--border); vertical-align:middle; white-space:nowrap; }
  table.pac tr:hover td { background:var(--hover,rgba(99,102,241,.04)); }
  .pac-status { display:inline-block; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:600; }
  .pac-status.critico  { background:#fef2f2; color:#dc2626; }
  .pac-status.atencao  { background:#fffbeb; color:#d97706; }
  .pac-status.em-dia   { background:#f0fdf4; color:#16a34a; }
  .pac-status.sem-data { background:#f8fafc; color:#94a3b8; }
  .pac-status.alta     { background:#f0fdf4; color:#16a34a; }
  .pac-alta-btn { cursor:pointer; font-size:16px; background:none; border:none; padding:0; }
  .pac-cell-edit { cursor:pointer; }
  .pac-cell-edit:hover { background:var(--hover,rgba(99,102,241,.08)); border-radius:4px; }
  .pac-edit-input { width:100%; padding:3px 6px; border:1px solid var(--primary,#6366f1); border-radius:4px; font-size:12px; }
  .pac-dias { font-weight:600; }
  .pac-dias.over { color:#dc2626; }
  .pac-wpp { display:inline-flex; align-items:center; gap:4px; padding:3px 8px; background:#25D366; color:#fff; border-radius:6px; text-decoration:none; font-size:11px; font-weight:600; }
  .pac-count { font-size:12px; color:var(--text-muted); margin-left:auto; }
</style>
</head>
<body>
<script src="/js/shared-nav.js" data-active="pacientes"></script>
<div class="main-content">
<div class="pac-wrap">
  <div class="pac-header">
    <h2>👥 Pacientes — Sucesso do Cliente</h2>
    <div class="pac-filters">
      <select id="fStatus" onchange="renderTable()">
        <option value="">Todos os status</option>
        <option value="critico">🔴 Crítico</option>
        <option value="atencao">🟡 Atenção</option>
        <option value="em-dia">🟢 Em dia</option>
        <option value="sem-data">⚪ Sem data</option>
        <option value="alta">✅ Alta</option>
      </select>
      <select id="fTratamento" onchange="renderTable()"><option value="">Todos os tratamentos</option></select>
      <select id="fExecutor" onchange="renderTable()"><option value="">Todos os executores</option></select>
    </div>
    <span class="pac-count" id="pacCount"></span>
  </div>
  <div id="pacMsg" style="padding:20px;color:var(--text-muted);text-align:center">Carregando...</div>
  <div class="pac-table-wrap" id="pacTableWrap" style="display:none">
    <table class="pac">
      <thead><tr>
        <th>P</th><th>NOME</th><th>TRATAMENTO</th><th>DATA VENDA</th>
        <th>DATA ATUALIZ.</th><th>PRÓXIMO PASSO</th><th>DATA AGEND.</th>
        <th>AVALIADOR</th><th>EXECUTOR</th><th>OBS</th><th>DIAS</th><th>STATUS</th><th></th>
      </tr></thead>
      <tbody id="pacTbody"></tbody>
    </table>
  </div>
</div>
</div>

<script src="/js/pacientes/api.js"></script>
<script>
let rows = [], config = {};

function calcStatus(row) {
  if (row.is_alta) return { label:'ALTA', cls:'alta', icon:'✅' };
  if (!row.data_atualizacao) return { label:'SEM DATA', cls:'sem-data', icon:'⚪' };
  const cfg = config[row.tratamento] || { dias_atualizacao: 10 };
  const dias = Math.floor((Date.now() - new Date(row.data_atualizacao).getTime()) / 86400000);
  if (dias > cfg.dias_atualizacao) return { label:'CRÍTICO', cls:'critico', icon:'🔴', dias };
  if (dias > cfg.dias_atualizacao - 5) return { label:'ATENÇÃO', cls:'atencao', icon:'🟡', dias };
  return { label:'EM DIA', cls:'em-dia', icon:'🟢', dias };
}

// ── helpers DOM (sem innerHTML com dados do usuário) ──────────────
function cel(text, cls) {
  const td = document.createElement('td');
  td.textContent = text || '—';
  if (cls) td.className = cls;
  return td;
}

function editCel(rowId, field, value) {
  const td = document.createElement('td');
  td.className = 'pac-cell-edit';
  td.textContent = value || '—';
  td.dataset.id    = rowId;
  td.dataset.field = field;
  td.dataset.value = value || '';
  return td;
}

function makeRow(r) {
  const st = calcStatus(r);
  const dias = st.dias !== undefined ? st.dias
    : (r.data_atualizacao ? Math.floor((Date.now() - new Date(r.data_atualizacao).getTime()) / 86400000) : null);

  const tr = document.createElement('tr');
  tr.dataset.id = r.id;

  // P — botão Alta
  const btnAlta = document.createElement('button');
  btnAlta.className = 'pac-alta-btn';
  btnAlta.title = r.is_alta ? 'Remover alta' : 'Marcar como alta';
  btnAlta.textContent = r.is_alta ? '✅' : '○';
  btnAlta.dataset.id   = r.id;
  btnAlta.dataset.alta = r.is_alta ? '1' : '';
  const tdAlta = document.createElement('td');
  tdAlta.appendChild(btnAlta);
  tr.appendChild(tdAlta);

  // Nome
  const strong = document.createElement('strong');
  strong.textContent = r.nome || '';
  const tdNome = document.createElement('td');
  tdNome.appendChild(strong);
  tr.appendChild(tdNome);

  tr.appendChild(editCel(r.id, 'tratamento',      r.tratamento));
  tr.appendChild(cel(r.data_venda));
  tr.appendChild(editCel(r.id, 'data_atualizacao', r.data_atualizacao));
  tr.appendChild(editCel(r.id, 'proximo_passo',    r.proximo_passo));
  tr.appendChild(editCel(r.id, 'data_agendamento', r.data_agendamento));
  tr.appendChild(editCel(r.id, 'avaliador',        r.avaliador));
  tr.appendChild(editCel(r.id, 'executor',         r.executor));
  tr.appendChild(editCel(r.id, 'obs',              r.obs));

  // Dias
  const tdDias = document.createElement('td');
  tdDias.className = 'pac-dias' + (typeof dias === 'number' && dias > 0 ? ' over' : '');
  tdDias.textContent = dias !== null ? dias : '—';
  tr.appendChild(tdDias);

  // Status
  const span = document.createElement('span');
  span.className = 'pac-status ' + st.cls;
  span.textContent = st.icon + ' ' + st.label;
  const tdSt = document.createElement('td');
  tdSt.appendChild(span);
  tr.appendChild(tdSt);

  // WhatsApp
  const tdWpp = document.createElement('td');
  if (r.telefone) {
    const a = document.createElement('a');
    a.className = 'pac-wpp';
    a.href = 'https://wa.me/55' + r.telefone;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = '💬';
    tdWpp.appendChild(a);
  }
  tr.appendChild(tdWpp);

  return tr;
}

function renderTable() {
  const fStatus = document.getElementById('fStatus').value;
  const fTrat   = document.getElementById('fTratamento').value;
  const fExec   = document.getElementById('fExecutor').value;

  const filtered = rows.filter(r => {
    const st = calcStatus(r);
    if (fStatus && st.cls !== fStatus) return false;
    if (fTrat  && r.tratamento !== fTrat) return false;
    if (fExec  && r.executor   !== fExec) return false;
    return true;
  });

  document.getElementById('pacCount').textContent = `${filtered.length} paciente(s)`;
  const tbody = document.getElementById('pacTbody');
  tbody.textContent = ''; // limpa sem innerHTML
  const frag = document.createDocumentFragment();
  filtered.forEach(r => frag.appendChild(makeRow(r)));
  tbody.appendChild(frag);
}

// ── event delegation no tbody (zero onclick inline) ───────────────
document.getElementById('pacTbody').addEventListener('click', async e => {
  // Botão Alta
  const btn = e.target.closest('.pac-alta-btn');
  if (btn) {
    const id      = btn.dataset.id;
    const current = btn.dataset.alta === '1';
    try {
      const updated = await PacientesAPI.atualizar(id, { is_alta: !current });
      const idx = rows.findIndex(r => r.id === id);
      if (idx >= 0) rows[idx] = updated;
      renderTable();
    } catch(err) { alert('Erro: ' + err.message); }
    return;
  }

  // Célula editável
  const td = e.target.closest('.pac-cell-edit');
  if (!td || td.querySelector('input')) return;
  const { id, field, value } = td.dataset;
  const orig = td.textContent;
  const inp  = document.createElement('input');
  inp.className = 'pac-edit-input';
  inp.type  = field.includes('data') ? 'date' : 'text';
  inp.value = value;
  td.textContent = '';
  td.appendChild(inp);
  inp.focus();

  async function save() {
    const val = inp.value.trim();
    try {
      const updated = await PacientesAPI.atualizar(id, { [field]: val || null });
      const idx = rows.findIndex(r => r.id === id);
      if (idx >= 0) rows[idx] = updated;
      renderTable();
    } catch(err) { td.textContent = orig; alert('Erro: ' + err.message); }
  }

  inp.addEventListener('blur', save);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') { inp.removeEventListener('blur', save); td.textContent = orig; }
  });
});

async function init() {
  try {
    const [data, cfg] = await Promise.all([PacientesAPI.listar(), PacientesAPI.config()]);
    rows   = data;
    config = Object.fromEntries(cfg.map(c => [c.tratamento, c]));

    // preencher filtros com textContent (sem innerHTML)
    const fTrat = document.getElementById('fTratamento');
    const fExec = document.getElementById('fExecutor');
    [...new Set(data.map(r => r.tratamento).filter(Boolean))].sort().forEach(t => {
      const o = document.createElement('option'); o.textContent = t; fTrat.appendChild(o);
    });
    [...new Set(data.map(r => r.executor).filter(Boolean))].sort().forEach(e => {
      const o = document.createElement('option'); o.textContent = e; fExec.appendChild(o);
    });

    document.getElementById('pacMsg').style.display = 'none';
    document.getElementById('pacTableWrap').style.display = '';
    renderTable();
  } catch(e) {
    document.getElementById('pacMsg').textContent = 'Erro: ' + e.message;
  }
}

init();
</script>
</body>
</html>
```

- [ ] **Step 7.3: Commit**

```bash
git add public/pacientes/index.html public/js/pacientes/api.js
git commit -m "feat: modulo /pacientes/ — tabela CRC Sucesso com status automatico por tratamento"
```

---

## Task 8: Deploy e Verificação Final

- [ ] **Step 8.1: git push + deploy**

```bash
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

- [ ] **Step 8.2: Verificar endpoints**

Logar como admin no CRM e abrir o DevTools:

```js
// no console do browser
const t = JSON.parse(Object.entries(localStorage).find(([k])=>k.startsWith('sb-')&&k.endsWith('-auth-token'))[1]).access_token;
fetch('/api/pacientes/config', {headers:{Authorization:'Bearer '+t}}).then(r=>r.json()).then(d=>console.log('Config ok:', d.length, 'tratamentos'));
fetch('/api/pacientes', {headers:{Authorization:'Bearer '+t}}).then(r=>r.json()).then(d=>console.log('Pacientes ok:', d.length, 'registros'));
```

Esperado: `Config ok: 15 tratamentos`, `Pacientes ok: N registros` (N > 0 após o import do Task 6).

- [ ] **Step 8.3: Verificar módulo no browser**

1. Acessar `/pacientes/` logado como admin
2. Confirmar que a tabela carrega com dados
3. Confirmar que o status é colorido corretamente (🔴🟡🟢⚪✅)
4. Clicar em uma célula editável (ex: Próximo Passo), digitar algo, pressionar Enter → confirmar que salva sem recarregar
5. Clicar no botão ○ de um paciente → confirmar que vira ✅ ALTA
6. Testar filtro por Status → confirmar que filtra

- [ ] **Step 8.4: Verificar fluxo Conferência → Pacientes**

1. Acessar `/comercial/conferencia/` logado como gestor
2. Aprovar um fechamento que NÃO esteja no módulo Pacientes ainda
3. Acessar `/pacientes/` e confirmar que o paciente aparece na lista

- [ ] **Step 8.5: Verificar CAPI no Gerenciador de Eventos Meta**

Acessar o Gerenciador de Eventos da Meta (pixel 904146029308947). Confirmar que eventos `Purchase` históricos aparecem (pode levar algumas horas para a Meta processar).

---

## Notas de Implementação

**Encoding CSV:** Tentar `latin1` primeiro, fallback para `utf8`. Chars como `ã`, `ç`, `é` devem renderizar corretamente nos nomes.

**CAPI event_time:** Eventos com datas > 7 dias no passado têm peso menor para atribuição mas alimentam normalmente as Audiências Personalizadas e Lookalike — que é o objetivo principal.

**Re-execução segura:** O script verifica `lead_eventos` com `tipo like 'historico_%'` antes de inserir e verifica `pacientes_sucesso` por telefone antes de inserir. Pode ser re-executado sem duplicar dados.

**Pacientes sem telefone no Sheets:** São inseridos em `pacientes_sucesso` com `telefone = null`, vinculados apenas por nome. Não aparecem no CAPI backfill.
