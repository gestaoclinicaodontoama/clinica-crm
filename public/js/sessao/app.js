// /js/sessao/app.js — Registro por Sessão (ASB), mobile-first.
// Dia da agenda (default hoje) + busca retroativa; marcar etapa do plano ou registrar
// atendimento avulso ("caso b"). A data escolhida na datebar dirige TODOS os POSTs,
// tanto no modo dia quanto no modo busca.
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
  const limparCod = n => String(n || '').replace(/^\s*\d{2,}\s*[-–—.]\s*/, '').trim();   // tira o código Clinicorp do nome (só exibição)

let token = null;
let modo = 'dia';           // 'dia' | 'busca'
let pacientesAtuais = [];
const openSet = new Set();     // cards expandidos (paciente_clinicorp_id)
const avulsoSet = new Set();   // formulário "Atendimento realizado" aberto (paciente_clinicorp_id)
let buscaTimer = null;

(function estilosGrupo() {
  const st = document.createElement('style');
  st.textContent = `.grp-dent{display:flex;align-items:center;gap:8px;font-weight:700;font-size:.95rem;margin:16px 2px 8px;padding-bottom:5px;border-bottom:2px solid var(--line,#e2e8f0)}
.grp-dent:first-child{margin-top:4px}
.grp-n{font-size:.7rem;font-weight:700;color:#64748b;background:rgba(100,116,139,.14);border-radius:999px;padding:1px 8px}
.card-dent{color:#0d9488;font-weight:600}`;
  document.head.appendChild(st);
})();

(function init() {
  const k = Object.keys(localStorage).find(kk => kk.startsWith('sb-') && kk.endsWith('-auth-token'));
  if (!k) return (window.location.href = '/');
  let parsed;
  try { parsed = JSON.parse(localStorage.getItem(k)); } catch (_) {}
  token = parsed?.access_token;
  if (!token) return (window.location.href = '/');

  document.getElementById('dataInput').value = hoje();
  updateAvisoFuturo();
  carregarDia();
  document.getElementById('conteudo').addEventListener('click', onConteudoClick);
})();

// ── datas (America/Sao_Paulo, mesmo padrão do Registro Diário) ─────────────
function hoje() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); }
function mudarDia(delta) {
  const d = new Date(document.getElementById('dataInput').value + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  document.getElementById('dataInput').value = d.toISOString().slice(0, 10);
  onDataChange();
}
function irHoje() { document.getElementById('dataInput').value = hoje(); onDataChange(); }
function onDataChange() {
  updateAvisoFuturo();
  if (modo === 'dia') carregarDia();
}
function updateAvisoFuturo() {
  const data = document.getElementById('dataInput').value;
  const futuro = data > hoje();
  document.getElementById('avisoFuturo').style.display = futuro ? '' : 'none';
  document.getElementById('btnNext').disabled = data >= hoje();
}

// ── api() com retry 5xx (padrão do CRM) ─────────────────────────────────────
async function api(path, opts = {}) {
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  for (const espera of [1500, 3000, null]) {
    const r = await fetch(path, { headers: H, ...opts });
    if (r.status >= 500 && espera !== null) { await new Promise(s => setTimeout(s, espera)); continue; }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return r.json();
  }
}

function toast(msg, erro) {
  const t = document.createElement('div');
  t.className = 'toast' + (erro ? ' erro' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), erro ? 3200 : 2200);
}

// ── carregar: dia ou busca ───────────────────────────────────────────────────
async function carregarDia() {
  modo = 'dia';
  const data = document.getElementById('dataInput').value;
  const el = document.getElementById('conteudo');
  el.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  try {
    const json = await api(`/api/sessao/dia?data=${data}`);
    pacientesAtuais = json.pacientes || [];
    render();
  } catch (e) {
    el.innerHTML = `<div class="empty">Erro: ${esc(e.message)}</div>`;
  }
}

function onBusca() {
  const q = document.getElementById('buscaInput').value.trim();
  clearTimeout(buscaTimer);
  document.getElementById('buscaHint').style.display = q.length >= 2 ? '' : 'none';
  if (q.length < 2) { carregarDia(); return; }
  buscaTimer = setTimeout(() => executarBusca(q), 350);
}

async function executarBusca(q) {
  modo = 'busca';
  openSet.clear(); avulsoSet.clear();
  const el = document.getElementById('conteudo');
  el.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  try {
    const json = await api(`/api/sessao/buscar?q=${encodeURIComponent(q)}`);
    pacientesAtuais = json.pacientes || [];
    render();
  } catch (e) {
    el.innerHTML = `<div class="empty">Erro: ${esc(e.message)}</div>`;
  }
}

// ── render ────────────────────────────────────────────────────────────────
function chipPlano(plano) {
  if (!plano) return '<span class="chip chip-sem">Sem plano</span>';
  const map = {
    aguardando_planejamento: ['chip-sem', 'Sem plano'],
    planejado: ['chip-planejado', 'Planejado'],
    em_andamento: ['chip-andamento', 'Em andamento'],
    concluido: ['chip-concluido', 'Concluído'],
  };
  const [cls, label] = map[plano.status] || ['chip-sem', plano.status];
  return `<span class="chip ${cls}">${esc(label)}</span>`;
}

function etapaRowHtml(item, et) {
  const meta = [limparCod(item.procedure_name), et.profissional_executor].filter(Boolean).join(' · ');
  const desc = et.descricao || limparCod(item.procedure_name) || '';
  const done = et.status === 'concluida' || et.status === 'concluida_retroativa';
  if (done) {
    return `<div class="etapa-row done">
      <div class="etapa-info">
        <div class="etapa-desc riscado">${esc(desc)}</div>
        <div class="etapa-meta">${esc(meta)}</div>
      </div>
      <div class="etapa-done-mark">✓</div>
    </div>`;
  }
  const tempo = et.tempo_planejado_min != null ? et.tempo_planejado_min : null;
  const metaTexto = meta + (tempo != null ? `${meta ? ' · ' : ''}plano: ${tempo} min` : '');
  return `<div class="etapa-row" data-etapa-row data-etapa-id="${esc(et.id)}">
    <div class="etapa-info">
      <div class="etapa-desc">${esc(desc)}</div>
      <div class="etapa-meta">${esc(metaTexto)}</div>
    </div>
    <div class="etapa-check">✓</div>
  </div>`;
}

function avulsoFormHtml(p) {
  const pid = p.paciente_clinicorp_id;
  const open = avulsoSet.has(String(pid));
  return `<div class="avulso-form ${open ? 'open' : ''}" data-avulso-form>
    <label style="font-size:12px;color:var(--muted)">Observação (opcional) — ${esc(p.nome)}</label>
    <textarea placeholder="Ex.: retorno rápido, orientação, ajuste..."></textarea>
    <div class="avulso-form-actions">
      <button class="btn-cancelar" data-avulso-cancelar>Cancelar</button>
      <button class="btn-confirmar" data-avulso-confirmar>Confirmar</button>
    </div>
  </div>`;
}

function bodyHtml(p) {
  let html = '';
  if (p.plano && p.itens && p.itens.length) {
    html += '<div class="etapas-title">Etapas</div>';
    for (const item of p.itens) for (const et of (item.etapas || [])) html += etapaRowHtml(item, et);
  } else if (p.plano) {
    html += '<div class="sem-plano">Plano sem etapas cadastradas.</div>';
  } else {
    html += '<div class="sem-plano">Sem plano de tratamento.</div>';
  }
  html += `<button class="btn-avulso" data-avulso-toggle>+ Atendimento realizado</button>`;
  html += avulsoFormHtml(p);
  return html;
}

function cardHtml(p, showDent = true) {
  const pid = String(p.paciente_clinicorp_id);
  const open = openSet.has(pid);
  const horario = p.horario ? esc(String(p.horario).slice(0, 5)) : '';
  const dent = showDent && p.dentista ? `<span class="card-dent">${esc(p.dentista)}</span>` : '';
  const ok = p.ja_registrado_hoje ? '<span class="chip chip-ok">✓ registrado</span>' : '';
  return `<div class="card ${open ? 'open' : ''}" data-pid="${esc(pid)}">
    <div class="card-head" data-toggle>
      <div class="card-name-wrap">
        <div class="card-name">${esc(p.nome)}</div>
        <div class="card-sub">${horario ? `<span>${horario}</span>` : ''}${dent}${chipPlano(p.plano)}${ok}</div>
      </div>
      <div class="card-arrow">▾</div>
    </div>
    <div class="card-body">${open ? bodyHtml(p) : ''}</div>
  </div>`;
}

function render() {
  const el = document.getElementById('conteudo');
  if (!pacientesAtuais.length) {
    el.innerHTML = `<div class="empty">${modo === 'busca' ? 'Nenhum paciente encontrado.' : 'Nenhum comparecimento neste dia.'}</div>`;
    return;
  }
  // busca = lista simples (dentista aparece no próprio cartão)
  if (modo === 'busca') { el.innerHTML = pacientesAtuais.map(p => cardHtml(p, true)).join(''); return; }
  // dia = agrupa por dentista (o nome vira cabeçalho do grupo)
  const grupos = new Map();
  for (const p of pacientesAtuais) {
    const d = (p.dentista || '').trim() || 'Sem dentista definido';
    if (!grupos.has(d)) grupos.set(d, []);
    grupos.get(d).push(p);
  }
  const nomes = [...grupos.keys()].sort((a, b) =>
    a === 'Sem dentista definido' ? 1 : b === 'Sem dentista definido' ? -1 : a.localeCompare(b, 'pt'));
  el.innerHTML = nomes.map(d =>
    `<div class="grp-dent">🦷 ${esc(d)} <span class="grp-n">${grupos.get(d).length}</span></div>` +
    grupos.get(d).map(p => cardHtml(p, false)).join('')
  ).join('');
}

// ── ações ─────────────────────────────────────────────────────────────────
async function marcarEtapa(row) {
  if (row.classList.contains('loading')) return;
  const etapaId = row.dataset.etapaId;
  const card = row.closest('.card');
  const pid = card ? card.dataset.pid : null;
  const body = { etapa_id: Number(etapaId), data: document.getElementById('dataInput').value };

  row.classList.add('loading');
  try {
    const resp = await api('/api/sessao/etapa', { method: 'POST', body: JSON.stringify(body) });
    const p = pacientesAtuais.find(x => String(x.paciente_clinicorp_id) === String(pid));
    if (p) {
      for (const item of p.itens || []) for (const et of item.etapas || []) if (String(et.id) === String(etapaId)) et.status = 'concluida';
      if (p.plano && resp.plano_status) p.plano.status = resp.plano_status;
      p.ja_registrado_hoje = true;
    }
    toast(resp.jaConcluida ? 'Etapa já estava concluída.' : 'Etapa registrada ✓');
    render();
  } catch (e) {
    row.classList.remove('loading');
    toast(e.message, true);
  }
}

async function confirmarAvulso(btn) {
  const form = btn.closest('[data-avulso-form]');
  const card = btn.closest('.card');
  const pid = card ? card.dataset.pid : null;
  const p = pacientesAtuais.find(x => String(x.paciente_clinicorp_id) === String(pid));
  const textarea = form ? form.querySelector('textarea') : null;
  const obs = textarea ? textarea.value.trim() : '';

  btn.disabled = true; btn.textContent = 'Enviando...';
  try {
    await api('/api/sessao/avulso', {
      method: 'POST',
      body: JSON.stringify({
        paciente_clinicorp_id: pid,
        paciente_nome: p ? p.nome : '',
        obs,
        data: document.getElementById('dataInput').value,
      }),
    });
    avulsoSet.delete(String(pid));
    if (p) p.ja_registrado_hoje = true;
    toast('Atendimento registrado ✓');
    render();
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false; btn.textContent = 'Confirmar';
  }
}

function onConteudoClick(ev) {
  const marcarRow = ev.target.closest('[data-etapa-row]');
  if (marcarRow && !ev.target.closest('input')) { marcarEtapa(marcarRow); return; }

  const toggle = ev.target.closest('[data-toggle]');
  if (toggle) {
    const pid = toggle.closest('.card').dataset.pid;
    if (openSet.has(pid)) openSet.delete(pid); else openSet.add(pid);
    render();
    return;
  }

  const avulsoToggle = ev.target.closest('[data-avulso-toggle]');
  if (avulsoToggle) {
    const pid = avulsoToggle.closest('.card').dataset.pid;
    if (avulsoSet.has(pid)) avulsoSet.delete(pid); else avulsoSet.add(pid);
    render();
    return;
  }

  const avulsoCancelar = ev.target.closest('[data-avulso-cancelar]');
  if (avulsoCancelar) {
    const pid = avulsoCancelar.closest('.card').dataset.pid;
    avulsoSet.delete(pid);
    render();
    return;
  }

  const avulsoConfirmar = ev.target.closest('[data-avulso-confirmar]');
  if (avulsoConfirmar) { confirmarAvulso(avulsoConfirmar); return; }
}
