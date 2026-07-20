// /js/producao-fiscalizacao/app.js — Fiscalização da gestora (planejado × real) — Entrega ③B
// spec: docs/superpowers/specs/2026-07-20-fiscalizacao-planejado-real-design.md
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let token = null;
let podeEditarConfig = false;

(function init() {
  const k = Object.keys(localStorage).find(kk => kk.startsWith('sb-') && kk.endsWith('-auth-token'));
  if (!k) return (window.location.href = '/');
  let parsed;
  try { parsed = JSON.parse(localStorage.getItem(k)); } catch (_) {}
  token = parsed?.access_token;
  if (!token) return (window.location.href = '/');

  document.getElementById('toInput').value = hoje();
  document.getElementById('fromInput').value = diasAtras(30);
  boot();
})();

// ── datas (America/Sao_Paulo, mesmo padrão do Registro Diário) ─────────────
function hoje() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); }
function diasAtras(n) {
  const d = new Date(hoje() + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function mudarJanela(direcao) {
  const fromEl = document.getElementById('fromInput'), toEl = document.getElementById('toInput');
  const from = new Date(fromEl.value + 'T12:00:00Z'), to = new Date(toEl.value + 'T12:00:00Z');
  const spanDias = Math.max(1, Math.round((to - from) / 864e5) + 1);
  const delta = spanDias * direcao;
  from.setUTCDate(from.getUTCDate() + delta);
  to.setUTCDate(to.getUTCDate() + delta);
  fromEl.value = from.toISOString().slice(0, 10);
  toEl.value = to.toISOString().slice(0, 10);
  carregar();
}

// ── api() com retry 5xx (padrão do CRM) ─────────────────────────────────────
async function api(path, opts = {}) {
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  for (const espera of [1500, 3000, null]) {
    const r = await fetch(path, { headers: H, ...opts });
    if (r.status >= 500 && espera !== null) { await new Promise(s => setTimeout(s, espera)); continue; }
    if (!r.ok) { const j = await r.json().catch(() => ({})); const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  }
}

// ── formatação ───────────────────────────────────────────────────────────────
function fmtBRL(v) { return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function fmtMin(m) {
  const min = Math.round(Number(m) || 0);
  if (min <= 0) return '0min';
  const h = Math.floor(min / 60), r = min % 60;
  if (h <= 0) return `${r}min`;
  if (r === 0) return `${h}h`;
  return `${h}h ${r}min`;
}
function fmtDeltaMin(delta) {
  const min = Math.round(Number(delta) || 0);
  if (min === 0) return '0min';
  return (min > 0 ? '+' : '−') + fmtMin(Math.abs(min));
}
function fmtPct(frac, casas) {
  if (frac == null || !Number.isFinite(Number(frac))) return '—';
  return (Number(frac) * 100).toFixed(casas == null ? 0 : casas) + '%';
}
function seloPgto(t) {
  if (!t) return '';
  const m = { particular: ['Particular', 'sel-part'], convenio: ['Convênio', 'sel-conv'], misto: ['Misto', 'sel-mist'] };
  const [label, cls] = m[t] || [t, 'sel-part'];
  return `<span class="selo ${cls}">${esc(label)}</span>`;
}

// ── boot ───────────────────────────────────────────────────────────────────
async function boot() {
  await Promise.all([carregarMe(), carregar()]);
}

async function carregarMe() {
  try {
    const me = await api('/api/me');
    const roles = me.roles || [];
    podeEditarConfig = roles.some(r => ['gestor', 'admin'].includes(r));
  } catch (_) {
    podeEditarConfig = false; // sem certeza da role → padrão seguro é só leitura
  }
}

async function carregar() {
  const from = document.getElementById('fromInput').value;
  const to = document.getElementById('toInput').value;
  document.getElementById('nextBtn').disabled = to >= hoje();

  await Promise.all([carregarConfig(), carregarCobertura(from, to), carregarPlanoReal(from, to)]);
}

// ── config ───────────────────────────────────────────────────────────────────
async function carregarConfig() {
  const el = document.getElementById('configBody');
  el.innerHTML = '<span class="spinner"></span>';
  try {
    const cfg = await api('/api/fiscalizacao/config');
    renderConfig(cfg);
  } catch (e) {
    el.innerHTML = `<div class="empty">Erro: ${esc(e.message)}</div>`;
  }
}

function renderConfig(cfg) {
  const el = document.getElementById('configBody');
  if (!podeEditarConfig) {
    el.innerHTML = `<div class="config-readonly">
      <span>Custo hora clínica: <b>${fmtBRL(cfg.custo_hora_clinica)}</b></span>
      <span>Margem-alvo: <b>${fmtPct(cfg.margem_alvo_default / 100)}</b></span>
    </div>`;
    return;
  }
  el.innerHTML = `
    <div class="config-field">
      <label for="cfgCustoHora">Custo hora clínica (R$)</label>
      <input type="number" id="cfgCustoHora" step="0.01" min="0" value="${esc(cfg.custo_hora_clinica)}">
    </div>
    <div class="config-field">
      <label for="cfgMargemAlvo">Margem-alvo (%)</label>
      <input type="number" id="cfgMargemAlvo" step="0.1" min="0" value="${esc(cfg.margem_alvo_default)}">
    </div>
    <button class="btn btn-primario" id="cfgSalvarBtn" onclick="salvarConfig()">Salvar</button>
    <span class="config-msg" id="cfgMsg"></span>`;
}

async function salvarConfig() {
  const btn = document.getElementById('cfgSalvarBtn');
  const msg = document.getElementById('cfgMsg');
  const custo_hora_clinica = Number(document.getElementById('cfgCustoHora').value);
  const margem_alvo_default = Number(document.getElementById('cfgMargemAlvo').value);
  btn.disabled = true;
  msg.textContent = '';
  msg.className = 'config-msg';
  try {
    await api('/api/fiscalizacao/config', { method: 'PUT', body: JSON.stringify({ custo_hora_clinica, margem_alvo_default }) });
    msg.textContent = 'Salvo.';
    msg.className = 'config-msg ok';
    const from = document.getElementById('fromInput').value, to = document.getElementById('toInput').value;
    await carregarPlanoReal(from, to); // custo de cadeira depende da config
  } catch (e) {
    msg.textContent = e.status === 403 ? 'Só gestor/admin pode editar.' : `Erro: ${e.message}`;
    msg.className = 'config-msg erro';
  } finally {
    btn.disabled = false;
  }
}

// ── cobertura ────────────────────────────────────────────────────────────────
function classePct(pct) {
  if (pct == null) return '';
  if (pct < 0.3) return 'critica';
  if (pct < 0.5) return 'baixa';
  return '';
}

async function carregarCobertura(from, to) {
  const el = document.getElementById('coberturaBody');
  el.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  try {
    const json = await api(`/api/fiscalizacao/cobertura?from=${from}&to=${to}`);
    renderCobertura(json);
  } catch (e) {
    el.innerHTML = `<div class="empty">Erro: ${esc(e.message)}</div>`;
  }
}

function linhaCobertura(d) {
  const pct = d.pct;
  const cls = classePct(pct);
  const pctTxt = fmtPct(pct);
  const largura = pct == null ? 0 : Math.round(pct * 100);
  return `<tr>
    <td>${esc(d.dentista_nome) || '—'}</td>
    <td>${d.sessoes}</td>
    <td>${d.registradas}</td>
    <td>
      <span class="barrinha"><span class="barrinha-fill ${cls}" style="width:${largura}%"></span></span>
      <span class="${cls === 'critica' ? 'pct-critica' : cls === 'baixa' ? 'pct-baixa' : ''}">${pctTxt}</span>
    </td>
  </tr>`;
}

function renderCobertura(j) {
  document.getElementById('coberturaCount').textContent = j.dentistas.length ? `${j.dentistas.length} dentistas` : '';
  const el = document.getElementById('coberturaBody');
  if (!j.dentistas.length) { el.innerHTML = '<div class="empty">Nenhuma sessão com plano ativo neste período.</div>'; return; }
  el.innerHTML = `<table><thead><tr>
    <th>Dentista</th><th>Sessões</th><th>Registradas</th><th>%</th>
  </tr></thead><tbody>${j.dentistas.map(linhaCobertura).join('')}</tbody>
  <tfoot><tr>
    <td>Total</td><td>${j.total.sessoes}</td><td>${j.total.registradas}</td><td>${fmtPct(j.total.pct)}</td>
  </tr></tfoot></table>`;
}

// ── planejado × real ─────────────────────────────────────────────────────────
const SEVERIDADE_RANK = { critico: 2, atencao: 1, ok: 0 };

async function carregarPlanoReal(from, to) {
  const el = document.getElementById('planoBody');
  el.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  try {
    const json = await api(`/api/fiscalizacao/planejado-real?from=${from}&to=${to}`);
    renderPlanoReal(json);
  } catch (e) {
    el.innerHTML = `<div class="empty">Erro: ${esc(e.message)}</div>`;
  }
}

function linhaPlanoReal(p) {
  const cls = p.severidade === 'critico' ? 'sev-critico' : p.severidade === 'atencao' ? 'sev-atencao' : '';
  const deltaCls = p.delta_min > 0 ? 'delta-pos' : p.delta_min < 0 ? 'delta-neg' : '';
  return `<tr class="${cls}">
    <td>${esc(p.paciente_nome) || '—'}</td>
    <td>${esc(p.dentista_nome) || '—'} ${seloPgto(p.tipo_pagamento)}</td>
    <td>${fmtMin(p.planejado_min)}</td>
    <td>${fmtMin(p.real_min)}</td>
    <td class="${deltaCls}">${fmtDeltaMin(p.delta_min)}${p.estouro ? '<span class="tag-estouro">estouro</span>' : ''}</td>
    <td>${fmtBRL(p.custo_cadeira)}</td>
    <td>${fmtPct(p.pct_receita_cadeira)}</td>
  </tr>`;
}

function renderPlanoReal(j) {
  document.getElementById('planoCount').textContent = j.planos.length ? `${j.planos.length} tratamentos` : '';
  const el = document.getElementById('planoBody');
  if (!j.planos.length) { el.innerHTML = '<div class="empty">Nenhum tratamento neste período.</div>'; return; }

  const ordenado = [...j.planos].sort((a, b) => {
    const r = (SEVERIDADE_RANK[b.severidade] || 0) - (SEVERIDADE_RANK[a.severidade] || 0);
    return r !== 0 ? r : (b.delta_min || 0) - (a.delta_min || 0);
  });

  el.innerHTML = `<table><thead><tr>
    <th>Paciente</th><th>Dentista</th><th>Planejado</th><th>Real</th><th>Δ</th><th>Custo de cadeira</th><th>% da receita</th>
  </tr></thead><tbody>${ordenado.map(linhaPlanoReal).join('')}</tbody>
  <tfoot><tr>
    <td colspan="2">Total</td>
    <td>${fmtMin(j.total.planejado_min)}</td>
    <td>${fmtMin(j.total.real_min)}</td>
    <td colspan="3">${j.total.estourando} tratamento${j.total.estourando === 1 ? '' : 's'} estourando</td>
  </tr></tfoot></table>`;
}
