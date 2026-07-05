// ============================================================
//  CRM CLINICA - Servidor Node.js (Supabase edition)
// ============================================================

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
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
const { montarMonitorCrc, resumoCrcTexto } = require('./lib/monitor/crc');
const { montarDRE } = require('./lib/financeiro/dre');
const { montarDREMensal } = require('./lib/financeiro/dre-mensal');
const _DREAnalise = require('./public/js/financeiro/dre-analise');
const _PainelGestor = require('./public/js/painel/gestor');
const { alvosDaRegra } = require('./lib/financeiro/reclassificar');
const { nucleo: _finNucleo } = require('./lib/financeiro/normalizar');
const { syncPeriodo: syncFinanceiro, syncFluxoFuturo } = require('./sync/financeiro-sync');
const { dataLocal: _finDataLocal } = require('./lib/financeiro/data');
const { agruparParcelasPorMes } = require('./lib/financeiro/fluxo-futuro');
const _analiseParcelas = require('./lib/financeiro/analise-parcelas');
const _recuperacao = require('./lib/financeiro/recuperacao');
const _inad = require('./lib/financeiro/inadimplencia');
const { montarFatos: _dreMontarFatos, contasDetalhadas: _dreContasDetalhadas } = require('./lib/financeiro/avaliacao');
// Janela do mês anterior + mês corrente em America/Sao_Paulo. "Só mês corrente" deixava
// buracos: o sync das 02h do dia 30 não cobre o dia 30 inteiro, e a partir do dia 1º a
// janela nunca mais volta a sincronizar o mês anterior.
function _finMesCorrente() {
  const hojeBR = _finDataLocal(new Date().toISOString());  // 'YYYY-MM-DD' no fuso BR
  const [ano, mes] = hojeBR.slice(0, 7).split('-').map(Number);
  const anoAnterior = mes === 1 ? ano - 1 : ano;
  const mesAnterior = mes === 1 ? 12 : mes - 1;
  const from = `${anoAnterior}-${String(mesAnterior).padStart(2, '0')}-01`;
  return { from, to: hojeBR };
}

const _upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
const webpush = require('web-push');
const capiHealth = require('./lib/capi/health');
const { METRICAS: MKT_METRICAS, metricaPorKey: mktMetricaPorKey } = require('./lib/marketing/qualidade');
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:gestao.clinicaodontoama@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// Converte QUALQUER áudio (webm do Chrome, mp4/AAC do iOS, mp3/m4a de upload) para
// ogg/opus — único formato que o WhatsApp renderiza como mensagem de voz NATIVA.
// ffmpeg detecta o formato de entrada sozinho (pipe:0). -ac 1 (mono) garante a UI de voz.
// Async (spawn): spawnSync bloqueava o event loop inteiro durante a conversão
function _audioParaOggOpus(buffer) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-i', 'pipe:0', '-c:a', 'libopus', '-ac', '1', '-f', 'ogg', 'pipe:1']);
    const out = [];
    p.stdout.on('data', c => out.push(c));
    p.stderr.resume(); // descarta stderr para o processo não travar com o pipe cheio
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) return reject(new Error('Conversão de áudio falhou'));
      resolve(Buffer.concat(out));
    });
    p.stdin.on('error', () => {}); // EPIPE se o ffmpeg morrer antes de ler tudo
    p.stdin.end(buffer);
  });
}

let _buildCommit = 'unknown';
try { _buildCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['pipe','pipe','ignore'] }).trim(); } catch (_) {}
const _buildDeployedAt = new Date().toISOString();

const PORT = parseInt(process.env.PORT, 10) || 3000;
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || '5531999999999').replace(/\D/g, '');
const FUNIL = ['Novo', 'Em qualificação', 'Avaliação agendada', 'Compareceu', 'Em negociação', 'Fechou', 'Perdido'];
// Sufixo p/ busca por telefone imune ao 9º dígito/DDI (WhatsApp grava wa_id sem o 9 em números antigos):
// os 8 dígitos finais não mudam entre formatos. Retorna '' se a busca não parece telefone.
const sufixoTelefoneBusca = q => {
  const dig = String(q || '').replace(/\D/g, '');
  return dig.length >= 8 ? dig.slice(-8) : '';
};
const CARTEIRAS = ['Comercial', 'Dra. Izabela'];
const ESTADOS_FRIO = ['nunca_agendou', 'orcou_sem_fechar'];

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
// Cache de sessão/perfil em memória para reduzir egress no Supabase.
// O front dispara várias chamadas em rajada por ação (cada uma revalidava a
// sessão e recarregava o perfil). Aqui guardamos o resultado por ~60s.
// Trade-off aceitável p/ CRM interno: um logout demora até 60s p/ invalidar.
const AUTH_TTL = 60_000;
const _userCache = new Map();    // token  -> { user, exp }
const _profileCache = new Map(); // userId -> { profile, exp }
function _bustProfile(userId) { if (userId) _profileCache.delete(userId); }

async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const now = Date.now();
  const cached = _userCache.get(token);
  if (cached && cached.exp > now) { req.user = cached.user; return next(); }
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) { _userCache.delete(token); return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' }); }
  if (_userCache.size > 5000) _userCache.clear(); // sweep simples contra crescimento sem limite
  _userCache.set(token, { user, exp: now + AUTH_TTL });
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
const { chaveTelefone } = require('./lib/funil/telefone');
const { parseEchoes } = require('./lib/wa/echoes');
const { parseCsv } = require('./lib/disparos/parser');
const { ultimos8 } = require('./lib/disparos/matching');
const disparoRunner = require('./lib/disparos/runner');
const { coletarLeadIds } = require('./lib/disparos/leads-da-campanha');
const { normalizarRegra } = require('./lib/publicos/regra');
const { montarCsv } = require('./lib/publicos/csv');
const { toqueDevido, podeAutoPerder } = require('./lib/recuperacao/cadencia');

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
    const sendable = Object.keys(await whatsapp.getPhoneNumbers());
    res.json({ numbers, defaultPhoneId, sendable });
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
      nome: profile?.nome || req.user.user_metadata?.nome || req.user.user_metadata?.name || req.user.email,
      roles: profile?.roles || metaRoles || ['crc_leads'],
      threec_agent_token: profile?.threec_agent_token || null,
      threec_agent_ramal: profile?.threec_agent_ramal || null,
      softphone_modo: profile?.softphone_modo || 'iframe',
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
    _bustProfile(req.user.id);
    res.json({ ok: true, threec_agent_id: patch.threec_agent_id || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Login antecipado do agente na campanha manual (chamado pelo front quando o
// softfone conecta) — deixa o agente "ocioso/pronto" e elimina o atraso do
// login-na-hora-de-discar na 1ª ligação.
app.post('/api/me/3c-login', requireAuth, async (req, res) => {
  try {
    const p = await loadProfile(req);
    if (!p?.threec_agent_token) return res.json({ ok: false, motivo: 'sem token' });
    const ok = await threec.loginManual(p.threec_agent_token);
    res.json({ ok });
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
    _bustProfile(req.user.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Slugs de navegação válidos para a barra inferior mobile (nav_prefs.tabbar)
const NAV_SLUGS = new Set([
  'dashboard','leads','funil','conv-agendamentos','conv-avaliacao','disparos',
  'notas-fiscais','inadimplentes','usuarios','tarefas-gestor','config',
  'avaliacao-dentista','ligacoes',
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
  const now = Date.now();
  const c = _profileCache.get(req.user.id);
  if (c && c.exp > now) { req.user.profile = c.profile; return c.profile; }
  const { data } = await supabase.from('profiles')
    .select('id, nome, roles, threec_agent_token, threec_agent_ramal, threec_agent_id, softphone_modo').eq('id', req.user.id).maybeSingle();
  const profile = data || { roles: [] };
  _profileCache.set(req.user.id, { profile, exp: now + AUTH_TTL });
  req.user.profile = profile;
  return profile;
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
// Conversas WhatsApp: mesmas roles do item de menu + 'crc' legado
const requireConversas = requireRole('admin', 'gestor', 'crc', 'crc_leads', 'crc_comercial', 'crc_sucesso');
const requireDisparos = requireRole('admin', 'gestor', 'crc_comercial');
const requirePublicos = requireRole('admin', 'gestor', 'crc_comercial', 'mod_publicos');
const requireFinanceiro = requireRole('financeiro', 'admin', 'mod_financeiro');
const requireProducao  = requireRole('financeiro', 'admin', 'mod_financeiro', 'mod_producao');

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
    const { data: users, error } = await supabase.rpc('admin_list_users', { p_admin_id: req.user.id });
    if (error) throw error;
    if (!users?.length) return res.json([]);

    const userIds = users.map(u => u.id);

    const [ufResult, profResult] = await Promise.all([
      supabase.from('user_funcoes').select('user_id, funcao:funcao_id(id, nome)').in('user_id', userIds),
      supabase.from('profiles').select('id, roles_extra').in('id', userIds),
    ]);
    if (ufResult.error) throw ufResult.error;
    if (profResult.error) throw profResult.error;
    const uf = ufResult.data;
    const profiles = profResult.data;

    const funcoesByUser = {};
    (uf || []).forEach(row => {
      if (!funcoesByUser[row.user_id]) funcoesByUser[row.user_id] = [];
      funcoesByUser[row.user_id].push(row.funcao);
    });
    const extrasByUser = {};
    (profiles || []).forEach(p => { extrasByUser[p.id] = p.roles_extra || []; });

    res.json(users.map(u => ({
      ...u,
      funcoes: funcoesByUser[u.id] || [],
      roles_extra: extrasByUser[u.id] || [],
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nome, email, senha, funcoes = [], roles_extra = [] } = req.body;
    if (!email || !senha) return res.status(400).json({ error: 'email e senha são obrigatórios' });

    // Cria usuário com roles vazias — trigger preencherá ao atribuir funcoes
    const { data, error } = await supabase.rpc('admin_create_user', {
      p_admin_id: req.user.id,
      p_email:    email,
      p_password: senha,
      p_nome:     nome || email,
      p_roles:    [],
    });
    if (error) throw error;
    if (data?.error) return res.status(400).json({ error: data.error });

    // Auto-confirma o email para que o usuario possa logar imediatamente
    await supabase.rpc('admin_confirm_user', { p_admin_id: req.user.id, p_email: email });

    // Atribui funcoes + roles_extra (se fornecidos)
    const userId = data?.id;
    if (userId && (funcoes.length || roles_extra.length)) {
      await supabase.rpc('admin_update_user_funcoes', {
        p_user_id:     userId,
        p_funcao_ids:  funcoes,
        p_roles_extra: roles_extra,
        p_nome:        null,
      });
    }

    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nome, funcoes, roles_extra } = req.body;
    const { data, error } = await supabase.rpc('admin_update_user_funcoes', {
      p_user_id:     req.params.id,
      p_funcao_ids:  Array.isArray(funcoes)     ? funcoes     : [],
      p_roles_extra: Array.isArray(roles_extra) ? roles_extra : [],
      p_nome:        nome || null,
    });
    if (error) throw error;
    if (data?.error) return res.status(400).json({ error: data.error });
    _bustProfile(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
// ========== ADMIN: FUNÇÕES ==========
app.get('/api/admin/funcoes', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('funcoes').select('*').order('nome');
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/funcoes', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nome, roles } = req.body;
    if (!nome) return res.status(400).json({ error: 'nome obrigatório' });
    const { data, error } = await supabase
      .from('funcoes').insert({ nome, roles: Array.isArray(roles) ? roles : [] })
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/funcoes/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nome, roles } = req.body;
    const updates = {};
    if (nome !== undefined) updates.nome = nome;
    if (roles !== undefined) updates.roles = Array.isArray(roles) ? roles : [];
    const { data, error } = await supabase
      .from('funcoes').update(updates).eq('id', req.params.id)
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/funcoes/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('funcoes').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
        status: 'Novo', valor: null, tipo_trat: '',
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
      const suf = sufixoTelefoneBusca(q);
      query = query.or('nome.ilike.%' + safe + '%,telefone.ilike.%' + safe + '%,campanha.ilike.%' + safe + '%'
        + (suf ? ',telefone.ilike.%' + suf + '%' : ''));
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
    const { nome, telefone, email = '', origem = 'Direto', status = 'Novo', notas_sdr = '' } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
    const tel = sanitizeStr(telefone, 30).replace(/\D/g, '');
    if (!tel) return res.status(400).json({ error: 'Telefone obrigatório' });
    const { data: dup } = await supabase.from('leads').select('id').eq('telefone', tel).maybeSingle();
    if (dup) return res.status(409).json({ error: 'Telefone já cadastrado em outro lead' });
    const { data: lead, error } = await supabase.from('leads').insert({
      nome: sanitizeStr(nome), telefone: tel, email: sanitizeStr(email, 100),
      origem: sanitizeStr(origem), campanha: '', conteudo: '', fbclid: '', gclid: '', ctwa_clid: '',
      status: FUNIL.includes(status) ? status : 'Novo',
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
    const leadAntes = { status: lead.status, notas_sdr: lead.notas_sdr };
    const ALLOWED = [
      'nome','telefone','email','origem','status','valor','tipo_trat',
      'notas_sdr','notas_avaliacao','notas_comercial','observacao_interna',
      'score_interesse','perfil_disc','etiquetas',
      'proximo_contato','ultimo_contato',
      'crc_comercial_id','crc_comercial_nome',
      'crc_agendamento_id','crc_agendamento_nome',
      'carteira','motivo_perda','etapa_negociacao','data_compromisso','data_fechamento',
    ];
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const agora = new Date().toISOString();
    const patch = {};
    for (const k of Object.keys(req.body)) {
      if (!ALLOWED.includes(k)) continue;
      let v = req.body[k];
      if (k === 'status') {
        if (!FUNIL.includes(v)) return res.status(400).json({ error: 'Status inválido. Use: ' + FUNIL.join(', ') });
        if (v === 'Avaliação agendada' && !lead.data_agendamento) patch.data_agendamento = agora;
        if (v === 'Avaliação agendada') { patch.crc_agendamento_id = req.user?.id || null; patch.crc_agendamento_nome = req.user?.profile?.nome || null; }
        if (v === 'Compareceu' && !lead.data_comparecimento) patch.data_comparecimento = agora;
        if (v === 'Em negociação' && !lead.data_avaliacao) patch.data_avaliacao = agora;
        if (v === 'Em negociação' && !lead.data_orcamento) patch.data_orcamento = agora;
        // Entrou em negociação sem D definido → começa em D0; saiu de negociação → limpa o D.
        if (v === 'Em negociação' && !lead.etapa_negociacao && req.body.etapa_negociacao == null) patch.etapa_negociacao = 'D0';
        if (v !== 'Em negociação' && lead.etapa_negociacao) patch.etapa_negociacao = null;
        if (v === 'Fechou' && !lead.data_fechamento && req.body.data_fechamento == null) patch.data_fechamento = agora;
      }
      if (k === 'carteira' && !CARTEIRAS.includes(v)) return res.status(400).json({ error: 'Carteira inválida' });
      if (k === 'etapa_negociacao') {
        if (v === '' || v === null) v = null;
        else if (!['D0','D1','D2','D3','D4','D5'].includes(v)) return res.status(400).json({ error: 'Etapa de negociação inválida' });
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
      if (k === 'proximo_contato' || k === 'ultimo_contato' || k === 'data_compromisso' || k === 'data_fechamento') {
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
    if (patch.notas_sdr !== undefined && (patch.notas_sdr || '') !== (leadAntes.notas_sdr || '')) {
      logEvento(updated.id, 'nota_sdr_editada', 'Anotação SDR atualizada',
        { tamanho: (patch.notas_sdr || '').length }, req.user?.id || null);
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
const CARD_FIELDS = 'id,nome,telefone,origem,status,valor,criado_em,data_comparecimento,data_agendamento,data_fechamento,data_orcamento,data_avaliacao,crc_agendamento_nome,crc_comercial_nome,ultimo_contato,etapa_negociacao';

function buildLeadsColFilter(coluna, q, crc, countOnly = false, origem = null) {
  const now = Date.now();
  const d30  = new Date(now - 30  * 864e5).toISOString();
  const d180 = new Date(now - 180 * 864e5).toISOString();
  const d365 = new Date(now - 365 * 864e5).toISOString();
  const sel = countOnly ? '*' : CARD_FIELDS;
  const opts = countOnly ? { count: 'exact', head: true } : { count: 'exact' };
  // Board de leads é só carteira Comercial; Dra. Izabela fica fora do funil.
  let qb = supabase.from('leads').select(sel, opts).neq('carteira', 'Dra. Izabela');
  switch (coluna) {
    // 'lead' = Novo ativo (não frio); colunas nutrir_* = pool de reativação (frio) por idade
    case 'lead':
      qb = qb.eq('status', 'Novo').is('estado_frio', null).gte('criado_em', d30); break;
    case 'em_qualificacao':   qb = qb.eq('status', 'Em qualificação'); break;
    case 'nutrir_30':
      qb = qb.eq('status', 'Novo').not('estado_frio', 'is', null).lt('criado_em', d30).gte('criado_em', d180); break;
    case 'nutrir_180':
      qb = qb.eq('status', 'Novo').not('estado_frio', 'is', null).lt('criado_em', d180).gte('criado_em', d365); break;
    case 'nutrir_365':
      qb = qb.eq('status', 'Novo').not('estado_frio', 'is', null).lt('criado_em', d365); break;
    case 'agendado':          qb = qb.eq('status', 'Avaliação agendada'); break;
    case 'faltou':            qb = qb.contains('etiquetas', ['Faltou']); break;
    case 'nao_tem_interesse': qb = qb.eq('status', 'Perdido').eq('motivo_perda', 'Sem interesse'); break;
    default: return null;
  }
  if (q) {
    const safe = q.replace(/[%,()]/g, '');
    const suf = sufixoTelefoneBusca(q);
    qb = qb.or(`nome.ilike.%${safe}%,telefone.ilike.%${safe}%` + (suf ? `,telefone.ilike.%${suf}%` : ''));
  }
  if (crc)    qb = qb.eq('crc_agendamento_nome', crc);
  if (origem) qb = qb.eq('origem', origem);
  return qb;
}

const LEADS_COLUNAS = ['lead','em_qualificacao','agendado','faltou','nao_tem_interesse','nutrir_30','nutrir_180','nutrir_365'];

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
    // D0 acolhe quem entrou em negociação sem D ainda (etapa null) + os marcados D0
    case 'd0': qb = qb.eq('status', 'Em negociação').or('etapa_negociacao.is.null,etapa_negociacao.eq.D0'); break;
    case 'd1': qb = qb.eq('status', 'Em negociação').eq('etapa_negociacao', 'D1'); break;
    case 'd2': qb = qb.eq('status', 'Em negociação').eq('etapa_negociacao', 'D2'); break;
    case 'd3': qb = qb.eq('status', 'Em negociação').eq('etapa_negociacao', 'D3'); break;
    case 'd4': qb = qb.eq('status', 'Em negociação').eq('etapa_negociacao', 'D4'); break;
    case 'd5': qb = qb.eq('status', 'Em negociação').eq('etapa_negociacao', 'D5'); break;
    case 'fechou':
      qb = qb.eq('status', 'Fechou').gte('data_fechamento', d30); break;
    case 'perdido': qb = qb.eq('status', 'Perdido'); break;
    default: return null; // nutricao_* handled via RPC
  }
  if (q) {
    const safe = q.replace(/[%,()]/g, '');
    const suf = sufixoTelefoneBusca(q);
    qb = qb.or(`nome.ilike.%${safe}%,telefone.ilike.%${safe}%` + (suf ? `,telefone.ilike.%${suf}%` : ''));
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

app.get('/api/leads/:id/ligacoes', requireAuth, requireCrcLead, rateLimit, async (req, res) => {
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

// Lê TODAS as linhas de uma query paginando de 1000 em 1000 (o client Supabase
// trunca em 1000 por padrão). buildQuery deve devolver um builder NOVO a cada chamada.
async function _fetchAllPaginado(buildQuery) {
  const size = 1000; let from = 0; const all = [];
  for (;;) {
    const { data, error } = await buildQuery().range(from, from + size - 1);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < size) break;
    from += size;
  }
  return all;
}

const ABC_COLS = 'nome, telefone, clinicorp_id, dias_sem_visita, paciente_id';

// Resolve os contatos ABC para discagem a partir de:
//  - opts.incluir : lista explícita de clinicorp_id (modo seleção manual), OU
//  - opts.filtros : filtros da tabela (modo "todas as páginas"), OU
//  - nada         : critério fixo padrão (Classe A/B · 180+ dias · sem agenda)
async function _buscarContatosAbc(opts = {}) {
  const { data: bloqueados, error: blqError } = await supabase.from('nao_ligar_pacientes').select('clinicorp_id');
  if (blqError) throw blqError; // falha aberta incluiria pacientes bloqueados na campanha
  const bloqueadosSet = new Set((bloqueados || []).map(r => String(r.clinicorp_id)));

  let rows;
  if (Array.isArray(opts.incluir) && opts.incluir.length) {
    const ids = opts.incluir.map(String);
    rows = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const { data, error } = await supabase.from('pacientes_abc').select(ABC_COLS).in('clinicorp_id', chunk);
      if (error) throw error;
      rows.push(...(data || []));
    }
  } else {
    const f = opts.filtros;
    const usarPadrao = !f || (f.classe == null && f.minDias == null && f.maxDias == null
      && !f.semAgenda && !f.perio && !(Array.isArray(f.vipIds) && f.vipIds.length) && !f.busca);
    rows = await _fetchAllPaginado(() => {
      let q = supabase.from('pacientes_abc').select(ABC_COLS);
      if (usarPadrao) {
        q = q.in('classe', ['A', 'B']).gte('dias_sem_visita', 180).is('proxima_consulta', null);
      } else {
        if (Array.isArray(f.classe) && f.classe.length) q = q.in('classe', f.classe);
        if (f.minDias) q = q.gte('dias_sem_visita', Number(f.minDias));
        if (f.maxDias) q = q.lte('dias_sem_visita', Number(f.maxDias));
        if (f.semAgenda) q = q.is('proxima_consulta', null);
        if (f.perio) q = q.eq('perio', true);
        if (Array.isArray(f.vipIds) && f.vipIds.length) q = q.in('paciente_id', f.vipIds);
        if (f.busca) q = q.ilike('nome', '%' + String(f.busca) + '%');
      }
      return q;
    });
  }

  return rows
    .filter(p => !bloqueadosSet.has(String(p.clinicorp_id)))
    .map(c => ({ ...c, tipo_origem: 'abc' }));
}

async function buscarContatos(tipo, opts = {}) {
  if (tipo === 'abc') {
    return _buscarContatosAbc(opts);
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

// Preview dirigido pela seleção da tabela (filtros/incluir/excluir). Retorna a
// contagem REAL que irá discar (só com telefone) + os 100 primeiros p/ revisão.
app.post('/api/campanhas/preview', requireAuth, requireCrcLead, async (req, res) => {
  try {
    const { tipo } = req.body;
    if (!TIPOS_VALIDOS.includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });
    const contatos = await buscarContatos(tipo, { filtros: req.body.filtros, incluir: req.body.incluir });
    const idField = tipo === 'abc' ? 'clinicorp_id' : 'id';
    const excluirSet = new Set((req.body.excluir || []).map(String));
    const filtrados = excluirSet.size ? contatos.filter(c => !excluirSet.has(String(c[idField]))) : contatos;
    const comTelefone = filtrados.filter(c => c.telefone?.trim());
    res.json({ total: comTelefone.length, contatos: comTelefone.slice(0, 100) });
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

    const contatos = await buscarContatos(tipo, { filtros: req.body.filtros, incluir: req.body.incluir });
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

// ========== DISPARO EM MASSA (WhatsApp) ==========

const DISPARO_MAX_CONTATOS = 5000;

// Lê o CSV cru do request: arquivo (multer, campo 'file') ou { texto } no body.
function lerCsvDoRequest(req) {
  if (req.file && req.file.buffer) return req.file.buffer.toString('utf8');
  if (req.body && typeof req.body.texto === 'string') return req.body.texto;
  return '';
}

// Confirma que um template está aprovado (db status 'aprovado' ou allow-list de env).
async function templateAprovado(nome) {
  const envNames = (process.env.WA_TEMPLATES || '').split(',').map(t => t.trim()).filter(Boolean);
  if (envNames.includes(nome)) return true;
  const { data } = await supabase.from('templates').select('status').eq('nome', nome).maybeSingle();
  return !!data && data.status === 'aprovado';
}

app.post('/api/disparos/preview', requireAuth, requireDisparos, _upload.single('file'), async (req, res) => {
  try {
    const texto = lerCsvDoRequest(req);
    const { contatos, invalidos } = parseCsv(texto);
    if (!contatos.length) return res.json({ casam: 0, novos: 0, invalidos, total: 0, amostra: [] });
    if (contatos.length > DISPARO_MAX_CONTATOS) return res.status(413).json({ error: 'Lista muito grande (máximo ' + DISPARO_MAX_CONTATOS + ' contatos)' });

    // Matching em lote: junta os candidatos por sufixo (chunks de ilike) num só
    // conjunto de chaves, em vez de 1 query por contato.
    const sufixos = [...new Set(contatos.map(c => ultimos8(c.telefone)).filter(u => u.length === 8))];
    const leadKeys = new Set();
    for (let i = 0; i < sufixos.length; i += 50) {
      const chunk = sufixos.slice(i, i + 50);
      const orExpr = chunk.map(u => 'telefone.ilike.%' + u + '%').join(',');
      const { data } = await supabase.from('leads').select('telefone').or(orExpr).limit(1000);
      for (const l of data || []) { const k = chaveTelefone(l.telefone); if (k) leadKeys.add(k); }
    }
    let casam = 0;
    for (const c of contatos) { if (leadKeys.has(chaveTelefone(c.telefone))) casam++; }
    res.json({
      casam, novos: contatos.length - casam, invalidos,
      total: contatos.length,
      amostra: contatos.slice(0, 5).map(c => ({ nome: c.nome, telefone: c.telefone })),
    });
  } catch (e) {
    console.error('❌ disparos/preview:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/disparos/criar', requireAuth, requireDisparos, _upload.single('file'), async (req, res) => {
  try {
    const nome = sanitizeStr(req.body.nome, 120);
    const template_nome = sanitizeStr(req.body.template_nome, 100);
    const lang = sanitizeStr(req.body.lang || 'pt_BR', 12);
    // Número de envio: ausente = default (compat); presente precisa ter token (2873/8700).
    const sendable = await whatsapp.getPhoneNumbers();
    let wa_number_id = sanitizeStr(req.body.wa_number_id || '', 50);
    if (!wa_number_id) wa_number_id = whatsapp.defaultPhoneId() || '';
    else if (!sendable[wa_number_id]) {
      return res.status(400).json({ error: 'Número sem credencial de envio configurada' });
    }
    if (!nome) return res.status(400).json({ error: 'Nome da campanha obrigatório' });
    if (!template_nome) return res.status(400).json({ error: 'Template obrigatório' });
    if (!(await templateAprovado(template_nome))) return res.status(400).json({ error: 'Template não aprovado pela Meta' });

    const texto = lerCsvDoRequest(req);
    const { contatos } = parseCsv(texto);
    if (!contatos.length) return res.status(400).json({ error: 'Nenhum contato válido no CSV' });
    if (contatos.length > DISPARO_MAX_CONTATOS) return res.status(413).json({ error: 'Lista muito grande (máximo ' + DISPARO_MAX_CONTATOS + ' contatos)' });

    const { data: camp, error: cErr } = await supabase.from('disparos_campanhas').insert({
      nome, template_nome, lang, total: contatos.length, wa_number_id,
      status: 'rascunho', criado_por: req.user.id,
    }).select().single();
    if (cErr) throw cErr;

    const rows = contatos.map(c => ({
      campanha_id: camp.id, nome: c.nome, primeiro_nome: c.primeiro_nome,
      telefone: c.telefone, variaveis: [c.primeiro_nome || 'tudo bem'], status: 'pendente',
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error: iErr } = await supabase.from('disparos_contatos').insert(rows.slice(i, i + 500));
      if (iErr) throw iErr;
    }
    res.json({ campanha_id: camp.id, total: contatos.length });
  } catch (e) {
    console.error('❌ disparos/criar:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/disparos/:id/iniciar', requireAuth, requireDisparos, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    if (!whatsapp.temBroadcast()) return res.status(503).json({ error: 'Número de broadcast não configurado.' });
    const { data: ativa } = await supabase.from('disparos_campanhas')
      .select('id').eq('status', 'enviando').neq('id', id).limit(1);
    if (ativa && ativa.length) return res.status(409).json({ error: 'Já existe uma campanha enviando. Aguarde ou pause antes.' });

    // Transição atômica: só inicia se ainda estiver em 'rascunho'.
    const { data: upd } = await supabase.from('disparos_campanhas')
      .update({ status: 'enviando', auto_pausada: false, iniciada_em: new Date().toISOString() })
      .eq('id', id).eq('status', 'rascunho').select('id');
    if (!upd || !upd.length) return res.status(409).json({ error: 'Campanha não está em rascunho (já iniciada?).' });
    disparoRunner.iniciarRunner(id, { supabase, whatsapp, logEvento });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/disparos/:id/pausar', requireAuth, requireDisparos, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    await supabase.from('disparos_campanhas').update({ status: 'pausada' }).eq('id', id).eq('status', 'enviando');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/disparos/:id/retomar', requireAuth, requireDisparos, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data: ativa } = await supabase.from('disparos_campanhas')
      .select('id').eq('status', 'enviando').neq('id', id).limit(1);
    if (ativa && ativa.length) return res.status(409).json({ error: 'Já existe uma campanha enviando. Aguarde ou pause antes.' });
    // Transição atômica: só retoma se estiver 'pausada'.
    const { data: upd } = await supabase.from('disparos_campanhas')
      .update({ status: 'enviando', auto_pausada: false }).eq('id', id).eq('status', 'pausada').select('id');
    if (!upd || !upd.length) return res.status(409).json({ error: 'Campanha não está pausada.' });
    disparoRunner.iniciarRunner(id, { supabase, whatsapp, logEvento });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===================== PÚBLICOS (construtor de listas) =====================

// Preview: contagem + amostra. Sem rateLimit apertado (chamado com debounce).
app.post('/api/publicos/preview', requireAuth, requirePublicos, async (req, res) => {
  try {
    const regra = normalizarRegra(req.body && req.body.regra);
    const { data: totalData, error: e1 } = await supabase.rpc('publico_contar', { regra });
    if (e1) throw e1;
    const { data: amostra, error: e2 } = await supabase.rpc('publico_buscar', { regra, _limit: 20, _offset: 0 });
    if (e2) throw e2;
    res.json({ total: Number(totalData) || 0, amostra: amostra || [] });
  } catch (e) {
    console.error('❌ publicos/preview:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// CRUD de públicos salvos.
app.get('/api/publicos', requireAuth, requirePublicos, async (req, res) => {
  try {
    const { data, error } = await supabase.from('publicos')
      .select('id,nome,regra,criado_em,atualizado_em').order('atualizado_em', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/publicos', requireAuth, requirePublicos, async (req, res) => {
  try {
    const nome = sanitizeStr(req.body.nome, 120);
    if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
    const regra = normalizarRegra(req.body && req.body.regra);
    const { data, error } = await supabase.from('publicos')
      .insert({ nome, regra, criado_por: req.user.id }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/publicos/:id', requireAuth, requirePublicos, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const nome = sanitizeStr(req.body.nome, 120);
    if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
    const regra = normalizarRegra(req.body && req.body.regra);
    const { error } = await supabase.from('publicos')
      .update({ nome, regra, atualizado_em: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/publicos/:id', requireAuth, requirePublicos, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { error } = await supabase.from('publicos').delete().eq('id', id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Exportar CSV (paginando no banco para não cair no corte de 1000).
app.post('/api/publicos/exportar', requireAuth, requirePublicos, async (req, res) => {
  try {
    const regra = normalizarRegra(req.body && req.body.regra);
    const PAGINA = 1000;
    const rows = [];
    for (let offset = 0; ; offset += PAGINA) {
      const { data, error } = await supabase.rpc('publico_buscar', { regra, _limit: PAGINA, _offset: offset });
      if (error) throw error;
      const pagina = data || [];
      rows.push(...pagina);
      if (pagina.length < PAGINA) break;
    }
    const csv = montarCsv(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="publico.csv"');
    res.send(csv);
  } catch (e) {
    console.error('❌ publicos/exportar:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Disparar: cria a campanha (já com lead_id resolvido) e inicia o runner.
app.post('/api/publicos/disparar', requireAuth, requirePublicos, async (req, res) => {
  try {
    const nome = sanitizeStr(req.body.nome_campanha, 120);
    const template_nome = sanitizeStr(req.body.template_nome, 100);
    if (!nome) return res.status(400).json({ error: 'Nome da campanha obrigatório' });
    if (!template_nome) return res.status(400).json({ error: 'Template obrigatório' });
    if (!(await templateAprovado(template_nome))) return res.status(400).json({ error: 'Template não aprovado pela Meta' });

    // Número: ausente = default (2873); presente precisa ter token.
    const sendable = await whatsapp.getPhoneNumbers();
    let wa_number_id = sanitizeStr(req.body.wa_number_id || '', 50);
    if (!wa_number_id) wa_number_id = whatsapp.defaultPhoneId() || '';
    else if (!sendable[wa_number_id]) return res.status(400).json({ error: 'Número sem credencial de envio configurada' });

    // Uma campanha enviando por vez (mesma guarda do /api/disparos/:id/iniciar).
    const { data: ativa } = await supabase.from('disparos_campanhas').select('id').eq('status', 'enviando').limit(1);
    if (ativa && ativa.length) return res.status(409).json({ error: 'Já existe uma campanha enviando. Aguarde ou pause antes.' });

    // Resolve TODOS os leads do público (paginado no banco).
    const regra = normalizarRegra(req.body && req.body.regra);
    const PAGINA = 1000;
    const leads = [];
    for (let offset = 0; ; offset += PAGINA) {
      const { data, error } = await supabase.rpc('publico_buscar', { regra, _limit: PAGINA, _offset: offset });
      if (error) throw error;
      const pagina = data || [];
      leads.push(...pagina);
      if (pagina.length < PAGINA) break;
    }
    if (!leads.length) return res.status(400).json({ error: 'Público sem contatos' });

    // Cria a campanha (rascunho) com o número escolhido.
    const { data: camp, error: cErr } = await supabase.from('disparos_campanhas').insert({
      nome, template_nome, lang: 'pt_BR', total: leads.length, wa_number_id,
      status: 'rascunho', criado_por: req.user.id,
    }).select().single();
    if (cErr) throw cErr;

    // Contatos já com lead_id (leads existentes — pula matching).
    const contatos = leads.map(l => {
      const primeiro = (l.nome || '').trim().split(/\s+/)[0] || 'tudo bem';
      return { campanha_id: camp.id, lead_id: l.id, nome: l.nome, primeiro_nome: primeiro,
        telefone: l.telefone, variaveis: [primeiro], status: 'pendente' };
    });
    for (let i = 0; i < contatos.length; i += 500) {
      const { error: iErr } = await supabase.from('disparos_contatos').insert(contatos.slice(i, i + 500));
      if (iErr) throw iErr;
    }

    // Marca enviando + inicia o runner (mesmo deps do /iniciar).
    await supabase.from('disparos_campanhas')
      .update({ status: 'enviando', iniciada_em: new Date().toISOString() }).eq('id', camp.id);
    disparoRunner.iniciarRunner(camp.id, { supabase, whatsapp, logEvento });

    res.json({ campanha_id: camp.id, total: leads.length });
  } catch (e) {
    console.error('❌ publicos/disparar:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/disparos/pendentes-aviso', requireAuth, requireDisparos, async (req, res) => {
  try {
    const { data } = await supabase.from('disparos_campanhas')
      .select('id, nome, enviados, total').eq('auto_pausada', true).order('id', { ascending: false });
    res.json({ campanhas: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/disparos/:id/progresso', requireAuth, requireDisparos, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { data: c } = await supabase.from('disparos_campanhas')
      .select('status, total, enviados, falhas').eq('id', id).maybeSingle();
    if (!c) return res.status(404).json({ error: 'Campanha não encontrada' });
    res.json({ ...c, restantes: Math.max(0, c.total - c.enviados - c.falhas) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/disparos/:id', requireAuth, requireDisparos, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { data: camp } = await supabase.from('disparos_campanhas').select('*').eq('id', id).maybeSingle();
    if (!camp) return res.status(404).json({ error: 'Campanha não encontrada' });
    const { data: contatos } = await supabase.from('disparos_contatos')
      .select('nome, telefone, status, erro, enviado_em').eq('campanha_id', id).order('id').limit(2000);
    res.json({ campanha: camp, contatos: contatos || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/disparos', requireAuth, requireDisparos, async (req, res) => {
  try {
    const { data } = await supabase.from('disparos_campanhas')
      .select('*').order('id', { ascending: false }).limit(100);
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Disparos recebidos por um lead (para a aba no perfil).
app.get('/api/leads/:id/disparos', requireAuth, requireConversas, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data: contatos } = await supabase.from('disparos_contatos')
      .select('wa_id, status, enviado_em, campanha:disparos_campanhas(nome, template_nome)')
      .eq('lead_id', id).order('id', { ascending: false }).limit(100);
    const waIds = (contatos || []).map(c => c.wa_id).filter(Boolean);
    let statusPorWa = {};
    if (waIds.length) {
      const { data: msgs } = await supabase.from('mensagens')
        .select('wa_id, wa_status, wa_erro').in('wa_id', waIds);
      for (const m of msgs || []) statusPorWa[m.wa_id] = { wa_status: m.wa_status, wa_erro: m.wa_erro };
    }
    res.json((contatos || []).map(c => ({
      campanha: c.campanha?.nome || '',
      template: c.campanha?.template_nome || '',
      enviado_em: c.enviado_em, status_envio: c.status,
      entrega: statusPorWa[c.wa_id] || null,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
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
app.post('/api/ligacoes/:id/analisar', requireAuth, requireCrcLead, rateLimit, async (req, res) => {
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
// Janela de atendimento da Meta: mensagem LIVRE (texto/mídia) só pode ser enviada
// até 24h após a última mensagem recebida do lead. Fora da janela a API aceita o
// envio e DESCARTA em silêncio (erro 131047 só chega via webhook de status) — por
// isso bloqueamos aqui com aviso claro em vez de deixar a mensagem sumir.
const MSG_JANELA_FECHADA = 'Janela de 24h fechada — o lead precisa responder para receber mensagem livre. Use o botão 📢 Template para reabrir a conversa.';
// A janela é POR PAR (número da clínica ↔ lead): mensagem do lead no 8700 não
// abre janela para o 2873. Como toda conversa livre sai pelo número SDR (2873),
// a checagem considera só mensagens recebidas nele (vazio = legado, conta como SDR).
async function janela24hAberta(leadId) {
  const pid = whatsapp.defaultPhoneId() || '';
  const { data } = await supabase.from('mensagens').select('criada_em, wa_number_id')
    .eq('lead_id', leadId).eq('direcao', 'recebida')
    .order('id', { ascending: false }).limit(10);
  const ult = (data || []).find(m => !m.wa_number_id || m.wa_number_id === pid);
  return !!(ult && Date.now() - new Date(ult.criada_em).getTime() < 24 * 3600 * 1000);
}

// Claim-first: 1ª resposta pelo CRM torna o usuário dono da conversa.
// Só preenche quando vazio (guard .is no update) — nunca sobrescreve.
function assumirConversaSeSemDono(lead, user) {
  if (!lead || lead.crc_agendamento_id || !user?.id) return;
  const nomeCrc = sanitizeStr(user.profile?.nome || '', 100);
  supabase.from('leads')
    .update({ crc_agendamento_id: user.id, crc_agendamento_nome: nomeCrc })
    .eq('id', lead.id).is('crc_agendamento_id', null)
    .then(({ error }) => {
      if (!error) logEvento(lead.id, 'conversa_assumida',
        'Conversa assumida por ' + (nomeCrc || 'CRC'), {}, user.id);
    })
    .catch(() => {});
}

app.post('/api/leads/:id/whatsapp', requireAuth, requireConversas, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data: lead, error } = await supabase.from('leads').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (!lead.telefone) return res.status(400).json({ error: 'Lead sem telefone' });
    if (!whatsapp.temToken()) return res.status(503).json({ error: 'WhatsApp Cloud API não configurada' });
    const { texto, templateName, variaveis, reply_wa_id } = req.body;
    let resultado;
    if (!templateName && !texto) return res.status(400).json({ error: 'texto ou templateName obrigatorio' });
    // Política fixa (decisão do gestor): conversa livre SEMPRE pelo número SDR
    // (2873); template SEMPRE pelo número de disparos (8700). O cliente não escolhe.
    const sdrPhoneId = whatsapp.defaultPhoneId() || '';
    if (templateName) {
      resultado = await whatsapp.enviarTemplate({ para: lead.telefone, templateName, variaveis });
    } else {
      if (!(await janela24hAberta(lead.id))) return res.status(400).json({ error: MSG_JANELA_FECHADA });
      const contextWaId = reply_wa_id ? sanitizeStr(reply_wa_id, 500) : null;
      resultado = await whatsapp.enviarTexto({ para: lead.telefone, texto, phoneNumberId: sdrPhoneId, contextWaId });
    }
    const sentPhoneId = templateName ? (whatsapp.broadcastPhoneId() || '') : sdrPhoneId;
    const { error: insErr } = await supabase.from('mensagens').insert({
      lead_id: lead.id, direcao: 'enviada', canal: 'sdr',
      texto: sanitizeStr(texto || '[template:' + sanitizeStr(templateName, 100) + ']', 4000),
      wa_id: resultado.messages?.[0]?.id || '',
      wa_number_id: sentPhoneId,
    });
    if (insErr) console.error('❌ wa send (registro da mensagem):', insErr.message);
    await supabase.from('leads').update({ ultimo_contato: new Date().toISOString() }).eq('id', lead.id);
    res.json({ ok: true });
    assumirConversaSeSemDono(lead, req.user);
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

app.post('/api/leads/:id/whatsapp/midia', requireAuth, requireConversas, rateLimit, _upload.single('arquivo'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data: lead } = await supabase.from('leads').select('id,telefone,wa_number_id,crc_agendamento_id').eq('id', id).maybeSingle();
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (!lead.telefone) return res.status(400).json({ error: 'Lead sem telefone' });
    if (!whatsapp.temToken()) return res.status(503).json({ error: 'WhatsApp Cloud API não configurada' });
    if (!req.file) return res.status(400).json({ error: 'Arquivo obrigatório' });
    if (!(await janela24hAberta(lead.id))) return res.status(400).json({ error: MSG_JANELA_FECHADA });
    let { buffer, mimetype, originalname } = req.file;
    let tipo = 'document';
    if (mimetype.startsWith('image/')) tipo = 'image';
    else if (mimetype.startsWith('audio/')) tipo = 'audio';
    else if (mimetype.startsWith('video/')) tipo = 'video';
    // WhatsApp só toca como áudio de voz NATIVO se for OGG/Opus. Chrome grava webm,
    // iPhone/Safari grava mp4(AAC) e uploads vêm como mp3/m4a — qualquer um desses,
    // enviado cru, faz o destinatário ver "Este áudio não está mais disponível" e o
    // player aparecer como não-nativo. Por isso convertemos TODO áudio não-ogg.
    if (tipo === 'audio' && !mimetype.startsWith('audio/ogg')) {
      buffer = await _audioParaOggOpus(buffer);
      mimetype = 'audio/ogg';
      originalname = originalname.replace(/\.[a-z0-9]+$/i, '') + '.ogg';
    }
    const caption = sanitizeStr(req.body.caption || '', 500);
    // Mídia livre segue a mesma política do texto: sempre pelo número SDR (2873)
    const mediaPid = whatsapp.defaultPhoneId() || undefined;
    // upload e envio usam o MESMO phoneNumberId (media_id é vinculado ao número que fez o upload)
    const mediaId = await whatsapp.uploadMidia({ buffer, mimetype, filename: originalname, phoneNumberId: mediaPid });
    const resultado = await whatsapp.enviarMidia({ para: lead.telefone, mediaId, tipo, caption, phoneNumberId: mediaPid });
    const { error: insErr } = await supabase.from('mensagens').insert({
      lead_id: lead.id, direcao: 'enviada', canal: 'sdr',
      texto: caption || `[${tipo}: ${sanitizeStr(originalname, 60)}]`, wa_id: resultado.messages?.[0]?.id || '',
      tipo, media_id: mediaId, mime: sanitizeStr(mimetype, 120),
      media_filename: tipo === 'document' ? sanitizeStr(originalname, 200) : null,
      wa_number_id: mediaPid || '',
    });
    if (insErr) console.error('❌ wa midia (registro da mensagem):', insErr.message);
    await supabase.from('leads').update({ ultimo_contato: new Date().toISOString() }).eq('id', lead.id);
    res.json({ ok: true });
    assumirConversaSeSemDono(lead, req.user);
    logEvento(id, 'mensagem_enviada', 'Mídia enviada: ' + (req.file?.originalname || 'arquivo'),
      { tipo: req.file?.mimetype || '' }, req.user?.id || null);
  } catch (e) {
    console.error('❌ wa midia:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/leads/:id/mensagens', requireAuth, requireConversas, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID invalido' });
    // Modo incremental (?after=N): evita rebaixar a thread inteira a cada poll.
    // Retorna só as mensagens novas (id>N) + um resumo de status das 25 mais
    // recentes (p/ refletir ✓✓ de entrega, fixar/desafixar e apagar, que mudam
    // em mensagens já existentes). Corta drasticamente o egress de aba aberta.
    const after = parseInt(req.query.after, 10);
    if (!Number.isNaN(after) && after > 0) {
      const [novasR, recentesR] = await Promise.all([
        supabase.from('mensagens').select('*').eq('lead_id', id).gt('id', after).order('id', { ascending: true }),
        supabase.from('mensagens').select('id, wa_status, wa_erro, fixada, editada_em, texto')
          .eq('lead_id', id).order('id', { ascending: false }).limit(25),
      ]);
      if (novasR.error) throw novasR.error;
      return res.json({ incremental: true, novas: novasR.data || [], recentes: recentesR.data || [] });
    }
    // criada_em primeiro: ecos backfillados têm id novo mas data antiga
    const { data, error } = await supabase.from('mensagens').select('*').eq('lead_id', id)
      .order('criada_em', { ascending: true }).order('id', { ascending: true });
    if (error) throw error;
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

app.get('/api/leads/:id/midia/:msgId', requireAuth, requireConversas, rateLimit, async (req, res) => {
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

app.patch('/api/leads/:id/fixar-conversa', requireAuth, requireConversas, rateLimit, async (req, res) => {
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

app.patch('/api/leads/:id/mensagens/:msgId/fixar', requireAuth, requireConversas, rateLimit, async (req, res) => {
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

// Rota de editar mensagem removida: a Cloud API da Meta não suporta edição —
// o frontend já havia sido removido (a425ecd) e manter só o registro local
// faria o CRM divergir do que o lead realmente recebeu.

app.delete('/api/leads/:id/mensagens/:msgId', requireAuth, requireConversas, rateLimit, async (req, res) => {
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

app.post('/api/leads/:id/agendar-mensagem', requireAuth, requireConversas, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
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

app.get('/api/leads/:id/agendamentos', requireAuth, requireConversas, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data, error } = await supabase.from('mensagens_agendadas')
      .select('*').eq('lead_id', id).order('agendado_para');
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/agendamentos/:id', requireAuth, requireConversas, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { error } = await supabase.from('mensagens_agendadas').delete().eq('id', id).is('enviada_em', null);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cron: dispara mensagens agendadas a cada 60s.
// Egress: seleciona só as colunas usadas no envio (antes era select('*') +
// join leads(wa_number_id) que nem era lido). leads!inner(id) mantém o filtro
// de "lead existe" sem trazer dados do lead.
setInterval(async () => {
  try {
    const { data } = await supabase.from('mensagens_agendadas')
      .select('id, lead_id, telefone, texto, agendado_para, leads!inner(id)')
      .is('enviada_em', null).is('erro', null)
      .lte('agendado_para', new Date().toISOString()).limit(10);
    if (!data?.length) return;
    for (const ag of data) {
      try {
        // Janela de 24h: fora dela a Meta descartaria a mensagem em silêncio
        if (!(await janela24hAberta(ag.lead_id))) {
          await supabase.from('mensagens_agendadas')
            .update({ erro: 'Janela de 24h fechada no horário do envio — mensagem não enviada' }).eq('id', ag.id);
          logEvento(ag.lead_id, 'mensagem_agendada_falhou',
            'Mensagem agendada NÃO enviada: janela de 24h fechada (lead não respondeu desde o agendamento)',
            { agendamento_id: ag.id });
          continue;
        }
        // Claim ANTES de enviar: se enviasse primeiro e o update falhasse, o lead
        // receberia a mesma mensagem a cada 30s. Update condicional também evita
        // envio duplo se houver mais de uma instância do servidor.
        const { data: claimed, error: claimErr } = await supabase.from('mensagens_agendadas')
          .update({ enviada_em: new Date().toISOString() })
          .eq('id', ag.id).is('enviada_em', null).select('id');
        if (claimErr || !claimed?.length) continue;
        // Mesma política do chat: mensagem livre sempre pelo número SDR (2873)
        const phoneNumberId = whatsapp.defaultPhoneId() || undefined;
        const resultado = await whatsapp.enviarTexto({ para: ag.telefone, texto: ag.texto, phoneNumberId });
        const { error: insErr } = await supabase.from('mensagens').insert({
          lead_id: ag.lead_id, direcao: 'enviada', canal: 'agendada', texto: ag.texto,
          wa_id: resultado.messages?.[0]?.id || '',
          wa_number_id: phoneNumberId || '',
        });
        if (insErr) console.error('❌ Agendamento #' + ag.id + ' (registro):', insErr.message);
        console.log('📅 Mensagem agendada enviada → lead #' + ag.lead_id);
      } catch (e) {
        console.error('❌ Agendamento #' + ag.id + ':', e.message);
        // Falhou após o claim: não reenvia (evita spam); registra no trajeto do lead
        supabase.from('mensagens_agendadas').update({ erro: sanitizeStr(e.message, 300) }).eq('id', ag.id)
          .then(() => {}, () => {});
        logEvento(ag.lead_id, 'mensagem_agendada_falhou',
          'Mensagem agendada NÃO foi enviada: ' + sanitizeStr(e.message, 200), { agendamento_id: ag.id });
      }
    }
  } catch (_) {}
}, 60000);

app.get('/api/conversas', requireAuth, requireConversas, rateLimit, async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('conversas_com_preview',
      { sdr_phone: whatsapp.defaultPhoneId() || null });
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
    const campanhaId = parseInt(req.query.campanha_id, 10);
    if (!Number.isNaN(campanhaId)) {
      const leadIds = await coletarLeadIds(async (offset, limit) => {
        const { data } = await supabase.from('disparos_contatos')
          .select('lead_id').eq('campanha_id', campanhaId).eq('status', 'enviado')
          .not('lead_id', 'is', null).range(offset, offset + limit - 1);
        return data || [];
      });
      rows = rows.filter(r => leadIds.has(r.id));
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/leads/:id/broadcast', requireAuth, requireConversas, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data: lead, error } = await supabase.from('leads').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (!lead.telefone) return res.status(400).json({ error: 'Lead sem telefone' });
    if (!whatsapp.temBroadcast()) return res.status(503).json({ error: 'Número de broadcast não configurado.' });
    const { templateName, variaveis = [], lang = 'pt_BR' } = req.body;
    if (!templateName) return res.status(400).json({ error: 'templateName obrigatório' });
    const resultado = await whatsapp.enviarBroadcast({ para: lead.telefone, templateName, variaveis, lang });
    const vars = variaveis.length ? ' | ' + variaveis.slice(0, 10).map(v => sanitizeStr(String(v), 100)).join(', ') : '';
    const { error: insErr } = await supabase.from('mensagens').insert({
      lead_id: lead.id, direcao: 'enviada', canal: 'broadcast',
      texto: sanitizeStr('[template: ' + sanitizeStr(templateName, 100) + vars + ']', 4000),
      wa_id: resultado.messages?.[0]?.id || '',
      wa_number_id: whatsapp.broadcastPhoneId() || '',
    });
    if (insErr) console.error('❌ broadcast (registro da mensagem):', insErr.message);
    await supabase.from('leads').update({ ultimo_contato: new Date().toISOString() }).eq('id', lead.id);
    res.json({ ok: true });
    assumirConversaSeSemDono(lead, req.user);
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
    let wabaId = process.env.WA_BUSINESS_ACCOUNT_ID || WA_BUSINESS_ACCOUNT_ID || '';
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
        status: 'Novo', valor: null, tipo_trat: '',
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

// ===== DIAGNÓSTICO TEMPORÁRIO (jun/2026): assinaturas de webhook do WhatsApp =====
// READ-ONLY. Descobre app_id + WABA id (via debug_token), lista os campos de webhook
// que o app assina e os apps inscritos na WABA — para saber por que as mensagens da
// IA não chegam (provável falta de 'message_echoes'/'smb_message_echoes' + Coexistência).
// Não retorna o token. Remover junto com o resto do diagnóstico da IA.
app.get('/api/admin/wa-webhook-diag', requireAuth, requireAdmin, async (req, res) => {
  const V = 'v21.0';
  const TOKEN = process.env.WHATSAPP_API_TOKEN || process.env.WHATSAPP_CLOUD_TOKEN || '';
  const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  const APP_SECRET = process.env.META_APP_SECRET || '';
  if (!TOKEN || !PHONE_ID) return res.status(503).json({ error: 'WhatsApp não configurado' });
  const out = {};
  const g = async (label, url) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      out[label] = await r.json().catch(() => ({ _parseError: true }));
    } catch (e) { out[label] = { _error: e.message }; }
  };
  // 1) debug_token (auto): revela app_id, scopes e WABA (granular_scopes.target_ids)
  await g('debug_token', `https://graph.facebook.com/${V}/debug_token?input_token=${encodeURIComponent(TOKEN)}&access_token=${encodeURIComponent(TOKEN)}`);
  // 2) info do número (platform_type indica Cloud API / coexistência)
  await g('phone', `https://graph.facebook.com/${V}/${PHONE_ID}?fields=id,display_phone_number,verified_name,platform_type,quality_rating,name_status,code_verification_status&access_token=${encodeURIComponent(TOKEN)}`);
  const dt = out.debug_token?.data || {};
  const appId = dt.app_id || '';
  let wabaId = '';
  for (const s of (Array.isArray(dt.granular_scopes) ? dt.granular_scopes : [])) {
    if (/whatsapp_business/.test(s.scope || '') && Array.isArray(s.target_ids) && s.target_ids.length) { wabaId = s.target_ids[0]; break; }
  }
  out._derivado = { appId, wabaId, scopes: dt.scopes || [] };
  // 3) campos de webhook assinados pelo APP (precisa app access token)
  if (appId && APP_SECRET) {
    await g('app_subscriptions', `https://graph.facebook.com/${V}/${appId}/subscriptions?access_token=${encodeURIComponent(appId + '|' + APP_SECRET)}`);
  } else out.app_subscriptions = { _skip: 'sem app_id ou app_secret' };
  // 4) apps inscritos na WABA (+ override callback)
  if (wabaId) {
    await g('waba_subscribed_apps', `https://graph.facebook.com/${V}/${wabaId}/subscribed_apps?access_token=${encodeURIComponent(TOKEN)}`);
  } else out.waba_subscribed_apps = { _skip: 'WABA id não derivado' };
  res.json(out);
});

// ===== DIAGNÓSTICO TEMPORÁRIO (jun/2026): assinar campos de eco do webhook =====
// Faz o app passar a receber as mensagens enviadas pelo agente/IA (ecos). A chamada
// SUBSTITUI a lista de campos — por isso sempre inclui 'messages' junto, senão
// pararíamos de receber as mensagens dos clientes. Re-supre o callback/verify_token
// atuais (já verificados) para não derrubar o webhook. Remover após estabilizar.
app.post('/api/admin/wa-webhook-subscribe', requireAuth, requireAdmin, async (req, res) => {
  const V = 'v21.0';
  const TOKEN = process.env.WHATSAPP_API_TOKEN || process.env.WHATSAPP_CLOUD_TOKEN || '';
  const APP_SECRET = process.env.META_APP_SECRET || '';
  const VERIFY = process.env.WHATSAPP_VERIFY_TOKEN || '';
  const CALLBACK = 'https://plataformaama-plataforma.uc5as5.easypanel.host/webhooks/whatsapp';
  const fields = String(req.query.fields || 'messages,message_echoes,smb_message_echoes');
  if (!TOKEN || !APP_SECRET) return res.status(503).json({ error: 'WhatsApp/app não configurado' });
  if (!/(^|,)messages(,|$)/.test(fields)) return res.status(400).json({ error: 'fields DEVE incluir messages' });
  const j = async (url, opts) => {
    try { const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(10_000) }); return await r.json().catch(() => ({ _parseError: true })); }
    catch (e) { return { _error: e.message }; }
  };
  const dbg = await j(`https://graph.facebook.com/${V}/debug_token?input_token=${encodeURIComponent(TOKEN)}&access_token=${encodeURIComponent(TOKEN)}`);
  const appId = dbg?.data?.app_id;
  if (!appId) return res.status(500).json({ error: 'não derivou app_id', dbg });
  const appToken = appId + '|' + APP_SECRET;
  const body = new URLSearchParams({ object: 'whatsapp_business_account', callback_url: CALLBACK, verify_token: VERIFY, fields, access_token: appToken });
  const subscribe = await j(`https://graph.facebook.com/${V}/${appId}/subscriptions`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const after = await j(`https://graph.facebook.com/${V}/${appId}/subscriptions?access_token=${encodeURIComponent(appToken)}`);
  const fieldsAtuais = (after?.data?.[0]?.fields || []).map(f => (f && typeof f === 'object' && f.name) ? f.name : f);
  res.json({ pediu: fields, subscribe, fieldsAtuais });
});

// Match de lead por telefone: exato → sufixo 8 dígitos + chaveTelefone (base
// legada sem DDI/9º dígito; preserva a separação intencional de familiares).
async function acharLeadPorTelefone(fone) {
  const { data: rows } = await supabase.from('leads').select('*')
    .eq('telefone', fone).order('id').limit(1);
  let lead = rows?.[0] || null;
  if (!lead) {
    const suf = String(fone).slice(-8);
    const alvo = chaveTelefone(fone);
    if (suf.length === 8 && alvo) {
      const { data: cands } = await supabase.from('leads').select('*')
        .like('telefone', '%' + suf).order('id').limit(20);
      lead = (cands || []).find(c => chaveTelefone(c.telefone) === alvo) || null;
    }
  }
  return lead;
}

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
    // Status de entrega (sent/delivered/read/failed) — "failed" é como descobrimos
    // que a Meta DESCARTOU uma mensagem aceita pela API (ex.: janela de 24h fechada)
    const statuses = whatsapp.parseStatuses(req.body);
    for (const st of statuses) {
      const upd = { wa_status: st.status };
      if (st.status === 'failed') upd.wa_erro = sanitizeStr(st.erro || 'falha não especificada', 300);
      // só "promove" o status (sent → delivered → read); failed sobrescreve qualquer um
      const podeSobrescrever = { sent: [], delivered: ['sent'], read: ['sent', 'delivered'], failed: ['sent', 'delivered', 'read'] }[st.status] || [];
      let q = supabase.from('mensagens').update(upd).eq('wa_id', st.wa_id);
      q = podeSobrescrever.length
        ? q.or('wa_status.is.null,wa_status.in.(' + podeSobrescrever.join(',') + ')')
        : q.is('wa_status', null);
      const { data: updRows, error: stErr } = await q.select('id, lead_id');
      if (stErr) console.error('❌ webhook wa status:', stErr.message);
      if (st.status === 'failed' && updRows?.length) {
        console.warn('⚠️  WA mensagem NÃO entregue (wa_id ' + st.wa_id.slice(-12) + '): ' + (st.erro || 'sem detalhe'));
        logEvento(updRows[0].lead_id, 'mensagem_falhou',
          'Mensagem NÃO entregue pelo WhatsApp: ' + sanitizeStr(st.erro || 'falha não especificada', 200),
          { wa_id: st.wa_id, erro: st.erro || '' });
      }
    }
    // DIAGNÓSTICO TEMPORÁRIO (jun/2026): registra eventos de webhook que NÃO são
    // mensagem recebida nem status — é onde caem os ecos do agente/app da Meta
    // (smb_message_echoes / message_echoes / Business Agent). Objetivo: descobrir se
    // as mensagens da IA já chegam no webhook. Fire-and-forget p/ não atrasar o 200.
    try {
      const evts = whatsapp.coletarEventosDebug(req.body);
      if (evts.length) {
        supabase.from('webhook_wa_debug').insert(
          evts.map(e => ({ field: e.field, value_keys: e.value_keys, phone_number_id: e.phone_number_id, payload: e.payload }))
        ).then(({ error }) => { if (error) console.error('webhook_wa_debug:', error.message); });
      }
    } catch (e) { console.error('webhook debug log:', e.message); }
    // Ecos do app/IA da Meta → entram na thread como enviada canal='app'.
    // Dedup por wa_id (protege contra reentrega e eco de msg enviada via API).
    try {
      for (const eco of parseEchoes(req.body)) {
        try {
          const { data: dup } = await supabase.from('mensagens')
            .select('id').eq('wa_id', eco.wamid).limit(1);
          if (dup?.length) continue;
          const leadEco = await acharLeadPorTelefone(eco.to);
          if (!leadEco) { console.log('[eco-app] sem lead p/ …' + eco.to.slice(-8)); continue; }
          const { error: ecoErr } = await supabase.from('mensagens').insert({
            lead_id: leadEco.id, direcao: 'enviada', canal: 'app',
            texto: sanitizeStr(eco.texto, 4000), wa_id: eco.wamid,
            tipo: eco.tipo,
            wa_number_id: sanitizeStr(eco.phone_number_id || '', 50),
            ...(eco.timestamp ? { criada_em: eco.timestamp } : {}),
          });
          if (ecoErr) console.error('❌ eco-app insert:', ecoErr.message);
        } catch (e) { console.error('❌ eco-app item:', e.message); }
      }
    } catch (e) { console.error('❌ eco-app:', e.message); }
    const m = whatsapp.parseMensagemRecebida(req.body);
    if (!m) return res.status(200).send('ok');
    let lead = await acharLeadPorTelefone(m.from);
    if (!lead) {
      const { data: inserted, error: insertErr } = await supabase.from('leads').insert({
        nome: sanitizeStr(m.nome || 'Lead WhatsApp'),
        telefone: sanitizeStr(m.from, 30), email: '',
        origem: m.ctwa_clid ? _origemCTWA(m.referral_data) : 'WhatsApp Direto',
        campanha: sanitizeStr(m.ad_id || '', 200), conteudo: '', fbclid: '', gclid: '',
        ctwa_clid: sanitizeStr(m.ctwa_clid || '', 500),
        referral_data: m.referral_data || {},
        wa_number_id: sanitizeStr(m.phone_number_id || '', 50),
        status: 'Novo', valor: null, tipo_trat: '',
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
      const { error: insErr } = await supabase.from('mensagens').insert({
        lead_id: lead.id, direcao: 'recebida', canal: 'sdr',
        texto: sanitizeStr(m.texto, 4000), wa_id: m.id || '',
        tipo: m.tipo || 'text',
        media_id: m.media_id || null,
        mime: m.mime ? sanitizeStr(m.mime, 120) : null,
        media_filename: m.media_filename ? sanitizeStr(m.media_filename, 200) : null,
        wa_number_id: sanitizeStr(m.phone_number_id || '', 50),
      });
      if (insErr) console.error('❌ webhook wa (registro da mensagem recebida):', insErr.message);
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

// ========== MONITOR DIÁRIO DAS CRCS ==========
// IO compartilhado entre o endpoint e o push diário. `data` = YYYY-MM-DD (BRT).
async function montarMonitorCrcDoDia(data) {
  const from = data + 'T00:00:00-03:00';
  const to = data + 'T23:59:59.999-03:00';
  // respostas até 72h após o dia fecham esperas iniciadas no dia (consulta retroativa)
  const fimRespostas = new Date(new Date(to).getTime() + 72 * 3600 * 1000).toISOString();
  const [evRes, recRes, ligRes, abertasRes] = await Promise.all([
    supabase.from('lead_eventos')
      .select('lead_id, tipo, metadata, usuario_id, criado_em')
      .in('tipo', ['mensagem_enviada', 'template_enviado', 'status_mudou', 'nota_sdr_editada'])
      .gte('criado_em', from).lte('criado_em', fimRespostas).limit(20000),
    supabase.from('mensagens').select('lead_id, criada_em')
      .eq('direcao', 'recebida').gte('criada_em', from).lte('criada_em', to).limit(20000),
    supabase.from('ligacoes').select('usuario_id, duracao_segundos')
      .eq('modulo', 'leads').gte('criada_em', from).lte('criada_em', to).limit(5000),
    supabase.rpc('esperas_abertas', { fim: to }),
  ]);
  for (const r of [evRes, recRes, ligRes, abertasRes]) if (r.error) throw r.error;
  const periodo = { from, to };
  const monitor = montarMonitorCrc({
    periodo,
    eventos: evRes.data || [],
    recebidas: recRes.data || [],
    ligacoes: ligRes.data || [],
    esperasAbertas: abertasRes.data || [],
  });
  // nomes das CRCs
  const ids = monitor.porCrc.map(c => c.usuario_id);
  let nomes = {};
  if (ids.length) {
    const { data: perfis } = await supabase.from('profiles').select('id, nome').in('id', ids);
    for (const p of perfis || []) nomes[p.id] = p.nome || '';
  }
  return { monitor, nomes };
}

app.get('/api/monitor-crc', requireAuth, rateLimit, async (req, res) => {
  try {
    const p = await loadProfile(req);
    const roles = p.roles || [];
    const gestor = roles.includes('admin') || roles.includes('gestor');
    if (!gestor && !roles.includes('crc_leads')) return res.status(403).json({ error: 'Acesso negado' });
    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const data = String(req.query.data || hoje);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ error: 'Data inválida (YYYY-MM-DD)' });
    if (data > hoje) return res.status(400).json({ error: 'Data futura' });
    const { monitor, nomes } = await montarMonitorCrcDoDia(data);
    if (!gestor) {
      // CRC vê só os próprios números — filtro NO SERVIDOR
      const meu = monitor.porCrc.find(c => c.usuario_id === req.user.id) || null;
      return res.json({ escopo: 'proprio', data, porCrc: meu ? [meu] : [], nomes: { [req.user.id]: nomes[req.user.id] || p.nome || '' } });
    }
    res.json({ escopo: 'time', data, ...monitor, nomes });
  } catch (e) {
    console.error('❌ monitor-crc:', e);
    res.status(500).json({ error: e.message });
  }
});

async function enviarResumoCrcDiario(force) {
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  if (!force) {
    const { data: claimed, error } = await supabase.from('app_config')
      .update({ resumo_crc_ultimo_envio: hoje }).eq('id', 1)
      .or('resumo_crc_ultimo_envio.is.null,resumo_crc_ultimo_envio.neq.' + hoje)
      .select('id');
    if (error || !claimed || !claimed.length) return false;
  } else {
    await supabase.from('app_config').update({ resumo_crc_ultimo_envio: hoje }).eq('id', 1);
  }
  const { monitor, nomes } = await montarMonitorCrcDoDia(hoje);
  const dataBR = hoje.split('-').reverse().slice(0, 2).join('/');
  const texto = resumoCrcTexto(monitor, nomes, dataBR);
  const { data: gestores } = await supabase.from('profiles').select('id')
    .or('roles.cs.{admin},roles.cs.{gestor}');
  for (const g of gestores || []) {
    await criarNotificacao(g.id, 'resumo_crc', 'Resumo diario das CRCs', texto, { url: '/monitor-crc/' });
  }
  console.log('Resumo CRC enviado (' + (gestores && gestores.length || 0) + ' gestores): ' + texto.slice(0, 120));
  return true;
}

setInterval(function() {
  const hhmm = new Date().toLocaleTimeString('sv-SE', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  if (hhmm >= '18:30') enviarResumoCrcDiario(false).catch(function(e) { console.error('[resumo-crc]', e.message); });
}, 60000);

// Varredura de fim de dia: notifica CRCs configuradas (app_config.varredura_aguardando
// = [{usuario_id, hora}]) sobre conversas aguardando resposta (spec 2026-07-03).
function _fmtEsperaMin(min) {
  return min >= 60 ? Math.floor(min / 60) + 'h' + String(min % 60).padStart(2, '0') : min + 'min';
}

async function enviarVarreduraAguardando() {
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const hhmm = new Date().toLocaleTimeString('sv-SE', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  const { data: cfg, error: cfgError } = await supabase.from('app_config')
    .select('varredura_aguardando, varredura_aguardando_envios').eq('id', 1).maybeSingle();
  if (cfgError) console.error('[varredura-aguardando] config:', cfgError.message);
  const lista = Array.isArray(cfg?.varredura_aguardando) ? cfg.varredura_aguardando : [];
  if (!lista.length) return;
  const envios = cfg?.varredura_aguardando_envios || {};
  let mudou = false;
  for (const item of lista) {
    if (!item?.usuario_id || !item?.hora) continue;
    if (hhmm < item.hora || envios[item.usuario_id] === hoje) continue;
    const { data: rows, error } = await supabase.rpc('conversas_aguardando', { minutos: 30 });
    if (error) { console.error('[varredura-aguardando] rpc:', error.message); continue; }
    envios[item.usuario_id] = hoje; mudou = true;
    if (!rows?.length) continue;
    const top = rows.slice(0, 5)
      .map(r => (r.nome || r.telefone || '?') + ' (' + _fmtEsperaMin(r.espera_min) + ')').join(', ');
    const corpo = rows.length + ' conversa' + (rows.length > 1 ? 's' : '') +
      ' aguardando resposta. Mais antigas: ' + top +
      (rows.length > 5 ? ' e mais ' + (rows.length - 5) + '…' : '');
    await criarNotificacao(item.usuario_id, 'aguardando_resposta',
      '⏰ Conversas aguardando resposta', corpo,
      { url: '/?page=conv-agendamentos&filtro=aguardando' });
    console.log('[varredura-aguardando] ' + item.usuario_id.slice(0, 8) + ': ' + rows.length + ' conversas');
  }
  if (mudou) await supabase.from('app_config')
    .update({ varredura_aguardando_envios: envios }).eq('id', 1);
}

setInterval(function() {
  enviarVarreduraAguardando().catch(function(e) { console.error('[varredura-aguardando]', e.message); });
}, 60000);

app.post('/api/internal/cron/resumo-crc', requireCronSecret, async (req, res) => {
  try {
    const ok = await enviarResumoCrcDiario(req.query.force === '1');
    res.json({ ok: true, enviado: ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  'Novo':               'LeadSubmitted',   // era 'Lead'
  'Em qualificação':    'LeadQualified',   // era 'Em conversa - Lead Qualificado'
  'Avaliação agendada': 'Schedule',        // era 'Agendado'
  'Compareceu':         'Contact',
  'Em negociação':      null,              // era 'Orçado'/'D0-D5'
  'Fechou':             'Purchase',
  'Perdido':            null,
};

const FUNIL_ORDEM = ['LeadSubmitted', 'LeadQualified', 'Schedule', 'Contact', 'Purchase'];

// Orquestrador com CASCATA de funil: ao atingir um estágio fundo, garante também os
// eventos anteriores (LeadQualified..alvo) que ainda não foram enviados — porque um
// estágio fundo implica os rasos (ex.: agendou ⇒ qualificou). Evita Schedule sem
// LeadQualified. LeadSubmitted (entrada, business_messaging) NÃO é re-enviado
// retroativamente — só dispara quando ELE é o alvo.
async function dispararConversaoMeta(lead, eventoCustom = null) {
  if (lead.importado_historico) { console.log('⏭️  Lead importado #' + lead.id + ' não dispara CAPI'); return; }
  const alvo = eventoCustom || EVENTOS_FUNIL[lead.status];
  if (!alvo) { console.log('⏭️  Lead #' + lead.id + ' status "' + lead.status + '" não dispara CAPI'); return; }
  const idx = FUNIL_ORDEM.indexOf(alvo);
  const jaEnviados = new Set(lead.eventos_meta_enviados || []);
  let aEnviar;
  if (idx < 0) aEnviar = jaEnviados.has(alvo) ? [] : [alvo];                          // evento fora do funil
  else if (idx === 0) aEnviar = jaEnviados.has('LeadSubmitted') ? [] : ['LeadSubmitted'];
  else aEnviar = FUNIL_ORDEM.slice(1, idx + 1).filter(e => !jaEnviados.has(e));        // LeadQualified..alvo
  for (const ev of aEnviar) await _enviarEventoMetaUnico(lead, ev);
}

async function _enviarEventoMetaUnico(lead, eventName) {
  let PIXEL = process.env.META_PIXEL_ID;
  const TOKEN = process.env.META_ACCESS_TOKEN;
  if (!PIXEL || !TOKEN) { console.log('⚠️  Meta CAPI não configurada'); return; }
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
    const pageId = (await resolveAdPageId(adId).catch(() => null)) || pageIdFallback(lead);
    if (pageId) {
      user_data.page_id = pageId;
      // Roteamento de dataset por Página: o Events Manager só permite 1 Página
      // vinculada por dataset ("Dados vinculados"), então cada Página tem seu
      // próprio dataset. Mapa default abaixo + override opcional por env
      // META_PIXEL_BY_PAGE (JSON page_id->pixel_id). Sem match, mantém
      // META_PIXEL_ID (= Página 106 "Dr. Marcos Vinicius - AMA").
      const DEFAULT_PIXEL_BY_PAGE = {
        '1204513262736152': '981176104681444', // Clínica AMA → dataset "Pixel WhatsApp CAPI - Clínica AMA"
      };
      let pixelByPage = DEFAULT_PIXEL_BY_PAGE;
      try {
        pixelByPage = { ...DEFAULT_PIXEL_BY_PAGE, ...JSON.parse(process.env.META_PIXEL_BY_PAGE || '{}') };
      } catch (e) { console.error('META_PIXEL_BY_PAGE inválido:', e.message); }
      if (pixelByPage[pageId]) PIXEL = pixelByPage[pageId];
    }
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
      lead.eventos_meta_enviados = eventos; // mantém em memória p/ a cascata não sobrescrever
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

async function processarInadimplentes(items, today) {
  const pacientes = _inad.agregarPorPaciente(items, today);
  const ids = pacientes.map(p => String(p.id));

  // entregue por paciente (soma da produção realizada) + consultas futuras — agregado
  // no SQL via RPC (evita somar no JS / limite 1000 do client e reduz egress).
  const entregueMap = new Map();
  const veioRecenteSet = new Set();
  const consultaFuturaSet = new Set();
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const { data: ent, error: e1 } = await supabase.rpc('inad_entregue_por_paciente', { p_ids: chunk, p_hoje: today });
    if (e1) console.error('[inad] entregue rpc:', e1.message);
    else for (const r of (ent || [])) {
      const id = String(r.paciente_clinicorp_id || '');
      if (!id) continue;
      entregueMap.set(id, Number(r.total_entregue) || 0);
      if (r.veio_recente) veioRecenteSet.add(id);
    }
    const { data: cf, error: e2 } = await supabase.rpc('inad_consulta_futura_ids', { p_ids: chunk, p_hoje: today });
    if (e2) console.error('[inad] consulta rpc:', e2.message);
    else for (const r of (cf || [])) { const id = String(r.paciente_clinicorp_id || ''); if (id) consultaFuturaSet.add(id); }
  }

  return _inad.classificarESepararGrupos(pacientes, { entregueMap, consultaFuturaSet, veioRecenteSet });
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
    const processado = await processarInadimplentes(allItems, today);
    processado.resultado = {
      recuperacao: _recuperacao.recuperacaoPorMes(allItems, today, 12),
      vencido:     _recuperacao.vencidoRetroativo(allItems, today, 24),
      aging:       _analiseParcelas.agingVencido(allItems, today),
    };
    await supabase.from('inadimplentes_cache').upsert({
      id: 1, data: processado, atualizado_em: Date.now(),
      endpoint: '/payment/list?postDate (24mo chunks)',
    });
    console.log(`[Inadimplentes] ✅ Background: ${processado.totais.pacientes} inadimplentes de ${allItems.length} registros`);
    // Resumo financeiro POR PACIENTE (pago/vencido/futuro) — reusa os mesmos itens do /payment/list.
    try { await atualizarPacientesFinanceiro(allItems, today); }
    catch(e){ console.error('[pacientes_financeiro] erro:', e.message); }
    // Recebíveis por mês de vencimento (24m) p/ a página A Receber / A Pagar — mesmos itens.
    try { await atualizarRecebiveisMensais(allItems, today); }
    catch(e){ console.error('[recebiveis_mensal] erro:', e.message); }
    // Análises da carteira (aging, taxa de perda, renovação, top, retroativo) + snapshot do dia.
    try { await atualizarAnalisesSaude(allItems, today); }
    catch(e){ console.error('[saude_analises] erro:', e.message); }
    try { await gravarSnapshotSaude(today); }
    catch(e){ console.error('[saude_snapshot] erro:', e.message); }
  } catch(e) {
    console.error('[Inadimplentes] Background refresh erro:', e.message);
  } finally {
    _inadimplentesRefreshing = false;
  }
}

// Agrega o /payment/list por paciente: total pago (recebido), vencido, futuro e último pgto.
// Corrige o financeiro do Perfil 360º (o list_summary não atribui boletos ao paciente).
async function atualizarPacientesFinanceiro(items, today) {
  const m = {};
  for (const i of (items || [])) {
    const id = String(i.PatientId || i.patientId || i.Patient_PersonId || '').trim();
    if (!id) continue;
    const recebido = i.PaymentReceived === 'X' || (i.ReceivedDate && i.ReceivedDate !== '' && i.ReceivedDate !== '0001-01-01');
    const due = i.DueDate || i.due_date || i.PostDate || i.ScheduledDate || '';
    const valor = Number(i.AmountWithDiscounts || i.Amount || i.TotalPostAmount || 0) || 0;
    if (!m[id]) m[id] = { clinicorp_id: id, total_pago: 0, total_vencido: 0, total_futuro: 0, ultimo_pgto: null };
    const p = m[id];
    if (recebido) {
      p.total_pago += valor;
      const rd = (i.ReceivedDate && i.ReceivedDate !== '0001-01-01') ? i.ReceivedDate.slice(0,10) : null;
      if (rd && (!p.ultimo_pgto || rd > p.ultimo_pgto)) p.ultimo_pgto = rd;
    } else if (due && due < today) p.total_vencido += valor;
    else if (due && due >= today) p.total_futuro += valor;
  }
  const rows = Object.values(m).map(r => ({ ...r,
    total_pago: Math.round(r.total_pago*100)/100, total_vencido: Math.round(r.total_vencido*100)/100,
    total_futuro: Math.round(r.total_futuro*100)/100, atualizado_em: new Date().toISOString() }));
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('pacientes_financeiro').upsert(rows.slice(i, i+500), { onConflict: 'clinicorp_id' });
    if (error) throw new Error(error.message);
  }
  console.log(`[pacientes_financeiro] ${rows.length} pacientes atualizados`);
}

// Agrega o /payment/list por MÊS de vencimento (parcelas a vencer, 24m) →
// fin_recebiveis_mensal. Range completo com zeros; upsert + limpeza do passado.
async function atualizarRecebiveisMensais(items, today) {
  const meses = agruparParcelasPorMes(items, today);
  const agora = new Date().toISOString();
  const rows = meses.map(m => ({ mes: m.mes + '-01', valor: m.valor, atualizado_em: agora }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('fin_recebiveis_mensal').upsert(rows.slice(i, i + 500), { onConflict: 'mes' });
    if (error) throw new Error(error.message);
  }
  const del = await supabase.from('fin_recebiveis_mensal').delete().lt('mes', rows[0].mes);
  if (del.error) console.error('[recebiveis_mensal] limpeza falhou:', del.error.message);
  console.log(`[recebiveis_mensal] ${rows.length} meses atualizados`);
}

// Análises da carteira p/ a página A Receber / A Pagar (1 linha JSON, sobrescrita).
async function atualizarAnalisesSaude(items, today) {
  const dados = {
    aging: _analiseParcelas.agingVencido(items, today),
    perda: _analiseParcelas.taxaPerda(items, today),
    renovacao: _analiseParcelas.novasERecebidasPorMes(items, today, 12),
    top: _analiseParcelas.topPagadores(items, today, 10),
    retroativo: _analiseParcelas.carteiraRetroativa(items, today, 24),
  };
  const { error } = await supabase.from('fin_saude_analises')
    .upsert({ id: 1, dados, atualizado_em: new Date().toISOString() }, { onConflict: 'id' });
  if (error) throw new Error(error.message);
  console.log('[saude_analises] atualizadas');
}

// Snapshot diário dos totais A PARTIR DO MÊS SEGUINTE ao vigente (o mês corrente
// é parcial — contas pagas saem do forecast e distorcem a tendência).
async function gravarSnapshotSaude(today) {
  const proxMes = (() => { let [y, m] = today.slice(0, 7).split('-').map(Number);
    m++; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, '0')}-01`; })();
  const [receb, fluxo, vencido] = await Promise.all([
    supabase.from('fin_recebiveis_mensal').select('valor').gte('mes', proxMes),
    supabase.from('fin_fluxo_futuro').select('a_pagar').gte('mes', proxMes),
    supabase.rpc('fin_vencido_total'),
  ]);
  if (receb.error || fluxo.error || vencido.error)
    throw new Error((receb.error || fluxo.error || vencido.error).message);
  const receber = (receb.data || []).reduce((s, r) => s + Number(r.valor), 0);
  const pagar = (fluxo.data || []).reduce((s, r) => s + Number(r.a_pagar), 0);
  const { error } = await supabase.from('fin_saude_snapshots').upsert({
    data: today, receber: Math.round(receber * 100) / 100, pagar: Math.round(pagar * 100) / 100,
    resultado: Math.round((receber - pagar) * 100) / 100,
    vencido: Number(vencido.data || 0), origem: 'diario',
  }, { onConflict: 'data' });
  if (error) throw new Error(error.message);
  console.log(`[saude_snapshot] ${today}: receber ${Math.round(receber)} × pagar ${Math.round(pagar)}`);
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
    // data_agendamento = ATO de agendar (agora); data_compromisso = dia/hora da consulta.
    const dataCompromisso = new Date(data + 'T' + hora_inicio + ':00-03:00').toISOString();
    const crcNome = req.user?.profile?.name || req.user?.email || null;
    await supabase.from('leads').update({
      status: 'Avaliação agendada',
      data_agendamento: new Date().toISOString(),
      data_compromisso: dataCompromisso,
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
  const PRE_COMPARECEU = ['Novo', 'Em qualificação', 'Avaliação agendada'];
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

// ===== Recuperação de falta de avaliação (spec 2026-07-05) =====
// Detecta no-shows pela agenda, cria etiqueta+tarefa, roda cadência D+0/3/7/10.
function _hojeSP() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

async function _criarTarefaRecuperacao(falta, assigneeId) {
  const desc = [
    'Paciente faltou à avaliação (' + (falta.category || 's/ categoria') + ').',
    falta.telefone ? 'Tel: ' + falta.telefone : 'Sem telefone no cadastro — buscar no Clinicorp.',
    falta.dentist_name ? 'Dentista: ' + falta.dentist_name : null,
    'Data da falta: ' + falta.appointment_date,
    'Ligar para remarcar.',
  ].filter(Boolean).join('\n');
  const { data, error } = await supabase.from('tasks').insert({
    titulo: 'Recuperar falta — ' + (falta.patient_name || 'paciente'),
    descricao: desc, tipo: 'pontual', data_ref: _hojeSP(),
    created_by: assigneeId, prioridade: 'alta', categoria: 'recuperacao_falta',
    prazo: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    lead_id: falta.lead_id || null, assignee_id: assigneeId, status: 'pendente',
  }).select('id').single();
  if (error) { console.error('[recuperacao] task:', error.message); return null; }
  return data.id;
}

async function _donoProvisorioRodizio() {
  const { data: cfg } = await supabase.from('app_config')
    .select('recuperacao_falta_crc_leads, recuperacao_falta_rodizio_idx').eq('id', 1).maybeSingle();
  const lista = Array.isArray(cfg?.recuperacao_falta_crc_leads) ? cfg.recuperacao_falta_crc_leads : [];
  if (!lista.length) return { dono: null, todos: [] };
  const idx = (cfg.recuperacao_falta_rodizio_idx || 0) % lista.length;
  const dono = lista[idx];
  await supabase.from('app_config').update({ recuperacao_falta_rodizio_idx: idx + 1 }).eq('id', 1);
  return { dono, todos: lista };
}

// Read-only: lista de CRC de Leads sem avançar o índice do rodízio.
// Usar no read-path (ex.: renotificação/lembrete); o avanço do índice
// é exclusivo do momento em que um NOVO dono provisório é escolhido
// (ver _donoProvisorioRodizio, usado só na atribuição de falta nova).
async function _listaCrcLeads() {
  const { data: cfg } = await supabase.from('app_config')
    .select('recuperacao_falta_crc_leads').eq('id', 1).maybeSingle();
  return Array.isArray(cfg?.recuperacao_falta_crc_leads) ? cfg.recuperacao_falta_crc_leads : [];
}

async function varrerFaltasAvaliacao() {
  const hoje = _hojeSP();
  // 1) NOVAS faltas
  const { data: novas, error: eNovas } = await supabase.rpc('detectar_faltas_avaliacao', { dias: 30 });
  if (eNovas) { console.error('[recuperacao] detectar:', eNovas.message); return; }
  const { data: cfg } = await supabase.from('app_config')
    .select('recuperacao_falta_crc_pos').eq('id', 1).maybeSingle();
  const crcPos = cfg?.recuperacao_falta_crc_pos || null;
  for (const f of (novas || [])) {
    try {
      // define responsável
      let assignee = null, semDono = false;
      if ((f.category || '').match(/pós|pos/i) && crcPos) assignee = crcPos;
      else if (f.crc_agendamento_id) assignee = f.crc_agendamento_id;
      let todosLeads = [];
      if (!assignee) { const r = await _donoProvisorioRodizio(); assignee = r.dono; todosLeads = r.todos; semDono = true; }
      if (!assignee) continue; // sem config → não cria (evita task órfã)
      const taskId = await _criarTarefaRecuperacao(f, assignee);
      if (f.lead_id) await supabase.rpc('lead_add_etiqueta', { p_lead_id: f.lead_id, p_tag: 'Faltou' });
      await supabase.from('recuperacao_faltas').insert({
        clinicorp_appt_id: f.clinicorp_appt_id, patient_name: f.patient_name, category: f.category,
        dentist_name: f.dentist_name, appointment_date: f.appointment_date, telefone: f.telefone,
        lead_id: f.lead_id || null, crc_responsavel_id: semDono ? null : assignee,
        status: 'aberta', toques_enviados: 1, ultimo_toque_em: new Date().toISOString(), task_id: taskId,
      });
      if (semDono) {
        for (const uid of todosLeads) {
          await criarNotificacao(uid, 'falta_sem_responsavel', 'Falta sem responsável',
            (f.patient_name || 'Paciente') + ' faltou (' + (f.category || '') + '). Atribuída provisoriamente; remaneje se for de outra.',
            { url: '/tarefas/', task_id: taskId });
        }
      }
    } catch (e) { console.error('[recuperacao] nova falta:', e.message); }
  }
  // 2) ABERTAS: recuperação + cadência
  const { data: abertas } = await supabase.from('recuperacao_faltas').select('*').eq('status', 'aberta');
  for (const r of (abertas || [])) {
    try {
      const { data: recuperada } = await supabase.rpc('falta_esta_recuperada', { p_appt_id: r.clinicorp_appt_id });
      if (recuperada) {
        if (r.task_id) await supabase.from('tasks').update({ status: 'concluida' }).eq('id', r.task_id);
        await supabase.from('recuperacao_faltas').update({ status: 'recuperada', recuperada_em: new Date().toISOString() }).eq('id', r.id);
        continue;
      }
      const marco = toqueDevido(r.appointment_date, hoje, r.toques_enviados);
      if (marco === null) continue;
      if (marco === 10) {
        // auto-Perdido com trava. Já passamos pela checagem de recuperação acima e
        // NÃO recuperou → logo não há consulta futura (futura tornaria recuperada).
        // Por isso temConsultaFutura é definitivamente false aqui (sem RPC extra).
        let statusLead = null, tarefaConcluida = false;
        if (r.lead_id) {
          const { data: l } = await supabase.from('leads').select('status').eq('id', r.lead_id).maybeSingle();
          statusLead = l?.status || null;
        }
        if (r.task_id) {
          const { data: t } = await supabase.from('tasks').select('status').eq('id', r.task_id).maybeSingle();
          tarefaConcluida = t?.status === 'concluida';
        }
        if (podeAutoPerder({ leadEncontrado: !!r.lead_id, statusLead, temConsultaFutura: false, tarefaConcluida })) {
          await supabase.from('leads').update({ status: 'Perdido', motivo_perda: 'Faltou e não retornou' }).eq('id', r.lead_id);
          logEvento(r.lead_id, 'status_mudou', 'Auto-Perdido: faltou e não retornou', { de: statusLead, para: 'Perdido' }, null);
          if (r.task_id) await supabase.from('tasks').update({ status: 'concluida' }).eq('id', r.task_id);
          await supabase.from('recuperacao_faltas').update({ status: 'perdida' }).eq('id', r.id);
        } else {
          await supabase.from('recuperacao_faltas').update({ status: 'encerrada' }).eq('id', r.id);
        }
        continue;
      }
      // toque D+3 ou D+7: renotifica o dono (ou as 3 se sem dono)
      const alvo = r.crc_responsavel_id ? [r.crc_responsavel_id] : (await _listaCrcLeads());
      for (const uid of alvo) {
        await criarNotificacao(uid, 'falta_recuperar_lembrete', 'Lembrete: recuperar falta',
          'D+' + marco + ' — ' + (r.patient_name || 'paciente') + ' ainda não voltou. Insista na remarcação.',
          { url: '/tarefas/', task_id: r.task_id });
      }
      await supabase.from('recuperacao_faltas').update({
        toques_enviados: r.toques_enviados + 1, ultimo_toque_em: new Date().toISOString(),
      }).eq('id', r.id);
    } catch (e) { console.error('[recuperacao] cadencia:', e.message); }
  }
}

setInterval(function () {
  varrerFaltasAvaliacao().catch(function (e) { console.error('[recuperacao]', e.message); });
}, 3 * 3600 * 1000);

// ── Webhook do Clinicorp (Clinicorp -> CRM, tempo real) ──────────────────────
// Cadastrado em sistema.clinicorp.com → Acesso Externo → Gestão de Webhook,
// apontando para https://<host>/api/clinicorp/webhook.
// Endpoint PÚBLICO (o Clinicorp não envia nosso JWT). Proteção opcional via
// CLINICORP_WEBHOOK_SECRET (querystring ?secret= ou header x-webhook-secret).
// v1: trata COMPARECIMENTO (check-in) → marca "Compareceu" + dispara CAPI Contact.
// Loga o payload cru para mapearmos o formato exato do Clinicorp na 1ª chamada real.
const _PODE_COMPARECER = new Set(['Novo','Em qualificação','Avaliação agendada']);

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
    // DASHBOARD_UNIFICADO=1 ativa a Etapa 3 (CRM Antigo + Novo). Default: só CRM Antigo (Etapa 1).
    const payload = await montarDashboard(supabase, periodo, origem, { unificado: process.env.DASHBOARD_UNIFICADO === '1' });
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
      .select('valor_particular, entrada_valor, clinicorp_lastchange, lead_id, paciente_nome, telefone, data_fechamento')
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

    if (acao === 'aprovar') {
      // Espelha a venda aprovada no módulo Pacientes (Sucesso do Cliente).
      // Dedup por clinicorp_estimate_id — orçamentos vêm sem lead_id, então não dá pra
      // depender dele aqui (era o bug: aprovados nunca chegavam em pacientes_sucesso).
      (async () => {
        try {
          const { data: jaExisteArr } = await supabase.from('pacientes_sucesso')
            .select('id, excluido_em').eq('clinicorp_estimate_id', id).limit(1);
          if (jaExisteArr?.length && jaExisteArr[0].excluido_em) {
            // Linha soft-deletada no Pacientes 2: reaprovação reativa (senão a venda sumiria dos dois módulos)
            await supabase.from('pacientes_sucesso')
              .update({ excluido_em: null }).eq('id', jaExisteArr[0].id);
          }
          if (!jaExisteArr?.length) {
            let telefone = orc.telefone || '';
            if (!telefone && orc.lead_id) {
              const { data: lead } = await supabase.from('leads')
                .select('telefone').eq('id', orc.lead_id).maybeSingle();
              telefone = lead?.telefone || '';
            }
            await supabase.from('pacientes_sucesso').insert({
              lead_id: orc.lead_id || null,
              clinicorp_estimate_id: id,
              nome: orc.paciente_nome || '',
              telefone,
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
    let q = supabase.from('pacientes_sucesso').select('*').is('excluido_em', null).order('data_venda', { ascending: false, nullsFirst: false });
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

// ========== PACIENTES 2 (beta) — mesma tabela, leitura enriquecida via RPC ==========
// Enriquecimento (financeiro, agenda, dentistas) é feito no Postgres (pacientes_sucesso_v2),
// sobre tabelas já sincronizadas — zero chamadas ao Clinicorp. RPC retorna jsonb único
// (não sofre o teto de 1000 linhas do PostgREST).
app.get('/api/pacientes2', requireAuth, requireCrcSucesso, rateLimit, async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('pacientes_sucesso_v2');
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pacientes2/dentistas', requireAuth, requireCrcSucesso, rateLimit, async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('dentistas_nomes');
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Soft-delete: some da lista (v2); linha preservada no banco (excluido_em).
app.delete('/api/pacientes2/:id', requireAuth, requireCrcSucesso, rateLimit, async (req, res) => {
  try {
    const excluido_em = new Date().toISOString();
    const { data, error } = await supabase.from('pacientes_sucesso')
      .update({ excluido_em })
      .eq('id', req.params.id).select('id').single();
    if (error) throw error;
    res.json({ ok: true, id: data.id, excluido_em });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Restaurar um excluído (lista "Excluídos" no rodapé do Pacientes 2)
app.post('/api/pacientes2/:id/restaurar', requireAuth, requireCrcSucesso, rateLimit, async (req, res) => {
  try {
    const { data, error } = await supabase.from('pacientes_sucesso')
      .update({ excluido_em: null })
      .eq('id', req.params.id).select('id').single();
    if (error) throw error;
    res.json({ ok: true, id: data.id });
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
// Estado global do sync neste processo (evita execuções simultâneas).
let _syncRunning = false;
async function runGuardedSync(trigger) {
  if (_syncRunning) { console.log('[sync] já em execução — gatilho ignorado:', trigger); return null; }
  _syncRunning = true;
  try {
    const result = await runClinicorpSync(trigger);
    // CAPI Purchase dos leads que o sync avançou p/ Fechou (dedup via eventos_meta_enviados)
    for (const id of (result?.leads_fechados_ids || [])) {
      try {
        const { data: lead } = await supabase.from('leads').select('*').eq('id', id).maybeSingle();
        if (lead) await dispararConversaoMeta(lead);
      } catch (e) { console.error('[sync-fechou] CAPI lead', id, ':', e.message); }
    }
    return result;
  }
  finally { _syncRunning = false; }
}

// ── Sync diário Clinicorp: self-healing (sobrevive a restart do container) ──
// O estado fica no banco (sync_log), não em memória: a cada tick, se já passou
// das 02:00 BRT de hoje e nenhuma execução foi registrada desde então, dispara.
// Assim, se o container estava fora do ar às 02:00, ele recupera ao voltar.
(function agendarSyncDiario() {
  // Instante de hoje às 02:00 no horário de Brasília (UTC-3, sem horário de verão).
  function janelaHoje() {
    const hojeBRT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD
    return new Date(`${hojeBRT}T02:00:00-03:00`);
  }

  async function verificarEExecutar() {
    if (_syncRunning) return;
    const janela = janelaHoje();
    if (Date.now() < janela.getTime()) return; // ainda não deu 02:00 hoje
    try {
      const { data, error } = await supabase.from('sync_log')
        .select('id').gte('started_at', janela.toISOString()).limit(1);
      if (error) throw error;
      if (data && data.length) return; // já houve uma execução desde as 02:00 de hoje
    } catch (e) {
      console.error('[sync-diario] checagem sync_log falhou:', e.message);
      return; // sem confirmação do DB, não dispara (evita loop)
    }
    console.log('[sync-diario] disparando sync agendado');
    runGuardedSync('agendado').catch(e => console.error('[sync-diario] erro:', e.message));
    // sync financeiro do mês corrente — mesma janela diária, sem derrubar o processo
    try {
      const { from, to } = _finMesCorrente();
      await syncFinanceiro(from, to);
      console.log('[financeiro-sync] mês corrente sincronizado');
    } catch (e) { console.error('[financeiro-sync] erro:', e.message); }
    // A Receber / A Pagar (24m) — 1 chamada list_cash_flow, erro não derruba as demais fases
    try {
      await syncFluxoFuturo();
      console.log('[fluxo-futuro] 24m sincronizado');
    } catch (e) { console.error('[fluxo-futuro] erro:', e.message); }
    // Financeiro por paciente + inadimplentes (/payment/list) — diário, não só sob demanda.
    try { await fetchInadimplentesBackground(); }
    catch (e) { console.error('[inadimplentes-diario] erro:', e.message); }
  }

  setTimeout(() => verificarEExecutar().catch(() => {}), 30_000);       // logo após o boot
  setInterval(() => verificarEExecutar().catch(() => {}), 10 * 60_000); // a cada 10 min
  console.log('[sync-diario] scheduler self-healing ativo (verifica a cada 10 min, janela 02:00 BRT)');
})();
// ========== SYNC MANUAL ==========
// POST /api/admin/sync-clinicorp  — dispara sync imediatamente (sem esperar as 2h)
app.post('/api/admin/sync-clinicorp', requireAuth, async (req, res) => {
  if (_syncRunning) return res.json({ ok: true, running: true, msg: 'Sync já em andamento' });
  res.json({ ok: true, msg: 'Sync iniciado em background — acompanhe o status' });
  runGuardedSync('manual').catch(e => console.error('[sync-manual] erro:', e.message));
  // Financeiro por paciente + inadimplentes (/payment/list) — guarda própria evita rodar 2x.
  fetchInadimplentesBackground().catch(e => console.error('[inadimplentes-manual] erro:', e.message));
});

// GET /api/admin/sync-status — última execução registrada + se há sync rodando agora
app.get('/api/admin/sync-status', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('sync_log')
      .select('started_at, finished_at, ok, trigger, duration_s, steps, error')
      .order('started_at', { ascending: false }).limit(1);
    if (error) throw error;
    res.json({ running: _syncRunning, last: data?.[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== CAPI SAÚDE — Monitor ==========
async function capiCarregarRows(diasAtras = 21) {
  const desde = new Date(Date.now() - diasAtras * 86400000).toISOString();
  const todos = [];
  let from = 0; const passo = 1000;
  while (true) { // lead_eventos pode passar de 1000 linhas — paginar
    const { data, error } = await supabase.from('lead_eventos')
      .select('criado_em, metadata')
      .eq('tipo', 'capi_disparado').gte('criado_em', desde)
      .order('criado_em', { ascending: false }).range(from, from + passo - 1);
    if (error) throw error;
    todos.push(...(data || []));
    if (!data || data.length < passo) break;
    from += passo;
  }
  return todos.map(capiHealth.normalizar);
}

app.get('/api/admin/capi-saude', requireAuth, requireGestor, async (req, res) => {
  try {
    const agora = new Date();
    const rows = await capiCarregarRows(21);
    // Erros recentes (7d): subcode -> contagem + última ocorrência + página(s) afetada(s)
    const corte7 = new Date(agora - 7 * 86400000);
    const errosMap = {};
    for (const r of rows) {
      if (r.sucesso || !r.subcode || r.ts < corte7) continue;
      const e = errosMap[r.subcode] || (errosMap[r.subcode] = { subcode: r.subcode, count: 0, ultima: null, paginas: new Set() });
      e.count++;
      if (!e.ultima || r.ts > e.ultima) e.ultima = r.ts;
      if (r.pageId) e.paginas.add(r.pageId);
    }
    const erros = Object.values(errosMap)
      .map(e => ({ subcode: e.subcode, count: e.count, ultima: e.ultima ? e.ultima.toISOString() : null, paginas: [...e.paginas] }))
      .sort((a, b) => b.count - a.count);
    res.json({
      semana: capiHealth.contagensPorSemana(rows, agora),
      cobertura: capiHealth.coberturaMatch(rows.filter(r => r.ts >= new Date(agora - 7 * 86400000))),
      totais7d: capiHealth.totais7d(rows, agora),
      gatilhos: capiHealth.avaliarGatilhos(rows, agora),
      erros,
      atualizadoEm: agora.toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function _textoAlerta(n) {
  const map = {
    taxa_falha: 'Taxa de falha alta no CAPI',
    silencio: 'Página sem eventos CAPI (silêncio)',
    erro_novo: 'Novo erro no CAPI',
    queda_volume: 'Queda de volume de eventos CAPI',
    divergencia: 'Divergência enviado x registrado na Meta',
  };
  return (map[n.gatilho] || n.gatilho) + (n.escopo ? ` — ${n.escopo}` : '');
}

let _capiChecando = false;
async function capiChecarGatilhos() {
  if (_capiChecando) return;
  _capiChecando = true;
  try {
    const agora = new Date();
    const rows = await capiCarregarRows(21);
    const atuais = capiHealth.avaliarGatilhos(rows, agora);
    const { data: salvos } = await supabase.from('capi_monitor_estado').select('*');
    const { notificar, upserts } = capiHealth.decidirAlertas(atuais, salvos || [], agora);
    for (const u of upserts) {
      await supabase.from('capi_monitor_estado')
        .upsert({ ...u, atualizado_em: agora.toISOString() }, { onConflict: 'gatilho,escopo' });
    }
    if (notificar.length) {
      const { data: gestores } = await supabase.from('profiles').select('id').or('roles.cs.{admin},roles.cs.{gestor}');
      for (const n of notificar) {
        const corpo = _textoAlerta(n) + ' — veja o detalhe no monitor.';
        for (const g of gestores || []) await criarNotificacao(g.id, 'capi_alerta', 'Alerta CAPI', corpo, { url: '/capi-saude/' });
      }
      console.log('[capi-monitor] alertas enviados:', notificar.map(_textoAlerta).join(' | '));
    }
  } catch (e) { console.error('[capi-monitor] checagem falhou:', e.message); }
  finally { _capiChecando = false; }
}

setTimeout(() => capiChecarGatilhos(), 45_000);
setInterval(() => capiChecarGatilhos(), 30 * 60_000); // a cada 30 min
console.log('[capi-monitor] scheduler de alertas ativo (30 min)');

app.post('/api/admin/capi-saude/recheck', requireAuth, requireGestor, async (req, res) => {
  res.json({ ok: true, msg: 'Re-checagem disparada' });
  capiChecarGatilhos().catch(e => console.error('[capi-monitor] recheck:', e.message));
});

// ========== WhatsApp — Monitor de saúde dos números (Cloud API) ==========
// Detecta quando um número sai do estado saudável da Cloud API. Causa real do
// incidente 30/06: WABA sem forma de pagamento → Meta desregistra o número →
// platform_type vira ON_PREMISE / throughput NOT_APPLICABLE e o envio falha com
// (#133010). Aqui consultamos o número na Graph API e avisamos os gestores no
// sino do CRM SÓ na MUDANÇA de estado (não spamma a cada tick).
const WA_SAUDE_NUMEROS = [
  { rotulo: 'Conversas (9649-2873)', pid: process.env.WHATSAPP_PHONE_NUMBER_ID,
    tok: process.env.WHATSAPP_API_TOKEN || process.env.WHATSAPP_CLOUD_TOKEN },
  { rotulo: 'Broadcast (3824-8700)', pid: process.env.WHATSAPP_BROADCAST_PHONE_ID,
    tok: process.env.WHATSAPP_BROADCAST_TOKEN || process.env.WHATSAPP_API_TOKEN || process.env.WHATSAPP_CLOUD_TOKEN },
].filter(n => n.pid && n.tok);

const _waSaudeEstado = {}; // pid -> 'ok' | 'degradado'
let _waChecando = false;

async function waAvaliarNumero(n) {
  // Retorna { ok, motivo, detalhe } ou null se não deu pra avaliar (rede/token).
  try {
    const url = `https://graph.facebook.com/v21.0/${n.pid}` +
      `?fields=display_phone_number,platform_type,throughput,quality_rating,account_mode` +
      `&access_token=${n.tok}`;
    const r = await fetch(url);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return null; // erro de rede/token → não alarmar (evita falso positivo)
    const plat = j.platform_type;
    const thr = j.throughput && j.throughput.level;
    const degradado = plat !== 'CLOUD_API' || thr === 'NOT_APPLICABLE';
    let motivo = '';
    if (degradado) {
      motivo = `platform_type=${plat || '?'}, throughput=${thr || '?'}`;
      if (plat === 'ON_PREMISE') motivo += ' (provável WABA sem forma de pagamento)';
    }
    return { ok: !degradado, motivo, detalhe: { platform_type: plat, throughput: thr, quality_rating: j.quality_rating } };
  } catch (e) { return null; }
}

async function waChecarSaude() {
  if (_waChecando || !WA_SAUDE_NUMEROS.length) return;
  _waChecando = true;
  try {
    let gestores = null;
    for (const n of WA_SAUDE_NUMEROS) {
      const res = await waAvaliarNumero(n);
      if (!res) continue; // não avaliável agora
      const novo = res.ok ? 'ok' : 'degradado';
      const ant = _waSaudeEstado[n.pid];
      _waSaudeEstado[n.pid] = novo;
      const primeira = ant === undefined;
      // Alerta: degradou (ou já nasceu degradado no boot) | Recuperou: degradado -> ok
      const alertarFalha = novo === 'degradado' && (primeira || ant === 'ok');
      const alertarOk = novo === 'ok' && ant === 'degradado';
      if (!alertarFalha && !alertarOk) continue;
      if (!gestores) {
        const { data } = await supabase.from('profiles').select('id').or('roles.cs.{admin},roles.cs.{gestor}');
        gestores = data || [];
      }
      const titulo = alertarFalha ? '🔴 WhatsApp fora do ar' : '✅ WhatsApp normalizado';
      const corpo = alertarFalha
        ? `O número ${n.rotulo} saiu da Cloud API — o CRM pode não conseguir enviar mensagens. ${res.motivo}. Cheque a forma de pagamento da WABA no WhatsApp Manager.`
        : `O número ${n.rotulo} voltou ao normal (Cloud API).`;
      for (const g of gestores) await criarNotificacao(g.id, 'whatsapp_saude', titulo, corpo, { url: '/conversas/' });
      console.log(`[wa-monitor] ${n.rotulo}: ${ant ?? 'boot'} -> ${novo} (${res.motivo || 'ok'})`);
    }
  } catch (e) { console.error('[wa-monitor] checagem falhou:', e.message); }
  finally { _waChecando = false; }
}

setTimeout(() => waChecarSaude(), 50_000);
setInterval(() => waChecarSaude(), 20 * 60_000); // a cada 20 min
console.log('[wa-monitor] scheduler de saúde WhatsApp ativo (20 min)');

app.get('/api/admin/whatsapp-saude', requireAuth, requireGestor, async (req, res) => {
  const out = [];
  for (const n of WA_SAUDE_NUMEROS) {
    const r = await waAvaliarNumero(n);
    out.push({ rotulo: n.rotulo, phone_id: n.pid, avaliavel: !!r,
      ok: r ? r.ok : null, ...(r ? r.detalhe : {}), motivo: r ? r.motivo : 'não avaliável (token/rede)' });
  }
  res.json({ numeros: out, atualizadoEm: new Date().toISOString() });
});

app.post('/api/admin/whatsapp-saude/recheck', requireAuth, requireGestor, async (req, res) => {
  res.json({ ok: true, msg: 'Re-checagem disparada' });
  waChecarSaude().catch(e => console.error('[wa-monitor] recheck:', e.message));
});

// ========== CAPI — Resumos diários 8h / 18h ==========
function _resumoTexto(rows, slot, agora) {
  const t = capiHealth.totais7d(rows, agora);
  const g = capiHealth.avaliarGatilhos(rows, agora).filter(x => x.status === 'ruim');
  const cab = slot === '8h' ? 'Saúde CAPI (ontem)' : 'Saúde CAPI (hoje até agora)';
  const status = g.length ? `⚠️ ${g.length} alerta(s)` : '✅ tudo ok';
  return `${cab}: ${status}. 7d: ${t.sucesso} ok / ${t.falha} falha.`;
}

async function capiEnviarResumo(slot, force = false) {
  const col = slot === '8h' ? 'capi_resumo_8h_ultimo' : 'capi_resumo_18h_ultimo';
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  if (!force) {
    const { data: claimed, error } = await supabase.from('app_config')
      .update({ [col]: hoje }).eq('id', 1)
      .or(`${col}.is.null,${col}.neq.${hoje}`).select('id');
    if (error || !claimed || !claimed.length) return false; // já enviado hoje
  } else {
    await supabase.from('app_config').update({ [col]: hoje }).eq('id', 1);
  }
  const rows = await capiCarregarRows(21);
  const texto = _resumoTexto(rows, slot, new Date());
  const { data: gestores } = await supabase.from('profiles').select('id').or('roles.cs.{admin},roles.cs.{gestor}');
  for (const gst of gestores || []) await criarNotificacao(gst.id, 'capi_resumo', 'Resumo CAPI', texto, { url: '/capi-saude/' });
  console.log('[capi-monitor] resumo', slot, 'enviado:', texto);
  return true;
}

// scheduler self-healing dos resumos (claim atômico evita duplicação entre ticks/instâncias)
(function agendarResumosCapi() {
  function horaBRT() { return Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false })); }
  async function tick() {
    const hh = horaBRT();
    try {
      if (hh >= 8 && hh < 18) await capiEnviarResumo('8h');
      if (hh >= 18) await capiEnviarResumo('18h');
    } catch (e) { console.error('[capi-monitor] resumo tick:', e.message); }
  }
  setTimeout(() => tick().catch(() => {}), 60_000);
  setInterval(() => tick().catch(() => {}), 15 * 60_000);
  console.log('[capi-monitor] scheduler de resumos 8h/18h ativo');
})();

// Conjuntos de anúncio: cruza CONVERSAS (Meta, evento de otimização atual) com o que o
// NOSSO CAPI registrou de volta por conjunto (eventos do funil com SUCESSO). Expõe os
// conjuntos que recebem conversa mas NÃO retornam pelo CAPI (ex.: página não conectada
// ao dataset). O limiar 50/sem vale só no evento de otimização (hoje = conversa). 7 dias.
const CAPI_EVENTOS_FUNIL = ['LeadSubmitted', 'LeadQualified', 'Schedule', 'Contact', 'Purchase'];
app.get('/api/admin/capi-saude/conjuntos', requireAuth, requireGestor, async (req, res) => {
  try {
    const TOKEN = process.env.META_ACCESS_TOKEN;
    const desde = new Date(Date.now() - 7 * 86400000);
    // 1) Meta insights nível ANÚNCIO: mapeia ad_id -> conjunto e soma conversas por conjunto
    const adsetInfo = {};   // adset_id -> { adset_name, campaign_name, conversas }
    const adToAdset = {};   // ad_id -> adset_id
    let metaErro = TOKEN ? null : 'sem_token';
    if (TOKEN) {
      const ymd = d => d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
      const timeRange = JSON.stringify({ since: ymd(desde), until: ymd(new Date()) });
      const url = 'https://graph.facebook.com/' + META_API_VERSION + '/act_' + META_AD_ACCOUNT_ID +
        '/insights?level=ad&fields=ad_id,adset_id,adset_name,campaign_name,actions,spend' +
        '&time_range=' + encodeURIComponent(timeRange) + '&limit=500';
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 25000);
      let r;
      try { r = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN }, signal: ctrl.signal }); }
      finally { clearTimeout(to); }
      const json = await r.json();
      if (json.error) metaErro = json.error.message || 'Erro Meta';
      else (json.data || []).forEach(row => {
        const conv = (row.actions || []).find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d');
        adToAdset[row.ad_id] = row.adset_id;
        if (!adsetInfo[row.adset_id]) adsetInfo[row.adset_id] = { adset_name: row.adset_name, campaign_name: row.campaign_name, conversas: 0, spend7d: 0 };
        adsetInfo[row.adset_id].conversas += conv ? parseInt(conv.value, 10) : 0;
        adsetInfo[row.adset_id].spend7d += parseFloat(row.spend) || 0;
      });
    }
    // 2) Nosso CAPI: eventos (7d) -> ad_id do lead (lead.campanha) -> sucesso/falha por conjunto
    const eventos = [];
    let from = 0; const passo = 1000;
    while (true) {
      const { data, error } = await supabase.from('lead_eventos')
        .select('lead_id, metadata').eq('tipo', 'capi_disparado').gte('criado_em', desde.toISOString())
        .order('criado_em', { ascending: false }).range(from, from + passo - 1);
      if (error) throw error;
      eventos.push(...(data || []));
      if (!data || data.length < passo) break;
      from += passo;
    }
    const leadIds = [...new Set(eventos.map(e => e.lead_id).filter(Boolean))];
    const leadAd = {};
    for (let i = 0; i < leadIds.length; i += 300) {
      const { data } = await supabase.from('leads').select('id, campanha').in('id', leadIds.slice(i, i + 300));
      (data || []).forEach(l => { if (l.campanha && /^\d{6,}$/.test(l.campanha)) leadAd[l.id] = l.campanha; });
    }
    const capiByAdset = {}; // adset_id -> { EVENTO: {ok,fail} }
    for (const ev of eventos) {
      const adId = leadAd[ev.lead_id]; if (!adId) continue;
      const adset = adToAdset[adId]; if (!adset) continue;
      const m = ev.metadata || {}; if (!CAPI_EVENTOS_FUNIL.includes(m.evento)) continue;
      const ok = m.sucesso === true || m.sucesso === 'true';
      capiByAdset[adset] = capiByAdset[adset] || {};
      capiByAdset[adset][m.evento] = capiByAdset[adset][m.evento] || { ok: 0, fail: 0 };
      ok ? capiByAdset[adset][m.evento].ok++ : capiByAdset[adset][m.evento].fail++;
    }
    // 3) monta as linhas (conjuntos com conversa>0 OU com algum evento CAPI)
    const ids = new Set([...Object.keys(adsetInfo).filter(id => adsetInfo[id].conversas > 0), ...Object.keys(capiByAdset)]);
    const META_SEM = 50;
    const conjuntos = [...ids].map(id => {
      const info = adsetInfo[id] || { adset_name: '(conjunto fora do período)', campaign_name: '', conversas: 0, spend7d: 0 };
      const eventos = {};
      for (const e of CAPI_EVENTOS_FUNIL) eventos[e] = (capiByAdset[id] && capiByAdset[id][e]) || { ok: 0, fail: 0 };
      const capiRetorna = eventos.LeadSubmitted.ok > 0;
      const spend7d = info.spend7d || 0;
      const diaAtual = spend7d / 7;
      // Verba diária sugerida p/ bater META_SEM por semana de cada etapa do funil
      // (estimativa LINEAR: assume custo por evento constante ao escalar — vale p/ saltos
      // moderados; o custo real tende a subir). Só estimável com gasto>0 e evento>0.
      const verba = {};
      for (const e of CAPI_EVENTOS_FUNIL) {
        const n = eventos[e].ok;
        if (spend7d <= 0 || n <= 0) { verba[e] = null; continue; }     // sem base p/ estimar
        if (n >= META_SEM) { verba[e] = { ok: true, diaAtual: Math.round(diaAtual) }; continue; }
        const novoDia = META_SEM * spend7d / (7 * n);                  // R$/dia p/ chegar a 50/sem
        verba[e] = { ok: false, add: Math.round(novoDia - diaAtual), novoDia: Math.round(novoDia), diaAtual: Math.round(diaAtual) };
      }
      return { adset_id: id, adset_name: info.adset_name, campaign_name: info.campaign_name, conversas: info.conversas, spend7d: Math.round(spend7d), diaAtual: Math.round(diaAtual), eventos, capiRetorna, verba };
    }).sort((a, b) => b.conversas - a.conversas);
    res.json({ conjuntos, meta: META_SEM, eventoFoco: 'LeadQualified', eventosFunil: CAPI_EVENTOS_FUNIL, metaErro, atualizadoEm: new Date().toISOString() });
  } catch (e) {
    if (e.name === 'AbortError') return res.json({ metaErro: 'Meta não respondeu a tempo', conjuntos: [], meta: 50 });
    res.status(500).json({ error: e.message });
  }
});

// EMQ (Event Match Quality) por dataset — qualidade do match que a Meta calcula (0–10).
// Endpoint Graph: /dataset_quality?dataset_id=<id>&fields=web{event_match_quality,event_name}.
const CAPI_DATASETS_EMQ = {
  '904146029308947': 'Dr. Marcos Vinicius (pág 106)',
  '981176104681444': 'Clínica AMA (pág 1204)',
};
app.get('/api/admin/capi-saude/emq', requireAuth, requireGestor, async (req, res) => {
  try {
    const TOKEN = process.env.META_ACCESS_TOKEN;
    if (!TOKEN) return res.json({ sem_token: true, datasets: [] });
    const fields = encodeURIComponent('web{event_match_quality,event_name}');
    const datasets = [];
    for (const [id, label] of Object.entries(CAPI_DATASETS_EMQ)) {
      const url = 'https://graph.facebook.com/' + META_API_VERSION + '/dataset_quality?dataset_id=' + id + '&fields=' + fields;
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 15000);
      try {
        const r = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN }, signal: ctrl.signal });
        const json = await r.json();
        if (json.error) { datasets.push({ id, label, erro: json.error.message || 'Erro Meta' }); continue; }
        const eventos = (json.web || []).map(w => ({
          evento: w.event_name,
          score: w.event_match_quality ? w.event_match_quality.composite_score : null,
          chaves: ((w.event_match_quality && w.event_match_quality.match_key_feedback) || [])
            .map(k => ({ id: k.identifier, pct: k.coverage ? k.coverage.percentage : null })),
        }));
        datasets.push({ id, label, eventos });
      } catch (e) {
        datasets.push({ id, label, erro: e.name === 'AbortError' ? 'timeout' : e.message });
      } finally { clearTimeout(to); }
    }
    res.json({ datasets, atualizadoEm: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Estágio mais fundo do funil que o lead realmente atingiu (status + datas-marco).
function eventoMaisFundoLead(lead) {
  if (lead.status === 'Fechou' || lead.data_fechamento) return 'Purchase';
  if (lead.data_comparecimento || lead.status === 'Compareceu') return 'Contact';
  if (lead.data_agendamento || lead.status === 'Avaliação agendada') return 'Schedule';
  if (lead.status === 'Em qualificação' || lead.status === 'Em negociação') return 'LeadQualified';
  return null;
}

// Backfill (one-off, admin): para cada lead CTWA, reenvia via cascata os eventos do
// funil que faltaram até o estágio real dele. Idempotente (cascata pula os já enviados).
// Objetivo: o lead_eventos passar a refletir o funil VERDADEIRO por conjunto.
let _capiBackfillEm = 0; // timestamp do início; 0 = parado. Auto-libera após 10min (anti-trava).
app.post('/api/admin/capi-saude/backfill-funil', requireAuth, requireAdmin, async (req, res) => {
  if (_capiBackfillEm && (Date.now() - _capiBackfillEm) < 10 * 60_000) {
    return res.json({ ok: true, running: true, msg: 'Backfill já em andamento (há ' + Math.round((Date.now() - _capiBackfillEm) / 1000) + 's)' });
  }
  _capiBackfillEm = Date.now();
  try {
    // CTWA NÃO importados (há ~15k CTWA importados históricos que encheriam o limite e
    // deixariam os reais de fora). Ordena por id desc (recentes primeiro). Seleção fina no .filter().
    const { data: leads, error } = await supabase.from('leads')
      .select('id, nome, telefone, email, status, valor, ctwa_clid, referral_data, wa_number_id, eventos_meta_enviados, data_agendamento, data_comparecimento, data_fechamento, importado_historico')
      .not('ctwa_clid', 'is', null)
      .not('importado_historico', 'is', true)
      .order('id', { ascending: false })
      .limit(2000);
    if (error) throw error;
    const alvos = (leads || []).filter(l => {
      if (l.importado_historico) return false;
      const alvo = eventoMaisFundoLead(l);
      if (!alvo) return false;
      const idx = FUNIL_ORDEM.indexOf(alvo);
      const ja = new Set(l.eventos_meta_enviados || []);
      return FUNIL_ORDEM.slice(1, idx + 1).some(e => !ja.has(e));
    });
    res.json({ ok: true, alvos: alvos.length, msg: alvos.length + ' lead(s) a preencher — rodando em background.' });
    (async () => {
      let proc = 0;
      for (const lead of alvos) {
        const alvo = eventoMaisFundoLead(lead);
        try { await dispararConversaoMeta(lead, alvo); proc++; }
        catch (e) { console.error('[capi-backfill] lead', lead.id, 'falhou:', e.message); }
        await new Promise(r => setTimeout(r, 120));
      }
      console.log('[capi-backfill] concluído:', proc, '/', alvos.length, 'leads preenchidos');
      _capiBackfillEm = 0;
    })().catch(e => { console.error('[capi-backfill] loop:', e.message); _capiBackfillEm = 0; });
  } catch (e) {
    _capiBackfillEm = 0;
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
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

function converterParaWav16k(buffer, inputFmt) {
  const { ffmpegArgsTo16kWav } = require('./lib/avaliacao/audio-format');
  return new Promise((resolve, reject) => {
    const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ffmpegArgsTo16kWav(inputFmt));
    const out = []; let err = '';
    ff.stdout.on('data', d => out.push(d));
    ff.stderr.on('data', d => { err += d.toString(); });
    ff.on('error', e => reject(new Error('ffmpeg indisponível: ' + e.message)));
    ff.on('close', code => code === 0
      ? resolve(Buffer.concat(out))
      : reject(new Error('ffmpeg falhou (' + code + '): ' + err.slice(0, 300))));
    ff.stdin.on('error', () => {}); // evita EPIPE se ffmpeg fechar cedo
    ff.stdin.write(buffer); ff.stdin.end();
  });
}

app.post('/api/avaliacoes/transcrever',
  requireAuth, requireDentista, requireModuloAtivo,
  express.raw({ type: '*/*', limit: '300mb' }),
  (req, res) => {
    const jobId = crypto.randomUUID();
    const { detectFormat, needsConversion } = require('./lib/avaliacao/audio-format');
    const buffer = req.body;
    const filename = req.headers['x-audio-filename'] || '';
    const rawCt = (req.headers['x-audio-content-type'] || req.headers['content-type'] || '').split(';')[0].trim();
    const fmt = detectFormat(rawCt, filename);

    console.log('[transcrever] upload recebido', JSON.stringify({ jobId, userId: req.user.id, rawCt, filename, fmt, bytes: buffer?.length ?? 0 }));

    if (!buffer || buffer.length === 0) {
      _transcribeJobs.set(jobId, { status: 'error', result: null, error: 'Arquivo vazio ou não recebido.', userId: req.user.id });
      return res.json({ jobId });
    }

    _transcribeJobs.set(jobId, { status: 'pending', result: null, error: null, userId: req.user.id });
    res.json({ jobId });

    (async () => {
      try {
        let bufFinal = buffer;
        let ctFinal = rawCt || 'audio/mpeg';
        if (needsConversion(fmt)) {
          console.log('[transcrever] convertendo', JSON.stringify({ jobId, fmt }));
          bufFinal = await converterParaWav16k(buffer, fmt);
          ctFinal = 'audio/wav';
        }
        const dgResult = await deepgramLib().transcribeBuffer(bufFinal, ctFinal);
        const words = dgResult?.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
        _transcribeJobs.set(jobId, { status: 'done', result: { words }, error: null, userId: req.user.id });
      } catch (e) {
        console.error('[transcrever] FALHA', JSON.stringify({ jobId, fmt, bytes: buffer?.length ?? 0, erro: e.message }));
        const amigavel = /ffmpeg/.test(e.message)
          ? 'Não consegui converter este áudio. Tente enviar em MP3 ou WAV.'
          : 'Falha ao transcrever o áudio: ' + e.message;
        _transcribeJobs.set(jobId, { status: 'error', result: null, error: amigavel, userId: req.user.id });
      }
    })();

    setTimeout(() => _transcribeJobs.delete(jobId), 15 * 60 * 1000);
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

// ── Mapeamento dentista CRM ↔ Dentist_PersonId Clinicorp ───────────────────
app.get('/api/avaliacoes/dentista-map', requireAuth, requireGestor, async (req, res) => {
  try {
    const [{ data: maps }, { data: dentistas }] = await Promise.all([
      supabase.from('dentista_clinicorp_map').select('dentista_id, clinicorp_person_id, nome, updated_at'),
      supabase.from('profiles').select('id, nome').filter('roles', 'cs', '{dentista}').order('nome'),
    ]);
    res.json({
      maps: maps || [],
      dentistas: dentistas || [],
      avaliadores_conhecidos: DENTISTAS_AVALIACAO, // ajuda o admin a escolher o id certo
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/avaliacoes/dentista-map/:dentista_id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { dentista_id } = req.params;
    if (!UUID_V4_RE.test(dentista_id)) return res.status(400).json({ error: 'dentista_id deve ser um UUID v4 válido' });
    const personId = parseInt(req.body?.clinicorp_person_id, 10);
    if (isNaN(personId) || personId <= 0) return res.status(400).json({ error: 'clinicorp_person_id deve ser um inteiro positivo' });
    const nome = req.body?.nome ? String(req.body.nome).slice(0, 120) : null;
    const { error } = await supabase.from('dentista_clinicorp_map').upsert({
      dentista_id, clinicorp_person_id: personId, nome,
      updated_at: new Date().toISOString(), updated_by: req.user.id,
    }, { onConflict: 'dentista_id' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/avaliacoes/dentista-map/:dentista_id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { dentista_id } = req.params;
    if (!UUID_V4_RE.test(dentista_id)) return res.status(400).json({ error: 'dentista_id deve ser um UUID v4 válido' });
    const { error } = await supabase.from('dentista_clinicorp_map').delete().eq('dentista_id', dentista_id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Agenda do dia do dentista (paciente presente) ──────────────────────────
app.get('/api/avaliacoes/agenda-hoje', requireAuth, requireDentista, requireModuloAtivo, rateLimit, async (req, res) => {
  try {
    const { parseAgendaDia } = require('./lib/avaliacao/agenda');
    const p = await loadProfile(req);
    const isGestor = (p.roles || []).some(r => ['gestor', 'admin'].includes(r));

    // dentista alvo: o próprio, ou ?dentista_id= quando gestor/admin sobe áudio por outro
    let alvoDentistaId = req.user.id;
    if (isGestor && req.query.dentista_id) {
      if (!UUID_V4_RE.test(req.query.dentista_id)) return res.status(400).json({ error: 'dentista_id inválido' });
      alvoDentistaId = req.query.dentista_id;
    }

    const { data: map } = await supabase.from('dentista_clinicorp_map')
      .select('clinicorp_person_id').eq('dentista_id', alvoDentistaId).maybeSingle();
    if (!map) return res.status(409).json({ error: 'sem_vinculo', mensagem: 'Dentista sem vínculo com o Clinicorp. Peça ao admin para configurar.' });

    // data: hoje em America/Sao_Paulo, ou ?data=YYYY-MM-DD (gestor sobe retroativo)
    let dia = req.query.data;
    if (dia) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return res.status(400).json({ error: 'data deve ser YYYY-MM-DD' });
    } else {
      dia = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); // UTC-3
    }
    const to = new Date(dia + 'T00:00:00Z'); to.setUTCDate(to.getUTCDate() + 1);
    const toStr = to.toISOString().slice(0, 10);

    const r = await clinicorpGet('/appointment/list', { from: dia, to: toStr });
    const appts = Array.isArray(r.data) ? r.data : (Array.isArray(r) ? r : []);
    const agenda = parseAgendaDia(appts, map.clinicorp_person_id, dia);
    res.json({ data: dia, agenda });
  } catch (e) {
    console.error('[agenda-hoje]', e);
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
      consentimento_manual_versao, consentimento_manual_em,
      clinicorp_appointment_id, clinicorp_patient_id, data_consulta } = req.body;

    if (!id || !paciente_nome || !modo || !started_at || !analysis)
      return res.status(400).json({ error: 'Campos obrigatórios: id, paciente_nome, modo, started_at, analysis' });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      return res.status(400).json({ error: 'id deve ser um UUID v4 válido' });
    // Gestor/admin pode salvar avaliação em nome de outro dentista (upload retroativo).
    // CRM single-tenant (sem clinic_id): o escopo é "ser um avaliador real do CRM".
    let dentistaIdFinal = req.user.id;
    if (req.body.dentista_id && req.body.dentista_id !== req.user.id) {
      const pp = await loadProfile(req);
      const isGestor = (pp.roles || []).some(r => ['gestor', 'admin'].includes(r));
      if (!isGestor)
        return res.status(403).json({ error: 'Sem permissão para salvar avaliação em nome de outro dentista' });
      if (!UUID_V4_RE.test(req.body.dentista_id))
        return res.status(400).json({ error: 'dentista_id inválido' });
      // Alvo precisa ser um avaliador real: perfil com role dentista OU vínculo Clinicorp.
      const [{ data: alvoProf }, { data: alvoMap }] = await Promise.all([
        supabase.from('profiles').select('roles').eq('id', req.body.dentista_id).maybeSingle(),
        supabase.from('dentista_clinicorp_map').select('dentista_id').eq('dentista_id', req.body.dentista_id).maybeSingle(),
      ]);
      const ehAvaliador = !!alvoMap || (alvoProf && (alvoProf.roles || []).some(r => ['dentista', 'admin', 'mod_avaliacao_dentista'].includes(r)));
      if (!ehAvaliador)
        return res.status(403).json({ error: 'dentista_id não é um avaliador válido' });
      dentistaIdFinal = req.body.dentista_id;
    }
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
      id, dentista_id: dentistaIdFinal,
      paciente_id: paciente_id || null,
      paciente_nome: String(paciente_nome).slice(0, 200),
      paciente_vinculado: !!paciente_vinculado,
      clinicorp_appointment_id: clinicorp_appointment_id ? String(clinicorp_appointment_id).slice(0, 64) : null,
      clinicorp_patient_id:     clinicorp_patient_id ? String(clinicorp_patient_id).slice(0, 64) : null,
      data_consulta:            (data_consulta && /^\d{4}-\d{2}-\d{2}$/.test(data_consulta)) ? data_consulta : null,
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
        .select('*').eq('id', id).eq('dentista_id', dentistaIdFinal).maybeSingle();
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
      .select('id, dentista_id, paciente_id, paciente_nome, paciente_vinculado, clinicorp_appointment_id, data_consulta, nota_final, modo, created_at, feedback_ia', { count: 'exact' })
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
    let rows = data || [];
    const dentistaIds = [...new Set(rows.map(r => r.dentista_id).filter(Boolean))];
    if (dentistaIds.length) {
      const { data: profs } = await supabase.from('profiles').select('id, nome').in('id', dentistaIds);
      const nomeBy = Object.fromEntries((profs || []).map(p => [p.id, p.nome]));
      rows = rows.map(r => ({
        ...r,
        dentista_nome: nomeBy[r.dentista_id] || null,
        orfa: !r.paciente_vinculado && !r.clinicorp_appointment_id && !r.data_consulta,
      }));
    }
    res.json({ data: rows, total: count || 0, limit, offset });
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

// Atribuição manual de avaliação órfã: dentista + paciente (nome) + data, num passo só.
app.patch('/api/avaliacoes/:id/atribuir', requireAuth, async (req, res) => {
  try {
    if (!UUID_V4_RE.test(req.params.id)) return res.status(400).json({ error: 'id deve ser um UUID v4 válido' });
    const p = await loadProfile(req);
    const isGestor = (p.roles || []).some(r => ['gestor', 'admin'].includes(r));
    if (!isGestor) return res.status(403).json({ error: 'Apenas gestor/admin pode atribuir' });

    const { data: consulta } = await supabase.from('consultas_spin').select('id').eq('id', req.params.id).maybeSingle();
    if (!consulta) return res.status(404).json({ error: 'Consulta não encontrada' });

    const patch = {};
    const { dentista_id, paciente_nome, data_consulta, clinicorp_patient_id, clinicorp_appointment_id } = req.body;
    if (dentista_id !== undefined) {
      if (!UUID_V4_RE.test(dentista_id)) return res.status(400).json({ error: 'dentista_id inválido' });
      patch.dentista_id = dentista_id;
    }
    if (paciente_nome !== undefined) {
      const nome = String(paciente_nome || '').trim().slice(0, 120);
      if (!nome) return res.status(400).json({ error: 'paciente_nome não pode ser vazio' });
      patch.paciente_nome = nome;
    }
    if (data_consulta !== undefined) {
      if (data_consulta && !/^\d{4}-\d{2}-\d{2}$/.test(data_consulta)) return res.status(400).json({ error: 'data_consulta deve ser YYYY-MM-DD' });
      patch.data_consulta = data_consulta || null;
    }
    if (clinicorp_patient_id !== undefined) patch.clinicorp_patient_id = clinicorp_patient_id ? String(clinicorp_patient_id).slice(0, 64) : null;
    if (clinicorp_appointment_id !== undefined) patch.clinicorp_appointment_id = clinicorp_appointment_id ? String(clinicorp_appointment_id).slice(0, 64) : null;

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    const { data, error } = await supabase.from('consultas_spin').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ ok: true, consulta: data });
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
      .select('id, lead_id, usuario_id, modulo, criada_em, tentativas_gravacao, profiles:usuario_id(threec_agent_id)')
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
        const agentOk = !agentId || String(c.agent_id) === String(agentId);
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
      if (novoPatch.gravacao_url && novoPatch.status === 'atendida') {
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

// Perfil 360º — dados do Clinicorp (financeiro, procedimentos, agendamentos) vinculados por telefone
app.get('/api/leads/:id/clinicorp', requireAuth, rateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data, error } = await supabase.rpc('perfil_clinicorp', { p_lead_id: id });
    if (error) throw error;
    res.json(data || { vinculado: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Busca de pacientes (Clinicorp) por nome/telefone/CPF; resolve lead_id por telefone
app.get('/api/pacientes/buscar', requireAuth, rateLimit, async (req, res) => {
  try {
    const q = (req.query.q || '').toString().slice(0, 80);
    const { data, error } = await supabase.rpc('buscar_pacientes', { p_q: q });
    if (error) throw error;
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 360º de um paciente direto (sem depender de lead) — para a busca de pacientes
app.get('/api/pacientes/:id/clinicorp', requireAuth, rateLimit, async (req, res) => {
  try {
    const pid = req.params.id;
    const { data, error } = await supabase.rpc('perfil_clinicorp_by_paciente', { p_paciente_id: pid });
    if (error) throw error;
    res.json(data || { vinculado: false });
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

// ===== AGENTE DE MARKETING =====
app.get('/api/marketing/campanhas', requireAuth, requireRole('admin', 'gestor'), rateLimit, async (req, res) => {
  try {
    const lente = req.query.lente === 'caixa' ? 'caixa' : 'safra';
    const _parseDate = (s) => { const d = new Date(s); if (isNaN(d.getTime())) throw Object.assign(new Error('Data inválida'), { status: 400 }); return d; };
    const periodo = parseInt(req.query.periodo, 10) || 30;
    const dDesde = req.query.desde ? _parseDate(req.query.desde) : new Date(Date.now() - periodo * 86400000);
    const dAte   = req.query.ate   ? _parseDate(req.query.ate)   : new Date();
    const ymd = d => d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

    const { data: cfgRow } = await supabase.from('marketing_config').select('*').eq('id', 1).maybeSingle();
    const cfg = cfgRow || { meta_roas: 3.0, gasto_minimo: 200, maturacao_dias: 21, cobertura_minima: 0.60 };

    const insights = {};
    // Gasto de anúncio exige ads_read — usa o token dedicado de ads quando houver
    // (mesmo padrão dos thumbnails), caindo para o token geral do CAPI.
    const TOKEN = process.env.META_ADS_TOKEN || process.env.META_ACCESS_TOKEN;
    if (TOKEN) {
      const timeRange = JSON.stringify({ since: ymd(dDesde), until: ymd(dAte) });
      const url = 'https://graph.facebook.com/' + META_API_VERSION + '/act_' + META_AD_ACCOUNT_ID +
        '/insights?level=ad&fields=ad_id,ad_name,campaign_name,spend&time_range=' + encodeURIComponent(timeRange) + '&limit=500';
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 25000);
      try {
        const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + TOKEN }, signal: ctrl.signal });
        const j = await r.json();
        (j.data || []).forEach(row => { insights[row.ad_id] = { ad_name: row.ad_name, campaign_name: row.campaign_name || '(sem nome)', spend: parseFloat(row.spend) || 0 }; });
      } catch (_) { /* segue sem gasto */ } finally { clearTimeout(to); }
    }

    const { data: rpc, error } = await supabase.rpc('marketing_campanhas', { p_desde: ymd(dDesde), p_ate: ymd(dAte), p_lente: lente });
    if (error) throw new Error(error.message);
    const receita = {};
    (rpc || []).forEach(row => { receita[row.ad_id] = row; });

    const adIds = new Set([...Object.keys(insights), ...Object.keys(receita)]);
    const camps = {};
    for (const adId of adIds) {
      const i = insights[adId] || { ad_name: '(anúncio fora do período)', campaign_name: '(sem campanha Meta)', spend: 0 };
      const r = receita[adId] || { leads_total: 0, leads_casados: 0, incertos: 0, faturamento: 0, total_contratado: 0, caixa: 0, lead_recente: null };
      const nome = i.campaign_name;
      if (!camps[nome]) camps[nome] = { campanha: nome, spend: 0, leads_total: 0, leads_casados: 0, incertos: 0, faturamento: 0, total_contratado: 0, caixa: 0, lead_recente: null, anuncios: [] };
      const c = camps[nome];
      c.spend += i.spend; c.leads_total += r.leads_total; c.leads_casados += r.leads_casados;
      c.incertos += r.incertos; c.faturamento += Number(r.faturamento) || 0;
      c.total_contratado += Number(r.total_contratado) || 0; c.caixa += Number(r.caixa) || 0;
      if (r.lead_recente && (!c.lead_recente || r.lead_recente > c.lead_recente)) c.lead_recente = r.lead_recente;
      c.anuncios.push({ ad_id: adId, ad_name: i.ad_name, spend: i.spend, ...r });
    }

    const hoje = Date.now();
    const campanhas = Object.values(camps).map(c => {
      const receitaLente = lente === 'caixa' ? c.caixa : c.faturamento;
      c.roas = c.spend > 0 ? receitaLente / c.spend : null;
      c.cobertura = c.leads_total > 0 ? c.leads_casados / c.leads_total : null;
      const diasRecente = c.lead_recente ? (hoje - new Date(c.lead_recente).getTime()) / 86400000 : 9999;
      if (lente === 'caixa') {
        c.selo = 'caixa';
      } else if (c.leads_casados === 0 || c.cobertura === null || c.cobertura < Number(cfg.cobertura_minima)) {
        c.selo = 'cobertura_baixa';
      } else if (diasRecente < Number(cfg.maturacao_dias)) {
        c.selo = 'observar';
      } else if (c.spend < Number(cfg.gasto_minimo)) {
        c.selo = 'observar';
      } else if (c.roas !== null && c.roas >= Number(cfg.meta_roas)) {
        c.selo = 'escalar';
      } else if (c.roas !== null) {
        c.selo = 'cortar';
      } else {
        c.selo = 'observar';
      }
      return c;
    }).filter(c => c.spend > 0 || c.leads_total > 0 || c.caixa > 0)
      .sort((a, b) => (lente === 'caixa' ? b.caixa - a.caixa : b.spend - a.spend));

    const totais = campanhas.reduce((t, c) => {
      t.spend += c.spend; t.leads_total += c.leads_total; t.leads_casados += c.leads_casados;
      t.faturamento += c.faturamento; t.caixa += c.caixa; return t;
    }, { spend: 0, leads_total: 0, leads_casados: 0, faturamento: 0, caixa: 0 });
    totais.cobertura = totais.leads_total > 0 ? totais.leads_casados / totais.leads_total : null;
    totais.roas = totais.spend > 0 ? (lente === 'caixa' ? totais.caixa : totais.faturamento) / totais.spend : null;

    res.json({ campanhas, totais, lente, cfg, desde: ymd(dDesde), ate: ymd(dAte), sem_token: !TOKEN });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/marketing/drill/leads', requireAuth, requireRole('admin', 'gestor'), rateLimit, async (req, res) => {
  try {
    const adIds = String(req.query.ad_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!adIds.length) return res.json({ leads: [] });
    const lente = req.query.lente === 'caixa' ? 'caixa' : 'safra';
    const ymd = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const desde = req.query.desde ? ymd(req.query.desde) : ymd(Date.now() - 30 * 86400000);
    const ate = req.query.ate ? ymd(req.query.ate) : ymd(Date.now());
    const { data, error } = await supabase.rpc('marketing_drill_leads', { p_ad_ids: adIds, p_desde: desde, p_ate: ate, p_lente: lente });
    if (error) throw new Error(error.message);
    res.json({ leads: data || [] });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/marketing/drill/paciente', requireAuth, requireRole('admin', 'gestor'), rateLimit, async (req, res) => {
  try {
    const leadId = parseInt(req.query.lead_id, 10);
    if (!leadId) return res.status(400).json({ error: 'lead_id obrigatório' });
    const { data, error } = await supabase.rpc('marketing_drill_paciente', { p_lead_id: leadId });
    if (error) throw new Error(error.message);
    res.json(data || { vinculado: false });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/marketing/qualidade-lead', requireAuth, requireRole('admin', 'gestor'), rateLimit, async (req, res) => {
  try {
    const _parseDate = (s) => { const d = new Date(s); if (isNaN(d.getTime())) throw Object.assign(new Error('Data inválida'), { status: 400 }); return d; };
    const periodo = parseInt(req.query.periodo, 10) || 30;
    const dDesde = req.query.desde ? _parseDate(req.query.desde) : new Date(Date.now() - periodo * 86400000);
    const dAte   = req.query.ate   ? _parseDate(req.query.ate)   : new Date();
    const ymd = d => d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

    const { data: rpc, error } = await supabase.rpc('marketing_qualidade_lead', { p_desde: ymd(dDesde), p_ate: ymd(dAte) });
    if (error) throw new Error(error.message);

    // leads.campanha guarda o ID do ANÚNCIO (CTWA), não da campanha. Resolvemos cada
    // ad_id -> { ad_name, campaign_id, campaign_name } em lote via Graph ?ids= (até 50 por
    // chamada; resolve por id, então funciona mesmo p/ anúncio de outra conta) e
    // re-agregamos por campanha real.
    const TOKEN = process.env.META_ADS_TOKEN || process.env.META_ACCESS_TOKEN;
    const semToken = !TOKEN;
    const adInfo = {}; // ad_id -> { ad_name, campaign_id, campaign_name }
    const adIds = (rpc || []).map(r => r.campanha_id).filter(id => id != null);
    if (TOKEN && adIds.length) {
      for (let i = 0; i < adIds.length; i += 50) {
        const chunk = adIds.slice(i, i + 50);
        const url = 'https://graph.facebook.com/' + META_API_VERSION +
          '/?ids=' + encodeURIComponent(chunk.join(',')) + '&fields=id,name,campaign{id,name}';
        const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 25000);
        try {
          const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + TOKEN }, signal: ctrl.signal });
          const j = await r.json();
          Object.keys(j || {}).forEach(id => {
            const o = j[id]; if (!o || o.error) return;
            adInfo[id] = { ad_name: o.name || id, campaign_id: o.campaign && o.campaign.id, campaign_name: o.campaign && o.campaign.name };
          });
        } catch (_) { /* segue com o que tiver resolvido */ } finally { clearTimeout(to); }
      }
    }

    const mergeStatus = (dst, src) => { Object.keys(src || {}).forEach(k => { dst[k] = (dst[k] || 0) + Number(src[k] || 0); }); };
    const campMap = {};
    let semCampanha = { total: 0, por_status: {} };
    (rpc || []).forEach(row => {
      if (row.campanha_id == null) { semCampanha = { total: Number(row.total) || 0, por_status: row.por_status || {} }; return; }
      const adId = row.campanha_id;
      const info = adInfo[adId] || {};
      // Sem campanha resolvida → agrupa o anúncio como sua própria pseudo-campanha,
      // rotulada pelo nome do anúncio (se houver) ou pelo ID cru.
      const campId = info.campaign_id || ('ad:' + adId);
      const campNome = info.campaign_name || info.ad_name || adId;
      if (!campMap[campId]) campMap[campId] = { campanha_id: campId, campanha_nome: campNome, resolvido: !!info.campaign_name, total: 0, por_status: {}, anuncios: [] };
      const c = campMap[campId];
      c.total += Number(row.total) || 0;
      mergeStatus(c.por_status, row.por_status);
      c.anuncios.push({ ad_id: adId, ad_name: info.ad_name || adId, total: Number(row.total) || 0, por_status: row.por_status || {} });
    });
    const campanhas = Object.values(campMap).sort((a, b) => b.total - a.total);
    campanhas.forEach(c => c.anuncios.sort((a, b) => b.total - a.total));

    res.json({
      desde: ymd(dDesde), ate: ymd(dAte), sem_token: semToken,
      metricas: MKT_METRICAS.map(m => ({ key: m.key, label: m.label, status: m.status, tom: m.tom })),
      campanhas, sem_campanha: semCampanha,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/marketing/qualidade-lead/drill', requireAuth, requireRole('admin', 'gestor'), rateLimit, async (req, res) => {
  try {
    const _parseDate = (s) => { const d = new Date(s); if (isNaN(d.getTime())) throw Object.assign(new Error('Data inválida'), { status: 400 }); return d; };
    const periodo = parseInt(req.query.periodo, 10) || 30;
    const dDesde = req.query.desde ? _parseDate(req.query.desde) : new Date(Date.now() - periodo * 86400000);
    const dAte   = req.query.ate   ? _parseDate(req.query.ate)   : new Date();
    const ymd = d => d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

    // metrica vinda do cliente é validada contra a lista conhecida (nunca status cru no filtro).
    const metrica = mktMetricaPorKey(String(req.query.metrica || 'sem_interesse'));
    const campId = String(req.query.campanha_id || '');
    // ad_ids = conjunto de anúncios de uma campanha (drill por campanha). leads.campanha guarda o ad_id.
    const adIds = String(req.query.ad_ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 300);

    let q = supabase.from('leads')
      .select('id, nome, status, criado_em')
      .in('status', metrica.status)
      .gte('criado_em', ymd(dDesde) + 'T00:00:00-03:00')
      .lt('criado_em', ymd(new Date(dAte.getTime() + 86400000)) + 'T00:00:00-03:00')
      .order('criado_em', { ascending: false })
      .limit(200);
    if (campId === '__none__') q = q.or('campanha.is.null,campanha.eq.');
    else if (adIds.length) q = q.in('campanha', adIds);
    else q = q.eq('campanha', campId);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ leads: (data || []).map(l => ({ lead_id: l.id, nome: l.nome, status: l.status, criado_em: l.criado_em })) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Visão unificada por campanha: funde gasto Meta + receita Clinicorp + funil de leads.
// Tudo casa por campanha real (leads.campanha = ad_id → campanha via Graph).
app.get('/api/marketing/visao-geral', requireAuth, requireRole('admin', 'gestor'), rateLimit, async (req, res) => {
  try {
    const _parseDate = (s) => { const d = new Date(s); if (isNaN(d.getTime())) throw Object.assign(new Error('Data inválida'), { status: 400 }); return d; };
    const periodo = parseInt(req.query.periodo, 10) || 30;
    const dDesde = req.query.desde ? _parseDate(req.query.desde) : new Date(Date.now() - periodo * 86400000);
    const dAte   = req.query.ate   ? _parseDate(req.query.ate)   : new Date();
    const ymd = d => d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const TOKEN = process.env.META_ADS_TOKEN || process.env.META_ACCESS_TOKEN;
    const semToken = !TOKEN;

    // 1. Insights por anúncio: gasto + mapa ad_id → campanha (id/nome).
    const adInfo = {}; // ad_id -> { ad_name, campaign_id, campaign_name, spend }
    if (TOKEN) {
      const timeRange = JSON.stringify({ since: ymd(dDesde), until: ymd(dAte) });
      const url = 'https://graph.facebook.com/' + META_API_VERSION + '/act_' + META_AD_ACCOUNT_ID +
        '/insights?level=ad&fields=ad_id,ad_name,campaign_id,campaign_name,spend&time_range=' + encodeURIComponent(timeRange) + '&limit=500';
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 25000);
      try {
        const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + TOKEN }, signal: ctrl.signal });
        const j = await r.json();
        (j.data || []).forEach(row => { adInfo[row.ad_id] = { ad_name: row.ad_name, campaign_id: row.campaign_id, campaign_name: row.campaign_name, spend: parseFloat(row.spend) || 0 }; });
      } catch (_) { /* segue sem gasto */ } finally { clearTimeout(to); }
    }

    // 2. Receita por anúncio (faturamento + caixa).
    const { data: rpcRev, error: eRev } = await supabase.rpc('marketing_campanhas', { p_desde: ymd(dDesde), p_ate: ymd(dAte), p_lente: 'safra' });
    if (eRev) throw new Error(eRev.message);
    const receita = {};
    (rpcRev || []).forEach(r => { receita[r.ad_id] = r; });

    // 3. Funil por anúncio (status). campanha_id null = balde sem anúncio.
    const { data: rpcQ, error: eQ } = await supabase.rpc('marketing_qualidade_lead', { p_desde: ymd(dDesde), p_ate: ymd(dAte) });
    if (eQ) throw new Error(eQ.message);
    const quali = {};
    let semCampanha = { total: 0, por_status: {} };
    (rpcQ || []).forEach(r => { if (r.campanha_id == null) semCampanha = { total: Number(r.total) || 0, por_status: r.por_status || {} }; else quali[r.campanha_id] = r; });

    // 3b. Região por DDD do telefone (31=local, 33=regional, resto=fora) por anúncio.
    const { data: rpcD, error: eD } = await supabase.rpc('marketing_ddd_regiao', { p_desde: ymd(dDesde), p_ate: ymd(dAte) });
    if (eD) throw new Error(eD.message);
    const dddZero = () => ({ local: 0, regional: 0, fora: 0, nd: 0 });
    const dddMap = {};
    let semCampanhaDdd = dddZero();
    (rpcD || []).forEach(r => {
      const o = { local: Number(r.ddd_local) || 0, regional: Number(r.ddd_regional) || 0, fora: Number(r.ddd_fora) || 0, nd: Number(r.ddd_nd) || 0 };
      if (r.campanha_id == null) semCampanhaDdd = o; else dddMap[r.campanha_id] = o;
    });
    semCampanha.ddd = semCampanhaDdd;

    // 4. Resolve ad→campanha p/ anúncios que têm lead/receita mas não vieram nos insights
    // (sem entrega no período) via Graph ?ids= (lote de 50; resolve por id).
    const conhecidos = new Set(Object.keys(adInfo));
    const faltam = [...new Set([...Object.keys(receita), ...Object.keys(quali)])].filter(id => !conhecidos.has(id));
    if (TOKEN && faltam.length) {
      for (let i = 0; i < faltam.length; i += 50) {
        const chunk = faltam.slice(i, i + 50);
        const url = 'https://graph.facebook.com/' + META_API_VERSION + '/?ids=' + encodeURIComponent(chunk.join(',')) + '&fields=id,name,campaign{id,name}';
        const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 25000);
        try {
          const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + TOKEN }, signal: ctrl.signal });
          const j = await r.json();
          Object.keys(j || {}).forEach(id => { const o = j[id]; if (!o || o.error) return; adInfo[id] = { ad_name: o.name || id, campaign_id: o.campaign && o.campaign.id, campaign_name: o.campaign && o.campaign.name, spend: 0 }; });
        } catch (_) { /* segue */ } finally { clearTimeout(to); }
      }
    }

    // 5. Agrega tudo por campanha.
    const mergeStatus = (dst, src) => { Object.keys(src || {}).forEach(k => { dst[k] = (dst[k] || 0) + Number(src[k] || 0); }); };
    const campMap = {};
    const allAdIds = new Set([...Object.keys(adInfo), ...Object.keys(receita), ...Object.keys(quali)]);
    allAdIds.forEach(adId => {
      const info = adInfo[adId] || {}, rev = receita[adId] || {}, q = quali[adId] || { total: 0, por_status: {} };
      const dd = dddMap[adId] || dddZero();
      const campId = info.campaign_id || ('ad:' + adId);
      const campNome = info.campaign_name || info.ad_name || adId;
      if (!campMap[campId]) campMap[campId] = { campanha_id: campId, campanha_nome: campNome, resolvido: !!info.campaign_name, spend: 0, faturamento: 0, caixa: 0, total: 0, por_status: {}, ddd: dddZero(), anuncios: [] };
      const c = campMap[campId];
      c.spend += info.spend || 0;
      c.faturamento += Number(rev.faturamento) || 0;
      c.caixa += Number(rev.caixa) || 0;
      c.total += Number(q.total) || 0;
      mergeStatus(c.por_status, q.por_status);
      c.ddd.local += dd.local; c.ddd.regional += dd.regional; c.ddd.fora += dd.fora; c.ddd.nd += dd.nd;
      c.anuncios.push({ ad_id: adId, ad_name: info.ad_name || adId, spend: info.spend || 0, faturamento: Number(rev.faturamento) || 0, caixa: Number(rev.caixa) || 0, total: Number(q.total) || 0, por_status: q.por_status || {}, ddd: dd });
    });
    const campanhas = Object.values(campMap)
      .map(c => { c.roas = c.spend > 0 ? c.faturamento / c.spend : null; return c; })
      .filter(c => c.spend > 0 || c.total > 0 || c.faturamento > 0 || c.caixa > 0)
      .sort((a, b) => b.total - a.total);
    campanhas.forEach(c => c.anuncios.sort((a, b) => b.total - a.total));

    res.json({
      desde: ymd(dDesde), ate: ymd(dAte), sem_token: semToken,
      metricas: MKT_METRICAS.map(m => ({ key: m.key, label: m.label, status: m.status, tom: m.tom })),
      campanhas, sem_campanha: semCampanha,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/marketing/config', requireAuth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const { data, error } = await supabase.from('marketing_config').select('*').eq('id', 1).maybeSingle();
    if (error) throw new Error(error.message);
    res.json(data || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/marketing/config', requireAuth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const b = req.body || {};
    const patch = { id: 1, atualizado_em: new Date().toISOString() };
    for (const k of ['meta_roas', 'gasto_minimo', 'maturacao_dias', 'cobertura_minima']) {
      if (b[k] != null && !isNaN(Number(b[k]))) patch[k] = Number(b[k]);
    }
    const { error } = await supabase.from('marketing_config').upsert(patch, { onConflict: 'id' });
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
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
      '?fields=name,campaign{name},adset{name},creative{thumbnail_url,image_url}';
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + TOKEN } });
    const json = await r.json();
    if (json.error) {
      const data = { thumbnail_url: null, nome: null, campanha_nome: null, adset_nome: null, indisponivel: true };
      _thumbCache.set(adId, { data, exp: Date.now() + 3600000 }); // 1h em erro
      return res.json(data);
    }
    const thumb = json.creative?.image_url || json.creative?.thumbnail_url || null;
    const data = { thumbnail_url: thumb, nome: json.name || null,
      campanha_nome: json.campaign?.name || null, adset_nome: json.adset?.name || null };
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
    // Modo leve p/ o poll do sino (a cada 60s): retorna só a contagem de não
    // lidas via count (head:true, sem trazer linhas) → egress ~zero. Antes
    // baixava 50 notificações inteiras só p/ mostrar o número da bolinha.
    if (req.query.badge) {
      const { count } = await supabase.from('notificacoes')
        .select('id', { count: 'exact', head: true })
        .eq('usuario_id', req.user.id).eq('lida', false);
      return res.json({ nao_lidas: count || 0 });
    }
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

// ===================== CENTRAL DE TAREFAS =====================
const { gerarTarefasDoDia } = require('./lib/tarefas/geracao');

function hojeISO() {
  // nowLocal() devolve STRING "YYYY-MM-DD HH:MM:SS" no fuso de Brasília (server.js:126)
  return nowLocal().slice(0, 10);
}

function repoTarefas() {
  return {
    async templatesDoUsuario(userId, roles) {
      const orParts = [`and(escopo.eq.pessoal,owner_id.eq.${userId})`];
      if (roles.length) orParts.push(`and(escopo.eq.role,role.in.(${roles.join(',')}))`);
      const { data: byRoleOrPersonal } = await supabase.from('task_templates')
        .select('*').eq('ativo', true).or(orParts.join(','));
      const { data: byUsuarios } = await supabase.from('task_templates')
        .select('*').eq('ativo', true).eq('escopo', 'usuarios')
        .filter('assignee_ids', 'cs', JSON.stringify([userId]));
      return [...(byRoleOrPersonal || []), ...(byUsuarios || [])];
    },
    async taskExisteNoDia(templateId, userId, dataRef) {
      const { count } = await supabase.from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('template_id', templateId).eq('assignee_id', userId).eq('data_ref', dataRef);
      return (count || 0) > 0;
    },
    async taskAbertaDoTemplate(templateId, userId) {
      const { count } = await supabase.from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('template_id', templateId).eq('assignee_id', userId).eq('status', 'pendente');
      return (count || 0) > 0;
    },
    async coletaCardExiste(templateId, userId, dataRef, periodo) {
      const { count } = await supabase.from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('template_id', templateId).eq('assignee_id', userId)
        .eq('data_ref', dataRef).eq('periodo', periodo);
      return (count || 0) > 0;
    },
    async inserir(task) { await supabase.from('tasks').insert(task); },
  };
}

// GET /api/tarefas?data=hoje  → gera sob demanda + retorna tarefas do dia, marca visto_em
app.get('/api/tarefas', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = await loadProfile(req);
    const roles = profile.roles || [];
    const hoje = hojeISO();
    try { await gerarTarefasDoDia(repoTarefas(), userId, roles, hoje); }
    catch (e) { console.error('[tarefas] geracao on-demand', e.message); }

    const { data, error } = await supabase.from('tasks')
      .select('*')
      .eq('assignee_id', userId)
      .or(`data_ref.eq.${hoje},and(status.eq.pendente,data_ref.lt.${hoje})`)
      .order('data_ref', { ascending: true });
    if (error) throw error;

    const naoVistas = (data || []).filter(t => t.status === 'pendente' && !t.visto_em).map(t => t.id);
    if (naoVistas.length) {
      await supabase.from('tasks').update({ visto_em: new Date().toISOString() }).in('id', naoVistas);
    }
    res.json({ tarefas: data || [], hoje });
  } catch (e) {
    console.error('[GET /api/tarefas]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tarefas  → cria tarefa(s) pontual(is). assignee_ids[] permite fan-out.
app.post('/api/tarefas', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = await loadProfile(req);
    const isGestor = (profile.roles || []).some(r => r === 'admin' || r === 'gestor');
    const b = req.body || {};
    if (!b.titulo || !String(b.titulo).trim()) return res.status(400).json({ error: 'titulo obrigatório' });

    let assignees = Array.isArray(b.assignee_ids) && b.assignee_ids.length ? b.assignee_ids : [userId];
    const paraTerceiros = assignees.some(a => a !== userId);
    if (paraTerceiros && !isGestor) return res.status(403).json({ error: 'Sem permissão para atribuir a outros' });

    const base = {
      titulo: String(b.titulo).trim(),
      descricao: b.descricao || null,
      tipo: 'pontual',
      template_id: null,
      data_ref: b.data_ref || hojeISO(),
      created_by: userId,
      prioridade: ['alta','normal','baixa'].includes(b.prioridade) ? b.prioridade : 'normal',
      categoria: b.categoria || null,
      tipo_resultado: b.tipo_resultado === 'numero' ? 'numero' : 'check',
      unidade: b.unidade || null,
      meta: b.meta ?? null,
      prazo: b.prazo || null,
      lead_id: b.lead_id || null,
      paciente_clinicorp_id: b.paciente_clinicorp_id || null,
      arrasta: !!b.arrasta,
      status: 'pendente',
    };
    const rows = assignees.map(a => ({ ...base, assignee_id: a }));
    const { data, error } = await supabase.from('tasks').insert(rows).select();
    if (error) throw error;

    for (const t of data) {
      if (t.assignee_id !== userId) {
        await criarNotificacao(t.assignee_id, 'tarefa_atribuida', 'Nova tarefa', t.titulo, { url: '/tarefas/', task_id: t.id });
      }
    }
    res.json({ tarefas: data });
  } catch (e) {
    console.error('[POST /api/tarefas]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET templates: pessoais do usuário + de role
app.get('/api/tarefas/templates', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = await loadProfile(req);
    const roles = profile.roles || [];
    const isGestor = roles.some(r => r === 'admin' || r === 'gestor');

    if (req.query.gestao === '1' && isGestor) {
      const { data, error } = await supabase.from('task_templates')
        .select('*').eq('ativo', true)
        .in('escopo', ['role', 'usuarios'])
        .order('created_at');
      if (error) throw error;
      return res.json({ templates: data || [] });
    }

    const orParts = [`and(escopo.eq.pessoal,owner_id.eq.${userId})`];
    if (roles.length) orParts.push(`and(escopo.eq.role,role.in.(${roles.join(',')}))`);
    const { data, error } = await supabase.from('task_templates')
      .select('*').or(orParts.join(',')).order('created_at');
    if (error) throw error;
    res.json({ templates: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST template: role/usuarios => só gestor/admin; pessoal => qualquer um (owner = ele)
app.post('/api/tarefas/templates', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = await loadProfile(req);
    const isGestor = (profile.roles || []).some(r => r === 'admin' || r === 'gestor');
    const b = req.body || {};
    if (!b.titulo) return res.status(400).json({ error: 'titulo obrigatório' });
    const escopo = ['role', 'usuarios'].includes(b.escopo) ? b.escopo : 'pessoal';
    if (escopo !== 'pessoal' && !isGestor)
      return res.status(403).json({ error: 'Só gestor/admin cria rotina por cargo ou usuários' });
    if (b.tipo === 'coleta') {
      if (!Array.isArray(b.metricas) || b.metricas.length === 0)
        return res.status(400).json({ error: 'Coleta precisa de ao menos um campo' });
      if (!Array.isArray(b.periodos) || b.periodos.length === 0)
        return res.status(400).json({ error: 'Coleta precisa de ao menos um período' });
    }
    const tipo = b.tipo === 'coleta' ? 'coleta' : 'tarefa';
    const row = {
      titulo: b.titulo, descricao: b.descricao || null, escopo,
      role:         escopo === 'role'     ? b.role         : null,
      owner_id:     escopo === 'pessoal'  ? userId         : null,
      assignee_ids: escopo === 'usuarios' ? (b.assignee_ids || null) : null,
      frequencia: ['diaria','semanal','mensal'].includes(b.frequencia) ? b.frequencia : 'diaria',
      dias_semana: b.dias_semana || null, dia_mes: b.dia_mes || null,
      hora_sugerida: b.hora_sugerida || null,
      prioridade: ['alta','normal','baixa'].includes(b.prioridade) ? b.prioridade : 'normal',
      categoria: b.categoria || null,
      tipo_resultado: b.tipo_resultado === 'numero' ? 'numero' : 'check',
      unidade: b.unidade || null, meta: b.meta ?? null,
      tipo,
      arrasta: !!b.arrasta, created_by: userId,
      metricas:   tipo === 'coleta' ? (Array.isArray(b.metricas)   ? b.metricas   : []) : null,
      conversoes: tipo === 'coleta' ? (Array.isArray(b.conversoes) ? b.conversoes : []) : null,
      periodos:   tipo === 'coleta' ? (Array.isArray(b.periodos)   ? b.periodos   : []) : null,
      ver_proprio: tipo === 'coleta' ? !!b.ver_proprio : false,
    };
    const { data, error } = await supabase.from('task_templates').insert(row).select().single();
    if (error) throw error;
    res.json({ template: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH template: dono (pessoal) ou gestor/admin (role)
app.patch('/api/tarefas/templates/:id', requireAuth, async (req, res) => {
  try {
    const profile = await loadProfile(req);
    const isGestor = (profile.roles || []).some(r => r === 'admin' || r === 'gestor');
    const { data: tpl } = await supabase.from('task_templates').select('*').eq('id', req.params.id).maybeSingle();
    if (!tpl) return res.status(404).json({ error: 'Molde não encontrado' });
    const podeEditar = (tpl.escopo === 'pessoal' && tpl.owner_id === req.user.id) ||
                       ((tpl.escopo === 'role' || tpl.escopo === 'usuarios') && isGestor);
    if (!podeEditar) return res.status(403).json({ error: 'Sem permissão' });
    const patch = {};
    for (const k of ['titulo','descricao','frequencia','dias_semana','dia_mes','hora_sugerida','prioridade','categoria','tipo_resultado','unidade','meta','arrasta','ativo','metricas','conversoes','periodos','ver_proprio']) {
      if (k in req.body) patch[k] = req.body[k];
    }
    const { data, error } = await supabase.from('task_templates').update(patch).eq('id', tpl.id).select().single();
    if (error) throw error;
    res.json({ template: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE template: mesmas regras do PATCH + fechar_instancias opcional
app.delete('/api/tarefas/templates/:id', requireAuth, async (req, res) => {
  try {
    const profile = await loadProfile(req);
    const isGestor = (profile.roles || []).some(r => r === 'admin' || r === 'gestor');
    const { data: tpl } = await supabase.from('task_templates').select('*').eq('id', req.params.id).maybeSingle();
    if (!tpl) return res.status(404).json({ error: 'Molde não encontrado' });
    const pode = (tpl.escopo === 'pessoal' && tpl.owner_id === req.user.id) ||
                 ((tpl.escopo === 'role' || tpl.escopo === 'usuarios') && isGestor);
    if (!pode) return res.status(403).json({ error: 'Sem permissão' });
    if (req.body && req.body.fechar_instancias) {
      await supabase.from('tasks').delete()
        .eq('template_id', tpl.id)
        .eq('status', 'pendente');
    }
    const { error } = await supabase.from('task_templates').delete().eq('id', tpl.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/tarefas/historico?de=YYYY-MM-DD&ate=YYYY-MM-DD  → histórico do próprio usuário
app.get('/api/tarefas/historico', requireAuth, async (req, res) => {
  try {
    const de = req.query.de || hojeISO();
    const ate = req.query.ate || hojeISO();
    const { data, error } = await supabase.from('tasks')
      .select('*').eq('assignee_id', req.user.id)
      .gte('data_ref', de).lte('data_ref', ate)
      .order('data_ref', { ascending: false });
    if (error) throw error;
    res.json({ tarefas: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const requireTarefasGestao = requireRole('admin', 'gestor');

// GET /api/tarefas/gestao?de=&ate=&pessoa=&categoria=  → painel da equipe + histórico filtrado
app.get('/api/tarefas/gestao', requireAuth, requireTarefasGestao, async (req, res) => {
  try {
    const de = req.query.de || hojeISO();
    const ate = req.query.ate || hojeISO();
    let q = supabase.from('tasks').select('*').gte('data_ref', de).lte('data_ref', ate);
    if (req.query.pessoa) q = q.eq('assignee_id', req.query.pessoa);
    if (req.query.categoria) q = q.eq('categoria', req.query.categoria);
    const { data: tarefas, error } = await q.order('data_ref', { ascending: false });
    if (error) throw error;

    const porPessoa = {};
    for (const t of (tarefas || [])) {
      const p = porPessoa[t.assignee_id] || (porPessoa[t.assignee_id] = { total: 0, concluidas: 0, atrasadas: 0, soma_valor: 0, n_valor: 0 });
      p.total++;
      if (t.status === 'concluida') p.concluidas++;
      if (t.status === 'pendente' && t.data_ref < hojeISO()) p.atrasadas++;
      if (t.tipo_resultado === 'numero' && t.valor_resultado != null) { p.soma_valor += Number(t.valor_resultado); p.n_valor++; }
    }
    res.json({ tarefas: tarefas || [], resumo: porPessoa });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/tarefas/pessoas → lista de perfis ativos (para atribuir e mapear nomes no painel)
app.get('/api/tarefas/pessoas', requireAuth, requireTarefasGestao, async (req, res) => {
  try {
    const { data, error } = await supabase.from('profiles')
      .select('id, nome, roles').eq('ativo', true).order('nome');
    if (error) throw error;
    res.json({ pessoas: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/coletas/:templateId/dashboard?de=&ate=&pessoa=&gran=
app.get('/api/coletas/:templateId/dashboard', requireAuth, async (req, res) => {
  try {
    const profile = await loadProfile(req);
    const roles = profile.roles || [];
    const isGestor = roles.some(r => r === 'admin' || r === 'gestor');
    const { data: tpl } = await supabase.from('task_templates')
      .select('*').eq('id', req.params.templateId).maybeSingle();
    if (!tpl || tpl.tipo !== 'coleta') return res.status(404).json({ error: 'Coleta não encontrada' });

    const pessoa = req.query.pessoa || null;
    if (!isGestor) {
      if (!tpl.ver_proprio || pessoa !== req.user.id)
        return res.status(403).json({ error: 'Sem permissão' });
    }

    const de = req.query.de || hojeISO();
    const ate = req.query.ate || hojeISO();
    const gran = req.query.gran === 'semana' ? 'semana' : 'dia';

    const { somarLista, calcularConversoes } = require('./lib/tarefas/agregacao');

    const totaisRpc = await supabase.rpc('coleta_totais',
      { p_template_id: tpl.id, p_de: de, p_ate: ate, p_pessoa: pessoa });
    const somas = somarLista(totaisRpc.data || []);
    const conversoes = calcularConversoes(somas, tpl.conversoes || []);

    const serieRpc = await supabase.rpc('coleta_serie',
      { p_template_id: tpl.id, p_de: de, p_ate: ate, p_pessoa: pessoa, p_gran: gran });

    const payload = {
      template: { id: tpl.id, titulo: tpl.titulo, metricas: tpl.metricas || [], conversoes: tpl.conversoes || [], ver_proprio: tpl.ver_proprio },
      somas, conversoes,
      serie: serieRpc.data || [],
    };

    // por_pessoa expõe os números de toda a equipe — só para gestor/admin.
    if (isGestor) {
      const porPessoaRpc = await supabase.rpc('coleta_por_pessoa',
        { p_template_id: tpl.id, p_de: de, p_ate: ate });
      const porPessoa = {};
      for (const r of (porPessoaRpc.data || [])) {
        (porPessoa[r.assignee_id] || (porPessoa[r.assignee_id] = {}))[r.chave] = Number(r.total) || 0;
      }
      payload.por_pessoa = porPessoa;
    }

    res.json(payload);
  } catch (e) {
    console.error('[GET /api/coletas/:id/dashboard]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tarefas/:id  → concluir (com valor_resultado se numero), reabrir, editar
app.patch('/api/tarefas/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const profile = await loadProfile(req);
    const isGestor = (profile.roles || []).some(r => r === 'admin' || r === 'gestor');
    const { data: tarefa, error: e0 } = await supabase.from('tasks').select('*').eq('id', req.params.id).maybeSingle();
    if (e0) throw e0;
    if (!tarefa) return res.status(404).json({ error: 'Tarefa não encontrada' });

    const b = req.body || {};
    const ehAssignee = tarefa.assignee_id === userId;
    const ehCriador = tarefa.created_by === userId;

    if (b.acao === 'lancar_coleta') {
      if (!ehAssignee && !isGestor) return res.status(403).json({ error: 'Sem permissão' });
      const { data: tpl } = await supabase.from('task_templates')
        .select('metricas').eq('id', tarefa.template_id).maybeSingle();
      const metricas = (tpl && Array.isArray(tpl.metricas)) ? tpl.metricas : [];
      const entrada = (b.valores && typeof b.valores === 'object') ? b.valores : {};
      const valores = {};
      for (const m of metricas) {
        const v = entrada[m.chave];
        if (v === undefined || v === null || v === '') continue;
        if (m.tipo_campo === 'texto') valores[m.chave] = String(v).slice(0, 500);
        else { const n = Number(v); if (!Number.isNaN(n)) valores[m.chave] = n; }
      }
      const patch = {
        valores, origem: 'manual', status: 'concluida',
        concluida_em: new Date().toISOString(), concluida_por: userId,
      };
      const { data, error } = await supabase.from('tasks').update(patch).eq('id', tarefa.id).select().single();
      if (error) throw error;
      return res.json({ tarefa: data });
    }

    if (b.acao === 'concluir') {
      if (!ehAssignee && !isGestor) return res.status(403).json({ error: 'Sem permissão' });
      if (tarefa.tipo_resultado === 'numero' && (b.valor_resultado === undefined || b.valor_resultado === null || b.valor_resultado === ''))
        return res.status(400).json({ error: 'Informe o valor para concluir esta tarefa' });
      const patch = {
        status: 'concluida',
        concluida_em: new Date().toISOString(),
        concluida_por: userId,
        obs_conclusao: b.obs_conclusao || null,
        valor_resultado: tarefa.tipo_resultado === 'numero' ? Number(b.valor_resultado) : null,
      };
      const { data, error } = await supabase.from('tasks').update(patch).eq('id', tarefa.id).select().single();
      if (error) throw error;
      return res.json({ tarefa: data });
    }

    if (b.acao === 'reabrir') {
      if (!ehAssignee && !isGestor) return res.status(403).json({ error: 'Sem permissão' });
      const { data, error } = await supabase.from('tasks')
        .update({ status: 'pendente', concluida_em: null, concluida_por: null, valor_resultado: null, obs_conclusao: null })
        .eq('id', tarefa.id).select().single();
      if (error) throw error;
      return res.json({ tarefa: data });
    }

    if (!ehCriador) return res.status(403).json({ error: 'Só quem criou pode editar' });
    const patch = {};
    for (const k of ['titulo','descricao','prioridade','categoria','prazo','lead_id','paciente_clinicorp_id','arrasta']) {
      if (k in b) patch[k] = b[k];
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada para atualizar' });
    const { data, error } = await supabase.from('tasks').update(patch).eq('id', tarefa.id).select().single();
    if (error) throw error;
    res.json({ tarefa: data });
  } catch (e) {
    console.error('[PATCH /api/tarefas/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/tarefas/:id  → só created_by e só se pendente (preserva histórico)
app.delete('/api/tarefas/:id', requireAuth, async (req, res) => {
  try {
    const { data: tarefa } = await supabase.from('tasks').select('created_by,status').eq('id', req.params.id).maybeSingle();
    if (!tarefa) return res.status(404).json({ error: 'Tarefa não encontrada' });
    if (tarefa.created_by !== req.user.id) return res.status(403).json({ error: 'Só quem criou pode excluir' });
    if (tarefa.status === 'concluida') return res.status(400).json({ error: 'Não é possível excluir tarefa concluída' });
    const { error } = await supabase.from('tasks').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/tarefas/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// CRON Central de Tarefas: geração matinal de todos + push resumo + push de prazo
let _ultimaGeracaoMatinal = null; // 'YYYY-MM-DD'

async function cronTarefas() {
  try {
    const agora = nowLocal();            // "YYYY-MM-DD HH:MM:SS" (string, fuso BR)
    const hoje = agora.slice(0, 10);
    const hora = Number(agora.slice(11, 13));

    if (hora >= 6 && _ultimaGeracaoMatinal !== hoje) {
      const { data: usuarios } = await supabase.from('profiles').select('id, roles').eq('ativo', true);
      for (const u of (usuarios || [])) {
        try {
          await gerarTarefasDoDia(repoTarefas(), u.id, u.roles || [], hoje);
          const { count } = await supabase.from('tasks').select('id', { count: 'exact', head: true })
            .eq('assignee_id', u.id).eq('data_ref', hoje).eq('status', 'pendente');
          if ((count || 0) > 0) {
            await criarNotificacao(u.id, 'tarefa_resumo', 'Tarefas de hoje', `Você tem ${count} tarefa(s) hoje.`, { url: '/tarefas/' });
          }
        } catch (e) { console.error('[cronTarefas] usuario', u.id, e.message); }
      }
      _ultimaGeracaoMatinal = hoje;
    }

    const agoraISO = new Date().toISOString();
    const { data: vencendo } = await supabase.from('tasks')
      .select('id, assignee_id, titulo')
      .eq('status', 'pendente').is('prazo_avisado_em', null)
      .lte('prazo', agoraISO).not('prazo', 'is', null);
    for (const t of (vencendo || [])) {
      await criarNotificacao(t.assignee_id, 'tarefa_vencendo', 'Tarefa no prazo', t.titulo, { url: '/tarefas/', task_id: t.id });
      await supabase.from('tasks').update({ prazo_avisado_em: agoraISO }).eq('id', t.id);
    }

    // Lembrete de coletas: card pendente cujo horário do período já passou
    const horaAgora = agora.slice(11, 16); // "HH:MM"
    const { data: cards } = await supabase.from('tasks')
      .select('id, assignee_id, titulo, periodo, template_id')
      .eq('status', 'pendente').eq('data_ref', hoje)
      .not('periodo', 'is', null).is('prazo_avisado_em', null);
    for (const c of (cards || [])) {
      const { data: tpl } = await supabase.from('task_templates').select('periodos').eq('id', c.template_id).maybeSingle();
      const per = (tpl && Array.isArray(tpl.periodos)) ? tpl.periodos.find(p => p.chave === c.periodo) : null;
      if (!per) continue;
      const horaAviso = (per.avisos_por_pessoa && per.avisos_por_pessoa[c.assignee_id]) || per.hora_aviso;
      if (!horaAviso || horaAgora < horaAviso) continue;
      await criarNotificacao(c.assignee_id, 'coleta_lembrete', 'Hora de preencher', c.titulo, { url: '/tarefas/', task_id: c.id });
      await supabase.from('tasks').update({ prazo_avisado_em: new Date().toISOString() }).eq('id', c.id);
    }
  } catch (e) { console.error('[cronTarefas]', e.message); }
}
setInterval(cronTarefas, 15 * 60 * 1000);

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


// ========== FINANCEIRO / DRE ==========

// DRE do período (agregada no Postgres — evita o limite de 1000 linhas do supabase-js)
app.get('/api/financeiro/dre', requireAuth, requireFinanceiro, async (req, res) => {
  const { from, to } = req.query;
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from || '') || !re.test(to || '') || from > to) return res.status(400).json({ error: 'periodo invalido' });
  const { data, error } = await supabase.rpc('fin_dre_agg', { p_from: from, p_to: to });
  if (error) return res.status(500).json({ error: error.message });
  const lancs = (data || []).map(r => ({ fluxo: r.fluxo, valor: Number(r.total), conta_codigo: r.conta_codigo }));
  res.json(montarDRE(lancs));
});

// DRE mensal: uma DRE por mês do período + resumo de saídas sem categoria (fora da DRE)
app.get('/api/financeiro/dre-mensal', requireAuth, requireFinanceiro, async (req, res) => {
  const { from, to } = req.query;
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from || '') || !re.test(to || '') || from > to) return res.status(400).json({ error: 'periodo invalido' });
  const nMeses = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) + 1;
  if (nMeses > 36) return res.status(400).json({ error: 'periodo maximo: 36 meses' });
  const [agg, semCat, fat] = await Promise.all([
    supabase.rpc('fin_dre_agg_mensal', { p_from: from, p_to: to }),
    supabase.rpc('fin_sem_categoria_resumo', { p_from: from, p_to: to }),
    supabase.rpc('fin_faturamento_mensal', { p_from: from, p_to: to }),
  ]);
  if (agg.error) return res.status(500).json({ error: agg.error.message });
  if (semCat.error) return res.status(500).json({ error: semCat.error.message });
  const sc = (semCat.data || [])[0] || { qtd: 0, total: 0 };
  res.json({
    meses: montarDREMensal(agg.data || [], from, to),
    sem_categoria: { qtd: Number(sc.qtd), total: Number(sc.total) },
    faturamento: fat.error ? [] : (fat.data || []), // competência (REVENUE) — linha 0 da DRE
  });
});

// Curva diária dos últimos 6 meses completos — calibra a projeção do mês corrente
// (corrige o front-loading: despesas concentradas no início do mês explodiam a linear)
app.get('/api/financeiro/curva-diaria', requireAuth, requireFinanceiro, async (req, res) => {
  const hoje = _finDataLocal(new Date().toISOString());
  const [y, m] = hoje.slice(0, 7).split('-').map(Number);
  const ini = new Date(Date.UTC(y, m - 7, 1)).toISOString().slice(0, 10);  // 1º dia, 6 meses atrás
  const fim = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);  // último dia do mês passado
  const { data, error } = await supabase.rpc('fin_agg_diario', { p_from: ini, p_to: fim });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Avaliação do consultor: fatos exatos (lib/financeiro/avaliacao) + leitura da IA.
// Cache 24h por período em fin_dre_avaliacoes; ?force=1 regenera.
app.get('/api/financeiro/avaliacao', requireAuth, requireFinanceiro, async (req, res) => {
  const { from, to, force, pergunta } = req.query;
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from || '') || !re.test(to || '') || from > to) return res.status(400).json({ error: 'periodo invalido' });
  if (pergunta != null && (!String(pergunta).trim() || String(pergunta).length > 300))
    return res.status(400).json({ error: 'pergunta vazia ou longa demais (máx. 300 caracteres)' });
  const periodoKey = `${from}~${to}`;
  try {
    if (!pergunta && force !== '1') {
      const { data: c } = await supabase.from('fin_dre_avaliacoes').select('*').eq('periodo', periodoKey).maybeSingle();
      if (c && (Date.now() - new Date(c.atualizado_em).getTime()) < 24 * 3600e3)
        return res.json({ fatos: c.fatos, texto: c.texto, atualizado_em: c.atualizado_em, cache: true });
    }
    // período + contexto (6 meses antes) + mesmos meses do ano anterior
    const ultimoDiaMesAnterior = (iso) => { const [yy, mm] = iso.slice(0, 7).split('-').map(Number);
      return new Date(Date.UTC(yy, mm - 1, 0)).toISOString().slice(0, 10); };
    const primeiroDiaMenosN = (iso, n) => { const [yy, mm] = iso.slice(0, 7).split('-').map(Number);
      return new Date(Date.UTC(yy, mm - 1 - n, 1)).toISOString().slice(0, 10); };
    const menos1Ano = (iso, fimDeMes) => { const [yy, mm] = iso.slice(0, 7).split('-').map(Number);
      return fimDeMes ? new Date(Date.UTC(yy - 1, mm, 0)).toISOString().slice(0, 10)
        : `${yy - 1}${iso.slice(4)}`; };
    const buscar = async (f, t) => {
      const { data, error } = await supabase.rpc('fin_dre_agg_mensal', { p_from: f, p_to: t });
      if (error) throw new Error(error.message);
      return montarDREMensal(data || [], f, t);
    };
    const [periodo, contexto, anoAnterior] = await Promise.all([
      buscar(from, to),
      buscar(primeiroDiaMenosN(from, 6), ultimoDiaMesAnterior(from)),
      buscar(menos1Ano(from, false), menos1Ano(to, true)),
    ]);
    // meses sem receita nenhuma no contexto/AA (antes do backfill) ficam fora das médias
    const comDados = (ms) => ms.filter(m => (m.grupos || []).some(g => Math.abs(g.total) > 0.005));
    const ctxOk = comDados(contexto);
    const fatos = _dreMontarFatos({ periodo, contexto: ctxOk, anoAnterior: comDados(anoAnterior) });
    // Pergunta livre: responde com fatos + TODAS as contas (sem cache — custa centavos)
    if (pergunta) {
      const contas = _dreContasDetalhadas(periodo, ctxOk);
      const { data } = await geminiLib().perguntarDRE({ fatos, contas, pergunta });
      return res.json({ resposta: data.resposta });
    }
    let texto = null, textoErro = null;
    try { texto = (await geminiLib().avaliarDRE({ fatos })).data; }
    catch (e) { textoErro = e.message; console.error('[dre-avaliacao] IA falhou:', e.message); }
    await supabase.from('fin_dre_avaliacoes').upsert({
      periodo: periodoKey, fatos, texto, atualizado_em: new Date().toISOString(),
    }, { onConflict: 'periodo' });
    res.json({ fatos, texto, texto_erro: textoErro, atualizado_em: new Date().toISOString(), cache: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lançamentos filtráveis (página de até 2000)
app.get('/api/financeiro/lancamentos', requireAuth, requireFinanceiro, async (req, res) => {
  const { from, to, empresa, conta_id, fluxo, incluir_inativos } = req.query;
  // Colunas explícitas SEM `raw` (JSON cru da Clinicorp = 90% do peso da tabela
  // e não é usado na tela). Corta ~90% do egress deste endpoint.
  let q = supabase.from('fin_lancamentos').select('id, clinicorp_id, data, descricao, valor, fluxo, post_type, entry_type, forma_pgto, empresa, paciente_id, receita_sub, conta_id, classificacao_metodo, override_manual, ativo, visto_em, criado_em, fin_contas(codigo,nome)').order('data', { ascending: false }).limit(2000);
  if (from) q = q.gte('data', from);
  if (to) q = q.lte('data', to);
  if (empresa) q = q.eq('empresa', empresa);
  if (conta_id) q = q.eq('conta_id', conta_id);
  if (fluxo) q = q.eq('fluxo', fluxo);
  if (incluir_inativos !== '1') q = q.eq('ativo', true);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Fila "A categorizar" (despesas sem conta)
app.get('/api/financeiro/a-categorizar', requireAuth, requireFinanceiro, async (req, res) => {
  const { from, to } = req.query;
  let q = supabase.from('fin_lancamentos')
    .select('id, clinicorp_id, data, descricao, valor, fluxo, post_type, entry_type, forma_pgto, empresa, paciente_id, receita_sub, conta_id, classificacao_metodo, override_manual, ativo, visto_em, criado_em') // sem `raw` (peso morto)
    .eq('ativo', true).eq('fluxo', 'sai').is('conta_id', null).order('valor', { ascending: false }).limit(1000);
  if (from) q = q.gte('data', from);
  if (to) q = q.lte('data', to);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Resumo de pendências de categorização agrupado por ano (para o seletor da tela)
app.get('/api/financeiro/a-categorizar/resumo', requireAuth, requireFinanceiro, async (req, res) => {
  const { data, error } = await supabase.rpc('fin_a_categorizar_por_ano');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Saúde 24m: a receber (parcelas por vencimento, fin_recebiveis_mensal, 24m) ×
// a pagar (out_forecast do cash_flow, fin_fluxo_futuro, ~12m — a_pagar=null além
// do horizonte que o Clinicorp fornece, para não parecer "zero contas").
app.get('/api/financeiro/saude', requireAuth, requireFinanceiro, async (req, res) => {
  // Histórico mensal (faturamento/caixa/saídas) p/ a projeção de crescimento — 36 meses.
  const hojeIso = _finDataLocal(new Date());
  const serieFrom = (() => { const [y, m] = hojeIso.slice(0, 7).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 - 36, 1)).toISOString().slice(0, 10); })();
  const [receb, fluxo, vencido, analises, snaps, serie] = await Promise.all([
    supabase.from('fin_recebiveis_mensal').select('mes,valor,atualizado_em').order('mes'),
    supabase.from('fin_fluxo_futuro').select('mes,a_receber,a_pagar,atualizado_em').order('mes'),
    supabase.rpc('fin_vencido_total'),
    supabase.from('fin_saude_analises').select('dados,atualizado_em').eq('id', 1).maybeSingle(),
    supabase.from('fin_saude_snapshots').select('data,receber,pagar,resultado,origem').order('data').limit(800),
    supabase.rpc('fin_series_mensais', { p_from: serieFrom, p_to: hojeIso }),
  ]);
  if (receb.error) return res.status(500).json({ error: receb.error.message });
  if (fluxo.error) return res.status(500).json({ error: fluxo.error.message });
  if (vencido.error) return res.status(500).json({ error: vencido.error.message });
  const pagarPorMes = new Map((fluxo.data || []).map(r => [String(r.mes).slice(0, 7), Number(r.a_pagar)]));
  // Fallback: antes do 1º refresh dos recebíveis, usa o in_forecast antigo do fluxo
  const meses = (receb.data || []).length
    ? (receb.data || []).map(r => {
        const ym = String(r.mes).slice(0, 7);
        return { mes: ym, a_receber: Number(r.valor), a_pagar: pagarPorMes.has(ym) ? pagarPorMes.get(ym) : null };
      })
    : (fluxo.data || []).map(r => ({
        mes: String(r.mes).slice(0, 7), a_receber: Number(r.a_receber), a_pagar: Number(r.a_pagar),
      }));
  const ts = [(receb.data || [])[0]?.atualizado_em, (fluxo.data || [])[0]?.atualizado_em]
    .filter(Boolean).sort().pop() || null;
  // Série mensal p/ projeção — exclui o mês corrente (parcial distorce a tendência).
  const ymCorrente = hojeIso.slice(0, 7);
  const serieMensal = serie.error ? []
    : (serie.data || []).filter(r => String(r.ym) < ymCorrente).map(r => ({
        ym: String(r.ym), faturamento: Number(r.faturamento) || 0,
        caixa: Number(r.caixa) || 0, saidas: Number(r.saidas) || 0,
      }));
  res.json({
    meses, vencido: Number(vencido.data || 0), atualizado_em: ts,
    analises: analises.data?.dados || null,
    snapshots: (snaps.data || []).map(s => ({
      data: String(s.data), receber: Number(s.receber), pagar: Number(s.pagar),
      resultado: Number(s.resultado), origem: s.origem,
    })),
    serie_mensal: serieMensal,
  });
});

// Painel do Gestor — indicadores financeiros (só gestor). O funil, marketing e
// prevenção o front puxa dos endpoints que já aceitam gestor; aqui ficam os
// números que exigem as RPCs financeiras (fora do alcance do role gestor puro).
app.get('/api/painel-gestor', requireAuth, requireGestor, async (req, res) => {
  const hoje = _finDataLocal(new Date());
  const ymCorrente = hoje.slice(0, 7);
  const menosMeses = (n) => { const [y, m] = hoje.slice(0, 7).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 10); };
  const from90 = (() => { const d = new Date(hoje + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 90);
    return d.toISOString().slice(0, 10); })();
  try {
    const [serieR, aggR, vencR, recebR, analR, ticketR] = await Promise.all([
      supabase.rpc('fin_series_mensais', { p_from: menosMeses(36), p_to: hoje }),
      supabase.rpc('fin_dre_agg_mensal', { p_from: menosMeses(8), p_to: hoje }),
      supabase.rpc('fin_vencido_total'),
      supabase.from('fin_recebiveis_mensal').select('valor'),
      supabase.from('fin_saude_analises').select('dados').eq('id', 1).maybeSingle(),
      supabase.from('orcamentos').select('valor_particular,valor_aprovado,revisao_status')
        .eq('status', 'APPROVED').gt('valor_particular', 0).gte('data_fechamento', from90),
    ]);
    // Faturamento do último mês completo + crescimento ano-a-ano
    const serie = (serieR.data || []).filter(r => String(r.ym) < ymCorrente)
      .sort((a, b) => a.ym < b.ym ? -1 : 1)
      .map(r => ({ ym: String(r.ym), faturamento: Number(r.faturamento) || 0,
        caixa: Number(r.caixa) || 0, saidas: Number(r.saidas) || 0 }));
    const ultimoMes = serie[serie.length - 1] || null;
    const crescimentoFat = _PainelGestor.crescimentoAnual(serie, 'faturamento');

    // Lucro/margem + ponto de equilíbrio (meses completos), via DRE + análise
    const dreMeses = montarDREMensal(aggR.data || [], menosMeses(8), hoje);
    const hojeDate = new Date();
    const completos = dreMeses.filter(m => _DREAnalise.mesCompleto(m.ym, hojeDate));
    const ult = completos[completos.length - 1] || null;
    const sub = ult ? _DREAnalise.subtotais(ult) : null;
    const margem = sub && sub.receitaBruta > 0 ? sub.resultadoFinal / sub.receitaBruta : null;
    const pe = _DREAnalise.pontoEquilibrio(completos);
    const ms = _DREAnalise.margemSeguranca(completos);

    // Inadimplência
    const aReceber = (recebR.data || []).reduce((s, r) => s + (Number(r.valor) || 0), 0);
    const vencido = Number(vencR.data || 0);
    const inadPct = aReceber > 0 ? vencido / aReceber : null;
    const taxaPerda = analR.data?.dados?.perda?.taxa ?? null;

    // Ticket médio SEM convênio (orçamentos particulares aprovados nos últimos 90 dias)
    const aprov = (ticketR.data || []).filter(o => o.revisao_status !== 'rejeitado');
    const vals = aprov.map(o => Number(o.valor_aprovado ?? o.valor_particular) || 0).filter(v => v > 0);
    const ticket = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;

    res.json({
      atualizado_em: new Date().toISOString(),
      faturamento: { mes: ultimoMes ? ultimoMes.ym : null, valor: ultimoMes ? ultimoMes.faturamento : null,
        crescimentoAnual: crescimentoFat },
      lucro: { margem, resultado: sub ? sub.resultadoFinal : null,
        pontoEquilibrio: pe.erro ? null : pe.pe, folga: ms ? ms.pct : null },
      inadimplencia: { vencido, aReceber, pct: inadPct, taxaPerda },
      ticketSemConvenio: { valor: ticket, n: vals.length },
    });
  } catch (e) {
    console.error('❌ /api/painel-gestor:', e.message);
    res.status(500).json({ error: 'Falha ao montar o painel do gestor' });
  }
});

// Classificar 1 lançamento. body: { conta_id, alcance: 'so_esta'|'todas', metodo, padrao }
app.post('/api/financeiro/lancamentos/:id/classificar', requireAuth, requireFinanceiro, async (req, res) => {
  const { conta_id, alcance, metodo, padrao } = req.body || {};
  if (!conta_id) return res.status(400).json({ error: 'conta_id obrigatório' });

  // busca a descrição da linha (para derivar padrão se vier vazio)
  const { data: lanc, error: eL } = await supabase.from('fin_lancamentos').select('descricao').eq('id', req.params.id).maybeSingle();
  if (eL) return res.status(500).json({ error: eL.message });

  await supabase.from('fin_lancamentos').update({
    conta_id, classificacao_metodo: 'manual', override_manual: alcance === 'so_esta',
  }).eq('id', req.params.id);

  if (alcance === 'todas') {
    const met = metodo || 'exato';
    const pad = padrao || (lanc ? _finNucleo(lanc.descricao) : null);
    if (pad) {
      await supabase.from('fin_regras').upsert(
        { metodo: met, padrao: pad, conta_id, origem: 'manual', criado_por: req.user?.id },
        { onConflict: 'metodo,padrao' });

      // busca candidatos em páginas de 1000 (evita o limite do supabase-js) e reclassifica
      const cands = [];
      let from = 0;
      while (true) {
        const { data: page } = await supabase.from('fin_lancamentos')
          .select('id,descricao,override_manual').eq('fluxo', 'sai').eq('override_manual', false)
          .range(from, from + 999);
        if (!page || !page.length) break;
        cands.push(...page);
        if (page.length < 1000) break;
        from += 1000;
      }
      const alvos = alvosDaRegra(cands, { metodo: met, padrao: pad });
      for (let i = 0; i < alvos.length; i += 500) {
        const ids = alvos.slice(i, i + 500).map(a => a.id);
        await supabase.from('fin_lancamentos')
          .update({ conta_id, classificacao_metodo: met === 'pessoa' ? 'pessoa' : 'regra' })
          .in('id', ids).eq('override_manual', false);
      }
    }
  }
  res.json({ ok: true });
});

// CRUD simples de cadastros (contas, regras, pessoas)
// allow-list de campos por tabela (evita mass-assignment via req.body)
const FIN_CRUD_CAMPOS = {
  fin_contas:  ['codigo', 'nome', 'grupo', 'tipo', 'ordem', 'ativo'],
  fin_regras:  ['metodo', 'padrao', 'conta_id', 'prioridade'],
  fin_pessoas: ['nome', 'papel', 'conta_id', 'empresa', 'ativo'],
};
function _finPick(tabela, body) {
  const campos = FIN_CRUD_CAMPOS[tabela] || [];
  const out = {};
  for (const k of campos) if (body && body[k] !== undefined) out[k] = body[k];
  return out;
}
const FIN_GET_SELECT = {
  fin_contas:  '*',
  fin_regras:  '*, fin_contas(codigo,nome)',
  fin_pessoas: '*, fin_contas(codigo,nome)',
};
for (const tabela of ['fin_contas', 'fin_regras', 'fin_pessoas']) {
  const slug = tabela.replace('fin_', '');
  app.get(`/api/financeiro/${slug}`, requireAuth, requireFinanceiro, async (req, res) => {
    const { data, error } = await supabase.from(tabela).select(FIN_GET_SELECT[tabela] || '*').order('id').limit(5000);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });
  app.post(`/api/financeiro/${slug}`, requireAuth, requireFinanceiro, async (req, res) => {
    const { data, error } = await supabase.from(tabela).insert(_finPick(tabela, req.body)).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });
  app.patch(`/api/financeiro/${slug}/:id`, requireAuth, requireFinanceiro, async (req, res) => {
    const { data, error } = await supabase.from(tabela).update(_finPick(tabela, req.body)).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });
}

// Sync manual do financeiro — mês corrente (botão "Atualizar dados" da DRE)
app.post('/api/financeiro/sync', requireAuth, requireFinanceiro, async (req, res) => {
  const { from, to } = _finMesCorrente();
  try {
    const r = await syncFinanceiro(from, to);
    // fluxo futuro no mesmo botão; falha aqui não invalida o sync da DRE
    try { await syncFluxoFuturo(); }
    catch (e) { console.error('[fluxo-futuro] erro:', e.message); }
    // recebíveis 24m (12 chamadas /payment/list) em background — guard interno
    // impede execução concorrente; a página atualiza no próximo carregamento
    fetchInadimplentesBackground().catch(e => console.error('[recebiveis-manual] erro:', e.message));
    res.json(r);
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Produção: Receita x Entrega ──────────────────────────────────────────────

app.get('/api/producao/resumo', requireAuth, requireProducao, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from e to obrigatórios' });

  try {
    // Ambas as RPCs rodam em paralelo para melhor performance
    const [{ data: dentData, error: eD }, { data: recData, error: eR }] = await Promise.all([
      supabase.rpc('producao_por_dentista', { p_from: from, p_to: to }),
      supabase.rpc('sum_received',          { p_from: from, p_to: to }),
    ]);
    if (eD) throw new Error(`producao_por_dentista: ${eD.message}`);
    if (eR) throw new Error(`sum_received: ${eR.message}`);

    // producao_por_dentista retorna tabela; sum_received retorna scalar numeric direto
    const producao_total = (dentData || []).reduce((s, r) => s + Number(r.producao), 0);
    const receita_total  = Number(recData ?? 0);

    const por_dentista = (dentData || []).map(d => ({
      dentist_person_id: d.dentist_person_id,
      dentist_name:      d.dentist_name,
      producao:          Number(d.producao),
      participacao_pct:  producao_total > 0
        ? Math.round((Number(d.producao) / producao_total) * 1000) / 10
        : 0,
    }));

    const percentual = receita_total > 0
      ? Math.round((producao_total / receita_total) * 1000) / 10
      : null;

    res.json({ from, to, producao_total, receita_total, percentual, por_dentista });
  } catch (e) {
    console.error('[producao/resumo]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/producao/procedimentos', requireAuth, requireProducao, async (req, res) => {
  const { from, to, search, dentist } = req.query;
  const page  = Math.max(1, parseInt(req.query.page  || '1'));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '100')));
  if (!from || !to) return res.status(400).json({ error: 'from e to obrigatórios' });

  try {
    const offset = (page - 1) * limit;
    let q = supabase
      .from('producao_procedimentos')
      .select('executed_date, dentist_name, procedure_name, paciente_nome, amount, bill_type', { count: 'exact' })
      .gte('executed_date', from)
      .lte('executed_date', to)
      .order('executed_date', { ascending: false });

    if (dentist) q = q.ilike('dentist_name', `%${dentist}%`);
    if (search)  q = q.or(`procedure_name.ilike.%${search}%,paciente_nome.ilike.%${search}%`);

    const { data, error, count } = await q.range(offset, offset + limit - 1);
    if (error) throw new Error(error.message);
    res.json({ total: count || 0, page, data: data || [] });
  } catch (e) {
    console.error('[producao/procedimentos]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/producao/top-procedimentos', requireAuth, requireProducao, async (req, res) => {
  const { from, to } = req.query;
  const topN = Math.min(20, Math.max(1, parseInt(req.query.limit || '10')));
  if (!from || !to) return res.status(400).json({ error: 'from e to obrigatórios' });

  try {
    const { data, error } = await supabase.rpc('producao_top_procedimentos', { p_from: from, p_to: to, p_limit: topN });
    if (error) throw new Error(error.message);
    res.json({ data: data || [] });
  } catch (e) {
    console.error('[producao/top-procedimentos]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Análise por Dentista ─────────────────────────────────────────────────────

// Helper: retorna array de {ano, mes} entre from e to (inclusive)
function _getMonths(from, to) {
  const months = [];
  let d = new Date(from.slice(0, 7) + '-01');
  const end = new Date(to.slice(0, 7) + '-01');
  while (d <= end) {
    months.push({ ano: d.getFullYear(), mes: d.getMonth() + 1 });
    d.setMonth(d.getMonth() + 1);
  }
  return months;
}

// Resumo por dentista no período
app.get('/api/producao/dentista/resumo', requireAuth, requireProducao, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from e to obrigatórios' });

  try {
    const fromYear = parseInt(from.slice(0, 4));
    const toYear   = parseInt(to.slice(0, 4));
    const months   = _getMonths(from, to);

    // agenda_appointments.dentist_name is always null (Clinicorp /appointment/list doesn't return it)
    // so we derive execução dentist IDs from producao_procedimentos, which has the correct names.
    // Agregações via RPC: o client JS trunca .select() em 1000 linhas (agenda tem ~1000/mês).
    const { data: execDentists, error: eExec } = await supabase.rpc('dentistas_execucao');
    if (eExec) throw new Error(eExec.message);
    const execMap = {};
    for (const r of (execDentists || [])) {
      if (!execMap[r.dentist_person_id]) execMap[r.dentist_person_id] = r.dentist_name;
    }
    const execIds = Object.keys(execMap);
    if (execIds.length === 0) return res.json({ data: [] });

    const [
      { data: agendaRows, error: eA },
      { data: producaoRows, error: eP },
      { data: manualRows,  error: eM },
      { data: custoRows,   error: eC },
    ] = await Promise.all([
      supabase.rpc('agenda_horas_dentista_mes', { p_ids: execIds, p_from: from, p_to: to }),
      supabase.rpc('producao_por_dentista', { p_from: from, p_to: to }),
      supabase.from('dentista_horas_manual')
        .select('dentist_person_id, ano, mes, horas')
        .gte('ano', fromYear)
        .lte('ano', toYear),
      supabase.from('producao_imposto_aliquota')
        .select('ano, custo_hora')
        .gte('ano', fromYear)
        .lte('ano', toYear),
    ]);
    if (eA) throw new Error(eA.message);
    if (eP) throw new Error(eP.message);
    if (eM) throw new Error(eM.message);
    if (eC) throw new Error(eC.message);

    // Indexes
    const manualMap = {};
    for (const r of (manualRows || [])) {
      if (!manualMap[r.dentist_person_id]) manualMap[r.dentist_person_id] = {};
      manualMap[r.dentist_person_id][`${r.ano}-${r.mes}`] = Number(r.horas);
    }
    const custoByYear = {};
    for (const r of (custoRows || [])) {
      custoByYear[r.ano] = r.custo_hora != null ? Number(r.custo_hora) : null;
    }
    const producaoMap = {};
    for (const r of (producaoRows || [])) {
      if (r.dentist_person_id === '__sem_dentista__') continue;
      producaoMap[r.dentist_person_id] = { producao: Number(r.producao), dentist_name: r.dentist_name };
    }

    // Group agenda by dentist → month (já agregado no SQL)
    const agendaByDent = {};
    for (const r of (agendaRows || [])) {
      if (!agendaByDent[r.dentist_person_id]) agendaByDent[r.dentist_person_id] = {};
      agendaByDent[r.dentist_person_id][`${r.ano}-${r.mes}`] = { horas: Number(r.horas), dias: r.dias };
    }

    // Build result — all execução dentists (even those without agenda in this period)
    const data = [];
    for (const dentId of execIds) {
      const agenda = agendaByDent[dentId] || {};
      const manual = manualMap[dentId] || {};

      let horasTot = 0;
      let diasTot  = 0;
      let horas_manual_override = false;

      for (const { ano, mes } of months) {
        const key = `${ano}-${mes}`;
        if (manual[key] !== undefined) {
          horasTot += Number(manual[key]);
          horas_manual_override = true;
        } else {
          const m = agenda[key];
          if (m) {
            horasTot += m.horas;
            diasTot  += m.dias;
          }
        }
      }

      const producao_total    = Math.round((producaoMap[dentId]?.producao || 0) * 100) / 100;
      const horas_agendadas   = Math.round(horasTot * 100) / 100;
      const producao_por_hora = horas_agendadas > 0
        ? Math.round((producao_total / horas_agendadas) * 100) / 100
        : null;
      const custo_hora        = custoByYear[fromYear] ?? null;
      const resultado_por_hora = (producao_por_hora !== null && custo_hora !== null)
        ? Math.round((producao_por_hora - custo_hora) * 100) / 100
        : null;

      data.push({
        dentist_person_id: dentId,
        dentist_name:      execMap[dentId] || producaoMap[dentId]?.dentist_name || '',
        producao_total,
        horas_agendadas,
        dias_com_agenda: diasTot,
        producao_por_hora,
        custo_hora,
        resultado_por_hora,
        horas_manual_override,
      });
    }

    data.sort((a, b) => b.producao_total - a.producao_total);
    res.json({ data });
  } catch (e) {
    console.error('[producao/dentista/resumo]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Evolução mensal por dentista
app.get('/api/producao/dentista/evolucao', requireAuth, requireProducao, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from e to obrigatórios' });

  try {
    const fromYear = parseInt(from.slice(0, 4));
    const toYear   = parseInt(to.slice(0, 4));
    const months   = _getMonths(from, to);

    // agenda_appointments.dentist_name is always null — derive execução IDs from producao_procedimentos.
    // Agregações via RPC: o client JS trunca .select() em 1000 linhas (agenda tem ~1000/mês).
    const { data: execDentists, error: eExec } = await supabase.rpc('dentistas_execucao');
    if (eExec) throw new Error(eExec.message);
    const execMap = {};
    for (const r of (execDentists || [])) {
      if (!execMap[r.dentist_person_id]) execMap[r.dentist_person_id] = r.dentist_name;
    }
    const execIds = Object.keys(execMap);
    if (execIds.length === 0) return res.json({ data: [] });

    const [
      { data: agendaRows, error: eA },
      { data: manualRows,  error: eM },
      { data: custoRows,   error: eC },
    ] = await Promise.all([
      supabase.rpc('agenda_horas_dentista_mes', { p_ids: execIds, p_from: from, p_to: to }),
      supabase.from('dentista_horas_manual')
        .select('dentist_person_id, ano, mes, horas')
        .gte('ano', fromYear)
        .lte('ano', toYear),
      supabase.from('producao_imposto_aliquota')
        .select('ano, custo_hora')
        .gte('ano', fromYear)
        .lte('ano', toYear),
    ]);
    if (eA) throw new Error(eA.message);
    if (eM) throw new Error(eM.message);
    if (eC) throw new Error(eC.message);

    // Produção mensal por dentista via RPC (uma chamada por mês em paralelo)
    const producaoResults = await Promise.all(months.map(({ ano, mes }) => {
      const pad = String(mes).padStart(2, '0');
      const mFrom = `${ano}-${pad}-01`;
      const lastDay = new Date(ano, mes, 0).getDate();
      const mTo   = `${ano}-${pad}-${String(lastDay).padStart(2, '0')}`;
      return supabase.rpc('producao_por_dentista', { p_from: mFrom, p_to: mTo })
        .then(({ data }) => ({ ano, mes, rows: data || [] }));
    }));

    // Build producaoByMonthDent: dentId → { 'ano-mes': producao }
    const producaoByMonthDent = {};
    for (const { ano, mes, rows } of producaoResults) {
      for (const r of rows) {
        if (r.dentist_person_id === '__sem_dentista__') continue;
        if (!producaoByMonthDent[r.dentist_person_id]) producaoByMonthDent[r.dentist_person_id] = {};
        producaoByMonthDent[r.dentist_person_id][`${ano}-${mes}`] = Number(r.producao);
      }
    }

    // Indexes
    const manualMap = {};
    for (const r of (manualRows || [])) {
      if (!manualMap[r.dentist_person_id]) manualMap[r.dentist_person_id] = {};
      manualMap[r.dentist_person_id][`${r.ano}-${r.mes}`] = Number(r.horas);
    }
    const custoByYear = {};
    for (const r of (custoRows || [])) {
      custoByYear[r.ano] = r.custo_hora != null ? Number(r.custo_hora) : null;
    }

    // Group agenda by dentist → month (já agregado no SQL)
    const agendaByDent = {};
    for (const r of (agendaRows || [])) {
      if (!agendaByDent[r.dentist_person_id]) agendaByDent[r.dentist_person_id] = {};
      agendaByDent[r.dentist_person_id][`${r.ano}-${r.mes}`] = { horas: Number(r.horas), dias: r.dias };
    }

    // Build monthly rows — iterate execIds so dentists with no agenda still appear
    const data = [];
    for (const dentId of execIds) {
      const agenda = agendaByDent[dentId] || {};
      const manual = manualMap[dentId] || {};

      for (const { ano, mes } of months) {
        const key = `${ano}-${mes}`;
        const manualEntry = manual[key];
        const agendaEntry = agenda[key];

        const horas_manual    = manualEntry !== undefined;
        const horas_agendadas = horas_manual
          ? Number(manualEntry)
          : (agendaEntry ? agendaEntry.horas : 0);
        const dias_com_agenda = horas_manual ? 0 : (agendaEntry ? agendaEntry.dias : 0);

        const producao = producaoByMonthDent[dentId]?.[key] || 0;
        if (!producao && !horas_agendadas) continue; // sem dado no mês → não polui a tabela
        const producao_por_hora = horas_agendadas > 0
          ? Math.round((producao / horas_agendadas) * 100) / 100
          : null;
        const custo_hora = custoByYear[ano] ?? null;
        const resultado_por_hora = (producao_por_hora !== null && custo_hora !== null)
          ? Math.round((producao_por_hora - custo_hora) * 100) / 100
          : null;

        data.push({
          mes:               `${ano}-${String(mes).padStart(2, '0')}`,
          dentist_person_id: dentId,
          dentist_name:      execMap[dentId] || '',
          producao:          Math.round(producao * 100) / 100,
          horas_agendadas,
          dias_com_agenda,
          producao_por_hora,
          custo_hora,
          resultado_por_hora,
          horas_manual,
        });
      }
    }

    data.sort((a, b) => a.dentist_name.localeCompare(b.dentist_name) || a.mes.localeCompare(b.mes));
    res.json({ data });
  } catch (e) {
    console.error('[producao/dentista/evolucao]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Top 5 procedimentos de um dentista no período
app.get('/api/producao/dentista/top-procedimentos', requireAuth, requireProducao, async (req, res) => {
  const { from, to, dentist_id } = req.query;
  if (!from || !to || !dentist_id) return res.status(400).json({ error: 'from, to e dentist_id obrigatórios' });

  try {
    const { data, error } = await supabase.rpc('producao_top_procs_dentista', {
      p_from: from, p_to: to, p_dentist_id: dentist_id, p_limit: 5,
    });
    if (error) throw new Error(error.message);
    res.json({ data: data || [] });
  } catch (e) {
    console.error('[producao/dentista/top-procedimentos]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Configuração global de produção por ano (imposto + custo/hora)
app.get('/api/producao/imposto', requireAuth, requireProducao, async (req, res) => {
  const ano = parseInt(req.query.ano);
  if (!ano) return res.status(400).json({ error: 'ano obrigatório' });
  try {
    const { data, error } = await supabase.from('producao_imposto_aliquota')
      .select('aliquota, custo_hora').eq('ano', ano).maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ aliquota: data?.aliquota ?? null, custo_hora: data?.custo_hora ?? null });
  } catch (e) {
    console.error('[producao/imposto GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/producao/imposto', requireAuth, requireProducao, async (req, res) => {
  const { ano, aliquota, custo_hora } = req.body;
  if (!ano) return res.status(400).json({ error: 'ano obrigatório' });
  try {
    const row = { ano: parseInt(ano), atualizado_em: new Date().toISOString() };
    if (aliquota  != null) row.aliquota  = Number(aliquota);
    if (custo_hora != null) row.custo_hora = Number(custo_hora);
    const { error } = await supabase.from('producao_imposto_aliquota')
      .upsert(row, { onConflict: 'ano' });
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    console.error('[producao/imposto POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Custo real proporcional por dentista (pagamentos nas despesas × proporção horas execução)
app.get('/api/producao/dentista/custo-real', requireAuth, requireProducao, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from e to obrigatórios' });
  try {
    const { data: configs, error: eConf } = await supabase
      .from('dentista_config')
      .select('dentist_person_id, keyword_despesa, persona_avaliacao_id, horas_semana_exec, horas_semana_aval')
      .not('keyword_despesa', 'is', null);
    if (eConf) throw new Error(eConf.message);
    if (!configs?.length) return res.json({ data: [] });

    const results = await Promise.all(configs.map(async (c) => {
      const allIds = [c.dentist_person_id];
      if (c.persona_avaliacao_id) allIds.push(c.persona_avaliacao_id);

      const [{ data: pagamentos, error: eP }, { data: horasRows, error: eH }] = await Promise.all([
        supabase.from('fin_lancamentos')
          .select('descricao, valor, data')
          .eq('fluxo', 'sai')
          .ilike('descricao', `%${c.keyword_despesa}%`)
          .gte('data', from)
          .lte('data', to)
          .eq('ativo', true)
          .order('data', { ascending: true }),
        supabase.rpc('horas_agenda_por_personas', { p_ids: allIds, p_from: from, p_to: to }),
      ]);
      if (eP) throw new Error(eP.message);
      if (eH) throw new Error(eH.message);

      const pago = (pagamentos || []).reduce((s, r) => s + Number(r.valor), 0);

      let horas_exec = 0, horas_aval = 0;
      for (const r of (horasRows || [])) {
        if (r.dentist_person_id === c.dentist_person_id) horas_exec = Number(r.horas);
        else horas_aval += Number(r.horas);
      }
      const horas_total = horas_exec + horas_aval;

      // Rateio do salário: se há escala fixa configurada (horas/semana de execução
      // e avaliação), usa essa proporção estável. Senão, cai nas horas realmente
      // agendadas. Sem persona de avaliação → custo é o pago integral.
      const esc_exec = Number(c.horas_semana_exec) || 0;
      const esc_aval = Number(c.horas_semana_aval) || 0;
      const esc_total = esc_exec + esc_aval;

      let proporcao_exec, base_rateio;
      if (c.persona_avaliacao_id && esc_total > 0) {
        proporcao_exec = esc_exec / esc_total;
        base_rateio = 'escala';
      } else if (c.persona_avaliacao_id && horas_total > 0) {
        proporcao_exec = horas_exec / horas_total;
        base_rateio = 'agendadas';
      } else {
        proporcao_exec = 1;
        base_rateio = 'integral';
      }
      const custo_proporcional = pago * proporcao_exec;

      return {
        dentist_person_id:  c.dentist_person_id,
        _keyword:           c.keyword_despesa || '',
        _avaliacao_id:      c.persona_avaliacao_id || '',
        pago:               Math.round(pago * 100) / 100,
        horas_exec:         Math.round(horas_exec * 100) / 100,
        horas_aval:         Math.round(horas_aval * 100) / 100,
        horas_semana_exec:  esc_exec || null,
        horas_semana_aval:  esc_aval || null,
        base_rateio,
        proporcao_exec:     Math.round(proporcao_exec * 1000) / 10,
        custo_proporcional: Math.round(custo_proporcional * 100) / 100,
        pagamentos:         (pagamentos || []).map(p => ({
          descricao: p.descricao,
          valor:     Math.round(Number(p.valor) * 100) / 100,
          data:      p.data,
        })),
      };
    }));

    res.json({ data: results });
  } catch (e) {
    console.error('[producao/dentista/custo-real]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Salvar config de dentista (keyword despesas + ID persona avaliação)
app.post('/api/producao/dentista/config', requireAuth, requireProducao, async (req, res) => {
  const { dentist_person_id, dentist_name, keyword_despesa, persona_avaliacao_id,
          horas_semana_exec, horas_semana_aval } = req.body;
  if (!dentist_person_id) return res.status(400).json({ error: 'dentist_person_id obrigatório' });
  try {
    const { error } = await supabase.from('dentista_config').upsert({
      dentist_person_id,
      dentist_name:         dentist_name || null,
      keyword_despesa:      keyword_despesa || null,
      persona_avaliacao_id: persona_avaliacao_id || null,
      horas_semana_exec:    (horas_semana_exec === '' || horas_semana_exec == null) ? null : Number(horas_semana_exec),
      horas_semana_aval:    (horas_semana_aval === '' || horas_semana_aval == null) ? null : Number(horas_semana_aval),
      atualizado_em:        new Date().toISOString(),
    }, { onConflict: 'dentist_person_id' });
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    console.error('[producao/dentista/config]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Salvar custo/hora por dentista por ano
app.post('/api/producao/dentista/custo-hora', requireAuth, requireProducao, async (req, res) => {
  const { dentist_person_id, dentist_name, ano, custo_hora } = req.body;
  if (!dentist_person_id || !ano || custo_hora == null) {
    return res.status(400).json({ error: 'dentist_person_id, ano e custo_hora obrigatórios' });
  }
  try {
    const { error } = await supabase.from('dentista_custo_hora').upsert({
      dentist_person_id: String(dentist_person_id),
      dentist_name:      dentist_name || null,
      ano:               parseInt(ano),
      custo_hora:        Number(custo_hora),
      atualizado_em:     new Date().toISOString(),
    }, { onConflict: 'dentist_person_id,ano' });
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    console.error('[producao/dentista/custo-hora]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Salvar horas manuais por dentista por mês
app.post('/api/producao/dentista/horas-manual', requireAuth, requireProducao, async (req, res) => {
  const { dentist_person_id, dentist_name, ano, mes, horas } = req.body;
  if (!dentist_person_id || !ano || !mes || horas == null) {
    return res.status(400).json({ error: 'dentist_person_id, ano, mes e horas obrigatórios' });
  }
  try {
    const { error } = await supabase.from('dentista_horas_manual').upsert({
      dentist_person_id: String(dentist_person_id),
      dentist_name:      dentist_name || null,
      ano:               parseInt(ano),
      mes:               parseInt(mes),
      horas:             Number(horas),
      atualizado_em:     new Date().toISOString(),
    }, { onConflict: 'dentist_person_id,ano,mes' });
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    console.error('[producao/dentista/horas-manual]', e.message);
    res.status(500).json({ error: e.message });
  }
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
  // Disparos: campanhas 'enviando' orfas (restart no meio) viram 'pausada' p/ Retomar.
  disparoRunner.recuperarOrfas(supabase).catch(e => console.error('recuperarOrfas:', e.message));
});

