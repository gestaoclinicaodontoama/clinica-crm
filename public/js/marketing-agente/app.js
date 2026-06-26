// Agente de Marketing — visão unificada por campanha (gasto × receita × funil de leads).
const fmt = n => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
// Dinheiro compacto p/ caber na matriz (R$1,2k). Mantém centavos só p/ valores pequenos.
const fmtK = n => { n = Number(n) || 0; if (!n) return '·'; if (Math.abs(n) >= 1000) return 'R$' + (n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: n >= 10000 ? 0 : 1 }) + 'k'; return 'R$' + n.toLocaleString('pt-BR', { maximumFractionDigits: 0 }); };
// Anti-XSS: toda string externa (nome de campanha/anúncio do Meta, nome de lead/paciente) passa por aqui.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Colunas do funil (na ordem do funil). A contagem de cada coluna vem dos status que a
// métrica agrupa (metricas[] do backend é a fonte de verdade).
const Q_COLS = [
  { key: 'sem_interesse', label: 'Perdidos', tom: 'ruim' },
  { key: 'qualificacao', label: 'Qualificados', tom: 'bom' },
  { key: 'agendada', label: 'Agendados', tom: 'bom' },
  { key: 'compareceu', label: 'Compareceu', tom: 'bom' },
  { key: 'negociacao', label: 'Em negociação', tom: 'bom' },
  { key: 'fechou', label: 'Fechou', tom: 'bom' },
];

let _data = null;     // resposta de /visao-geral
let _rows = [];        // campanhas ordenadas (referência p/ drill)
let _sort = 'total';   // coluna de ordenação
let _expand = {};       // campanha_id -> bool
let _cfg = { meta_roas: 3 };

function erro(el, msg) { const p = document.createElement('p'); p.style.color = 'var(--red)'; p.textContent = 'Erro: ' + msg; el.replaceChildren(p); }

function _metrica(key) { const ms = (_data && _data.metricas) || []; return ms.find(m => m.key === key) || { key, status: [] }; }
function _val(porStatus, key) { const st = _metrica(key).status || []; return st.reduce((s, x) => s + ((porStatus && porStatus[x]) || 0), 0); }
function _roas(o) { return o.spend > 0 ? o.faturamento / o.spend : null; }
function _sortVal(o, key) {
  if (key === 'total') return o.total;
  if (key === 'spend') return o.spend;
  if (key === 'faturamento') return o.faturamento;
  if (key === 'caixa') return o.caixa;
  if (key === 'roas') { const r = _roas(o); return r == null ? -1 : r; }
  return _val(o.por_status, key);
}

function periodoQuery() {
  const v = document.getElementById('q-periodo').value;
  if (v === 'custom') {
    const d = document.getElementById('q-desde').value, a = document.getElementById('q-ate').value;
    if (d && a) return `desde=${encodeURIComponent(d)}&ate=${encodeURIComponent(a)}`;
  }
  return `periodo=${encodeURIComponent(v === 'custom' ? 90 : v)}`;
}

async function carregar() {
  document.getElementById('q-lista').innerHTML = 'Carregando…';
  document.getElementById('q-drill').innerHTML = '';
  try {
    const [d, cfg] = await Promise.all([
      mktApi(`/api/marketing/visao-geral?${periodoQuery()}`),
      mktApi('/api/marketing/config').catch(() => ({ meta_roas: 3 })),
    ]);
    _data = d; _cfg = cfg || { meta_roas: 3 }; _expand = {};
    render();
  } catch (e) { erro(document.getElementById('q-lista'), e.message); }
}

function _sortRows(campanhas) {
  return (campanhas || []).slice().sort((a, b) => (_sortVal(b, _sort) - _sortVal(a, _sort)) || (b.total - a.total));
}

// Célula de etapa do funil (clicável → leads da etapa).
function _cellFunil(o, col, target) {
  const v = _val(o.por_status, col.key);
  const tcls = col.tom === 'ruim' ? ' q-bad' : '';
  if (!v) return `<td class="q-num${tcls}"><span class="q-zero">·</span></td>`;
  const pctTxt = col.key === 'sem_interesse' && o.total > 0 ? `<span class="q-pct">${Math.round(100 * v / o.total)}%</span>` : '';
  return `<td class="q-num${tcls}"><span class="q-cell" data-fdrill='${target}' data-mkey="${col.key}">${v}${pctTxt}</span></td>`;
}
// Célula de receita (clicável → leads → pagamentos).
function _cellReceita(valor, target) {
  if (!valor) return `<td class="q-num q-money"><span class="q-zero">·</span></td>`;
  return `<td class="q-num q-money"><span class="q-cell" data-rdrill='${target}' title="${esc(fmt(valor))}">${fmtK(valor)}</span></td>`;
}
function _cellRoas(o) {
  const r = _roas(o);
  if (r == null) return `<td class="q-num q-money"><span class="q-zero">·</span></td>`;
  const meta = Number(_cfg.meta_roas) || 3;
  const cls = r >= meta ? 'q-roas-bom' : 'q-roas-ruim';
  return `<td class="q-num q-money"><span class="${cls}">${r.toFixed(1)}x</span></td>`;
}

function render() {
  const d = _data; if (!d) return;
  const rows = _sortRows(d.campanhas); _rows = rows;
  const sc = d.sem_campanha || { total: 0, por_status: {} };

  const naoResolvidas = rows.filter(c => !c.resolvido).length;
  document.getElementById('q-cobertura').innerHTML =
    `${esc(d.desde)} → ${esc(d.ate)} · ${rows.length} campanha(s)` +
    (naoResolvidas ? ` · ${naoResolvidas} sem nome (anúncio antigo/sem acesso)` : '') +
    (d.sem_token ? ' · ⚠️ sem token Meta — gasto/nome indisponíveis' : '');

  if (!rows.length && !sc.total) { document.getElementById('q-lista').innerHTML = '<p>Nenhum dado no período.</p>'; return; }

  const th = (key, label, cls) => `<th class="${cls || ''}${_sort === key ? ' q-sorted' : ''}" data-sort="${esc(key)}" title="Ordenar por ${esc(label)}">${esc(label)}</th>`;
  let html = `<div class="q-tablewrap"><table class="q-matrix"><thead><tr>
    <th class="q-th-camp">Campanha</th>
    ${th('spend', 'Gasto', 'q-num q-money q-sep')}
    ${th('faturamento', 'Faturam.', 'q-num q-money')}
    ${th('caixa', 'Caixa', 'q-num q-money')}
    ${th('roas', 'ROAS', 'q-num q-money')}
    ${th('total', 'Leads', 'q-num q-sep')}
    ${Q_COLS.map(c => th(c.key, c.label, 'q-num' + (c.tom === 'ruim' ? ' q-bad-h' : ''))).join('')}
  </tr></thead><tbody>`;

  const moneyCells = (o, target) => `
    <td class="q-num q-money q-sep">${o.spend ? fmtK(o.spend) : '<span class="q-zero">·</span>'}</td>
    ${_cellReceita(o.faturamento, target)}
    ${_cellReceita(o.caixa, target)}
    ${_cellRoas(o)}`;

  rows.forEach((c, ci) => {
    const exp = !!_expand[c.campanha_id];
    html += `<tr class="q-row">
      <td class="q-camp"><span class="q-caret" data-exp="${ci}">${exp ? '▾' : '▸'}</span><span class="q-name" title="${esc(c.campanha_nome)}">${esc(c.campanha_nome)}</span></td>
      ${moneyCells(c, JSON.stringify({ ci }))}
      <td class="q-num q-total q-sep">${c.total}</td>
      ${Q_COLS.map(col => _cellFunil(c, col, JSON.stringify({ ci }))).join('')}
    </tr>`;
    if (exp) (c.anuncios || []).forEach((a, ai) => {
      html += `<tr class="q-adrow">
        <td class="q-camp q-ad"><span class="q-name" title="${esc(a.ad_name)}">↳ ${esc(a.ad_name)}</span></td>
        ${moneyCells(a, JSON.stringify({ ci, ai }))}
        <td class="q-num q-total q-sep">${a.total}</td>
        ${Q_COLS.map(col => _cellFunil(a, col, JSON.stringify({ ci, ai }))).join('')}
      </tr>`;
    });
  });

  if (sc.total) html += `<tr class="q-row q-semcamp">
    <td class="q-camp"><span class="q-name">(sem campanha · orgânico/manual)</span></td>
    <td class="q-num q-money q-sep"><span class="q-zero">·</span></td><td class="q-num q-money"><span class="q-zero">·</span></td><td class="q-num q-money"><span class="q-zero">·</span></td><td class="q-num q-money"><span class="q-zero">·</span></td>
    <td class="q-num q-total q-sep">${sc.total}</td>
    ${Q_COLS.map(col => _cellFunil(sc, col, JSON.stringify({ none: true }))).join('')}
  </tr>`;

  html += `</tbody></table></div>`;
  document.getElementById('q-lista').innerHTML = html;

  document.querySelectorAll('.q-matrix th[data-sort]').forEach(el => el.onclick = () => { _sort = el.dataset.sort; render(); });
  document.querySelectorAll('.q-caret').forEach(el => el.onclick = () => { const c = rows[el.dataset.exp]; _expand[c.campanha_id] = !_expand[c.campanha_id]; render(); });
  document.querySelectorAll('[data-fdrill]').forEach(el => el.onclick = () => drillEtapa(JSON.parse(el.dataset.fdrill), el.dataset.mkey));
  document.querySelectorAll('[data-rdrill]').forEach(el => el.onclick = () => drillReceita(JSON.parse(el.dataset.rdrill)));
}

function _alvo(target) {
  // Resolve {ci,ai|none} -> { adIds, nome }
  if (target.none) return { none: true, nome: '(sem campanha)' };
  const c = _rows[target.ci];
  if (target.ai != null) { const a = c.anuncios[target.ai]; return { adIds: [a.ad_id], nome: a.ad_name }; }
  return { adIds: (c.anuncios || []).map(a => a.ad_id), nome: c.campanha_nome };
}

async function drillEtapa(target, metricaKey) {
  const box = document.getElementById('q-drill');
  const col = Q_COLS.find(c => c.key === metricaKey); const label = (col && col.label) || metricaKey;
  const t = _alvo(target);
  const base = t.none ? `campanha_id=__none__` : `ad_ids=${encodeURIComponent(t.adIds.join(','))}`;
  box.innerHTML = '<div class="mkt-card">Carregando leads…</div>'; box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const r = await mktApi(`/api/marketing/qualidade-lead/drill?${base}&metrica=${encodeURIComponent(metricaKey)}&${periodoQuery()}`);
    const lista = r.leads.length ? r.leads.map(l =>
      `<div class="q-leadrow">• <a class="mkt-clickable" href="/?abrir_lead=${encodeURIComponent(l.lead_id)}" target="_blank" rel="noopener">${esc(l.nome || '(sem nome)')}</a>
        <span class="mkt-cobertura">— ${esc(l.status)} · ${esc((l.criado_em || '').slice(0, 10))}</span></div>`).join('') : '<i>Sem leads.</i>';
    box.innerHTML = `<div class="mkt-card"><div class="q-drill-head"><b>${esc(t.nome)} · ${esc(label)}</b> <span class="mkt-cobertura">(${r.leads.length})</span> <span class="mkt-clickable" id="q-drill-x">fechar ✕</span></div>${lista}</div>`;
    const x = document.getElementById('q-drill-x'); if (x) x.onclick = () => { box.innerHTML = ''; };
  } catch (e) { erro(box, e.message); }
}

async function drillReceita(target) {
  const box = document.getElementById('q-drill');
  const t = _alvo(target); if (t.none || !t.adIds.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="mkt-card">Carregando receita…</div>'; box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const r = await mktApi(`/api/marketing/drill/leads?ad_ids=${encodeURIComponent(t.adIds.join(','))}&lente=safra&desde=${encodeURIComponent(_data.desde)}&ate=${encodeURIComponent(_data.ate)}`);
    const lista = r.leads.length ? r.leads.map(l => {
      const cls = l.vinculo === 'casado' ? 'pill-green' : (l.vinculo === 'incerto' ? 'pill-yellow' : 'pill-muted');
      return `<div class="q-leadrow">• ${esc(l.nome || '(sem nome)')} <span class="pill ${cls}">${esc(l.vinculo)}</span>
        ${l.paciente_nome ? `→ ${esc(l.paciente_nome)}` : ''} · fat ${fmt(l.faturamento)}
        ${l.vinculo !== 'sem_paciente' ? `<span class="mkt-clickable" data-pac="${encodeURIComponent(l.lead_id)}">ver pagamentos</span>` : ''}</div>`;
    }).join('') : '<i>Sem leads casados a pagamento.</i>';
    box.innerHTML = `<div class="mkt-card"><div class="q-drill-head"><b>${esc(t.nome)} · Receita</b> <span class="mkt-cobertura">(${r.leads.length})</span> <span class="mkt-clickable" id="q-drill-x">fechar ✕</span></div>${lista}</div>`;
    const x = document.getElementById('q-drill-x'); if (x) x.onclick = () => { box.innerHTML = ''; };
    box.querySelectorAll('[data-pac]').forEach(el => el.onclick = () => verPaciente(el.dataset.pac, el.closest('.q-leadrow')));
  } catch (e) { erro(box, e.message); }
}

async function verPaciente(leadId, anchor) {
  const div = document.createElement('div'); div.style.margin = '4px 0 8px 16px'; div.className = 'mkt-cobertura';
  anchor.appendChild(div); div.textContent = 'Carregando…';
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

// Período personalizado: mostra/esconde os campos de data.
document.getElementById('q-periodo').onchange = () => {
  const custom = document.getElementById('q-periodo').value === 'custom';
  document.getElementById('q-customrange').style.display = custom ? '' : 'none';
  if (!custom) carregar();
};
document.getElementById('q-atualizar').onclick = carregar;

// Modal de parâmetros (limiar de ROAS p/ colorir a coluna).
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

carregar();
