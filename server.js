// ============================================================
//  CRM CLINICA - Servidor Node.js (Supabase edition)
// ============================================================

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const totalvoice = require('./totalvoice');
const whatsapp = require('./whatsapp');
const threec = require('./lib/3cplus');
const threecCamp = require('./lib/3cplus-campanhas');
const { agregarFunil } = require('./lib/funil/agregar');
const { agregarFechamentos, temposPorFase } = require('./lib/funil/fechamentos');
const { resolvePeriodo } = require('./lib/funil/periodo');
const { montarDashboard } = require('./lib/funil/dashboard');
const { buscarEventosNovos } = require('./lib/monitor/queries');
const { montarMonitor } = require('./lib/monitor/diario');

const _upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
const webpush = require('web-push');
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:gestao.clinicaodontoama@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

function _webmToOgg(buffer) {
  const r = spawnSync('ffmpeg', ['-i','pipe:0','-c:a','libopus','-f','ogg','pipe:1'], {
    input: buffer, maxBuffer: 20 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('Conversão de áudio falhou');
  return r.stdout;
}

let _buildCommit = 'unknown';
try { _buildCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['pipe','pipe','ignore'] }).trim(); } catch (_) {}
const _buildDeployedAt = new Date().toISOString();

const PORT = parseInt(process.env.PORT, 10) || 3000;
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || '5531999999999').replace(/\D/g, '');
const FUNIL = ['Lead', 'Dra. Izabela', 'Em conversa - Lead Qualificado', 'Agendado', 'Faltou', 'Compareceu', 'Nutrir', 'Não tem Interesse', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'Reclassificar', 'Em nutrição', 'Fechou', 'Perdido'];

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

// --------- logEvento ---------
function logEvento(leadId, tipo, descricao, metadata = {}, usuarioId = null) {
  if (!leadId) return;
  supabase.from('lead_eventos').insert({
    lead_id: leadId, tipo, descricao, metadata,
    usuario_id: usuarioId || null,
  }).then(() => {}).catch(e => console.error('[logEvento]', e.message));
}

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
// Deriva origem de lead CTWA (Facebook/Instagram) a partir do source_url do referral
function _origemCTWA(referralData) {
  const u = ((referralData || {}).source_url || '').toLowerCase();
  if (/instagram\.com|ig\.me|instagr\.am/.test(u)) return 'Instagram';
  if (/facebook\.com|fb\.me|fb\.com|fb\.watch|fb\.gg/.test(u)) return 'Facebook';
  return 'Meta Ads';
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

// ========== CONFIG PÚBLICO ==========
app.get('/api/config/wa', requireAuth, async (req, res) => {
  try {
    const numbers = await whatsapp.getPhoneNumbers();
    // Auto-descobre IDs de números não presentes nos env vars (ex.: SDR sem WHATSAPP_PHONE_NUMBER_ID)
    try {
      const tok = process.env.WHATSAPP_API_TOKEN || process.env.WHATSAPP_CLOUD_TOKEN || '';
      if (tok) {
        const { data: rows } = await supabase.from('mensagens').select('wa_number_id')
          .not('wa_number_id', 'is', null).neq('wa_number_id', '').limit(200);
        const extraIds = [...new Set((rows||[]).map(r=>r.wa_number_id))].filter(id=>id&&!numbers[id]);
        for (const phoneId of extraIds.slice(0, 5)) {
          try {
            const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}?fields=display_phone_number&access_token=${tok}`);
            const d = await r.json();
            if (d.display_phone_number) {
              const digits = d.display_phone_number.replace(/\D/g, '');
              const last8 = digits.slice(-8);
              numbers[phoneId] = last8.length === 8 ? last8.slice(0,4)+'-'+last8.slice(4) : digits.slice(-4);
            } else { numbers[phoneId] = '...'+phoneId.slice(-4); }
          } catch {}
        }
      }
    } catch {}
    let defaultPhoneId = whatsapp.defaultPhoneId();
    if (!defaultPhoneId) {
      const broadcastId = process.env.WHATSAPP_BROADCAST_PHONE_ID || '';
      try {
        // Prefere o número que recebe mensagens dos leads (não o de broadcast)
        const { data: inc } = await supabase.from('mensagens').select('wa_number_id')
          .eq('direcao', 'recebida').not('wa_number_id', 'is', null).neq('wa_number_id', '')
          .neq('wa_number_id', broadcastId).order('id', { ascending: false }).limit(1);
        defaultPhoneId = inc?.[0]?.wa_number_id
          || Object.keys(numbers).find(k => k !== broadcastId)
          || Object.keys(numbers)[0] || '';
      } catch {
        defaultPhoneId = Object.keys(numbers).find(k => k !== broadcastId)
          || Object.keys(numbers)[0] || '';
      }
    }
    res.json({ numbers, defaultPhoneId });
  } catch (e) {
    res.json({ numbers: {}, defaultPhoneId: '' });
  }
});

// Lista CRC Lead para atribuição de responsabilidade
app.get('/api/crcs-lead', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('profiles')
      .select('id,nome').contains('roles', ['crc_leads']).eq('ativo', true).order('nome');
    if (error) throw error;
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
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
      threec_agent_token: profile?.threec_agent_token || null,
      threec_agent_ramal: profile?.threec_agent_ramal || null,
      nav_prefs: profile?.nav_prefs || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/me/threec-agent-token', requireAuth, async (req, res) => {
  try {
    const { threec_agent_token, threec_agent_ramal } = req.body;
    const patch = {};
    if (typeof threec_agent_token === 'string') patch.threec_agent_token = threec_agent_token.trim().slice(0, 200) || null;
    if (typeof threec_agent_ramal === 'string') patch.threec_agent_ramal = threec_agent_ramal.trim().slice(0, 20) || null;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nenhum campo informado' });

    // Auto-busca o ID numérico do agente na 3cplus via GET /api/v1/me
    if (patch.threec_agent_token) {
      try {
        const meRes = await threec.apiRequest('GET', '/api/v1/me', null, patch.threec_agent_token);
        if (meRes.status === 200) {
          const meData = JSON.parse(meRes.body);
          const numId = meData?.data?.id;
          if (numId) patch.threec_agent_id = numId;
        }
      } catch {}
    }

    const { error } = await supabase.from('profiles').update(patch).eq('id', req.user.id);
    if (error) throw error;
    res.json({ ok: true, threec_agent_id: patch.threec_agent_id || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// alias legado
app.patch('/api/me/threec-agent-id', requireAuth, async (req, res) => {
  try {
    const { threec_agent_id } = req.body;
    if (typeof threec_agent_id !== 'string') return res.status(400).json({ error: 'threec_agent_id deve ser string' });
    const val = threec_agent_id.trim().slice(0, 100);
    const { error } = await supabase.from('profiles').update({ threec_agent_id: val || null }).eq('id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Slugs de navegação válidos para a barra inferior mobile (nav_prefs.tabbar)
const NAV_SLUGS = new Set([
  'dashboard','leads','funil','conv-agendamentos','conv-avaliacao','disparos',
  'notas-fiscais','inadimplentes','usuarios','tarefas-gestor','config',
  'avaliacao-dentista','atribuicao','ligacoes',
  'aniversariantes','recall','vips',
]);
app.patch('/api/me/nav-prefs', requireAuth, async (req, res) => {
  try {
    const tabbar = req.body?.tabbar;
    if (!Array.isArray(tabbar)) return res.status(400).json({ error: 'tabbar deve ser array' });
    if (tabbar.length < 1 || tabbar.length > 4) return res.status(400).json({ error: 'tabbar deve ter de 1 a 4 itens' });
    const seen = new Set();
    for (const s of tabbar) {
      if (typeof s !== 'string' || !NAV_SLUGS.has(s)) return res.status(400).json({ error: 'slug inválido: ' + s });
      if (seen.has(s)) return res.status(400).json({ error: 'slug duplicado: ' + s });
      seen.add(s);
    }
    const { error } = await supabase.from('profiles').update({ nav_prefs: { tabbar } }).eq('id', req.user.id);
    if (error) throw error;
    res.json({ ok: true, tabbar });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== ROLE MIDDLEWARES ==========
async function loadProfile(req) {
  if (req.user.profile) return req.user.profile;
  const { data } = await supabase.from('profiles')
    .select('id, nome, roles, threec_agent_token, threec_agent_ramal, threec_agent_id').eq('id', req.user.id).maybeSingle();
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
const requireCrcSucesso = requireRole('crc_sucesso', 'crc_comercial', 'gestor', 'admin');
const requireCrcLead  = requireRole('crc_leads', 'crc_comercial', 'admin', 'gestor');
const requireKanbanLeads    = requireRole('admin', 'gestor', 'crc', 'crc_leads', 'crc_comercial', 'mod_kanban_leads');
const requireKanbanComercial = requireRole('admin', 'gestor', 'crc', 'crc_comercial', 'mod_kanban_comercial');
const requireDashboardAvaliacao = requireRole('gestor', 'admin', 'crc_comercial');

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
      logEvento(lead.id, 'lead_criado',
        'Entrou via ' + origem + (ctwa_clid ? ' (CTWA ✓)' : '') + (campanha ? ' — ' + campanha : ''),
        { origem, campanha: campanha || '', ctwa_clid: ctwa_clid || '', fbclid: fbclid || '' }
      );
      dispararConversaoMeta(lead).catch(e => console.error('Meta CAPI:', e.message));
      if (fbclid) {
        supabase.from('pixel_sessions')
          .update({ lead_id: lead.id })
          .eq('fbclid', fbclid).is('lead_id', null)
          .then(async () => {
            const { data: sessoes } = await supabase.from('pixel_sessions')
              .select('pagina, metadata, criado_em').eq('fbclid', fbclid).eq('lead_id', lead.id)
              .order('criado_em', { ascending: true });
            for (const s of (sessoes || [])) {
              logEvento(lead.id, 'pixel_pagina',
                'Visitou: ' + s.pagina,
                { pagina: s.pagina, referrer: s.metadata?.referrer || '' }
              );
            }
          }).catch(() => {});
      }
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
    logEvento(lead.id, 'lead_criado', 'Lead criado manualmente — ' + lead.origem,
      { origem: lead.origem }, req.user?.id || null);
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
      'nome','telefone','email','origem','status','valor','tipo_trat',
      'notas_sdr','notas_avaliacao','notas_comercial',
      'score_interesse','perfil_disc','etiquetas',
      'proximo_contato','ultimo_contato',
      'crc_comercial_id','crc_comercial_nome',
      'crc_agendamento_id','crc_agendamento_nome',
    ];
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const agora = new Date().toISOString();
    const patch = {};
    for (const k of Object.keys(req.body)) {
      if (!ALLOWED.includes(k)) continue;
      let v = req.body[k];
      if (k === 'status') {
        if (!FUNIL.includes(v)) return res.status(400).json({ error: 'Status inválido. Use: ' + FUNIL.join(', ') });
        if (v === 'Agendado' && !lead.data_agendamento) patch.data_agendamento = agora;
        if (v === 'Agendado') { patch.crc_agendamento_id = req.user?.id || null; patch.crc_agendamento_nome = req.user?.profile?.nome || req.user?.email || null; }
        if (v === 'Compareceu' && !lead.data_comparecimento) patch.data_comparecimento = agora;
        // D0 = entrada na régua comercial (avaliação realizada)
        if (v === 'D0' && !lead.data_avaliacao) patch.data_avaliacao = agora;
        if (v === 'Em nutrição' && !lead.data_orcamento) patch.data_orcamento = agora;
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
      if (k === 'crc_comercial_id' || k === 'crc_agendamento_id') {
        if (!v) { patch[k] = null; continue; }
        if (typeof v !== 'string' || !UUID_RE.test(v)) continue; // ignora UUID inválido
        patch[k] = v;
        continue;
      }
      if (typeof v === 'string') v = sanitizeStr(v, 4000);
      patch[k] = v;
    }
    const { data: updated, error: updateErr } = await supabase.from('leads').update(patch).eq('id', id).select().single();
    if (updateErr) throw updateErr;
    const statusMudou = req.body.status && req.body.status !== leadAntes.status;
    if (statusMudou) {
      const evtNome = EVENTOS_FUNIL[updated.status];
      logEvento(updated.id, 'status_mudou',
        'Status: ' + leadAntes.status + ' → ' + updated.status,
        { de: leadAntes.status, para: updated.status },
        req.user?.id || null
      );
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
    const [totaisRes, statusRes, origensRes, ultimosRes] = await Promise.all([
      supabase.rpc('stats_totais'),
      supabase.rpc('stats_por_status'),
      supabase.rpc('stats_por_origem'),
      supabase.from('leads').select('id,nome,telefone,origem,campanha,status,valor,criado_em').order('id', { ascending: false }).limit(10),
    ]);
    if (totaisRes.error) throw totaisRes.error;
    if (statusRes.error) throw statusRes.error;
    if (origensRes.error) throw origensRes.error;
    if (ultimosRes.error) throw ultimosRes.error;

    const t = totaisRes.data;
    const total = Number(t.total);
    const receita = Number(t.receita) || 0;
    const fechadosN = Number(t.fechados) || 0;
    const ticketMedio = fechadosN ? receita / fechadosN : 0;
    const oportunidade = Number(t.oportunidade) || 0;

    const statusMap = new Map((statusRes.data || []).map(r => [r.status, Number(r.n)]));
    const porStatus = FUNIL.map(s => ({ status: s, n: statusMap.get(s) || 0 }));

    const porOrigem = (origensRes.data || []).map(r => ({
      origem: r.origem, n: Number(r.n), fechados: Number(r.fechados), receita: Number(r.receita) || 0,
    }));

    res.json({ total, porStatus, porOrigem, receita, ticketMedio, oportunidade, ultimosLeads: ultimosRes.data || [], _v: 5 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ========== KANBAN ==========
const CARD_FIELDS = 'id,nome,telefone,origem,status,valor,criado_em,data_comparecimento,data_agendamento,data_fechamento,data_orcamento,data_avaliacao,crc_agendamento_nome,crc_comercial_nome,ultimo_contato';

function buildLeadsColFilter(coluna, q, crc, countOnly = false, origem = null) {
  const now = Date.now();
  const d30  = new Date(now - 30  * 864e5).toISOString();
  const d180 = new Date(now - 180 * 864e5).toISOString();
  const d365 = new Date(now - 365 * 864e5).toISOString();
  const NURTURE = ['Lead', 'Nutrir', 'Reclassificar'];
  const sel = countOnly ? '*' : CARD_FIELDS;
  const opts = countOnly ? { count: 'exact', head: true } : { count: 'exact' };
  let qb = supabase.from('leads').select(sel, opts);
  switch (coluna) {
    case 'lead':
      qb = qb.in('status', NURTURE).gte('criado_em', d30); break;
    case 'nutrir_30':
      qb = qb.in('status', NURTURE).lt('criado_em', d30).gte('criado_em', d180); break;
    case 'nutrir_180':
      qb = qb.in('status', NURTURE).lt('criado_em', d180).gte('criado_em', d365); break;
    case 'nutrir_365':
      qb = qb.in('status', NURTURE).lt('criado_em', d365); break;
    case 'agendado':          qb = qb.eq('status', 'Agendado'); break;
    case 'faltou':            qb = qb.eq('status', 'Faltou'); break;
    case 'nao_tem_interesse': qb = qb.eq('status', 'Não tem Interesse'); break;
    default: return null;
  }
  if (q) {
    const safe = q.replace(/[%,()]/g, '');
    qb = qb.or(`nome.ilike.%${safe}%,telefone.ilike.%${safe}%`);
  }
  if (crc)    qb = qb.eq('crc_agendamento_nome', crc);
  if (origem) qb = qb.eq('origem', origem);
  return qb;
}

const LEADS_COLUNAS = ['lead','agendado','faltou','nao_tem_interesse','nutrir_30','nutrir_180','nutrir_365'];

// IMPORTANTE: /counts deve vir ANTES de /:coluna
app.get('/api/kanban/leads/counts', requireAuth, requireKanbanLeads, rateLimit, async (req, res) => {
  const q      = req.query.q      || null;
  const crc    = req.query.crc    || null;
  const origem = req.query.origem || null;
  try {
    const results = await Promise.all(
      LEADS_COLUNAS.map(async col => {
        const qb = buildLeadsColFilter(col, q, crc, true, origem);
        if (!qb) return [col, 0];
        const { count, error } = await qb;
        if (error) console.error('[kanban/leads/counts]', col, error.message);
        return [col, count ?? 0];
      })
    );
    res.json(Object.fromEntries(results));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/kanban/leads/crcs', requireAuth, requireKanbanLeads, async (req, res) => {
  try {
    const { data, error } = await supabase.from('leads')
      .select('crc_agendamento_nome')
      .not('crc_agendamento_nome', 'is', null)
      .neq('crc_agendamento_nome', '');
    if (error) throw error;
    const unique = [...new Set(data.map(r => r.crc_agendamento_nome))].sort();
    res.json(unique);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/kanban/leads/:coluna', requireAuth, requireKanbanLeads, rateLimit, async (req, res) => {
  const { coluna } = req.params;
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  const q      = req.query.q      || null;
  const crc    = req.query.crc    || null;
  const origem = req.query.origem || null;
  if (!LEADS_COLUNAS.includes(coluna)) return res.status(400).json({ error: 'Coluna inválida' });
  try {
    const orderField = coluna === 'agendado' ? 'data_agendamento' : 'criado_em';
    const ascending = coluna === 'agendado';
    const offset = page * 30;
    const { data, count, error } = await buildLeadsColFilter(coluna, q, crc, false, origem)
      .order(orderField, { ascending })
      .range(offset, offset + 29);
    if (error) throw error;
    res.json({ leads: data, total: count ?? 0, page, hasMore: offset + (data?.length ?? 0) < (count ?? 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== KANBAN COMERCIAL ==========
function buildComercialColFilter(coluna, q, crc, countOnly = false) {
  const now = Date.now();
  const d30  = new Date(now - 30 * 864e5).toISOString();
  const sel  = countOnly ? '*' : CARD_FIELDS;
  const opts = countOnly ? { count: 'exact', head: true } : { count: 'exact' };
  let qb = supabase.from('leads').select(sel, opts);
  switch (coluna) {
    case 'compareceu':
      qb = qb.eq('status', 'Compareceu').gte('data_comparecimento', d30); break;
    case 'd0': qb = qb.eq('status', 'D0'); break;
    case 'd1': qb = qb.eq('status', 'D1'); break;
    case 'd2': qb = qb.eq('status', 'D2'); break;
    case 'd3': qb = qb.eq('status', 'D3'); break;
    case 'd4': qb = qb.eq('status', 'D4'); break;
    case 'd5': qb = qb.eq('status', 'D5'); break;
    case 'fechou':
      qb = qb.eq('status', 'Fechou').gte('data_fechamento', d30); break;
    case 'perdido': qb = qb.eq('status', 'Perdido'); break;
    default: return null; // nutricao_* handled via RPC
  }
  if (q) {
    const safe = q.replace(/[%,()]/g, '');
    qb = qb.or(`nome.ilike.%${safe}%,telefone.ilike.%${safe}%`);
  }
  if (crc) qb = qb.eq('crc_comercial_nome', crc);
  return qb;
}

const COMERCIAL_SIMPLES = ['compareceu','d0','d1','d2','d3','d4','d5','fechou','perdido'];
const COMERCIAL_COLUNAS = [...COMERCIAL_SIMPLES, 'nutricao_30','nutricao_180','nutricao_365'];

// IMPORTANTE: /counts deve vir ANTES de /:coluna
app.get('/api/kanban/comercial/counts', requireAuth, requireKanbanComercial, rateLimit, async (req, res) => {
  const q   = req.query.q   || null;
  const crc = req.query.crc || null;
  try {
    const simplesPromises = COMERCIAL_SIMPLES.map(async col => {
      const qb = buildComercialColFilter(col, q, crc, true);
      const { count, error } = await qb;
      if (error) console.error('[kanban/comercial/counts]', col, error.message);
      return [col, count ?? 0];
    });
    const nutricaoPromises = ['30','180','365'].map(async bucket => {
      const { data, error } = await supabase.rpc('kanban_nutricao_count', {
        p_bucket: bucket,
        p_q: q,
        p_crc: crc,
      });
      if (error) console.error('[kanban/comercial/counts] nutricao_' + bucket, error.message);
      return [`nutricao_${bucket}`, Number(data) || 0];
    });
    const results = await Promise.all([...simplesPromises, ...nutricaoPromises]);
    res.json(Object.fromEntries(results));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/kanban/comercial/crcs', requireAuth, requireKanbanComercial, async (req, res) => {
  try {
    const { data, error } = await supabase.from('leads')
      .select('crc_comercial_nome')
      .not('crc_comercial_nome', 'is', null)
      .neq('crc_comercial_nome', '');
    if (error) throw error;
    const unique = [...new Set(data.map(r => r.crc_comercial_nome))].sort();
    res.json(unique);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/kanban/comercial/:coluna', requireAuth, requireKanbanComercial, rateLimit, async (req, res) => {
  const { coluna } = req.params;
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  const q   = req.query.q   || null;
  const crc = req.query.crc || null;
  if (!COMERCIAL_COLUNAS.includes(coluna)) return res.status(400).json({ error: 'Coluna inválida' });
  try {
    const offset = page * 30;
    if (coluna.startsWith('nutricao_')) {
      const bucket = coluna.replace('nutricao_', '');
      const [{ data, error: e1 }, { data: total, error: e2 }] = await Promise.all([
        supabase.rpc('kanban_nutricao', { p_bucket: bucket, p_limit: 30, p_offset: offset, p_q: q, p_crc: crc }),
        supabase.rpc('kanban_nutricao_count', { p_bucket: bucket, p_q: q, p_crc: crc }),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      const tot = Number(total) || 0;
      return res.json({ leads: data, total: tot, page, hasMore: offset + (data?.length ?? 0) < tot });
    }
    const orderField = coluna === 'compareceu' ? 'data_comparecimento'
      : ['d0','d1','d2','d3','d4','d5'].includes(coluna) ? 'data_avaliacao'
      : coluna === 'fechou' ? 'data_fechamento'
      : 'criado_em';
    const { data, count, error } = await buildComercialColFilter(coluna, q, crc)
      .order(orderField, { ascending: false, nullsFirst: false })
      .range(offset, offset + 29);
    if (error) throw error;
    res.json({ leads: data, total: count ?? 0, page, hasMore: offset + (data?.length ?? 0) < (count ?? 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== TELEFONIA ==========
// DEBUG TEMPORÁRIO — remover após diagnóstico
app.get('/api/debug/3cplus', requireAuth, async (req, res) => {
  try {
    const p = await loadProfile(req);
    const token = p.threec_agent_token;
    const base = process.env.THREEC_BASE_URL || 'https://clinicaama.3c.plus';
    const altBase = 'https://app.3c.fluxoti.com.br';
    if (!token) return res.json({ erro: 'sem token no perfil', base });
    const https = require('https'); const http = require('http');

    function makeProbe(baseUrl) {
      return function probeToken(method, apiPath, body, tok) {
        const url = new URL(apiPath, baseUrl);
        url.searchParams.set('api_token', tok || token);
        const mod = url.protocol === 'https:' ? https : http;
        const data = body ? JSON.stringify(body) : null;
        return new Promise((resolve) => {
          const opts = { hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, timeout: 8000 };
          const req2 = mod.request(opts, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b.slice(0, 500) })); });
          req2.on('timeout', () => { req2.destroy(); resolve({ status: 'timeout' }); });
          req2.on('error', e => resolve({ status: 'err', body: e.message }));
          if (data) req2.write(data); req2.end();
        });
      };
    }
    const probe = makeProbe(base);
    const gestorToken = process.env.THREEC_TOKEN || '';

    // Datas para sonda do /calls (hoje, últimas 24h)
    const now = new Date();
    const ontem = new Date(now - 24 * 3600 * 1000);
    const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');
    const callsUrl = `/api/v1/calls?start_date=${encodeURIComponent(fmt(ontem))}&end_date=${encodeURIComponent(fmt(now))}`;

    const steps = await Promise.all([
      // Login sequencial + manual_call_enter (testados em série via then)
      probe('POST', '/api/v1/agent/login', { campaign: 247859 }).then(async loginRes => {
        const enterRes = await probe('POST', '/api/v1/agent/manual_call_enter', null);
        const logoutRes = await probe('POST', '/api/v1/agent/logout', null);
        return [
          { path: 'POST /api/v1/agent/login {campaign:247859}', ...loginRes },
          { path: 'POST /api/v1/agent/manual_call_enter (após login)', ...enterRes },
          { path: 'POST /api/v1/agent/logout (cleanup)', ...logoutRes },
        ];
      }),
      // Listar chamadas com datas reais (gestor token)
      probe('GET', callsUrl, null, gestorToken).then(r => [{ path: `GET ${callsUrl} GESTOR`, ...r }]),
      // Outros endpoints de agente
      probe('GET',  '/api/v1/agent/me', null).then(r => [{ path: 'GET /api/v1/agent/me', ...r }]),
      probe('GET',  '/api/v1/me', null).then(r => [{ path: 'GET /api/v1/me AGENT', ...r }]),
      probe('GET',  '/api/v1/me', null, gestorToken).then(r => [{ path: 'GET /api/v1/me GESTOR', ...r }]),
    ]);

    res.json({ base, tokenPreview: token.slice(0,8)+'...', gestorTokenPresent: Boolean(gestorToken), steps: steps.flat() });
  } catch (e) {
    res.json({ erro: e.message });
  }
});

app.post('/api/leads/:id/ligar', requireAuth, requireCrcLead, rateLimit, async (req, res) => {
  try {
    const leadId = req.params.id;
    if (!leadId || !/^\d+$/.test(leadId)) return res.status(400).json({ error: 'ID inválido' });

    const p = await loadProfile(req);
    if (!p.threec_agent_token) {
      return res.status(400).json({ error: 'Configure seu Token de Agente 3cplus em Configurações → Perfil antes de ligar.' });
    }

    const { data: lead } = await supabase.from('leads').select('id, nome, telefone').eq('id', leadId).maybeSingle();
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (!lead.telefone) return res.status(400).json({ error: 'Lead sem telefone cadastrado' });

    const { callId } = await threec.ligar({ agentToken: p.threec_agent_token, numeroDestino: lead.telefone });

    const { data: ligacao, error: lErr } = await supabase.from('ligacoes').insert({
      lead_id: leadId,
      usuario_id: req.user.id,
      threec_call_id: callId,
      status: 'iniciada',
      modulo: 'leads',
    }).select().single();
    if (lErr) throw lErr;

    res.json({ ok: true, ligacao });
    logEvento(leadId, 'ligacao', 'Ligação iniciada via 3cplus',
      { threec_call_id: callId || '' }, req.user?.id || null);
  } catch (e) {
    console.error('❌ 3cplus ligar:', e.message);
    res.status(e.status || 500).json({ error: e.message });
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

app.get('/api/leads/:id/ligacoes', requireAuth, rateLimit, async (req, res) => {
  try {
    const leadId = req.params.id;
    if (!leadId || !/^\d+$/.test(leadId)) return res.status(400).json({ error: 'ID inválido' });
    const { data, error } = await supabase.from('ligacoes')
      .select('id, threec_call_id, status, duracao_segundos, gravacao_url, transcricao, analise_ia, tentativas_gravacao, criada_em, analisada_em')
      .eq('lead_id', leadId)
      .order('criada_em', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== CAMPANHAS DE DISCAGEM PREDITIVA ==========

const CAMP_ENV = {
  abc:        'THREEC_CAMPAIGN_ABC',
  indicacoes: 'THREEC_CAMPAIGN_INDICACOES',
  recentes:   'THREEC_CAMPAIGN_RECENTES',
  frios:      'THREEC_CAMPAIGN_FRIOS',
};

const TIPOS_VALIDOS = Object.keys(CAMP_ENV);

async function buscarContatos(tipo) {
  if (tipo === 'abc') {
    const { data: bloqueados, error: blqError } = await supabase.from('nao_ligar_pacientes').select('clinicorp_id');
    if (blqError) throw blqError; // falha aberta incluiria pacientes bloqueados na campanha
    const bloqueadosSet = new Set((bloqueados || []).map(r => String(r.clinicorp_id)));
    const { data, error } = await supabase.from('pacientes_abc')
      .select('nome, telefone, clinicorp_id, dias_sem_visita')
      .in('classe', ['A', 'B'])
      .gte('dias_sem_visita', 180)
      .is('proxima_consulta', null);
    if (error) throw error;
    return (data || [])
      .filter(p => !bloqueadosSet.has(String(p.clinicorp_id)))
      .map(c => ({ ...c, tipo_origem: 'abc' }));
  }
  if (tipo === 'indicacoes') {
    const { data, error } = await supabase.from('leads')
      .select('id, nome, telefone')
      .eq('origem', 'Indicação')
      .not('status', 'in', '("Fechou","Perdido")')
      .eq('nao_ligar', false);
    if (error) throw error;
    return (data || []).map(c => ({ ...c, tipo_origem: 'indicacoes' }));
  }
  if (tipo === 'recentes') {
    const { data, error } = await supabase.from('leads')
      .select('id, nome, telefone')
      .neq('origem', 'Indicação')
      .not('status', 'in', '("Fechou","Perdido")')
      .eq('nao_ligar', false)
      .order('criado_em', { ascending: false })
      .limit(50);
    if (error) throw error;
    return (data || []).map(c => ({ ...c, tipo_origem: 'recentes' }));
  }
  if (tipo === 'frios') {
    const { data, error } = await supabase.from('leads')
      .select('id, nome, telefone')
      .neq('origem', 'Indicação')
      .not('status', 'in', '("Fechou","Perdido")')
      .eq('nao_ligar', false)
      .order('criado_em', { ascending: false })
      .range(50, 150);
    if (error) throw error;
    return (data || []).map(c => ({ ...c, tipo_origem: 'frios' }));
  }
  const err = new Error('Tipo inválido'); err.status = 400; throw err;
}

app.get('/api/campanhas/preview/:tipo', requireAuth, requireCrcLead, async (req, res) => {
  try {
    const { tipo } = req.params;
    if (!TIPOS_VALIDOS.includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });
    const contatos = await buscarContatos(tipo);
    if (req.query.count_only === 'true') return res.json({ total: contatos.length });
    res.json({ total: contatos.length, contatos });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/campanhas/nao-ligar', requireAuth, requireCrcLead, async (req, res) => {
  try {
    const { tipo, id } = req.body;
    if (!tipo || !id) return res.status(400).json({ error: 'tipo e id são obrigatórios' });
    if (!['paciente', 'lead'].includes(tipo)) return res.status(400).json({ error: 'tipo deve ser "paciente" ou "lead"' });
    if (tipo === 'paciente') {
      const { error } = await supabase.from('nao_ligar_pacientes').insert({ clinicorp_id: String(id) });
      if (error && error.code !== '23505') throw error; // 23505 = unique violation (já bloqueado — OK)
    } else {
      const { data: updated, error } = await supabase
        .from('leads')
        .update({ nao_ligar: true })
        .eq('id', id)
        .select('id');
      if (error) throw error;
      if (!updated || updated.length === 0) return res.status(404).json({ error: 'Lead não encontrado' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/campanhas/lancar', requireAuth, requireCrcLead, async (req, res) => {
  try {
    const { tipo } = req.body;
    if (!TIPOS_VALIDOS.includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });

    const envVar = CAMP_ENV[tipo];
    const campaignId = parseInt(process.env[envVar], 10);
    if (!campaignId) {
      return res.status(400).json({ error: `Campanha não configurada. Configure ${envVar} no Easypanel.` });
    }

    const { data: ativas } = await supabase.from('campanhas_discagem')
      .select('id').in('status', ['ativa', 'pausada']).limit(1);
    if (ativas?.length) {
      return res.status(409).json({ error: 'Encerre ou retome e encerre a campanha atual antes de lançar outra.' });
    }

    const contatos = await buscarContatos(tipo);
    const excluirSet = new Set((req.body.excluir || []).map(String));
    const contatosFiltrados = excluirSet.size > 0
      ? contatos.filter(c => {
          const idField = tipo === 'abc' ? 'clinicorp_id' : 'id';
          return !excluirSet.has(String(c[idField]));
        })
      : contatos;
    const comTelefone = contatosFiltrados.filter(c => c.telefone?.trim());
    if (!comTelefone.length) {
      return res.status(400).json({ error: 'Nenhum contato encontrado com telefone cadastrado.' });
    }

    await threecCamp.uploadMailing(campaignId, comTelefone.map(c => ({ nome: c.nome, telefone: c.telefone })));

    const { data: campanha, error: dbErr } = await supabase.from('campanhas_discagem').insert({
      tipo,
      threec_campaign_id: campaignId,
      contatos_total: comTelefone.length,
      contatos_json: comTelefone,
      status: 'ativa',
      usuario_id: req.user.id,
    }).select().single();

    if (dbErr) {
      await threecCamp.encerrarCampanha(campaignId).catch(e => console.error('❌ rollback encerrar:', e.message));
      throw dbErr;
    }

    const p = req.user.profile;
    if (p?.threec_agent_token) {
      threecCamp.loginCrcNaCampanha(p.threec_agent_token, campaignId).catch(e => {
        console.warn('⚠️ loginCrcNaCampanha falhou (não-fatal):', e.message);
      });
    } else {
      console.info('ℹ️ CRC sem threec_agent_token — loginCrcNaCampanha ignorado');
    }

    res.json({ ok: true, campanha: { id: campanha.id, tipo: campanha.tipo, contatos_total: campanha.contatos_total } });
  } catch (e) {
    console.error('❌ campanhas/lancar:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/campanhas/:id/pausar', requireAuth, requireCrcLead, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data: campanha } = await supabase.from('campanhas_discagem').select('*').eq('id', id).maybeSingle();
    if (!campanha) return res.status(404).json({ error: 'Campanha não encontrada' });
    if (campanha.status !== 'ativa') return res.status(400).json({ error: `Campanha não está ativa (status atual: ${campanha.status})` });
    await threecCamp.pausarCampanha(campanha.threec_campaign_id);
    await supabase.from('campanhas_discagem').update({ status: 'pausada', pausada_em: new Date().toISOString() }).eq('id', id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/campanhas/:id/retomar', requireAuth, requireCrcLead, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data: campanha } = await supabase.from('campanhas_discagem').select('*').eq('id', id).maybeSingle();
    if (!campanha) return res.status(404).json({ error: 'Campanha não encontrada' });
    if (campanha.status !== 'pausada') return res.status(400).json({ error: `Campanha não está pausada (status atual: ${campanha.status})` });
    await threecCamp.retomarCampanha(campanha.threec_campaign_id);
    await supabase.from('campanhas_discagem').update({ status: 'ativa', pausada_em: null }).eq('id', id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/campanhas/:id/encerrar', requireAuth, requireCrcLead, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data: campanha } = await supabase.from('campanhas_discagem').select('threec_campaign_id').eq('id', id).maybeSingle();
    if (!campanha) return res.status(404).json({ error: 'Campanha não encontrada' });
    await threecCamp.encerrarCampanha(campanha.threec_campaign_id);
    await supabase.from('campanhas_discagem').update({ status: 'encerrada', encerrada_em: new Date().toISOString() }).eq('id', id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/campanhas/ativa', requireAuth, requireCrcLead, async (req, res) => {
  try {
    const { data: campanha } = await supabase.from('campanhas_discagem')
      .select('id, tipo, status, contatos_total, iniciada_em, pausada_em')
      .in('status', ['ativa', 'pausada'])
      .order('iniciada_em', { ascending: false })
      .limit(1)
      .maybeSingle();
    res.json({ campanha: campanha || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/campanhas/:id/resultado', requireAuth, requireCrcLead, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data: campanha } = await supabase.from('campanhas_discagem')
      .select('threec_campaign_id, contatos_total, iniciada_em').eq('id', id).maybeSingle();
    if (!campanha) return res.status(404).json({ error: 'Campanha não encontrada' });
    const calls = await threecCamp.getCallsDaCampanha(campanha.threec_campaign_id, campanha.iniciada_em);
    const atendidas = calls.filter(c => c.status_id === 7).length;
    const nao_atendeu = calls.filter(c => c.status_id !== 7).length;
    const na_fila = Math.max(0, campanha.contatos_total - atendidas - nao_atendeu);
    res.json({ atendidas, nao_atendeu, na_fila });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
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

// ========== 3CPLUS WEBHOOK ==========
app.post('/api/webhooks/3cplus', async (req, res) => {
  try {
    const token = req.headers['x-webhook-token'] || '';
    const expected = process.env.THREEC_WEBHOOK_TOKEN || '';
    if (!expected || token !== expected) return res.status(401).send('unauthorized');

    const {
      threec_call_id,
      agent_id,
      status,
      duracao_segundos,
      gravacao_url,
    } = req.body;

    if (!threec_call_id) return res.status(400).send('threec_call_id obrigatório');

    const statusMap = {
      atendida: 'atendida', answered: 'atendida',
      nao_atendida: 'nao_atendida', 'no-answer': 'nao_atendida',
      ocupado: 'ocupado', busy: 'ocupado',
    };
    const statusNormalizado = statusMap[status] || 'nao_atendida';

    const { data: ligacao, error } = await supabase.from('ligacoes')
      .select('*')
      .eq('threec_call_id', threec_call_id)
      .maybeSingle();

    if (error || !ligacao) {
      console.warn('⚠️ webhook 3cplus: ligação não encontrada para call_id', threec_call_id);
      return res.status(200).send('ok');
    }

    const patch = {
      status: statusNormalizado,
      duracao_segundos: Number.isFinite(parseInt(duracao_segundos, 10)) ? parseInt(duracao_segundos, 10) : null,
      gravacao_url: gravacao_url || null,
    };

    await supabase.from('ligacoes').update(patch).eq('id', ligacao.id);

    if (gravacao_url && statusNormalizado === 'atendida') {
      processarGravacao({ ...ligacao, ...patch }).catch(() => {});
    }

    res.status(200).send('ok');
  } catch (e) {
    console.error('❌ webhook 3cplus:', e.message);
    res.status(500).send('erro');
  }
});

// ========== ANÁLISE MANUAL DE LIGAÇÕES ==========
app.post('/api/ligacoes/:id/analisar', requireAuth, rateLimit, async (req, res) => {
  try {
    const ligacaoId = req.params.id;
    if (!UUID_V4_RE.test(ligacaoId)) return res.status(400).json({ error: 'ID inválido' });

    const { data: ligacao } = await supabase.from('ligacoes')
      .select('*').eq('id', ligacaoId).maybeSingle();
    if (!ligacao) return res.status(404).json({ error: 'Ligação não encontrada' });
    if (ligacao.status !== 'atendida') return res.status(400).json({ error: 'Apenas chamadas atendidas podem ser analisadas' });
    if (!ligacao.gravacao_url) return res.status(400).json({ error: 'Gravação não disponível' });

    res.json({ ok: true, msg: 'Análise iniciada' });

    // Fire-and-forget com override de limites (manual)
    (async () => {
      try {
        const { buffer: audioBuffer, contentType } = await threec.downloadGravacao(ligacao.gravacao_url);
        const { data: analise, tokensIn, tokensOut } = await geminiLib().analyzeLigacao({
          audioBuffer, contentType, modulo: ligacao.modulo,
        });
        const custoMin = parseFloat(process.env.GEMINI_COST_PER_MIN || '0.016');
        const duracao = ligacao.duracao_segundos || 0;
        const custoEstimado = parseFloat(((duracao / 60) * custoMin).toFixed(4));
        await Promise.all([
          supabase.from('ligacoes').update({
            transcricao: analise.transcricao,
            analise_ia: { resumo: analise.resumo, pontos_fortes: analise.pontos_fortes, pontos_melhora: analise.pontos_melhora, score: analise.score },
            analisada_em: new Date().toISOString(),
          }).eq('id', ligacaoId),
          supabase.from('ia_uso_log').insert({
            modulo: ligacao.modulo, duracao_audio_s: duracao,
            tokens_entrada: tokensIn, tokens_saida: tokensOut, custo_estimado: custoEstimado,
          }),
        ]);
        console.log(`✅ Análise manual concluída: ${ligacaoId}`);
      } catch (e) {
        console.error('❌ análise manual:', ligacaoId, e.message);
      }
    })();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== LIGAÇÕES — ROTAS GERENCIAIS ==========
app.get('/api/ligacoes/stats', requireAuth, requireGestor, async (req, res) => {
  try {
    const { desde, ate, modulo, usuario_id } = req.query;
    let q = supabase.from('ligacoes').select('status, duracao_segundos, analise_ia');
    if (desde) q = q.gte('criada_em', desde + 'T00:00:00Z');
    if (ate)   q = q.lte('criada_em', ate + 'T23:59:59Z');
    if (modulo && modulo !== 'todos') q = q.eq('modulo', modulo);
    if (usuario_id && UUID_V4_RE.test(usuario_id)) q = q.eq('usuario_id', usuario_id);
    const { data } = await q;
    const rows = data || [];
    const total = rows.length;
    const atendidas = rows.filter(r => r.status === 'atendida').length;
    const taxaAtendimento = total ? Math.round((atendidas / total) * 100) : 0;
    const comDuracao = rows.filter(r => r.duracao_segundos > 0);
    const duracaoMedia = comDuracao.length
      ? Math.round(comDuracao.reduce((s, r) => s + r.duracao_segundos, 0) / comDuracao.length)
      : 0;
    const comScore = rows.filter(r => r.analise_ia?.score != null);
    const scoreMedia = comScore.length
      ? parseFloat((comScore.reduce((s, r) => s + r.analise_ia.score, 0) / comScore.length).toFixed(1))
      : null;
    res.json({ total, atendidas, taxa_atendimento: taxaAtendimento, duracao_media_s: duracaoMedia, score_medio: scoreMedia });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ligacoes', requireAuth, requireGestor, rateLimit, async (req, res) => {
  try {
    const { desde, ate, usuario_id, modulo, status, score_min, score_max, origem, page = '1' } = req.query;
    const limit = 50;
    const offset = (Math.max(1, parseInt(page, 10)) - 1) * limit;

    let q = supabase.from('ligacoes')
      .select(`
        id, threec_call_id, status, duracao_segundos, modulo,
        criada_em, analisada_em, analise_ia,
        usuario_id, profiles!ligacoes_usuario_id_fkey(nome),
        lead_id, leads!ligacoes_lead_id_fkey(nome, origem)
      `, { count: 'exact' })
      .order('criada_em', { ascending: false })
      .range(offset, offset + limit - 1);

    if (desde) q = q.gte('criada_em', desde + 'T00:00:00Z');
    if (ate)   q = q.lte('criada_em', ate + 'T23:59:59Z');
    if (usuario_id && UUID_V4_RE.test(usuario_id)) q = q.eq('usuario_id', usuario_id);
    if (modulo)  q = q.eq('modulo', modulo);
    if (status)  q = q.eq('status', status);
    if (score_min) q = q.gte('analise_ia->>score', score_min);
    if (score_max) q = q.lte('analise_ia->>score', score_max);
    if (origem) q = q.filter('leads.origem', 'eq', origem);

    const { data, error, count } = await q;
    if (error) throw error;
    res.json({ data: data || [], total: count || 0, page: parseInt(page, 10), limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== IA CONFIG ==========
app.get('/api/ia-config', requireAuth, requireGestor, async (req, res) => {
  try {
    const { data, error } = await supabase.from('ia_config').select('*').order('modulo');
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/ia-config/:modulo', requireAuth, requireGestor, async (req, res) => {
  try {
    const { modulo } = req.params;
    if (!['leads', 'agendamentos', 'avaliacao_dentista'].includes(modulo))
      return res.status(400).json({ error: 'Módulo inválido' });
    const { auto_analise_ativo, min_duracao_s, limite_diario, limite_semanal } = req.body;
    const patch = {};
    if (typeof auto_analise_ativo === 'boolean') patch.auto_analise_ativo = auto_analise_ativo;
    if (Number.isFinite(min_duracao_s) && min_duracao_s >= 0) patch.min_duracao_s = min_duracao_s;
    if (Number.isFinite(limite_diario) && limite_diario > 0) patch.limite_diario = limite_diario;
    if (Number.isFinite(limite_semanal) && limite_semanal > 0) patch.limite_semanal = limite_semanal;
    const { error } = await supabase.from('ia_config').update(patch).eq('modulo', modulo);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== IA USO LOG ==========
app.get('/api/ia-uso-log', requireAuth, requireGestor, async (req, res) => {
  try {
    const diasAtras = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    const { data, error } = await supabase.from('ia_uso_log')
      .select('*')
      .gte('criado_em', diasAtras)
      .order('criado_em', { ascending: false })
      .limit(500);
    if (error) throw error;

    const byDia = {};
    for (const row of (data || [])) {
      const dia = row.criado_em.slice(0, 10);
      const k = `${dia}|${row.modulo}`;
      if (!byDia[k]) byDia[k] = { data: dia, modulo: row.modulo, analises: 0, minutos: 0, custo: 0 };
      byDia[k].analises++;
      byDia[k].minutos += Math.ceil((row.duracao_audio_s || 0) / 60);
      byDia[k].custo += parseFloat(row.custo_estimado || 0);
    }

    const inicioMes = new Date();
    inicioMes.setDate(1); inicioMes.setHours(0, 0, 0, 0);
    const mesRows = (data || []).filter(r => r.criado_em >= inicioMes.toISOString());
    const analisesMes = mesRows.length;
    const minutosMes = mesRows.reduce((s, r) => s + Math.ceil((r.duracao_audio_s || 0) / 60), 0);
    const custoMes = parseFloat(mesRows.reduce((s, r) => s + parseFloat(r.custo_estimado || 0), 0).toFixed(2));
    const diasDecorridos = new Date().getDate();
    const diasNoMes = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const projecao = diasDecorridos > 0 ? parseFloat(((custoMes / diasDecorridos) * diasNoMes).toFixed(2)) : 0;

    res.json({
      cards: { analises_mes: analisesMes, minutos_mes: minutosMes, custo_mes: custoMes, projecao_mes: projecao },
      tabela: Object.values(byDia).sort((a, b) => b.data.localeCompare(a.data)),
      custo_por_min: parseFloat(process.env.GEMINI_COST_PER_MIN || '0.016'),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    const { texto, templateName, variaveis, reply_wa_id, phone_number_id } = req.body;
    let resultado;
    if (!templateName && !texto) return res.status(400).json({ error: 'texto ou templateName obrigatorio' });
    const replyPhoneId = (typeof phone_number_id === 'string' && /^\d+$/.test(phone_number_id) && phone_number_id)
      ? phone_number_id
      : (lead.wa_number_id || whatsapp.defaultPhoneId() || '');
    if (templateName) {
      resultado = await whatsapp.enviarTemplate({ para: lead.telefone, templateName, variaveis });
    } else {
      const contextWaId = reply_wa_id ? sanitizeStr(reply_wa_id, 500) : null;
      resultado = await whatsapp.enviarTexto({ para: lead.telefone, texto, phoneNumberId: replyPhoneId, contextWaId });
    }
    await supabase.from('mensagens').insert({
      lead_id: lead.id, direcao: 'enviada', canal: 'sdr',
      texto: sanitizeStr(texto || '[template:' + sanitizeStr(templateName, 100) + ']', 4000),
      wa_id: resultado.messages?.[0]?.id || '',
      wa_number_id: replyPhoneId,
    });
    await supabase.from('leads').update({ ultimo_contato: new Date().toISOString() }).eq('id', lead.id);
    res.json({ ok: true });
    if (templateName) {
      supabase.from('templates').select('categoria').eq('nome', templateName).maybeSingle()
        .then(({ data: tpl }) => {
          logEvento(id, 'template_enviado',
            'Template enviado: ' + templateName,
            { template: templateName, categoria: tpl?.categoria || 'MARKETING' },
            req.user?.id || null
          );
        }).catch(() => {});
    } else {
      logEvento(id, 'mensagem_enviada',
        'Mensagem enviada: "' + (texto || '').slice(0, 80) + (texto?.length > 80 ? '…' : '') + '"',
        {}, req.user?.id || null
      );
    }
  } catch (e) {
    console.error('❌ wa send:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/leads/:id/whatsapp/midia', requireAuth, rateLimit, _upload.single('arquivo'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { data: lead } = await supabase.from('leads').select('id,telefone,wa_number_id').eq('id', id).maybeSingle();
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (!lead.telefone) return res.status(400).json({ error: 'Lead sem telefone' });
    if (!whatsapp.temToken()) return res.status(503).json({ error: 'WhatsApp Cloud API não configurada' });
    if (!req.file) return res.status(400).json({ error: 'Arquivo obrigatório' });
    let { buffer, mimetype, originalname } = req.file;
    // Chrome grava como audio/webm — converter para audio/ogg (opus) que o WhatsApp aceita
    if (mimetype.startsWith('audio/webm')) {
      buffer = _webmToOgg(buffer);
      mimetype = 'audio/ogg';
      originalname = originalname.replace(/\.webm$/, '.ogg');
    }
    const mediaId = await whatsapp.uploadMidia({ buffer, mimetype, filename: originalname });
    let tipo = 'document';
    if (mimetype.startsWith('image/')) tipo = 'image';
    else if (mimetype.startsWith('audio/')) tipo = 'audio';
    else if (mimetype.startsWith('video/')) tipo = 'video';
    const caption = sanitizeStr(req.body.caption || '', 500);
    const mediaPid = lead.wa_number_id || undefined;
    const resultado = await whatsapp.enviarMidia({ para: lead.telefone, mediaId, tipo, caption, phoneNumberId: mediaPid });
    await supabase.from('mensagens').insert({
      lead_id: lead.id, direcao: 'enviada', canal: 'sdr',
      texto: caption || `[${tipo}: ${sanitizeStr(originalname, 60)}]`, wa_id: resultado.messages?.[0]?.id || '',
      tipo, media_id: mediaId, mime: sanitizeStr(mimetype, 120),
      media_filename: tipo === 'document' ? sanitizeStr(originalname, 200) : null,
      wa_number_id: mediaPid || '',
    });
    await supabase.from('leads').update({ ultimo_contato: new Date().toISOString() }).eq('id', lead.id);
    res.json({ ok: true });
    logEvento(id, 'mensagem_enviada', 'Mídia enviada: ' + (req.file?.originalname || 'arquivo'),
      { tipo: req.file?.mimetype || '' }, req.user?.id || null);
  } catch (e) {
    console.error('❌ wa midia:', e);
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

const _WA_MIME_ALLOWLIST = new Set([
  'image/jpeg','image/png','image/webp','image/gif','image/heic',
  'audio/ogg','audio/ogg; codecs=opus','audio/mpeg','audio/mp4','audio/aac',
  'video/mp4','video/3gpp',
  'application/pdf',
]);

app.get('/api/leads/:id/midia/:msgId', requireAuth, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const msgId = parseInt(req.params.msgId, 10);
    if (Number.isNaN(id) || Number.isNaN(msgId)) return res.status(400).json({ error: 'ID inválido' });
    const { data: msg } = await supabase.from('mensagens')
      .select('id, lead_id, media_id, mime').eq('id', msgId).maybeSingle();
    if (!msg || msg.lead_id !== id) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (!msg.media_id) return res.status(404).json({ error: 'Mensagem sem mídia' });
    const { buffer, contentType } = await whatsapp.baixarMidia(msg.media_id);
    const safeMime = _WA_MIME_ALLOWLIST.has(msg.mime) ? msg.mime
      : _WA_MIME_ALLOWLIST.has(contentType) ? contentType
      : 'application/octet-stream';
    res.set('Content-Type', safeMime);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(buffer);
  } catch (e) {
    console.error('❌ wa midia download:', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.patch('/api/leads/:id/fixar-conversa', requireAuth, rateLimit, async (req, res) => {
  try {
    const leadId = parseInt(req.params.id, 10);
    if (Number.isNaN(leadId)) return res.status(400).json({ error: 'ID inválido' });
    const { data: lead } = await supabase.from('leads').select('id,conversa_fixada').eq('id', leadId).maybeSingle();
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    const nova = !lead.conversa_fixada;
    await supabase.from('leads').update({ conversa_fixada: nova }).eq('id', leadId);
    res.json({ conversa_fixada: nova });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/leads/:id/mensagens/:msgId/fixar', requireAuth, rateLimit, async (req, res) => {
  try {
    const leadId = parseInt(req.params.id, 10);
    const msgId  = parseInt(req.params.msgId, 10);
    if (Number.isNaN(leadId) || Number.isNaN(msgId)) return res.status(400).json({ error: 'ID inválido' });
    const { data: msg } = await supabase.from('mensagens').select('id,lead_id,fixada').eq('id', msgId).maybeSingle();
    if (!msg || msg.lead_id !== leadId) return res.status(404).json({ error: 'Mensagem não encontrada' });
    const novaFixada = !msg.fixada;
    await supabase.from('mensagens').update({ fixada: novaFixada }).eq('id', msgId).eq('lead_id', leadId);
    res.json({ fixada: novaFixada });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/leads/:id/mensagens/:msgId', requireAuth, rateLimit, async (req, res) => {
  try {
    const leadId = parseInt(req.params.id, 10);
    const msgId  = parseInt(req.params.msgId, 10);
    if (Number.isNaN(leadId) || Number.isNaN(msgId)) return res.status(400).json({ error: 'ID inválido' });
    const { data: msg } = await supabase.from('mensagens')
      .select('id,lead_id,wa_id,direcao,wa_number_id').eq('id', msgId).maybeSingle();
    if (!msg || msg.lead_id !== leadId) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (msg.direcao !== 'enviada') return res.status(400).json({ error: 'Só é possível apagar mensagens enviadas' });
    if (!msg.wa_id) return res.status(400).json({ error: 'Mensagem sem ID do WhatsApp — não pode ser apagada' });
    await whatsapp.deletarMensagem({ phoneNumberId: msg.wa_number_id || undefined, waId: msg.wa_id });
    await supabase.from('mensagens').update({ texto: '🚫 Mensagem apagada', wa_id: '', tipo: 'text', media_id: null }).eq('id', msgId);
    logEvento(leadId, 'mensagem_apagada', 'Mensagem apagada para todos', {}, req.user?.id || null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/leads/:id/agendar-mensagem', requireAuth, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { texto, agendado_para } = req.body;
    if (!texto || !agendado_para) return res.status(400).json({ error: 'texto e agendado_para são obrigatórios' });
    const { data: lead, error: le } = await supabase.from('leads').select('id,telefone,nome').eq('id', id).maybeSingle();
    if (le || !lead) return res.status(404).json({ error: 'Lead não encontrado' });
    const { data, error } = await supabase.from('mensagens_agendadas').insert({
      lead_id: id, telefone: lead.telefone,
      texto: sanitizeStr(texto, 4000),
      agendado_para: new Date(agendado_para).toISOString(),
    }).select().single();
    if (error) throw error;
    res.json({ ok: true, agendamento: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leads/:id/agendamentos', requireAuth, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { data, error } = await supabase.from('mensagens_agendadas')
      .select('*').eq('lead_id', id).order('agendado_para');
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/agendamentos/:id', requireAuth, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { error } = await supabase.from('mensagens_agendadas').delete().eq('id', id).is('enviada_em', null);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cron: dispara mensagens agendadas a cada 30s
setInterval(async () => {
  try {
    const { data } = await supabase.from('mensagens_agendadas')
      .select('*').is('enviada_em', null).lte('agendado_para', new Date().toISOString()).limit(10);
    if (!data?.length) return;
    for (const ag of data) {
      try {
        await whatsapp.enviarTexto({ para: ag.telefone, texto: ag.texto });
        await supabase.from('mensagens_agendadas').update({ enviada_em: new Date().toISOString() }).eq('id', ag.id);
        await supabase.from('mensagens').insert({ lead_id: ag.lead_id, direcao: 'enviada', canal: 'agendada', texto: ag.texto, wa_id: '' });
        console.log('📅 Mensagem agendada enviada → lead #' + ag.lead_id);
      } catch (e) { console.error('❌ Agendamento #' + ag.id + ':', e.message); }
    }
  } catch (_) {}
}, 30000);

app.get('/api/conversas', requireAuth, rateLimit, async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('conversas_com_preview');
    if (error) throw error;
    let rows = (data || []).map(r => ({
      ...r,
      ultima_mensagem: r.texto,
      ultima_mensagem_direcao: r.direcao,
      ultima_mensagem_em: r.criada_em,
    }));
    const mode = req.query.mode || '';
    const broadcastId = process.env.WHATSAPP_BROADCAST_PHONE_ID || '';
    if (broadcastId) {
      if (mode === 'oficial') rows = rows.filter(r => r.ultima_wa_number_id === broadcastId || r.wa_number_id === broadcastId);
      else if (mode === 'lead') rows = rows.filter(r => r.ultima_wa_number_id !== broadcastId && r.wa_number_id !== broadcastId);
    }
    res.json(rows);
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
    // Auto-descobre WABA ID — tenta vários tokens em ordem
    let wabaId = process.env.WA_BUSINESS_ACCOUNT_ID || '';
    if (!wabaId) {
      const tokensToTry = [
        TOKEN,
        process.env.WHATSAPP_BROADCAST_TOKEN,
        process.env.WHATSAPP_API_TOKEN,
        process.env.WHATSAPP_CLOUD_TOKEN,
      ].filter(Boolean);
      for (const tok of tokensToTry) {
        try {
          const dr = await fetch('https://graph.facebook.com/v21.0/me/whatsapp_business_accounts?fields=id&limit=5',
            { headers: { 'Authorization': 'Bearer ' + tok } });
          const dd = await dr.json();
          if (dd.data?.[0]?.id) { wabaId = dd.data[0].id; break; }
        } catch (_) {}
      }
    }
    if (!wabaId) return res.status(400).json({ error: 'WABA ID não encontrado. Vá em Meta Business Suite → Configurações → Contas WhatsApp, copie o ID e configure WA_BUSINESS_ACCOUNT_ID no Easypanel.' });
    let url = `https://graph.facebook.com/v21.0/${wabaId}/message_templates?fields=name,status,category,components&limit=200`;
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
        origem: m.ctwa_clid ? _origemCTWA(m.referral_data) : 'WhatsApp Direto',
        campanha: sanitizeStr(m.ad_id || '', 200), conteudo: '', fbclid: '', gclid: '',
        ctwa_clid: sanitizeStr(m.ctwa_clid || '', 500),
        referral_data: m.referral_data || {},
        wa_number_id: sanitizeStr(m.phone_number_id || '', 50),
        status: 'Lead', valor: null, tipo_trat: '',
        notas_sdr: '', notas_avaliacao: '', notas_comercial: '',
        score_interesse: null, perfil_disc: '',
        etiquetas: [], proximo_contato: null, ultimo_contato: new Date().toISOString(),
        enviado_meta: false, enviado_google: false, eventos_meta_enviados: [],
      }).select().single();
      if (insertErr) throw insertErr;
      lead = inserted;
      console.log('✅ Novo lead via WA: ' + m.nome + ' (' + m.from + ')' + (m.ctwa_clid ? ' [CTWA]' : ''));
      logEvento(lead.id, 'lead_criado',
        m.ctwa_clid ? 'Entrou via anúncio Meta (CTWA ✓)' : 'Primeira mensagem via WhatsApp',
        { origem: lead.origem, campanha: lead.campanha || '', ctwa_clid: m.ctwa_clid || '' }
      );
      if (m.ctwa_clid && lead) dispararConversaoMeta(lead).catch(e => console.error('Meta CAPI:', e.message));
    } else {
      const upd = { ultimo_contato: new Date().toISOString() };
      if (m.ctwa_clid && !lead.ctwa_clid) {
        upd.ctwa_clid = sanitizeStr(m.ctwa_clid, 500);
        upd.origem = _origemCTWA(m.referral_data);
        if (m.ad_id) upd.campanha = sanitizeStr(m.ad_id, 200);
        if (m.referral_data) upd.referral_data = m.referral_data;
      }
      if (m.phone_number_id && !lead.wa_number_id) {
        upd.wa_number_id = sanitizeStr(m.phone_number_id, 50);
      }
      const { data: updatedLead } = await supabase.from('leads').update(upd).eq('id', lead.id).select().single();
      if (m.ctwa_clid && !lead.ctwa_clid && updatedLead) {
        console.log('🔗 ctwa_clid atualizado em lead existente #' + lead.id);
        dispararConversaoMeta({ ...updatedLead, status: lead.status }).catch(e => console.error('Meta CAPI:', e.message));
      }
    }
    if (lead) {
      await supabase.from('mensagens').insert({
        lead_id: lead.id, direcao: 'recebida', canal: 'sdr',
        texto: sanitizeStr(m.texto, 4000), wa_id: m.id || '',
        tipo: m.tipo || 'text',
        media_id: m.media_id || null,
        mime: m.mime ? sanitizeStr(m.mime, 120) : null,
        media_filename: m.media_filename ? sanitizeStr(m.media_filename, 200) : null,
        wa_number_id: sanitizeStr(m.phone_number_id || '', 50),
      });
      logEvento(lead.id, 'mensagem_recebida',
        'Mensagem recebida: "' + (m.texto || '').slice(0, 80) + (m.texto?.length > 80 ? '…' : '') + '"',
        { wa_id: m.id || '', tipo: m.tipo }
      );
      // Detectar resposta a template (janela 48h)
      const h48ago = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      supabase.from('lead_eventos')
        .select('id, metadata, criado_em')
        .eq('lead_id', lead.id)
        .eq('tipo', 'template_enviado')
        .gte('criado_em', h48ago)
        .order('criado_em', { ascending: false })
        .limit(1)
        .then(async ({ data: tevts }) => {
          if (!tevts?.length) return;
          const { data: tresps } = await supabase.from('lead_eventos')
            .select('id').eq('lead_id', lead.id).eq('tipo', 'template_respondido')
            .gte('criado_em', tevts[0].criado_em).limit(1);
          if (tresps?.length) return;
          const minutos = Math.round((Date.now() - new Date(tevts[0].criado_em).getTime()) / 60000);
          logEvento(lead.id, 'template_respondido',
            'Respondeu ao template "' + (tevts[0].metadata?.template || '') + '" (' + minutos + ' min depois)',
            { template: tevts[0].metadata?.template || '', tempo_resposta_min: minutos }
          );
        }).catch(() => {});
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

// page_id do CAPI: a Meta EXIGE que o page_id enviado seja o da mesma Página que gerou o
// ctwa_clid (erro 400 subcode 2804072 quando não batem). A Página é determinada pelo ANÚNCIO
// (não pelo número de WhatsApp): o mesmo número pode receber cliques de anúncios de Páginas
// diferentes. Por isso resolvemos o page_id a partir do anúncio (referral.source_id):
//   ad -> creative.effective_object_story_id = "<page_id>_<post_id>".
// Requer token com ads_read (META_ADS_TOKEN; cai para META_ACCESS_TOKEN). Em cache por ad_id.
const _adPageCache = new Map();
async function resolveAdPageId(adId) {
  if (!adId) return '';
  if (_adPageCache.has(adId)) return _adPageCache.get(adId);
  const token = process.env.META_ADS_TOKEN || process.env.META_ACCESS_TOKEN;
  if (!token) return '';
  try {
    const r = await fetch('https://graph.facebook.com/' + META_API_VERSION + '/' + encodeURIComponent(adId) +
      '?fields=creative%7Beffective_object_story_id%7D&access_token=' + encodeURIComponent(token));
    const j = await r.json();
    const story = (j && j.creative && j.creative.effective_object_story_id) || '';
    const pageId = String(story).split('_')[0] || '';
    if (pageId) _adPageCache.set(adId, pageId);
    return pageId;
  } catch (e) { console.error('resolveAdPageId:', e.message); return ''; }
}

// Fallback de page_id por env quando não dá para resolver pelo anúncio.
// META_PAGE_ID_BY_WA (JSON) opcional: {"<wa_number_id>":"<page_id>","default":"<page_id>"}
function pageIdFallback(lead) {
  let map = {};
  try { map = JSON.parse(process.env.META_PAGE_ID_BY_WA || '{}'); } catch { map = {}; }
  const wa = lead && lead.wa_number_id ? lead.wa_number_id : 'default';
  return map[wa] || map.default || META_PAGE_ID || '';
}

// Eventos por action_source (testado ao vivo na API da Meta):
// - business_messaging: SÓ aceita LeadSubmitted e Purchase (demais dão 400 subcode 2804066).
// - system_generated:   aceita o funil inteiro (Lead/LeadQualified/Schedule/Contact/Purchase)
//   carregando o mesmo ctwa_clid → usado para as fases geradas pelo CRM.

const EVENTOS_FUNIL = {
  'Lead':              'LeadSubmitted',
  'Aguardando':        null,
  'Dra. Izabela':      null,
  'Em conversa - Qualificado':       null,
  'Em conversa - Lead Qualificado':  'LeadQualified',
  'Agendado':          'Schedule',
  'Compareceu':        'Contact',
  'Nutrir':            null,
  'Não tem Interesse': null,
  'D0':                null,
  'D1':                null,
  'D2':                null,
  'D3':                null,
  'D4':                null,
  'D5':                null,
  'Reclassificar':     null,
  'Em nutrição':       null,
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
  // action_source por evento (CTWA): a 1ª mensagem (LeadSubmitted) é ação do usuário no chat →
  // business_messaging; as fases geradas pelo CRM (Schedule/Contact/Purchase/LeadQualified) vão
  // como system_generated (que aceita o funil inteiro). Ambos levam ctwa_clid + page_id.
  // Leads não-CTWA (web) continuam como website.
  const action_source = !isCTWA ? 'website'
    : (eventName === 'LeadSubmitted' ? 'business_messaging' : 'system_generated');
  const user_data = {};
  if (lead.telefone) user_data.ph = [sha256(lead.telefone)];
  if (lead.email) user_data.em = [sha256(lead.email)];
  if (lead.nome) user_data.fn = [sha256(lead.nome.split(' ')[0])];
  if (isCTWA) {
    user_data.ctwa_clid = lead.ctwa_clid;
    // Prefere a Página resolvida pelo próprio anúncio; cai para o fallback por env.
    const adId = (lead.referral_data || {}).source_id || '';
    const pageId = (await resolveAdPageId(adId)) || pageIdFallback(lead);
    if (pageId) user_data.page_id = pageId;
  } else if (lead.fbclid) {
    user_data.fbc = 'fb.1.' + Math.floor(Date.now()/1000) + '.' + lead.fbclid;
  }
  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source,
      ...(action_source === 'business_messaging' && { messaging_channel: 'whatsapp' }),
      event_id: 'lead_' + lead.id + '_' + eventName,
      user_data,
      custom_data: { currency: 'BRL', value: parseFloat(lead.valor) || 0 },
    }],
    ...(process.env.META_TEST_EVENT_CODE && { test_event_code: process.env.META_TEST_EVENT_CODE }),
  };
  // Metadata de payload sem dados sensíveis em claro (telefone/email já são hash)
  const payloadResumo = payload.data[0];
  try {
    const r = await fetch('https://graph.facebook.com/' + META_API_VERSION + '/' + PIXEL + '/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
      body: JSON.stringify(payload),
    });
    const httpStatus = r.status;
    const json = await r.json();
    if (json.events_received) {
      console.log('📤 Meta CAPI ✓ Lead #' + lead.id + ' | evento: ' + eventName);
      logEvento(lead.id, 'capi_disparado',
        'CAPI: ' + eventName + ' enviado à Meta' + (parseFloat(lead.valor) > 0 ? ' (R$ ' + parseFloat(lead.valor).toFixed(2) + ')' : ''),
        {
          evento: eventName, valor: parseFloat(lead.valor) || 0, sucesso: true,
          http_status: httpStatus, action_source,
          payload_enviado: payloadResumo,
          resposta_meta: { events_received: json.events_received, messages: json.messages || [], fbtrace_id: json.fbtrace_id || null },
        }
      );
      const eventos = [...(lead.eventos_meta_enviados || [])];
      if (!eventos.includes(eventName)) eventos.push(eventName);
      const upd = { eventos_meta_enviados: eventos };
      if (eventName === 'Purchase') upd.enviado_meta = true;
      await supabase.from('leads').update(upd).eq('id', lead.id);
    } else {
      console.error('📤 Meta CAPI ✗ Lead #' + lead.id + ' | ' + eventName + ':', JSON.stringify(json).slice(0, 300));
      logEvento(lead.id, 'capi_disparado',
        'CAPI: ' + eventName + ' FALHOU (' + httpStatus + ')',
        {
          evento: eventName, valor: parseFloat(lead.valor) || 0, sucesso: false,
          http_status: httpStatus, action_source,
          payload_enviado: payloadResumo,
          resposta_meta: { error: json.error || json, fbtrace_id: json.fbtrace_id || null },
        }
      );
    }
  } catch (e) {
    console.error('📤 Meta CAPI ERRO Lead #' + lead.id + ':', e.message);
    logEvento(lead.id, 'capi_disparado',
      'CAPI: ' + eventName + ' ERRO de conexão',
      { evento: eventName, sucesso: false, erro: String(e.message).slice(0, 300), payload_enviado: payloadResumo }
    );
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
const _clinicorpReqs = []; // timestamps das req na janela de 1h (para rate limit display)

function _trackClinicorpReq() {
  const now = Date.now();
  _clinicorpReqs.push(now);
  const cutoff = now - 60 * 60 * 1000;
  while (_clinicorpReqs.length && _clinicorpReqs[0] < cutoff) _clinicorpReqs.shift();
}

app.get('/api/clinicorp-status', requireAuth, (req, res) => {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const recent = _clinicorpReqs.filter(t => t > cutoff);
  const oldest = recent[0] || now;
  const resetInMs = Math.max(0, (oldest + 60 * 60 * 1000) - now);
  res.json({ used: recent.length, limit: 25, resetIn: Math.ceil(resetInMs / 60000) });
});

// ===== CLINICORP CONSTANTES =====
const CLINICORP_CLINIC_ID   = 6182869788131328;
const CLINICORP_STATUS_ARRIVED = 5140799724060672; // "2-Em espera" (checkin)
const DENTISTAS_AVALIACAO = [
  { id: 5757301300985856, nome: 'Marcos - Avaliação' },
  { id: 6576596377468928, nome: 'Matheus G. - Avaliação' },
];

function clinicorpGet(apiPath, params = {}) {
  _trackClinicorpReq();
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
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch(e) { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout Clinicorp')); });
    req.on('error', reject);
    req.end();
  });
}


function clinicorpPost(apiPath, body) {
  _trackClinicorpReq();
  return new Promise((resolve, reject) => {
    const user  = process.env.CLINICORP_USER  || 'clinicaama';
    const token = process.env.CLINICORP_TOKEN || '';
    const auth  = Buffer.from(user + ':' + token).toString('base64');
    const qs = new URLSearchParams({
      subscriber_id: process.env.CLINICORP_SUBSCRIBER_ID || 'clinicaama',
      business_id:   process.env.CLINICORP_BUSINESS_ID   || 'clinicaama',
    }).toString();
    const bodyStr = JSON.stringify(body);
    const opts = {
      hostname: 'api.clinicorp.com',
      path: '/rest/v1' + apiPath + '?' + qs,
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth, 'X-Api-Key': token,
        'Accept': 'application/json', 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout Clinicorp')); });
    req.on('error', reject);
    req.write(bodyStr);
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
        name: (i.PatientName || i.patientName || i.Patient_PersonName || 'Paciente ' + patId).replace(/\s*\(\d+\)\s*$/, ''),
        phone: String(i.Phone || i.MobilePhone || i.phone || i.PayerPhone || ''),
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

// Coleta inadimplentes em background: consulta últimos 24 meses em chunks de 2 meses.
// Query única desde 2019 retorna ~20k itens mais antigos (todos pagos) pelo limite da API.
let _inadimplentesRefreshing = false;

async function fetchInadimplentesBackground() {
  if (_inadimplentesRefreshing) return;
  _inadimplentesRefreshing = true;
  console.log('[Inadimplentes] Background refresh iniciado...');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    const today = nowLocal().slice(0, 10);
    const allItems = [];
    for (let i = 0; i < 12; i++) {
      const toDate   = new Date(); toDate.setMonth(toDate.getMonth() - i * 2);
      const fromDate = new Date(); fromDate.setMonth(fromDate.getMonth() - (i + 1) * 2);
      const from = fromDate.toISOString().split('T')[0];
      const to   = toDate.toISOString().split('T')[0];
      try {
        const r = await clinicorpGet('/payment/list', { from, to, date_type: 'postDate' });
        if (r.status === 200 && Array.isArray(r.data)) {
          allItems.push(...r.data);
          console.log(`[Inadimplentes] chunk ${from}~${to}: ${r.data.length} itens (total ${allItems.length})`);
        }
      } catch(e) { console.log(`[Inadimplentes] chunk ${from} erro: ${e.message}`); }
      await sleep(400);
    }
    const processado = processarInadimplentes(allItems, today);
    await supabase.from('inadimplentes_cache').upsert({
      id: 1, data: processado, atualizado_em: Date.now(),
      endpoint: '/payment/list?postDate (24mo chunks)',
    });
    console.log(`[Inadimplentes] ✅ Background: ${processado.totais.pacientes} inadimplentes de ${allItems.length} registros`);
  } catch(e) {
    console.error('[Inadimplentes] Background refresh erro:', e.message);
  } finally {
    _inadimplentesRefreshing = false;
  }
}

// ========== AGENDAMENTO CLINICORP ==========

// Horários disponíveis de um dentista num dia
app.get('/api/clinicorp/horarios', requireAuth, rateLimit, async (req, res) => {
  const { data, dentista_id } = req.query;
  if (!data || !dentista_id) return res.status(400).json({ error: 'data e dentista_id obrigatórios' });
  const dentistaId = parseInt(dentista_id, 10);
  const dentista = DENTISTAS_AVALIACAO.find(d => d.id === dentistaId);
  if (!dentista) return res.status(400).json({ error: 'Dentista não permitido' });
  try {
    const dateTo = new Date(data); dateTo.setDate(dateTo.getDate() + 1);
    const to = dateTo.toISOString().split('T')[0];
    const r = await clinicorpGet('/appointment/list', { from: data, to });
    const apts = Array.isArray(r.data) ? r.data : (Array.isArray(r) ? r : []);
    const ocupados = apts.filter(a =>
      !a.Deleted &&
      (String(a.Dentist_PersonId) === String(dentistaId) || String(a.DoctorId) === String(dentistaId))
    );
    // Gera slots de 30 min das 08:00 às 17:30
    const slots = [];
    for (let h = 8; h < 18; h++) {
      for (let m = 0; m < 60; m += 30) {
        const from_t = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        const toM = m === 30 ? 0 : 30; const toH = m === 30 ? h + 1 : h;
        const to_t = `${String(toH).padStart(2,'0')}:${String(toM).padStart(2,'0')}`;
        if (toH >= 18) break;
        const ocupado = ocupados.some(a => {
          const af = a.FromTime || a.fromTime || '';
          const at = a.ToTime   || a.toTime   || '';
          return af && at && af < to_t && at > from_t;
        });
        slots.push({ from: from_t, to: to_t, disponivel: !ocupado });
      }
    }
    res.json(slots.map(s => ({ inicio: s.from, ocupado: !s.disponivel })));
  } catch(e) { console.error('clinicorp/horarios:', e); res.status(500).json({ error: e.message }); }
});

// Criar agendamento no Clinicorp a partir de um lead do CRM
app.post('/api/leads/:id/agendar-clinicorp', requireAuth, rateLimit, async (req, res) => {
  const leadId = parseInt(req.params.id, 10);
  const { data, hora_inicio, dentista_id } = req.body;
  if (!data || !hora_inicio || !dentista_id) return res.status(400).json({ error: 'data, hora_inicio e dentista_id obrigatórios' });
  const dentistaId = parseInt(dentista_id, 10);
  const dentista = DENTISTAS_AVALIACAO.find(d => d.id === dentistaId);
  if (!dentista) return res.status(400).json({ error: 'Dentista não autorizado' });
  try {
    const { data: lead } = await supabase.from('leads').select('*').eq('id', leadId).maybeSingle();
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

    // 1. Buscar/criar paciente no Clinicorp
    // A API do Clinicorp identifica paciente por `PatientId` (não `id`); /patient/get
    // retorna um array. Helpers para extrair o id de forma robusta:
    const _firstPatient = d => Array.isArray(d) ? d[0] : (Array.isArray(d?.data) ? d.data[0] : (d?.data || d));
    const _patientId = o => (o && (o.PatientId || o.Patient_PersonId || o.id)) || null;
    // O Clinicorp guarda o telefone SEM o DDI 55; nossos leads guardam COM. Remover o 55
    // (número BR tem 12-13 dígitos com DDI) — senão /patient/get nunca casa.
    const _foneClinicorp = raw => { let p = String(raw||'').replace(/\D/g,''); if (p.startsWith('55') && p.length >= 12) p = p.slice(2); return p; };
    let patient_id = lead.clinicorp_patient_id || null;
    if (!patient_id && lead.telefone) {
      const phone = _foneClinicorp(lead.telefone);
      const pr = await clinicorpGet('/patient/get', { Phone: phone });
      const pid = _patientId(_firstPatient(pr?.data));
      if (pid) {
        patient_id = pid;
        await supabase.from('leads').update({ clinicorp_patient_id: patient_id }).eq('id', leadId);
      }
    }
    if (!patient_id && lead.nome) {
      const pr = await clinicorpGet('/patient/get', { Name: lead.nome });
      const pid = _patientId(_firstPatient(pr?.data));
      if (pid) patient_id = pid;
    }
    if (!patient_id) {
      const phone = _foneClinicorp(lead.telefone);
      const cr = await clinicorpPost('/patient/create', {
        subscriber_id: process.env.CLINICORP_SUBSCRIBER_ID || 'clinicaama',
        Name: sanitizeStr(lead.nome || 'Paciente', 100),
        ...(phone ? { MobilePhone: parseInt(phone) } : {}),
      });
      patient_id = _patientId(_firstPatient(cr?.data));
      if (patient_id) await supabase.from('leads').update({ clinicorp_patient_id: patient_id }).eq('id', leadId);
    }

    // 2. Calcular hora_fim (+30 min)
    const [h, m] = hora_inicio.split(':').map(Number);
    const hora_fim = `${String(m === 30 ? h + 1 : h).padStart(2,'0')}:${m === 30 ? '00' : '30'}`;

    // 3. Criar agendamento
    const dateISO = new Date(data + 'T00:00:00-03:00').toISOString();
    const aptBody = {
      PatientName: sanitizeStr(lead.nome || 'Paciente', 100),
      MobilePhone: lead.telefone || '',
      fromTime: hora_inicio, toTime: hora_fim,
      date: dateISO,
      Clinic_BusinessId: CLINICORP_CLINIC_ID,
      Dentist_PersonId: dentistaId,
      CategoryDescription: 'Avaliação',
      ...(patient_id ? { Patient_PersonId: patient_id } : {}),
    };
    const result = await clinicorpPost('/appointment/create_appointment_by_api', aptBody);
    if (result.status !== 200 || !result.data) throw new Error('Clinicorp: ' + JSON.stringify(result.data));
    const apt = Array.isArray(result.data) ? result.data[0] : result.data;
    const clinicorp_appointment_id = apt?.id || null;

    // 4. Salvar no lead (incluindo CRC responsável)
    const dataAgendamento = new Date(data + 'T' + hora_inicio + ':00-03:00').toISOString();
    const crcNome = req.user?.profile?.name || req.user?.email || null;
    await supabase.from('leads').update({
      status: 'Agendado', data_agendamento: dataAgendamento,
      clinicorp_appointment_id,
      crc_agendamento_id: req.user?.id || null,
      crc_agendamento_nome: crcNome,
    }).eq('id', leadId);

    res.json({ ok: true, clinicorp_appointment_id, dentista: dentista.nome, data, hora: hora_inicio + ' - ' + hora_fim, crc: crcNome });
    logEvento(leadId, 'clinicorp_agendado',
      'Agendado no Clinicorp: ' + dentista.nome + ' — ' + data,
      { dentista: dentista.nome, data, hora: hora_inicio, clinicorp_appointment_id },
      req.user?.id || null
    );
  } catch(e) {
    console.error('agendar-clinicorp:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Sync periódico: detecta comparecimento no Clinicorp e atualiza lead para "Compareceu" ──
// Últimos 11 dígitos para comparar telefones BR independente do prefixo 55
const normPhone = s => String(s || '').replace(/\D/g, '').slice(-11);

async function syncComparecimentos() {
  if (!process.env.CLINICORP_TOKEN) return;
  // Inclui Nutrir/Reclassificar: leads históricos que podem ter comparecido sem passar pelo CRM
  const PRE_COMPARECEU = ['Lead', 'Aguardando', 'Dra. Izabela', 'Agendado', 'Nutrir', 'Reclassificar'];
  try {
    const d30ago  = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const r = await clinicorpGet('/appointment/list', { from: d30ago, to: tomorrow });
    const apts = r?.data || [];

    // ── Phase 1: leads com clinicorp_appointment_id (agendados via CRM) ──
    const { data: linkedLeads } = await supabase.from('leads')
      .select('id, clinicorp_appointment_id, status')
      .not('clinicorp_appointment_id', 'is', null)
      .in('status', PRE_COMPARECEU);

    for (const lead of (linkedLeads || [])) {
      const apt = apts.find(a => String(a.id) === String(lead.clinicorp_appointment_id));
      if (!apt) continue;
      const chegou = apt.CheckinTime || apt.Status === 'Arrived' || apt.StatusId === CLINICORP_STATUS_ARRIVED;
      if (!chegou) {
        // Detectar falta: appointment existe mas passou 24h sem checkin
        const aptDateStr = apt.date || apt.Date || apt.AppointmentDate;
        if (!aptDateStr) continue;
        const aptTime = new Date(aptDateStr);
        const passou24h = Date.now() - aptTime.getTime() > 24 * 3600 * 1000;
        if (passou24h) {
          const { data: jaFaltou } = await supabase.from('lead_eventos')
            .select('id').eq('lead_id', lead.id).eq('tipo', 'clinicorp_faltou').limit(1);
          if (!jaFaltou?.length) {
            logEvento(lead.id, 'clinicorp_faltou',
              'Não compareceu à consulta agendada para ' + (apt.date || apt.Date || '').slice(0, 10),
              { clinicorp_appointment_id: lead.clinicorp_appointment_id }
            );
          }
        }
        continue;
      }
      const dataComp = apt.CheckinTime ? new Date(apt.CheckinTime).toISOString() : new Date().toISOString();
      await supabase.from('leads').update({ status: 'Compareceu', data_comparecimento: dataComp }).eq('id', lead.id);
      logEvento(lead.id, 'status_mudou', 'Status: Agendado → Compareceu (detectado via Clinicorp)',
        { de: lead.status, para: 'Compareceu' }, null);
      console.log(`[sync-compareceu] lead ${lead.id} → Compareceu (apt ${lead.clinicorp_appointment_id})`);
    }

    // ── Phase 2: match por telefone para leads sem clinicorp_appointment_id ──
    // Constrói mapa phone11 → ISO mais recente do CheckinTime
    const phoneCheckin = {};
    for (const apt of apts) {
      if (!apt.CheckinTime) continue;
      const p11 = normPhone(apt.MobilePhone || apt.Phone || '');
      if (!p11 || p11.length < 8) continue;
      const iso = new Date(apt.CheckinTime).toISOString();
      if (!phoneCheckin[p11] || iso > phoneCheckin[p11]) phoneCheckin[p11] = iso;
    }

    const phones11 = Object.keys(phoneCheckin);
    if (!phones11.length) return;

    // Busca leads em status pré-Compareceu e sem apt_id (para não duplicar Phase 1)
    const { data: candidates } = await supabase.from('leads')
      .select('id, telefone, status')
      .in('status', PRE_COMPARECEU)
      .is('clinicorp_appointment_id', null);

    for (const lead of (candidates || [])) {
      const p11 = normPhone(lead.telefone);
      const dataComp = phoneCheckin[p11];
      if (!dataComp) continue;
      await supabase.from('leads').update({ status: 'Compareceu', data_comparecimento: dataComp }).eq('id', lead.id);
      logEvento(lead.id, 'status_mudou', 'Status: → Compareceu (detectado via Clinicorp por telefone)',
        { de: lead.status, para: 'Compareceu', telefone: lead.telefone }, null);
      console.log(`[sync-compareceu] lead ${lead.id} → Compareceu (phone match)`);
    }

  } catch(e) {
    console.error('[sync-compareceu]', e.message);
  }
}
setInterval(syncComparecimentos, 10 * 60 * 1000);

// ── Webhook do Clinicorp (Clinicorp -> CRM, tempo real) ──────────────────────
// Cadastrado em sistema.clinicorp.com → Acesso Externo → Gestão de Webhook,
// apontando para https://<host>/api/clinicorp/webhook.
// Endpoint PÚBLICO (o Clinicorp não envia nosso JWT). Proteção opcional via
// CLINICORP_WEBHOOK_SECRET (querystring ?secret= ou header x-webhook-secret).
// v1: trata COMPARECIMENTO (check-in) → marca "Compareceu" + dispara CAPI Contact.
// Loga o payload cru para mapearmos o formato exato do Clinicorp na 1ª chamada real.
const _PODE_COMPARECER = new Set(['Lead','Aguardando','Dra. Izabela','Em conversa - Lead Qualificado','Agendado','Nutrir','Reclassificar']);

async function _processarAptWebhook(apt) {
  if (!apt || typeof apt !== 'object') return;
  const aptId = apt.id || apt.Id || apt.AppointmentId || null;
  const phone11 = normPhone(apt.MobilePhone || apt.Phone || apt.PatientPhone || '');
  const chegou = !!(apt.CheckinTime || apt.Status === 'Arrived' || apt.StatusId === CLINICORP_STATUS_ARRIVED);
  if (!chegou) return; // outros eventos por enquanto só ficam no log acima

  let lead = null;
  if (aptId) {
    const { data } = await supabase.from('leads').select('*').eq('clinicorp_appointment_id', aptId).maybeSingle();
    lead = data || null;
  }
  if (!lead && phone11 && phone11.length >= 8) {
    const { data } = await supabase.from('leads').select('*').ilike('telefone', '%' + phone11).limit(1);
    lead = (data && data[0]) || null;
  }
  if (!lead) { console.log('[clinicorp-webhook] comparecimento sem lead (apt ' + aptId + ', fone ' + phone11 + ')'); return; }
  if (!_PODE_COMPARECER.has(lead.status)) { console.log('[clinicorp-webhook] lead ' + lead.id + ' já em "' + lead.status + '"; ignora'); return; }

  const dataComp = apt.CheckinTime ? new Date(apt.CheckinTime).toISOString() : new Date().toISOString();
  await supabase.from('leads').update({ status: 'Compareceu', data_comparecimento: dataComp }).eq('id', lead.id);
  logEvento(lead.id, 'status_mudou', 'Status: ' + lead.status + ' → Compareceu (webhook Clinicorp)',
    { de: lead.status, para: 'Compareceu' }, null);
  dispararConversaoMeta({ ...lead, status: 'Compareceu' }).catch(e => console.error('Meta CAPI:', e.message));
  console.log('[clinicorp-webhook] lead ' + lead.id + ' → Compareceu (apt ' + aptId + ')');
}

app.post('/api/clinicorp/webhook', async (req, res) => {
  console.log('[clinicorp-webhook] payload:', JSON.stringify(req.body || {}).slice(0, 3000));
  const secret = process.env.CLINICORP_WEBHOOK_SECRET;
  if (secret && req.query.secret !== secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.json({ ok: true }); // responde rápido; processa em seguida
  try {
    const body = req.body || {};
    const cand = body.data || body.appointment || body.Appointment || body.appointments || body;
    const apts = Array.isArray(cand) ? cand : [cand];
    for (const apt of apts) await _processarAptWebhook(apt);
  } catch (e) {
    console.error('[clinicorp-webhook] processamento:', e.message);
  }
});

async function syncTemplateSemResposta() {
  try {
    const h48ago = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const { data: expirados } = await supabase.from('lead_eventos')
      .select('id, lead_id, metadata, criado_em')
      .eq('tipo', 'template_enviado')
      .lt('criado_em', h48ago)
      .limit(100);
    await Promise.all((expirados || []).map(async te => {
      const { data: resp } = await supabase.from('lead_eventos')
        .select('id').eq('lead_id', te.lead_id)
        .in('tipo', ['template_respondido', 'template_sem_resposta'])
        .gte('criado_em', te.criado_em).limit(1);
      if (!resp?.length) {
        logEvento(te.lead_id, 'template_sem_resposta',
          'Sem resposta ao template "' + (te.metadata?.template || '') + '" após 48h',
          { template: te.metadata?.template || '' }
        );
      }
    }));
  } catch(e) { console.error('[sync] template_sem_resposta:', e.message); }
}
setInterval(syncTemplateSemResposta, 30 * 60 * 1000);

// ── Meta diária de agendamentos ──────────────────────────────────────────────
app.get('/api/meta-agendamentos', requireAuth, async (req, res) => {
  try {
    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD
    const [configRes, leadsRes] = await Promise.all([
      supabase.from('app_config').select('meta_agendamentos_diarios').eq('id', 1).maybeSingle(),
      supabase.from('leads')
        .select('id, crc_agendamento_id, crc_agendamento_nome, data_agendamento')
        .gte('data_agendamento', hoje + 'T00:00:00-03:00')
        .lte('data_agendamento', hoje + 'T23:59:59-03:00'),
    ]);
    const meta = configRes.data?.meta_agendamentos_diarios || 10;
    const agendamentos = leadsRes.data || [];

    // Agrupar por CRC
    const porCrc = {};
    agendamentos.forEach(l => {
      const key = l.crc_agendamento_id;
      if (!porCrc[key]) porCrc[key] = { nome: l.crc_agendamento_nome || 'CRC', total: 0 };
      porCrc[key].total++;
    });

    res.json({ meta, total: agendamentos.length, por_crc: Object.values(porCrc) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/meta-agendamentos', requireAuth, requireRole('admin', 'gestor'), async (req, res) => {
  const { meta } = req.body;
  const valor = parseInt(meta, 10);
  if (!valor || valor < 1) return res.status(400).json({ error: 'meta deve ser um número positivo' });
  try {
    await supabase.from('app_config').update({ meta_agendamentos_diarios: valor }).eq('id', 1);
    res.json({ ok: true, meta: valor });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ========== DASHBOARD COMERCIAL — funil de avaliações ==========
// GET /api/comercial/funil?from=YYYY-MM-DD&to=YYYY-MM-DD&origem=<campanha|all>
app.get('/api/comercial/funil', requireAuth, requireDashboardAvaliacao, rateLimit, async (req, res) => {
  try {
    const { from, to } = req.query;
    const origem = (req.query.origem && req.query.origem !== 'all') ? req.query.origem : null;
    if (!from || !to) return res.status(400).json({ error: 'from e to são obrigatórios (YYYY-MM-DD)' });
    const toEnd = to + 'T23:59:59';

    // Avaliações VÁLIDAS (com orçamento) no período — topo do funil + tempos clínica
    const { data: avaliacoes } = await supabase.from('avaliacoes')
      .select('paciente_clinicorp_id, telefone, data, compareceu, lead_id, agendado_em, comparecimento_em')
      .eq('tem_orcamento', true).gte('data', from).lte('data', to);

    // Orçamentos PARTICULARES criados no período (pipeline do topo)
    const { data: orcCriados } = await supabase.from('orcamentos')
      .select('paciente_clinicorp_id, telefone, valor_particular, status, data_criacao, lead_id')
      .gt('valor_particular', 0).gte('data_criacao', from).lte('data_criacao', to);

    // Leads no período
    const { data: leads } = await supabase.from('leads')
      .select('id, telefone, origem, data_lead, data_agendamento, data_comparecimento')
      .gte('data_lead', from).lte('data_lead', toEnd);

    // Fechamentos no período (por data_fechamento) — particular aprovado
    const { data: fechados } = await supabase.from('orcamentos')
      .select('paciente_clinicorp_id, valor_particular, entrada_valor, data_fechamento, lead_id, revisao_status, valor_aprovado, entrada_aprovada')
      .eq('status', 'APPROVED').gt('valor_particular', 0)
      .gte('data_fechamento', from).lte('data_fechamento', to);

    // Avaliações dos pacientes dos fechamentos (qualquer data) p/ tempo-até-fechar e split
    const pacientesFechados = [...new Set((fechados || []).map(f => f.paciente_clinicorp_id))];
    let avalFechados = [];
    if (pacientesFechados.length) {
      const r = await supabase.from('avaliacoes')
        .select('paciente_clinicorp_id, data, comparecimento_em')
        .in('paciente_clinicorp_id', pacientesFechados);
      avalFechados = r.data || [];
    }

    const avaliacoesPorPaciente = new Map();
    for (const a of avalFechados) {
      if (!avaliacoesPorPaciente.has(a.paciente_clinicorp_id)) avaliacoesPorPaciente.set(a.paciente_clinicorp_id, []);
      avaliacoesPorPaciente.get(a.paciente_clinicorp_id).push(a);
    }
    const naoRejeitados = (fechados || []).filter(f => f.revisao_status !== 'rejeitado');
    const fechamentoPorPaciente = new Map();
    const fechamentoPorLead = new Map();
    for (const f of naoRejeitados) {
      const cur = fechamentoPorPaciente.get(f.paciente_clinicorp_id);
      if (!cur || f.data_fechamento > cur) fechamentoPorPaciente.set(f.paciente_clinicorp_id, f.data_fechamento);
      if (f.lead_id != null) {
        const c2 = fechamentoPorLead.get(f.lead_id);
        if (!c2 || f.data_fechamento > c2) fechamentoPorLead.set(f.lead_id, f.data_fechamento);
      }
    }

    const aprovados = naoRejeitados.filter(f => f.revisao_status === 'aprovado')
      .map(f => ({ ...f, valor_particular: f.valor_aprovado, entrada_valor: f.entrada_aprovada }));
    const pendentes = naoRejeitados.filter(f => f.revisao_status === 'pendente');

    // topo do funil: usa valor_particular como "valor"
    const orcTopo = (orcCriados || []).map(o => ({ ...o, valor: o.valor_particular }));
    const resultado = agregarFunil({ leads: leads || [], avaliacoes: avaliacoes || [], orcamentos: orcTopo, origem });
    const fechamentos_mes = {
      confirmado: agregarFechamentos({ orcamentos: aprovados, avaliacoesPorPaciente }),
      pendente:   agregarFechamentos({ orcamentos: pendentes, avaliacoesPorPaciente }),
    };
    const tempos_fase = temposPorFase({ avaliacoes: avaliacoes || [], fechamentoPorPaciente, leads: leads || [], fechamentoPorLead });

    const origens = [...new Set((leads || []).map(l => l.origem).filter(Boolean))].sort();
    res.json({ from, to, origem: origem || 'all', origens, ...resultado, fechamentos_mes, tempos_fase });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dashboard comercial do CRM Antigo (eventos historico_* em lead_eventos).
// Spec: docs/superpowers/specs/2026-06-06-dashboard-crm-antigo-design.md
app.get('/api/comercial/dashboard', requireAuth, requireDashboardAvaliacao, rateLimit, async (req, res) => {
  try {
    const preset = req.query.preset || '30d';
    const origem = (req.query.origem && req.query.origem !== 'all') ? req.query.origem : null;
    if (preset === 'custom') {
      const dre = /^\d{4}-\d{2}-\d{2}$/;
      if (!dre.test(req.query.from || '') || !dre.test(req.query.to || '') || req.query.from > req.query.to) {
        return res.status(400).json({ error: 'custom exige from e to válidos (YYYY-MM-DD, com from <= to)' });
      }
    }
    const periodo = resolvePeriodo(preset, req.query.from || null, req.query.to || null);
    const payload = await montarDashboard(supabase, periodo, origem);
    res.json(payload);
  } catch (e) {
    console.error('❌ /api/comercial/dashboard:', e.message);
    res.status(500).json({ error: 'Falha ao montar o dashboard' });
  }
});

// Monitor de Validação Diária do CRM Novo (eventos lead_criado/status_mudou).
// Spec: docs/superpowers/specs/2026-06-07-monitor-validacao-crm-novo-design.md
app.get('/api/comercial/monitor', requireAuth, requireDashboardAvaliacao, rateLimit, async (req, res) => {
  try {
    const preset = req.query.preset || 'mes';
    if (preset === 'custom') {
      const dre = /^\d{4}-\d{2}-\d{2}$/;
      if (!dre.test(req.query.from || '') || !dre.test(req.query.to || '') || req.query.from > req.query.to) {
        return res.status(400).json({ error: 'custom exige from e to válidos (YYYY-MM-DD, com from <= to)' });
      }
    }
    const periodo = resolvePeriodo(preset, req.query.from || null, req.query.to || null);
    const { eventos, leadValor } = await buscarEventosNovos(supabase, periodo.from, periodo.to);
    const out = montarMonitor(eventos, leadValor, { from: periodo.from, to: periodo.to });
    res.json({ periodo, ...out });
  } catch (e) {
    console.error('❌ /api/comercial/monitor:', e.message);
    res.status(500).json({ error: 'Falha ao montar o monitor' });
  }
});

// ===== Conferência da CRC =====
// GET /api/comercial/conferencia?status=pendente|aprovado|rejeitado
app.get('/api/comercial/conferencia', requireAuth, requireDashboardAvaliacao, rateLimit, async (req, res) => {
  try {
    const status = ['pendente', 'aprovado', 'rejeitado'].includes(req.query.status) ? req.query.status : 'pendente';
    const { data, error } = await supabase.from('orcamentos')
      .select('clinicorp_estimate_id, paciente_nome, profissional_nome, valor_particular, entrada_valor, data_fechamento, valor_aprovado, entrada_aprovada, revisao_status, revisao_motivo')
      .eq('status', 'APPROVED').gt('valor_particular', 0).not('data_fechamento', 'is', null)
      .eq('revisao_status', status)
      .order('data_fechamento', { ascending: false }).limit(500);
    if (error) throw error;
    res.json({ status, fechamentos: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/comercial/conferencia/:estimateId  body { acao:'aprovar'|'rejeitar', valor?, entrada?, motivo? }
app.post('/api/comercial/conferencia/:estimateId', requireAuth, requireDashboardAvaliacao, rateLimit, async (req, res) => {
  try {
    const id = String(req.params.estimateId);
    const { acao } = req.body;
    if (!['aprovar', 'rejeitar'].includes(acao)) return res.status(400).json({ error: 'acao inválida' });

    const { data: orc } = await supabase.from('orcamentos')
      .select('valor_particular, entrada_valor, clinicorp_lastchange, lead_id, paciente_nome, data_fechamento')
      .eq('clinicorp_estimate_id', id).maybeSingle();
    if (!orc) return res.status(404).json({ error: 'Fechamento não encontrado' });

    const now = new Date().toISOString();
    let patch;
    if (acao === 'aprovar') {
      const num = (v, fb) => (v === undefined || v === null || v === '' || isNaN(Number(v))) ? fb : Math.max(0, Number(v));
      patch = {
        revisao_status: 'aprovado',
        valor_aprovado: num(req.body.valor, Number(orc.valor_particular || 0)),
        entrada_aprovada: num(req.body.entrada, Number(orc.entrada_valor || 0)),
        revisao_ref_lastchange: orc.clinicorp_lastchange || null,
        revisao_motivo: null,
        revisado_por: req.user.id, revisado_em: now,
      };
    } else {
      const motivo = sanitizeStr(req.body.motivo || '', 500).trim();
      if (!motivo) return res.status(400).json({ error: 'motivo é obrigatório para rejeitar' });
      patch = { revisao_status: 'rejeitado', revisao_motivo: motivo, revisado_por: req.user.id, revisado_em: now };
    }
    const { error } = await supabase.from('orcamentos').update(patch).eq('clinicorp_estimate_id', id);
    if (error) throw error;

    if (acao === 'aprovar' && orc.lead_id) {
      (async () => {
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
      })();
    }

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
    const { tratamento, executor } = req.query;
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
    const allowed = ['data_atualizacao','proximo_passo','data_agendamento','avaliador','executor','obs','is_alta','prioridade','tratamento','situacao_tratamento','data_vencimento','aba'];
    const patch = {};
    for (const k of allowed) { if (k in req.body) patch[k] = req.body[k] === '' ? null : req.body[k]; }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nada para atualizar' });
    patch.atualizado_em = new Date().toISOString();
    const { data, error } = await supabase.from('pacientes_sucesso').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Lista CRCs que já agendaram hoje (para filtro) ───────────────────────────
app.get('/api/crcs-agendamentos', requireAuth, async (req, res) => {
  try {
    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const { data } = await supabase.from('leads')
      .select('crc_agendamento_id, crc_agendamento_nome')
      .gte('data_agendamento', hoje + 'T00:00:00-03:00')
      .not('crc_agendamento_id', 'is', null);
    const seen = new Set();
    const crcs = (data || []).filter(l => {
      if (seen.has(l.crc_agendamento_id)) return false;
      seen.add(l.crc_agendamento_id); return true;
    }).map(l => ({ id: l.crc_agendamento_id, nome: l.crc_agendamento_nome }));
    res.json(crcs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/inadimplentes', requireAuth, rateLimit, async (req, res) => {
  try {
    if (!process.env.CLINICORP_TOKEN) {
      return res.status(503).json({ error: 'CLINICORP_TOKEN não configurado. Adicione nas variáveis de ambiente.' });
    }
    const forceRefresh = req.query.refresh === '1';
    const { data: cache } = await supabase.from('inadimplentes_cache').select('*').eq('id', 1).maybeSingle();
    const cacheAgeMs = cache?.atualizado_em ? Date.now() - Number(cache.atualizado_em) : Infinity;
    const CACHE_TTL_MS = 23 * 60 * 60 * 1000; // 23 horas

    if (forceRefresh || cacheAgeMs > CACHE_TTL_MS) {
      fetchInadimplentesBackground(); // dispara sem bloquear
    }

    if (cache?.data) {
      const result = await mergeInadimplentesNotas(cache.data);
      return res.json({
        ...result, from_cache: true,
        cache_min: Math.round(cacheAgeMs / 60000),
        refreshing: _inadimplentesRefreshing,
      });
    }

    return res.json({
      grupo1: [], grupo2: [], grupo3: [],
      totais: { pacientes: 0, valorTotal: 0, emCobranca: 0, renegociacao: 0, criticos: 0 },
      from_cache: false, refreshing: true,
      aviso: 'Coletando dados pela primeira vez da Clinicorp (24 meses em chunks). Aguarde 2–3 minutos e clique em "Atualizar dados".',
    });
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

async function getIaConfig(modulo) {
  const { data } = await supabase.from('ia_config').select('*').eq('modulo', modulo).maybeSingle();
  return data || { auto_analise_ativo: false, min_duracao_s: 60, limite_diario: 50, limite_semanal: 200 };
}

async function contarAnalisesHoje(modulo) {
  const hoje = new Date().toISOString().slice(0, 10);
  const { count } = await supabase.from('ia_uso_log')
    .select('*', { count: 'exact', head: true })
    .eq('modulo', modulo)
    .gte('criado_em', hoje + 'T00:00:00Z');
  return count || 0;
}

async function contarAnalisesSemana(modulo) {
  const seteDias = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const { count } = await supabase.from('ia_uso_log')
    .select('*', { count: 'exact', head: true })
    .eq('modulo', modulo)
    .gte('criado_em', seteDias);
  return count || 0;
}

async function processarGravacao(ligacao) {
  try {
    const config = await getIaConfig(ligacao.modulo);

    const elegivel = (
      ligacao.status === 'atendida' &&
      (ligacao.duracao_segundos || 0) >= config.min_duracao_s &&
      config.auto_analise_ativo &&
      (await contarAnalisesHoje(ligacao.modulo)) < config.limite_diario &&
      (await contarAnalisesSemana(ligacao.modulo)) < config.limite_semanal
    );

    if (!elegivel) return;

    let audioBuffer, contentType;
    try {
      ({ buffer: audioBuffer, contentType } = await threec.downloadGravacao(ligacao.gravacao_url));
    } catch (downloadErr) {
      console.warn(`⚠️ Download gravação falhou (tentativa ${ligacao.tentativas_gravacao + 1}):`, downloadErr.message);
      await supabase.from('ligacoes').update({
        tentativas_gravacao: (ligacao.tentativas_gravacao || 0) + 1,
        ...(ligacao.tentativas_gravacao >= 2 ? { status: 'falha_gravacao' } : {}),
      }).eq('id', ligacao.id);
      return;
    }

    const duracao = ligacao.duracao_segundos || 0;
    const { data: analise, tokensIn, tokensOut } = await geminiLib().analyzeLigacao({
      audioBuffer, contentType, modulo: ligacao.modulo,
    });

    const custoMin = parseFloat(process.env.GEMINI_COST_PER_MIN || '0.016');
    const custoEstimado = parseFloat(((duracao / 60) * custoMin).toFixed(4));

    await Promise.all([
      supabase.from('ligacoes').update({
        transcricao: analise.transcricao,
        analise_ia: { resumo: analise.resumo, pontos_fortes: analise.pontos_fortes, pontos_melhora: analise.pontos_melhora, score: analise.score },
        analisada_em: new Date().toISOString(),
        tentativas_gravacao: (ligacao.tentativas_gravacao || 0) + 1,
      }).eq('id', ligacao.id),
      supabase.from('ia_uso_log').insert({
        modulo: ligacao.modulo,
        duracao_audio_s: duracao,
        tokens_entrada: tokensIn,
        tokens_saida: tokensOut,
        custo_estimado: custoEstimado,
      }),
    ]);

    console.log(`✅ Ligação ${ligacao.id} analisada — score ${analise.score}`);
  } catch (e) {
    console.error('❌ processarGravacao:', ligacao.id, e.message);
  }
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
      .then(dgResult => {
        const words = dgResult?.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
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

app.get('/api/avaliacoes/dashboard', requireAuth, requireDashboardAvaliacao, async (req, res) => {
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
    const isGestor  = roles.some(r => ['gestor','admin','crc_comercial'].includes(r));
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
    const isGestor = roles.some(r => ['gestor','admin','crc_comercial'].includes(r));
    const isOwner = consulta.dentista_id === req.user.id;
    if (!isGestor && !isOwner) return res.status(403).json({ error: 'Acesso negado' });
    res.json(consulta);
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

app.post('/api/avaliacoes/:id/detalhar/:etapa_idx', requireAuth, requireRole('dentista', 'admin', 'gestor', 'mod_avaliacao_dentista'), requireModuloAtivo, async (req, res) => {
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

// ========== CRON 3cplus: RETRY GRAVAÇÕES ==========
setInterval(async () => {
  try {
    const { data: pendentes } = await supabase.from('ligacoes')
      .select('*')
      .not('gravacao_url', 'is', null)
      .is('transcricao', null)
      .gt('tentativas_gravacao', 0)
      .lt('tentativas_gravacao', 3)
      .neq('status', 'falha_gravacao')
      .limit(10);
    if (!pendentes?.length) return;
    console.log(`🔄 Cron 3cplus: reprocessando ${pendentes.length} gravação(ões)`);
    for (const lig of pendentes) {
      await processarGravacao(lig).catch(() => {});
    }
  } catch (e) {
    console.error('❌ cron 3cplus retry:', e.message);
  }
}, 3600000); // 1 hora

// ========== CRON 3cplus: POLLING GET /calls PARA PREENCHER threec_call_id ==========
// Converte "HH:MM:SS" → segundos
function hmsToSeconds(hms) {
  if (!hms || hms === '00:00:00') return 0;
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

// 3cplus não envia webhooks — usa Socket.io. Este cron faz polling como alternativa.
// Resposta de GET /api/v1/calls: {status:200, data:[{id,number,agent_id,call_date,speaking_with_agent_time,recording,status_id,...}]}
setInterval(async () => {
  if (!threec.temToken()) return;
  try {
    const duasHoras = new Date(Date.now() - 2 * 3600 * 1000);
    const { data: pendentes } = await supabase.from('ligacoes')
      .select('id, lead_id, usuario_id, criada_em, profiles:usuario_id(threec_agent_id)')
      .is('threec_call_id', null)
      .eq('status', 'iniciada')
      .gt('criada_em', duasHoras.toISOString())
      .limit(20);

    if (!pendentes?.length) return;

    const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');
    const { status, body } = await threec.getCalls({ startDate: fmt(duasHoras), endDate: fmt(new Date()) });

    if (status !== 200) {
      console.warn(`⚠️ cron 3cplus poll: GET /calls retornou ${status} — ${body.slice(0, 200)}`);
      return;
    }

    let chamadas;
    try {
      const parsed = JSON.parse(body);
      chamadas = parsed?.data;
    } catch { return; }
    if (!Array.isArray(chamadas)) {
      console.warn('⚠️ cron 3cplus poll — data não é array:', JSON.stringify(chamadas).slice(0, 200));
      return;
    }

    // Para cada ligação pendente, tenta encontrar a chamada correspondente no 3cplus
    for (const lig of pendentes) {
      const agentId = lig.profiles?.threec_agent_id;
      const { data: lead } = await supabase.from('leads').select('telefone').eq('id', lig.lead_id).maybeSingle();
      if (!lead?.telefone) continue;
      const destNorm = lead.telefone.replace(/\D/g, '');
      const criada = new Date(lig.criada_em).getTime();

      // Busca chamada: número bate nos últimos 8 dígitos + agent_id (se disponível) + janela ±15min
      const match = chamadas.find(c => {
        const dest = (c.number || '').replace(/\D/g, '');
        const agentOk = !agentId || c.agent_id === agentId;
        const ts = c.call_date_rfc3339 || c.call_date;
        const diff = ts ? Math.abs(new Date(ts).getTime() - criada) : Infinity;
        return dest.endsWith(destNorm.slice(-8)) && agentOk && diff < 900000; // 15min
      });

      if (!match) continue;

      const duracao = hmsToSeconds(match.speaking_with_agent_time);
      const novoPatch = {
        threec_call_id: String(match.id),
        status: match.status_id === 7 ? 'atendida' : 'nao_atendida',
        duracao_segundos: duracao || null,
        gravacao_url: match.recording || null,
      };
      await supabase.from('ligacoes').update(novoPatch).eq('id', lig.id);
      console.log(`✅ cron 3cplus poll: ligação ${lig.id} → call ${match.id} status=${novoPatch.status} dur=${duracao}s`);
      if (novoPatch.gravacao_url && novoPatch.status === 'atendida' && duracao >= 60) {
        processarGravacao({ ...lig, ...novoPatch }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('❌ cron 3cplus poll:', e.message);
  }
}, 1800000); // 30 minutos

// ========== STATIC ==========
app.get('/ligacoes', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ligacoes.html'));
});
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^\/(?!api\/|lead(\?|$)|webhooks\/|track\.js).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// ========== TRAJETO / ATRIBUICAO / ANUNCIOS ==========

app.get('/api/leads/:id/trajeto', requireAuth, requireRole('admin', 'gestor', 'crc_leads', 'crc_comercial', 'crc_sucesso', 'crc_pos_tratamento'), rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const offset = parseInt(req.query.offset, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const { data, error, count } = await supabase.from('lead_eventos')
      .select('*', { count: 'planned' })
      .eq('lead_id', id)
      .order('criado_em', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    res.json({ eventos: data || [], total: count || 0, offset, limit });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/atribuicao', requireAuth, requireRole('admin', 'gestor'), rateLimit, async (req, res) => {
  try {
    const periodo = parseInt(req.query.periodo, 10) || 30;
    const _parseDate = (s) => { const d = new Date(s); if (isNaN(d.getTime())) throw Object.assign(new Error('Data inválida: ' + s), { status: 400 }); return d.toISOString(); };
    const desde = req.query.desde ? _parseDate(req.query.desde) : new Date(Date.now() - periodo * 86400000).toISOString();
    const ate = req.query.ate ? _parseDate(req.query.ate) : new Date().toISOString();

    const { data: leads, error } = await supabase.from('leads')
      .select('id,campanha,ctwa_clid,fbclid,gclid,status,valor,data_agendamento,data_comparecimento,criado_em')
      .gte('criado_em', desde).lte('criado_em', ate).limit(5000);
    if (error) throw error;

    const { data: catalog } = await supabase.from('anuncios').select('chave,nome,fonte').eq('ativo', true);
    const catalogMap = {};
    (catalog || []).forEach(a => { catalogMap[a.chave.toLowerCase()] = { nome: a.nome, fonte: a.fonte }; });

    const grupos = {};
    const addGrupo = (chave, fonte) => {
      if (!grupos[chave]) grupos[chave] = { chave, fonte, nome: catalogMap[chave.toLowerCase()]?.nome || chave, leads: 0, qualificados: 0, agendados: 0, compareceu: 0, fechados: 0, receita: 0 };
    };

    for (const l of (leads || [])) {
      let chave, fonte;
      if (l.gclid && !l.ctwa_clid) { chave = l.campanha || '__google__'; fonte = 'google'; }
      else if (l.campanha && (l.ctwa_clid || l.fbclid)) { chave = l.campanha; fonte = 'meta'; }
      else if (l.ctwa_clid && !l.campanha) { chave = '__meta_sem_campanha__'; fonte = 'meta'; }
      else { chave = '__organico__'; fonte = '-'; }

      addGrupo(chave, fonte);
      const g = grupos[chave];
      g.leads++;
      if (l.status === 'Em conversa - Qualificado') g.qualificados++;
      if (l.data_agendamento) g.agendados++;
      if (l.data_comparecimento) g.compareceu++;
      if (l.status === 'Fechou') { g.fechados++; if (l.valor) g.receita += parseFloat(l.valor); }
    }

    if (grupos['__meta_sem_campanha__']) grupos['__meta_sem_campanha__'].nome = 'Meta Ads (sem campanha)';
    if (grupos['__organico__']) grupos['__organico__'].nome = 'Orgânico / Direto';
    if (grupos['__google__']) grupos['__google__'].nome = 'Google (sem campanha)';

    const lista = Object.values(grupos).sort((a, b) => b.leads - a.leads);
    const totais = lista.reduce((acc, g) => {
      if (g.chave !== '__organico__') {
        acc.leads += g.leads; acc.qualificados += g.qualificados; acc.agendados += g.agendados;
        acc.fechados += g.fechados; acc.receita += g.receita;
      }
      return acc;
    }, { leads: 0, qualificados: 0, agendados: 0, fechados: 0, receita: 0 });

    res.json({ grupos: lista, totais, periodo, desde, ate, truncado: (leads || []).length >= 5000 });
  } catch(e) { res.status(e.status || 500).json({ error: e.message }); }
});

// CPA / ROAS / Discrepância — cruza gasto+conversas do Meta com leads do CRM
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || '945699087658457';
app.get('/api/meta-insights', requireAuth, requireRole('admin', 'gestor'), rateLimit, async (req, res) => {
  try {
    const TOKEN = process.env.META_ACCESS_TOKEN;
    if (!TOKEN) return res.status(200).json({ error: 'META_ACCESS_TOKEN não configurado', sem_token: true, anuncios: [] });

    const _parseDate = (s) => { const d = new Date(s); if (isNaN(d.getTime())) throw Object.assign(new Error('Data inválida'), { status: 400 }); return d; };
    const periodo = parseInt(req.query.periodo, 10) || 30;
    const dDesde = req.query.desde ? _parseDate(req.query.desde) : new Date(Date.now() - periodo * 86400000);
    const dAte   = req.query.ate   ? _parseDate(req.query.ate)   : new Date();
    const ymd = d => d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

    // 1) Insights do Meta por anúncio (gasto + conversas iniciadas)
    const timeRange = JSON.stringify({ since: ymd(dDesde), until: ymd(dAte) });
    const url = 'https://graph.facebook.com/' + META_API_VERSION + '/act_' + META_AD_ACCOUNT_ID +
      '/insights?level=ad&fields=ad_id,ad_name,campaign_name,spend,actions' +
      '&time_range=' + encodeURIComponent(timeRange) + '&limit=500';
    const _metaCtrl = new AbortController();
    const _metaTimeout = setTimeout(() => _metaCtrl.abort(), 25000);
    let r;
    try {
      r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + TOKEN }, signal: _metaCtrl.signal });
    } finally {
      clearTimeout(_metaTimeout);
    }
    const json = await r.json();
    if (json.error) {
      return res.status(200).json({ erro_meta: json.error.message || 'Erro Meta', code: json.error.code, anuncios: [] });
    }
    const insights = {};
    (json.data || []).forEach(row => {
      const conv = (row.actions || []).find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d');
      insights[row.ad_id] = {
        ad_id: row.ad_id, ad_name: row.ad_name, campaign_name: row.campaign_name,
        spend: parseFloat(row.spend) || 0,
        meta_conversas: conv ? parseInt(conv.value, 10) : 0,
      };
    });

    // 2) Leads do CRM no período, agrupados por ad_id (lead.campanha = source_id)
    const { data: leads } = await supabase.from('leads')
      .select('campanha,ctwa_clid,status,valor,data_agendamento,data_comparecimento,criado_em')
      .gte('criado_em', dDesde.toISOString()).lte('criado_em', dAte.toISOString()).limit(5000);
    const crm = {};
    (leads || []).forEach(l => {
      if (!l.campanha || !/^\d{6,}$/.test(l.campanha)) return; // só leads com ad_id numérico
      if (!crm[l.campanha]) crm[l.campanha] = { leads: 0, agendados: 0, compareceu: 0, fechados: 0, receita: 0 };
      const g = crm[l.campanha];
      g.leads++;
      if (l.data_agendamento) g.agendados++;
      if (l.data_comparecimento) g.compareceu++;
      if (l.status === 'Fechou') { g.fechados++; if (l.valor) g.receita += parseFloat(l.valor); }
    });

    // 3) Cruza (união das chaves de insights e crm)
    const chaves = new Set([...Object.keys(insights), ...Object.keys(crm)]);
    const anuncios = [...chaves].map(adId => {
      const i = insights[adId] || { ad_id: adId, ad_name: '(anúncio fora do período)', campaign_name: '', spend: 0, meta_conversas: 0 };
      const c = crm[adId] || { leads: 0, agendados: 0, compareceu: 0, fechados: 0, receita: 0 };
      const cpa = c.fechados > 0 ? i.spend / c.fechados : null;
      const cpl = c.leads > 0 ? i.spend / c.leads : null;
      const roas = i.spend > 0 ? c.receita / i.spend : null;
      const discrepancia = i.meta_conversas - c.leads; // Meta reporta vs CRM real
      return { ...i, ...c, cpa, cpl, roas, discrepancia };
    }).filter(a => a.spend > 0 || a.leads > 0)
      .sort((a, b) => b.spend - a.spend);

    const totais = anuncios.reduce((t, a) => {
      t.spend += a.spend; t.meta_conversas += a.meta_conversas;
      t.leads += a.leads; t.fechados += a.fechados; t.receita += a.receita;
      return t;
    }, { spend: 0, meta_conversas: 0, leads: 0, fechados: 0, receita: 0 });
    totais.cpa = totais.fechados > 0 ? totais.spend / totais.fechados : null;
    totais.cpl = totais.leads > 0 ? totais.spend / totais.leads : null;
    totais.roas = totais.spend > 0 ? totais.receita / totais.spend : null;

    res.json({ anuncios, totais, desde: ymd(dDesde), ate: ymd(dAte), conta: META_AD_ACCOUNT_ID });
  } catch(e) {
    if (e.name === 'AbortError') {
      return res.status(200).json({ erro_meta: 'A Meta API não respondeu a tempo. Tente um período menor ou tente novamente.', anuncios: [] });
    }
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Cache de thumbnails de anúncios (em memória, TTL 6h)
const _thumbCache = new Map();
app.get('/api/anuncio-thumb/:adId', requireAuth, rateLimit, async (req, res) => {
  const adId = String(req.params.adId || '').replace(/\D/g, '');
  if (!adId || adId.length < 6) return res.status(400).json({ error: 'ad_id inválido' });
  const TOKEN = process.env.META_ACCESS_TOKEN;
  if (!TOKEN) return res.json({ thumbnail_url: null, nome: null, indisponivel: true });

  const cached = _thumbCache.get(adId);
  if (cached && cached.exp > Date.now()) return res.json(cached.data);

  try {
    const url = 'https://graph.facebook.com/' + META_API_VERSION + '/' + adId +
      '?fields=name,creative{thumbnail_url,image_url}';
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + TOKEN } });
    const json = await r.json();
    if (json.error) {
      const data = { thumbnail_url: null, nome: null, indisponivel: true };
      _thumbCache.set(adId, { data, exp: Date.now() + 3600000 }); // 1h em erro
      return res.json(data);
    }
    const thumb = json.creative?.image_url || json.creative?.thumbnail_url || null;
    const data = { thumbnail_url: thumb, nome: json.name || null };
    _thumbCache.set(adId, { data, exp: Date.now() + 6 * 3600000 }); // 6h em sucesso
    res.json(data);
  } catch(e) { res.json({ thumbnail_url: null, nome: null, indisponivel: true }); }
});

app.get('/api/anuncios', requireAuth, requireRole('admin', 'gestor'), rateLimit, async (req, res) => {
  try {
    const { data, error } = await supabase.from('anuncios').select('*').order('criado_em', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/anuncios', requireAuth, requireRole('admin'), rateLimit, async (req, res) => {
  try {
    const { fonte, chave, nome, descricao = '' } = req.body;
    if (!fonte || !chave || !nome) return res.status(400).json({ error: 'fonte, chave e nome obrigatórios' });
    if (!['meta', 'google'].includes(fonte)) return res.status(400).json({ error: 'fonte inválida' });
    const { data, error } = await supabase.from('anuncios')
      .insert({ fonte, chave: String(chave).toLowerCase().trim(), nome: String(nome).trim(), descricao })
      .select().single();
    if (error) throw error;
    res.json({ ok: true, anuncio: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/anuncios/:id', requireAuth, requireRole('admin'), rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { nome, descricao, ativo } = req.body;
    const patch = {};
    if (nome !== undefined) patch.nome = String(nome).trim();
    if (descricao !== undefined) patch.descricao = String(descricao).trim();
    if (ativo !== undefined) patch.ativo = Boolean(ativo);
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada para atualizar' });
    const { data, error } = await supabase.from('anuncios').update(patch).eq('id', id).select().single();
    if (error) throw error;
    res.json({ ok: true, anuncio: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ========== NOTIFICAÇÕES + PUSH + TAREFAS ==========

async function sendPushToUser(usuarioId, title, body, data = {}) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  try {
    const { data: subs } = await supabase.from('push_subscriptions')
      .select('subscription').eq('usuario_id', usuarioId).eq('ativo', true);
    if (!subs?.length) return;
    const payload = JSON.stringify({ title, body, data });
    await Promise.allSettled(subs.map(s =>
      webpush.sendNotification(s.subscription, payload).catch(async e => {
        if (e.statusCode === 410) { // subscription expirada
          await supabase.from('push_subscriptions')
            .update({ ativo: false }).eq('usuario_id', usuarioId)
            .eq('endpoint', s.subscription.endpoint);
        }
      })
    ));
  } catch(e) { console.error('[push]', e.message); }
}

async function criarNotificacao(usuarioId, tipo, titulo, corpo, metadata = {}) {
  if (!usuarioId) return;
  try {
    await supabase.from('notificacoes').insert({ usuario_id: usuarioId, tipo, titulo, corpo, metadata });
    await sendPushToUser(usuarioId, titulo, corpo, { tipo, ...metadata });
  } catch(e) { console.error('[notif]', e.message); }
}

// Chave pública VAPID para o frontend registrar o service worker
app.get('/api/push/vapid-public', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

app.post('/api/push/subscribe', requireAuth, rateLimit, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Subscription inválida' });
    await supabase.from('push_subscriptions').upsert({
      usuario_id: req.user.id,
      endpoint: subscription.endpoint,
      subscription,
      ativo: true,
    }, { onConflict: 'usuario_id,endpoint' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/push/subscribe', requireAuth, rateLimit, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) {
      await supabase.from('push_subscriptions').update({ ativo: false })
        .eq('usuario_id', req.user.id).eq('endpoint', endpoint);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Notificações
app.get('/api/notificacoes', requireAuth, rateLimit, async (req, res) => {
  try {
    const { data } = await supabase.from('notificacoes')
      .select('*').eq('usuario_id', req.user.id)
      .order('criado_em', { ascending: false }).limit(50);
    const naoLidas = (data || []).filter(n => !n.lida).length;
    res.json({ notificacoes: data || [], nao_lidas: naoLidas });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/notificacoes/:id/lida', requireAuth, rateLimit, async (req, res) => {
  try {
    await supabase.from('notificacoes').update({ lida: true })
      .eq('id', req.params.id).eq('usuario_id', req.user.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/notificacoes/lidas-todas', requireAuth, rateLimit, async (req, res) => {
  try {
    await supabase.from('notificacoes').update({ lida: true })
      .eq('usuario_id', req.user.id).eq('lida', false);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Lista usuários ativos — usado pelo módulo Tarefas para popular o select "Atribuir para"
app.get('/api/usuarios', requireAuth, requireRole('admin', 'gestor'), rateLimit, async (req, res) => {
  try {
    const { data, error } = await supabase.from('profiles').select('id,nome').eq('ativo', true).order('nome');
    if (error) throw error;
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Tarefas
const _requireGestor = requireRole('admin', 'gestor');

app.get('/api/tarefas', requireAuth, rateLimit, async (req, res) => {
  try {
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const usuarioId = req.user.id;
    const isGestor = req.user.profile?.roles?.some(r => ['admin','gestor'].includes(r));
    let query = supabase.from('tarefas').select('*').eq('ativo', true);
    if (!isGestor) query = query.eq('atribuido_para', usuarioId);
    const { data: tarefas } = await query.order('prioridade', { ascending: false });
    if (!tarefas?.length) return res.json({ tarefas: [], hoje });

    // Garante instâncias de hoje para tarefas diárias
    const diarias = tarefas.filter(t => t.tipo === 'diaria');
    if (diarias.length) {
      await supabase.from('tarefa_instancias').upsert(
        diarias.map(t => ({ tarefa_id: t.id, usuario_id: t.atribuido_para, data_ref: hoje, status: 'pendente' })),
        { onConflict: 'tarefa_id,data_ref', ignoreDuplicates: true }
      );
    }

    // Busca instâncias de hoje
    const ids = tarefas.map(t => t.id);
    const { data: instancias } = await supabase.from('tarefa_instancias')
      .select('*').in('tarefa_id', ids).eq('data_ref', hoje);
    const instMap = {};
    (instancias || []).forEach(i => { instMap[i.tarefa_id] = i; });

    const resultado = tarefas.map(t => ({ ...t, instancia_hoje: instMap[t.id] || null }));
    res.json({ tarefas: resultado, hoje });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tarefas', _requireGestor, rateLimit, async (req, res) => {
  try {
    const { titulo, descricao='', tipo='pontual', atribuido_para, data_vencimento, prioridade='normal' } = req.body;
    if (!titulo || !atribuido_para) return res.status(400).json({ error: 'titulo e atribuido_para obrigatórios' });
    const { data, error } = await supabase.from('tarefas').insert({
      titulo: sanitizeStr(titulo, 200), descricao: sanitizeStr(descricao, 2000),
      tipo, atribuido_para, criado_por: req.user.id,
      data_vencimento: data_vencimento || null, prioridade,
    }).select().single();
    if (error) throw error;
    // Notifica o usuário
    await criarNotificacao(atribuido_para, 'tarefa_atribuida',
      '📋 Nova tarefa atribuída', titulo,
      { tarefa_id: data.id, tipo, prioridade }
    );
    res.json({ ok: true, tarefa: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/tarefas/:id', _requireGestor, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ALLOWED_T = ['titulo','descricao','tipo','atribuido_para','data_vencimento','prioridade','ativo'];
    const patch = {};
    ALLOWED_T.forEach(k => { if (req.body[k] !== undefined) patch[k] = req.body[k]; });
    patch.atualizado_em = new Date().toISOString();
    const { error } = await supabase.from('tarefas').update(patch).eq('id', id);
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tarefas/:id/concluir', requireAuth, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const { data: tarefa } = await supabase.from('tarefas').select('id,tipo,atribuido_para')
      .eq('id', id).single();
    if (!tarefa) return res.status(404).json({ error: 'Tarefa não encontrada' });
    if (tarefa.atribuido_para !== req.user.id &&
        !req.user.profile?.roles?.some(r => ['admin','gestor'].includes(r)))
      return res.status(403).json({ error: 'Sem permissão' });

    if (tarefa.tipo === 'diaria') {
      await supabase.from('tarefa_instancias').upsert({
        tarefa_id: id, usuario_id: tarefa.atribuido_para, data_ref: hoje,
        status: 'concluida', concluida_em: new Date().toISOString(),
      }, { onConflict: 'tarefa_id,data_ref' });
    } else {
      await supabase.from('tarefa_instancias').upsert({
        tarefa_id: id, usuario_id: tarefa.atribuido_para, data_ref: hoje,
        status: 'concluida', concluida_em: new Date().toISOString(),
      }, { onConflict: 'tarefa_id,data_ref' });
      await supabase.from('tarefas').update({ ativo: false }).eq('id', id);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Limpa notificações lidas com mais de 30 dias (roda no startup e a cada 24h)
async function limparNotificacoesAntigas() {
  const corte = new Date(Date.now() - 30 * 86400000).toISOString();
  try {
    await supabase.from('notificacoes').delete().eq('lida', true).lt('criado_em', corte);
  } catch (e) { console.error('[limparNotificacoesAntigas]', e.message); }
}
limparNotificacoesAntigas();
setInterval(limparNotificacoesAntigas, 24 * 3600000);

// ========== PIXEL RASTREIO ==========

// Token por lead: determinístico (sem coluna extra no banco)
// Formato: base64url(leadId) + '.' + hmac(8 chars)
function _lidToken(leadId) {
  const secret = process.env.TRACK_SECRET || process.env.PIXEL_TRACK_TOKEN || 'ama-lid-secret';
  const mac = crypto.createHmac('sha256', secret).update(String(leadId)).digest('hex').slice(0, 8);
  const payload = Buffer.from(String(leadId)).toString('base64url');
  return payload + '.' + mac;
}
function _lidResolve(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  let leadId;
  try { leadId = parseInt(Buffer.from(parts[0], 'base64url').toString(), 10); } catch { return null; }
  if (!Number.isFinite(leadId) || leadId <= 0) return null;
  const secret = process.env.TRACK_SECRET || process.env.PIXEL_TRACK_TOKEN || 'ama-lid-secret';
  const expectedMac = crypto.createHmac('sha256', secret).update(String(leadId)).digest('hex').slice(0, 8);
  return parts[1] === expectedMac ? leadId : null;
}

// Retorna o link de rastreio personalizado para um lead
app.get('/api/leads/:id/tracking-link', requireAuth, rateLimit, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
  const pagina = sanitizeStr(req.query.pagina || '', 100).replace(/[^a-z0-9\-\/]/gi, '').toLowerCase();
  const base = 'https://clinicaodontoama.com.br';
  const path = pagina ? '/' + pagina.replace(/^\//, '') : '/';
  const lid = _lidToken(id);
  res.json({ url: base + path + '?lid=' + lid, lid });
});

app.get('/track.js', (req, res) => {
  const token = process.env.PIXEL_TRACK_TOKEN || '';
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Access-Control-Allow-Origin', 'https://clinicaodontoama.com.br');
  res.send(`(function(){
  var p=new URLSearchParams(location.search);
  var BASE='https://plataformaama-plataforma.uc5as5.easypanel.host';
  // Captura UTMs e persiste entre páginas (link bio, posts, etc)
  var UK=['utm_source','utm_medium','utm_campaign','utm_content','utm_term'];
  var utm={};UK.forEach(function(k){var v=p.get(k);if(v){utm[k]=v;localStorage.setItem('_ama_'+k,v);}else{var s=localStorage.getItem('_ama_'+k);if(s)utm[k]=s;}});
  // Rastreio por lid (link personalizado enviado pelo CRC)
  var lid=p.get('lid');
  if(lid){
    fetch(BASE+'/t',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:${JSON.stringify(token)},lid:lid,evento:'PageView',pagina:location.pathname,referrer:document.referrer,utm:utm})
    }).catch(function(){});
  }
  // Rastreio por fbclid (anúncio Meta)
  var f=p.get('fbclid')||localStorage.getItem('_ama_fbclid');
  if(f)localStorage.setItem('_ama_fbclid',f);
  if(!f)return;
  fetch(BASE+'/t',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token:${JSON.stringify(token)},fbclid:f,evento:'PageView',pagina:location.pathname,referrer:document.referrer,utm:utm})
  }).catch(function(){});
})();`);
});

app.post('/t', rateLimit, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://clinicaodontoama.com.br');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  const { token, fbclid, lid, evento = 'PageView', pagina = '/', referrer = '', utm } = req.body || {};
  if (!process.env.PIXEL_TRACK_TOKEN) return res.status(503).send('');
  if (!token || token !== process.env.PIXEL_TRACK_TOKEN) return res.status(401).send('');
  const safePagina = String(pagina).slice(0, 200);
  const safeRef   = String(referrer).slice(0, 200);
  // Sanitiza UTMs (chaves conhecidas, valores curtos)
  const safeUtm = {};
  if (utm && typeof utm === 'object') {
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'].forEach(k => {
      if (typeof utm[k] === 'string' && utm[k]) safeUtm[k] = utm[k].slice(0, 200);
    });
  }
  res.status(204).send(''); // responde logo, processa em background

  try {
    // Ramo 1: link personalizado por lead (lid)
    if (lid) {
      const leadId = _lidResolve(lid);
      if (leadId) {
        await supabase.from('pixel_sessions').insert({
          lead_id: leadId, fbclid: '', pagina: safePagina, evento: String(evento).slice(0, 50),
          metadata: { referrer: safeRef, via: 'lid', utm: safeUtm },
        });
        logEvento(leadId, 'pixel_pagina',
          'Visitou via link: ' + safePagina + (safeRef ? ' (via ' + safeRef.replace(/^https?:\/\//, '').split('/')[0] + ')' : ''),
          { pagina: safePagina, referrer: safeRef, via: 'lid' }
        );
        // Notifica a CRC responsável pelo lead
        const { data: lead } = await supabase.from('leads')
          .select('id, nome, crc_comercial_id, crc_agendamento_id').eq('id', leadId).single();
        if (lead) {
          const crcId = lead.crc_comercial_id || lead.crc_agendamento_id;
          if (crcId) {
            const pagLabel = safePagina === '/' ? 'página inicial' : safePagina.replace(/^\//, '');
            await criarNotificacao(crcId, 'visita_lead',
              '👀 ' + (lead.nome || 'Lead') + ' acessou o site',
              'Visitou: ' + pagLabel,
              { lead_id: leadId, pagina: safePagina }
            );
          }
        }
      }
      return;
    }
    // Ramo 2: fbclid (anúncio Meta)
    if (!fbclid || typeof fbclid !== 'string' || fbclid.length > 500) return;
    const safeFbclid = fbclid.slice(0, 500);
    const { data: sessao } = await supabase.from('pixel_sessions').insert({
      fbclid: safeFbclid, pagina: safePagina, evento: String(evento).slice(0, 50),
      metadata: { referrer: safeRef, utm: safeUtm },
    }).select().single();
    if (!sessao) return;
    const { data: lead } = await supabase.from('leads')
      .select('id').eq('fbclid', safeFbclid).maybeSingle();
    if (lead) {
      await supabase.from('pixel_sessions').update({ lead_id: lead.id }).eq('id', sessao.id);
      logEvento(lead.id, 'pixel_pagina',
        'Visitou: ' + safePagina + (safeRef ? ' (via ' + safeRef.replace(/^https?:\/\//, '').split('/')[0] + ')' : ''),
        { pagina: safePagina, referrer: safeRef }
      );
    }
  } catch(e) { console.error('[/t]', e.message); }
});

app.options('/t', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://clinicaodontoama.com.br');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.status(204).send('');
});

app.use((err, req, res, next) => {
  console.error('💥', err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Erro interno' });
});

app.listen(PORT, () => {
  console.log('\n🦷 CRM Clínica em http://localhost:' + PORT);
  console.log('📱 WA básico: +' + WHATSAPP_NUMBER);
  console.log('📞 TotalVoice: ' + (totalvoice.temToken() ? 'configurada ✓' : 'não configurada'));
  console.log('💬 WA Cloud API: ' + (whatsapp.temToken() ? 'configurada ✓' : 'não configurada') + '\n');
});

