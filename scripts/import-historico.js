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

function phoneForMeta(tel) {
  const t = String(tel || '').replace(/\D/g, '');
  if (!t) return null;
  return t.startsWith('55') ? t : '55' + t;
}

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

function readFileSmart(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
  const utf8 = buf.toString('utf8');
  const REPL = String.fromCharCode(0xFFFD);
  if (utf8.indexOf(REPL) === -1) return utf8;
  return buf.toString('latin1');
}

function parseCSV(text, delim = ';') {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignora CR */ }
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
      if (vals.length === 1 && vals[0].trim() === '') continue;
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

  const mapLead = new Map();
  for (const r of [...leadsCSV, ...fechCSV]) {
    const t = normalizeTel(r['Telefone']);
    if (!t) continue;
    const ex = mapLead.get(t);
    if (!ex || parseDate(r['Data de cadastro']) > parseDate(ex['Data de cadastro'])) mapLead.set(t, r);
  }

  console.log(`Telefones únicos: ${mapLead.size}`);

  const allTels = [...mapLead.keys()];
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
      status = 'Nutrir'; stats.Faltou++;
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

  const toInsertLeads = [];
  for (const c of classified) {
    if (mapExisting.has(c.tel)) { stats.Existente++; continue; }
    if (!c.status) continue;
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

  const processed = [];
  const allEvts = [];
  for (const { tel, leadRow, status, extraData, isComp } of classified) {
    const existingLead = mapExisting.get(tel);
    if (!existingLead) continue;
    const leadId = existingLead.id;

    const dc = extraData.dataCadastro || new Date();
    allEvts.push({ lead_id: leadId, tipo: 'historico_lead_criado', descricao: `Lead histórico — ${leadRow['Origem'] || 'Importado'}`, metadata: { importado: true }, criado_em: dc.toISOString() });
    if (extraData.dataAgendamento) allEvts.push({ lead_id: leadId, tipo: 'historico_agendado', descricao: `Agendamento histórico em ${extraData.dataAgendamento.toLocaleDateString('pt-BR')}`, metadata: { importado: true }, criado_em: extraData.dataAgendamento.toISOString() });
    if (isComp && extraData.dataAgendamento) allEvts.push({ lead_id: leadId, tipo: 'historico_compareceu', descricao: 'Compareceu à consulta (histórico)', metadata: { importado: true }, criado_em: extraData.dataAgendamento.toISOString() });
    if (extraData.dataOrcamento) allEvts.push({ lead_id: leadId, tipo: 'historico_orcamento', descricao: `Orçamento: R$ ${extraData.valor || 0} — ${extraData.tratamento}`, metadata: { importado: true }, criado_em: extraData.dataOrcamento.toISOString() });
    if (extraData.dataFechamento && status === 'Fechou') allEvts.push({ lead_id: leadId, tipo: 'historico_fechou', descricao: `Fechamento: R$ ${extraData.valor} (entrada: R$ ${extraData.entrada})`, metadata: { valor: extraData.valor, entrada: extraData.entrada, tratamento: extraData.tratamento, importado: true }, criado_em: extraData.dataFechamento.toISOString() });

    processed.push({ leadId, tel, status, extraData, existingLead });
  }

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

  await upsertPacientes(processed, sheetsRows, mapFech);
  await buildCustomAudience(processed);
  await offlineCapiRecent(processed);

  console.log('\n✅ Importação concluída!');
}

async function upsertPacientes(processed, sheetsRows, mapFech) {
  console.log('\n📋 Inserindo pacientes_sucesso...');
  const mapProcessed = new Map(processed.map(p => [p.tel, p]));

  const existTel = new Set(), existNome = new Set();
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase.from('pacientes_sucesso').select('telefone, nome').range(from, from + 999);
    if (!data || !data.length) break;
    for (const r of data) { if (r.telefone) existTel.add(r.telefone); if (r.nome) existNome.add(r.nome.trim()); }
    if (data.length < 1000) break;
  }

  const toInsert = [];
  const willTel = new Set();

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

  for (let i = 0; i < toInsert.length; i += 500) {
    const { error } = await supabase.from('pacientes_sucesso').insert(toInsert.slice(i, i + 500));
    if (error) console.error('pacientes_sucesso lote:', error.message);
  }
  console.log(`✅ pacientes_sucesso ok (${toInsert.length} inseridos)`);
}

const AUDIENCE_NAME = 'Pacientes Fechados (histórico 2023–2026)';
const SIXTY_TWO_DAYS_MS = 62 * 24 * 60 * 60 * 1000;

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

async function buildCustomAudience(processed) {
  const TOKEN = process.env.META_ACCESS_TOKEN;
  const AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID;
  if (!TOKEN || !AD_ACCOUNT) { console.log('⚠️  Custom Audience: META_ACCESS_TOKEN ou META_AD_ACCOUNT_ID ausentes — pulando'); return; }
  console.log('\n👥 Custom Audience (pacientes fechados)...');

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
    rows.push([emHash, phHash]);
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

async function offlineCapiRecent(processed) {
  const PIXEL = process.env.META_PIXEL_ID;
  const TOKEN = process.env.META_ACCESS_TOKEN;
  const TEST  = process.env.META_TEST_EVENT_CODE;
  if (!PIXEL || !TOKEN) { console.log('⚠️  CAPI offline: META_PIXEL_ID ou META_ACCESS_TOKEN ausentes — pulando'); return; }
  console.log('\n📤 CAPI offline (Purchase ≤62 dias)...');

  const limite = Date.now() - SIXTY_TWO_DAYS_MS;
  let enviados = 0, foraJanela = 0;
  for (const { leadId, tel, status, extraData, existingLead } of processed) {
    if (status !== 'Fechou') continue;
    const dt = extraData.dataFechamento;
    if (!dt) continue;
    if (dt.getTime() < limite) { foraJanela++; continue; }
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
      custom_data: { currency: 'BRL', value: Number(extraData.valor) || 0 },
    };
    const payload = { data: [evt], ...(TEST ? { test_event_code: TEST } : {}) };

    try {
      const r = await fetch(`https://graph.facebook.com/v21.0/${PIXEL}/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
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
