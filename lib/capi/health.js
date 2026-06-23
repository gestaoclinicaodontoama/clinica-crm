const EVENTOS = ['LeadSubmitted', 'LeadQualified', 'Schedule', 'Contact', 'Purchase'];
const TZ = 'America/Sao_Paulo';

function normalizar(le) {
  const m = le.metadata || {};
  const ud = (m.payload_enviado && m.payload_enviado.user_data) || {};
  const as = m.action_source || '';
  return {
    ts: new Date(le.criado_em),
    evento: m.evento || null,
    sucesso: m.sucesso === true || m.sucesso === 'true',
    httpStatus: m.http_status ? Number(m.http_status) : null,
    subcode: (m.resposta_meta && m.resposta_meta.error && m.resposta_meta.error.error_subcode)
      ? String(m.resposta_meta.error.error_subcode) : null,
    pageId: ud.page_id || null,
    isCTWA: as === 'business_messaging' || as === 'system_generated',
    has: {
      telefone: !!ud.ph, email: !!ud.em, nome: !!ud.fn,
      ctwa_clid: !!ud.ctwa_clid, page_id: !!ud.page_id,
    },
  };
}

// Segunda-feira 00:00 BRT da semana que contém `d`.
function inicioSemana(d) {
  const ymd = d.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD no fuso BRT
  const base = new Date(`${ymd}T00:00:00-03:00`);
  const dow = (base.getDay() + 6) % 7; // 0 = segunda
  return new Date(base.getTime() - dow * 86400000);
}

function _bucket() { return { enviados: 0, sucesso: 0, falha: 0 }; }
function _add(acc, r) { acc.enviados++; r.sucesso ? acc.sucesso++ : acc.falha++; }

function contagensPorSemana(rows, agora = new Date()) {
  const ini = inicioSemana(agora);
  const iniAnt = new Date(ini.getTime() - 7 * 86400000);
  const atual = {}, anterior = {};
  for (const e of EVENTOS) { atual[e] = _bucket(); anterior[e] = _bucket(); }
  for (const r of rows) {
    if (!EVENTOS.includes(r.evento)) continue;
    if (r.ts >= ini) _add(atual[r.evento], r);
    else if (r.ts >= iniAnt && r.ts < ini) _add(anterior[r.evento], r);
  }
  return { atual, anterior };
}

function coberturaMatch(rows) {
  const tot = rows.length || 1;
  const ctwa = rows.filter(r => r.isCTWA);
  const totC = ctwa.length || 1;
  const pct = (n, d) => Math.round((n / d) * 100);
  return {
    telefone: pct(rows.filter(r => r.has.telefone).length, tot),
    email: pct(rows.filter(r => r.has.email).length, tot),
    nome: pct(rows.filter(r => r.has.nome).length, tot),
    ctwa_clid: pct(ctwa.filter(r => r.has.ctwa_clid).length, totC),
    page_id: pct(ctwa.filter(r => r.has.page_id).length, totC),
  };
}

function totais7d(rows, agora = new Date()) {
  const corte = new Date(agora.getTime() - 7 * 86400000);
  const r7 = rows.filter(r => r.ts >= corte);
  const porPagina = {};
  let sucesso = 0, falha = 0;
  for (const r of r7) {
    r.sucesso ? sucesso++ : falha++;
    const k = r.pageId || '(sem página)';
    porPagina[k] = porPagina[k] || { sucesso: 0, falha: 0 };
    r.sucesso ? porPagina[k].sucesso++ : porPagina[k].falha++;
  }
  return { total: r7.length, sucesso, falha, porPagina };
}

const LIMITES = {
  taxaFalha: { janelaH: 6, minTentativas: 10, max: 0.30 },
  silencio:  { janelaH: 18, baselineDias: 7, minMediaDia: 3 },
  erroNovo:  { janelaH: 24, historicoDias: 14 },
  quedaVolume: { semanas: 3, fracaoMin: 0.50 },
};

const _desde = (agora, horas) => new Date(agora.getTime() - horas * 3600000);

function _taxaFalha(rows, agora) {
  const r = rows.filter(x => x.ts >= _desde(agora, LIMITES.taxaFalha.janelaH));
  const det = { tentativas: r.length, falhas: r.filter(x => !x.sucesso).length };
  det.taxa = r.length ? det.falhas / r.length : 0;
  const ruim = r.length >= LIMITES.taxaFalha.minTentativas && det.taxa > LIMITES.taxaFalha.max;
  return { gatilho: 'taxa_falha', escopo: null, status: ruim ? 'ruim' : 'ok', detalhe: det };
}

function _silencio(rows, agora) {
  const { baselineDias, minMediaDia, janelaH } = LIMITES.silencio;
  const corteJanela = _desde(agora, janelaH);
  const ini = new Date(corteJanela.getTime() - baselineDias * 24 * 3600000);
  const porPagina = {};
  for (const r of rows) {
    if (!r.pageId) continue;
    porPagina[r.pageId] = porPagina[r.pageId] || { baselineSucesso: 0, janelaSucesso: 0 };
    if (r.sucesso && r.ts >= ini && r.ts < corteJanela) porPagina[r.pageId].baselineSucesso++;
    if (r.sucesso && r.ts >= corteJanela) porPagina[r.pageId].janelaSucesso++;
  }
  const out = [];
  for (const [page, d] of Object.entries(porPagina)) {
    const ativa = d.baselineSucesso / baselineDias >= minMediaDia;
    if (!ativa) continue;
    const ruim = d.janelaSucesso === 0;
    out.push({ gatilho: 'silencio', escopo: page, status: ruim ? 'ruim' : 'ok', detalhe: { page, ...d } });
  }
  return out;
}

function _erroNovo(rows, agora) {
  const { janelaH, historicoDias } = LIMITES.erroNovo;
  const corte = _desde(agora, janelaH);
  const iniHist = _desde(agora, historicoDias * 24);
  const hist = new Set(rows.filter(r => r.subcode && r.ts >= iniHist && r.ts < corte).map(r => r.subcode));
  const novos = [...new Set(rows.filter(r => r.subcode && r.ts >= corte).map(r => r.subcode))].filter(s => !hist.has(s));
  return { gatilho: 'erro_novo', escopo: null, status: novos.length ? 'ruim' : 'ok', detalhe: { novos } };
}

function _quedaVolume(rows, agora) {
  const { semanas, fracaoMin } = LIMITES.quedaVolume;
  const diaMs = 86400000;
  const hojeSucesso = rows.filter(r => r.sucesso && r.ts >= _desde(agora, 24)).length;
  const amostras = [];
  for (let k = 1; k <= semanas; k++) {
    const fim = new Date(agora.getTime() - k * 7 * diaMs);
    const ini = new Date(fim.getTime() - diaMs);
    amostras.push(rows.filter(r => r.sucesso && r.ts >= ini && r.ts < fim).length);
  }
  if (amostras.length < 2) return { gatilho: 'queda_volume', escopo: null, status: 'ok', detalhe: { motivo: 'sem histórico' } };
  const media = amostras.reduce((a, b) => a + b, 0) / amostras.length;
  const ruim = media > 0 && hojeSucesso < media * fracaoMin;
  return { gatilho: 'queda_volume', escopo: null, status: ruim ? 'ruim' : 'ok', detalhe: { hojeSucesso, media: Math.round(media) } };
}

function avaliarGatilhos(rows, agora = new Date()) {
  return [
    _taxaFalha(rows, agora),
    ..._silencio(rows, agora),
    _erroNovo(rows, agora),
    _quedaVolume(rows, agora),
  ];
}

const COOLDOWN_H = 12;

function fingerprint(e) {
  // só campos estáveis do problema, sem números que oscilam a cada tick
  if (e.gatilho === 'erro_novo') return 'erro_novo:' + (e.detalhe.novos || []).join(',');
  return e.gatilho + ':' + (e.escopo || '');
}

function decidirAlertas(atuais, salvos, agora = new Date()) {
  const mapaSalvo = new Map(salvos.map(s => [s.gatilho + '|' + (s.escopo || ''), s]));
  const notificar = [], upserts = [];
  for (const e of atuais) {
    const chave = e.gatilho + '|' + (e.escopo || '');
    const prev = mapaSalvo.get(chave);
    const fp = fingerprint(e);
    if (e.status === 'ok') {
      if (prev && prev.status === 'alertado') upserts.push({ ...base(e, fp), status: 'ok', ultimo_alerta_em: prev.ultimo_alerta_em || null });
      continue;
    }
    // status ruim
    const eraAlertado = prev && prev.status === 'alertado' && prev.fingerprint === fp;
    const dentroCooldown = eraAlertado && prev.ultimo_alerta_em &&
      (agora.getTime() - new Date(prev.ultimo_alerta_em).getTime()) < COOLDOWN_H * 3600000;
    if (dentroCooldown) {
      upserts.push({ ...base(e, fp), status: 'alertado', ultimo_alerta_em: prev.ultimo_alerta_em });
    } else {
      notificar.push({ gatilho: e.gatilho, escopo: e.escopo || null, detalhe: e.detalhe, fingerprint: fp });
      upserts.push({ ...base(e, fp), status: 'alertado', ultimo_alerta_em: agora.toISOString() });
    }
  }
  return { notificar, upserts };
}
function base(e, fp) { return { gatilho: e.gatilho, escopo: e.escopo || null, fingerprint: fp, detalhe: e.detalhe }; }

module.exports = { EVENTOS, TZ, normalizar, inicioSemana, contagensPorSemana, coberturaMatch, totais7d, LIMITES, avaliarGatilhos, decidirAlertas, fingerprint, COOLDOWN_H };
