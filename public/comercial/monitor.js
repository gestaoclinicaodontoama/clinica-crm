// public/comercial/monitor.js — consome /api/comercial/monitor (Etapa 2)
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

const ETAPAS = [
  ['leads', 'Lead criado'],
  ['agendou', 'Agendou'],
  ['compareceu', 'Compareceu'],
  ['orcou', 'Orçou'],
  ['fechou', 'Fechou'],
];

async function carregar() {
  const preset = document.getElementById('f-preset').value;
  const qs = new URLSearchParams({ preset });
  if (preset === 'custom') {
    qs.set('from', document.getElementById('f-from').value);
    qs.set('to', document.getElementById('f-to').value);
  }
  let r;
  try {
    r = await fetch('/api/comercial/monitor?' + qs, { headers: { Authorization: 'Bearer ' + token() } });
  } catch { alert('Falha de rede ao carregar o monitor'); return; }
  if (!r.ok) { alert('Erro ao carregar o monitor (HTTP ' + r.status + ')'); return; }
  const d = await r.json();
  renderCobertura(d.cobertura);
  renderSaude(d.saude);
  renderTabela(d.dias);
}

function renderCobertura(c) {
  document.getElementById('cobertura').innerHTML = ETAPAS.map(([id, rotulo]) => {
    const ok = !!c[id];
    return `<div class="cob ${ok ? 'ok' : 'faltando'}">${ok ? '✅' : '⚠'} ${rotulo}</div>`;
  }).join('');
}

function renderSaude(s) {
  const semOrigem = s.leads_sem_origem;
  const semValor = s.fechamentos_sem_valor;
  const orfas = s.transicoes_orfas;
  const totalOrfas = orfas.compareceu_sem_agendou + orfas.fechou_sem_compareceu;
  const card = (rotulo, valor, ruim) =>
    `<div class="alerta ${ruim ? 'ruim' : ''}"><div class="rotulo">${rotulo}</div><div class="valor">${valor}</div></div>`;
  document.getElementById('saude').innerHTML = [
    card('Leads sem origem', `${semOrigem.n}/${semOrigem.total} (${fmtPct(semOrigem.pct)})`, semOrigem.n > 0),
    card('Fechamentos sem valor', `${semValor.n}/${semValor.total}`, semValor.n > 0),
    card('Transições órfãs', String(totalOrfas), totalOrfas > 0),
  ].join('');
}

function renderTabela(dias) {
  if (!dias.length) { document.getElementById('tabela').innerHTML = '<p style="color:var(--muted);font-size:13px">Sem atividade no período.</p>'; return; }
  const linhas = dias.map(d =>
    `<tr><td>${d.data}</td><td>${d.leads}</td><td>${d.agendou}</td><td>${d.compareceu}</td><td>${d.orcou}</td><td>${d.fechou}</td><td>${fmtBRL(d.venda)}</td></tr>`
  ).join('');
  document.getElementById('tabela').innerHTML =
    `<table><thead><tr><th>Dia</th><th>Leads</th><th>Agendou</th><th>Compareceu</th><th>Orçou</th><th>Fechou</th><th>Venda</th></tr></thead><tbody>${linhas}</tbody></table>`;
}

document.getElementById('f-preset').addEventListener('change', (e) => {
  const custom = e.target.value === 'custom';
  document.getElementById('f-from').disabled = !custom;
  document.getElementById('f-to').disabled = !custom;
});
document.getElementById('f-aplicar').addEventListener('click', carregar);
carregar();
