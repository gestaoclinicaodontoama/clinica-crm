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
    const { data: jaExisteArr } = await supabase.from('pacientes_sucesso')
      .select('id').eq('lead_id', orc.lead_id).limit(1);
    if (!jaExisteArr?.length) {
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

// Telefone para a Meta: dígitos COM código do país (55). normalizeTel devolve SEM 55 (chave interna).
function phoneForMeta(tel) {
  const t = String(tel || '').replace(/\D/g, '');
  if (!t) return null;
  return t.startsWith('55') ? t : '55' + t;
}

// Valores em formato pt-BR: "1.500,00" -> 1500.0 (corrige parseFloat que quebra com vírgula/ponto).
function parseBRMoney(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/\s/g, '').replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

function parseDate(s) {
  if (!s || s === '') return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function toDateStr(d) { return d ? d.toISOString().split('T')[0] : null; }

// Detecção de encoding: prefere UTF-8 (com ou sem BOM); cai para Latin-1/Win-1252
// só se o decode UTF-8 produzir byte inválido (U+FFFD). Evita corromper ã/ç/é silenciosamente.
function readFileSmart(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8'); // BOM UTF-8
  const utf8 = buf.toString('utf8');
  const REPL = String.fromCharCode(0xFFFD); // caractere de substituição (byte inválido em UTF-8)
  if (utf8.indexOf(REPL) === -1) return utf8; // decodificou limpo como UTF-8
  return buf.toString('latin1');              // bytes inválidos em UTF-8 → Latin-1
}

// Parser CSV com state-machine: respeita aspas, delimitador dentro de aspas,
// aspas escapadas ("") e quebras de linha dentro de campos entre aspas.
function parseCSV(text, delim = ';') {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // "" → aspas literal
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignora CR; \r\n tratado pelo \n */ }
      else field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function readCSVDir(dir) {
  const rows = [];
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.csv')).sort();
  for (const f of files) {
    const recs = parseCSV(readFileSmart(path.join(dir, f)), ';');
    if (recs.length < 2) continue;
    const headers = recs[0].map(h => h.trim());
    for (let i = 1; i < recs.length; i++) {
      const vals = recs[i];
      if (vals.length === 1 && vals[0].trim() === '') continue; // linha em branco
      const row = {};
      headers.forEach((h, j) => { row[h] = vals[j] !== undefined ? vals[j].trim() : ''; });
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

  // ── 1) classificar todos (sem I/O) ─────────────────────────────
  const classified = [];
  for (const [tel, leadRow] of mapLead) {
    const fRow  = mapFech.get(tel);
    const oRow  = mapOrcOpen.get(tel);
    const aRow  = mapAgend.get(tel);
    const isComp = telsComp.has(tel);

    let status, extraData = {};
    if (fRow) {
      status = 'Fechou'; stats.Fechou++;
      extraData = {
        valor: parseBRMoney(fRow['Valor fechado']),
        entrada: parseBRMoney(fRow['Valor entrada']),
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
    classified.push({ tel, leadRow, status, extraData, isComp });
  }

  // ── 2) inserir leads NOVOS em lote (500/req) ───────────────────
  const toInsertLeads = [];
  for (const c of classified) {
    if (mapExisting.has(c.tel)) { stats.Existente++; continue; }
    if (!c.status) continue; // comp sem orc e sem lead existente → pula
    toInsertLeads.push({
      nome: c.leadRow['Nome'] || 'Sem nome',
      telefone: c.tel,
      origem: c.leadRow['Origem'] || 'Importado',
      status: c.status,
      importado_historico: true,
      ...(c.extraData.dataCadastro && { criado_em: c.extraData.dataCadastro.toISOString() }),
      ...(c.extraData.valor ? { valor: c.extraData.valor } : {}),
    });
  }
  for (let i = 0; i < toInsertLeads.length; i += 500) {
    const { data: ins, error } = await supabase.from('leads')
      .insert(toInsertLeads.slice(i, i + 500))
      .select('id, telefone, eventos_meta_enviados, email, valor');
    if (error) { console.error('Erro insert leads lote:', error.message); continue; }
    for (const l of (ins || [])) { mapExisting.set(l.telefone, l); stats.Novo++; }
  }

  // ── 3) montar processed + acumular lead_eventos ────────────────
  const processed = []; // { leadId, tel, status, extraData, existingLead }
  const allEvts = [];
  for (const { tel, leadRow, status, extraData, isComp } of classified) {
    const existingLead = mapExisting.get(tel);
    if (!existingLead) continue; // não inserido (comp sem orc sem lead, ou erro no lote)
    const leadId = existingLead.id;

    const dc = extraData.dataCadastro || new Date();
    allEvts.push({ lead_id: leadId, tipo: 'historico_lead_criado', descricao: `Lead histórico — ${leadRow['Origem'] || 'Importado'}`, metadata: { importado: true }, criado_em: dc.toISOString() });
    if (extraData.dataAgendamento) allEvts.push({ lead_id: leadId, tipo: 'historico_agendado', descricao: `Agendamento histórico em ${extraData.dataAgendamento.toLocaleDateString('pt-BR')}`, metadata: { importado: true }, criado_em: extraData.dataAgendamento.toISOString() });
    if (isComp && extraData.dataAgendamento) allEvts.push({ lead_id: leadId, tipo: 'historico_compareceu', descricao: 'Compareceu à consulta (histórico)', metadata: { importado: true }, criado_em: extraData.dataAgendamento.toISOString() });
    if (extraData.dataOrcamento) allEvts.push({ lead_id: leadId, tipo: 'historico_orcamento', descricao: `Orçamento: R$ ${extraData.valor || 0} — ${extraData.tratamento}`, metadata: { importado: true }, criado_em: extraData.dataOrcamento.toISOString() });
    if (extraData.dataFechamento && status === 'Fechou') allEvts.push({ lead_id: leadId, tipo: 'historico_fechou', descricao: `Fechamento: R$ ${extraData.valor} (entrada: R$ ${extraData.entrada})`, metadata: { valor: extraData.valor, entrada: extraData.entrada, tratamento: extraData.tratamento, importado: true }, criado_em: extraData.dataFechamento.toISOString() });

    processed.push({ leadId, tel, status, extraData, existingLead });
  }

  // ── 4) dedup + insert lead_eventos em lote ─────────────────────
  const evtLeadIds = [...new Set(allEvts.map(e => e.lead_id))];
  const existKeys = new Set();
  for (let i = 0; i < evtLeadIds.length; i += 500) {
    const { data } = await supabase.from('lead_eventos')
      .select('lead_id, tipo').in('lead_id', evtLeadIds.slice(i, i + 500)).like('tipo', 'historico_%');
    for (const e of (data || [])) existKeys.add(`${e.lead_id}|${e.tipo}`);
  }
  const novosEvts = allEvts.filter(e => !existKeys.has(`${e.lead_id}|${e.tipo}`));
  for (let i = 0; i < novosEvts.length; i += 500) {
    const { error } = await supabase.from('lead_eventos').insert(novosEvts.slice(i, i + 500));
    if (error) console.error('Erro insert eventos lote:', error.message);
  }
  console.log(`Eventos: ${novosEvts.length} novos de ${allEvts.length} candidatos`);

  console.log('\n📊 Stats leads:', stats);

  // ── pacientes_sucesso ──────────────────────────────────────────
  await upsertPacientes(processed, sheetsRows, mapFech);

  // ── Meta: audiência histórica (SEM limite) + CAPI offline recente (≤62d) ──
  await buildCustomAudience(processed);
  await offlineCapiRecent(processed);

  console.log('\n✅ Importação concluída!');
}

async function upsertPacientes(processed, sheetsRows, mapFech) {
  console.log('\n📋 Inserindo pacientes_sucesso...');
  const mapProcessed = new Map(processed.map(p => [p.tel, p]));

  // ── existentes (uma vez, paginado) ─────────────────────────────
  const existTel = new Set(), existNome = new Set();
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase.from('pacientes_sucesso').select('telefone, nome').range(from, from + 999);
    if (!data || !data.length) break;
    for (const r of data) { if (r.telefone) existTel.add(r.telefone); if (r.nome) existNome.add(r.nome.trim()); }
    if (data.length < 1000) break;
  }

  const toInsert = [];
  const willTel = new Set(); // já enfileirados nesta execução (evita duplicar entre Sheets e CSV)

  // Sheets (fonte primária)
  for (const row of sheetsRows) {
    const tel = normalizeTel(row.telefone || '');
    const nome = (row.nome || '').trim();
    if (!nome) continue;
    const existe = tel ? (existTel.has(tel) || willTel.has(tel)) : existNome.has(nome);
    if (existe) { if (tel) willTel.add(tel); continue; }

    const fRow = tel ? mapFech.get(tel) : null;
    const p = tel ? mapProcessed.get(tel) : null;
    toInsert.push({
      lead_id: p?.leadId || null,
      nome, telefone: tel || null,
      tratamento: row.tratamento || null,
      data_venda: row.data_venda || (fRow ? toDateStr(parseDate(fRow['Data fechamento'])) : null),
      valor_fechado: fRow ? (parseBRMoney(fRow['Valor fechado']) || null) : null,
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
    if (tel) willTel.add(tel); else existNome.add(nome);
  }

  // CSV fechamentos não cobertos pelo Sheets
  for (const [tel, fRow] of mapFech) {
    if (existTel.has(tel) || willTel.has(tel)) continue;
    const p = mapProcessed.get(tel) || {};
    toInsert.push({
      lead_id: p.leadId || null,
      nome: fRow['Nome'] || '',
      telefone: tel,
      tratamento: fRow['Tratamento'] || null,
      data_venda: toDateStr(parseDate(fRow['Data fechamento'])),
      valor_fechado: parseBRMoney(fRow['Valor fechado']) || null,
      importado_historico: true,
    });
    willTel.add(tel);
  }

  // insert em lote (500/req)
  for (let i = 0; i < toInsert.length; i += 500) {
    const { error } = await supabase.from('pacientes_sucesso').insert(toInsert.slice(i, i + 500));
    if (error) console.error('pacientes_sucesso lote:', error.message);
  }
  console.log(`✅ pacientes_sucesso ok (${toInsert.length} inseridos)`);
}

const AUDIENCE_NAME = 'Pacientes Fechados (histórico 2023–2026)';
const SIXTY_TWO_DAYS_MS = 62 * 24 * 60 * 60 * 1000;

// Cria (ou reusa) a Custom Audience pelo nome e devolve o id.
async function getOrCreateAudience(adAccount, token) {
  const list = await fetch(`https://graph.facebook.com/v21.0/act_${adAccount}/customaudiences?fields=id,name&limit=500&access_token=${token}`);
  const lj = await list.json();
  if (lj.error) throw new Error('listar audiences: ' + JSON.stringify(lj.error));
  const found = (lj.data || []).find(a => a.name === AUDIENCE_NAME);
  if (found) { console.log(`  audiência existente: ${found.id}`); return found.id; }

  const create = await fetch(`https://graph.facebook.com/v21.0/act_${adAccount}/customaudiences`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: AUDIENCE_NAME,
      description: 'Pacientes que fecharam tratamento (importação histórica CSV). Seed de Lookalike e exclusão.',
      subtype: 'CUSTOM',
      customer_file_source: 'USER_PROVIDED_ONLY',
      access_token: token,
    }),
  });
  const cj = await create.json();
  if (cj.error) throw new Error('criar audience: ' + JSON.stringify(cj.error));
  console.log(`  audiência criada: ${cj.id}`);
  return cj.id;
}

// PARTE 2A — Custom Audience (histórico COMPLETO, sem limite de tempo).
// É a ferramenta correta para o objetivo: seed de Lookalike + exclusão de pacientes ativos.
async function buildCustomAudience(processed) {
  const TOKEN = process.env.META_ACCESS_TOKEN;
  const AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID; // ex.: 945699087658457 (sem "act_")
  if (!TOKEN || !AD_ACCOUNT) { console.log('⚠️  Custom Audience: META_ACCESS_TOKEN ou META_AD_ACCOUNT_ID ausentes — pulando'); return; }
  console.log('\n👥 Custom Audience (pacientes fechados)...');

  // Só quem fechou, dedup por telefone, com hash COM código do país.
  const seen = new Set();
  const rows = [];
  for (const { tel, status, existingLead } of processed) {
    if (status !== 'Fechou') continue;
    const phRaw = phoneForMeta(tel);
    const phHash = phRaw ? sha256(phRaw) : '';
    const emHash = existingLead?.email ? sha256(existingLead.email) : '';
    if (!phHash && !emHash) continue;
    const key = phHash || emHash;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([emHash, phHash]); // ordem casa com schema ['EMAIL','PHONE']
  }
  console.log(`  ${rows.length} pacientes fechados para upload`);
  if (!rows.length) { console.log('  nada a enviar'); return; }

  const audienceId = await getOrCreateAudience(AD_ACCOUNT, TOKEN);

  let enviados = 0;
  for (let i = 0; i < rows.length; i += 10000) {
    const chunk = rows.slice(i, i + 10000);
    const body = { payload: { schema: ['EMAIL', 'PHONE'], data: chunk }, access_token: TOKEN };
    const r = await fetch(`https://graph.facebook.com/v21.0/${audienceId}/users`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok || j.error) { console.error('  ✗ upload lote:', JSON.stringify(j.error || j).slice(0, 200)); continue; }
    enviados += j.num_received ?? chunk.length;
    console.log(`  ✓ lote ${Math.floor(i / 10000) + 1}: recebidos=${j.num_received} inválidos=${j.num_invalid_entries ?? 0}`);
  }
  console.log(`✅ Custom Audience ok (${enviados} enviados, audience ${audienceId})`);
}

// PARTE 2B — CAPI offline (action_source 'physical_store', janela de 62 dias).
// Para o histórico 2023–2025 NÃO envia nada (tudo > 62 dias); fica pronto para conversões recentes.
async function offlineCapiRecent(processed) {
  const PIXEL = process.env.META_PIXEL_ID;        // dataset/pixel id
  const TOKEN = process.env.META_ACCESS_TOKEN;
  const TEST  = process.env.META_TEST_EVENT_CODE; // opcional: valida na aba Test Events antes de produção
  if (!PIXEL || !TOKEN) { console.log('⚠️  CAPI offline: META_PIXEL_ID ou META_ACCESS_TOKEN ausentes — pulando'); return; }
  console.log('\n📤 CAPI offline (Purchase ≤62 dias)...');

  const limite = Date.now() - SIXTY_TWO_DAYS_MS;
  let enviados = 0, foraJanela = 0;
  for (const { leadId, tel, status, extraData, existingLead } of processed) {
    if (status !== 'Fechou') continue;
    const dt = extraData.dataFechamento;
    if (!dt) continue;
    if (dt.getTime() < limite) { foraJanela++; continue; } // > 62 dias → não enviável como evento
    if ((existingLead?.eventos_meta_enviados || []).includes('Purchase')) continue;

    const user_data = {};
    const phRaw = phoneForMeta(tel);
    if (phRaw) user_data.ph = [sha256(phRaw)];
    if (existingLead?.email) user_data.em = [sha256(existingLead.email)];

    const evt = {
      event_name: 'Purchase',
      event_time: Math.floor(dt.getTime() / 1000),
      action_source: 'physical_store',
      event_id: `hist_${leadId}_Purchase`,
      user_data,
      custom_data: { currency: 'BRL', value: Number(extraData.valor) || 0 }, // extraData.valor já é número (parseBRMoney)
    };
    const payload = { data: [evt], ...(TEST ? { test_event_code: TEST } : {}) };

    try {
      const r = await fetch(`https://graph.facebook.com/v21.0/${PIXEL}/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      // events_received SOZINHO não prova aceitação — checar r.ok e ausência de error.
      if (r.ok && !j.error && j.events_received) {
        console.log(`  ✓ Purchase lead ${leadId} (${toDateStr(dt)})`);
        const evs = [...(existingLead?.eventos_meta_enviados || [])];
        if (!evs.includes('Purchase')) evs.push('Purchase');
        await supabase.from('leads').update({ eventos_meta_enviados: evs, enviado_meta: true }).eq('id', leadId);
        enviados++;
      } else {
        console.error(`  ✗ Purchase lead ${leadId}:`, JSON.stringify(j.error || j).slice(0, 200));
      }
    } catch (e) { console.error(`  ✗ CAPI offline lead ${leadId}:`, e.message); }
    await new Promise(r => setTimeout(r, 50));
  }
  console.log(`✅ CAPI offline ok (${enviados} enviados, ${foraJanela} fora da janela de 62 dias → cobertos pela Custom Audience)`);
}

main().catch(e => { console.error('💥', e); process.exit(1); });
```

- [ ] **Step 5.2: Validar sintaxe do script**

Rodar `node --check scripts/import-historico.js` para garantir que não há erro de sintaxe antes de executar. O script usa `telsComp` de forma consistente (declarada uma única vez em `main()`) e `toDateStr` é declarada apenas uma vez — não há placeholder nem duplicata a corrigir.

- [ ] **Step 5.3: Commit**

```bash
git add scripts/import-historico.js
git commit -m "feat: script de importacao historica CSV + Custom Audience + CAPI offline"
```

---

## Task 6: Executar o Script de Importação

**Pré-requisito:** Tasks 1–5 completas. `.env` com `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID` (ex.: `945699087658457`, sem `act_`) e `META_PIXEL_ID`. Opcional: `META_TEST_EVENT_CODE` (valida o CAPI offline na aba Test Events antes de produção).

> **Token Meta:** precisa de permissão `ads_management` (Custom Audience usa a Marketing API, não só o Pixel). Faça **uma** chamada de teste antes do run em massa: `GET /act_<id>/customaudiences` deve responder 200. Se der erro de permissão/escopo, corrija o token antes de prosseguir.

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
Telefones únicos: ~N
Já existem no Supabase: ~N
Eventos: ~N novos de ~M candidatos
📊 Stats leads: { Fechou: ~817, Reclassificar: ~N, Faltou: ~N, Nutrir: ~N, Novo: ~N, Existente: ~N, ... }
📋 Inserindo pacientes_sucesso...
✅ pacientes_sucesso ok (~N inseridos)
👥 Custom Audience (pacientes fechados)...
✅ Custom Audience ok (~817 enviados, audience <id>)
✅ CAPI offline ok (0 enviados, ~817 fora da janela de 62 dias → cobertos pela Custom Audience)
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

- [ ] **Step 6.4: Verificar a Custom Audience no Gerenciador da Meta**

1. Abrir **Gerenciador de Anúncios → Públicos** na conta `945699087658457`.
2. Confirmar que existe o público **"Pacientes Fechados (histórico 2023–2026)"**.
3. O tamanho aparece como "Preenchendo"/"Pronto" em algumas horas (a Meta processa o match de forma assíncrona). Esperado: alcance próximo ao nº de fechamentos com telefone válido.
4. Conferir o `num_invalid_entries` do log do script (Step 6.2): se alto, revisar normalização de telefone/email.

> A partir desse público é possível criar o **Lookalike** (semelhantes a quem fechou) e usá-lo como **exclusão** nas campanhas de prospecção. Isso é manual no Gerenciador — fora do escopo do script.

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

**Encoding CSV:** `readFileSmart` prefere **UTF-8** (com/sem BOM) e só cai para Latin-1 se o decode UTF-8 produzir byte inválido (U+FFFD) — evita corromper `ã/ç/é` silenciosamente, que era o risco de ler `latin1` cego. Confira 1 nome com acento na tabela após o import (Step 6.3) para validar o encoding.

**Parsing CSV:** `parseCSV` é um state-machine que respeita aspas, delimitador `;` dentro de aspas, aspas escapadas (`""`) e quebras de linha dentro de campos. Substitui o `split(';')`/`split('\n')` ingênuo, que desalinhava colunas quando **Nome** ou **Obs** continham `;` ou aspas.

**Dedup `pacientes_sucesso`:** as checagens de existência usam `.limit(1)` (não `.maybeSingle()`), que não estoura se houver telefone duplicado na base.

**Janela de tempo da Meta (CRÍTICO):** a Conversions API **rejeita** eventos web com `event_time` > 7 dias e offline > 62 dias. Como os CSVs são de 2023–2025 (tudo > 62 dias em jun/2026), **eventos CAPI não servem para o histórico** — usaríamos e a Meta descartaria silenciosamente. Por isso o histórico vai por **Custom Audience (lista)**, que não tem janela de tempo. O CAPI offline (`physical_store`) fica só para fechamentos recentes (≤62 dias).

**`events_received` não prova aceitação:** a Meta pode responder `events_received: 1` e descartar o evento depois (fora da janela, payload inválido). O script checa `r.ok` + ausência de `error` e recomenda validar com `META_TEST_EVENT_CODE` antes do run real.

**Hash de PII:** telefone vai com código do país (`55` + DDD + número, só dígitos) via `phoneForMeta()` — sem isso o match quality é ~0. Email em minúsculas + trim. Ambos SHA-256.

**Re-execução segura:** dedup de leads por telefone (via `mapExisting`, carregado do Supabase no início), de `lead_eventos` por `(lead_id, tipo)` com `tipo like 'historico_%'`, e de `pacientes_sucesso` por telefone/nome (carregados uma vez). Pode ser re-executado sem duplicar.

**Performance (batch):** inserts em lote de 500 (`leads`, `lead_eventos`, `pacientes_sucesso`) e leituras de dedup paginadas — em vez de 1 round-trip por lead. Reduz de ~1-2h para minutos em ~10k leads. Se um lote falhar (ex.: coluna/constraint), o erro é logado e os demais seguem; re-rodar reenvia só o que faltou (idempotente). Se um lote inteiro falhar de forma sistemática, inspecione o erro e reduza o tamanho do lote.

**Pacientes sem telefone no Sheets:** São inseridos em `pacientes_sucesso` com `telefone = null`, vinculados apenas por nome. Não entram na Custom Audience (sem telefone/email para match).

**Re-execução da audiência:** reenviar os mesmos usuários hasheados é idempotente do lado da Meta (é um conjunto). `getOrCreateAudience` reusa o público pelo nome, então re-rodar não cria duplicatas.
