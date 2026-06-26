const SELO_LABEL = { escalar:'🟢 Escalar', cortar:'🔴 Cortar/revisar', observar:'🟡 Observar', cobertura_baixa:'⚪ Cobertura baixa', caixa:'💰 Caixa' };
const fmt = n => (Number(n)||0).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
const pct = n => n == null ? '—' : Math.round(n*100) + '%';
// Escapa qualquer string vinda de sistema externo (nome de lead/paciente do WhatsApp,
// descrição do Clinicorp, nome de campanha do Meta) antes de ir pro innerHTML — anti-XSS.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
// Selo/vínculo vêm de enums do backend; ainda assim restringimos a um conjunto conhecido
// antes de usar em nome de classe CSS (defesa em profundidade).
const SELO_OK = new Set(['escalar','cortar','observar','cobertura_baixa','caixa']);
const seloClass = s => SELO_OK.has(s) ? s : 'cobertura_baixa';
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

// Reimplementa o ranking do lib/marketing/qualidade.js no cliente (8 linhas; o backend
// envia `metricas[]` como fonte de verdade do mapeamento status→etapa).
function _valorMetrica(porStatus, metrica) {
  return (metrica.status || []).reduce((s, st) => s + ((porStatus && porStatus[st]) || 0), 0);
}
function _rank(campanhas, metrica, ordenarPor, minLeads) {
  let rows = (campanhas || []).map(c => {
    const valor = _valorMetrica(c.por_status, metrica);
    return Object.assign({}, c, { valor, taxa: c.total > 0 ? valor / c.total : 0 });
  }).filter(r => r.valor > 0);
  if (ordenarPor === 'taxa') rows = rows.filter(r => r.total >= minLeads).sort((a, b) => (b.taxa - a.taxa) || (b.valor - a.valor));
  else rows.sort((a, b) => (b.valor - a.valor) || (b.taxa - a.taxa));
  return rows;
}
function _metricaAtual() {
  const key = document.getElementById('q-metrica').value;
  const ms = (_q.dados && _q.dados.metricas) || [];
  return ms.find(m => m.key === key) || ms[0] || { key: 'sem_interesse', label: 'Sem interesse', status: ['Perdido', 'Não tem Interesse'], tom: 'ruim' };
}

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
      <div><span class="mkt-selo selo-${seloClass(c.selo)}">${esc(SELO_LABEL[c.selo] || c.selo)}</span> <b>${esc(c.campanha)}</b></div>
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
      return `<div>• ${esc(l.nome || '(sem nome)')} — <span class="mkt-selo selo-${cls}">${esc(l.vinculo)}</span>
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
  try {
    const d = await mktApi(`/api/marketing/qualidade-lead?periodo=${periodo}`);
    _q.dados = d;
    const sel = document.getElementById('q-metrica');
    if (!sel.options.length) {
      sel.innerHTML = d.metricas.map(m => `<option value="${esc(m.key)}">${esc(m.label)}</option>`).join('');
    }
    renderQualidade();
  } catch (e) { erro(document.getElementById('q-lista'), e.message); }
}

function renderQualidade() {
  const d = _q.dados; if (!d) return;
  const metrica = _metricaAtual();
  const ordenarPor = document.getElementById('q-ordenar').value;
  const minLeads = parseInt(document.getElementById('q-minleads').value, 10) || 1;
  const rows = _rank(d.campanhas, metrica, ordenarPor, minLeads);
  const pillCls = metrica.tom === 'ruim' ? 'pill-red' : 'pill-green';

  // Cobertura da etapa: quantos leads da etapa têm campanha identificada.
  const comCamp = d.campanhas.reduce((s, c) => s + _valorMetrica(c.por_status, metrica), 0);
  const semCamp = _valorMetrica(d.sem_campanha.por_status, metrica);
  const totalEtapa = comCamp + semCamp;
  document.getElementById('q-cobertura').innerHTML = totalEtapa
    ? `${Math.round(100 * comCamp / totalEtapa)}% dos leads de "${esc(metrica.label)}" têm campanha identificada (${comCamp} de ${totalEtapa})` + (d.sem_token ? ' · ⚠️ sem token Meta: mostrando IDs' : '')
    : `Nenhum lead em "${esc(metrica.label)}" no período.`;

  document.getElementById('q-lista').innerHTML = rows.length ? rows.map((c, idx) => `
    <div class="mkt-card">
      <div><span class="pill ${pillCls}">${c.valor} ${esc(metrica.label)}</span>
        <b>${esc(c.campanha_nome)}</b>${c.resolvido ? '' : ' <span class="mkt-cobertura">(ID não resolvido)</span>'}</div>
      <div class="mkt-cobertura mkt-num">${Math.round(c.taxa * 100)}% dos ${c.total} leads da campanha ·
        <span class="mkt-clickable" data-qcamp="${idx}">ver leads</span></div>
      <div class="mkt-drill" id="qdrill-${idx}" style="display:none"></div>
    </div>`).join('') : '<p>Nenhuma campanha nessa etapa/critério.</p>';
  document.querySelectorAll('[data-qcamp]').forEach(el => el.onclick = () => abrirQDrill(rows[el.dataset.qcamp], el.dataset.qcamp, metrica.key));

  const sc = d.sem_campanha; const scVal = _valorMetrica(sc.por_status, metrica);
  document.getElementById('q-semcamp').innerHTML = scVal ? `
    <div class="mkt-card" style="opacity:.7">
      <span class="pill pill-muted">${scVal}</span> <b>(sem campanha)</b>
      <span class="mkt-cobertura"> · leads sem origem de campanha (orgânico/manual) · </span>
      <span class="mkt-clickable" data-qcamp-none="1">ver leads</span>
      <div class="mkt-drill" id="qdrill-none" style="display:none"></div>
    </div>` : '';
  const noneEl = document.querySelector('[data-qcamp-none]');
  if (noneEl) noneEl.onclick = () => abrirQDrill({ campanha_id: '__none__' }, 'none', metrica.key);
}

async function abrirQDrill(camp, idx, metricaKey) {
  const box = document.getElementById('qdrill-' + idx);
  if (box.style.display === 'block') { box.style.display = 'none'; return; }
  box.style.display = 'block'; box.innerHTML = 'Carregando leads…';
  const periodo = document.getElementById('q-periodo').value;
  try {
    const d = await mktApi(`/api/marketing/qualidade-lead/drill?campanha_id=${encodeURIComponent(camp.campanha_id)}&metrica=${encodeURIComponent(metricaKey)}&periodo=${periodo}`);
    box.innerHTML = d.leads.length ? d.leads.map(l =>
      `<div>• <a class="mkt-clickable" href="/?abrir_lead=${encodeURIComponent(l.lead_id)}" target="_blank" rel="noopener">${esc(l.nome || '(sem nome)')}</a>
        <span class="mkt-cobertura">— ${esc(l.status)} · ${esc((l.criado_em || '').slice(0, 10))}</span></div>`
    ).join('') : '<i>Sem leads.</i>';
  } catch (e) { erro(box, e.message); }
}

document.getElementById('atualizar').onclick = carregar;
document.getElementById('lente').onchange = carregar;
document.getElementById('periodo').onchange = carregar;
document.getElementById('btn-config').onclick = async () => {
  const cfg = await mktApi('/api/marketing/config');
  const roas = prompt('Meta de ROAS (x):', cfg.meta_roas); if (roas === null) return;
  const gasto = prompt('Gasto mínimo (R$):', cfg.gasto_minimo); if (gasto === null) return;
  const mat = prompt('Maturação (dias):', cfg.maturacao_dias); if (mat === null) return;
  const cob = prompt('Cobertura mínima (0–1):', cfg.cobertura_minima); if (cob === null) return;
  await mktApi('/api/marketing/config', { method:'PUT', body: JSON.stringify({ meta_roas:roas, gasto_minimo:gasto, maturacao_dias:mat, cobertura_minima:cob }) });
  carregar();
};
document.getElementById('aba-roas').onclick = () => trocarAba('roas');
document.getElementById('aba-qualidade').onclick = () => trocarAba('qualidade');
document.getElementById('q-atualizar').onclick = carregarQualidade;
document.getElementById('q-periodo').onchange = carregarQualidade;
['q-metrica', 'q-ordenar', 'q-minleads'].forEach(id => document.getElementById(id).addEventListener('change', renderQualidade));
carregar();
