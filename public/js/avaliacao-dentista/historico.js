import { AvaliacaoApp } from './state.js';
import { get, patch } from './api.js';
import { showToast, showModal, formatDate } from './ui.js';

const PAGE_SIZE = 50;

let _offset = 0;
let _total = 0;
let _items = [];

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
  const field = (label, val) => {
    if (!val && val !== 0) return '';
    return `<div style="margin-bottom:10px">
      <div style="font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-bottom:2px">${label}</div>
      <div style="font-size:13px;color:var(--text);line-height:1.5">${escHtml(String(val))}</div>
    </div>`;
  };
  const list = (label, arr) => {
    if (!arr?.length) return '';
    return `<div style="margin-bottom:10px">
      <div style="font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-bottom:4px">${label}</div>
      <ul style="margin:0;padding-left:16px;font-size:13px;color:var(--text);line-height:1.6">
        ${arr.map(i => `<li>${escHtml(String(i))}</li>`).join('')}
      </ul>
    </div>`;
  };
  return [
    field('Paciente', c.paciente),
    field('Contato', c.contato),
    field('Queixa principal', c.queixa_principal),
    field('Tratamento proposto', c.tratamento_proposto),
    field('Valor', c.valor),
    field('Poder de compra', c.poder_de_compra),
    field('Abordagem follow-up', c.abordagem_followup),
    list('Objeções levantadas', c.objecoes),
    list('Gatilhos emocionais', c.gatilhos_emocionais),
  ].join('');
}

function renderCRCSucessoHtml(s) {
  if (!s) return '';
  if (typeof s === 'string') {
    return `<p style="font-size:13px;color:var(--text);line-height:1.6;white-space:pre-wrap">${escHtml(s)}</p>`;
  }
  const field = (label, val) => {
    if (!val && val !== 0) return '';
    return `<div style="margin-bottom:10px">
      <div style="font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-bottom:2px">${label}</div>
      <div style="font-size:13px;color:var(--text);line-height:1.5">${escHtml(String(val))}</div>
    </div>`;
  };
  const list = (label, arr) => {
    if (!arr?.length) return '';
    return `<div style="margin-bottom:10px">
      <div style="font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-bottom:4px">${label}</div>
      <ul style="margin:0;padding-left:16px;font-size:13px;color:var(--text);line-height:1.6">
        ${arr.map(i => `<li>${escHtml(String(i))}</li>`).join('')}
      </ul>
    </div>`;
  };
  return [
    field('Resumo clínico', s.resumo_clinico),
    field('Jornada do paciente', s.jornada_paciente),
    field('Como garantir boa experiência', s.como_garantir_boa_experiencia),
    list('Plano de fases', s.plano_de_fases),
    list('Pontos de atenção emocional', s.pontos_atencao_emocional),
  ].join('');
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
  setTimeout(() => { btn.innerHTML = orig; btn.style.color = ''; }, 2000);
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
    return `<div style="margin-bottom:10px">
      <div style="font-size:9.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#9ca3af;margin-bottom:2px">${label}</div>
      <div style="font-size:13px;color:#111827;line-height:1.5">${escHtml(String(val))}</div>
    </div>`;
  };

  const printList = (label, arr) => {
    if (!arr?.length) return '';
    return `<div style="margin-bottom:10px">
      <div style="font-size:9.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#9ca3af;margin-bottom:4px">${label}</div>
      <ul style="margin:0;padding-left:16px;font-size:13px;color:#111827;line-height:1.6">
        ${arr.map(i => `<li>${escHtml(String(i))}</li>`).join('')}
      </ul>
    </div>`;
  };

  const comHtml = com ? (typeof com === 'string'
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

  const sucHtml = suc ? (typeof suc === 'string'
    ? `<p style="font-size:13px;color:#111827;line-height:1.6;white-space:pre-wrap">${escHtml(suc)}</p>`
    : [
        printField('Resumo clínico', suc.resumo_clinico),
        printField('Jornada do paciente', suc.jornada_paciente),
        printField('Como garantir boa experiência', suc.como_garantir_boa_experiencia),
        printList('Plano de fases', suc.plano_de_fases),
        printList('Pontos de atenção emocional', suc.pontos_atencao_emocional),
      ].join('')
  ) : '';

  const notaCor2 = c.nota_final >= 7 ? '#22c55e' : c.nota_final >= 5 ? '#eab308' : '#ef4444';

  const win = window.open('', '_blank');
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

  root.innerHTML = _items.map((c, idx) => {
    const nota = c.nota_final;
    const cor = notaCor(nota);
    return `
      <div
        class="hist-row"
        data-idx="${idx}"
        tabindex="0"
        role="button"
        aria-label="Ver detalhe da consulta de ${escHtml(c.paciente_nome ?? '—')} em ${formatDate(c.created_at)}"
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
          <div style="font-size:13.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(c.paciente_nome ?? '—')}</div>
          <div style="font-size:11.5px;color:var(--muted);margin-top:2px">${formatDate(c.created_at)} · ${modoBadge(c.modo)}</div>
        </div>
      </div>`;
  }).join('');

  const more = document.getElementById('hist-load-more');
  if (more) more.style.display = (_offset < _total) ? 'block' : 'none';
}

async function loadMore() {
  const btn = document.getElementById('hist-load-more-btn');
  if (btn) btn.disabled = true;

  try {
    const data = await get(`/avaliacoes?limit=${PAGE_SIZE}&offset=${_offset}`);
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
  const roles = AvaliacaoApp.user?.roles ?? [];
  const podeEditar = isDono(c) || roles.includes('admin') || roles.includes('gestor');

  const etapasHtml = etapas.map((e, i) => {
    const cor = notaCor(e.nota);
    const pct = ((e.nota ?? 0) / 10) * 100;
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
      </div>`;
  }).join('');

  const feedbackEl = c.feedback_ia
    ? `<div style="margin-top:14px;padding:12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;font-size:12.5px;color:var(--muted)">Feedback do dentista registrado.</div>`
    : podeEditar
      ? `<div id="hist-feedback-zone" style="margin-top:14px">
           <button onclick="window._histAbrirFeedback()" aria-label="Dar feedback à análise desta consulta" style="padding:8px 16px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);color:var(--text);font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit">Dar feedback à IA</button>
         </div>`
      : '';

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
      ${crcCom ? `
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div style="font-size:13px;font-weight:700">📋 Relatório CRC Comercial</div>
          ${copyBtnHtml('hist-copy-comercial')}
        </div>
        ${renderCRCComercialHtml(crcCom)}
      </div>` : ''}

      <!-- CRC Sucesso -->
      ${crcSuc ? `
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div style="font-size:13px;font-weight:700">🌟 Relatório CRC Sucesso do Cliente</div>
          ${copyBtnHtml('hist-copy-sucesso')}
        </div>
        ${renderCRCSucessoHtml(crcSuc)}
      </div>` : ''}

      ${feedbackEl}

      <div style="margin-top:18px">
        <button onclick="document.getElementById('avaliacao-modal-bg').classList.remove('open')"
          style="padding:9px 22px;border-radius:8px;background:var(--bg3);color:var(--text);border:1px solid var(--border);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit"
          aria-label="Fechar detalhe da consulta">Fechar</button>
      </div>
    </div>`;

  showModal(html);

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
  window._histEditarNome = () => {
    const titleEl = document.getElementById('avaliacao-modal-title');
    const editBtn = document.getElementById('hist-edit-nome-btn');
    if (!titleEl) return;

    const nomeAtual = c.paciente_nome ?? '';
    titleEl.style.display = 'none';
    if (editBtn) editBtn.style.display = 'none';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px';
    wrapper.innerHTML = `
      <input id="hist-nome-input" value="${escHtml(nomeAtual)}" maxlength="120"
        style="font-size:15px;font-weight:700;background:var(--bg3);border:1px solid var(--accent);border-radius:6px;padding:4px 8px;color:var(--text);font-family:inherit;width:220px" />
      <button id="hist-nome-salvar" style="padding:4px 12px;border-radius:6px;background:var(--accent);color:white;border:none;cursor:pointer;font-size:12.5px;font-weight:600;font-family:inherit">Salvar</button>
      <button id="hist-nome-cancelar" style="padding:4px 10px;border-radius:6px;background:var(--bg3);border:1px solid var(--border);color:var(--text);cursor:pointer;font-size:12.5px;font-family:inherit">Cancelar</button>`;
    titleEl.parentNode.insertBefore(wrapper, titleEl);

    const input = wrapper.querySelector('#hist-nome-input');
    input.focus();
    input.select();

    const cancelar = () => {
      wrapper.remove();
      titleEl.style.display = '';
      if (editBtn) editBtn.style.display = '';
    };

    wrapper.querySelector('#hist-nome-cancelar').addEventListener('click', cancelar);
    wrapper.querySelector('#hist-nome-salvar').addEventListener('click', async () => {
      const novoNome = input.value.trim();
      if (!novoNome) { showToast('Nome não pode ser vazio.', 'warning'); return; }
      try {
        const btn = wrapper.querySelector('#hist-nome-salvar');
        btn.disabled = true;
        btn.textContent = '...';
        await patch(`/avaliacoes/${c.id}/nome`, { nome: novoNome });
        c.paciente_nome = novoNome;
        titleEl.textContent = novoNome;
        const summary = _items.find(i => i.id === c.id);
        if (summary) summary.paciente_nome = novoNome;
        renderList();
        cancelar();
        showToast('Nome atualizado.', 'success');
      } catch (e) {
        showToast('Erro ao salvar: ' + e.message, 'error');
        const btn = wrapper.querySelector('#hist-nome-salvar');
        if (btn) { btn.disabled = false; btn.textContent = 'Salvar'; }
      }
    });

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') wrapper.querySelector('#hist-nome-salvar').click();
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

export async function init() {
  renderRoot();

  _offset = 0;
  _total = 0;
  _items = [];

  const listEl = document.getElementById('hist-list');
  if (listEl) listEl.innerHTML = `<div style="padding:24px;text-align:center;font-size:13px;color:var(--muted)">Carregando...</div>`;

  try {
    const data = await get(`/avaliacoes?limit=${PAGE_SIZE}&offset=0`);
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
