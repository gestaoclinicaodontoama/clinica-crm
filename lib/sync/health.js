// Saúde dos syncs — funções puras sobre linhas do sync_log.
// Fase 1: Clinicorp (02h) + Social Media (03:15). Espelha lib/capi/health.js.
const TZ = 'America/Sao_Paulo';

const JOBS = [
  { id: 'clinicorp', label: 'Sync Clinicorp (02h)',
    ehDoJob: t => !String(t || '').startsWith('social-media'),
    janelaHHMM: '02:00', margemMin: 120 },
  { id: 'social', label: 'Social Media (03:15)',
    ehDoJob: t => String(t || '').startsWith('social-media'),
    janelaHHMM: '03:15', margemMin: 120 },
];

const LIMITES = { tipicoMin: 3, fracaoAbaixo: 0.40, travadoMin: 120, historico: 60 };

function parseStep(v) {
  if (typeof v === 'number') return { tipo: 'num', n: v };
  const s = String(v == null ? '' : v).trim();
  if (s.startsWith('erro')) return { tipo: 'erro', msg: s };
  if (/^\d/.test(s)) return { tipo: 'num', n: parseInt(s.match(/\d+/)[0], 10) };
  return { tipo: 'neutro', msg: s };
}

function mediana(nums) {
  if (!nums || !nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// rows chegam em ordem desc por started_at; a ordem é preservada.
function separarPorJob(rows) {
  const porJob = {};
  for (const j of JOBS) porJob[j.id] = [];
  for (const r of rows || []) {
    const j = JOBS.find(j => j.ehDoJob(r.trigger));
    if (j) porJob[j.id].push(r);
  }
  return porJob;
}

const completa = r => !!(r && r.finished_at && r.steps && typeof r.steps === 'object');

function tipicoPorFase(rowsCompletas) {
  const porFase = {};
  for (const r of rowsCompletas || []) {
    for (const [fase, v] of Object.entries(r.steps || {})) {
      const p = parseStep(v);
      if (p.tipo !== 'num') continue;
      (porFase[fase] = porFase[fase] || []).push(p.n);
    }
  }
  const out = {};
  for (const [fase, ns] of Object.entries(porFase)) out[fase] = mediana(ns);
  return out;
}

function classificarFases(ultima, tipico) {
  const out = [];
  const fases = new Set([...Object.keys((ultima && ultima.steps) || {}), ...Object.keys(tipico || {})]);
  for (const fase of fases) {
    const t = tipico && tipico[fase] != null ? tipico[fase] : null;
    if (!ultima || !ultima.steps || !(fase in ultima.steps)) {
      out.push({ fase, hoje: null, tipico: t, status: 'sumiu' });
      continue;
    }
    const p = parseStep(ultima.steps[fase]);
    if (p.tipo === 'erro') { out.push({ fase, hoje: null, tipico: t, status: 'erro', msg: p.msg }); continue; }
    if (p.tipo === 'neutro') { out.push({ fase, hoje: p.msg, tipico: t, status: 'neutro' }); continue; }
    if (t == null || t < LIMITES.tipicoMin) { out.push({ fase, hoje: p.n, tipico: t, status: 'neutro' }); continue; }
    if (p.n === 0) { out.push({ fase, hoje: 0, tipico: t, status: 'zerou' }); continue; }
    if (p.n < t * LIMITES.fracaoAbaixo) { out.push({ fase, hoje: p.n, tipico: t, status: 'abaixo' }); continue; }
    out.push({ fase, hoje: p.n, tipico: t, status: 'ok' });
  }
  return out;
}

function inicioJanelaHoje(hhmm, agora) {
  const ymd = agora.toLocaleDateString('en-CA', { timeZone: TZ });
  return new Date(`${ymd}T${hhmm}:00-03:00`);
}

function estadoJob(rowsJob, jobDef, agora) {
  const ultima = (rowsJob && rowsJob[0]) || null;
  const ultimaCompleta = (rowsJob || []).find(completa) || null;
  if (ultima && !ultima.finished_at &&
      agora.getTime() - new Date(ultima.started_at).getTime() > LIMITES.travadoMin * 60000) {
    return { status: 'travou', ultima, ultimaCompleta };
  }
  const janela = inicioJanelaHoje(jobDef.janelaHHMM, agora);
  const limite = new Date(janela.getTime() + jobDef.margemMin * 60000);
  if (agora >= limite) {
    const rodouHoje = (rowsJob || []).some(r => new Date(r.started_at) >= janela);
    if (!rodouHoje) return { status: 'nao_rodou', ultima, ultimaCompleta };
  }
  if (ultimaCompleta && ultimaCompleta.ok === false) return { status: 'falhou', ultima, ultimaCompleta };
  return { status: 'ok', ultima, ultimaCompleta };
}

function avaliarGatilhosSync(rows, agora = new Date()) {
  const porJob = separarPorJob(rows);
  const out = [];
  for (const job of JOBS) {
    const rowsJob = porJob[job.id];
    const est = estadoJob(rowsJob, job, agora);
    out.push({
      gatilho: 'sync_falha', escopo: job.id,
      status: (est.status === 'falhou' || est.status === 'travou') ? 'ruim' : 'ok',
      detalhe: { estado: est.status, error: (est.ultimaCompleta && est.ultimaCompleta.error) || null },
    });
    out.push({
      gatilho: 'sync_nao_rodou', escopo: job.id,
      status: est.status === 'nao_rodou' ? 'ruim' : 'ok',
      detalhe: { estado: est.status },
    });
    const completas = rowsJob.filter(completa);
    const ultima = completas[0];
    if (ultima) {
      const tipico = tipicoPorFase(completas.slice(1)); // exclui a própria rodada avaliada
      for (const f of classificarFases(ultima, tipico)) {
        const ruim = ['erro', 'zerou', 'abaixo'].includes(f.status);
        out.push({
          gatilho: 'sync_fase', escopo: job.id + ':' + f.fase,
          status: ruim ? 'ruim' : 'ok',
          detalhe: { hoje: f.hoje, tipico: f.tipico, status: f.status, msg: f.msg || null },
        });
      }
    }
  }
  return out;
}

function montarSaude(rows, agora = new Date()) {
  const porJob = separarPorJob(rows);
  const jobs = [];
  for (const job of JOBS) {
    const rowsJob = porJob[job.id];
    const est = estadoJob(rowsJob, job, agora);
    const completas = rowsJob.filter(completa);
    const ultima = completas[0] || null;
    const tipico = tipicoPorFase(completas.slice(1));
    const fases = ultima ? classificarFases(ultima, tipico) : [];
    const corte7 = new Date(agora.getTime() - 7 * 86400000);
    const erros = rowsJob
      .filter(r => r.error && new Date(r.started_at) >= corte7)
      .map(r => ({ quando: r.started_at, msg: r.error }))
      .slice(0, 10);
    jobs.push({
      id: job.id, label: job.label, estado: est.status,
      ultima: ultima ? { quando: ultima.started_at, ok: ultima.ok, duracao_s: ultima.duration_s, trigger: ultima.trigger } : null,
      fases, erros,
      historico: rowsJob.slice(0, 7).map(r => ({ quando: r.started_at, ok: r.ok, duracao_s: r.duration_s, trigger: r.trigger })),
    });
  }
  return { jobs, atualizadoEm: agora.toISOString() };
}

module.exports = {
  TZ, JOBS, LIMITES, parseStep, mediana, separarPorJob, completa, tipicoPorFase,
  classificarFases, inicioJanelaHoje, estadoJob, avaliarGatilhosSync, montarSaude,
};
