import { AvaliacaoApp } from './state.js';
import { get, patch, post } from './api.js';
import { showToast, showModal, formatDate } from './ui.js';

const PAGE_SIZE = 50;

let _offset = 0;
let _total = 0;
let _items = [];

// Filter state
let _filterDentistaId = '';
let _filterDesde = '';
let _filterAte = '';

// Dentistas cache (gestor/admin only)
let _dentistas = null;

function formatDateOnly(iso) {
  if (!iso) return '—';
  // iso may be YYYY-MM-DD or a full ISO string
  const part = iso.slice(0, 10);
  const [y, m, d] = part.split('-');
  return `${d}/${m}/${y}`;
}

function buildQueryUrl(limit, offset) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (_filterDentistaId) params.set('dentista_id', _filterDentistaId);
  if (_filterDesde) params.set('desde', _filterDesde);
  if (_filterAte) params.set('ate', _filterAte);
  return `/avaliacoes?${params.toString()}`;
}

function isGestorUser() {
  const roles = AvaliacaoApp.user?.roles ?? [];
  return roles.includes('gestor') || roles.includes('admin');
}

async function loadDentistas() {
  if (_dentistas) return _dentistas;
  try {
    _dentistas = await get('/avaliacoes/dentistas');
  } catch (_) {
    _dentistas = [];
  }
  return _dentistas;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function notaCor(nota) {
  if (nota == null) return 'var(--muted)';
  if (nota >= 7) return 'var(--green)';
  if (nota >= 5) return 'var(--yellow)';
  return 'var(--red)';
}

function modoBadge(modo) {
  const map = { deepgram: 'Microfone', audio: 'Upload', texto: 'Texto' };
  return map[modo] ?? modo ?? '—';
}

function isDono(consulta) {
  const uid = AvaliacaoApp.user?.id;
  return uid && consulta.dentista_id === uid;
}

function hasCRCContent(c) {
  if (!c) return false;
  if (typeof c === 'string') return c.trim().length > 0;
  return Object.values(c).some(v =>
    v !== undefined && v !== null &&
    (Array.isArray(v) ? v.length > 0 : String(v).trim().length > 0)
  );
}

function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  } else {
    legacyCopy(text);
  }
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (_) {}
  ta.remove();
}

function etapasParaTexto(etapas) {
  return etapas.map(e =>
    `${e.nome} — ${e.nota?.toFixed(1) ?? '—'}\n` +
    `${e.feedback ?? ''}\n` +
    (e.melhoria ? `↑ Melhoria: ${e.melhoria}` : '')
  ).join('\n\n');
}

function crcComercialParaTexto(c) {
  if (!c || typeof c === 'string') return c ?? '';
  const lines = [
    c.paciente && `Paciente: ${c.paciente}`,
    c.contato && `Contato: ${c.contato}`,
    c.queixa_principal && `Queixa principal: ${c.queixa_principal}`,
    c.tratamento_proposto && `Tratamento proposto: ${c.tratamento_proposto}`,
    c.valor && `Valor: ${c.valor}`,
    c.poder_de_compra && `Poder de compra: ${c.poder_de_compra}`,
    c.abordagem_followup && `Abordagem follow-up: ${c.abordagem_followup}`,
    c.objecoes?.length && `Objeções levantadas:\n${c.objecoes.map(o => `• ${o}`).join('\n')}`,
    c.gatilhos_emocionais?.length && `Gatilhos emocionais:\n${c.gatilhos_emocionais.map(g => `• ${g}`).join('\n')}`,
  ].filter(Boolean);
  return lines.join('\n\n');
}

function crcSucessoParaTexto(s) {
  if (!s || typeof s === 'string') return s ?? '';
  const lines = [
    s.resumo_clinico && `Resumo clínico: ${s.resumo_clinico}`,
    s.jornada_paciente && `Jornada do paciente: ${s.jornada_paciente}`,
    s.como_garantir_boa_experiencia && `Como garantir boa experiência: ${s.como_garantir_boa_experiencia}`,
    s.plano_de_fases?.length && `Plano de fases:\n${s.plano_de_fases.map(f => `• ${f}`).join('\n')}`,
    s.pontos_atencao_emocional?.length && `Pontos de atenção emocional:\n${s.pontos_atencao_emocional.map(p => `• ${p}`).join('\n')}`,
  ].filter(Boolean);
  return lines.join('\n\n');
}

function renderCRCComercialHtml(c) {
  if (!c) return '';
  if (typeof c === 'string') {
    return `<p style="font-size:13px;color:var(--text);line-height:1.6;white-space:pre-wrap">${escHtml(c)}</p>`;
  }
  const topic = (label, val) => {
    if (!val && val !== 0) return '';
    return `<div style="margin-bottom:12px;display:flex;gap:8px;align-items:flex-start">
      <span style="color:var(--accent);flex-shrink:0;font-size:16px;line-height:1.15;margin-top:-1px">•</span>
      <div>
        <div style="font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-bottom:2px">${label}</div>
        <div style="font-size:13px;color:var(--text);line-height:1.5">${escHtml(String(val))}</div>
      </div>
    </div>`;
  };
  const topicList = (label, arr) => {
    if (!arr?.length) return '';
    const items = arr.map(i => `<div style="display:flex;gap:6px;align-items:flex-start;margin-bottom:3px">
        <span style="color:var(--muted);flex-shrink:0;font-size:13px;line-height:1.4">›</span>
        <div style="font-size:13px;color:var(--text);line-height:1.5">${escHtml(String(i))}</div>
      </div>`).join('');
    return `<div style="margin-bottom:12px;display:flex;gap:8px;align-items:flex-start">
      <span style="color:var(--accent);flex-shrink:0;font-size:16px;line-height:1.15;margin-top:-1px">•</span>
      <div>
        <div style="font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-bottom:6px">${label}</div>
        ${items}
      </div>
    </div>`;
  };
  return [
    topic('Paciente', c.paciente),
    topic('Contato', c.contato),
    topic('Queixa principal', c.queixa_principal),
    topic('Tratamento proposto', c.tratamento_proposto),
    topic('Valor', c.valor),
    topic('Poder de compra', c.poder_de_compra),
    topic('Abordagem follow-up', c.abordagem_followup),
    topicList('Objeções levantadas', c.objecoes),
    topicList('Gatilhos emocionais', c.gatilhos_emocionais),
  ].join('');
}

function renderCRCSucessoHtml(s) {
  if (!s) return '';
  if (typeof s === 'string') {
    return `<p style="font-size:13px;color:var(--text);line-height:1.6;white-space:pre-wrap">${escHtml(s)}</p>`;
  }
  const topic = (label, val) => {
    if (!val && val !== 0) return '';
    return `<div style="margin-bottom:12px;display:flex;gap:8px;align-items:flex-start">
      <span style="color:var(--accent);flex-shrink:0;font-size:16px;line-height:1.15;margin-top:-1px">•</span>
      <div>
        <div style="font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-bottom:2px">${label}</div>
        <div style="font-size:13px;color:var(--text);line-height:1.5">${escHtml(String(val))}</div>
      </div>
    </div>`;
  };
  const topicList = (label, arr) => {
    if (!arr?.length) return '';
    const items = arr.map(i => `<div style="display:flex;gap:6px;align-items:flex-start;margin-bottom:3px">
        <span style="color:var(--muted);flex-shrink:0;font-size:13px;line-height:1.4">›</span>
        <div style="font-size:13px;color:var(--text);line-height:1.5">${escHtml(String(i))}</div>
      </div>`).join('');
    return `<div style="margin-bottom:12px;display:flex;gap:8px;align-items:flex-start">
      <span style="color:var(--accent);flex-shrink:0;font-size:16px;line-height:1.15;margin-top:-1px">•</span>
      <div>
        <div style="font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-bottom:6px">${label}</div>
        ${items}
      </div>
    </div>`;
  };
  return [
    topic('Resumo clínico', s.resumo_clinico),
    topic('Jornada do paciente', s.jornada_paciente),
    topic('Como garantir boa experiência', s.como_garantir_boa_experiencia),
    topicList('Plano de fases', s.plano_de_fases),
    topicList('Pontos de atenção emocional', s.pontos_atencao_emocional),
  ].join('');
}

function transcriptParaTexto(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) return '';
  return transcript.map(t => `${t.speaker_label}: ${t.text}`).join('\n\n');
}

function baixarTranscriptPDF(c, transcript) {
  const win = window.open('', '_blank');
  if (!win) { showToast('Popup bloqueado. Permita popups neste site para baixar.', 'warning'); return; }
  const turnsHtml = transcript.map(t => `
    <div style="margin-bottom:14px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;
                  color:${t.speaker_label === 'DENTISTA' ? '#6366f1' : '#9ca3af'};margin-bottom:3px">
        ${escHtml(t.speaker_label)}
      </div>
      <div style="font-size:13px;color:#111827;line-height:1.6">${escHtml(t.text)}</div>
    </div>`).join('');
  win.document.open('text/html', 'replace');
  win.document.write(`<!DOCTYPE html><html lang="pt-BR"><head>
    <meta charset="utf-8">
    <title>Transcrição — ${escHtml(c.paciente_nome ?? '—')}</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; background: #fff; color: #111827; }
      .page { max-width: 780px; margin: 0 auto; padding: 40px 32px; }
      h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
      .sub { font-size: 13px; color: #6b7280; margin-bottom: 28px; border-bottom: 1px solid #e5e7eb; padding-bottom: 16px; }
      @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
    </style>
  </head><body><div class="page">
    <h1>Transcrição da Consulta</h1>
    <div class="sub">${escHtml(c.paciente_nome ?? '—')} · ${formatDate(c.created_at)} · ${modoBadge(c.modo)}</div>
    ${turnsHtml}
  </div></body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
}

function copyBtnHtml(id, label = 'Copiar') {
  return `<button id="${id}" title="${label}" aria-label="${label}"
    style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:6px;
           background:var(--bg3);border:1px solid var(--border);color:var(--muted);
           font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit;flex-shrink:0">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>${label}
  </button>`;
}

function flashCopyBtn(id) {
  const btn = document.getElementById(id);
  if (!btn) return;
  const orig = btn.innerHTML;
  btn.innerHTML = btn.innerHTML.replace(/Copiar/, '✓ Copiado');
  btn.style.color = 'var(--green)';
  setTimeout(() => {
    const current = document.getElementById(id);
    if (current) { current.innerHTML = orig; current.style.color = ''; }
  }, 2000);
}

function imprimirRelatorio(c) {
  const analysis = c.analysis ?? {};
  const etapas = analysis.etapas ?? [];
  const relatorios = analysis.relatorios ?? {};
  const com = relatorios.comercial;
  const suc = relatorios.sucesso;

  const etapasHtml = etapas.map(e => {
    const cor = e.nota >= 7 ? '#22c55e' : e.nota >= 5 ? '#eab308' : '#ef4444';
    const pct = ((e.nota ?? 0) / 10) * 100;
    return `
      <div style="padding:10px 0;border-bottom:1px solid #e5e7eb">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:5px">
          <span style="font-size:11px;font-family:monospace;width:100px;flex-shrink:0;color:#6b7280">${escHtml(e.nome)}</span>
          <div style="flex:1;height:5px;background:#f3f4f6;border-radius:999px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${cor};border-radius:999px"></div>
          </div>
          <span style="font-family:monospace;font-size:13px;width:28px;text-align:right;color:${cor};font-weight:700">${e.nota?.toFixed(1) ?? '—'}</span>
        </div>
        <div style="font-size:12px;color:#374151;line-height:1.5">${escHtml(e.feedback ?? '')}</div>
        ${e.melhoria ? `<div style="font-size:12px;color:#2563eb;line-height:1.5;margin-top:4px">↑ ${escHtml(e.melhoria)}</div>` : ''}
      </div>`;
  }).join('');

  const printField = (label, val) => {
    if (!val) return '';
    return `<div style="margin-bottom:12px;display:flex;gap:8px;align-items:flex-start">
      <span style="color:#6366f1;flex-shrink:0;font-size:16px;line-height:1.15;margin-top:-1px">•</span>
      <div>
        <div style="font-size:9.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#9ca3af;margin-bottom:2px">${label}</div>
        <div style="font-size:13px;color:#111827;line-height:1.5">${escHtml(String(val))}</div>
      </div>
    </div>`;
  };

  const printList = (label, arr) => {
    if (!arr?.length) return '';
    const items = arr.map(i => `<div style="display:flex;gap:6px;align-items:flex-start;margin-bottom:3px">
        <span style="color:#9ca3af;flex-shrink:0;font-size:13px;line-height:1.4">›</span>
        <div style="font-size:13px;color:#111827;line-height:1.5">${escHtml(String(i))}</div>
      </div>`).join('');
    return `<div style="margin-bottom:12px;display:flex;gap:8px;align-items:flex-start">
      <span style="color:#6366f1;flex-shrink:0;font-size:16px;line-height:1.15;margin-top:-1px">•</span>
      <div>
        <div style="font-size:9.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#9ca3af;margin-bottom:6px">${label}</div>
        ${items}
      </div>
    </div>`;
  };

  const comHtml = hasCRCContent(com) ? (typeof com === 'string'
    ? `<p style="font-size:13px;color:#111827;line-height:1.6;white-space:pre-wrap">${escHtml(com)}</p>`
    : [
        printField('Paciente', com.paciente),
        printField('Contato', com.contato),
        printField('Queixa principal', com.queixa_principal),
        printField('Tratamento proposto', com.tratamento_proposto),
        printField('Valor', com.valor),
        printField('Poder de compra', com.poder_de_compra),
        printField('Abordagem follow-up', com.abordagem_followup),
        printList('Objeções levantadas', com.objecoes),
        printList('Gatilhos emocionais', com.gatilhos_emocionais),
      ].join('')
  ) : '';

  const sucHtml = hasCRCContent(suc) ? (typeof suc === 'string'
    ? `<p style="font-size:13px;color:#111827;line-height:1.6;white-space:pre-wrap">${escHtml(suc)}</p>`
    : [
        printField('Resumo clínico', suc.resumo_clinico),
        printField('Jornada do paciente', suc.jornada_paciente),
        printField('Como garantir boa experiência', suc.como_garantir_boa_experiencia),
        printList('Plano de fases', suc.plano_de_fases),
        printList('Pontos de atenção emocional', suc.pontos_atencao_emocional),
      ].join('')
  ) : '';

  const notaCor2 = c.nota_final == null ? '#9ca3af' : c.nota_final >= 7 ? '#22c55e' : c.nota_final >= 5 ? '#eab308' : '#ef4444';

  const win = window.open('', '_blank');
  if (!win) {
    showToast('Popup bloqueado. Permita popups neste site para imprimir.', 'warning');
    return;
  }
  win.document.open('text/html', 'replace');
  win.document.write(`<!DOCTYPE html><html lang="pt-BR"><head>
    <meta charset="utf-8">
    <title>Copiloto SPIN — Relatório da Consulta</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; background: #fff; color: #111827; }
      .page { max-width: 780px; margin: 0 auto; padding: 40px 32px; }
      h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
      .sub { font-size: 13px; color: #6b7280; margin-bottom: 28px; }
      .section { border: 1px solid #e5e7eb; border-radius: 10px; padding: 18px; margin-bottom: 20px; }
      .section-title { font-size: 13px; font-weight: 700; margin-bottom: 14px; display: flex; align-items: center; gap: 6px; }
      .nota-badge { font-family: monospace; font-size: 38px; font-weight: 700; float: right; color: ${notaCor2}; margin-top:-4px }
      .veredito { font-size: 13px; line-height: 1.6; color: #374151; margin-bottom: 20px; }
      @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
    </style>
  </head><body><div class="page">
    <h1>Copiloto SPIN — Relatório da Consulta</h1>
    <div class="sub">${escHtml(c.paciente_nome ?? '—')} · ${formatDate(c.created_at)}</div>
    ${analysis.veredito ? `<div class="veredito">${escHtml(analysis.veredito)}</div>` : ''}
    ${etapas.length ? `
    <div class="section">
      <div class="section-title">NOTAS POR ETAPA
        <span class="nota-badge">${c.nota_final?.toFixed(1) ?? '—'}</span>
      </div>
      ${etapasHtml}
    </div>` : ''}
    ${comHtml ? `<div class="section"><div class="section-title">📋 Relatório CRC Comercial</div>${comHtml}</div>` : ''}
    ${sucHtml ? `<div class="section"><div class="section-title">🌟 Relatório CRC Sucesso do Cliente</div>${sucHtml}</div>` : ''}
  </div></body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
}

function renderList() {
  const root = document.getElementById('hist-list');
  if (!root) return;

  if (_items.length === 0) {
    root.innerHTML = `<div style="padding:32px;text-align:center;font-size:13px;color:var(--muted)">Nenhuma consulta encontrada.</div>`;
    return;
  }

  const isGestor = isGestorUser();
  root.innerHTML = _items.map((c, idx) => {
    const nota = c.nota_final;
    const cor = notaCor(nota);
    const seloOrfa = c.orfa ? ' <span style="font-size:10px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:1px 6px;color:var(--muted)">sem vínculo</span>' : '';
    const btnAtribuir = (isGestor && c.orfa)
      ? `<button onclick="event.stopPropagation();window._avdAtribuir('${escHtml(c.id)}')" style="padding:4px 10px;border-radius:8px;background:var(--accent);color:#fff;border:none;font-size:11px;cursor:pointer;flex-shrink:0">Atribuir</button>`
      : '';
    const dataExib = c.data_consulta ? formatDateOnly(c.data_consulta) : formatDate(c.created_at);
    const dentistaNome = escHtml(c.dentista_nome ?? '—');
    return `
      <div
        class="hist-row"
        data-idx="${idx}"
        tabindex="0"
        role="button"
        aria-label="Ver detalhe da consulta de ${escHtml(c.paciente_nome ?? '—')} em ${dataExib}"
        style="display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .12s"
        onmouseenter="this.style.background='var(--bg3)'"
        onmouseleave="this.style.background=''"
        onkeydown="if(event.key==='Enter'||event.key===' ')window._histDetalhe(${idx})"
        onclick="window._histDetalhe(${idx})"
      >
        <div style="font-family:'DM Mono',monospace;font-size:20px;font-weight:700;color:${cor};width:48px;text-align:center;flex-shrink:0">
          ${nota != null ? nota.toFixed(1) : '—'}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13.5px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:4px;flex-wrap:wrap">
            ${escHtml(c.paciente_nome ?? '—')}${seloOrfa}
          </div>
          <div style="font-size:11.5px;color:var(--muted);margin-top:2px;display:flex;gap:8px;flex-wrap:wrap">
            <span>${dataExib} · ${modoBadge(c.modo)}</span>
            ${c.dentista_nome ? `<span style="color:var(--text)">· ${dentistaNome}</span>` : ''}
          </div>
        </div>
        ${btnAtribuir}
      </div>`;
  }).join('');

  const more = document.getElementById('hist-load-more');
  if (more) more.style.display = (_offset < _total) ? 'block' : 'none';
}

async function loadMore() {
  const btn = document.getElementById('hist-load-more-btn');
  if (btn) btn.disabled = true;

  try {
    const data = await get(buildQueryUrl(PAGE_SIZE, _offset));
    _items = [..._items, ...(data.data ?? [])];
    _total = data.total ?? _items.length;
    _offset += (data.data ?? []).length;
    renderList();
  } catch (e) {
    showToast('Erro ao carregar histórico: ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderDetalhe(c) {
  const analysis = c.analysis ?? {};
  const etapas = analysis.etapas ?? [];
  const relatorios = analysis.relatorios ?? {};
  const crcCom = relatorios.comercial;
  const crcSuc = relatorios.sucesso;
  const transcript = Array.isArray(c.transcript) && c.transcript.length > 0 ? c.transcript : null;
  const roles = AvaliacaoApp.user?.roles ?? [];
  const podeEditar = isDono(c) || roles.includes('admin') || roles.includes('gestor');

  const _detalheCache = {};
  const etapasHtml = etapas.map((e, i) => {
    const cor = notaCor(e.nota);
    const pct = ((e.nota ?? 0) / 10) * 100;
    const hasTrechos = e.trechos?.length > 0;
    const hasDetalhe = e.detalhe?.momentos?.length > 0;

    const trechosSection = hasTrechos ? `
      <div id="hist-trechos-${i}" style="display:none;margin-top:8px;padding:8px 10px;background:var(--bg2);border-radius:8px;border:1px solid var(--border)">
        ${e.trechos.map(t => `<div style="font-size:11.5px;font-style:italic;color:var(--muted);border-left:2px solid var(--accent);padding-left:8px;margin-bottom:6px;line-height:1.5">"${escHtml(t)}"</div>`).join('')}
      </div>` : '';

    const detalheSection = hasDetalhe ? `
      <div id="hist-detalhe-${i}" style="margin-top:8px">
        ${e.detalhe.momentos.map(m => `
          <div style="margin-bottom:8px;padding:9px 10px;background:var(--bg2);border-radius:8px;border:1px solid var(--border)">
            <div style="font-size:11.5px;font-style:italic;color:var(--muted);border-left:2px solid var(--accent);padding-left:8px;margin-bottom:6px;line-height:1.5">"${escHtml(m.trecho ?? '')}"</div>
            <div style="font-size:12px;color:var(--red);margin-bottom:3px;line-height:1.4">⚠ ${escHtml(m.problema ?? '')}</div>
            <div style="font-size:12px;color:var(--green);line-height:1.4">✓ ${escHtml(m.alternativa ?? '')}</div>
          </div>`).join('')}
      </div>` : `<div id="hist-detalhe-${i}" style="display:none;margin-top:8px"></div>`;

    const btnTrechos = hasTrechos
      ? `<button id="hist-trechos-btn-${i}" onclick="window._histToggleTrechos(${i},${e.trechos.length})"
          style="background:none;border:none;cursor:pointer;font-size:11.5px;color:var(--muted);font-family:inherit;padding:2px 0;text-decoration:underline;text-underline-offset:2px">
          Ver trechos (${e.trechos.length})
        </button>` : '';

    const btnDetalhar = hasDetalhe
      ? `<button disabled style="padding:3px 10px;border-radius:6px;background:var(--bg2);border:1px solid var(--border);font-size:11.5px;color:var(--green);font-family:inherit;cursor:default">✓ Detalhado</button>`
      : `<button id="hist-btn-detalhar-${i}" onclick="window._histDetalharEtapa('${escHtml(c.id)}',${i})"
          style="padding:3px 10px;border-radius:6px;background:var(--bg2);border:1px solid var(--border);font-size:11.5px;color:var(--muted);font-family:inherit;cursor:pointer">
          🔍 Detalhar com IA
        </button>`;

    return `
      <div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:5px">
          <span style="font-size:11.5px;font-family:'DM Mono',monospace;width:100px;flex-shrink:0;color:var(--muted)">${escHtml(e.nome)}</span>
          <div style="flex:1;height:5px;background:var(--bg3);border-radius:999px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${cor};border-radius:999px"></div>
          </div>
          <span style="font-family:'DM Mono',monospace;font-size:13px;width:28px;text-align:right;color:${cor}">${e.nota?.toFixed(1) ?? '—'}</span>
        </div>
        <div style="font-size:12px;color:var(--text);line-height:1.5">${escHtml(e.feedback ?? '')}</div>
        ${e.melhoria ? `<div style="font-size:12px;color:var(--accent);line-height:1.5;margin-top:4px">↑ ${escHtml(e.melhoria)}</div>` : ''}
        <div style="display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap">
          ${btnTrechos}
          ${btnDetalhar}
        </div>
        ${trechosSection}
        ${detalheSection}
      </div>`;
  }).join('');

  const feedbackEl = c.feedback_ia
    ? `<div style="margin-top:14px;padding:12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;font-size:12.5px;color:var(--muted)">Feedback do dentista registrado.</div>`
    : podeEditar
      ? `<div id="hist-feedback-zone" style="margin-top:14px">
           <button onclick="window._histAbrirFeedback()" aria-label="Dar feedback à análise desta consulta" style="padding:8px 16px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);color:var(--text);font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit">Dar feedback à IA</button>
         </div>`
      : '';

  const crcEhFormatoAntigo = (hasCRCContent(crcCom) && typeof crcCom === 'string') ||
                              (hasCRCContent(crcSuc) && typeof crcSuc === 'string');

  const reAnalisarEl = podeEditar ? `
    <div style="margin-top:10px;padding:10px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div style="font-size:12px;color:var(--muted);line-height:1.4">${crcEhFormatoAntigo
        ? '⚠ Relatório CRC no formato antigo (texto corrido). Reanalisando, aparecerá em tópicos.'
        : 'Quer usar o novo formato de análise (Acolhimento, Anamnese…) nesta consulta?'}</div>
      <button id="hist-reanalisar-btn" onclick="window._histReanalisar()" aria-label="Reanalisar esta consulta com o formato atual"
        style="padding:6px 14px;border-radius:8px;${crcEhFormatoAntigo ? 'background:var(--accent);color:white' : 'background:var(--bg3);color:var(--text)'};border:1px solid var(--border);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">
        Reanalisar agora
      </button>
    </div>` : '';

  const html = `
    <div>
      <!-- Cabeçalho -->
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:18px">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <h2 id="avaliacao-modal-title" style="font-size:16px;font-weight:700;margin:0">${escHtml(c.paciente_nome ?? '—')}</h2>
            ${podeEditar ? `<button id="hist-edit-nome-btn" onclick="window._histEditarNome()" title="Editar nome" aria-label="Editar nome da paciente"
              style="background:none;border:none;cursor:pointer;padding:2px 4px;color:var(--muted);line-height:1;flex-shrink:0">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>` : ''}
          </div>
          <div style="font-size:12px;color:var(--muted)">${formatDate(c.created_at)} · ${modoBadge(c.modo)}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0">
          <div style="font-family:'DM Mono',monospace;font-size:36px;font-weight:700;color:${notaCor(c.nota_final)};line-height:1">
            ${c.nota_final != null ? c.nota_final.toFixed(1) : '—'}
          </div>
          <button onclick="window._imprimirRelatorio()" title="Imprimir relatório completo" aria-label="Imprimir relatório completo"
            style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:6px;background:var(--bg3);border:1px solid var(--border);color:var(--muted);font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
              <rect x="6" y="14" width="12" height="8"/>
            </svg>Imprimir
          </button>
        </div>
      </div>

      ${analysis.veredito ? `<p style="font-size:13px;line-height:1.5;margin-bottom:16px">${escHtml(analysis.veredito)}</p>` : ''}

      <!-- Etapas -->
      ${etapas.length ? `
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Notas por etapa</div>
          ${copyBtnHtml('hist-copy-etapas')}
        </div>
        ${etapasHtml}
      </div>` : ''}

      <!-- CRC Comercial -->
      ${hasCRCContent(crcCom) ? `
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div style="font-size:13px;font-weight:700">📋 Relatório CRC Comercial</div>
          ${copyBtnHtml('hist-copy-comercial')}
        </div>
        ${renderCRCComercialHtml(crcCom)}
      </div>` : ''}

      <!-- CRC Sucesso -->
      ${hasCRCContent(crcSuc) ? `
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div style="font-size:13px;font-weight:700">🌟 Relatório CRC Sucesso do Cliente</div>
          ${copyBtnHtml('hist-copy-sucesso')}
        </div>
        ${renderCRCSucessoHtml(crcSuc)}
      </div>` : ''}

      <!-- Transcrição -->
      ${transcript ? `
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;margin-bottom:14px;overflow:hidden">
        <button id="hist-transcript-toggle" onclick="window._histToggleTranscript()"
          style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:none;border:none;cursor:pointer;font-family:inherit;text-align:left">
          <div style="display:flex;align-items:center;gap:8px">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--muted);flex-shrink:0">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span style="font-size:13px;font-weight:600;color:var(--text)">Transcrição completa</span>
            <span style="font-size:11px;color:var(--muted)">(${transcript.length} falas)</span>
          </div>
          <svg id="hist-transcript-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" style="color:var(--muted);transition:transform .2s;flex-shrink:0">
            <path d="M6 9l6 6 6-6"/>
          </svg>
        </button>
        <div id="hist-transcript-body" style="display:none;padding:0 14px 14px">
          <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
            ${copyBtnHtml('hist-copy-transcript')}
            <button id="hist-pdf-transcript"
              style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:6px;
                     background:var(--bg3);border:1px solid var(--border);color:var(--muted);
                     font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit;flex-shrink:0">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
                <rect x="6" y="14" width="12" height="8"/>
              </svg>Baixar PDF
            </button>
          </div>
          <div style="max-height:320px;overflow-y:auto;padding-right:4px">
            ${transcript.map(t => `
              <div style="margin-bottom:10px;padding:8px 10px;background:var(--bg2);border-radius:8px;border-left:2px solid ${t.speaker_label === 'DENTISTA' ? 'var(--accent)' : 'var(--border)'}">
                <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${t.speaker_label === 'DENTISTA' ? 'var(--accent)' : 'var(--muted)'};margin-bottom:3px">
                  ${escHtml(t.speaker_label)}
                </div>
                <div style="font-size:12.5px;color:var(--text);line-height:1.55">${escHtml(t.text)}</div>
              </div>`).join('')}
          </div>
        </div>
      </div>` : ''}

      ${feedbackEl}
      ${reAnalisarEl}

      <div style="margin-top:18px">
        <button onclick="document.getElementById('avaliacao-modal-bg').classList.remove('open')"
          style="padding:9px 22px;border-radius:8px;background:var(--bg3);color:var(--text);border:1px solid var(--border);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit"
          aria-label="Fechar detalhe da consulta">Fechar</button>
      </div>
    </div>`;

  showModal(html);

  // Wire transcript
  window._histToggleTranscript = () => {
    const body = document.getElementById('hist-transcript-body');
    const arrow = document.getElementById('hist-transcript-arrow');
    if (!body) return;
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : '';
    if (arrow) arrow.style.transform = open ? '' : 'rotate(180deg)';
  };
  document.getElementById('hist-copy-transcript')?.addEventListener('click', () => {
    copyToClipboard(transcriptParaTexto(transcript));
    flashCopyBtn('hist-copy-transcript');
    showToast('Transcrição copiada.', 'success');
  });
  document.getElementById('hist-pdf-transcript')?.addEventListener('click', () => {
    baixarTranscriptPDF(c, transcript);
  });

  // Wire copy buttons
  document.getElementById('hist-copy-etapas')?.addEventListener('click', () => {
    copyToClipboard(`NOTAS POR ETAPA\n\n${etapasParaTexto(etapas)}`);
    flashCopyBtn('hist-copy-etapas');
    showToast('Etapas copiadas.', 'success');
  });
  document.getElementById('hist-copy-comercial')?.addEventListener('click', () => {
    copyToClipboard(`RELATÓRIO CRC COMERCIAL\n\n${crcComercialParaTexto(crcCom)}`);
    flashCopyBtn('hist-copy-comercial');
    showToast('CRC Comercial copiado.', 'success');
  });
  document.getElementById('hist-copy-sucesso')?.addEventListener('click', () => {
    copyToClipboard(`RELATÓRIO CRC SUCESSO DO CLIENTE\n\n${crcSucessoParaTexto(crcSuc)}`);
    flashCopyBtn('hist-copy-sucesso');
    showToast('CRC Sucesso copiado.', 'success');
  });

  window._imprimirRelatorio = () => imprimirRelatorio(c);
  window._histAbrirFeedback = () => renderFeedbackForm(c);

  window._histToggleTrechos = (i, count) => {
    const el = document.getElementById(`hist-trechos-${i}`);
    const btn = document.getElementById(`hist-trechos-btn-${i}`);
    if (!el) return;
    const open = el.style.display !== 'none';
    el.style.display = open ? 'none' : '';
    if (btn) btn.textContent = open ? `Ver trechos (${count})` : `Ocultar trechos`;
  };

  window._histDetalharEtapa = async (consultaId, i) => {
    if (_detalheCache[i]) return;
    const btn = document.getElementById(`hist-btn-detalhar-${i}`);
    const container = document.getElementById(`hist-detalhe-${i}`);
    if (!btn || !container || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Analisando…';
    try {
      const res = await post(`/avaliacoes/${consultaId}/detalhar/${i}`, {});
      _detalheCache[i] = res.detalhe;
      const momentos = res.detalhe?.momentos ?? [];
      container.style.display = '';
      container.innerHTML = momentos.length
        ? momentos.map(m => `
            <div style="margin-bottom:8px;padding:9px 10px;background:var(--bg2);border-radius:8px;border:1px solid var(--border)">
              <div style="font-size:11.5px;font-style:italic;color:var(--muted);border-left:2px solid var(--accent);padding-left:8px;margin-bottom:6px;line-height:1.5">"${escHtml(m.trecho ?? '')}"</div>
              <div style="font-size:12px;color:var(--red);margin-bottom:3px;line-height:1.4">⚠ ${escHtml(m.problema ?? '')}</div>
              <div style="font-size:12px;color:var(--green);line-height:1.4">✓ ${escHtml(m.alternativa ?? '')}</div>
            </div>`).join('')
        : `<div style="font-size:12px;color:var(--muted);font-style:italic">Nenhum momento específico identificado.</div>`;
      btn.textContent = '✓ Detalhado';
      btn.style.color = 'var(--green)';
    } catch (_) {
      showToast('Erro ao detalhar etapa. Tente novamente.', 'error');
      btn.disabled = false;
      btn.textContent = '🔍 Detalhar com IA';
    }
  };
  window._histReanalisar = async () => {
    const btn = document.getElementById('hist-reanalisar-btn');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Analisando…';
    try {
      await post(`/avaliacoes/${c.id}/reanalisar`, {});
      showToast('Análise atualizada! Recarregando…', 'success');
      // Re-fetch and re-render the detail with the new analysis
      const updated = await get(`/avaliacoes/${c.id}`);
      const summary = _items.find(i => i.id === c.id);
      if (summary) summary.nota_final = updated.nota_final;
      renderList();
      renderDetalhe(updated);
    } catch (e) {
      showToast('Erro: ' + (e.message || 'tente novamente.'), 'error');
      btn.disabled = false;
      btn.textContent = 'Reanalisar agora';
    }
  };
  window._histEditarNome = () => {
    if (document.getElementById('hist-nome-input')) return; // edit already active
    const titleEl = document.getElementById('avaliacao-modal-title');
    const editBtn = document.getElementById('hist-edit-nome-btn');
    if (!titleEl) return;

    const nomeAtual = c.paciente_nome ?? '';
    titleEl.style.display = 'none';
    if (editBtn) editBtn.style.display = 'none';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px';

    const input = document.createElement('input');
    input.id = 'hist-nome-input';
    input.value = nomeAtual; // set via property — no HTML injection risk
    input.maxLength = 120;
    input.style.cssText = 'font-size:15px;font-weight:700;background:var(--bg3);border:1px solid var(--accent);border-radius:6px;padding:4px 8px;color:var(--text);font-family:inherit;width:220px';

    const btnSalvar = document.createElement('button');
    btnSalvar.id = 'hist-nome-salvar';
    btnSalvar.textContent = 'Salvar';
    btnSalvar.style.cssText = 'padding:4px 12px;border-radius:6px;background:var(--accent);color:white;border:none;cursor:pointer;font-size:12.5px;font-weight:600;font-family:inherit';

    const btnCancelar = document.createElement('button');
    btnCancelar.id = 'hist-nome-cancelar';
    btnCancelar.textContent = 'Cancelar';
    btnCancelar.style.cssText = 'padding:4px 10px;border-radius:6px;background:var(--bg3);border:1px solid var(--border);color:var(--text);cursor:pointer;font-size:12.5px;font-family:inherit';

    wrapper.appendChild(input);
    wrapper.appendChild(btnSalvar);
    wrapper.appendChild(btnCancelar);
    titleEl.parentNode.insertBefore(wrapper, titleEl);
    input.focus();
    input.select();

    const cancelar = () => {
      wrapper.remove();
      titleEl.style.display = '';
      if (editBtn) editBtn.style.display = '';
    };

    btnCancelar.addEventListener('click', cancelar);
    btnSalvar.addEventListener('click', async () => {
      const novoNome = input.value.trim();
      if (!novoNome) { showToast('Nome não pode ser vazio.', 'warning'); return; }
      try {
        btnSalvar.disabled = true;
        btnSalvar.textContent = '...';
        await patch(`/avaliacoes/${c.id}/nome`, { nome: novoNome });
        c.paciente_nome = novoNome;
        titleEl.textContent = novoNome;
        const summary = _items.find(i => i.id === c.id);
        if (summary) summary.paciente_nome = novoNome;
        renderList();
        cancelar();
        showToast('Nome atualizado.', 'success');
      } catch (e) {
        showToast('Erro ao salvar nome. Tente novamente.', 'error');
        btnSalvar.disabled = false;
        btnSalvar.textContent = 'Salvar';
      }
    });

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') btnSalvar.click();
      if (e.key === 'Escape') cancelar();
    });
  };
}

function renderFeedbackForm(c) {
  const analysis = c.analysis ?? {};
  const etapas = analysis.etapas ?? [];
  const consultaId = c.id;
  let _histFbState = {};

  const etapasInputs = etapas.map((e, i) => `
    <div style="margin-bottom:12px">
      <div style="font-size:12px;font-weight:600;margin-bottom:6px">${escHtml(e.nome)}</div>
      <div style="display:flex;gap:6px">
        <button type="button" class="hist-fb-btn" data-idx="${i}" data-val="sim" aria-label="Concordo com análise de ${escHtml(e.nome)}" onclick="window._histToggleFb(${i},'sim')" style="padding:4px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);cursor:pointer;font-size:13px">✅</button>
        <button type="button" class="hist-fb-btn" data-idx="${i}" data-val="parcial" aria-label="Concordo parcialmente com análise de ${escHtml(e.nome)}" onclick="window._histToggleFb(${i},'parcial')" style="padding:4px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);cursor:pointer;font-size:13px">⚠️</button>
        <button type="button" class="hist-fb-btn" data-idx="${i}" data-val="nao" aria-label="Discordo da análise de ${escHtml(e.nome)}" onclick="window._histToggleFb(${i},'nao')" style="padding:4px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);cursor:pointer;font-size:13px">❌</button>
      </div>
    </div>`).join('');

  const html = `
    <div>
      <h2 id="avaliacao-modal-title" style="font-size:16px;font-weight:700;margin-bottom:6px">Feedback à IA</h2>
      <p style="font-size:12.5px;color:var(--muted);margin-bottom:16px">Como você avalia a análise desta consulta?</p>
      <div style="margin-bottom:14px">
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:6px">Nota geral (1–5)</label>
        <input id="hist-fb-nota" type="number" min="1" max="5" style="width:70px;background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:7px 10px;color:var(--text);font-size:13px;font-family:inherit" aria-label="Nota geral do feedback de 1 a 5">
      </div>
      <div style="margin-bottom:14px">${etapasInputs}</div>
      <div style="margin-bottom:16px">
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:6px">Comentário (opcional)</label>
        <textarea id="hist-fb-comentario" style="width:100%;min-height:80px;background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:8px 10px;color:var(--text);font-size:12.5px;font-family:inherit;resize:vertical" aria-label="Comentário opcional sobre a análise"></textarea>
      </div>
      <div style="display:flex;gap:8px">
        <button onclick="window._histEnviarFeedback()" style="padding:9px 20px;border-radius:8px;background:var(--accent);color:white;border:none;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit" aria-label="Enviar feedback">Enviar</button>
        <button onclick="document.getElementById('avaliacao-modal-bg').classList.remove('open')" style="padding:9px 16px;border-radius:8px;background:var(--bg3);color:var(--text);border:1px solid var(--border);font-size:13px;cursor:pointer;font-family:inherit" aria-label="Cancelar">Cancelar</button>
      </div>
    </div>`;

  showModal(html);

  window._histToggleFb = (idx, val) => {
    _histFbState[idx] = val;
    document.querySelectorAll(`.hist-fb-btn[data-idx="${idx}"]`).forEach(b => {
      const active = b.dataset.val === val;
      b.style.background = active ? 'var(--accent)' : 'var(--bg3)';
      b.style.color = active ? 'white' : 'var(--text)';
      b.style.borderColor = active ? 'var(--accent)' : 'var(--border)';
    });
  };

  window._histEnviarFeedback = async () => {
    const nota = parseInt(document.getElementById('hist-fb-nota')?.value);
    if (!nota || nota < 1 || nota > 5) {
      showToast('Informe uma nota de 1 a 5.', 'warning');
      return;
    }
    const comentario = document.getElementById('hist-fb-comentario')?.value?.trim() || undefined;
    const etapasFb = etapas.map((e, i) => {
      const val = _histFbState[i];
      return val ? { nome: e.nome, concordou: val } : null;
    }).filter(Boolean);

    try {
      await patch(`/avaliacoes/${consultaId}/feedback`, {
        feedback_ia: {
          schema_version: 1,
          nota_geral: nota,
          comentario,
          etapas: etapasFb,
        },
      });
      c.feedback_ia = { schema_version: 1, nota_geral: nota, comentario, etapas: etapasFb };
      renderList();
      showToast('Feedback enviado.', 'success');
      document.getElementById('avaliacao-modal-bg')?.classList.remove('open');
    } catch (e) {
      showToast('Erro ao enviar feedback: ' + e.message, 'error');
    }
  };
}

function renderRoot() {
  const root = document.getElementById('historico-root');
  if (!root) return;

  root.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden">
      <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div style="font-size:13.5px;font-weight:600">Consultas</div>
        <div id="hist-count" style="font-size:12px;color:var(--muted)"></div>
      </div>
      <div id="hist-filters" style="display:none;padding:12px 16px;border-bottom:1px solid var(--border);align-items:center;flex-wrap:wrap;gap:10px">
        <select id="hist-filter-dentista" aria-label="Filtrar por dentista"
          style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text);font-size:12.5px;font-family:inherit;cursor:pointer">
          <option value="">Todos os dentistas</option>
        </select>
        <input id="hist-filter-desde" type="date" aria-label="Data inicial"
          style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text);font-size:12.5px;font-family:inherit">
        <input id="hist-filter-ate" type="date" aria-label="Data final"
          style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text);font-size:12.5px;font-family:inherit">
      </div>
      <div id="hist-list"></div>
      <div id="hist-load-more" style="display:none;padding:14px;text-align:center">
        <button id="hist-load-more-btn" onclick="window._histLoadMore()" style="padding:8px 22px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);color:var(--text);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit" aria-label="Carregar mais consultas">Carregar mais</button>
      </div>
    </div>`;

  window._histDetalhe = async (idx) => {
    const summary = _items[idx];
    if (!summary) return;
    try {
      const c = await get(`/avaliacoes/${summary.id}`);
      renderDetalhe(c);
    } catch (e) {
      showToast('Erro ao carregar detalhe: ' + e.message, 'error');
    }
  };
  window._histLoadMore = loadMore;
}

async function reloadList() {
  _offset = 0;
  _total = 0;
  _items = [];

  const listEl = document.getElementById('hist-list');
  if (listEl) listEl.innerHTML = `<div style="padding:24px;text-align:center;font-size:13px;color:var(--muted)">Carregando...</div>`;

  try {
    const data = await get(buildQueryUrl(PAGE_SIZE, 0));
    _items = data.data ?? [];
    _total = data.total ?? _items.length;
    _offset = _items.length;

    const countEl = document.getElementById('hist-count');
    if (countEl) countEl.textContent = `${_total} consulta${_total !== 1 ? 's' : ''}`;

    renderList();
  } catch (e) {
    showToast('Erro ao carregar histórico: ' + e.message, 'error');
    if (listEl) listEl.innerHTML = `<div style="padding:24px;text-align:center;font-size:13px;color:var(--red)">Erro ao carregar. Tente novamente.</div>`;
  }
}

export async function init() {
  _filterDentistaId = '';
  _filterDesde = '';
  _filterAte = '';
  _dentistas = null;

  renderRoot();

  // Wire filters for gestor/admin
  if (isGestorUser()) {
    const filtersEl = document.getElementById('hist-filters');
    if (filtersEl) filtersEl.style.display = 'flex';

    // Load dentistas and populate select
    const dentistas = await loadDentistas();
    const sel = document.getElementById('hist-filter-dentista');
    if (sel && dentistas.length) {
      dentistas.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = d.nome;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => {
        _filterDentistaId = sel.value;
        reloadList();
      });
    }

    const desdeEl = document.getElementById('hist-filter-desde');
    const ateEl = document.getElementById('hist-filter-ate');
    if (desdeEl) desdeEl.addEventListener('change', () => { _filterDesde = desdeEl.value; reloadList(); });
    if (ateEl) ateEl.addEventListener('change', () => { _filterAte = ateEl.value; reloadList(); });
  }

  // Attribution modal (gestor/admin only)
  window._avdAtribuir = async (id) => {
    const dentistas = isGestorUser() ? await loadDentistas() : [];
    const optsHtml = dentistas.map(d =>
      `<option value="${escHtml(d.id)}">${escHtml(d.nome)}</option>`
    ).join('');

    const html = `
      <div>
        <h2 id="avaliacao-modal-title" style="font-size:16px;font-weight:700;margin-bottom:14px">Atribuir avaliação</h2>
        <div style="margin-bottom:12px">
          <label style="font-size:12px;font-weight:600;display:block;margin-bottom:6px">Dentista</label>
          <select id="avd-attr-dentista" aria-label="Selecionar dentista"
            style="width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text);font-size:13px;font-family:inherit">
            <option value="">— selecione —</option>
            ${optsHtml}
          </select>
        </div>
        <div style="margin-bottom:12px">
          <label style="font-size:12px;font-weight:600;display:block;margin-bottom:6px">Nome do paciente</label>
          <input id="avd-attr-paciente" type="text" maxlength="120" placeholder="Nome do paciente" aria-label="Nome do paciente"
            style="width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text);font-size:13px;font-family:inherit;box-sizing:border-box">
        </div>
        <div style="margin-bottom:18px">
          <label style="font-size:12px;font-weight:600;display:block;margin-bottom:6px">Data da consulta</label>
          <input id="avd-attr-data" type="date" aria-label="Data da consulta"
            style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text);font-size:13px;font-family:inherit">
        </div>
        <div style="display:flex;gap:8px">
          <button id="avd-attr-confirmar" style="padding:9px 20px;border-radius:8px;background:var(--accent);color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit" aria-label="Confirmar atribuição">Confirmar</button>
          <button onclick="document.getElementById('avaliacao-modal-bg').classList.remove('open')"
            style="padding:9px 16px;border-radius:8px;background:var(--bg3);color:var(--text);border:1px solid var(--border);font-size:13px;cursor:pointer;font-family:inherit" aria-label="Cancelar">Cancelar</button>
        </div>
      </div>`;

    showModal(html);

    document.getElementById('avd-attr-confirmar')?.addEventListener('click', async () => {
      const btn = document.getElementById('avd-attr-confirmar');
      const dentistaId = document.getElementById('avd-attr-dentista')?.value || undefined;
      const pacienteNome = document.getElementById('avd-attr-paciente')?.value.trim() || undefined;
      const dataConsulta = document.getElementById('avd-attr-data')?.value || undefined;

      // Build body with only filled fields
      const body = {};
      if (dentistaId) body.dentista_id = dentistaId;
      if (pacienteNome) body.paciente_nome = pacienteNome;
      if (dataConsulta) body.data_consulta = dataConsulta;

      if (Object.keys(body).length === 0) {
        showToast('Preencha ao menos um campo.', 'warning');
        return;
      }

      try {
        if (btn) { btn.disabled = true; btn.textContent = 'Salvando…'; }
        await patch(`/avaliacoes/${id}/atribuir`, body);
        showToast('Avaliação atribuída.', 'success');
        document.getElementById('avaliacao-modal-bg')?.classList.remove('open');
        await reloadList();
      } catch (e) {
        showToast('Erro ao atribuir: ' + (e.message || 'tente novamente.'), 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Confirmar'; }
      }
    });
  };

  await reloadList();
}
