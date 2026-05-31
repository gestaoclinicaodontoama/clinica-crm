// public/js/comercial/app.js
const BRL = v => (v == null ? '—' : v.toLocaleString('pt-BR', { style:'currency', currency:'BRL' }));
const PCT = v => (v == null ? '—' : (v * 100).toFixed(1).replace('.', ',') + '%');
const NUM = v => (v == null ? '—' : String(v));

// Monta os cards de uma visão; omite os que não se aplicam (fonte null).
function cardsDe(v) {
  const out = [];
  const add = (cond, rotulo, val) => { if (cond) out.push([rotulo, val]); };
  add(v.leads_criados   != null, 'Leads criados',          NUM(v.leads_criados));
  add(true,                      'Agendamentos',           NUM(v.agendamentos));
  add(v.pct_agendamentos != null,'% de agendamentos',      PCT(v.pct_agendamentos));
  add(v.leads_agendados != null, 'Leads agendados',        `${v.leads_agendados} (${PCT(v.pct_leads_agendados)})`);
  add(true,                      'Comparecimentos',        NUM(v.comparecimentos));
  add(true,                      '% de comparecimentos',   PCT(v.pct_comparecimentos));
  add(true,                      'Fechamentos',            NUM(v.fechamentos));
  add(true,                      '% de fechamentos',       PCT(v.pct_fechamentos));
  add(true,                      'Valor em oportunidades', BRL(v.valor_oportunidades));
  add(true,                      'Valor fechado',          BRL(v.valor_fechamentos));
  add(true,                      'Ticket médio',           BRL(v.ticket_medio));
  add(true,                      'Taxa de conversão (R$)', PCT(v.taxa_conversao));
  return out;
}

function render(el, v) {
  el.innerHTML = cardsDe(v)
    .map(([r, val]) => `<div class="card"><div class="rotulo">${r}</div><div class="valor">${val}</div></div>`)
    .join('');
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
}

document.getElementById('f-from').value = primeiroDiaMes();
document.getElementById('f-to').value   = new Date().toISOString().slice(0, 10);
document.getElementById('f-aplicar').addEventListener('click', () => carregar().catch(e => alert('Erro: ' + e.message)));
carregar().catch(e => alert('Erro: ' + e.message));
