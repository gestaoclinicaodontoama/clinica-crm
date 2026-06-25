const SELO_LABEL = { escalar:'🟢 Escalar', cortar:'🔴 Cortar/revisar', observar:'🟡 Observar', cobertura_baixa:'⚪ Cobertura baixa', caixa:'💰 Caixa' };
const fmt = n => (Number(n)||0).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
const pct = n => n == null ? '—' : Math.round(n*100) + '%';
let _state = { desde:null, ate:null, lente:'safra' };

async function carregar() {
  const lente = document.getElementById('lente').value;
  const periodo = document.getElementById('periodo').value;
  _state.lente = lente;
  document.getElementById('lista').innerHTML = 'Carregando…';
  try {
    const d = await mktApi(`/api/marketing/campanhas?lente=${lente}&periodo=${periodo}`);
    _state.desde = d.desde; _state.ate = d.ate;
    renderResumo(d); renderLista(d);
  } catch (e) { document.getElementById('lista').innerHTML = '<p style="color:#b91c1c">Erro: '+e.message+'</p>'; }
}

function renderResumo(d) {
  const t = d.totais, rec = d.lente === 'caixa' ? t.caixa : t.faturamento;
  document.getElementById('resumo').innerHTML = `<div class="mkt-card">
    <b>Resumo ${d.desde} → ${d.ate}</b> ${d.sem_token ? '· ⚠️ sem META_ACCESS_TOKEN (gasto = 0)' : ''}<br>
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
      <div><span class="mkt-selo selo-${c.selo}">${SELO_LABEL[c.selo]}</span> <b>${c.campanha}</b></div>
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
      return `<div>• ${l.nome||'(sem nome)'} — <span class="mkt-selo selo-${cls}">${l.vinculo}</span>
      ${l.paciente_nome?`→ ${l.paciente_nome}`:''} · fat ${fmt(l.faturamento)}
      ${l.vinculo!=='sem_paciente'?`<span class="mkt-clickable" data-lead="${l.lead_id}">ver pagamentos</span>`:''}</div>`;
    }).join('') : '<i>Sem leads.</i>';
    box.querySelectorAll('[data-lead]').forEach(el => el.onclick = () => verPaciente(el.dataset.lead, box));
  } catch (e) { box.innerHTML = 'Erro: '+e.message; }
}

async function verPaciente(leadId, box) {
  const d = await mktApi(`/api/marketing/drill/paciente?lead_id=${leadId}`);
  const div = document.createElement('div'); div.style.margin = '6px 0 6px 16px';
  if (!d.vinculado) { div.innerHTML = '<i>sem paciente vinculado</i>'; box.appendChild(div); return; }
  const f = d.financeiro || {};
  const lanc = d.lancamentos && d.lancamentos.length
    ? d.lancamentos.map(x => `${x.data} · ${x.tipo} · ${fmt(x.valor)} · ${x.descricao}`).join('<br>')
    : '<i>sem lançamentos</i>';
  div.innerHTML = `<b>${d.paciente.nome}</b> — pago ${fmt(f.pago)} · futuro ${fmt(f.futuro)}<br>${lanc}`;
  box.appendChild(div);
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
carregar();
