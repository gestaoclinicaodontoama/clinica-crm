// ============================================================
//  CRM CLINICA - Servidor Node.js (Supabase edition)
// ============================================================

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const totalvoice = require('./totalvoice');
const whatsapp = require('./whatsapp');

let _buildCommit = 'unknown';
try { _buildCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['pipe','pipe','ignore'] }).trim(); } catch (_) {}
const _buildDeployedAt = new Date().toISOString();

const PORT = parseInt(process.env.PORT, 10) || 3000;
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || '5531999999999').replace(/\D/g, '');
const FUNIL = ['Lead', 'Agendado', 'Compareceu', 'Em Avaliação', 'Orçamento Enviado', 'Fechou', 'Perdido'];

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('FATAL: SUPABASE_SERVICE_ROLE_KEY not set — RLS bypass unavailable, refusing to start');
  process.exit(1);
}

// --------- SUPABASE ---------
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY,
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

// ========== VERSION ==========
app.get('/api/version', (req, res) => {
  res.json({ commit: _buildCommit, deployedAt: _buildDeployedAt });
});

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

// ========== ROLE MIDDLEWARES ==========
async function loadProfile(req) {
  if (req.user.profile) return req.user.profile;
  const { data } = await supabase.from('profiles')
    .select('id, nome, roles').eq('id', req.user.id).maybeSingle();
  req.user.profile = data || { roles: [] };
  return req.user.profile;
}

function requireRole(...allowed) {
  return async (req, res, next) => {
    const p = await loadProfile(req);
    if (!allowed.some(r => (p.roles || []).includes(r))) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    next();
  };
}
const requireDentista = requireRole('dentista', 'admin', 'mod_avaliacao_dentista');
const requireGestor   = requireRole('gestor', 'admin');

// ========== ADMIN MIDDLEWARE ==========
// TODO(remover-em-2026-06-23): fallback de role em user_metadata
async function requireAdmin(req, res, next) {
  const p = await loadProfile(req);
  let roles = p.roles || [];
  if (roles.length === 0) {
    const metaRoles = req.user?.user_metadata?.roles || req.user?.app_metadata?.roles || [];
    // [deprecated] fallback: roles vindas de user_metadata enquanto profiles.roles não está populado
    if (metaRoles.length > 0) {
      console.warn('[deprecated] role from metadata for user ' + req.user.id);
      roles = metaRoles;
    }
  }
  if (!Array.isArray(roles) || !roles.includes('admin')) {
    return res.status(403).json({ error: 'Acesso restrito a administradores' });
  }
  next();
}

// ========== MODULO ATIVO MIDDLEWARE ==========
let _moduloAtivoCache = { value: null, ts: 0 };
async function requireModuloAtivo(req, res, next) {
  try {
    const now = Date.now();
    if (now - _moduloAtivoCache.ts > 30000) {
      const { data, error } = await supabase.from('avaliacao_dentista_config')
        .select('valor').eq('chave', 'modulo_ativo').maybeSingle();
      if (error) throw error;
      _moduloAtivoCache = { value: data?.valor ?? 'false', ts: now };
    }
    if (_moduloAtivoCache.value !== 'true') {
      res.set('Retry-After', '60');
      return res.status(503).json({ error: 'Módulo desativado' });
    }
    next();
  } catch (e) {
    next(e);
  }
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
    // Auto-confirma o email para que o usuario possa logar imediatamente
    await supabase.rpc('admin_confirm_user', { p_admin_id: req.user.id, p_email: email });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { roles, nome } = req.body;
    if (!Array.isArray(roles)) return res.status(400).json({ error: 'roles deve ser array' });
    const { data, error } = await supabase.rpc('admin_update_user_roles', {
      p_admin_id: req.user.id,
      p_user_id:  req.params.id,
      p_roles:    roles,
      p_nome:     nome || null,
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

app.get('/api/notas-fiscais/:id/pdf', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'ID invalido' });
    const { data: nota } = await supabase.from('notas_fiscais').select('id,caminho_pdf,num_nota').eq('id', id).maybeSingle();
    if (!nota) return res.status(404).json({ error: 'Nota não encontrada' });
    const cp = nota.caminho_pdf || '';
    if (!cp) return res.status(404).json({ error: 'PDF não disponível para esta nota' });
    // Se caminho_pdf é uma URL HTTP (URL de impressão do SIGISS), redireciona
    if (cp.startsWith('http')) return res.redirect(cp);
    // Se é um caminho de arquivo local, serve o arquivo
    const fs = require('fs');
    if (!fs.existsSync(cp)) return res.status(404).json({ error: 'Arquivo PDF não encontrado no servidor' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="NF-${nota.num_nota || id}.pdf"`);
    fs.createReadStream(cp).pipe(res);
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


// GET /api/pacientes/clinicorp/:termo — lookup por CPF ou nome, usado no formulario NF
app.get('/api/pacientes/clinicorp/:termo', requireAuth, rateLimit, async (req, res) => {
  const raw = decodeURIComponent(req.params.termo || '').trim();
  if (!raw) return res.status(400).json({ error: 'Termo invalido' });

  const soDigitos = raw.replace(/\D/g, '');
  // isCpf: 11 dígitos exatos (com ou sem formatação padrão xxx.xxx.xxx-xx)
  const isCpf = soDigitos.length === 11;
  const isNome = /[a-zA-ZÀ-ú]/.test(raw);

  try {
    // 1. Histórico local: busca em notas_fiscais (dados já usados em notas anteriores)
    // Mais rápido e confiável que Clinicorp API — não tem limite de taxa.
    if (isCpf) {
      const { data } = await supabase
        .from('notas_fiscais').select('cpf_tomador,nome_tomador')
        .eq('cpf_tomador', soDigitos)
        .order('id', { ascending: false }).limit(1).maybeSingle();
      if (data?.nome_tomador) {
        console.log(`[lookup-nf] CPF "${soDigitos}" encontrado no histórico NF`);
        return res.json({ cpf: data.cpf_tomador, nome: data.nome_tomador, fonte: 'historico' });
      }
    } else if (isNome) {
      const { data } = await supabase
        .from('notas_fiscais').select('cpf_tomador,nome_tomador')
        .ilike('nome_tomador', `%${raw}%`)
        .order('id', { ascending: false }).limit(1).maybeSingle();
      if (data?.nome_tomador) {
        console.log(`[lookup-nf] Nome "${raw}" encontrado no histórico NF`);
        return res.json({ cpf: data.cpf_tomador || '', nome: data.nome_tomador, fonte: 'historico' });
      }
    }

    // 2. Clinicorp API (fallback para pacientes sem histórico de NF)
    try {
      const params = isCpf ? { OtherDocumentId: soDigitos } : { Name: raw };
      const resp = await clinicorpGet('/patient/get', params);
      console.log(`[lookup-nf] "${raw}" clinicorp → status=${resp?.status}`);
      const list = Array.isArray(resp?.data) ? resp.data : (resp?.data?.Name ? [resp.data] : []);
      const p = list[0];
      if (p?.Name) return res.json({ cpf: (p.OtherDocumentId || '').replace(/\D/g, ''), nome: p.Name, fonte: 'clinicorp' });
    } catch (apiErr) {
      console.error(`[lookup-nf] clinicorp erro:`, apiErr.message);
    }

    return res.status(404).json({ error: 'Paciente nao encontrado' });
  } catch (e) {
    console.error('lookup paciente erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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

// ========== CRC POS TRATAMENTO ==========
app.post('/api/crc/sincronizar-novos', async (req, res) => {
  try {
    if (!process.env.CLINICORP_TOKEN)
      return res.status(503).json({ error: 'CLINICORP_TOKEN nao configurado', inserted: 0 });
    const since = new Date(); since.setDate(since.getDate() - 14);
    const sinceStr = since.toISOString().slice(0, 10);
    let payments = [];
    try { const r = await clinicorpGet('/payment/list', { startDate: sinceStr }); payments = r?.data || []; }
    catch { return res.json({ inserted: 0, skipped: 0, msg: 'Clinicorp indisponivel' }); }
    const payArr = Array.isArray(payments) ? payments : (payments?.Items || payments?.items || []);
    const uniqueIds = [...new Set(payArr.map(p => String(p.PatientId || p.patientId || '')).filter(Boolean))];
    if (!uniqueIds.length) return res.json({ inserted: 0, skipped: 0, msg: 'Sem novos pagamentos' });
    const existing = new Set();
    const chunkSize = 500;
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
      const chunk = uniqueIds.slice(i, i + chunkSize).map(Number);
      const { data } = await supabase.from('pacientes').select('clinicorp_id').in('clinicorp_id', chunk);
      (data || []).forEach(r => existing.add(String(r.clinicorp_id)));
    }
    const newIds = uniqueIds.filter(id => !existing.has(id));
    if (!newIds.length) return res.json({ inserted: 0, skipped: uniqueIds.length, msg: 'Todos ja cadastrados' });
    let inserted = 0;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (const id of newIds.slice(0, 100)) {
      try {
        const resp = await clinicorpGet('/patient/get', { PatientId: String(id) });
        const p = resp?.data;
        if (!p || !p.Name) continue;
        const birth = (p.BirthDate || '').replace(/T.*/, '');
        await supabase.from('pacientes').upsert({
          clinicorp_id: Number(id), nome: p.Name || '',
          data_nascimento: birth && birth >= '1900-01-01' && birth < new Date().toISOString().slice(0,10) ? birth : null,
          telefone_celular: p.MobilePhone || '', telefone_fixo: p.Landline || '',
          email: p.Email || '', cidade: p.City || '', estado: p.state || '',
          bairro: p.Neighborhood || '', como_conheceu: p.HowDidMeet || '',
          plano_saude: p.insurancePlanName || '', ativo: (p.Active || '') === 'X',
          inserido_em: p.InsertDate || new Date().toISOString(),
        }, { onConflict: 'clinicorp_id' });
        inserted++;
        await sleep(120);
      } catch { /* skip */ }
    }
    res.json({ ok: true, inserted, skipped: uniqueIds.length - newIds.length });
  } catch (e) {
    console.error('CRC sincronizar-novos erro:', e.message);
    res.status(500).json({ error: e.message, inserted: 0 });
  }
});

app.post('/api/crc/rebuscar-telefones', async (req, res) => {
  try {
    if (!process.env.CLINICORP_TOKEN)
      return res.status(503).json({ error: 'CLINICORP_TOKEN nao configurado', updated: 0 });
    const { data: missing } = await supabase.from('pacientes_abc')
      .select('clinicorp_id').in('classe', ['A', 'B'])
      .or('telefone.is.null,telefone.eq.').limit(200);
    if (!missing || !missing.length) return res.json({ updated: 0, msg: 'Todos ja tem telefone' });
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let updated = 0;
    for (const row of missing) {
      try {
        const resp = await clinicorpGet('/patient/get', { PatientId: String(row.clinicorp_id) });
        const p = resp?.data;
        const phone = p?.MobilePhone || p?.Landline || '';
        if (!phone) continue;
        await supabase.from('pacientes').update({ telefone_celular: p.MobilePhone || '', telefone_fixo: p.Landline || '', atualizado_em: new Date().toISOString() }).eq('clinicorp_id', row.clinicorp_id);
        await supabase.from('pacientes_abc').update({ telefone: phone }).eq('clinicorp_id', row.clinicorp_id);
        updated++;
        await sleep(150);
      } catch { /* skip */ }
    }
    res.json({ ok: true, updated, total: missing.length });
  } catch (e) {
    console.error('CRC rebuscar-telefones erro:', e.message);
    res.status(500).json({ error: e.message, updated: 0 });
  }
});
// ========== CRC SYNC ABC COMPLETO ==========
// Recalcula ABC completo usando pagamentos + agendamentos do Clinicorp
// POST /api/crc/sync-abc-completo → dispara em background, retorna imediatamente
app.post('/api/crc/sync-abc-completo', async (req, res) => {
  res.json({ ok: true, msg: 'Sync ABC iniciado em background — pode demorar alguns minutos' });

  (async function runSyncABC() {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const today = new Date().toISOString().slice(0, 10);
    const futureEnd = new Date(); futureEnd.setMonth(futureEnd.getMonth() + 6);
    const futureStr = futureEnd.toISOString().slice(0, 10);

    // Helper: fetch Clinicorp JSON, handling duplicate-key issue
    async function fetchC(path, params) {
      const resp = await clinicorpGet(path, params);
      const data = resp?.data;
      return Array.isArray(data) ? data : (data ? [data] : []);
    }

    console.log('[sync-abc] Iniciando sync completo...');

    // 1. Fetch ALL payments in 6-month chunks (2023 to today)
    const allPayments = [];
    const payChunks = [
      ['2023-01-01','2023-06-30'],['2023-07-01','2023-12-31'],
      ['2024-01-01','2024-06-30'],['2024-07-01','2024-12-31'],
      ['2025-01-01','2025-06-30'],['2025-07-01','2025-12-31'],
      ['2026-01-01', today],
    ];
    for (const [from, to] of payChunks) {
      try {
        const rows = await fetchC('/payment/list', { from, to });
        allPayments.push(...rows.filter(r => !r.Canceled && r.PatientId));
        console.log(`[sync-abc] payments ${from}: ${rows.length} (total ${allPayments.length})`);
      } catch (e) { console.error(`[sync-abc] payment chunk ${from}:`, e.message); }
      await sleep(1200);
    }

    // 2. Fetch appointments (past 3yr + future 6mo)
    const allAppts = [];
    const apptChunks = [
      ['2023-01-01','2023-06-30'],['2023-07-01','2023-12-31'],
      ['2024-01-01','2024-06-30'],['2024-07-01','2024-12-31'],
      ['2025-01-01','2025-06-30'],['2025-07-01','2025-12-31'],
      ['2026-01-01', futureStr],
    ];
    for (const [from, to] of apptChunks) {
      try {
        const rows = await fetchC('/appointment/list', { from, to });
        allAppts.push(...rows.filter(r => !r.Deleted && (r.Patient_PersonId || r.PatientId)));
        console.log(`[sync-abc] appts ${from}: ${rows.length} (total ${allAppts.length})`);
      } catch (e) { console.error(`[sync-abc] appt chunk ${from}:`, e.message); }
      await sleep(1200);
    }

    // 3. Build per-patient map from payments
    const patMap = {};
    allPayments.forEach(r => {
      const id = String(r.PatientId);
      if (!patMap[id]) patMap[id] = { clinicorp_id: Number(id), nome: r.PatientName || '', telefone: r.MobilePhone || r.Phone || '', total_receita: 0, qtd_procedimentos: 0, ultimo_pagamento: null, ultima_visita: null, proxima_consulta: null, qtd_comparecimentos: 0 };
      const amt = Number(r.Amount || r.TotalPostAmount || 0);
      if (amt > 0) { patMap[id].total_receita += amt; patMap[id].qtd_procedimentos++; }
      const d = (r.ReceivedDate || r.CheckOutDate || r.PaymentDate || '').slice(0, 10);
      if (d && (!patMap[id].ultimo_pagamento || d > patMap[id].ultimo_pagamento)) patMap[id].ultimo_pagamento = d;
    });

    // 4. Process appointments
    allAppts.forEach(a => {
      const id = String(a.Patient_PersonId || a.PatientId || '');
      if (!id) return;
      const d = (a.date || a.Date || a.AppointmentDate || '').slice(0, 10);
      if (!d) return;
      if (!patMap[id]) patMap[id] = { clinicorp_id: Number(id), nome: a.PatientName || '', telefone: a.MobilePhone || '', total_receita: 0, qtd_procedimentos: 0, ultimo_pagamento: null, ultima_visita: null, proxima_consulta: null, qtd_comparecimentos: 0 };
      if (d >= today) {
        if (!patMap[id].proxima_consulta || d < patMap[id].proxima_consulta) patMap[id].proxima_consulta = d;
      } else if (a.CheckinTime) {
        patMap[id].qtd_comparecimentos++;
        if (!patMap[id].ultima_visita || d > patMap[id].ultima_visita) patMap[id].ultima_visita = d;
      }
    });

    // 5. Compute ABC classification (Pareto: A=top 80% revenue, B=80-95%, C=rest)
    const pats = Object.values(patMap).filter(p => p.total_receita > 0).sort((a, b) => b.total_receita - a.total_receita);
    const totalRev = pats.reduce((s, p) => s + p.total_receita, 0);
    let cum = 0;
    pats.forEach(p => {
      cum += p.total_receita;
      const pct = totalRev > 0 ? (cum / totalRev * 100) : 100;
      p.pct_acumulado = pct;
      p.classe = pct <= 80 ? 'A' : pct <= 95 ? 'B' : 'C';
      p.dias_sem_visita = p.ultima_visita ? Math.floor((Date.now() - new Date(p.ultima_visita)) / 86400000) : null;
    });

    // 6. Get paciente_id mapping from supabase in batches
    const ids = pats.map(p => p.clinicorp_id);
    const idMap = {};
    for (let i = 0; i < ids.length; i += 1000) {
      const { data } = await supabase.from('pacientes').select('id, clinicorp_id').in('clinicorp_id', ids.slice(i, i + 1000));
      (data || []).forEach(p => { idMap[p.clinicorp_id] = p.id; });
    }

    // 7. Upsert to pacientes_abc in batches of 100
    const now = new Date().toISOString();
    let upserted = 0;
    const rows = pats.filter(p => idMap[p.clinicorp_id]).map(p => ({
      paciente_id: idMap[p.clinicorp_id], clinicorp_id: p.clinicorp_id,
      nome: p.nome, telefone: p.telefone, total_receita: p.total_receita,
      qtd_procedimentos: p.qtd_procedimentos, qtd_comparecimentos: p.qtd_comparecimentos,
      ultima_visita: p.ultima_visita, ultimo_pagamento: p.ultimo_pagamento,
      proxima_consulta: p.proxima_consulta, pct_acumulado: p.pct_acumulado,
      classe: p.classe, dias_sem_visita: p.dias_sem_visita, sincronizado_em: now,
    }));
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await supabase.from('pacientes_abc').upsert(rows.slice(i, i + 100), { onConflict: 'clinicorp_id' });
      if (!error) upserted += Math.min(100, rows.length - i);
      await sleep(50);
    }
    console.log(`[sync-abc] Concluido: ${pats.length} pacientes processados, ${upserted} upserted`);
  })().catch(e => console.error('[sync-abc] fatal:', e.message));
});
// ========== CLINICORP SYNC DIÁRIO ==========
// Roda às 2h todo dia. Se atingir 24 req/hora, aguarda 1h10m automaticamente e continua.
const { runSync: runClinicorpSync } = require('./sync/clinicorp-sync');
const { AnalysisV1 } = require('./lib/schemas/analysis.v1');
const { FeedbackV1 } = require('./lib/schemas/feedback.v1');
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
(function agendarSyncDiario() {
  let lastSyncDay = '';

  async function executarSync() {
    const today = new Date().toISOString().slice(0, 10);
    if (lastSyncDay === today) return;
    lastSyncDay = today;
    const result = await runClinicorpSync();
    if (!result.ok) console.error('[sync-diario] falhou:', result.error);
  }

  // Calcula delay até a próxima 2h
  function msAteProximas2h() {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(2, 0, 0, 0);
    if (now >= next) next.setDate(next.getDate() + 1);
    return next - now;
  }

  // Agenda a primeira execução e depois repete a cada 24h
  setTimeout(function tick() {
    executarSync().catch(e => console.error('[sync-diario] erro:', e.message));
    setTimeout(tick, 24 * 60 * 60_000);
  }, msAteProximas2h());

  const h = Math.round(msAteProximas2h() / 60_000);
  console.log(`[sync-diario] Próximo sync em ~${h} min (às 2h00)`);
})();
// ========== SYNC MANUAL ==========
// POST /api/admin/sync-clinicorp  — dispara sync imediatamente (sem esperar as 2h)
app.post('/api/admin/sync-clinicorp', requireAuth, async (req, res) => {
  res.json({ ok: true, msg: 'Sync iniciado em background — acompanhe os logs do servidor' });
  runClinicorpSync().catch(e => console.error('[sync-manual] erro:', e.message));
});

// ========== AVALIAÇÃO DENTISTA (PRs 4, 6, 7) ==========
// Lazy requires — lib/ criada no PR 3 (pode não existir no startup se PR 3 não deployado ainda)
function geminiLib()   { return require('./lib/gemini'); }
function deepgramLib() { return require('./lib/deepgram'); }

function requireCronSecret(req, res, next) {
  const secret = process.env.EASYPANEL_CRON_SECRET;
  if (!secret || req.headers['x-cron-secret'] !== secret)
    return res.status(403).json({ error: 'Forbidden' });
  next();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i || j));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

async function dbRateLimit(chave, max, expiresInMs) {
  const expira = new Date(Date.now() + expiresInMs).toISOString();
  const { data, error } = await supabase.rpc('check_and_increment_rate_limit', { p_chave: chave, p_max: max, p_expira: expira });
  if (error) throw error;
  return typeof data === 'number';
}

const _configCache = new Map(); // chave -> { val, expiresAt }
const CONFIG_TTL_MS = 60_000;
async function getConfigVal(chave) {
  const cached = _configCache.get(chave);
  if (cached && Date.now() < cached.expiresAt) return cached.val;
  const { data } = await supabase.from('avaliacao_dentista_config').select('valor').eq('chave', chave).maybeSingle();
  const val = data?.valor ?? null;
  _configCache.set(chave, { val, expiresAt: Date.now() + CONFIG_TTL_MS });
  return val;
}

let _dashCache = { data: null, ts: 0 };

// ── Bootstrap / config ─────────────────────────────────────────────────────

app.get('/api/avaliacoes/config', requireAuth, async (req, res) => {
  try {
    const { data: configs } = await supabase.from('avaliacao_dentista_config').select('chave, valor');
    const cfg = Object.fromEntries((configs || []).map(r => [r.chave, r.valor]));
    const p = await loadProfile(req);
    let extras = {};
    if ((p.roles || []).some(r => ['dentista', 'admin'].includes(r))) {
      const { data: toks } = await supabase.rpc('tokens_efetivos_mes', { p_dentista: req.user.id });
      extras.tokens_mes_atual = toks ?? 0;
    }
    res.json({ ...cfg, ...extras });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/avaliacoes/tipos-tratamento', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('tipos_tratamento').select('*').eq('ativo', true).order('id');
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Deepgram token efêmero ─────────────────────────────────────────────────

app.post('/api/avaliacoes/deepgram-token', requireAuth, requireDentista, requireModuloAtivo, async (req, res) => {
  try {
    const limitPorHora = parseInt(await getConfigVal('rate_limit_deepgram_token_por_hora') || '120', 10);
    const hora = new Date().toISOString().slice(0, 13);
    const allowed = await dbRateLimit(`deepgram:token:${req.user.id}:${hora}`, limitPorHora, 3600 * 1000);
    if (!allowed) return res.status(429).json({ error: 'Limite de tokens Deepgram atingido. Aguarde.' });
    const { token, expiresAt } = await deepgramLib().createEphemeralToken();
    res.json({ token, expires_at: expiresAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Transcrição server-side (upload de áudio, async + polling) ────────────
// Browser envia arquivo → servidor responde imediatamente com jobId → cliente faz
// polling em GET /transcrever/:jobId até status=done|error. Evita timeout do proxy.

const _transcribeJobs = new Map(); // jobId → { status, result, error, userId }

app.post('/api/avaliacoes/transcrever',
  requireAuth, requireDentista, requireModuloAtivo,
  express.raw({ type: '*/*', limit: '300mb' }),
  (req, res) => {
    const jobId = crypto.randomUUID();
    const contentType = (req.headers['x-audio-content-type'] || req.headers['content-type'] || 'audio/mpeg')
      .split(';')[0].trim();
    const buffer = req.body; // Buffer from express.raw()

    _transcribeJobs.set(jobId, { status: 'pending', result: null, error: null, userId: req.user.id });
    res.json({ jobId }); // respond immediately — no proxy timeout

    deepgramLib().transcribeBuffer(buffer, contentType)
      .then(data => {
        const words = data.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
        _transcribeJobs.set(jobId, { status: 'done', result: { words }, error: null, userId: req.user.id });
      })
      .catch(e => {
        _transcribeJobs.set(jobId, { status: 'error', result: null, error: e.message, userId: req.user.id });
      });

    setTimeout(() => _transcribeJobs.delete(jobId), 15 * 60 * 1000); // cleanup after 15min
  }
);

app.get('/api/avaliacoes/transcrever/:jobId', requireAuth, requireDentista, (req, res) => {
  const job = _transcribeJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado ou expirado.' });
  if (job.userId !== req.user.id) return res.status(403).json({ error: 'Acesso negado.' });
  res.json({ status: job.status, result: job.result, error: job.error });
});

// ── Análise Gemini ─────────────────────────────────────────────────────────

app.post('/api/avaliacoes/analisar', requireAuth, requireDentista, requireModuloAtivo, async (req, res) => {
  req.socket.setTimeout(180000); // 3 min — Gemini can be slow on large transcripts
  try {
    const { consulta_id, transcript, contexto_prompt } = req.body;
    if (!consulta_id || !transcript) return res.status(400).json({ error: 'consulta_id e transcript obrigatórios' });
    if (!UUID_V4_RE.test(consulta_id)) return res.status(400).json({ error: 'consulta_id deve ser um UUID v4 válido' });

    // Idempotência: análise já salva para este consulta_id não chama Gemini de novo
    const { data: existing } = await supabase.from('consultas_spin')
      .select('analysis').eq('id', consulta_id).eq('dentista_id', req.user.id).maybeSingle();
    if (existing?.analysis) return res.json({ analysis: existing.analysis, cached: true });

    // Rate limit: 30/hora/dentista
    const hora = new Date().toISOString().slice(0, 13);
    const allowed = await dbRateLimit(`gemini:analisar:${req.user.id}:${hora}`, 30, 3600 * 1000);
    if (!allowed) return res.status(429).json({ error: 'Limite de análises por hora atingido.' });

    // Token budget mensal
    const maxTokens = parseInt(await getConfigVal('tokens_max_dentista_mes') || '5000000', 10);
    const { data: usados } = await supabase.rpc('tokens_efetivos_mes', { p_dentista: req.user.id });
    if ((usados || 0) >= maxTokens)
      return res.status(429).json({ error: 'Limite mensal de tokens atingido. Fale com o gestor.' });

    const result = await geminiLib().analyzeTranscript({ dentistId: req.user.id, transcript, contextoPrompt: contexto_prompt, consultaId: consulta_id, supabase });
    const totalToks = (result.tokensIn || 0) + (result.tokensOut || 0);
    if (totalToks > 0) { try { await supabase.rpc('increment_token_counter', { p_dentista: req.user.id, p_tokens: totalToks }); } catch (_) {} }
    res.json({ analysis: result.analysis, uso: { gemini_tokens_in: result.tokensIn, gemini_tokens_out: result.tokensOut, custo_usd: result.custoUsd } });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Dashboard KPIs ─────────────────────────────────────────────────────────

app.get('/api/avaliacoes/dashboard', requireAuth, requireGestor, async (req, res) => {
  try {
    const now = Date.now();
    const { desde, ate } = req.query;
    if (desde && !/^\d{4}-\d{2}-\d{2}$/.test(desde)) return res.status(400).json({ error: 'desde deve estar no formato YYYY-MM-DD' });
    if (ate   && !/^\d{4}-\d{2}-\d{2}$/.test(ate))   return res.status(400).json({ error: 'ate deve estar no formato YYYY-MM-DD' });
    // Cache de 60s só quando sem filtros customizados
    if (!desde && !ate && now - _dashCache.ts < 60000 && _dashCache.data)
      return res.json(_dashCache.data);
    const params = {};
    if (desde) params.p_desde = desde;
    if (ate)   params.p_ate   = ate;
    const { data, error } = await supabase.rpc('dashboard_avaliacao_dentista', params);
    if (error) throw error;
    const responsePayload = { data: data || [], regenerando: false };
    if (!desde && !ate) _dashCache = { data: responsePayload, ts: now };
    res.json(responsePayload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/avaliacoes/dentistas', requireAuth, requireGestor, async (req, res) => {
  try {
    const { data, error } = await supabase.from('profiles')
      .select('id, nome').filter('roles', 'cs', '{dentista}').order('nome');
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Benchmark ─────────────────────────────────────────────────────────────

app.post('/api/avaliacoes/benchmark', requireAuth, requireGestor, requireModuloAtivo, async (req, res) => {
  try {
    const { desde, ate } = req.body;
    if (!desde || !ate) return res.status(400).json({ error: 'desde e ate obrigatórios (YYYY-MM-DD)' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(ate))
      return res.status(400).json({ error: 'desde e ate devem estar no formato YYYY-MM-DD' });
    const maxBench = parseInt(await getConfigVal('benchmark_max_por_dia') || '3', 10);
    const dia = new Date().toISOString().slice(0, 10);
    const allowed = await dbRateLimit(`gemini:benchmark:${req.user.id}:${dia}`, maxBench, 86400 * 1000);
    if (!allowed) return res.status(429).json({ error: 'Limite de benchmarks por dia atingido.' });

    const desdeISO = new Date(desde + 'T00:00:00-03:00').toISOString();
    const ateISO   = new Date(ate   + 'T23:59:59-03:00').toISOString();
    const { data: consultas } = await supabase.from('consultas_spin')
      .select('dentista_id, nota_final')
      .gte('created_at', desdeISO).lte('created_at', ateISO)
      .not('nota_final', 'is', null);

    const byD = {};
    (consultas || []).forEach(c => {
      if (!byD[c.dentista_id]) byD[c.dentista_id] = { dentista_id: c.dentista_id, notas: [] };
      byD[c.dentista_id].notas.push(Number(c.nota_final));
    });
    const agregados = Object.values(byD).map(d => ({
      dentista_id: d.dentista_id,
      nota_media: d.notas.length ? +(d.notas.reduce((s, n) => s + n, 0) / d.notas.length).toFixed(2) : null,
      total_consultas: d.notas.length,
    }));

    const result = await geminiLib().gerarBenchmark({ agregados, periodo: { desde, ate } });

    const { data: bench, error: bErr } = await supabase.from('benchmark_spin').insert({
      gerado_por: req.user.id, periodo_inicio: desde, periodo_fim: ate,
      resultado: result.resultado, custo_usd: result.custoUsd || null,
    }).select().single();
    if (bErr) throw bErr;

    const knownIds = new Set(Object.keys(byD));
    const planos = (result.planos || []).filter(p => knownIds.has(p.dentista_id));
    if (planos.length) {
      const { error: planosErr } = await supabase.from('benchmark_spin_planos')
        .insert(planos.map(p => ({ benchmark_id: bench.id, dentista_id: p.dentista_id, plano: p.plano })));
      if (planosErr) throw planosErr;
    }

    res.json({ ok: true, benchmark: bench });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/avaliacoes/benchmark/ultimo', requireAuth, requireGestor, async (req, res) => {
  try {
    const { data: bench } = await supabase.from('benchmark_spin')
      .select('*, benchmark_spin_planos(*)').order('gerado_em', { ascending: false }).limit(1).maybeSingle();
    res.json(bench || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/avaliacoes/benchmark/meu-plano', requireAuth, requireDentista, async (req, res) => {
  try {
    const { data: bench } = await supabase.from('benchmark_spin')
      .select('id, gerado_em, periodo_inicio, periodo_fim').order('gerado_em', { ascending: false }).limit(1).maybeSingle();
    if (!bench) return res.json(null);
    const { data: plano } = await supabase.from('benchmark_spin_planos')
      .select('plano').eq('benchmark_id', bench.id).eq('dentista_id', req.user.id).maybeSingle();
    res.json({ ...bench, plano: plano?.plano || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Config admin ───────────────────────────────────────────────────────────

app.get('/api/avaliacoes/config/admin', requireAuth, requireGestor, async (req, res) => {
  try {
    const [{ data: configs }, { data: perfis }] = await Promise.all([
      supabase.from('avaliacao_dentista_config').select('*').order('chave'),
      supabase.from('dentista_perfil_spin').select('dentista_id, tokens_mes_ref, tokens_mes_atual, updated_at'),
    ]);
    res.json({ configs: configs || [], perfis: perfis || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/avaliacoes/config/admin', requireAuth, requireGestor, async (req, res) => {
  try {
    const ALLOWED = ['modulo_ativo','retencao_audio_dias','tokens_max_dentista_mes',
      'detalhar_max_por_dia','benchmark_max_por_dia','termo_lgpd_versao_atual',
      'rate_limit_deepgram_token_por_hora'];
    const updates = [];
    for (const [k, v] of Object.entries(req.body)) {
      if (!ALLOWED.includes(k)) continue;
      updates.push(supabase.from('avaliacao_dentista_config')
        .update({ valor: String(v), updated_by: req.user.id, updated_at: new Date().toISOString() })
        .eq('chave', k));
    }
    await Promise.all(updates);
    _moduloAtivoCache = { value: null, ts: 0 }; // invalida cache
    _configCache.clear(); // invalida cache de configs (rate limits, tokens, etc.)
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: reaceite de consentimento LGPD ──────────────────────────────────

app.post('/api/avaliacoes/admin/reaceite/:paciente_id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!UUID_V4_RE.test(req.params.paciente_id))
      return res.status(400).json({ error: 'paciente_id deve ser um UUID v4 válido' });
    const versao = await getConfigVal('termo_lgpd_versao_atual') || 'v1-admin-manual';
    const { error } = await supabase.from('pacientes')
      .update({ consentimento_gravacao: true, consentimento_gravacao_em: new Date().toISOString(), consentimento_gravacao_versao: versao })
      .eq('id', req.params.paciente_id)
      .or('consentimento_gravacao.is.null,consentimento_gravacao.eq.false');
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LGPD: purge em lote por paciente ──────────────────────────────────────

app.delete('/api/avaliacoes/lgpd/paciente/:paciente_id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { paciente_id } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(paciente_id))
      return res.status(400).json({ error: 'paciente_id deve ser um UUID v4 válido' });
    const { data: consultas } = await supabase.from('consultas_spin')
      .select('id').eq('paciente_id', paciente_id);
    const ids = (consultas || []).map(c => c.id);
    // Log first to guarantee audit trail even if delete subsequently fails
    const { error: logErr } = await supabase.from('audit_log').insert({
      tabela: 'consultas_spin', acao: 'DELETE', actor_id: req.user.id, source: 'frontend',
      dados_antes: { paciente_id, qtd_consultas: ids.length, ids },
    });
    if (logErr) throw logErr;
    if (ids.length)
      await supabase.from('consultas_spin').delete().eq('paciente_id', paciente_id);
    res.json({ ok: true, deletadas: ids.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CRUD consultas ─────────────────────────────────────────────────────────

app.post('/api/avaliacoes', requireAuth, requireDentista, requireModuloAtivo, async (req, res) => {
  try {
    const { id, paciente_id, paciente_nome, paciente_vinculado = true, lead_id,
      modo, started_at, ended_at, transcript, analysis, analysis_schema_version = 1,
      feedback_ia, uso, transcript_stats, tipo_tratamento_id, tipo_tratamento_outro,
      tratamento_valor_cents, tratamento_valor_label, planejamento_em,
      consentimento_manual_versao, consentimento_manual_em } = req.body;

    if (!id || !paciente_nome || !modo || !started_at || !analysis)
      return res.status(400).json({ error: 'Campos obrigatórios: id, paciente_nome, modo, started_at, analysis' });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      return res.status(400).json({ error: 'id deve ser um UUID v4 válido' });
    const analysisCheck = AnalysisV1.safeParse(analysis);
    if (!analysisCheck.success)
      return res.status(400).json({ error: 'analysis inválido', issues: analysisCheck.error.issues.slice(0, 3) });
    let validatedFeedback = null;
    if (feedback_ia != null) {
      const fbCheck = FeedbackV1.safeParse(feedback_ia);
      if (!fbCheck.success) return res.status(400).json({ error: 'feedback_ia inválido', issues: fbCheck.error.issues.slice(0, 3) });
      validatedFeedback = fbCheck.data;
    }
    if (!['deepgram','audio','texto'].includes(modo))
      return res.status(400).json({ error: 'modo inválido. Use: deepgram, audio, texto' });
    if (paciente_vinculado && !paciente_id)
      return res.status(400).json({ error: 'paciente_id obrigatório quando paciente_vinculado=true' });
    if (paciente_id && !UUID_V4_RE.test(paciente_id))
      return res.status(400).json({ error: 'paciente_id deve ser um UUID v4 válido' });

    // LGPD: paciente vinculado em modo gravado exige consentimento
    if (['deepgram','audio'].includes(modo) && paciente_vinculado && paciente_id) {
      const { data: pac } = await supabase.from('pacientes')
        .select('consentimento_gravacao').eq('id', paciente_id).maybeSingle();
      if (pac?.consentimento_gravacao !== true)
        return res.status(403).json({ error: 'Paciente não autorizou gravação. Obtenha o consentimento antes de salvar.' });
    }

    const row = {
      id, dentista_id: req.user.id,
      paciente_id: paciente_id || null,
      paciente_nome: String(paciente_nome).slice(0, 200),
      paciente_vinculado: !!paciente_vinculado,
      lead_id: lead_id != null ? (() => { const n = parseInt(lead_id, 10); if (isNaN(n)) throw Object.assign(new Error('lead_id deve ser um inteiro'), { status: 400 }); return n; })() : null,
      modo, started_at, ended_at: ended_at || null,
      transcript: transcript || null, analysis, analysis_schema_version,
      feedback_ia: validatedFeedback,
      uso: uso || null, transcript_stats: transcript_stats || null,
      tipo_tratamento_id: tipo_tratamento_id || null,
      tipo_tratamento_outro: tipo_tratamento_outro ? String(tipo_tratamento_outro).slice(0, 100) : null,
      tratamento_valor_cents: (() => { const tvc = tratamento_valor_cents != null ? parseInt(tratamento_valor_cents, 10) : null; if (tvc !== null && (isNaN(tvc) || tvc < 0)) throw Object.assign(new Error('tratamento_valor_cents deve ser um inteiro não-negativo'), { status: 400 }); return tvc; })(),
      tratamento_valor_label: tratamento_valor_label ? String(tratamento_valor_label).slice(0, 80) : null,
      planejamento_em: planejamento_em || null,
      consentimento_manual_versao: consentimento_manual_versao || null,
      consentimento_manual_em: consentimento_manual_em || null,
    };

    const { data: consulta, error } = await supabase.from('consultas_spin')
      .upsert(row, { onConflict: 'id', ignoreDuplicates: true })
      .select().maybeSingle();
    if (error) throw error;

    if (!consulta) {
      const { data: existente } = await supabase.from('consultas_spin')
        .select('*').eq('id', id).eq('dentista_id', req.user.id).maybeSingle();
      if (!existente) return res.status(409).json({ error: 'Conflito de ID: consulta pertence a outro dentista' });
      return res.json({ ok: true, consulta: existente, duplicate: true });
    }
    res.json({ ok: true, consulta });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/avaliacoes', requireAuth, async (req, res) => {
  try {
    const p = await loadProfile(req);
    const roles = p.roles || [];
    const isGestor  = roles.some(r => ['gestor','admin'].includes(r));
    const isDentista = roles.some(r => ['dentista','admin'].includes(r));
    if (!isGestor && !isDentista) return res.status(403).json({ error: 'Acesso negado' });

    const limitRaw  = parseInt(req.query.limit  || '50',  10);
    const offsetRaw = parseInt(req.query.offset || '0',   10);
    if (isNaN(limitRaw)  || limitRaw  < 0) return res.status(400).json({ error: 'limit deve ser um inteiro não-negativo' });
    if (isNaN(offsetRaw) || offsetRaw < 0) return res.status(400).json({ error: 'offset deve ser um inteiro não-negativo' });
    const limit  = Math.min(limitRaw, 200);
    const offset = offsetRaw;
    const { desde, ate, dentista_id, tipo } = req.query;
    if (desde && !/^\d{4}-\d{2}-\d{2}$/.test(desde)) return res.status(400).json({ error: 'desde deve estar no formato YYYY-MM-DD' });
    if (ate   && !/^\d{4}-\d{2}-\d{2}$/.test(ate))   return res.status(400).json({ error: 'ate deve estar no formato YYYY-MM-DD' });
    if (dentista_id && !UUID_V4_RE.test(dentista_id)) return res.status(400).json({ error: 'dentista_id deve ser um UUID v4 válido' });

    let query = supabase.from('consultas_spin')
      .select('id, dentista_id, paciente_id, paciente_nome, nota_final, modo, created_at, feedback_ia', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (isGestor) {
      if (dentista_id) query = query.eq('dentista_id', dentista_id);
    } else {
      query = query.eq('dentista_id', req.user.id);
    }
    if (desde) query = query.gte('created_at', new Date(desde + 'T00:00:00-03:00').toISOString());
    if (ate)   query = query.lte('created_at', new Date(ate   + 'T23:59:59-03:00').toISOString());
    if (tipo) {
      const tipoInt = parseInt(tipo, 10);
      if (isNaN(tipoInt) || tipoInt < 1) return res.status(400).json({ error: 'tipo deve ser um inteiro positivo' });
      query = query.eq('tipo_tratamento_id', tipoInt);
    }

    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ data: data || [], total: count || 0, limit, offset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Consentimento LGPD por dentista ───────────────────────────────────────

app.post('/api/avaliacoes/aceitar-consentimento', requireAuth, requireDentista, requireModuloAtivo, async (req, res) => {
  try {
    const { paciente_id, versao } = req.body;
    if (!paciente_id) return res.status(400).json({ error: 'paciente_id obrigatório' });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(paciente_id))
      return res.status(400).json({ error: 'paciente_id deve ser um UUID v4 válido' });
    // Only allow consent for patients this dentist has actually consulted
    const p = await loadProfile(req);
    const isGestor = (p.roles || []).some(r => ['gestor','admin'].includes(r));
    if (!isGestor) {
      const { data: check } = await supabase.from('consultas_spin')
        .select('id').eq('dentista_id', req.user.id).eq('paciente_id', paciente_id).limit(1).maybeSingle();
      if (!check) return res.status(403).json({ error: 'Paciente não vinculado a este dentista' });
    }
    const v = versao ? String(versao).slice(0, 50) : ((await getConfigVal('termo_lgpd_versao_atual')) || 'v1-2026-05-24');
    const { error } = await supabase.from('pacientes')
      .update({ consentimento_gravacao: true, consentimento_gravacao_em: new Date().toISOString(), consentimento_gravacao_versao: v })
      .eq('id', paciente_id)
      .is('consentimento_gravacao', null);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Detalhe e patches (rotas paramétricas após as estáticas) ───────────────

app.get('/api/avaliacoes/:id', requireAuth, async (req, res) => {
  try {
    if (!UUID_V4_RE.test(req.params.id)) return res.status(400).json({ error: 'id deve ser um UUID v4 válido' });
    const p = await loadProfile(req);
    const roles = p.roles || [];
    const { data: consulta, error } = await supabase.from('consultas_spin').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!consulta) return res.status(404).json({ error: 'Consulta não encontrada' });
    const isGestor = roles.some(r => ['gestor','admin'].includes(r));
    const isOwner = consulta.dentista_id === req.user.id;
    if (!isGestor && !isOwner) return res.status(403).json({ error: 'Acesso negado' });
    // Gestor access: strip patient transcript (LGPD — only the treating dentist reads raw speech)
    const payload = isOwner ? consulta : { ...consulta, transcript: null };
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/avaliacoes/:id/feedback', requireAuth, async (req, res) => {
  try {
    if (!UUID_V4_RE.test(req.params.id)) return res.status(400).json({ error: 'id deve ser um UUID v4 válido' });
    const p = await loadProfile(req);
    const roles = p.roles || [];
    const { data: consulta } = await supabase.from('consultas_spin').select('dentista_id').eq('id', req.params.id).maybeSingle();
    if (!consulta) return res.status(404).json({ error: 'Consulta não encontrada' });
    const isDono = consulta.dentista_id === req.user.id;
    const isAdmin = roles.includes('admin');
    if (!isDono && !isAdmin) return res.status(403).json({ error: 'Apenas o dentista dono pode dar feedback' });
    const { feedback_ia } = req.body;
    if (!feedback_ia) return res.status(400).json({ error: 'feedback_ia obrigatório' });
    const fbCheck = FeedbackV1.safeParse(feedback_ia);
    if (!fbCheck.success) return res.status(400).json({ error: 'feedback_ia inválido', issues: fbCheck.error.issues.slice(0, 3) });
    const { data, error } = await supabase.from('consultas_spin')
      .update({ feedback_ia: fbCheck.data, feedback_ia_em: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ ok: true, consulta: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/avaliacoes/:id/tratamento', requireAuth, async (req, res) => {
  try {
    if (!UUID_V4_RE.test(req.params.id)) return res.status(400).json({ error: 'id deve ser um UUID v4 válido' });
    const p = await loadProfile(req);
    const roles = p.roles || [];
    const { data: consulta } = await supabase.from('consultas_spin').select('dentista_id').eq('id', req.params.id).maybeSingle();
    if (!consulta) return res.status(404).json({ error: 'Consulta não encontrada' });
    const isAdmin = roles.includes('admin');
    if (consulta.dentista_id !== req.user.id && !isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const { tipo_tratamento_id, tipo_tratamento_outro, tratamento_valor_cents, tratamento_valor_label, planejamento_em } = req.body;
    const patch = {};
    if (tipo_tratamento_id  !== undefined) patch.tipo_tratamento_id  = tipo_tratamento_id || null;
    if (tipo_tratamento_outro !== undefined) patch.tipo_tratamento_outro = tipo_tratamento_outro ? String(tipo_tratamento_outro).slice(0, 100) : null;
    if (tratamento_valor_cents !== undefined) {
      const tvc = tratamento_valor_cents != null ? parseInt(tratamento_valor_cents, 10) : null;
      if (tvc !== null && (isNaN(tvc) || tvc < 0))
        return res.status(400).json({ error: 'tratamento_valor_cents deve ser um inteiro não-negativo' });
      patch.tratamento_valor_cents = tvc;
    }
    if (tratamento_valor_label !== undefined) patch.tratamento_valor_label = tratamento_valor_label ? String(tratamento_valor_label).slice(0, 80) : null;
    if (planejamento_em !== undefined) patch.planejamento_em = planejamento_em || null;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    const { data, error } = await supabase.from('consultas_spin').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ ok: true, consulta: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/avaliacoes/:id/paciente', requireAuth, async (req, res) => {
  try {
    if (!UUID_V4_RE.test(req.params.id)) return res.status(400).json({ error: 'id deve ser um UUID v4 válido' });
    const p = await loadProfile(req);
    const roles = p.roles || [];
    const { data: consulta } = await supabase.from('consultas_spin').select('dentista_id, paciente_nome, modo').eq('id', req.params.id).maybeSingle();
    if (!consulta) return res.status(404).json({ error: 'Consulta não encontrada' });
    const isGestor = roles.some(r => ['gestor','admin'].includes(r));
    if (consulta.dentista_id !== req.user.id && !isGestor) return res.status(403).json({ error: 'Acesso negado' });
    const { paciente_id } = req.body;
    if (!paciente_id) return res.status(400).json({ error: 'paciente_id obrigatório' });
    if (!UUID_V4_RE.test(paciente_id)) return res.status(400).json({ error: 'paciente_id deve ser um UUID v4 válido' });
    const { data: pac } = await supabase.from('pacientes').select('id, nome, consentimento_gravacao').eq('id', paciente_id).maybeSingle();
    if (!pac) return res.status(404).json({ error: 'Paciente não encontrado' });
    if (consulta.modo !== 'texto' && pac.consentimento_gravacao !== true) return res.status(403).json({ error: 'Paciente não autorizou gravação' });
    const a = consulta.paciente_nome.toLowerCase().trim();
    const b = pac.nome.toLowerCase().trim();
    const maxLen = Math.max(a.length, b.length);
    if (maxLen > 0 && levenshtein(a, b) / maxLen > 0.3)
      return res.status(409).json({ error: 'nome diverge', nome_consulta: consulta.paciente_nome, nome_paciente: pac.nome, mensagem: 'Nome diverge em mais de 30%. Confirme o vínculo.' });
    const { data, error } = await supabase.from('consultas_spin')
      .update({ paciente_id, paciente_vinculado: true }).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ ok: true, consulta: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/avaliacoes/:id/nome', requireAuth, async (req, res) => {
  try {
    if (!UUID_V4_RE.test(req.params.id)) return res.status(400).json({ error: 'id deve ser um UUID v4 válido' });
    const p = await loadProfile(req);
    const roles = p.roles || [];
    const { data: consulta } = await supabase.from('consultas_spin').select('dentista_id').eq('id', req.params.id).maybeSingle();
    if (!consulta) return res.status(404).json({ error: 'Consulta não encontrada' });
    const isGestor = roles.some(r => ['gestor','admin'].includes(r));
    if (consulta.dentista_id !== req.user.id && !isGestor) return res.status(403).json({ error: 'Acesso negado' });
    const nome = (req.body?.nome ?? '').toString().trim().slice(0, 120);
    if (!nome) return res.status(400).json({ error: 'nome não pode ser vazio' });
    const { data, error } = await supabase.from('consultas_spin')
      .update({ paciente_nome: nome }).eq('id', req.params.id).select('id, paciente_nome').single();
    if (error) throw error;
    res.json({ ok: true, paciente_nome: data.paciente_nome });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/avaliacoes/:id/reanalisar', requireAuth, requireRole('dentista', 'admin', 'gestor', 'mod_avaliacao_dentista'), requireModuloAtivo, async (req, res) => {
  try {
    if (!UUID_V4_RE.test(req.params.id)) return res.status(400).json({ error: 'id deve ser um UUID v4 válido' });
    req.socket.setTimeout(180000);

    const { data: consulta, error: consultaErr } = await supabase
      .from('consultas_spin')
      .select('id, dentista_id, transcript, modo')
      .eq('id', req.params.id)
      .maybeSingle();

    if (consultaErr) throw consultaErr;
    if (!consulta) return res.status(404).json({ error: 'Consulta não encontrada' });
    const userRoles = (req.user.profile?.roles) || [];
    const isAdminOrGestor = userRoles.includes('admin') || userRoles.includes('gestor');
    if (consulta.dentista_id !== req.user.id && !isAdminOrGestor) return res.status(403).json({ error: 'Acesso negado' });
    if (!consulta.transcript || (Array.isArray(consulta.transcript) && consulta.transcript.length === 0)) {
      return res.status(400).json({ error: 'Consulta sem transcrição para reanalisar' });
    }

    // Pass consultaId: null to bypass idempotency — forces a fresh Gemini call
    const { analysis, tokensIn, tokensOut, custoUsd } = await geminiLib().analyzeTranscript({
      dentistId: consulta.dentista_id,
      transcript: consulta.transcript,
      contextoPrompt: '',
      consultaId: null,
      supabase,
    });

    const { data: updated, error } = await supabase
      .from('consultas_spin')
      .update({ analysis, nota_final: analysis.nota_final })
      .eq('id', req.params.id)
      .select('id, nota_final')
      .single();
    if (error) throw error;

    const totalToks = tokensIn + tokensOut;
    if (totalToks > 0) {
      try { await supabase.rpc('increment_token_counter', { p_dentista: consulta.dentista_id, p_tokens: totalToks }); } catch (_) {}
    }

    res.json({ ok: true, nota_final: updated.nota_final, custoUsd });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/avaliacoes/:id/detalhar/:etapa_idx', requireAuth, requireDentista, requireModuloAtivo, async (req, res) => {
  try {
    if (!UUID_V4_RE.test(req.params.id)) return res.status(400).json({ error: 'id deve ser um UUID v4 válido' });
    const p = await loadProfile(req);
    const roles = p.roles || [];
    const etapaIdx = parseInt(req.params.etapa_idx, 10);
    if (isNaN(etapaIdx) || etapaIdx < 0 || etapaIdx > 7) return res.status(400).json({ error: 'etapa_idx deve ser 0–7' });
    const { data: consulta } = await supabase.from('consultas_spin').select('dentista_id, analysis').eq('id', req.params.id).maybeSingle();
    if (!consulta) return res.status(404).json({ error: 'Consulta não encontrada' });
    const isGestor = roles.some(r => ['gestor','admin'].includes(r));
    const isDono = consulta.dentista_id === req.user.id;
    if (!isDono && !isGestor) return res.status(403).json({ error: 'Acesso negado' });
    const etapa = consulta.analysis?.etapas?.[etapaIdx];
    if (!etapa) return res.status(404).json({ error: 'Etapa não encontrada na análise' });
    if (etapa.detalhe) return res.json({ detalhe: etapa.detalhe, cached: true });

    const dentistaId = isDono ? req.user.id : consulta.dentista_id;
    const maxDetalhar = parseInt(await getConfigVal('detalhar_max_por_dia') || '20', 10);
    const dia = new Date().toISOString().slice(0, 10);
    const allowed = await dbRateLimit(`gemini:detalhar:${dentistaId}:${dia}`, maxDetalhar, 86400 * 1000);
    if (!allowed) return res.status(429).json({ error: 'Limite de detalhamentos por dia atingido.' });

    const result = await geminiLib().detalharEtapa({ etapaIdx, etapaNome: etapa.nome, trechos: etapa.trechos || [], nota: etapa.nota, dentistId: dentistaId, supabase });
    const totalToks = (result.tokensIn || 0) + (result.tokensOut || 0);
    if (totalToks > 0) { try { await supabase.rpc('increment_token_counter', { p_dentista: dentistaId, p_tokens: totalToks }); } catch (_) {} }

    const analysis = JSON.parse(JSON.stringify(consulta.analysis));
    analysis.etapas[etapaIdx].detalhe = result.detalhe;
    const { error: updateErr } = await supabase.from('consultas_spin').update({ analysis }).eq('id', req.params.id);
    if (updateErr) throw updateErr;
    res.json({ detalhe: result.detalhe });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.delete('/api/avaliacoes/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!UUID_V4_RE.test(req.params.id)) return res.status(400).json({ error: 'id deve ser um UUID v4 válido' });
    const { data: consulta } = await supabase.from('consultas_spin')
      .select('id, dentista_id, paciente_id, created_at').eq('id', req.params.id).maybeSingle();
    if (!consulta) return res.status(404).json({ error: 'Consulta não encontrada' });
    const { error: logErr } = await supabase.from('audit_log').insert({
      tabela: 'consultas_spin', registro_id: consulta.id, acao: 'DELETE',
      actor_id: req.user.id, source: 'frontend',
      dados_antes: { id: consulta.id, dentista_id: consulta.dentista_id, paciente_id: consulta.paciente_id, created_at: consulta.created_at },
    });
    if (logErr) throw logErr;
    await supabase.from('consultas_spin').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Perfil SPIN do dentista ────────────────────────────────────────────────

app.get('/api/dentista/perfil', requireAuth, requireDentista, async (req, res) => {
  try {
    const p = await loadProfile(req);
    const isGestor = (p.roles || []).some(r => ['gestor','admin'].includes(r));
    const rawTarget = isGestor && req.query.dentista_id ? req.query.dentista_id : null;
    if (rawTarget && !UUID_V4_RE.test(rawTarget))
      return res.status(400).json({ error: 'dentista_id deve ser um UUID v4 válido' });
    const targetId = rawTarget || req.user.id;
    const { data, error } = await supabase.from('dentista_perfil_spin').select('*').eq('dentista_id', targetId).maybeSingle();
    if (error) throw error;
    res.json(data || { dentista_id: targetId, tokens_mes_atual: 0, areas_fracas: [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/dentista/perfil', requireAuth, requireDentista, async (req, res) => {
  try {
    const { contexto_prompt } = req.body;
    const patch = { updated_at: new Date().toISOString() };
    if (contexto_prompt !== undefined)
      patch.contexto_prompt = contexto_prompt ? String(contexto_prompt).slice(0, 2000) : null;
    const { data, error } = await supabase.from('dentista_perfil_spin')
      .upsert({ dentista_id: req.user.id, ...patch }, { onConflict: 'dentista_id' })
      .select().maybeSingle();
    if (error) throw error;
    res.json({ ok: true, perfil: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cron interno ───────────────────────────────────────────────────────────

app.post('/api/internal/cron/purga-lgpd', requireCronSecret, async (req, res) => {
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const { data: logHoje } = await supabase.from('audit_log')
      .select('id').eq('tabela', 'cron:purga-lgpd').gte('criado_em', hoje + 'T00:00:00Z').limit(1).maybeSingle();
    if (logHoje) return res.json({ ok: true, msg: 'Já executado hoje', skipped: true });
    const retencaoDias = parseInt(await getConfigVal('retencao_audio_dias') || '365', 10);
    const cutoff = new Date(Date.now() - retencaoDias * 86400 * 1000).toISOString();
    const { data: purged, error } = await supabase.from('consultas_spin')
      .update({ transcript: null, transcript_purgado_em: new Date().toISOString() })
      .lt('created_at', cutoff)
      .not('transcript', 'is', null)
      .is('transcript_purgado_em', null)
      .select('id');
    if (error) throw error;
    await supabase.from('audit_log').insert({
      tabela: 'cron:purga-lgpd', acao: 'UPDATE', source: 'cron',
      dados_depois: { purged_count: (purged || []).length, cutoff },
    });
    res.json({ ok: true, purged: (purged || []).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/internal/cron/insights-semanal', requireCronSecret, async (req, res) => {
  try {
    const seisAtras = new Date(Date.now() - 6 * 86400 * 1000).toISOString();
    const { data: logRecente } = await supabase.from('audit_log')
      .select('id').eq('tabela', 'cron:insights-semanal').gte('criado_em', seisAtras).limit(1).maybeSingle();
    if (logRecente) return res.json({ ok: true, msg: 'Já executado recentemente', skipped: true });
    const trintaAtras = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    const { data: consultas } = await supabase.from('consultas_spin')
      .select('dentista_id, feedback_ia').gte('created_at', trintaAtras).not('feedback_ia', 'is', null);
    const byDentista = {};
    (consultas || []).forEach(c => {
      if (!byDentista[c.dentista_id]) byDentista[c.dentista_id] = [];
      byDentista[c.dentista_id].push(c.feedback_ia);
    });
    let atualizados = 0;
    for (const [dentistaId, feedbacks] of Object.entries(byDentista)) {
      try {
        const result = await geminiLib().gerarInsights({ feedbacks });
        await supabase.from('dentista_perfil_spin').upsert({
          dentista_id: dentistaId, insights_gestor: result.slice(0, 10000),
          insights_updated_at: new Date().toISOString(),
        }, { onConflict: 'dentista_id' });
        atualizados++;
      } catch { /* continua para próximo dentista se falhar */ }
    }
    await supabase.from('audit_log').insert({
      tabela: 'cron:insights-semanal', acao: 'UPDATE', source: 'cron',
      dados_depois: { dentistas_atualizados: atualizados },
    });
    res.json({ ok: true, atualizados });
  } catch (e) {
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

