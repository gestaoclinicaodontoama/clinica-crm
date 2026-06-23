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

module.exports = { EVENTOS, TZ, normalizar, inicioSemana, contagensPorSemana, coberturaMatch, totais7d };
