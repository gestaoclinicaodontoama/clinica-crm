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
  const roles = AvaliacaoApp.user?.roles ?? [];
  const podeEditar = isDono(c) || roles.includes('admin');

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
        <div style="font-size:12px;color:var(--muted);line-height:1.4">${escHtml(e.feedback ?? '')}</div>
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
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:18px">
        <div>
          <h2 id="avaliacao-modal-title" style="font-size:16px;font-weight:700;margin-bottom:4px">${escHtml(c.paciente_nome ?? '—')}</h2>
          <div style="font-size:12px;color:var(--muted)">${formatDate(c.created_at)} · ${modoBadge(c.modo)}</div>
        </div>
        <div style="font-family:'DM Mono',monospace;font-size:36px;font-weight:700;color:${notaCor(c.nota_final)};flex-shrink:0">
          ${c.nota_final != null ? c.nota_final.toFixed(1) : '—'}
        </div>
      </div>
      ${analysis.veredito ? `<p style="font-size:13px;line-height:1.5;margin-bottom:14px">${escHtml(analysis.veredito)}</p>` : ''}
      <div>${etapasHtml}</div>
      ${feedbackEl}
      <div style="margin-top:18px">
        <button onclick="document.getElementById('avaliacao-modal-bg').classList.remove('open')" style="padding:9px 22px;border-radius:8px;background:var(--bg3);color:var(--text);border:1px solid var(--border);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit" aria-label="Fechar detalhe da consulta">Fechar</button>
      </div>
    </div>`;

  showModal(html);

  window._histAbrirFeedback = () => renderFeedbackForm(c);
}

function renderFeedbackForm(c) {
  const analysis = c.analysis ?? {};
  const etapas = analysis.etapas ?? [];
  const consultaId = c.id; // captured in closure — never injected into HTML
  let _histFbState = {}; // idx -> 'sim'|'parcial'|'nao'

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
