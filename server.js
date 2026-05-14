// ============================================================
//  CRM CLINICA - Servidor Node.js (Supabase edition)
// ============================================================

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const totalvoice = require('./totalvoice');
const whatsapp = require('./whatsapp');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || '5531999999999').replace(/\D/g, '');
const FUNIL = ['Lead', 'Agendado', 'Compareceu', 'Em Avaliação', 'Orçamento Enviado', 'Fechou', 'Perdido'];

// --------- SUPABASE ---------
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// --------- AUTH MIDDLEWARE ---------
async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  req.user = user;
  next();
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
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}
function sanitizeStr(v, max = 200) {
  if (v === null || v === undefined) return '';
  return String(v).slice(0, max);
}
const sha256 = v => v ? crypto.createHash('sha256').update(String(v).toLowerCase().trim()).digest('hex') : null;

// --------- APP ---------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const _rlMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = _rlMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > 60000) { entry.count = 0; entry.start = now; }
  entry.count++;
  _rlMap.set(ip, entry);
  if (entry.count > 60) return res.status(429).json({ error: 'Muitas requisições. Aguarde um minuto.' });
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _rlMap) {
    if (now - entry.start > 300000) _rlMap.delete(ip);
  }
}, 600000);

// ========== AUTH ==========
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', req.user.id).maybeSingle();
    const metaRoles = req.user.user_metadata?.roles || req.user.app_metadata?.roles || null;
    res.json({
      id: req.user.id,
      email: req.user.email,
      nome: profile?.nome || req.user.user_metadata?.nome || req.user.email,
      roles: profile?.roles || metaRoles || ['crc_leads'],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== ADMIN MIDDLEWARE ==========
function requireAdmin(req, res, next) {
  const roles = req.user?.user_metadata?.roles || req.user?.app_metadata?.roles || [];
  if (!Array.isArray(roles) || !roles.includes('admin')) {
    return res.status(403).json({ error: 'Acesso restrito a administradores' });
  }
  next();
}

// ========== ADMIN: USUÁRIOS ==========
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('admin_list_users', { p_admin_id: req.user.id });
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nome, email, senha, roles } = req.body;
    if (!email || !senha) return res.status(400).json({ error: 'email e senha são obrigatórios' });
    const { data, error } = await supabase.rpc('admin_create_user', {
      p_admin_id: req.user.id,
      p_email: email,
      p_password: senha,
      p_nome: nome || email,
      p_roles: Array.isArray(roles) ? roles : ['crc_leads'],
    });
    if (error) throw error;
    if (data?.error) return res.status(400).json({ error: data.error });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('admin_delete_user', {
      p_admin_id: req.user.id,
      p_user_id: req.params.id,
    });
    if (error) throw error;
    if (data?.error) return res.status(400).json({ error: data.error });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ========== CAPTURAR LEAD ==========
app.get('/lead', rateLimit, async (req, res) => {
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

    let lead;
    if (telefone) {
      const { data: existing } = await supabase.from('leads').select('*').eq('telefone', telefone).maybeSingle();
      if (existing) {
        const obs = sanitizeStr((existing.observacoes_sistema || '') +
          '\n[' + nowLocal() + '] Reentrou via ' + origem + '/' + campanha, 4000);
        await supabase.from('leads').update({ observacoes_sistema: obs }).eq('id', existing.id);
        lead = existing;
        console.log('♻️  Lead reentrou #' + lead.id + ' — ' + nome);
      }
    }

    if (!lead) {
      const { data: inserted, error } = await supabase.from('leads').insert({
        nome: sanitizeStr(nome), telefone, email,
        origem, campanha, conteudo, fbclid, gclid, ctwa_clid,
        status: 'Lead', valor: null, tipo_trat: '',
        notas_sdr: '', notas_avaliacao: '', notas_comercial: '',
        score_interesse: null, perfil_disc: '',
        etiquetas: [], proximo_contato: null, ultimo_contato: null,
        enviado_meta: false, enviado_google: false, eventos_meta_enviados: [],
      }).select().single();
      if (error) throw error;
      lead = inserted;
      console.log('✅ Lead #' + lead.id + ' — ' + nome + ' via ' + origem);
      dispararConversaoMeta(lead).catch(e => console.error('Meta CAPI:', e.message));
    }

    const msg = encodeURIComponent('Olá! Vim do anúncio e gostaria de mais informações.');
    res.redirect(302, 'https://wa.me/' + WHATSAPP_NUMBER + '?text=' + msg);
  } catch (e) {
    console.error('❌ Erro lead:', e);
    res.status(500).send('Erro ao processar lead');
  }
});

// ========== API: LEADS ==========
app.get('/api/leads', requireAuth, rateLimit, async (req, res) => {
  try {
    const { status, origem, q, etiqueta } = req.query;
    let query = supabase.from('leads').select('*').order('id', { ascending: false }).range(0, 9999);
    if (status) query = query.eq('status', status);
    if (origem) query = query.eq('origem', origem);
    if (etiqueta) query = query.contains('etiquetas', [etiqueta]);
    if (q) {
      const safe = q.replace(/[%_\\]/g, '\\$&');
      query = query.or('nome.ilike.%' + safe + '%,telefone.ilike.%' + safe + '%,campanha.ilike.%' + safe + '%');
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/leads', requireAuth, rateLimit, async (req, res) => {
  try {
    const { nome, telefone, email = '', origem = 'Direto', status = 'Lead', notas_sdr = '' } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
    const tel = sanitizeStr(telefone, 30).replace(/\D/g, '');
    if (!tel) return res.status(400).json({ error: 'Telefone obrigatório' });
    const { data: dup } = await supabase.from('leads').select('id').eq('telefone', tel).maybeSingle();
    if (dup) return res.status(409).json({ error: 'Telefone já cadastrado em outro lead' });
    const { data: lead, error } = await supabase.from('leads').insert({
      nome: sanitizeStr(nome), telefone: tel, email: sanitizeStr(email, 100),
      origem: sanitizeStr(origem), campanha: '', conteudo: '', fbclid: '', gclid: '', ctwa_clid: '',
      status: FUNIL.includes(status) ? status : 'Lead',
      valor: null, tipo_trat: '',
      notas_sdr: sanitizeStr(notas_sdr, 4000), notas_avaliacao: '', notas_comercial: '',
      score_interesse: null, perfil_disc: '',
      etiquetas: [], proximo_contato: null, ultimo_contato: null,
      enviado_meta: false, enviado_google: false, eventos_meta_enviados: [],
    }).select().single();
    if (error) throw error;
    dispararConversaoMeta(lead).catch(e => console.error('Meta CAPI:', e.message));
    res.json({ ok: true, lead });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/leads/:id', requireAuth, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data: lead, error } = await supabase.from('leads').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    res.json(lead);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function patchLead(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data: lead, error: fetchErr } = await supabase.from('leads').select('*').eq('id', id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    const leadAntes = { status: lead.status };
    const ALLOWED = [
      'nome','telefone','email','status','valor','tipo_trat',
      'notas_sdr','notas_avaliacao','notas_comercial',
      'score_interesse','perfil_disc','etiquetas',
      'proximo_contato','ultimo_contato',
    ];
    const agora = new Date().toISOString();
    const patch = {};
    for (const k of Object.keys(req.body)) {
      if (!ALLOWED.includes(k)) continue;
      let v = req.body[k];
      if (k === 'status') {
        if (!FUNIL.includes(v)) return res.status(400).json({ error: 'Status inválido. Use: ' + FUNIL.join(', ') });
        if (v === 'Agendado' && !lead.data_agendamento) patch.data_agendamento = agora;
        if (v === 'Compareceu' && !lead.data_comparecimento) patch.data_comparecimento = agora;
        if (v === 'Em Avaliação' && !lead.data_avaliacao) patch.data_avaliacao = agora;
        if (v === 'Orçamento Enviado' && !lead.data_orcamento) patch.data_orcamento = agora;
        if (v === 'Fechou' && !lead.data_fechamento) patch.data_fechamento = agora;
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
      if (k === 'telefone') {
        v = sanitizeStr(v, 30).replace(/\D/g, '');
        if (v) {
          const { data: dup } = await supabase.from('leads').select('id').eq('telefone', v).neq('id', id).maybeSingle();
          if (dup) return res.status(409).json({ error: 'Telefone já cadastrado em outro lead' });
        }
      }
      if (k === 'proximo_contato' || k === 'ultimo_contato') {
        if (!v) { patch[k] = null; continue; }
        if (typeof v === 'string' && Number.isNaN(Date.parse(v))) continue;
      }
      if (typeof v === 'string') v = sanitizeStr(v, 4000);
      patch[k] = v;
    }
    const { data: updated, error: updateErr } = await supabase.from('leads').update(patch).eq('id', id).select().single();
    if (updateErr) throw updateErr;
    const statusMudou = req.body.status && req.body.status !== leadAntes.status;
    if (statusMudou) {
      const evtNome = EVENTOS_FUNIL[updated.status];
      const jaEnviou = (updated.eventos_meta_enviados || []).includes(evtNome);
      if (evtNome && !jaEnviou) {
        dispararConversaoMeta(updated).catch(e => console.error('Meta CAPI:', e.message));
      }
      if (updated.status === 'Fechou' && updated.gclid && !updated.enviado_google) {
        dispararConversaoGoogle(updated).catch(e => console.error('Google:', e.message));
      }
    }
    res.json({ ok: true, lead: updated });
  } catch (e) {
    console.error('❌ PATCH:', e);
    res.status(500).json({ error: e.message });
  }
}
app.patch('/api/leads/:id', requireAuth, rateLimit, patchLead);
app.patch('/api/leads/:id/status', requireAuth, rateLimit, patchLead);

// ========== STATS ==========
app.get('/api/stats', requireAuth, rateLimit, async (req, res) => {
  try {
    const { data: leads, error } = await supabase.from('leads').select('*').range(0, 9999);
    if (error) throw error;
    const total = leads.length;
    const porStatus = FUNIL.map(s => ({ status: s, n: leads.filter(l => l.status === s).length }));
    const origens = [...new Set(leads.map(l => l.origem))];
    const porOrigem = origens.map(o => {
      const arr = leads.filter(l => l.origem === o);
      const fechados = arr.filter(l => l.status === 'Fechou');
      return { origem: o, n: arr.length, fechados: fechados.length, receita: fechados.reduce((s, l) => s + (parseFloat(l.valor) || 0), 0) };
    }).sort((a, b) => b.n - a.n);
    const fechados = leads.filter(l => l.status === 'Fechou' && l.valor);
    const receita = fechados.reduce((s, l) => s + (parseFloat(l.valor) || 0), 0);
    const ticketMedio = fechados.length ? receita / fechados.length : 0;
    const oportunidade = leads
      .filter(l => ['Agendado','Compareceu','Em Avaliação','Orçamento Enviado'].includes(l.status))
      .reduce((s, l) => s + (parseFloat(l.valor) || 0), 0);
    const ultimosLeads = [...leads].sort((a, b) => b.id - a.id).slice(0, 10);
    res.json({ total, porStatus, porOrigem, receita, ticketMedio, oportunidade, ultimosLeads, _v: 4 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ========== TELEFONIA ==========
app.post('/api/leads/:id/ligar', requireAuth, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { data: lead, error } = await supabase.from('leads').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (!lead.telefone) return res.status(400).json({ error: 'Lead sem telefone' });
    const { numeroSdr } = req.body;
    if (!numeroSdr) return res.status(400).json({ error: 'numeroSdr obrigatório' });
    if (!totalvoice.temToken()) return res.status(503).json({ error: 'TotalVoice não configurada' });
    const dados = await totalvoice.ligar({ numeroSdr, numeroLead: lead.telefone, gravar: true, bina: process.env.TOTALVOICE_BINA });
    const { data: chamada, error: cErr } = await supabase.from('chamadas').insert({
      lead_id: lead.id, lead_nome: lead.nome,
      totalvoice_id: dados.id,
      numero_sdr: numeroSdr, numero_lead: lead.telefone,
      status: dados.status || 'iniciada',
      duracao_segundos: 0, url_gravacao: '',
    }).select().single();
    if (cErr) throw cErr;
    await supabase.from('leads').update({ ultimo_contato: new Date().toISOString() }).eq('id', lead.id);
    res.json({ ok: true, chamada });
  } catch (e) {
    console.error('❌ ligar:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/leads/:id/chamadas', requireAuth, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID invalido' });
    const { data, error } = await supabase.from('chamadas').select('*').eq('lead_id', id).order('id', { ascending: false });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/webhooks/totalvoice', async (req, res) => {
  try {
    const e = req.body;
    const tvId = e.id || e.chamada_id || e.dados?.id;
    if (!tvId) return res.status(200).send('ok');
    const { data: chamada } = await supabase.from('chamadas').select('*').eq('totalvoice_id', tvId).maybeSingle();
    if (!chamada) return res.status(200).send('ok');
    const patch = { atualizada_em: new Date().toISOString() };
    if (e.status) patch.status = sanitizeStr(e.status, 50);
    if (e.duracao_segundos !== undefined) { const d = parseInt(e.duracao_segundos, 10); patch.duracao_segundos = Number.isFinite(d) && d >= 0 ? d : 0; }
    if (e.url_gravacao) patch.url_gravacao = sanitizeStr(e.url_gravacao, 500);
    await supabase.from('chamadas').update(patch).eq('id', chamada.id);
    res.status(200).send('ok');
  } catch (e) {
    console.error('❌ webhook tv:', e);
    res.status(500).send('erro');
  }
});

// ========== WHATSAPP ==========
app.post('/api/leads/:id/whatsapp', requireAuth, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { data: lead, error } = await supabase.from('leads').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (!lead.telefone) return res.status(400).json({ error: 'Lead sem telefone' });
    if (!whatsapp.temToken()) return res.status(503).json({ error: 'WhatsApp Cloud API não configurada' });
    const { texto, templateName, variaveis } = req.body;
    let resultado;
    if (!templateName && !texto) return res.status(400).json({ error: 'texto ou templateName obrigatorio' });
    if (templateName) {
      resultado = await whatsapp.enviarTemplate({ para: lead.telefone, templateName, variaveis });
    } else {
      resultado = await whatsapp.enviarTexto({ para: lead.telefone, texto });
    }
    await supabase.from('mensagens').insert({
      lead_id: lead.id, direcao: 'enviada', canal: 'sdr',
      texto: sanitizeStr(texto || '[template:' + sanitizeStr(templateName, 100) + ']', 4000),
      wa_id: resultado.messages?.[0]?.id || '',
    });
    await supabase.from('leads').update({ ultimo_contato: new Date().toISOString() }).eq('id', lead.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ wa send:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/leads/:id/mensagens', requireAuth, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID invalido' });
    const { data, error } = await supabase.from('mensagens').select('*').eq('lead_id', id).order('id', { ascending: true });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/leads/:id/broadcast', requireAuth, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { data: lead, error } = await supabase.from('leads').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (!lead.telefone) return res.status(400).json({ error: 'Lead sem telefone' });
    if (!whatsapp.temBroadcast()) return res.status(503).json({ error: 'Número de broadcast não configurado.' });
    const { templateName, variaveis = [], lang = 'pt_BR' } = req.body;
    if (!templateName) return res.status(400).json({ error: 'templateName obrigatório' });
    const resultado = await whatsapp.enviarBroadcast({ para: lead.telefone, templateName, variaveis, lang });
    const vars = variaveis.length ? ' | ' + variaveis.slice(0, 10).map(v => sanitizeStr(String(v), 100)).join(', ') : '';
    await supabase.from('mensagens').insert({
      lead_id: lead.id, direcao: 'enviada', canal: 'broadcast',
      texto: sanitizeStr('[template: ' + sanitizeStr(templateName, 100) + vars + ']', 4000),
      wa_id: resultado.messages?.[0]?.id || '',
    });
    await supabase.from('leads').update({ ultimo_contato: new Date().toISOString() }).eq('id', lead.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ broadcast:', e);
    res.status(500).json({ error: e.message });
  }
});

// ========== TEMPLATES ==========
app.get('/api/templates', requireAuth, rateLimit, async (req, res) => {
  try {
    const { data: dbTpls, error } = await supabase.from('templates').select('*').order('id');
    if (error) throw error;
    const envNames = (process.env.WA_TEMPLATES || '').split(',').map(t => t.trim()).filter(Boolean);
    const envObjs = envNames
      .filter(n => !(dbTpls || []).find(t => t.nome === n))
      .map(n => ({ id: null, nome: n, titulo: n, corpo: '', categoria: 'MARKETING', status: 'aprovado' }));
    res.json([...(dbTpls || []), ...envObjs]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/templates', requireAuth, rateLimit, async (req, res) => {
  try {
    const { nome, titulo, corpo, categoria = 'MARKETING' } = req.body;
    if (!nome) return res.status(400).json({ error: 'nome obrigatório' });
    const nomeLimpo = sanitizeStr(nome, 100).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (!nomeLimpo) return res.status(400).json({ error: 'nome inválido' });
    const { data: dup } = await supabase.from('templates').select('id').eq('nome', nomeLimpo).maybeSingle();
    if (dup) return res.status(409).json({ error: 'Já existe um template com esse nome' });
    const { data: tpl, error } = await supabase.from('templates').insert({
      nome: nomeLimpo,
      titulo: sanitizeStr(titulo || nome, 200),
      corpo: sanitizeStr(corpo || '', 4000),
      categoria: ['MARKETING','UTILITY','AUTHENTICATION'].includes(categoria) ? categoria : 'MARKETING',
      status: 'pendente',
    }).select().single();
    if (error) throw error;
    res.json({ ok: true, template: tpl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/templates/:id', requireAuth, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { data: tpl, error: fetchErr } = await supabase.from('templates').select('*').eq('id', id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!tpl) return res.status(404).json({ error: 'Template não encontrado' });
    const STATUS_VALIDOS = ['pendente','submetido','aprovado','rejeitado','pausado','em_recurso'];
    const patch = {};
    for (const k of Object.keys(req.body)) {
      if (!['titulo','corpo','categoria','status'].includes(k)) continue;
      if (k === 'categoria' && !['MARKETING','UTILITY','AUTHENTICATION'].includes(req.body[k])) continue;
      if (k === 'status' && !STATUS_VALIDOS.includes(req.body[k])) continue;
      patch[k] = sanitizeStr(String(req.body[k]), 4000);
    }
    const { data: updated, error } = await supabase.from('templates').update(patch).eq('id', id).select().single();
    if (error) throw error;
    res.json({ ok: true, template: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/templates/:id', requireAuth, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { data: tpl } = await supabase.from('templates').select('id').eq('id', id).maybeSingle();
    if (!tpl) return res.status(404).json({ error: 'Template não encontrado' });
    const { error } = await supabase.from('templates').delete().eq('id', id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== TEMPLATES META API ==========
const WA_BUSINESS_ACCOUNT_ID = process.env.WA_BUSINESS_ACCOUNT_ID || '938428135727130';
const META_TPL_API = 'https://graph.facebook.com/v21.0/' + WA_BUSINESS_ACCOUNT_ID + '/message_templates';

app.post('/api/templates/:id/submeter-meta', requireAuth, rateLimit, async (req, res) => {
  try {
    const TOKEN = process.env.META_ACCESS_TOKEN;
    if (!TOKEN) return res.status(503).json({ error: 'META_ACCESS_TOKEN não configurado' });
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID invalido' });
    const { data: tpl, error: fetchErr } = await supabase.from('templates').select('*').eq('id', id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!tpl) return res.status(404).json({ error: 'Template não encontrado' });
    const matches = (tpl.corpo || '').match(/\{\{(\d+)\}\}/g) || [];
    const numVars = matches.length ? Math.max(...matches.map(m => parseInt(m.replace(/\D/g,'')))) : 0;
    const components = [];
    if (tpl.corpo) {
      const comp = { type: 'BODY', text: tpl.corpo };
      if (numVars > 0) comp.example = { body_text: [Array.from({length: numVars}, (_, i) => 'Exemplo ' + (i+1))] };
      components.push(comp);
    }
    const payload = { name: tpl.nome, language: 'pt_BR', category: tpl.categoria || 'UTILITY', components };
    const r = await fetch(META_TPL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message || 'Erro na Meta API' });
    await supabase.from('templates').update({ status: 'submetido', meta_id: data.id || null }).eq('id', id);
    res.json({ ok: true, meta_id: data.id, status: 'submetido' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/templates/sync-meta', requireAuth, rateLimit, async (req, res) => {
  try {
    const TOKEN = process.env.META_ACCESS_TOKEN;
    if (!TOKEN) return res.status(503).json({ error: 'META_ACCESS_TOKEN não configurado' });
    let url = META_TPL_API + '?fields=name,status,category,components&limit=200';
    const allMeta = [];
    let _pagina = 0;
    while (url && _pagina < 20) { _pagina++;
      const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + TOKEN } });
      const data = await r.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      if (data.data) allMeta.push(...data.data);
      url = data.paging?.next || null;
    }
    const STATUS_MAP = { APPROVED: 'aprovado', PENDING: 'submetido', REJECTED: 'rejeitado', PAUSED: 'pausado', DISABLED: 'pausado', IN_APPEAL: 'em_recurso', PENDING_DELETION: 'pendente' };
    const { data: localTpls } = await supabase.from('templates').select('*');
    const tpls = localTpls || [];
    let atualizados = 0;
    for (const tpl of tpls) {
      const metaTpl = allMeta.find(m => m.name === tpl.nome);
      if (metaTpl) {
        const novoStatus = STATUS_MAP[metaTpl.status] || metaTpl.status.toLowerCase();
        const patch = {};
        if (tpl.status !== novoStatus) { patch.status = novoStatus; atualizados++; }
        if (metaTpl.id && !tpl.meta_id) patch.meta_id = metaTpl.id;
        if (Object.keys(patch).length) await supabase.from('templates').update(patch).eq('id', tpl.id);
      }
    }
    let importados = 0;
    const nomesLocais = new Set(tpls.map(t => t.nome));
    const toImport = [];
    for (const m of allMeta) {
      if (nomesLocais.has(m.name)) continue;
      const bodyComp = (m.components || []).find(c => c.type === 'BODY');
      const cat = ['MARKETING','UTILITY','AUTHENTICATION'].includes(m.category) ? m.category : 'MARKETING';
      const titulo = m.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      toImport.push({ nome: m.name, titulo, corpo: bodyComp ? bodyComp.text : '', categoria: cat, status: STATUS_MAP[m.status] || m.status.toLowerCase(), meta_id: m.id || null });
    }
    if (toImport.length) {
      const { error: insErr } = await supabase.from('templates').insert(toImport);
      if (!insErr) importados = toImport.length;
    }
    res.json({ ok: true, atualizados, importados, total_meta: allMeta.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== IMPORTAR PACIENTES ==========
app.post('/api/leads/importar', requireAuth, rateLimit, async (req, res) => {
  try {
    const { pacientes } = req.body;
    if (!Array.isArray(pacientes) || !pacientes.length) return res.status(400).json({ error: 'pacientes deve ser array não vazio' });
    const lote = pacientes.slice(0, 5000);
    const telefones = lote.map(p => sanitizeStr(p.telefone || '', 30).replace(/\D/g, '')).filter(Boolean);
    let existentes = new Set();
    if (telefones.length) {
      const { data: dups } = await supabase.from('leads').select('telefone').in('telefone', [...new Set(telefones)]);
      (dups || []).forEach(d => existentes.add(d.telefone));
    }
    let importados = 0, duplicados = 0, erros = 0;
    const toInsert = [];
    for (const p of lote) {
      const nome = sanitizeStr(p.nome || 'Paciente importado');
      const telefone = sanitizeStr(p.telefone || '', 30).replace(/\D/g, '');
      if (!nome && !telefone) { erros++; continue; }
      if (telefone && existentes.has(telefone)) { duplicados++; continue; }
      if (telefone) existentes.add(telefone);
      toInsert.push({
        nome, telefone, email: sanitizeStr(p.email || '', 100), origem: sanitizeStr(p.origem || 'Importação', 100),
        campanha: '', conteudo: '', fbclid: '', gclid: '', ctwa_clid: '',
        status: 'Lead', valor: null, tipo_trat: '',
        notas_sdr: sanitizeStr(p.observacoes || '', 4000), notas_avaliacao: '', notas_comercial: '',
        score_interesse: null, perfil_disc: '',
        etiquetas: [], proximo_contato: null, ultimo_contato: null,
        enviado_meta: false, enviado_google: false, eventos_meta_enviados: [],
      });
      importados++;
    }
    if (toInsert.length) { const { error } = await supabase.from('leads').insert(toInsert); if (error) throw error; }
    res.json({ ok: true, importados, duplicados, erros });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== WEBHOOKS WHATSAPP ==========
app.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const vt = whatsapp.verifyToken();
  if (vt && mode === 'subscribe' && token === vt) {
    console.log('✅ Webhook WhatsApp verificado');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhooks/whatsapp', async (req, res) => {
  const APP_SECRET = process.env.META_APP_SECRET;
  if (APP_SECRET) {
    const sig = req.headers['x-hub-signature-256'] || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody || '').digest('hex');
    const sigBuf = Buffer.from(sig), expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      console.warn('⚠️  Webhook WA: assinatura inválida');
      return res.sendStatus(403);
    }
  }
  try {
    const m = whatsapp.parseMensagemRecebida(req.body);
    if (!m) return res.status(200).send('ok');
    let { data: lead } = await supabase.from('leads').select('*').eq('telefone', m.from).maybeSingle();
    if (!lead) {
      const { data: inserted, error: insertErr } = await supabase.from('leads').insert({
        nome: sanitizeStr(m.nome || 'Lead WhatsApp'),
        telefone: sanitizeStr(m.from, 30), email: '',
        origem: m.ctwa_clid ? 'Meta Ads' : 'WhatsApp Direto',
        campanha: sanitizeStr(m.ad_id || '', 200), conteudo: '', fbclid: '', gclid: '',
        ctwa_clid: sanitizeStr(m.ctwa_clid || '', 500),
        status: 'Lead', valor: null, tipo_trat: '',
        notas_sdr: '', notas_avaliacao: '', notas_comercial: '',
        score_interesse: null, perfil_disc: '',
        etiquetas: [], proximo_contato: null, ultimo_contato: new Date().toISOString(),
        enviado_meta: false, enviado_google: false, eventos_meta_enviados: [],
      }).select().single();
      if (insertErr) throw insertErr;
      lead = inserted;
      console.log('✅ Novo lead via WA: ' + m.nome + ' (' + m.from + ')' + (m.ctwa_clid ? ' [CTWA]' : ''));
      if (m.ctwa_clid && lead) dispararConversaoMeta(lead).catch(e => console.error('Meta CAPI:', e.message));
    } else {
      await supabase.from('leads').update({ ultimo_contato: new Date().toISOString() }).eq('id', lead.id);
    }
    if (lead) {
      await supabase.from('mensagens').insert({
        lead_id: lead.id, direcao: 'recebida', canal: 'sdr',
        texto: sanitizeStr(m.texto, 4000), wa_id: m.id || '',
      });
    }
    res.status(200).send('ok');
  } catch (e) {
    console.error('❌ webhook wa:', e);
    res.status(500).send('erro');
  }
});

// ========== META CAPI ==========
const META_PAGE_ID = process.env.META_PAGE_ID || '';
const META_API_VERSION = 'v21.0';

const EVENTOS_FUNIL = {
  'Lead':              'LeadSubmitted',
  'Agendado':          'Schedule',
  'Compareceu':        'Contact',
  'Em Avaliação':      null,
  'Orçamento Enviado': null,
  'Fechou':            'Purchase',
  'Perdido':           null,
};

async function dispararConversaoMeta(lead, eventoCustom = null) {
  const PIXEL = process.env.META_PIXEL_ID;
  const TOKEN = process.env.META_ACCESS_TOKEN;
  if (!PIXEL || !TOKEN) { console.log('⚠️  Meta CAPI não configurada'); return; }
  const eventName = eventoCustom || EVENTOS_FUNIL[lead.status];
  if (!eventName) { console.log('⏭️  Lead #' + lead.id + ' status "' + lead.status + '" não dispara CAPI'); return; }
  const isCTWA = !!lead.ctwa_clid;
  const action_source = isCTWA ? 'business_messaging' : 'website';
  const user_data = {};
  if (lead.telefone) user_data.ph = [sha256(lead.telefone)];
  if (lead.email) user_data.em = [sha256(lead.email)];
  if (lead.nome) user_data.fn = [sha256(lead.nome.split(' ')[0])];
  if (isCTWA) {
    user_data.ctwa_clid = lead.ctwa_clid;
    if (META_PAGE_ID) user_data.page_id = META_PAGE_ID;
  } else if (lead.fbclid) {
    user_data.fbc = 'fb.1.' + Math.floor(Date.now()/1000) + '.' + lead.fbclid;
  }
  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source,
      ...(isCTWA && { messaging_channel: 'whatsapp' }),
      event_id: 'lead_' + lead.id + '_' + eventName,
      user_data,
      custom_data: { currency: 'BRL', value: parseFloat(lead.valor) || 0 },
    }],
    ...(process.env.META_TEST_EVENT_CODE && { test_event_code: process.env.META_TEST_EVENT_CODE }),
  };
  try {
    const r = await fetch('https://graph.facebook.com/' + META_API_VERSION + '/' + PIXEL + '/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
      body: JSON.stringify(payload),
    });
    const json = await r.json();
    if (json.events_received) {
      console.log('📤 Meta CAPI ✓ Lead #' + lead.id + ' | evento: ' + eventName);
      const eventos = [...(lead.eventos_meta_enviados || [])];
      if (!eventos.includes(eventName)) eventos.push(eventName);
      const upd = { eventos_meta_enviados: eventos };
      if (eventName === 'Purchase') upd.enviado_meta = true;
      await supabase.from('leads').update(upd).eq('id', lead.id);
    } else {
      console.error('📤 Meta CAPI ✗ Lead #' + lead.id + ' | ' + eventName + ':', JSON.stringify(json).slice(0, 300));
    }
  } catch (e) {
    console.error('📤 Meta CAPI ERRO Lead #' + lead.id + ':', e.message);
  }
}

async function dispararConversaoGoogle(lead) {
  if (!lead.gclid) return;
  const csvPath = path.join(__dirname, 'google_conversions.csv');
  const header = 'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency\n';
  try { await fs.promises.access(csvPath); } catch { await fs.promises.writeFile(csvPath, header); }
  const conversionName = process.env.GOOGLE_CONVERSION_NAME || 'Tratamento Fechado';
  const time = lead.data_fechamento || nowLocal();
  const qf = v => '"' + String(v||'').replace(/"/g,'""') + '"';
  await fs.promises.appendFile(csvPath, qf(lead.gclid) + ',' + qf(conversionName) + ',' + qf(time) + ',' + (parseFloat(lead.valor) || 0) + ',BRL\n');
  console.log('📤 Google ✓ Lead #' + lead.id);
  await supabase.from('leads').update({ enviado_google: true }).eq('id', lead.id);
}

// ========== CAPTCHA MANUAL ==========
let _captchaPendente = null;

app.post('/api/nf-captcha', rateLimit, (req, res) => {
  const { img_b64 } = req.body;
  if (!img_b64) return res.status(400).json({ error: 'img_b64 obrigatório' });
  const token = crypto.randomBytes(16).toString('hex');
  _captchaPendente = { token, img_b64, resposta: null, criado_em: Date.now() };
  res.json({ ok: true, token });
});

app.get('/api/nf-captcha', (req, res) => {
  if (!_captchaPendente || Date.now() - _captchaPendente.criado_em > 120000) {
    _captchaPendente = null;
    return res.json({ pendente: false });
  }
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
  if (_captchaPendente.resposta) return res.json({ ok: true, digitos: _captchaPendente.resposta });
  res.json({ ok: false, aguardando: true });
});

// ========== NOTAS FISCAIS ==========
const NF_SISTEMAS = ['Vieira', 'Martins', 'Receita Saude'];
const NF_STATUS   = ['Pendente', 'Processando', 'Emitida', 'Erro'];

app.get('/api/notas-fiscais', async (req, res) => {
  try {
    const { sistema, status, competencia } = req.query;
    let query = supabase.from('notas_fiscais').select('*').order('id', { ascending: false });
    if (sistema) query = query.eq('sistema', sistema);
    if (status) query = query.eq('status', status);
    if (competencia) query = query.eq('competencia', competencia);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/notas-fiscais/pendentes', async (req, res) => {
  try {
    const { data, error } = await supabase.from('notas_fiscais').select('*').eq('status', 'Pendente');
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/notas-fiscais', rateLimit, async (req, res) => {
  try {
    const { sistema, competencia, tipo_tomador = 'CPF', cpf_tomador, nome_tomador,
      cpf_paciente = '', nome_paciente = '', parentesco = '', data_pagamento, valor, descricao = '' } = req.body;
    if (!sistema || !NF_SISTEMAS.includes(sistema)) return res.status(400).json({ error: 'sistema inválido. Use: ' + NF_SISTEMAS.join(', ') });
    if (!cpf_tomador || !nome_tomador) return res.status(400).json({ error: 'cpf_tomador e nome_tomador obrigatórios' });
    if (!competencia || !/^\d{2}-\d{4}$/.test(competencia)) return res.status(400).json({ error: 'competencia deve estar no formato MM-AAAA ex: 05-2026' });
    const { data: nota, error } = await supabase.from('notas_fiscais').insert({
      sistema: sanitizeStr(sistema, 30), competencia: sanitizeStr(competencia, 7), status: 'Pendente',
      tipo_tomador: tipo_tomador === 'CNPJ' ? 'CNPJ' : 'CPF',
      cpf_tomador: sanitizeStr(cpf_tomador, 20).replace(/\D/g, ''), nome_tomador: sanitizeStr(nome_tomador),
      cpf_paciente: sanitizeStr(cpf_paciente, 20).replace(/\D/g, ''), nome_paciente: sanitizeStr(nome_paciente),
      parentesco: sanitizeStr(parentesco, 50), data_pagamento: sanitizeStr(data_pagamento, 20),
      valor: parseFloat(String(valor).replace(',', '.')) || 0, descricao: sanitizeStr(descricao, 500), historico: [],
    }).select().single();
    if (error) throw error;
    res.json({ ok: true, nota });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/notas-fiscais/:id', rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'ID invalido' });
    const { data: nota, error: fetchErr } = await supabase.from('notas_fiscais').select('*').eq('id', id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!nota) return res.status(404).json({ error: 'Nota não encontrada' });
    const ALLOWED_EDIT = ['sistema','competencia','tipo_tomador','cpf_tomador','nome_tomador','cpf_paciente','nome_paciente','parentesco','data_pagamento','valor','descricao'];
    const ALLOWED_RESULT = ['status','num_nota','data_emissao','caminho_pdf','erro_msg'];
    const statusAntes = nota.status;
    const quem = req.body.quem === 'sistema' ? 'sistema' : 'manual';
    const patch = {};
    for (const k of [...ALLOWED_EDIT, ...ALLOWED_RESULT]) {
      if (!(k in req.body)) continue;
      let v = req.body[k];
      if (k === 'status' && !NF_STATUS.includes(v)) return res.status(400).json({ error: 'status inválido. Use: ' + NF_STATUS.join(', ') });
      if (k === 'sistema' && !NF_SISTEMAS.includes(v)) continue;
      if (k === 'tipo_tomador') v = v === 'CNPJ' ? 'CNPJ' : 'CPF';
      if (k === 'competencia' && !/^\d{2}-\d{4}$/.test(String(v))) continue;
      if (k === 'valor') v = parseFloat(String(v).replace(',', '.')) || 0;
      if (typeof v === 'string') v = sanitizeStr(v, 500);
      patch[k] = v;
    }
    if (req.body.status && req.body.status !== statusAntes) {
      const hist = Array.isArray(nota.historico) ? nota.historico : [];
      hist.push({ de: statusAntes, para: patch.status || nota.status, quando: nowLocal(), quem });
      patch.historico = hist;
    }
    const { data: updated, error } = await supabase.from('notas_fiscais').update(patch).eq('id', id).select().single();
    if (error) throw error;
    res.json({ ok: true, nota: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/notas-fiscais/:id', rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'ID invalido' });
    const { data: nota } = await supabase.from('notas_fiscais').select('id,status').eq('id', id).maybeSingle();
    if (!nota) return res.status(404).json({ error: 'Nota não encontrada' });
    if (['Emitida','Processando'].includes(nota.status)) return res.status(400).json({ error: 'Não é possível excluir uma nota já emitida ou em processamento' });
    const { error } = await supabase.from('notas_fiscais').delete().eq('id', id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/notas-fiscais/lote', rateLimit, async (req, res) => {
  try {
    const { notas } = req.body;
    if (!Array.isArray(notas) || !notas.length) return res.status(400).json({ error: 'Campo notas deve ser um array não vazio' });
    if (notas.length > 200) return res.status(400).json({ error: 'Máximo de 200 notas por lote' });
    const erros = [], toInsert = [];
    for (let i = 0; i < notas.length; i++) {
      const b = notas[i]; const linha = i + 1;
      if (!b.sistema || !NF_SISTEMAS.includes(b.sistema)) { erros.push({ linha, msg: 'sistema inválido: "' + b.sistema + '"' }); continue; }
      if (!b.cpf_tomador || !b.nome_tomador) { erros.push({ linha, msg: 'cpf_tomador e nome_tomador obrigatórios' }); continue; }
      if (!b.competencia || !/^\d{2}-\d{4}$/.test(b.competencia)) { erros.push({ linha, msg: 'competencia inválida: "' + b.competencia + '"' }); continue; }
      toInsert.push({
        sistema: sanitizeStr(b.sistema, 30), competencia: sanitizeStr(b.competencia, 7), status: 'Pendente',
        tipo_tomador: b.tipo_tomador === 'CNPJ' ? 'CNPJ' : 'CPF',
        cpf_tomador: sanitizeStr(b.cpf_tomador, 20).replace(/\D/g, ''), nome_tomador: sanitizeStr(b.nome_tomador),
        cpf_paciente: sanitizeStr(b.cpf_paciente || '', 20).replace(/\D/g, ''), nome_paciente: sanitizeStr(b.nome_paciente || ''),
        parentesco: sanitizeStr(b.parentesco || '', 50), data_pagamento: sanitizeStr(b.data_pagamento || '', 20),
        valor: parseFloat(String(b.valor || '0').replace(',', '.')) || 0, descricao: sanitizeStr(b.descricao || '', 500), historico: [],
      });
    }
    const criadas = [];
    if (toInsert.length) { const { data: inserted, error } = await supabase.from('notas_fiscais').insert(toInsert).select(); if (error) throw error; criadas.push(...(inserted || [])); }
    res.json({ ok: true, criadas: criadas.length, erros });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/notas-fiscais/stats', async (req, res) => {
  try {
    const { sistema, status, competencia } = req.query;
    let query = supabase.from('notas_fiscais').select('status,valor');
    if (sistema) query = query.eq('sistema', sistema);
    if (status) query = query.eq('status', status);
    if (competencia) query = query.eq('competencia', competencia);
    const { data: notas, error } = await query;
    if (error) throw error;
    const arr = notas || [];
    res.json({
      total: arr.length,
      pendentes: arr.filter(n => n.status === 'Pendente').length,
      emitidas: arr.filter(n => n.status === 'Emitida').length,
      erros: arr.filter(n => n.status === 'Erro').length,
      valorEmitido: arr.filter(n => n.status === 'Emitida').reduce((s, n) => s + (parseFloat(n.valor) || 0), 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== CLINICORP / INADIMPLENTES ==========
function clinicorpGet(apiPath, params = {}) {
  return new Promise((resolve, reject) => {
    const user  = process.env.CLINICORP_USER  || 'clinicaama';
    const token = process.env.CLINICORP_TOKEN || '';
    const auth  = Buffer.from(user + ':' + token).toString('base64');
    const qs = new URLSearchParams({
      subscriber_id: process.env.CLINICORP_SUBSCRIBER_ID || 'clinicaama',
      business_id:   process.env.CLINICORP_BUSINESS_ID   || 'clinicaama',
      ...params,
    }).toString();
    const opts = {
      hostname: 'api.clinicorp.com',
      path: '/rest/v1' + apiPath + '?' + qs,
      method: 'GET',
      headers: { 'Authorization': 'Basic ' + auth, 'X-Api-Key': token, 'Accept': 'application/json' },
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
    const isPaid = i.PaymentReceived === 'X' ||
      (i.ReceivedDate && i.ReceivedDate !== '' && i.ReceivedDate !== '0001-01-01');
    if (isPaid) return;
    const dueDate = i.DueDate || i.due_date || i.PostDate || i.ScheduledDate || '';
    if (!dueDate) return;
    const amount = Number(i.Amount || i.TotalPostAmount || i.AmountWithDiscounts || 0);
    const isOverdue = dueDate < today;
    const isFuture  = dueDate >= today;
    if (!patMap[patId]) {
      patMap[patId] = {
        id: patId,
        name: i.PatientName || i.patientName || i.Patient_PersonName || 'Paciente ' + patId,
        phone: i.Phone || i.MobilePhone || i.phone || '',
        overdueAmount: 0, futureAmount: 0, overdueCount: 0,
        oldestDueDate: null, nextDueDate: null, treatmentValue: 0, paidValue: 0,
      };
    }
    const p = patMap[patId];
    if (isOverdue) {
      p.overdueAmount += amount; p.overdueCount++;
      if (!p.oldestDueDate || dueDate < p.oldestDueDate) p.oldestDueDate = dueDate;
    } else if (isFuture) {
      p.futureAmount += amount;
      if (!p.nextDueDate || dueDate < p.nextDueDate) p.nextDueDate = dueDate;
    }
    const tv = Number(i.TotalPostAmount || i.TreatmentValue || 0);
    if (tv) p.treatmentValue = Math.max(p.treatmentValue, tv);
    const pv = Number(i.AmountWithDiscounts || i.PaidValue || 0);
    if (pv) p.paidValue = Math.max(p.paidValue, pv);
  });
  const patients = Object.values(patMap).filter(p => p.overdueCount > 0);
  patients.forEach(p => {
    p.diasDeAtraso    = p.oldestDueDate ? Math.floor((todayDate - new Date(p.oldestDueDate)) / 86400000) : 0;
    p.diasParaProximo = p.nextDueDate   ? Math.floor((new Date(p.nextDueDate) - todayDate) / 86400000) : null;
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

async function mergeInadimplentesNotas(resultado) {
  const { data: notas } = await supabase.from('inadimplentes_notas').select('*');
  const nm = {};
  (notas || []).forEach(n => { nm[n.patient_id] = n; });
  const addN = arr => arr.map(p => {
    const n = nm[p.id] || {};
    return { ...p, responsavel: n.responsavel || '', proximoPasso: n.proximo_passo || '', obs: n.obs || '' };
  });
  return { ...resultado, grupo1: addN(resultado.grupo1), grupo2: addN(resultado.grupo2), grupo3: addN(resultado.grupo3) };
}

app.get('/api/inadimplentes', requireAuth, rateLimit, async (req, res) => {
  try {
    if (!process.env.CLINICORP_TOKEN) {
      return res.status(503).json({ error: 'CLINICORP_TOKEN não configurado. Adicione nas variáveis de ambiente.' });
    }
    const forceRefresh = req.query.refresh === '1';
    if (!forceRefresh) {
      const { data: cache } = await supabase.from('inadimplentes_cache').select('*').eq('id', 1).maybeSingle();
      if (cache && cache.data && cache.atualizado_em) {
        const ageMs = Date.now() - Number(cache.atualizado_em);
        if (ageMs < 2 * 60 * 60 * 1000) {
          const result = await mergeInadimplentesNotas(cache.data);
          return res.json({ ...result, from_cache: true, cache_min: Math.round(ageMs / 60000) });
        }
      }
    }
    const today   = nowLocal().slice(0, 10); // Brazil date, matches Clinicorp timezone
    const futDate = new Date(); futDate.setFullYear(futDate.getFullYear() + 3);
    const futStr  = futDate.toISOString().split('T')[0];
    let items = [], endpointUsado = '';
    const FROM = '2019-01-01';
    try {
      const r = await clinicorpGet('/payment/list', { from: FROM, to: futStr, date_type: 'postDate' });
      console.log('[Inadimplentes] /payment/list?postDate → HTTP ' + r.status + ', itens: ' + (Array.isArray(r.data) ? r.data.length : JSON.stringify(r.data).slice(0,120)));
      if (r.status === 200 && Array.isArray(r.data)) { items = r.data; endpointUsado = '/payment/list?postDate'; }
    } catch(e) { console.log('[Inadimplentes] /payment/list erro:', e.message); }
    if (!items.length) {
      return res.json({
        grupo1: [], grupo2: [], grupo3: [],
        totais: { pacientes: 0, valorTotal: 0, emCobranca: 0, renegociacao: 0, criticos: 0 },
        from_cache: false, endpoint: endpointUsado || 'nenhum',
        aviso: 'Nenhum dado retornado pela Clinicorp. Verifique as credenciais e tente novamente.',
      });
    }
    const processado = processarInadimplentes(items, today);
    await supabase.from('inadimplentes_cache').upsert({ id: 1, data: processado, atualizado_em: Date.now(), endpoint: endpointUsado });
    console.log('[Inadimplentes] ✅ ' + processado.totais.pacientes + ' inadimplentes via ' + endpointUsado);
    const result = await mergeInadimplentesNotas(processado);
    res.json({ ...result, from_cache: false, endpoint: endpointUsado });
  } catch(e) {
    console.error('❌ inadimplentes:', e);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/inadimplentes/nota/:patientId', requireAuth, rateLimit, async (req, res) => {
  try {
    const patient_id = sanitizeStr(req.params.patientId, 50);
    const { responsavel, proximoPasso, obs } = req.body;
    const patch = {};
    if (responsavel  !== undefined) patch.responsavel   = sanitizeStr(responsavel, 100);
    if (proximoPasso !== undefined) patch.proximo_passo = sanitizeStr(proximoPasso, 1000);
    if (obs          !== undefined) patch.obs           = sanitizeStr(obs, 2000);
    const { error } = await supabase.from('inadimplentes_notas')
      .upsert({ patient_id, ...patch }, { onConflict: 'patient_id' });
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== HEALTH CHECK ==========
app.get('/health', (req, res) => res.json({ ok: true }));

// ========== STATIC ==========
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^\/(?!api\/|lead(\?|$)|webhooks\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use((err, req, res, next) => {
  console.error('💥', err);
  res.status(500).json({ error: 'Erro interno' });
});

app.listen(PORT, () => {
  console.log('\n🦷 CRM Clínica em http://localhost:' + PORT);
  console.log('📱 WA básico: +' + WHATSAPP_NUMBER);
  console.log('📞 TotalVoice: ' + (totalvoice.temToken() ? 'configurada ✓' : 'não configurada'));
  console.log('💬 WA Cloud API: ' + (whatsapp.temToken() ? 'configurada ✓' : 'não configurada') + '\n');
});

