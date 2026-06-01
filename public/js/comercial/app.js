// public/js/comercial/app.js
const BRL = v => (v == null ? '—' : v.toLocaleString('pt-BR', { style:'currency', currency:'BRL' }));
const PCT = v => (v == null ? '—' : (v * 100).toFixed(1).replace('.', ',') + '%');
const NUM = v => (v == null ? '—' : String(v));
const DIAS = v => (v == null ? '—' : `${v} ${v === 1 ? 'dia' : 'dias'}`);

// Monta os cards de uma visão; omite os que não se aplicam (fonte null).
// Topo do funil = só atividade (por mês de avaliação). Fechamento/valor vivem no bloco próprio.
function cardsDe(v) {
  const out = [];
  const add = (cond, rotulo, val) => { if (cond) out.push([rotulo, val]); };
  add(v.leads_criados   != null, 'Leads criados',        NUM(v.leads_criados));
  add(true,                      'Agendamentos',         NUM(v.agendamentos));
  add(v.pct_agendamentos != null,'% de agendamentos',    PCT(v.pct_agendamentos));
  add(v.leads_agendados != null, 'Leads agendados',      `${v.leads_agendados} (${PCT(v.pct_leads_agendados)})`);
  add(true,                      'Comparecimentos',      NUM(v.comparecimentos));
  add(true,                      '% de comparecimentos', PCT(v.pct_comparecimentos));
  return out;
}

function render(el, v) {
  el.innerHTML = cardsDe(v)
    .map(([r, val]) => `<div class="card"><div class="rotulo">${r}</div><div class="valor">${val}</div></div>`)
    .join('');
}

function cardsFech(f) {
  return [
    ['Fechamentos no mês', NUM(f.fechamentos)],
    ['Valor fechado', BRL(f.valor_fechado)],
    ['Entradas recebidas', BRL(f.entradas_recebidas)],
    ['Ticket médio', BRL(f.ticket_medio)],
    ['Tempo médio até fechar', DIAS(f.tempo_medio_ate_fechar)],
    ['Origem do fechamento', `${PCT(f.origem_fechamento.pct_mesmo_mes)} no mês · ${f.origem_fechamento.meses_anteriores} de antes`],
  ];
}
function renderFechamentosGrupo(el, f) {
  el.innerHTML = cardsFech(f)
    .map(([r, val]) => `<div class="card"><div class="rotulo">${r}</div><div class="valor">${val}</div></div>`)
    .join('');
}

function renderFases(el, grupo, t) {
  const itens = grupo === 'clinica'
    ? [['Agendou → Compareceu', t.agendou_compareceu], ['Compareceu → Fechou', t.compareceu_fechou]]
    : [['Lead → Agendou', t.lead_agendou], ['Agendou → Compareceu', t.agendou_compareceu], ['Compareceu → Fechou', t.compareceu_fechou]];
  const titulo = grupo === 'clinica' ? 'Clínica' : 'Leads rastreados';
  el.innerHTML = `<div class="fase" style="background:none;border:none;padding:10px 4px"><span class="grupo">${titulo}</span></div>` +
    itens.map(([r, v]) => `<div class="fase">${r}<b>${DIAS(v)}</b></div>`).join('');
}

function primeiroDiaMes() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

async function carregar() {
  const from = document.getElementById('f-from').value;
  const to   = document.getElementById('f-to').value;
  const origem = document.getElementById('f-origem').value;
  const data = await ComercialApi.getFunil({ from, to, origem });

  // popular seletor de origens (uma vez)
  const sel = document.getElementById('f-origem');
  if (sel.options.length <= 1 && data.origens) {
    for (const o of data.origens) sel.add(new Option(o, o));
  }
  render(document.getElementById('cards-clinica'), data.clinica);
  render(document.getElementById('cards-leads'), data.leads);
  renderFechamentosGrupo(document.getElementById('cards-fech-confirmado'), data.fechamentos_mes.confirmado);
  renderFechamentosGrupo(document.getElementById('cards-fech-pendente'), data.fechamentos_mes.pendente);
  renderFases(document.getElementById('fases-clinica'), 'clinica', data.tempos_fase.clinica);
  renderFases(document.getElementById('fases-leads'), 'leads', data.tempos_fase.leads);
}

document.getElementById('f-from').value = primeiroDiaMes();
document.getElementById('f-to').value   = new Date().toISOString().slice(0, 10);
document.getElementById('f-aplicar').addEventListener('click', () => carregar().catch(e => alert('Erro: ' + e.message)));
carregar().catch(e => alert('Erro: ' + e.message));
