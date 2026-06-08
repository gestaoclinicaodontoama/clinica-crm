// public/comercial/dashboard.js — consome /api/comercial/dashboard e desenha (Chart.js)
function token() {
  for (const k in localStorage) {
    if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
      try { return JSON.parse(localStorage[k]).access_token; } catch { /* ignora */ }
    }
  }
  return null;
}
const fmtBRL = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtPct = (v) => v == null ? '—' : (v * 100).toFixed(1) + '%';
let chartTend, chartDow;

async function carregar() {
  const preset = document.getElementById('f-preset').value;
  const origem = document.getElementById('f-origem').value;
  const qs = new URLSearchParams({ preset, origem });
  if (preset === 'custom') {
    qs.set('from', document.getElementById('f-from').value);
    qs.set('to', document.getElementById('f-to').value);
  }
  let r;
  try {
    r = await fetch('/api/comercial/dashboard?' + qs, { headers: { Authorization: 'Bearer ' + token() } });
  } catch { alert('Falha de rede ao carregar o dashboard'); return; }
  if (!r.ok) { alert('Erro ao carregar dashboard (HTTP ' + r.status + ')'); return; }
  const d = await r.json();
  renderKpis(d.kpis, d.comparacao);
  renderFunil(d.funil);
  renderOrigens(d.origens, origem);
  renderTendencia(d.serie);
  renderDow(d.por_dia_semana);
}

function renderKpis(k, c) {
  const card = (rotulo, valor, delta) =>
    `<div class="kpi"><div class="kpi-rotulo">${rotulo}</div><div class="kpi-valor">${valor}</div>` +
    (delta != null ? `<div class="kpi-delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${fmtPct(Math.abs(delta))}</div>` : '') +
    `</div>`;
  document.getElementById('kpis').innerHTML = [
    card('Venda (contrato)', fmtBRL(k.venda), c.venda.delta_pct),
    card('Entrada (caixa)', fmtBRL(k.entrada), null),
    card('Leads', k.leads, c.leads.delta_pct),
    card('Fechamentos', k.fechamentos, c.fechamentos.delta_pct),
    card('Ticket médio', fmtBRL(k.ticket_medio), null),
  ].join('');
}

function renderFunil(f) {
  document.getElementById('funil').innerHTML = f.etapas.map(e => {
    const garg = f.gargalo && f.gargalo.id === e.id ? ' gargalo' : '';
    const susp = e.cobertura_suspeita ? ' <span class="aviso" title="Cobertura de dado incompleta nesta etapa">⚠</span>' : '';
    const conv = e.conv_etapa_anterior == null ? '' : `<span class="conv">${fmtPct(e.conv_etapa_anterior)} da etapa anterior</span>`;
    return `<div class="etapa${garg}"><b>${e.rotulo}</b><span class="n">${e.n}</span>${conv}${susp}</div>`;
  }).join('');
}

function renderOrigens(origens, sel) {
  const s = document.getElementById('f-origem');
  if (s.options.length > 1) return; // já populado
  for (const o of origens) {
    const opt = document.createElement('option');
    opt.value = o; opt.textContent = o;
    if (o === sel) opt.selected = true;
    s.appendChild(opt);
  }
}

function semChart(ctx, msg) {
  ctx.parentElement.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:24px;text-align:center">${msg}</div>`;
}
function renderTendencia(serie) {
  const ctx = document.getElementById('g-tendencia');
  if (typeof Chart === 'undefined') { semChart(ctx, '📈 Gráfico indisponível (Chart.js não carregado — rodar o vendor em public/js/vendor/)'); return; }
  const labels = serie.pontos.map(p => p.data);
  if (chartTend) chartTend.destroy();
  chartTend = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Leads', data: serie.pontos.map(p => p.leads) },
        { label: 'Comparecimentos', data: serie.pontos.map(p => p.comparecimentos) },
        { label: 'Fechamentos', data: serie.pontos.map(p => p.fechamentos) },
      ],
    },
    options: { responsive: true, plugins: { title: { display: true, text: `Atividade por ${serie.granularidade}` } } },
  });
}

function renderDow(dows) {
  const ctx = document.getElementById('g-dow');
  if (typeof Chart === 'undefined') { semChart(ctx, '📊 Gráfico indisponível (Chart.js não carregado)'); return; }
  if (chartDow) chartDow.destroy();
  chartDow = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: dows.map(d => d.dia),
      datasets: [
        { label: 'Leads', data: dows.map(d => d.leads) },
        { label: 'Fechamentos', data: dows.map(d => d.fechamentos) },
      ],
    },
    options: { responsive: true, plugins: { title: { display: true, text: 'Por dia da semana' } } },
  });
}

document.getElementById('f-preset').addEventListener('change', (e) => {
  const custom = e.target.value === 'custom';
  document.getElementById('f-from').disabled = !custom;
  document.getElementById('f-to').disabled = !custom;
});
document.getElementById('f-aplicar').addEventListener('click', carregar);
carregar();
