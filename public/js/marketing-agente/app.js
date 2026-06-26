const SELO_LABEL = { escalar:'🟢 Escalar', cortar:'🔴 Cortar/revisar', observar:'🟡 Observar', cobertura_baixa:'⚪ Cobertura baixa', caixa:'💰 Caixa' };
const fmt = n => (Number(n)||0).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
const pct = n => n == null ? '—' : Math.round(n*100) + '%';
// Escapa qualquer string vinda de sistema externo (nome de lead/paciente do WhatsApp,
// descrição do Clinicorp, nome de campanha do Meta) antes de ir pro innerHTML — anti-XSS.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
// Selo/vínculo vêm de enums do backend; ainda assim restringimos a um conjunto conhecido
// antes de usar em nome de classe CSS (defesa em profundidade).
const SELO_PILL = { escalar:'pill-green', cortar:'pill-red', observar:'pill-yellow', cobertura_baixa:'pill-muted', caixa:'pill-green' };
const seloPill = s => SELO_PILL[s] || 'pill-muted';
let _state = { desde:null, ate:null, lente:'safra' };
let _q = { dados: null }; // cache da resposta de qualidade-lead

function trocarAba(qual) {
  const roas = qual === 'roas';
  document.getElementById('tab-roas').style.display = roas ? '' : 'none';
  document.getElementById('tab-qualidade').style.display = roas ? 'none' : '';
  document.getElementById('aba-roas').classList.toggle('active', roas);
  document.getElementById('aba-qualidade').classList.toggle('active', !roas);
  if (!roas && !_q.dados) carregarQualidade();
}

// Soma as contagens dos status de uma métrica (o backend manda metricas[] como fonte de verdade).
function _valorMetrica(porStatus, metrica) {
  return (metrica.status || []).reduce((s, st) => s + ((porStatus && porStatus[st]) || 0), 0);
}
// Colunas da matriz (etapas do funil), na ordem do funil. A contagem de cada coluna vem
// dos status que a métrica agrupa (definição em metricas[] do backend).
const Q_COLS = [
  { key: 'sem_interesse', label: 'Perdidos', tom: 'ruim' },
  { key: 'qualificacao', label: 'Qualificados', tom: 'bom' },
  { key: 'agendada', label: 'Agendados', tom: 'bom' },
  { key: 'compareceu', label: 'Compareceu', tom: 'bom' },
  { key: 'negociacao', label: 'Em negociação', tom: 'bom' },
  { key: 'fechou', label: 'Fechou', tom: 'bom' },
];
let _qSort = 'total';   // coluna de ordenação: 'total' ou uma key de Q_COLS
let _qExpand = {};       // campanha_id -> bool (linha expandida mostrando os anúncios)
function _qMetrica(key) { const ms = (_q.dados && _q.dados.metricas) || []; return ms.find(m => m.key === key) || { key, status: [] }; }
function _qVal(porStatus, key) { return _valorMetrica(porStatus, _qMetrica(key)); }

function erro(el, msg) {
  const p = document.createElement('p'); p.style.color = '#b91c1c'; p.textContent = 'Erro: ' + msg;
  el.replaceChildren(p);
}

async function carregar() {
  const lente = document.getElementById('lente').value;
  const periodo = document.getElementById('periodo').value;
  _state.lente = lente;
  document.getElementById('lista').innerHTML = 'Carregando…';
  try {
    const d = await mktApi(`/api/marketing/campanhas?lente=${lente}&periodo=${periodo}`);
    _state.desde = d.desde; _state.ate = d.ate;
    renderResumo(d); renderLista(d);
  } catch (e) { erro(document.getElementById('lista'), e.message); }
}

function renderResumo(d) {
  const t = d.totais, rec = d.lente === 'caixa' ? t.caixa : t.faturamento;
  document.getElementById('resumo').innerHTML = `<div class="mkt-card">
    <b>Resumo ${esc(d.desde)} → ${esc(d.ate)}</b> ${d.sem_token ? '· ⚠️ sem META_ACCESS_TOKEN (gasto = 0)' : ''}<br>
    Gasto: <span class="mkt-num">${fmt(t.spend)}</span> ·
    ${d.lente==='caixa'?'Caixa':'Faturamento'}: <span class="mkt-num">${fmt(rec)}</span> ·
    ROAS: <b>${t.roas==null?'—':t.roas.toFixed(2)+'x'}</b> ·
    Cobertura: ${pct(t.cobertura)} (${t.leads_casados}/${t.leads_total} leads)</div>`;
}

function renderLista(d) {
  if (!d.campanhas.length) { document.getElementById('lista').innerHTML = '<p>Nenhuma campanha no período.</p>'; return; }
  document.getElementById('lista').innerHTML = d.campanhas.map((c, idx) => {
    const rec = d.lente==='caixa' ? c.caixa : c.faturamento;
    return `<div class="mkt-card">
      <div><span class="pill ${seloPill(c.selo)}">${esc(SELO_LABEL[c.selo] || c.selo)}</span> <b>${esc(c.campanha)}</b></div>
      <div class="mkt-num">Gasto ${fmt(c.spend)} · ${d.lente==='caixa'?'Caixa':'Faturamento'}
        <span class="mkt-clickable" data-drill="${idx}">${fmt(rec)}</span>
        · ROAS ${c.roas==null?'—':c.roas.toFixed(2)+'x'}</div>
      <div class="mkt-cobertura">Cobertura ${pct(c.cobertura)} (${c.leads_casados}/${c.leads_total})${c.incertos?` · ${c.incertos} vínculo(s) incerto(s)`:''} · contratado ${fmt(c.total_contratado)}</div>
      <div class="mkt-drill" id="drill-${idx}" style="display:none"></div>
    </div>`;
  }).join('');
  document.querySelectorAll('[data-drill]').forEach(el => el.onclick = () => abrirDrill(d.campanhas[el.dataset.drill], el.dataset.drill));
}

async function abrirDrill(camp, idx) {
  const box = document.getElementById('drill-'+idx);
  if (box.style.display === 'block') { box.style.display = 'none'; return; }
  box.style.display = 'block'; box.innerHTML = 'Carregando leads…';
  const adIds = camp.anuncios.map(a => a.ad_id).join(',');
  try {
    const d = await mktApi(`/api/marketing/drill/leads?ad_ids=${encodeURIComponent(adIds)}&lente=${_state.lente}&desde=${_state.desde}&ate=${_state.ate}`);
    box.innerHTML = d.leads.length ? d.leads.map(l => {
      const cls = l.vinculo==='casado' ? 'escalar' : (l.vinculo==='incerto' ? 'observar' : 'cobertura_baixa');
      const leadId = encodeURIComponent(l.lead_id);
      return `<div>• ${esc(l.nome || '(sem nome)')} — <span class="pill ${cls === 'escalar' ? 'pill-green' : cls === 'observar' ? 'pill-yellow' : 'pill-muted'}">${esc(l.vinculo)}</span>
      ${l.paciente_nome?`→ ${esc(l.paciente_nome)}`:''} · fat ${fmt(l.faturamento)}
      ${l.vinculo!=='sem_paciente'?`<span class="mkt-clickable" data-lead="${leadId}">ver pagamentos</span>`:''}</div>`;
    }).join('') : '<i>Sem leads.</i>';
    box.querySelectorAll('[data-lead]').forEach(el => el.onclick = () => verPaciente(el.dataset.lead, box));
  } catch (e) { erro(box, e.message); }
}

async function verPaciente(leadId, box) {
  const div = document.createElement('div'); div.style.margin = '6px 0 6px 16px';
  box.appendChild(div);
  try {
    const d = await mktApi(`/api/marketing/drill/paciente?lead_id=${encodeURIComponent(leadId)}`);
    if (!d.vinculado) { div.innerHTML = '<i>sem paciente vinculado</i>'; return; }
    const f = d.financeiro || {};
    const lanc = d.lancamentos && d.lancamentos.length
      ? d.lancamentos.map(x => `${esc(x.data)} · ${esc(x.tipo)} · ${fmt(x.valor)} · ${esc(x.descricao)}`).join('<br>')
      : '<i>sem lançamentos</i>';
    div.innerHTML = `<b>${esc(d.paciente.nome)}</b> — pago ${fmt(f.pago)} · vencido ${fmt(f.vencido)} · futuro ${fmt(f.futuro)}<br>${lanc}`;
  } catch (e) { div.textContent = 'Erro: ' + e.message; }
}

async function carregarQualidade() {
  const periodo = document.getElementById('q-periodo').value;
  document.getElementById('q-lista').innerHTML = 'Carregando…';
  document.getElementById('q-drill').innerHTML = '';
  try {
    const d = await mktApi(`/api/marketing/qualidade-lead?periodo=${periodo}`);
    _q.dados = d; _qExpand = {};
    renderQualidade();
  } catch (e) { erro(document.getElementById('q-lista'), e.message); }
}

function _qSortRows(campanhas) {
  return (campanhas || []).slice().sort((a, b) => {
    const va = _qSort === 'total' ? a.total : _qVal(a.por_status, _qSort);
    const vb = _qSort === 'total' ? b.total : _qVal(b.por_status, _qSort);
    return (vb - va) || (b.total - a.total);
  });
}

// Uma célula numérica clicável. `target` (JSON) diz o que abrir no drill.
function _qCell(porStatus, total, col, target) {
  const v = _qVal(porStatus, col.key);
  const tcls = col.tom === 'ruim' ? ' q-bad' : '';
  if (!v) return `<td class="q-num${tcls}"><span class="q-zero">·</span></td>`;
  const pctTxt = col.key === 'sem_interesse' && total > 0 ? `<span class="q-pct">${Math.round(100 * v / total)}%</span>` : '';
  return `<td class="q-num${tcls}"><span class="q-cell" data-drill='${target}' data-mkey="${col.key}">${v}${pctTxt}</span></td>`;
}

function renderQualidade() {
  const d = _q.dados; if (!d) return;
  const rows = _qSortRows(d.campanhas);
  _q.rows = rows;
  const sc = d.sem_campanha || { total: 0, por_status: {} };

  const naoResolvidas = rows.filter(c => !c.resolvido).length;
  document.getElementById('q-cobertura').innerHTML =
    `${rows.length} campanha(s) no período` + (naoResolvidas ? ` · ${naoResolvidas} sem nome identificado (anúncio antigo/sem acesso)` : '') +
    (d.sem_token ? ' · ⚠️ sem token Meta — mostrando IDs' : '');

  if (!rows.length && !sc.total) { document.getElementById('q-lista').innerHTML = '<p>Nenhum lead no período.</p>'; document.getElementById('q-semcamp').innerHTML = ''; return; }

  const th = (key, label, cls) => `<th class="${cls || ''}${_qSort === key ? ' q-sorted' : ''}" data-sort="${esc(key)}" title="Ordenar por ${esc(label)}">${esc(label)}</th>`;
  let html = `<div class="q-tablewrap"><table class="q-matrix"><thead><tr>
    <th class="q-th-camp">Campanha</th>
    ${th('total', 'Leads', 'q-num')}
    ${Q_COLS.map(c => th(c.key, c.label, 'q-num' + (c.tom === 'ruim' ? ' q-bad-h' : ''))).join('')}
  </tr></thead><tbody>`;

  rows.forEach((c, ci) => {
    const exp = !!_qExpand[c.campanha_id];
    html += `<tr class="q-row">
      <td class="q-camp"><span class="q-caret" data-exp="${ci}">${exp ? '▾' : '▸'}</span><span class="q-name" title="${esc(c.campanha_nome)}">${esc(c.campanha_nome)}</span></td>
      <td class="q-num q-total">${c.total}</td>
      ${Q_COLS.map(col => _qCell(c.por_status, c.total, col, JSON.stringify({ ci }))).join('')}
    </tr>`;
    if (exp) (c.anuncios || []).forEach((a, ai) => {
      html += `<tr class="q-adrow">
        <td class="q-camp q-ad"><span class="q-name" title="${esc(a.ad_name)}">↳ ${esc(a.ad_name)}</span></td>
        <td class="q-num q-total">${a.total}</td>
        ${Q_COLS.map(col => _qCell(a.por_status, a.total, col, JSON.stringify({ ci, ai }))).join('')}
      </tr>`;
    });
  });

  if (sc.total) html += `<tr class="q-row q-semcamp">
    <td class="q-camp"><span class="q-name">(sem campanha · orgânico/manual)</span></td>
    <td class="q-num q-total">${sc.total}</td>
    ${Q_COLS.map(col => _qCell(sc.por_status, sc.total, col, JSON.stringify({ none: true }))).join('')}
  </tr>`;

  html += `</tbody></table></div>`;
  document.getElementById('q-lista').innerHTML = html;
  document.getElementById('q-semcamp').innerHTML = '';

  document.querySelectorAll('.q-matrix th[data-sort]').forEach(el => el.onclick = () => { _qSort = el.dataset.sort; renderQualidade(); });
  document.querySelectorAll('.q-caret').forEach(el => el.onclick = () => { const c = rows[el.dataset.exp]; _qExpand[c.campanha_id] = !_qExpand[c.campanha_id]; renderQualidade(); });
  document.querySelectorAll('.q-cell').forEach(el => el.onclick = () => abrirQDrill(JSON.parse(el.dataset.drill), el.dataset.mkey));
}

async function abrirQDrill(target, metricaKey) {
  const box = document.getElementById('q-drill');
  const periodo = document.getElementById('q-periodo').value;
  const col = Q_COLS.find(c => c.key === metricaKey); const label = (col && col.label) || metricaKey;
  let url, titulo;
  if (target.none) {
    url = `/api/marketing/qualidade-lead/drill?campanha_id=__none__&metrica=${encodeURIComponent(metricaKey)}&periodo=${periodo}`;
    titulo = `(sem campanha) · ${label}`;
  } else {
    const c = _q.rows[target.ci];
    let adIds, nome;
    if (target.ai != null) { const a = c.anuncios[target.ai]; adIds = [a.ad_id]; nome = a.ad_name; }
    else { adIds = (c.anuncios || []).map(a => a.ad_id); nome = c.campanha_nome; }
    url = `/api/marketing/qualidade-lead/drill?ad_ids=${encodeURIComponent(adIds.join(','))}&metrica=${encodeURIComponent(metricaKey)}&periodo=${periodo}`;
    titulo = `${nome} · ${label}`;
  }
  box.innerHTML = '<div class="mkt-card">Carregando leads…</div>';
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const r = await mktApi(url);
    const lista = r.leads.length ? r.leads.map(l =>
      `<div class="q-leadrow">• <a class="mkt-clickable" href="/?abrir_lead=${encodeURIComponent(l.lead_id)}" target="_blank" rel="noopener">${esc(l.nome || '(sem nome)')}</a>
        <span class="mkt-cobertura">— ${esc(l.status)} · ${esc((l.criado_em || '').slice(0, 10))}</span></div>`).join('') : '<i>Sem leads.</i>';
    box.innerHTML = `<div class="mkt-card"><div class="q-drill-head"><b>${esc(titulo)}</b> <span class="mkt-cobertura">(${r.leads.length})</span> <span class="mkt-clickable" id="q-drill-close">fechar ✕</span></div>${lista}</div>`;
    const cl = document.getElementById('q-drill-close'); if (cl) cl.onclick = () => { box.innerHTML = ''; };
  } catch (e) { erro(box, e.message); }
}

document.getElementById('atualizar').onclick = carregar;
document.getElementById('lente').onchange = carregar;
document.getElementById('periodo').onchange = carregar;
const cfgBg = document.getElementById('cfg-modal-bg');
document.getElementById('btn-config').onclick = async () => {
  const cfg = await mktApi('/api/marketing/config');
  document.getElementById('cfg-roas').value = cfg.meta_roas;
  document.getElementById('cfg-gasto').value = cfg.gasto_minimo;
  document.getElementById('cfg-mat').value = cfg.maturacao_dias;
  document.getElementById('cfg-cob').value = cfg.cobertura_minima;
  cfgBg.classList.add('open');
};
document.getElementById('cfg-cancelar').onclick = () => cfgBg.classList.remove('open');
cfgBg.onclick = (e) => { if (e.target === cfgBg) cfgBg.classList.remove('open'); };
document.getElementById('cfg-salvar').onclick = async () => {
  await mktApi('/api/marketing/config', { method: 'PUT', body: JSON.stringify({
    meta_roas: document.getElementById('cfg-roas').value,
    gasto_minimo: document.getElementById('cfg-gasto').value,
    maturacao_dias: document.getElementById('cfg-mat').value,
    cobertura_minima: document.getElementById('cfg-cob').value,
  }) });
  cfgBg.classList.remove('open');
  carregar();
};
document.getElementById('aba-roas').onclick = () => trocarAba('roas');
document.getElementById('aba-qualidade').onclick = () => trocarAba('qualidade');
document.getElementById('q-atualizar').onclick = carregarQualidade;
document.getElementById('q-periodo').onchange = carregarQualidade;
carregar();
