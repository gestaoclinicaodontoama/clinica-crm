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
const { planejarNovosPacientes } = require('../lib/sync/planejar-novos-pacientes');
const { classificarOrcamento } = require('../lib/funil/orcamento');
const { classificar, normalizarNome } = require('../lib/prevencao/classificacao');

const FUNIL_DIAS = 180; // janela de coleta do funil comercial

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const api = new ClinicorpApi({
  user:         process.env.CLINICORP_USER,
  token:        process.env.CLINICORP_TOKEN,
  subscriberId: process.env.CLINICORP_SUBSCRIBER_ID,
  businessId:   process.env.CLINICORP_BUSINESS_ID,
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

  // Captura nome+telefone do agendamento (a /appointment/list já traz) — usado para
  // inserir no cadastro `pacientes` quem agendou/compareceu mas ainda não pagou.
  const capturarContato = (a, id) => {
    if (!byId[id].nome && (a.PatientName || a.patientName)) byId[id].nome = a.PatientName || a.patientName;
    if (!byId[id].telefone && (a.MobilePhone || a.Phone)) byId[id].telefone = a.MobilePhone || a.Phone;
  };

  for (const a of pastArr) {
    const id   = a.PatientId || a.patientId || a.Patient_PersonId;
    if (!id) continue;
    const date = toDate(a.Date || a.date || a.AppointmentDate || a.ScheduleDate);
    if (!byId[id]) byId[id] = {};
    capturarContato(a, id);
    if (date && (!byId[id].ultima_visita || date > byId[id].ultima_visita)) {
      byId[id].ultima_visita = date;
    }
  }

  for (const a of futureArr) {
    const id   = a.PatientId || a.patientId || a.Patient_PersonId;
    if (!id) continue;
    const date = toDate(a.Date || a.date || a.AppointmentDate || a.ScheduleDate);
    const doc  = a.ProfessionalName || a.professionalName || a.DoctorName || '';
    if (!byId[id]) byId[id] = {};
    capturarContato(a, id);
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
  // A Clinicorp passou a exigir data inicial (from). Janela ampla (180d) pois
  // este número é só métrica de "orçamentos em aberto" — não alimenta a Conferência.
  const today  = new Date();
  const past180 = new Date(today); past180.setDate(past180.getDate() - FUNIL_DIAS);
  const estimates = await api.get('/patient/list_estimates', { from: dateStr(past180), to: dateStr(today) });
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
 * Insere pacientes NOVOS no cadastro a partir de pagamentos E agendamentos.
 * - Pagamentos: enriquece via /patient/get (nascimento, email, etc.).
 * - Agendamentos (quem agendou/compareceu mas ainda NÃO pagou): insere direto com
 *   nome+telefone que a /appointment/list já retorna — barato, sem chamada extra.
 * Conserta o buraco em que leads convertidos (avaliação/comparecimento) nunca entravam
 * no cadastro e por isso não casavam com o lead (match por telefone).
 */
async function insertNewPatients(payMap, apptMap = {}) {
  const unionIds = [...new Set([...Object.keys(payMap), ...Object.keys(apptMap)])].map(Number);
  if (!unionIds.length) return;

  // Quais já existem (chunked — o .in() não deve receber listas gigantes).
  const existingSet = new Set();
  for (let i = 0; i < unionIds.length; i += 500) {
    const { data } = await supabase.from('pacientes')
      .select('clinicorp_id').in('clinicorp_id', unionIds.slice(i, i + 500));
    (data || []).forEach(r => existingSet.add(String(r.clinicorp_id)));
  }

  const { viaPagamento, viaAgendamento } = planejarNovosPacientes(payMap, apptMap, existingSet);

  // 1) Agendamento-only: insert direto em lote (nome+telefone já vêm do agendamento).
  if (viaAgendamento.length) {
    const rows = viaAgendamento.map(p => ({
      clinicorp_id:     p.clinicorp_id,
      nome:             p.nome || `Paciente ${p.clinicorp_id}`,
      telefone_celular: p.telefone || null,
      inserido_em:      new Date().toISOString(),
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('pacientes')
        .upsert(rows.slice(i, i + 500), { onConflict: 'clinicorp_id', ignoreDuplicates: true });
      if (error) log(`ERRO insert agendamento-only: ${error.message}`);
    }
    log(`Pacientes novos de agendamento (ainda sem pagar): ${rows.length}`);
  }

  // 2) Pagamento: enriquece via /patient/get (com fallback nos dados do pagamento).
  if (!viaPagamento.length) { log('Nenhum paciente novo via pagamento'); return; }
  log(`${viaPagamento.length} pacientes novos via pagamento — buscando dados via /patient/get...`);

  const today = new Date().toISOString().slice(0, 10);
  let inserted = 0;
  for (const idStr of viaPagamento) {
    const id = Number(idStr);
    try {
      // Cada /patient/get consome 1 requisição — o rate limiter pausa automaticamente
      const p = await api.get('/patient/get', { id: String(id) });
      if (!p || !p.Name) {
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

  log(`Novos pacientes via pagamento inseridos: ${inserted}/${viaPagamento.length}`);
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

/** Lê TODAS as linhas de uma tabela (o client Supabase limita a 1000 por select). */
async function selectAll(table, columns, filtro) {
  const all = [];
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    let q = supabase.from(table).select(columns).range(offset, offset + PAGE - 1);
    if (filtro) q = filtro(q);
    const { data, error } = await q;
    if (error) { log(`ERRO selectAll ${table}: ${error.message}`); break; }
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
    offset += PAGE;
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
      paciente_nome:         o.PatientName || '',
      clinicorp_lastchange:  o.LastChange_Date || null,
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

/** Liga avaliações/orçamentos/pacientes_sucesso a leads pela chave de telefone (RPC vincular_leads_funil).
 *  Roda inteiro no Postgres: casa formatos mistos (DDI/9º dígito) e não sofre o limite de 1000 linhas do client. */
async function vincularLeads() {
  const { data, error } = await supabase.rpc('vincular_leads_funil');
  if (error) { log(`ERRO vincularLeads: ${error.message}`); return 0; }
  const n = (data?.avaliacoes || 0) + (data?.orcamentos || 0) + (data?.pacientes_sucesso || 0);
  log(`vincularLeads: ${n} linhas ligadas (aval ${data?.avaliacoes || 0}, orc ${data?.orcamentos || 0}, pac_sucesso ${data?.pacientes_sucesso || 0})`);
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
  const orcs = await selectAll('orcamentos', 'clinicorp_estimate_id, paciente_clinicorp_id, data_criacao',
    q => q.eq('status', 'APPROVED').gt('valor_particular', 0));

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

const PRODUCAO_DIAS = 90;

async function syncProducao() {
  // Carrega catálogo de procedimentos uma vez (cache por sessão de sync)
  // Clinicorp exige from/to em */list; usa janela ampla para cobrir todos os procedimentos
  const hoje = new Date().toISOString().slice(0, 10);
  const catalogRaw = await api.get('/procedures/list', { from: '2020-01-01', to: hoje });
  const catalog = new Map();
  // API retorna { "NomeTabelaPreco": [{id, ProcedureName, ...}], ... }
  const allProcs = Array.isArray(catalogRaw) ? catalogRaw : Object.values(catalogRaw).flat();
  for (const p of allProcs) {
    if (p.id) catalog.set(String(p.id), p.ProcedureName || p.Name || '');
  }

  const estimates = await fetchRangeChunked('/estimates/list', PRODUCAO_DIAS);

  const rows = [];
  for (const est of estimates) {
    const estId = String(est.id || est.EstimateId || '');
    if (!estId) continue;
    const procs = est.ProcedureList || est.procedureList || [];
    for (const p of procs) {
      if (p.Executed !== 'X') continue;
      const amount = Number(p.Amount ?? 0);
      if (amount <= 0) continue;
      const priceId = p.PriceId ? String(p.PriceId) : null;
      rows.push({
        clinicorp_estimate_id:  estId,
        clinicorp_treatment_id: est.TreatmentId ? String(est.TreatmentId) : null,
        price_id:               priceId,
        procedure_name:         priceId ? (catalog.get(priceId) || '') : '',
        specialty_id:           p.SpecialtyId ? String(p.SpecialtyId) : null,
        dentist_person_id:      p.Dentist_PersonId ? String(p.Dentist_PersonId) : null,
        dentist_name:           p.ProfessionalName || p.DentistName || null,
        executed_date:          p.ExecutedDate ? p.ExecutedDate.slice(0, 10) : null,
        amount,
        bill_type:              p.BillType || null,
        paciente_nome:          est.PatientName || null,
        atualizado_em:          new Date().toISOString(),
      });
    }
  }

  // Filtra linhas sem executed_date (dado inválido da Clinicorp)
  const valid = rows.filter(r => r.executed_date);

  // Deduplica pelo mesmo critério da coluna gerada no Postgres:
  // dedup_key = clinicorp_estimate_id|price_id|epoch(executed_date)|dentist_person_id
  const seenKeys = new Set();
  const deduped = [];
  for (const r of valid) {
    const epoch = Math.floor(new Date(r.executed_date).getTime() / 1000);
    const key = `${r.clinicorp_estimate_id}|${r.price_id || ''}|${epoch}|${r.dentist_person_id || ''}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      deduped.push(r);
    }
  }

  let count = 0;
  for (let i = 0; i < deduped.length; i += 500) {
    const chunk = deduped.slice(i, i + 500);
    // onConflict usa a coluna gerada 'dedup_key' (UNIQUE CONSTRAINT normal)
    const { error } = await supabase.from('producao_procedimentos').upsert(chunk, {
      onConflict: 'dedup_key',
      ignoreDuplicates: false,
    });
    if (error) log(`ERRO upsert producao (batch ${i}): ${error.message}`);
    else count += chunk.length;
  }

  log(`Produção: ${count} procedimentos upserted (${deduped.length} únicos de ${valid.length} válidos, ${rows.length} brutos)`);
  return { count };
}

const AGENDA_DIAS = 90;

async function syncAgenda() {
  function parseMinutes(t) {
    if (!t) return 0;
    const [h, m] = t.split(':').map(Number);
    return ((h || 0) * 60) + (m || 0);
  }

  const raw = await fetchRangeChunked('/appointment/list', AGENDA_DIAS);

  const rows = [];
  const seenIds = new Set();
  for (const a of raw) {
    const apptId = String(a.id || a.AppointmentId || '');
    if (!apptId || seenIds.has(apptId)) continue;
    seenIds.add(apptId);

    const apptDate = (a.date || a.Date || '').slice(0, 10);
    if (!apptDate) continue;

    const fromTime = a.fromTime || a.FromTime || null;
    const toTime   = a.toTime   || a.ToTime   || null;
    const dur = (fromTime && toTime)
      ? parseMinutes(toTime) - parseMinutes(fromTime)
      : null;

    rows.push({
      clinicorp_appt_id:  apptId,
      dentist_person_id:  a.Dentist_PersonId ? String(a.Dentist_PersonId) : null,
      dentist_name:       a.DentistName || a.ProfessionalName || null,
      patient_name:       a.PatientName || null,
      appointment_date:   apptDate,
      from_time:          fromTime,
      to_time:            toTime,
      duration_minutes:   (dur !== null && dur >= 0) ? dur : null,
      category:           a.CategoryDescription || null,
      checkin_time:       a.CheckinTime || null,
      deleted:            (a.Deleted || '') === 'X',
      atualizado_em:      new Date().toISOString(),
    });
  }

  let count = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from('agenda_appointments').upsert(chunk, {
      onConflict: 'clinicorp_appt_id',
      ignoreDuplicates: false,
    });
    if (error) log(`ERRO upsert agenda (batch ${i}): ${error.message}`);
    else count += chunk.length;
  }

  log(`Agenda: ${count} appointments upserted (${rows.length} válidos de ${raw.length} brutos)`);
  return { count };
}

function addDias(dateStr, dias) {
  const d = new Date(dateStr); d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

// Marca avaliacoes.tem_orcamento = paciente tem orçamento PARTICULAR criado em [data, data+60d].
async function marcarAvaliacoesComOrcamento() {
  const orcs = await selectAll('orcamentos', 'paciente_clinicorp_id, data_criacao',
    q => q.gt('valor_particular', 0));
  const byPat = new Map();
  for (const o of (orcs || [])) {
    if (!byPat.has(o.paciente_clinicorp_id)) byPat.set(o.paciente_clinicorp_id, []);
    byPat.get(o.paciente_clinicorp_id).push(o.data_criacao);
  }

  const avals = await selectAll('avaliacoes', 'clinicorp_appointment_id, paciente_clinicorp_id, data');

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

// Reabre (pendente) os aprovados cujo orçamento mudou no Clinicorp (LastChange_Date diferente do retrato).
async function reavaliarFechamentos() {
  const aprovados = await selectAll('orcamentos',
    'clinicorp_estimate_id, clinicorp_lastchange, revisao_ref_lastchange',
    q => q.eq('revisao_status', 'aprovado'));
  let n = 0;
  for (const o of aprovados) {
    const atual = o.clinicorp_lastchange ? new Date(o.clinicorp_lastchange).getTime() : null;
    const ref   = o.revisao_ref_lastchange ? new Date(o.revisao_ref_lastchange).getTime() : null;
    if (atual !== ref) {
      await supabase.from('orcamentos')
        .update({ revisao_status: 'pendente', revisao_notificado: false })
        .eq('clinicorp_estimate_id', o.clinicorp_estimate_id);
      n++;
    }
  }
  log(`Fechamentos reabertos (tratamento mudou): ${n}`);
  return n;
}

// Avisa os crc_comercial dos fechamentos pendentes ainda não notificados (uma notificação agregada).
async function notificarPendentes() {
  const pend = await selectAll('orcamentos', 'clinicorp_estimate_id',
    q => q.eq('status', 'APPROVED').gt('valor_particular', 0).not('data_fechamento', 'is', null)
          .eq('revisao_status', 'pendente').eq('revisao_notificado', false));
  if (!pend.length) { log('notificarPendentes: nenhum novo'); return 0; }

  const { data: crcs } = await supabase.from('profiles').select('id').contains('roles', ['crc_comercial']);
  const corpo = `${pend.length} fechamento(s) aguardando sua conferência`;
  const rows = (crcs || []).map(u => ({
    usuario_id: u.id, tipo: 'conferencia_pendente',
    titulo: '📋 Fechamentos para conferir', corpo,
    metadata: { url: '/comercial/conferencia/' },
  }));
  let notifOk = true;
  if (rows.length) {
    const { error } = await supabase.from('notificacoes').insert(rows);
    if (error) { log(`ERRO notificacoes: ${error.message}`); notifOk = false; }
  }

  // Só marca como notificado se o aviso realmente entrou (senão re-tenta no próximo sync).
  if (notifOk) {
    const ids = pend.map(p => p.clinicorp_estimate_id);
    for (let i = 0; i < ids.length; i += 500) {
      await supabase.from('orcamentos').update({ revisao_notificado: true })
        .in('clinicorp_estimate_id', ids.slice(i, i + 500));
    }
  }
  log(`notificarPendentes: ${pend.length} pendentes, ${rows.length} CRC avisados${notifOk ? '' : ' (FALHOU — não marcado)'}`);
  return pend.length;
}

// normaliza nome de paciente p/ casar producao_procedimentos ↔ pacientes (tira sufixo "(prontuário)").
function normPaciente(s) {
  return String(s || '').replace(/\s*\(\d+\)\s*$/, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Deriva a prevenção da producao_procedimentos (fonte com histórico COMPLETO, já
 * sincronizada — sem API, sem timeout). O estimates/list só retorna estimates recentes
 * e sub-coletava o histórico. Classifica adulto/infantil por nome, casa o paciente por
 * nome, reconstrói prevencao_eventos e recomputa os agregados em pacientes_abc.
 */
async function syncPrevencao() {
  const [procs, pacientes] = await Promise.all([
    selectAll('producao_procedimentos', 'procedure_name, executed_date, paciente_nome, dentist_name, bill_type'),
    selectAll('pacientes', 'id, clinicorp_id, nome'),
  ]);

  const byNome = new Map();
  for (const p of pacientes) {
    const k = normPaciente(p.nome);
    if (k && p.clinicorp_id != null && !byNome.has(k)) byNome.set(k, p);
  }

  const eventos = [];
  const naoClass = new Map();
  const seen = new Set();
  const aggByPac = new Map(); // paciente_id(UUID) → { clinicorp_id, adulto, infantil } — chave UUID evita imprecisão de bigint
  for (const pr of procs) {
    if (!pr.executed_date || !pr.procedure_name) continue;
    const categoria = classificar({ nome: pr.procedure_name, profissional: pr.dentist_name });
    if (!categoria) {
      const nn = normalizarNome(pr.procedure_name);
      if (nn) {
        const data = String(pr.executed_date).slice(0, 10);
        const cur = naoClass.get(nn) || { exemplo_nome: pr.procedure_name, expertise: null, ocorrencias: 0, ultima_vez: data };
        cur.ocorrencias++; if (data > cur.ultima_vez) cur.ultima_vez = data;
        naoClass.set(nn, cur);
      }
      continue;
    }
    const pac = byNome.get(normPaciente(pr.paciente_nome));
    if (!pac) continue; // sem paciente cadastrado correspondente
    const data = String(pr.executed_date).slice(0, 10);
    const cidStr = String(pac.clinicorp_id);
    const k = `${cidStr}|${data}|${categoria}`;
    if (!seen.has(k)) {
      seen.add(k);
      eventos.push({ clinicorp_id: cidStr, data, categoria, procedimento: pr.procedure_name, profissional: pr.dentist_name || null, bill_type: pr.bill_type || null });
    }
    const a = aggByPac.get(pac.id) || { clinicorp_id: cidStr, adulto: null, infantil: null, perio: null };
    if (data > (a[categoria] || '')) a[categoria] = data;
    aggByPac.set(pac.id, a);
  }

  // Tabela derivada: reconstrói do zero (producao é a fonte da verdade).
  await supabase.from('prevencao_eventos').delete().gte('id', 0);
  for (let i = 0; i < eventos.length; i += 500) {
    const { error } = await supabase.from('prevencao_eventos').insert(eventos.slice(i, i + 500));
    if (error) log(`ERRO insert prevencao_eventos: ${error.message}`);
  }

  // Agregados na pacientes_abc — upsert por paciente_id (único real); só toca as colunas
  // de prevenção (mantém classe/receita) e cria linha (classe=NULL) p/ quem só tem prevenção.
  const rows = [];
  for (const [paciente_id, a] of aggByPac) {
    const ultima = [a.adulto, a.infantil, a.perio].filter(Boolean).sort().slice(-1)[0] || null;
    rows.push({
      paciente_id, clinicorp_id: a.clinicorp_id,
      ultima_prevencao: ultima,
      ultima_prevencao_adulto: a.adulto,
      ultima_prevencao_infantil: a.infantil,
      ultima_prevencao_perio: a.perio,
      perio: a.perio != null,
      dias_sem_prevencao: ultima ? daysSince(ultima) : null,
    });
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('pacientes_abc')
      .upsert(rows.slice(i, i + 500), { onConflict: 'paciente_id' });
    if (error) log(`ERRO upsert prevencao em pacientes_abc: ${error.message}`);
  }
  log(`Prevenção: ${eventos.length} eventos, ${rows.length} pacientes agregados (de ${procs.length} procedimentos)`);

  const naoRows = [...naoClass.entries()].map(([nome_norm, v]) => ({ nome_norm, ...v, atualizado_em: new Date().toISOString() }));
  for (let i = 0; i < naoRows.length; i += 500) {
    await supabase.from('prevencao_nao_classificados').upsert(naoRows.slice(i, i + 500), { onConflict: 'nome_norm' });
  }

  return { eventos: eventos.length, pacientes: rows.length, nao_classificados: naoRows.length };
}

// ─── entrada principal ───────────────────────────────────────────────────────

async function runSync(trigger = 'agendado') {
  const start = Date.now();
  log(`══════════ SYNC CLINICORP INICIADO (${trigger}) ══════════`);

  const result = { ok: false, steps: {}, duration_s: 0 };

  // Registra o início (observabilidade + base do scheduler self-healing).
  let logId = null;
  try {
    const { data } = await supabase.from('sync_log')
      .insert({ trigger, started_at: new Date().toISOString() })
      .select('id').single();
    logId = data?.id ?? null;
  } catch (e) { log(`sync_log insert falhou: ${e.message}`); }

  // Cada fase é isolada: uma falha (ex.: um endpoint da Clinicorp fora do ar)
  // NÃO derruba as demais. Antes, um erro na 1ª fase abortava o sync inteiro e
  // travava orçamentos/avaliações/entradas — que usam outros endpoints.
  const erros = [];
  async function step(nome, fn, fallback) {
    try { return await fn(); }
    catch (err) {
      log(`ERRO na fase "${nome}": ${err.message}`);
      erros.push(`${nome}: ${err.message}`);
      result.steps[nome] = `erro: ${err.message.slice(0, 160)}`;
      return fallback;
    }
  }

  // Fase 1: agendamentos (2 requisições)
  const apptMap = await step('agendamentos', async () => {
    const m = await fetchAppointments();
    result.steps.agendamentos = Object.keys(m).length;
    return m;
  }, {});

  // Fase 2: pagamentos (1 requisição)
  const payMap = await step('pagamentos', async () => {
    const m = await fetchPayments();
    result.steps.pagamentos = Object.keys(m).length;
    return m;
  }, {});

  // Fase 3: orçamentos em aberto (1 requisição)
  await step('orcamentos_abertos', async () => {
    const ids = await fetchEstimates();
    result.steps.orcamentos_abertos = ids.size;
  });

  // Fase 4: inserir novos pacientes detectados
  await step('novos_pacientes', () => insertNewPatients(payMap, apptMap));

  // Fase 5: upsert em pacientes_abc
  await step('pacientes_abc', () => upsertAbcData(apptMap, payMap));

  // Fase 6: funil comercial (avaliações)
  const funilCfg = await step('funil_config', () => loadFunilConfig(),
    { ids: new Set(), nomeById: new Map(), statusCompareceu: new Set() });
  await step('avaliacoes_funil', async () => { result.steps.avaliacoes_funil = await syncAvaliacoes(funilCfg); });

  // Fase 7: funil comercial (orçamentos) — alimenta a Conferência
  await step('orcamentos_funil', async () => { result.steps.orcamentos_funil = await syncOrcamentos(); });

  // Fase 7b: produção realizada (ProcedureList Executed=X, janela 90d)
  await step('producao', async () => {
    const r = await syncProducao();
    result.steps.producao = r.count;
  });

  // Fase 7d: prevenção realizada (estimates Executed=X, classificada)
  await step('prevencao', async () => {
    const r = await syncPrevencao();
    result.steps.prevencao = r.eventos;
  });

  // Fase 7c: agenda de consultas (para análise por dentista, janela 90d)
  await step('agenda', async () => {
    const r = await syncAgenda();
    result.steps.agenda = r.count;
  });

  // Fase 8: vincular avaliações/orçamentos a leads (por telefone)
  await step('leads_vinculados', async () => { result.steps.leads_vinculados = await vincularLeads(); });

  // Fase 9: entradas (1º pagamento)
  await step('entradas', async () => { result.steps.entradas = await syncEntradas(); });

  // Fase 10: marcar avaliações válidas (com orçamento particular em 60d)
  await step('avaliacoes_validas', async () => { result.steps.avaliacoes_validas = await marcarAvaliacoesComOrcamento(); });

  // Fase 11: reabrir aprovados cujo tratamento mudou
  await step('fechamentos_reabertos', async () => { result.steps.fechamentos_reabertos = await reavaliarFechamentos(); });

  // Fase 12: notificar CRC dos pendentes novos
  await step('pendentes_notificados', async () => { result.steps.pendentes_notificados = await notificarPendentes(); });

  result.ok        = erros.length === 0;
  result.req_count = api.reqCount; // requisições feitas nesta hora
  if (erros.length) result.error = erros.join(' | ');

  result.duration_s = parseFloat(((Date.now() - start) / 1000).toFixed(1));
  log(`══════════ SYNC ${result.ok ? 'CONCLUÍDO' : 'FALHOU'} em ${result.duration_s}s ══════════`);

  if (logId != null) {
    try {
      await supabase.from('sync_log').update({
        finished_at: new Date().toISOString(),
        ok: result.ok,
        duration_s: result.duration_s,
        steps: result.steps,
        error: result.error || null,
      }).eq('id', logId);
    } catch (e) { log(`sync_log update falhou: ${e.message}`); }
  }

  return result;
}

// Chamada direta: node sync/clinicorp-sync.js
if (require.main === module) {
  runSync().then(r => process.exit(r.ok ? 0 : 1));
}

module.exports = { runSync, loadFunilConfig, syncAvaliacoes, syncOrcamentos, vincularLeads, syncEntradas, syncProducao, syncAgenda, marcarAvaliacoesComOrcamento, reavaliarFechamentos, notificarPendentes, syncPrevencao };
