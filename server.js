// ============================================================
//  CRM CLÍNICA — Servidor Node.js
//  Pipeline: Lead → Agendado → Compareceu → Em Avaliação
//            → Orçamento Enviado → Fechou / Perdido
// ============================================================

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
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
    templates: [],
    notas_fiscais: [],
    inadimplentes_notas: [],
    inadimplentes_cache: null,
    nextId: 1,
    nextChamadaId: 1,
    nextMensagemId: 1,
    nextTemplateId: 1,
    nextNotaId: 1,
  });
  if (!db.data.chamadas) db.data.chamadas = [];
  if (!db.data.mensagens) db.data.mensagens = [];
  if (!db.data.templates) db.data.templates = [];
  if (!db.data.notas_fiscais) db.data.notas_fiscais = [];
  db.data.notas_fiscais.forEach(n => { if (!n.historico) n.historico = []; });
  if (!db.data.inadimplentes_notas) db.data.inadimplentes_notas = [];
  if (!db.data.nextChamadaId) db.data.nextChamadaId = 1;
  if (!db.data.nextMensagemId) db.data.nextMensagemId = 1;
  if (!db.data.nextTemplateId) db.data.nextTemplateId = 1;
  if (!db.data.nextNotaId) db.data.nextNotaId = 1;
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

// Criação manual de lead pelo CRM
app.post('/api/leads', async (req, res) => {
  try {
    const { nome, telefone, email = '', origem = 'Direto', status = 'Lead', notas_sdr = '' } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
    const tel = sanitizeStr(telefone, 30).replace(/\D/g, '');
    if (!tel) return res.status(400).json({ error: 'Telefone obrigatório' });
    const lead = {
      id: db.data.nextId++,
      nome: sanitizeStr(nome), telefone: tel, email: sanitizeStr(email, 100),
      origem: sanitizeStr(origem), campanha: '', conteudo: '', fbclid: '', gclid: '', ctwa_clid: '',
      status: FUNIL.includes(status) ? status : 'Lead',
      valor: null, tipo_trat: '',
      notas_sdr: sanitizeStr(notas_sdr, 4000), notas_avaliacao: '', notas_comercial: '',
      score_interesse: null, perfil_disc: '',
      etiquetas: [], proximo_contato: null, ultimo_contato: null,
      data_lead: nowLocal(), data_agendamento: null, data_comparecimento: null,
      data_avaliacao: null, data_orcamento: null, data_fechamento: null,
      enviado_meta: false, enviado_google: false, eventos_meta_enviados: [],
      criado_em: nowLocal(), atualizado_em: nowLocal(),
    };
    db.data.leads.push(lead);
    await db.write();
    dispararConversaoMeta(lead).catch(e => console.error('Meta CAPI:', e.message));
    res.json({ ok: true, lead });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  res.json({ total, porStatus, porOrigem, receita, ticketMedio, oportunidade, ultimosLeads, _v: 4 });
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

// ========== TEMPLATES ==========
app.get('/api/templates', (req, res) => {
  const dbTpls = db.data.templates || [];
  // Templates do env como fallback (só aparecem se não estiverem no DB)
  const envNames = (process.env.WA_TEMPLATES || '').split(',').map(t => t.trim()).filter(Boolean);
  const envObjs = envNames
    .filter(n => !dbTpls.find(t => t.nome === n))
    .map(n => ({ id: null, nome: n, titulo: n, corpo: '', categoria: 'MARKETING', status: 'aprovado' }));
  res.json([...dbTpls, ...envObjs]);
});

app.post('/api/templates', async (req, res) => {
  try {
    const { nome, titulo, corpo, categoria = 'MARKETING' } = req.body;
    if (!nome) return res.status(400).json({ error: 'nome obrigatório' });
    const nomeLimpo = sanitizeStr(nome, 100).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (!nomeLimpo) return res.status(400).json({ error: 'nome inválido — use letras, números e underscore' });
    if (db.data.templates.find(t => t.nome === nomeLimpo)) {
      return res.status(409).json({ error: 'Já existe um template com esse nome' });
    }
    const tpl = {
      id: db.data.nextTemplateId++,
      nome: nomeLimpo,
      titulo: sanitizeStr(titulo || nome, 200),
      corpo: sanitizeStr(corpo || '', 4000),
      categoria: ['MARKETING','UTILITY','AUTHENTICATION'].includes(categoria) ? categoria : 'MARKETING',
      status: 'pendente',
      criado_em: nowLocal(),
    };
    db.data.templates.push(tpl);
    await db.write();
    res.json({ ok: true, template: tpl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/templates/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const tpl = db.data.templates.find(t => t.id === id);
    if (!tpl) return res.status(404).json({ error: 'Template não encontrado' });
    const allowed = ['titulo', 'corpo', 'categoria', 'status'];
    for (const k of Object.keys(req.body)) {
      if (allowed.includes(k)) tpl[k] = sanitizeStr(String(req.body[k]), 4000);
    }
    await db.write();
    res.json({ ok: true, template: tpl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/templates/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const idx = db.data.templates.findIndex(t => t.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Template não encontrado' });
    db.data.templates.splice(idx, 1);
    await db.write();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== TEMPLATES META API ==========
const WA_BUSINESS_ACCOUNT_ID = process.env.WA_BUSINESS_ACCOUNT_ID || '938428135727130';
const META_TPL_API = `https://graph.facebook.com/v21.0/${WA_BUSINESS_ACCOUNT_ID}/message_templates`;

// Submete template para aprovação na Meta
app.post('/api/templates/:id/submeter-meta', async (req, res) => {
  try {
    const TOKEN = process.env.META_ACCESS_TOKEN;
    if (!TOKEN) return res.status(503).json({ error: 'META_ACCESS_TOKEN não configurado' });

    const id = parseInt(req.params.id, 10);
    const tpl = db.data.templates.find(t => t.id === id);
    if (!tpl) return res.status(404).json({ error: 'Template não encontrado' });

    // Conta variáveis no corpo ({{1}}, {{2}}, ...)
    const matches = (tpl.corpo || '').match(/\{\{(\d+)\}\}/g) || [];
    const numVars = matches.length ? Math.max(...matches.map(m => parseInt(m.replace(/\D/g,'')))) : 0;

    const components = [];
    if (tpl.corpo) {
      const comp = { type: 'BODY', text: tpl.corpo };
      if (numVars > 0) {
        comp.example = { body_text: [Array.from({length: numVars}, (_, i) => `Exemplo ${i+1}`)] };
      }
      components.push(comp);
    }

    const payload = {
      name: tpl.nome,
      language: 'pt_BR',
      category: tpl.categoria || 'UTILITY',
      components,
    };

    const r = await fetch(`${META_TPL_API}?access_token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();

    if (data.error) {
      return res.status(400).json({ error: data.error.message || 'Erro na Meta API' });
    }

    // Atualiza status local para "submetido"
    tpl.status = 'submetido';
    tpl.meta_id = data.id || null;
    await db.write();
    res.json({ ok: true, meta_id: data.id, status: 'submetido' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sincroniza status de todos os templates com a Meta
app.get('/api/templates/sync-meta', async (req, res) => {
  try {
    const TOKEN = process.env.META_ACCESS_TOKEN;
    if (!TOKEN) return res.status(503).json({ error: 'META_ACCESS_TOKEN não configurado' });

    let url = `${META_TPL_API}?fields=name,status,category,components&limit=200&access_token=${TOKEN}`;
    const allMeta = [];
    while (url) {
      const r = await fetch(url);
      const data = await r.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      if (data.data) allMeta.push(...data.data);
      url = data.paging?.next || null;
    }

    const STATUS_MAP = {
      APPROVED: 'aprovado', PENDING: 'submetido',
      REJECTED: 'rejeitado', PAUSED: 'pausado',
      DISABLED: 'pausado', IN_APPEAL: 'em_recurso',
      PENDING_DELETION: 'pendente',
    };

    // Atualiza status dos templates já existentes localmente
    let atualizados = 0;
    for (const tpl of db.data.templates) {
      const metaTpl = allMeta.find(m => m.name === tpl.nome);
      if (metaTpl) {
        const novoStatus = STATUS_MAP[metaTpl.status] || metaTpl.status.toLowerCase();
        if (tpl.status !== novoStatus) { tpl.status = novoStatus; atualizados++; }
        if (metaTpl.id && !tpl.meta_id) tpl.meta_id = metaTpl.id;
      }
    }

    // Importa templates da Meta que ainda não existem localmente
    let importados = 0;
    const nomesLocais = new Set(db.data.templates.map(t => t.nome));
    for (const m of allMeta) {
      if (nomesLocais.has(m.name)) continue;
      // Extrai texto do componente BODY
      const bodyComp = (m.components || []).find(c => c.type === 'BODY');
      const corpo = bodyComp ? bodyComp.text : '';
      const cat = ['MARKETING','UTILITY','AUTHENTICATION'].includes(m.category) ? m.category : 'MARKETING';
      const status = STATUS_MAP[m.status] || m.status.toLowerCase();
      const titulo = m.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      db.data.templates.push({
        id: db.data.nextTemplateId++,
        nome: m.name,
        titulo,
        corpo,
        categoria: cat,
        status,
        meta_id: m.id || null,
        criado_em: nowLocal(),
      });
      importados++;
    }

    await db.write();
    res.json({ ok: true, atualizados, importados, total_meta: allMeta.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== IMPORTAR PACIENTES ==========
app.post('/api/leads/importar', async (req, res) => {
  try {
    const { pacientes } = req.body;
    if (!Array.isArray(pacientes) || !pacientes.length) {
      return res.status(400).json({ error: 'pacientes deve ser array não vazio' });
    }
    let importados = 0, duplicados = 0, erros = 0;
    for (const p of pacientes.slice(0, 5000)) {
      const nome = sanitizeStr(p.nome || 'Paciente importado');
      const telefone = sanitizeStr(p.telefone || '', 30).replace(/\D/g, '');
      const email = sanitizeStr(p.email || '', 100);
      const origem = sanitizeStr(p.origem || 'Importação', 100);
      if (!nome && !telefone) { erros++; continue; }
      if (telefone && db.data.leads.find(l => l.telefone === telefone)) { duplicados++; continue; }
      db.data.leads.push({
        id: db.data.nextId++,
        nome, telefone, email, origem,
        campanha: '', conteudo: '', fbclid: '', gclid: '', ctwa_clid: '',
        status: 'Lead', valor: null, tipo_trat: '',
        notas_sdr: sanitizeStr(p.observacoes || '', 4000),
        notas_avaliacao: '', notas_comercial: '',
        score_interesse: null, perfil_disc: '',
        etiquetas: [], proximo_contato: null, ultimo_contato: null,
        data_lead: nowLocal(),
        data_agendamento: null, data_comparecimento: null,
        data_avaliacao: null, data_orcamento: null, data_fechamento: null,
        enviado_meta: false, enviado_google: false,
        eventos_meta_enviados: [],
        criado_em: nowLocal(), atualizado_em: nowLocal(),
      });
      importados++;
    }
    await db.write();
    res.json({ ok: true, importados, duplicados, erros });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
        origem: m.ctwa_clid ? 'Meta Ads' : 'WhatsApp Direto',
        campanha: m.ad_id || '', conteudo: '', fbclid: '', gclid: '',
        ctwa_clid: m.ctwa_clid || '',
        status: 'Lead', valor: null, tipo_trat: '',
        notas_sdr: '', notas_avaliacao: '', notas_comercial: '',
        score_interesse: null, perfil_disc: '',
        etiquetas: [], proximo_contato: null, ultimo_contato: nowLocal(),
        data_lead: nowLocal(),
        data_agendamento: null, data_comparecimento: null,
        data_avaliacao: null, data_orcamento: null, data_fechamento: null,
        enviado_meta: false, enviado_google: false,
        eventos_meta_enviados: [],
        criado_em: nowLocal(), atualizado_em: nowLocal(),
      };
      db.data.leads.push(lead);
      console.log(`✅ Novo lead via WA: ${m.nome} (${m.from})${m.ctwa_clid ? ' [CTWA]' : ''}`);
      // Dispara LeadSubmitted no CAPI imediatamente para leads de anúncio CTWA
      if (m.ctwa_clid) dispararConversaoMeta(lead).catch(e => console.error('Meta CAPI:', e.message));
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

// ========== CAPTCHA MANUAL ==========
let _captchaPendente = null; // { token, img_b64, resposta, criado_em }

app.post('/api/nf-captcha', (req, res) => {
  const { img_b64 } = req.body;
  if (!img_b64) return res.status(400).json({ error: 'img_b64 obrigatório' });
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  _captchaPendente = { token, img_b64, resposta: null, criado_em: Date.now() };
  res.json({ ok: true, token });
});

app.get('/api/nf-captcha', (req, res) => {
  if (!_captchaPendente || Date.now() - _captchaPendente.criado_em > 120000) {
    _captchaPendente = null;
    return res.json({ pendente: false });
  }
  // Já foi respondido — não reabre o modal
  if (_captchaPendente.resposta) return res.json({ pendente: false });
  res.json({ pendente: true, token: _captchaPendente.token, img_b64: _captchaPendente.img_b64 });
});

app.post('/api/nf-captcha/:token/resposta', (req, res) => {
  const { digitos } = req.body;
  if (!_captchaPendente || _captchaPendente.token !== req.params.token)
    return res.status(404).json({ error: 'token inválido ou expirado' });
  _captchaPendente.resposta = String(digitos || '').replace(/\D/g, '').slice(0, 4);
  res.json({ ok: true });
});

app.get('/api/nf-captcha/:token/aguardar', (req, res) => {
  if (!_captchaPendente || _captchaPendente.token !== req.params.token)
    return res.json({ ok: false, expirado: true });
  if (_captchaPendente.resposta)
    return res.json({ ok: true, digitos: _captchaPendente.resposta });
  res.json({ ok: false, aguardando: true });
});

// ========== NOTAS FISCAIS ==========
const NF_SISTEMAS = ['Vieira', 'Martins', 'Receita Saude'];
const NF_STATUS   = ['Pendente', 'Processando', 'Emitida', 'Erro'];

app.get('/api/notas-fiscais', (req, res) => {
  const { sistema, status, competencia } = req.query;
  let r = [...db.data.notas_fiscais];
  if (sistema) r = r.filter(n => n.sistema === sistema);
  if (status)  r = r.filter(n => n.status === status);
  if (competencia) r = r.filter(n => n.competencia === competencia);
  r.sort((a, b) => b.id - a.id);
  res.json(r);
});

app.get('/api/notas-fiscais/pendentes', (req, res) => {
  const pendentes = db.data.notas_fiscais.filter(n => n.status === 'Pendente');
  res.json(pendentes);
});

app.post('/api/notas-fiscais', async (req, res) => {
  try {
    const {
      sistema, competencia, tipo_tomador = 'CPF',
      cpf_tomador, nome_tomador,
      cpf_paciente = '', nome_paciente = '', parentesco = '',
      data_pagamento, valor, descricao = '',
    } = req.body;
    if (!sistema || !NF_SISTEMAS.includes(sistema))
      return res.status(400).json({ error: `sistema inválido. Use: ${NF_SISTEMAS.join(', ')}` });
    if (!cpf_tomador || !nome_tomador)
      return res.status(400).json({ error: 'cpf_tomador e nome_tomador obrigatórios' });
    if (!competencia || !/^\d{2}-\d{4}$/.test(competencia))
      return res.status(400).json({ error: 'competencia deve estar no formato MM-AAAA ex: 05-2026' });

    const nota = {
      id: db.data.nextNotaId++,
      sistema: sanitizeStr(sistema, 30),
      competencia: sanitizeStr(competencia, 7),
      status: 'Pendente',
      tipo_tomador: tipo_tomador === 'CNPJ' ? 'CNPJ' : 'CPF',
      cpf_tomador: sanitizeStr(cpf_tomador, 20).replace(/\D/g, ''),
      nome_tomador: sanitizeStr(nome_tomador),
      cpf_paciente: sanitizeStr(cpf_paciente, 20).replace(/\D/g, ''),
      nome_paciente: sanitizeStr(nome_paciente),
      parentesco: sanitizeStr(parentesco, 50),
      data_pagamento: sanitizeStr(data_pagamento, 20),
      valor: parseFloat(String(valor).replace(',', '.')) || 0,
      descricao: sanitizeStr(descricao, 500),
      num_nota: null,
      data_emissao: null,
      caminho_pdf: null,
      erro_msg: null,
      historico: [],
      criado_em: nowLocal(),
      atualizado_em: nowLocal(),
    };
    db.data.notas_fiscais.push(nota);
    await db.write();
    res.json({ ok: true, nota });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/notas-fiscais/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const nota = db.data.notas_fiscais.find(n => n.id === id);
    if (!nota) return res.status(404).json({ error: 'Nota não encontrada' });

    const ALLOWED_EDIT = [
      'sistema','competencia','tipo_tomador','cpf_tomador','nome_tomador',
      'cpf_paciente','nome_paciente','parentesco','data_pagamento','valor','descricao',
    ];
    const ALLOWED_RESULT = ['status','num_nota','data_emissao','caminho_pdf','erro_msg'];

    const statusAntes = nota.status;
    const quem = req.body.quem === 'sistema' ? 'sistema' : 'manual';

    for (const k of [...ALLOWED_EDIT, ...ALLOWED_RESULT]) {
      if (!(k in req.body)) continue;
      let v = req.body[k];
      if (k === 'status' && !NF_STATUS.includes(v))
        return res.status(400).json({ error: `status inválido. Use: ${NF_STATUS.join(', ')}` });
      if (k === 'valor') v = parseFloat(String(v).replace(',', '.')) || 0;
      if (typeof v === 'string') v = sanitizeStr(v, 500);
      nota[k] = v;
    }

    if (req.body.status && req.body.status !== statusAntes) {
      if (!nota.historico) nota.historico = [];
      nota.historico.push({ de: statusAntes, para: nota.status, quando: nowLocal(), quem });
    }

    nota.atualizado_em = nowLocal();
    await db.write();
    res.json({ ok: true, nota });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/notas-fiscais/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const idx = db.data.notas_fiscais.findIndex(n => n.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Nota não encontrada' });
    if (['Emitida','Processando'].includes(db.data.notas_fiscais[idx].status))
      return res.status(400).json({ error: 'Não é possível excluir uma nota já emitida ou em processamento' });
    db.data.notas_fiscais.splice(idx, 1);
    await db.write();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/notas-fiscais/lote', async (req, res) => {
  try {
    const { notas } = req.body;
    if (!Array.isArray(notas) || !notas.length)
      return res.status(400).json({ error: 'Campo notas deve ser um array não vazio' });
    if (notas.length > 200)
      return res.status(400).json({ error: 'Máximo de 200 notas por lote' });

    const criadas = [];
    const erros = [];

    for (let i = 0; i < notas.length; i++) {
      const b = notas[i];
      const linha = i + 1;
      if (!b.sistema || !NF_SISTEMAS.includes(b.sistema)) { erros.push({ linha, msg: `sistema inválido: "${b.sistema}"` }); continue; }
      if (!b.cpf_tomador || !b.nome_tomador) { erros.push({ linha, msg: 'cpf_tomador e nome_tomador obrigatórios' }); continue; }
      if (!b.competencia || !/^\d{2}-\d{4}$/.test(b.competencia)) { erros.push({ linha, msg: `competencia inválida: "${b.competencia}"` }); continue; }

      const nota = {
        id: db.data.nextNotaId++,
        sistema: sanitizeStr(b.sistema, 30),
        competencia: sanitizeStr(b.competencia, 7),
        status: 'Pendente',
        tipo_tomador: b.tipo_tomador === 'CNPJ' ? 'CNPJ' : 'CPF',
        cpf_tomador: sanitizeStr(b.cpf_tomador, 20).replace(/\D/g, ''),
        nome_tomador: sanitizeStr(b.nome_tomador),
        cpf_paciente: sanitizeStr(b.cpf_paciente || '', 20).replace(/\D/g, ''),
        nome_paciente: sanitizeStr(b.nome_paciente || ''),
        parentesco: sanitizeStr(b.parentesco || '', 50),
        data_pagamento: sanitizeStr(b.data_pagamento || '', 20),
        valor: parseFloat(String(b.valor || '0').replace(',', '.')) || 0,
        descricao: sanitizeStr(b.descricao || '', 500),
        num_nota: null, data_emissao: null, caminho_pdf: null, erro_msg: null,
        historico: [],
        criado_em: nowLocal(), atualizado_em: nowLocal(),
      };
      db.data.notas_fiscais.push(nota);
      criadas.push(nota);
    }

    await db.write();
    res.json({ ok: true, criadas: criadas.length, erros });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/notas-fiscais/stats', (req, res) => {
  const { competencia } = req.query;
  let notas = db.data.notas_fiscais;
  if (competencia) notas = notas.filter(n => n.competencia === competencia);
  const total = notas.length;
  const pendentes = notas.filter(n => n.status === 'Pendente').length;
  const emitidas = notas.filter(n => n.status === 'Emitida').length;
  const erros = notas.filter(n => n.status === 'Erro').length;
  const valorEmitido = notas.filter(n => n.status === 'Emitida').reduce((s, n) => s + (n.valor || 0), 0);
  res.json({ total, pendentes, emitidas, erros, valorEmitido });
});

// ========== CLINICORP / INADIMPLENTES ==========
function clinicorpGet(apiPath, params = {}) {
  return new Promise((resolve, reject) => {
    const user  = process.env.CLINICORP_USER  || 'clinicaama';
    const token = process.env.CLINICORP_TOKEN || '';
    const auth  = Buffer.from(`${user}:${token}`).toString('base64');
    const qs = new URLSearchParams({
      subscriber_id: process.env.CLINICORP_SUBSCRIBER_ID || 'clinicaama',
      business_id:   process.env.CLINICORP_BUSINESS_ID   || 'clinicaama',
      ...params,
    }).toString();
    const opts = {
      hostname: 'api.clinicorp.com',
      path: `/rest/v1${apiPath}?${qs}`,
      method: 'GET',
      headers: { 'Authorization': `Basic ${auth}`, 'X-Api-Key': token, 'Accept': 'application/json' },
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch(e) { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout Clinicorp')); });
    req.on('error', reject);
    req.end();
  });
}

function processarInadimplentes(items, today) {
  const todayDate = new Date(today);
  const patMap = {};

  items.forEach(i => {
    const patId = String(i.PatientId || i.patientId || i.Patient_PersonId || '').trim();
    if (!patId) return;

    // Ignora registros já pagos
    // Clinicorp /payment/list: PaymentReceived='X' = pago; ausente = pendente
    const isPaid = i.PaymentReceived === 'X' ||
      (!i.PaymentReceived && (i.PaidDate || i.paid_date));
    if (isPaid) return;

    const dueDate = i.DueDate || i.due_date || i.ScheduledDate || i.InstallmentDate || '';
    if (!dueDate) return;

    const amount    = Number(i.Amount || i.Value || i.TotalPostAmount || i.installment_value || 0);
    const isOverdue = dueDate < today;
    const isFuture  = dueDate >= today;

    if (!patMap[patId]) {
      patMap[patId] = {
        id:   patId,
        name: i.PatientName || i.patientName || i.Patient_PersonName || `Paciente ${patId}`,
        phone: i.Phone || i.MobilePhone || i.phone || '',
        overdueAmount: 0, futureAmount: 0,
        overdueCount: 0,
        oldestDueDate: null, nextDueDate: null,
        treatmentValue: 0,  paidValue: 0,
      };
    }
    const p = patMap[patId];
    if (isOverdue) {
      p.overdueAmount += amount;
      p.overdueCount++;
      if (!p.oldestDueDate || dueDate < p.oldestDueDate) p.oldestDueDate = dueDate;
    } else if (isFuture) {
      p.futureAmount += amount;
      if (!p.nextDueDate || dueDate < p.nextDueDate) p.nextDueDate = dueDate;
    }
    const tv = Number(i.TreatmentValue || i.TotalTreatmentValue || 0);
    if (tv) p.treatmentValue = Math.max(p.treatmentValue, tv);
    const pv = Number(i.PaidValue || i.TotalPaidValue || i.AmountPaid || 0);
    if (pv) p.paidValue = Math.max(p.paidValue, pv);
  });

  const patients = Object.values(patMap).filter(p => p.overdueCount > 0);
  patients.forEach(p => {
    p.diasDeAtraso    = p.oldestDueDate ? Math.floor((todayDate - new Date(p.oldestDueDate)) / 86400000) : 0;
    p.diasParaProximo = p.nextDueDate   ? Math.floor((new Date(p.nextDueDate) - todayDate) / 86400000) : null;
    // Classificação: sem futuro = 3, 1 parcela vencida = 1, 2+ parcelas = 2
    p.grupo = (p.futureAmount <= 0) ? 3 : (p.overdueCount === 1) ? 1 : 2;
  });

  const byOverdue = (a, b) => b.overdueAmount - a.overdueAmount;
  const grupo1 = patients.filter(p => p.grupo === 1).sort(byOverdue);
  const grupo2 = patients.filter(p => p.grupo === 2).sort(byOverdue);
  const grupo3 = patients.filter(p => p.grupo === 3).sort(byOverdue);
  return {
    grupo1, grupo2, grupo3,
    totais: {
      pacientes:    patients.length,
      valorTotal:   patients.reduce((s, p) => s + p.overdueAmount, 0),
      emCobranca:   grupo1.length,
      renegociacao: grupo2.length,
      criticos:     grupo3.length,
    },
  };
}

function mergeInadimplentesNotas(resultado) {
  const notas = db.data.inadimplentes_notas || [];
  const nm = {};
  notas.forEach(n => { nm[n.patientId] = n; });
  const addN = arr => arr.map(p => {
    const n = nm[p.id] || {};
    return { ...p, responsavel: n.responsavel || '', proximoPasso: n.proximoPasso || '', obs: n.obs || '' };
  });
  return { ...resultado, grupo1: addN(resultado.grupo1), grupo2: addN(resultado.grupo2), grupo3: addN(resultado.grupo3) };
}

// GET /api/inadimplentes
// Cache de 2h para proteger o rate limit de 25 req/hora da Clinicorp
// Use ?refresh=1 para forçar nova busca (consome 1 requisição)
app.get('/api/inadimplentes', async (req, res) => {
  try {
    if (!process.env.CLINICORP_TOKEN) {
      return res.status(503).json({ error: 'CLINICORP_TOKEN não configurado. Adicione nas variáveis de ambiente do Railway.' });
    }
    const forceRefresh = req.query.refresh === '1';
    const cache = db.data.inadimplentes_cache;

    if (!forceRefresh && cache && cache.data && cache.atualizado_em) {
      const ageMs = Date.now() - new Date(cache.atualizado_em).getTime();
      if (ageMs < 2 * 60 * 60 * 1000) {
        const result = mergeInadimplentesNotas(cache.data);
        return res.json({ ...result, from_cache: true, cache_min: Math.round(ageMs / 60000) });
      }
    }

    const today   = new Date().toISOString().split('T')[0];
    const futDate = new Date(); futDate.setFullYear(futDate.getFullYear() + 3);
    const futStr  = futDate.toISOString().split('T')[0];

    let items = [], endpointUsado = '';
    const FROM = '2019-01-01'; // cobre dívidas históricas

    // Tentativa 1: /financial/list_receipt (contas a receber — endpoint correto no Swagger Clinicorp)
    try {
      const r = await clinicorpGet('/financial/list_receipt', { from: FROM, to: futStr });
      console.log(`[Inadimplentes] /financial/list_receipt → HTTP ${r.status}, itens: ${Array.isArray(r.data) ? r.data.length : JSON.stringify(r.data).slice(0,120)}`);
      if (r.status === 200 && Array.isArray(r.data) && r.data.length > 0) {
        items = r.data; endpointUsado = '/financial/list_receipt';
      }
    } catch(e) { console.log('[Inadimplentes] /financial/list_receipt erro:', e.message); }

    // Tentativa 2: /receivable/list
    if (!items.length) {
      try {
        const r = await clinicorpGet('/receivable/list', { from: FROM, to: futStr });
        console.log(`[Inadimplentes] /receivable/list → HTTP ${r.status}, itens: ${Array.isArray(r.data) ? r.data.length : JSON.stringify(r.data).slice(0,120)}`);
        if (r.status === 200 && Array.isArray(r.data) && r.data.length > 0) {
          items = r.data; endpointUsado = '/receivable/list';
        }
      } catch(e) { console.log('[Inadimplentes] /receivable/list erro:', e.message); }
    }

    // Tentativa 3 (fallback): /payment/list (legacy)
    if (!items.length) {
      try {
        const r = await clinicorpGet('/payment/list', { from: FROM, to: futStr });
        console.log(`[Inadimplentes] /payment/list → HTTP ${r.status}, itens: ${Array.isArray(r.data) ? r.data.length : JSON.stringify(r.data).slice(0,120)}`);
        if (r.status === 200 && Array.isArray(r.data)) { items = r.data; endpointUsado = '/payment/list'; }
      } catch(e) { console.log('[Inadimplentes] /payment/list erro:', e.message); }
    }

    if (!items.length) {
      return res.json({
        grupo1: [], grupo2: [], grupo3: [],
        totais: { pacientes: 0, valorTotal: 0, emCobranca: 0, renegociacao: 0, criticos: 0 },
        from_cache: false, endpoint: endpointUsado || 'nenhum',
        aviso: 'Nenhum dado retornado pela Clinicorp. Verifique as credenciais e tente novamente.',
      });
    }

    const processado = processarInadimplentes(items, today);
    db.data.inadimplentes_cache = { data: processado, atualizado_em: nowLocal(), endpoint: endpointUsado };
    await db.write();
    console.log(`[Inadimplentes] ✅ ${processado.totais.pacientes} inadimplentes via ${endpointUsado}`);

    const result = mergeInadimplentesNotas(processado);
    res.json({ ...result, from_cache: false, endpoint: endpointUsado });
  } catch(e) {
    console.error('❌ inadimplentes:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/debug-inad — retorna amostra dos campos brutos da Clinicorp para diagnóstico
app.get('/api/debug-inad', async (req, res) => {
  try {
    const today   = new Date().toISOString().split('T')[0];
    const futDate = new Date(); futDate.setFullYear(futDate.getFullYear() + 3);
    const futStr  = futDate.toISOString().split('T')[0];
    const result  = { today, receivable: null, payment: null };

    try {
      const r = await clinicorpGet('/receivable/list', { from: '2023-01-01', to: futStr });
      result.receivable = {
        status: r.status,
        isArray: Array.isArray(r.data),
        total: Array.isArray(r.data) ? r.data.length : null,
        errorMsg: !Array.isArray(r.data) ? JSON.stringify(r.data).slice(0, 300) : undefined,
        sample: Array.isArray(r.data) ? r.data.slice(0, 2) : [],
      };
    } catch(e) { result.receivable = { error: e.message }; }

    try {
      const r = await clinicorpGet('/payment/list', { from: '2023-01-01', to: futStr });
      result.payment = {
        status: r.status,
        isArray: Array.isArray(r.data),
        total: Array.isArray(r.data) ? r.data.length : null,
        errorMsg: !Array.isArray(r.data) ? JSON.stringify(r.data).slice(0, 300) : undefined,
        sample: Array.isArray(r.data) ? r.data.slice(0, 2) : [],
        futureCount: Array.isArray(r.data) ? r.data.filter(i => {
          const d = i.DueDate || i.due_date || i.ScheduledDate || i.InstallmentDate || '';
          return d >= today;
        }).length : null,
      };
    } catch(e) { result.payment = { error: e.message }; }

    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/inadimplentes/nota/:patientId — salva notas editáveis (Responsável, Próximo Passo, OBS)
app.patch('/api/inadimplentes/nota/:patientId', async (req, res) => {
  try {
    const patientId = sanitizeStr(req.params.patientId, 50);
    const { responsavel, proximoPasso, obs } = req.body;
    let nota = db.data.inadimplentes_notas.find(n => n.patientId === patientId);
    if (!nota) {
      nota = { patientId, responsavel: '', proximoPasso: '', obs: '', atualizado_em: nowLocal() };
      db.data.inadimplentes_notas.push(nota);
    }
    if (responsavel  !== undefined) nota.responsavel  = sanitizeStr(responsavel, 100);
    if (proximoPasso !== undefined) nota.proximoPasso = sanitizeStr(proximoPasso, 1000);
    if (obs          !== undefined) nota.obs          = sanitizeStr(obs, 2000);
    nota.atualizado_em = nowLocal();
    await db.write();
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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
