// ============================================================
//  CRM CLÍNICA — Servidor Node.js
//  Pipeline: Lead → Agendado → Compareceu → Em Avaliação
//            → Orçamento Enviado → Fechou / Perdido
// ============================================================

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { JSONFilePreset } = require('lowdb/node');
const totalvoice = require('./totalvoice');
const whatsapp = require('./whatsapp');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || '5531999999999').replace(/\D/g, '');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'clinica.db.json');

const FUNIL = ['Lead', 'Agendado', 'Compareceu', 'Em Avaliação', 'Orçamento Enviado', 'Fechou', 'Perdido'];

// --------- DB ---------
let db;
async function initDb() {
  db = await JSONFilePreset(DB_PATH, {
    leads: [],
    chamadas: [],
    mensagens: [],
    nextId: 1,
    nextChamadaId: 1,
    nextMensagemId: 1,
  });
  if (!db.data.chamadas) db.data.chamadas = [];
  if (!db.data.mensagens) db.data.mensagens = [];
  if (!db.data.nextChamadaId) db.data.nextChamadaId = 1;
  if (!db.data.nextMensagemId) db.data.nextMensagemId = 1;
  await db.write();
  console.log(`✅ Banco: ${db.data.leads.length} leads, ${db.data.chamadas.length} chamadas, ${db.data.mensagens.length} msgs`);
}

// --------- HELPERS ---------
function mapOrigem(src = '', medium = '') {
  const s = String(src).toLowerCase().trim();
  const m = String(medium).toLowerCase().trim();
  if (s === 'instagram' || s === 'facebook' || s === 'fb' || s === 'ig') {
    return (m === 'cpc' || m === 'paid' || m === 'ads') ? 'Meta Ads' : 'Orgânico';
  }
  if (s === 'google') {
    return (m === 'cpc' || m === 'paid' || m === 'ads') ? 'Google Ads' : 'Orgânico';
  }
  const map = {
    meta: 'Meta Ads', adwords: 'Google Ads',
    organico: 'Orgânico', organic: 'Orgânico', seo: 'Orgânico',
    indicacao: 'Indicação', 'indicação': 'Indicação', whatsapp: 'Indicação', referral: 'Indicação',
  };
  return map[s] || (s ? 'Outros' : 'Direto');
}
function nowLocal() {
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function sanitizeStr(v, max = 200) {
  if (v === null || v === undefined) return '';
  return String(v).slice(0, max);
}
const sha256 = v => v ? crypto.createHash('sha256').update(String(v).toLowerCase().trim()).digest('hex') : null;

// --------- APP ---------
const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));

// ========== CAPTURAR LEAD (link de anúncio) ==========
app.get('/lead', async (req, res) => {
  try {
    const nome = sanitizeStr(req.query.name) || 'Lead sem nome';
    const telefone = sanitizeStr(req.query.phone, 30).replace(/\D/g, '');
    const email = sanitizeStr(req.query.email, 100);
    const origem = mapOrigem(req.query.utm_source, req.query.utm_medium);
    const campanha = sanitizeStr(req.query.utm_campaign);
    const conteudo = sanitizeStr(req.query.utm_content);
    const fbclid = sanitizeStr(req.query.fbclid, 500);
    const gclid = sanitizeStr(req.query.gclid, 500);
    const ctwa_clid = sanitizeStr(req.query.ctwa_clid, 500);

    // Detectar duplicado (mesmo telefone)
    let lead = telefone ? db.data.leads.find(l => l.telefone === telefone) : null;
    if (lead) {
      // Atualiza dados de rastreamento sem perder histórico
      lead.observacoes_sistema = (lead.observacoes_sistema || '') +
        `\n[${nowLocal()}] Reentrou via ${origem}/${campanha}`;
      lead.atualizado_em = nowLocal();
      await db.write();
      console.log(`♻️  Lead reentrou #${lead.id} — ${nome}`);
    } else {
      lead = {
        id: db.data.nextId++,
        nome, telefone, email,
        origem, campanha, conteudo, fbclid, gclid, ctwa_clid,
        status: 'Lead',
        valor: null,
        tipo_trat: '',
        // Anotações segmentadas por etapa
        notas_sdr: '',
        notas_avaliacao: '',
        notas_comercial: '',
        // Avaliação SDR
        score_interesse: null, // 0-10
        perfil_disc: '',       // D, I, S, C
        etiquetas: [],
        proximo_contato: null,
        ultimo_contato: null,
        data_lead: nowLocal(),
        data_agendamento: null,
        data_comparecimento: null,
        data_avaliacao: null,
        data_orcamento: null,
        data_fechamento: null,
        enviado_meta: false,
        enviado_google: false,
        eventos_meta_enviados: [],
        criado_em: nowLocal(),
        atualizado_em: nowLocal(),
      };
      db.data.leads.push(lead);
      await db.write();
      console.log(`✅ Lead #${lead.id} — ${nome} via ${origem} | ${campanha || '(sem campanha)'}`);
    }

    const msg = encodeURIComponent('Olá! Vim do anúncio e gostaria de mais informações.');
    res.redirect(302, `https://wa.me/${WHATSAPP_NUMBER}?text=${msg}`);
  } catch (e) {
    console.error('❌ Erro lead:', e);
    res.status(500).send('Erro ao processar lead');
  }
});

// ========== API: LEADS ==========
app.get('/api/leads', (req, res) => {
  const { status, origem, q, etiqueta } = req.query;
  let r = [...db.data.leads];
  if (status) r = r.filter(l => l.status === status);
  if (origem) r = r.filter(l => l.origem === origem);
  if (etiqueta) r = r.filter(l => (l.etiquetas || []).includes(etiqueta));
  if (q) {
    const qq = String(q).toLowerCase();
    r = r.filter(l =>
      (l.nome || '').toLowerCase().includes(qq) ||
      (l.telefone || '').toLowerCase().includes(qq) ||
      (l.campanha || '').toLowerCase().includes(qq)
    );
  }
  r.sort((a, b) => b.id - a.id);
  res.json(r);
});

app.get('/api/leads/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
  const lead = db.data.leads.find(l => l.id === id);
  if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
  res.json(lead);
});

// PATCH genérico — aceita qualquer campo do lead
app.patch('/api/leads/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const lead = db.data.leads.find(l => l.id === id);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    const leadAntes = { status: lead.status };  // snapshot pra detectar mudanças

    const ALLOWED = [
      'nome','telefone','email','status','valor','tipo_trat',
      'notas_sdr','notas_avaliacao','notas_comercial',
      'score_interesse','perfil_disc','etiquetas',
      'proximo_contato','ultimo_contato','obs',
    ];

    const agora = nowLocal();
    for (const k of Object.keys(req.body)) {
      if (!ALLOWED.includes(k)) continue;
      let v = req.body[k];

      if (k === 'status') {
        if (!FUNIL.includes(v)) return res.status(400).json({ error: `Status inválido. Use: ${FUNIL.join(', ')}` });
        // Marcar timestamps automáticos
        if (v === 'Agendado' && !lead.data_agendamento) lead.data_agendamento = agora;
        if (v === 'Compareceu' && !lead.data_comparecimento) lead.data_comparecimento = agora;
        if (v === 'Em Avaliação' && !lead.data_avaliacao) lead.data_avaliacao = agora;
        if (v === 'Orçamento Enviado' && !lead.data_orcamento) lead.data_orcamento = agora;
        if (v === 'Fechou' && !lead.data_fechamento) lead.data_fechamento = agora;
      }
      if (k === 'valor') {
        v = (v === '' || v === null) ? null : parseFloat(v);
        if (v !== null && !Number.isFinite(v)) v = null;
      }
      if (k === 'score_interesse') {
        v = (v === '' || v === null) ? null : parseInt(v, 10);
        if (v !== null && (Number.isNaN(v) || v < 0 || v > 10)) v = null;
      }
      if (k === 'perfil_disc') {
        v = sanitizeStr(v, 4).toUpperCase();
        if (v && !['D','I','S','C'].includes(v)) v = '';
      }
      if (k === 'etiquetas') {
        if (!Array.isArray(v)) v = [];
        v = v.slice(0, 20).map(x => sanitizeStr(x, 50)).filter(Boolean);
      }
      if (typeof v === 'string') v = sanitizeStr(v, 4000);

      lead[k] = v;
    }
    lead.atualizado_em = agora;
    await db.write();

    // Disparar conversões em qualquer mudança de status do funil
    // Eventos enviados: LeadSubmitted, Schedule, Contact, Purchase
    // Sem duplicação: cada evento só dispara 1 vez por lead
    const statusMudou = req.body.status && req.body.status !== leadAntes.status;
    if (statusMudou) {
      const evtNome = EVENTOS_FUNIL[lead.status];
      const jaEnviou = (lead.eventos_meta_enviados || []).includes(evtNome);
      if (evtNome && !jaEnviou) {
        dispararConversaoMeta(lead).catch(e => console.error('Meta CAPI:', e.message));
      }
      // Google Ads: só dispara no Purchase (offline conversions)
      if (lead.status === 'Fechou' && lead.gclid && !lead.enviado_google) {
        dispararConversaoGoogle(lead).catch(e => console.error('Google:', e.message));
      }
    }

    res.json({ ok: true, lead });
  } catch (e) {
    console.error('❌ PATCH:', e);
    res.status(500).json({ error: e.message });
  }
});

// Backward-compat: rota /status antiga
app.patch('/api/leads/:id/status', async (req, res) => {
  req.url = `/api/leads/${req.params.id}`;
  app._router.handle(req, res);
});

// CRIAR LEAD MANUAL (do CRM)
app.post('/api/leads', async (req, res) => {
  try {
    const { nome, telefone, email, origem, observacoes } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
    const lead = {
      id: db.data.nextId++,
      nome: sanitizeStr(nome),
      telefone: sanitizeStr(telefone, 30).replace(/\D/g, ''),
      email: sanitizeStr(email, 100),
      origem: sanitizeStr(origem || 'Direto'),
      campanha: '', conteudo: '', fbclid: '', gclid: '',
      status: 'Lead', valor: null, tipo_trat: '',
      notas_sdr: sanitizeStr(observacoes || '', 4000),
      notas_avaliacao: '', notas_comercial: '',
      score_interesse: null, perfil_disc: '',
      etiquetas: [], proximo_contato: null, ultimo_contato: null,
      data_lead: nowLocal(),
      data_agendamento: null, data_comparecimento: null,
      data_avaliacao: null, data_orcamento: null, data_fechamento: null,
      enviado_meta: false, enviado_google: false,
      criado_em: nowLocal(), atualizado_em: nowLocal(),
    };
    db.data.leads.push(lead);
    await db.write();
    res.json({ ok: true, lead });
  } catch (e) {
    console.error('❌ POST:', e);
    res.status(500).json({ error: e.message });
  }
});

// ========== STATS ==========
app.get('/api/stats', (req, res) => {
  const leads = db.data.leads;
  const total = leads.length;
  const porStatus = FUNIL.map(s => ({ status: s, n: leads.filter(l => l.status === s).length }));
  const origens = [...new Set(leads.map(l => l.origem))];
  const porOrigem = origens.map(o => {
    const arr = leads.filter(l => l.origem === o);
    const fechados = arr.filter(l => l.status === 'Fechou');
    return {
      origem: o, n: arr.length, fechados: fechados.length,
      receita: fechados.reduce((s, l) => s + (l.valor || 0), 0),
    };
  }).sort((a, b) => b.n - a.n);
  const fechados = leads.filter(l => l.status === 'Fechou' && l.valor);
  const receita = fechados.reduce((s, l) => s + l.valor, 0);
  const ticketMedio = fechados.length ? receita / fechados.length : 0;
  const oportunidade = leads
    .filter(l => ['Agendado','Compareceu','Em Avaliação','Orçamento Enviado'].includes(l.status))
    .reduce((s, l) => s + (l.valor || 0), 0);
  const ultimosLeads = [...leads].sort((a, b) => b.id - a.id).slice(0, 10);
  res.json({ total, porStatus, porOrigem, receita, ticketMedio, oportunidade, ultimosLeads });
});

// ========== TELEFONIA ==========
app.post('/api/leads/:id/ligar', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const lead = db.data.leads.find(l => l.id === id);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (!lead.telefone) return res.status(400).json({ error: 'Lead sem telefone' });
    const { numeroSdr } = req.body;
    if (!numeroSdr) return res.status(400).json({ error: 'numeroSdr obrigatório' });
    if (!totalvoice.temToken()) return res.status(503).json({ error: 'TotalVoice não configurada' });

    const dados = await totalvoice.ligar({
      numeroSdr, numeroLead: lead.telefone, gravar: true,
      bina: process.env.TOTALVOICE_BINA,
    });
    const c = {
      id: db.data.nextChamadaId++,
      lead_id: lead.id, lead_nome: lead.nome,
      totalvoice_id: dados.id,
      numero_sdr: numeroSdr, numero_lead: lead.telefone,
      status: dados.status || 'iniciada',
      duracao_segundos: 0, url_gravacao: '',
      criada_em: nowLocal(),
    };
    db.data.chamadas.push(c);
    lead.ultimo_contato = nowLocal();
    await db.write();
    res.json({ ok: true, chamada: c });
  } catch (e) {
    console.error('❌ ligar:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/leads/:id/chamadas', (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.json(db.data.chamadas.filter(c => c.lead_id === id).sort((a,b) => b.id - a.id));
});

app.post('/webhooks/totalvoice', async (req, res) => {
  try {
    const e = req.body;
    const tvId = e.id || e.chamada_id || e.dados?.id;
    if (!tvId) return res.status(200).send('ok');
    const c = db.data.chamadas.find(x => x.totalvoice_id === tvId);
    if (!c) return res.status(200).send('ok');
    if (e.status) c.status = e.status;
    if (e.duracao_segundos !== undefined) c.duracao_segundos = e.duracao_segundos;
    if (e.url_gravacao) c.url_gravacao = e.url_gravacao;
    c.atualizada_em = nowLocal();
    await db.write();
    res.status(200).send('ok');
  } catch (e) {
    console.error('❌ webhook tv:', e);
    res.status(500).send('erro');
  }
});

// ========== WHATSAPP CLOUD API ==========
app.post('/api/leads/:id/whatsapp', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const lead = db.data.leads.find(l => l.id === id);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (!lead.telefone) return res.status(400).json({ error: 'Lead sem telefone' });
    if (!whatsapp.temToken()) return res.status(503).json({ error: 'WhatsApp Cloud API não configurada' });

    const { texto, templateName, variaveis } = req.body;
    let resultado;
    if (templateName) {
      resultado = await whatsapp.enviarTemplate({ para: lead.telefone, templateName, variaveis });
    } else {
      resultado = await whatsapp.enviarTexto({ para: lead.telefone, texto });
    }
    db.data.mensagens.push({
      id: db.data.nextMensagemId++,
      lead_id: lead.id, direcao: 'enviada',
      texto: texto || `[template:${templateName}]`,
      wa_id: resultado.messages?.[0]?.id || '',
      criada_em: nowLocal(),
    });
    lead.ultimo_contato = nowLocal();
    await db.write();
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ wa send:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/leads/:id/mensagens', (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.json(db.data.mensagens.filter(m => m.lead_id === id).sort((a,b) => a.id - b.id));
});

// Número 2 — broadcast de templates (confirmações, lembretes, follow-ups)
app.post('/api/leads/:id/broadcast', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const lead = db.data.leads.find(l => l.id === id);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (!lead.telefone) return res.status(400).json({ error: 'Lead sem telefone' });
    if (!whatsapp.temBroadcast()) return res.status(503).json({ error: 'Número de broadcast não configurado. Adicione WHATSAPP_BROADCAST_TOKEN e WHATSAPP_BROADCAST_PHONE_ID nas variáveis.' });

    const { templateName, variaveis = [], lang = 'pt_BR' } = req.body;
    if (!templateName) return res.status(400).json({ error: 'templateName obrigatório' });

    const resultado = await whatsapp.enviarBroadcast({ para: lead.telefone, templateName, variaveis, lang });
    db.data.mensagens.push({
      id: db.data.nextMensagemId++,
      lead_id: lead.id, direcao: 'enviada', canal: 'broadcast',
      texto: `[template: ${templateName}${variaveis.length ? ' | ' + variaveis.join(', ') : ''}]`,
      wa_id: resultado.messages?.[0]?.id || '',
      criada_em: nowLocal(),
    });
    lead.ultimo_contato = nowLocal();
    await db.write();
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ broadcast:', e);
    res.status(500).json({ error: e.message });
  }
});

// Lista templates disponíveis (retorna os do .env ou padrão)
app.get('/api/templates', (req, res) => {
  const lista = (process.env.WA_TEMPLATES || 'hello_world').split(',').map(t => t.trim()).filter(Boolean);
  res.json(lista);
});

// Webhook WhatsApp — verificação (Meta exige GET para validar URL)
app.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === whatsapp.verifyToken()) {
    console.log('✅ Webhook WhatsApp verificado');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Webhook WhatsApp — recebe mensagens
app.post('/webhooks/whatsapp', async (req, res) => {
  try {
    const m = whatsapp.parseMensagemRecebida(req.body);
    if (!m) return res.status(200).send('ok');
    let lead = db.data.leads.find(l => l.telefone === m.from);
    if (!lead) {
      lead = {
        id: db.data.nextId++,
        nome: m.nome || 'Lead WhatsApp',
        telefone: m.from, email: '',
        origem: 'WhatsApp Direto', campanha: '', conteudo: '', fbclid: '', gclid: '',
        status: 'Lead', valor: null, tipo_trat: '',
        notas_sdr: '', notas_avaliacao: '', notas_comercial: '',
        score_interesse: null, perfil_disc: '',
        etiquetas: [], proximo_contato: null, ultimo_contato: nowLocal(),
        data_lead: nowLocal(),
        data_agendamento: null, data_comparecimento: null,
        data_avaliacao: null, data_orcamento: null, data_fechamento: null,
        enviado_meta: false, enviado_google: false,
        criado_em: nowLocal(), atualizado_em: nowLocal(),
      };
      db.data.leads.push(lead);
      console.log(`✅ Novo lead via WA: ${m.nome} (${m.from})`);
    } else {
      lead.ultimo_contato = nowLocal();
    }
    db.data.mensagens.push({
      id: db.data.nextMensagemId++,
      lead_id: lead.id, direcao: 'recebida',
      texto: m.texto, wa_id: m.id, criada_em: nowLocal(),
    });
    await db.write();
    res.status(200).send('ok');
  } catch (e) {
    console.error('❌ webhook wa:', e);
    res.status(500).send('erro');
  }
});

// ========== META CAPI ==========
// Funciona para 2 origens:
//   1. Anúncios CTWA (Click-to-WhatsApp) → usa ctwa_clid + action_source: business_messaging
//   2. Anúncios web tradicionais → usa fbclid + action_source: website
const META_PAGE_ID = process.env.META_PAGE_ID || '';
const META_API_VERSION = 'v20.0';

const EVENTOS_FUNIL = {
  'Lead':              'LeadSubmitted',
  'Agendado':          'Schedule',
  'Compareceu':        'Contact',
  'Em Avaliação':      null,           // sem evento Meta — etapa interna
  'Orçamento Enviado': null,           // sem evento Meta — etapa interna
  'Fechou':            'Purchase',
  'Perdido':           null,
};

async function dispararConversaoMeta(lead, eventoCustom = null) {
  const PIXEL = process.env.META_PIXEL_ID;
  const TOKEN = process.env.META_ACCESS_TOKEN;
  if (!PIXEL || !TOKEN) { console.log('⚠️  Meta CAPI não configurada'); return; }

  // Define evento com base no status (ou usa o customizado)
  const eventName = eventoCustom || EVENTOS_FUNIL[lead.status];
  if (!eventName) {
    console.log(`⏭️  Lead #${lead.id} status "${lead.status}" não dispara CAPI`);
    return;
  }

  // Detecta se é CTWA (WhatsApp) ou web tradicional
  const isCTWA = !!lead.ctwa_clid;
  const action_source = isCTWA ? 'business_messaging' : 'website';

  // user_data: dados pra match com pessoas no Meta (tudo hasheado SHA-256)
  const user_data = {
    ...(lead.telefone && { ph: [sha256(lead.telefone)] }),
    ...(lead.email && { em: [sha256(lead.email)] }),
    ...(lead.nome && { fn: [sha256(lead.nome.split(' ')[0])] }),
  };

  // Para CTWA, OBRIGATÓRIO: ctwa_clid + page_id
  if (isCTWA) {
    user_data.ctwa_clid = lead.ctwa_clid;
    if (META_PAGE_ID) user_data.page_id = META_PAGE_ID;
  }
  // Para web tradicional, usar fbc com fbclid formatado
  else if (lead.fbclid) {
    user_data.fbc = `fb.1.${Math.floor(Date.now()/1000)}.${lead.fbclid}`;
  }

  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source,
      ...(isCTWA && { messaging_channel: 'whatsapp' }),
      // event_id único por (lead, evento) — evita deduplicação errada
      event_id: `lead_${lead.id}_${eventName}`,
      user_data,
      custom_data: {
        currency: 'BRL',
        value: lead.valor || 0,
      },
    }],
    ...(process.env.META_TEST_EVENT_CODE && { test_event_code: process.env.META_TEST_EVENT_CODE }),
  };

  try {
    const r = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${PIXEL}/events?access_token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await r.json();
    if (json.events_received) {
      console.log(`📤 Meta CAPI ✓ Lead #${lead.id} | evento: ${eventName} | ${isCTWA ? 'CTWA' : 'web'}`);
      // Marcar evento como enviado pra não duplicar
      if (!lead.eventos_meta_enviados) lead.eventos_meta_enviados = [];
      if (!lead.eventos_meta_enviados.includes(eventName)) {
        lead.eventos_meta_enviados.push(eventName);
      }
      if (eventName === 'Purchase') lead.enviado_meta = true;
      await db.write();
    } else {
      console.error(`📤 Meta CAPI ✗ Lead #${lead.id} | ${eventName}:`, JSON.stringify(json).slice(0, 300));
    }
  } catch (e) {
    console.error(`📤 Meta CAPI ERRO Lead #${lead.id}:`, e.message);
  }
}

async function dispararConversaoGoogle(lead) {
  if (!lead.gclid) return;
  const csvPath = path.join(__dirname, 'google_conversions.csv');
  const header = 'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency\n';
  if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, header);
  const conversionName = process.env.GOOGLE_CONVERSION_NAME || 'Tratamento Fechado';
  const time = lead.data_fechamento || nowLocal();
  fs.appendFileSync(csvPath, `${lead.gclid},${conversionName},${time},${lead.valor || 0},BRL\n`);
  console.log(`📤 Google ✓ Lead #${lead.id}`);
  lead.enviado_google = true;
  await db.write();
}

// ========== STATIC ==========
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^\/(?!api\/|lead(\?|$)|webhooks\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use((err, req, res, next) => {
  console.error('💥', err);
  res.status(500).json({ error: 'Erro interno' });
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🦷 CRM Clínica em http://localhost:${PORT}`);
    console.log(`📂 ${DB_PATH}`);
    console.log(`📱 WA básico: +${WHATSAPP_NUMBER}`);
    console.log(`📞 TotalVoice: ${totalvoice.temToken() ? 'configurada ✓' : 'não configurada'}`);
    console.log(`💬 WA Cloud API: ${whatsapp.temToken() ? 'configurada ✓' : 'não configurada'}\n`);
  });
}).catch(e => { console.error(e); process.exit(1); });
