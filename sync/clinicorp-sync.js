// Sync diário Clinicorp → Supabase.
// Atualiza: agendamentos, pagamentos, orçamentos e novos pacientes.
// Rate limit tratado automaticamente por clinicorp-api.js (espera 1h10m se precisar).
//
// Uso direto: node sync/clinicorp-sync.js
// Uso via server.js: const { runSync } = require('./sync/clinicorp-sync')

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { createClient } = require('@supabase/supabase-js');
const ClinicorpApi     = require('./clinicorp-api');
const { normalizarTelefone } = require('../lib/funil/telefone');
const { classificarOrcamento } = require('../lib/funil/orcamento');

const FUNIL_DIAS = 180; // janela de coleta do funil comercial

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const api = new ClinicorpApi({
  user:         'clinicaama',
  token:        '48d8b02a-c51c-4a71-9041-2c5effdf377c',
  subscriberId: 'clinicaama',
  businessId:   'clinicaama',
});

// ─── helpers ────────────────────────────────────────────────────────────────

function log(msg) {
  const t = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  console.log(`[${t}] [clinicorp-sync] ${msg}`);
}

function toDate(v) {
  if (!v) return null;
  return String(v).split('T')[0]; // "2026-05-18T03:00:00Z" → "2026-05-18"
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diff / 86_400_000);
}

function dateStr(d) { return ClinicorpApi.toDateStr(d); }

// ─── fases do sync ──────────────────────────────────────────────────────────

/**
 * Busca agendamentos (passados 30d + futuros 60d).
 * Retorna mapa: clinicorp_id → { ultima_visita, proxima_consulta, proximo_dentista }
 */
async function fetchAppointments() {
  const today      = new Date();
  const past30     = new Date(today); past30.setDate(past30.getDate() - 30);
  const future60   = new Date(today); future60.setDate(future60.getDate() + 60);

  log('Buscando agendamentos passados (30 dias)...');
  const past   = await api.get('/appointment/list', { from: dateStr(past30),   to: dateStr(today)    });
  log('Buscando agendamentos futuros (60 dias)...');
  const future = await api.get('/appointment/list', { from: dateStr(today),    to: dateStr(future60) });

  const pastArr   = Array.isArray(past)   ? past   : [];
  const futureArr = Array.isArray(future) ? future : [];
  log(`Agendamentos: ${pastArr.length} passados, ${futureArr.length} futuros`);

  const byId = {}; // clinicorp_id → dados

  for (const a of pastArr) {
    const id   = a.PatientId || a.patientId;
    if (!id) continue;
    const date = toDate(a.Date || a.date || a.AppointmentDate || a.ScheduleDate);
    if (!byId[id]) byId[id] = {};
    if (date && (!byId[id].ultima_visita || date > byId[id].ultima_visita)) {
      byId[id].ultima_visita = date;
    }
  }

  for (const a of futureArr) {
    const id   = a.PatientId || a.patientId;
    if (!id) continue;
    const date = toDate(a.Date || a.date || a.AppointmentDate || a.ScheduleDate);
    const doc  = a.ProfessionalName || a.professionalName || a.DoctorName || '';
    if (!byId[id]) byId[id] = {};
    if (date && (!byId[id].proxima_consulta || date < byId[id].proxima_consulta)) {
      byId[id].proxima_consulta  = date;
      byId[id].proximo_dentista  = doc;
    }
  }

  return byId;
}

/**
 * Busca pagamentos dos últimos 30 dias.
 * Retorna mapa: clinicorp_id → { ultimo_pagamento, nome }
 */
async function fetchPayments() {
  const today  = new Date();
  const past30 = new Date(today); past30.setDate(past30.getDate() - 30);

  log('Buscando pagamentos (30 dias)...');
  const payments = await api.get('/payment/list', { from: dateStr(past30), to: dateStr(today) });
  const arr = Array.isArray(payments) ? payments : [];
  log(`Pagamentos encontrados: ${arr.length}`);

  const byId = {};
  for (const p of arr) {
    const id   = p.PatientId || p.patientId;
    if (!id) continue;
    const date = toDate(p.ReceivedDate || p.CheckOutDate || p.PaymentDate || p.Date);
    if (!byId[id]) {
      byId[id] = {
        nome:             p.PatientName || p.patientName || '',
        telefone:         p.MobilePhone || p.Phone || p.phone || '',
        ultimo_pagamento: date,
      };
    } else if (date && date > byId[id].ultimo_pagamento) {
      byId[id].ultimo_pagamento = date;
    }
  }

  return byId;
}

/**
 * Busca orçamentos em aberto.
 * Retorna Set de clinicorp_ids com orçamento aberto.
 */
async function fetchEstimates() {
  log('Buscando orçamentos em aberto...');
  const estimates = await api.get('/patient/list_estimates');
  const arr = Array.isArray(estimates) ? estimates : [];
  log(`Orçamentos em aberto: ${arr.length}`);

  return new Set(
    arr.map(e => String(e.PatientId || e.patientId)).filter(Boolean)
  );
}

// ─── gravação no Supabase ────────────────────────────────────────────────────

/**
 * Dado um conjunto de clinicorp_ids, retorna mapa clinicorp_id → uuid (pacientes.id).
 * Ids sem correspondência em pacientes são ignorados.
 */
async function getPatientUuids(clinicorpIds) {
  if (!clinicorpIds.length) return {};
  const { data, error } = await supabase
    .from('pacientes')
    .select('id, clinicorp_id')
    .in('clinicorp_id', clinicorpIds);

  if (error) { log(`ERRO getPatientUuids: ${error.message}`); return {}; }

  const map = {};
  for (const r of (data || [])) map[String(r.clinicorp_id)] = r.id;
  return map;
}

/**
 * Insere pacientes novos detectados via pagamentos que não estão em pacientes.
 * Chama /patient/get para obter dados completos (nome, telefone, email, nascimento).
 */
async function insertNewPatients(payMap) {
  const clinicorpIds = Object.keys(payMap).map(Number);
  if (!clinicorpIds.length) return;

  const { data: existing } = await supabase
    .from('pacientes')
    .select('clinicorp_id')
    .in('clinicorp_id', clinicorpIds);

  const existingSet = new Set((existing || []).map(r => String(r.clinicorp_id)));
  const novos = clinicorpIds.filter(id => !existingSet.has(String(id)));

  if (!novos.length) { log('Nenhum paciente novo detectado'); return; }
  log(`${novos.length} pacientes novos — buscando dados via /patient/get...`);

  const today = new Date().toISOString().slice(0, 10);
  let inserted = 0;

  for (const id of novos) {
    try {
      // Cada /patient/get consome 1 requisição — o rate limiter pausa automaticamente
      const p = await api.get('/patient/get', { id: String(id) });
      if (!p || !p.Name) {
        // Fallback: insere com dados básicos do pagamento
        await supabase.from('pacientes').upsert({
          clinicorp_id:     id,
          nome:             payMap[id]?.nome || `Paciente ${id}`,
          telefone_celular: payMap[id]?.telefone || null,
          inserido_em:      new Date().toISOString(),
        }, { onConflict: 'clinicorp_id', ignoreDuplicates: true });
        inserted++;
        continue;
      }

      const birth = (p.BirthDate || '').replace(/T.*/, '');
      await supabase.from('pacientes').upsert({
        clinicorp_id:     id,
        nome:             p.Name,
        data_nascimento:  birth && birth >= '1900-01-01' && birth < today ? birth : null,
        telefone_celular: p.MobilePhone || payMap[id]?.telefone || null,
        telefone_fixo:    p.Landline    || null,
        email:            p.Email       || null,
        ativo:            (p.Active || '') === 'X',
        inserido_em:      p.InsertDate  || new Date().toISOString(),
      }, { onConflict: 'clinicorp_id', ignoreDuplicates: true });
      inserted++;
    } catch (e) {
      log(`ERRO /patient/get id=${id}: ${e.message}`);
    }
  }

  log(`Novos pacientes inseridos: ${inserted}/${novos.length}`);
}

/**
 * Faz upsert em pacientes_abc com agendamentos + pagamentos.
 * Conflict: paciente_id (UUID único).
 */
async function upsertAbcData(apptMap, payMap) {
  // Coleta todos os clinicorp_ids envolvidos
  const allIds = [...new Set([
    ...Object.keys(apptMap),
    ...Object.keys(payMap),
  ])].map(Number).filter(Boolean);

  if (!allIds.length) return;

  const uuidMap = await getPatientUuids(allIds);
  const now = new Date().toISOString();

  const rows = allIds
    .map(id => {
      const sid = String(id);
      const uid = uuidMap[sid];
      if (!uid) return null; // paciente não encontrado — pula

      const appt = apptMap[sid] || {};
      const pay  = payMap[sid]  || {};

      const ultVisita = appt.ultima_visita || null;

      return {
        paciente_id:       uid,
        clinicorp_id:      id,
        // Atualiza campos de agenda e pagamento; não sobrescreve ABC/receita
        ...(appt.ultima_visita   && { ultima_visita:    appt.ultima_visita }),
        ...(appt.proxima_consulta && { proxima_consulta: appt.proxima_consulta }),
        ...(appt.proximo_dentista && { proximo_dentista: appt.proximo_dentista }),
        ...(pay.ultimo_pagamento  && { ultimo_pagamento: pay.ultimo_pagamento }),
        ...(ultVisita             && { dias_sem_visita:  daysSince(ultVisita) }),
        ...(pay.nome              && { nome:             pay.nome }),
        ...(pay.telefone          && { telefone:         pay.telefone }),
        sincronizado_em: now,
      };
    })
    .filter(Boolean);

  if (!rows.length) return;

  // Processa em lotes de 500 para não exceder limites do Supabase
  const BATCH = 500;
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('pacientes_abc')
      .upsert(chunk, { onConflict: 'paciente_id', ignoreDuplicates: false });

    if (error) log(`ERRO upsert abc (batch ${i}): ${error.message}`);
    else       total += chunk.length;
  }

  log(`pacientes_abc atualizado: ${total} registros`);
}

// ─── funil comercial (Dashboard Comercial) ───────────────────────────────────

/**
 * Busca um endpoint da Clinicorp por janela, em fatias de <=30 dias
 * (estimates/list rejeita intervalos > 31 dias). Concatena todos os arrays.
 */
async function fetchRangeChunked(path, dias, chunkDias = 30) {
  const today = new Date();
  const all = [];
  for (let off = 0; off < dias; off += chunkDias) {
    const to   = new Date(today); to.setDate(to.getDate()   - off);
    const from = new Date(today); from.setDate(from.getDate() - Math.min(off + chunkDias, dias));
    const part = await api.get(path, { from: dateStr(from), to: dateStr(to) });
    if (Array.isArray(part)) all.push(...part);
  }
  return all;
}

/** Carrega config: avaliadores (id→nome) + StatusId que contam como compareceu. */
async function loadFunilConfig() {
  const [{ data: av }, { data: st }] = await Promise.all([
    supabase.from('config_avaliadores').select('nome, clinicorp_id').eq('ativo', true),
    supabase.from('config_status_compareceu').select('status_id').eq('compareceu', true),
  ]);
  const ids = new Set();
  const nomeById = new Map();
  for (const r of (av || [])) {
    const id = String(r.clinicorp_id || '');
    if (id) { ids.add(id); nomeById.set(id, r.nome || ''); }
  }
  const statusCompareceu = new Set((st || []).map(r => String(r.status_id)));
  return { ids, nomeById, statusCompareceu };
}

/**
 * Persiste avaliações (agendamentos dos dentistas avaliadores).
 * Filtra por Dentist_PersonId/ScheduleToId (a /appointment/list não traz nome).
 * compareceu = tem CheckinTime (mesmo sinal do syncComparecimentos) OU StatusId marcado.
 */
async function syncAvaliacoes(cfg) {
  log(`Buscando agendamentos do funil (${FUNIL_DIAS}d, fatias de 30d)...`);
  const arr = await fetchRangeChunked('/appointment/list', FUNIL_DIAS);

  const rows = [];
  const seen = new Set();
  for (const a of arr) {
    if ((a.Deleted || '') === 'X') continue;
    const dentId  = String(a.Dentist_PersonId || '');
    const schedId = String(a.ScheduleToId || '');
    const matchId = cfg.ids.has(dentId) ? dentId : (cfg.ids.has(schedId) ? schedId : null);
    if (!matchId) continue;

    const apptId = String(a.id || a.AppointmentId || '');
    if (!apptId || seen.has(apptId)) continue;
    seen.add(apptId);

    const statusId = String(a.StatusId || '');
    rows.push({
      clinicorp_appointment_id: apptId,
      paciente_clinicorp_id:    String(a.Patient_PersonId || ''),
      telefone:                 normalizarTelefone(a.MobilePhone || a.Phone),
      dentista_nome:            cfg.nomeById.get(matchId) || '',
      dentista_clinicorp_id:    matchId,
      data:                     toDate(a.date || a.Date),
      compareceu:               !!a.CheckinTime || cfg.statusCompareceu.has(statusId),
      status_raw:               statusId || null,
      agendado_em:              a.CreateDate || null,
      comparecimento_em:        a.CheckinTime ? new Date(Number(a.CheckinTime)).toISOString() : null,
      atualizado_em:            new Date().toISOString(),
    });
  }

  log(`Avaliações de avaliadores: ${rows.length}`);
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from('avaliacoes')
      .upsert(chunk, { onConflict: 'clinicorp_appointment_id' });
    if (error) log(`ERRO upsert avaliacoes: ${error.message}`);
  }
  return rows.length;
}

/** Persiste orçamentos (estimates) da janela. Dedup por id (fatias podem sobrepor). */
async function syncOrcamentos() {
  log(`Buscando orçamentos do funil (${FUNIL_DIAS}d, fatias de 30d)...`);
  const arr = await fetchRangeChunked('/estimates/list', FUNIL_DIAS);

  const byId = new Map();
  for (const o of arr) {
    const id = String(o.id || '');
    if (!id || id === 'undefined') continue;
    const { valorParticular, ehConvenio } = classificarOrcamento(o);
    byId.set(id, {
      clinicorp_estimate_id: id,
      treatment_id:          o.TreatmentId != null ? String(o.TreatmentId) : null,
      paciente_clinicorp_id: String(o.PatientId || ''),
      telefone:              normalizarTelefone(o.PatientMobilePhone),
      profissional_nome:     o.ProfessionalName || '',
      valor:                 Number(o.Amount || 0),
      valor_particular:      valorParticular,
      eh_convenio:           ehConvenio,
      status:                o.Status || null,
      data_criacao:          toDate(o.CreateDate),
      data_fechamento:       o.Status === 'APPROVED' ? toDate(o.LastChange_Date) : null,
      atualizado_em:         new Date().toISOString(),
    });
  }
  const rows = [...byId.values()];

  log(`Orçamentos: ${rows.length}`);
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from('orcamentos')
      .upsert(chunk, { onConflict: 'clinicorp_estimate_id' });
    if (error) log(`ERRO upsert orcamentos: ${error.message}`);
  }
  return rows.length;
}

/** Liga avaliações/orçamentos a leads por telefone normalizado (1 update por lead/tabela). */
async function vincularLeads() {
  const { data: leads } = await supabase.from('leads').select('id, telefone');
  const mapa = new Map(); // telefone → lead_id
  for (const l of (leads || [])) {
    const t = normalizarTelefone(l.telefone);
    if (t && !mapa.has(t)) mapa.set(t, l.id);
  }
  if (!mapa.size) { log('vincularLeads: nenhum lead com telefone'); return 0; }

  let n = 0;
  for (const [t, lid] of mapa) {
    for (const tabela of ['avaliacoes', 'orcamentos']) {
      const { data, error } = await supabase.from(tabela)
        .update({ lead_id: lid }).eq('telefone', t).is('lead_id', null).select('telefone');
      if (!error && data) n += data.length;
    }
  }
  log(`vincularLeads: ${n} linhas ligadas a leads`);
  return n;
}

/** Casa a entrada (1º pagamento do paciente a partir da data do orçamento) nos orçamentos aprovados particulares. */
async function syncEntradas() {
  log(`Buscando pagamentos do funil (${FUNIL_DIAS}d) para casar entradas...`);
  const pays = await fetchRangeChunked('/payment/list', FUNIL_DIAS);

  // mapa paciente → pagamentos ordenados por data asc
  const byPat = new Map();
  for (const p of pays) {
    const pid  = String(p.PatientId || p.patientId || '');
    const data = toDate(p.ReceivedDate || p.CheckOutDate || p.PaymentDate || p.Date);
    const valor = Number(p.Amount ?? p.PaidValue ?? p.Value ?? p.TotalPaid ?? 0);
    if (!pid || !data) continue;
    if (!byPat.has(pid)) byPat.set(pid, []);
    byPat.get(pid).push({ data, valor });
  }
  for (const arr of byPat.values()) arr.sort((a, b) => (a.data < b.data ? -1 : 1));

  // orçamentos aprovados particulares → casar 1º pagamento >= data_criacao
  const { data: orcs } = await supabase.from('orcamentos')
    .select('clinicorp_estimate_id, paciente_clinicorp_id, data_criacao')
    .eq('status', 'APPROVED').gt('valor_particular', 0);

  let n = 0;
  for (const o of (orcs || [])) {
    const arr = byPat.get(String(o.paciente_clinicorp_id)) || [];
    const entrada = arr.find(p => p.data >= o.data_criacao);
    if (!entrada) continue;
    const { error } = await supabase.from('orcamentos')
      .update({ entrada_valor: entrada.valor, entrada_data: entrada.data })
      .eq('clinicorp_estimate_id', o.clinicorp_estimate_id);
    if (!error) n++;
  }
  log(`Entradas casadas: ${n}`);
  return n;
}

function addDias(dateStr, dias) {
  const d = new Date(dateStr); d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

// Marca avaliacoes.tem_orcamento = paciente tem orçamento PARTICULAR criado em [data, data+60d].
async function marcarAvaliacoesComOrcamento() {
  const { data: orcs } = await supabase.from('orcamentos')
    .select('paciente_clinicorp_id, data_criacao').gt('valor_particular', 0);
  const byPat = new Map();
  for (const o of (orcs || [])) {
    if (!byPat.has(o.paciente_clinicorp_id)) byPat.set(o.paciente_clinicorp_id, []);
    byPat.get(o.paciente_clinicorp_id).push(o.data_criacao);
  }

  const { data: avals } = await supabase.from('avaliacoes')
    .select('clinicorp_appointment_id, paciente_clinicorp_id, data');

  const updates = [];
  for (const a of (avals || [])) {
    const datas = byPat.get(a.paciente_clinicorp_id) || [];
    const limite = a.data ? addDias(a.data, 60) : null;
    const tem = !!(a.data && datas.some(d => d >= a.data && d <= limite));
    updates.push({ clinicorp_appointment_id: a.clinicorp_appointment_id, tem_orcamento: tem });
  }

  const validas = updates.filter(u => u.tem_orcamento).length;
  for (let i = 0; i < updates.length; i += 500) {
    const chunk = updates.slice(i, i + 500);
    const { error } = await supabase.from('avaliacoes')
      .upsert(chunk, { onConflict: 'clinicorp_appointment_id' });
    if (error) log(`ERRO upsert tem_orcamento: ${error.message}`);
  }
  log(`Avaliações válidas (com orçamento): ${validas}/${updates.length}`);
  return validas;
}

// ─── entrada principal ───────────────────────────────────────────────────────

async function runSync() {
  const start = Date.now();
  log('══════════ SYNC CLINICORP INICIADO ══════════');

  const result = { ok: false, steps: {}, duration_s: 0 };

  try {
    // Fase 1: agendamentos (2 requisições)
    const apptMap = await fetchAppointments();
    result.steps.agendamentos = Object.keys(apptMap).length;

    // Fase 2: pagamentos (1 requisição)
    const payMap = await fetchPayments();
    result.steps.pagamentos = Object.keys(payMap).length;

    // Fase 3: orçamentos (1 requisição)
    const estimateIds = await fetchEstimates();
    result.steps.orcamentos_abertos = estimateIds.size;

    // Fase 4: inserir novos pacientes detectados
    await insertNewPatients(payMap);

    // Fase 5: upsert em pacientes_abc
    await upsertAbcData(apptMap, payMap);

    // Fase 6: funil comercial (avaliações)
    const funilCfg = await loadFunilConfig();
    result.steps.avaliacoes_funil = await syncAvaliacoes(funilCfg);

    // Fase 7: funil comercial (orçamentos)
    result.steps.orcamentos_funil = await syncOrcamentos();

    // Fase 8: vincular avaliações/orçamentos a leads (por telefone)
    result.steps.leads_vinculados = await vincularLeads();

    // Fase 9: entradas (1º pagamento)
    result.steps.entradas = await syncEntradas();

    // Fase 10: marcar avaliações válidas (com orçamento particular em 60d)
    result.steps.avaliacoes_validas = await marcarAvaliacoesComOrcamento();

    result.ok        = true;
    result.req_count = api.reqCount; // requisições feitas nesta hora
  } catch (err) {
    log(`ERRO FATAL: ${err.message}`);
    result.error = err.message;
  }

  result.duration_s = parseFloat(((Date.now() - start) / 1000).toFixed(1));
  log(`══════════ SYNC ${result.ok ? 'CONCLUÍDO' : 'FALHOU'} em ${result.duration_s}s ══════════`);
  return result;
}

// Chamada direta: node sync/clinicorp-sync.js
if (require.main === module) {
  runSync().then(r => process.exit(r.ok ? 0 : 1));
}

module.exports = { runSync, loadFunilConfig, syncAvaliacoes, syncOrcamentos, vincularLeads, syncEntradas, marcarAvaliacoesComOrcamento };
