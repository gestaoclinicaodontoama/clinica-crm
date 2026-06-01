const BRL = v => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style:'currency', currency:'BRL' }));
const fmtData = d => (d ? d.split('-').reverse().join('/') : '—');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

async function carregar() {
  const status = document.getElementById('f-status').value;
  const lista = document.getElementById('lista');
  lista.innerHTML = '<div class="vazio">Carregando...</div>';
  let data;
  try { data = await ComercialApi.listarConferencia(status); }
  catch (e) { lista.innerHTML = `<div class="vazio">Erro: ${esc(e.message)}</div>`; return; }

  const itens = data.fechamentos || [];
  document.getElementById('conta').textContent = `${itens.length} ${status}(s)`;
  if (!itens.length) { lista.innerHTML = '<div class="vazio">Nada por aqui.</div>'; return; }

  lista.innerHTML = itens.map(f => {
    const valor   = f.revisao_status === 'aprovado' ? f.valor_aprovado   : f.valor_particular;
    const entrada = f.revisao_status === 'aprovado' ? f.entrada_aprovada : f.entrada_valor;
    const acoes = status === 'pendente'
      ? `<div class="acoes">
           <button class="btn btn-ok" data-id="${f.clinicorp_estimate_id}" data-acao="aprovar">Aprovar</button>
           <button class="btn btn-no" data-id="${f.clinicorp_estimate_id}" data-acao="rejeitar">Rejeitar</button>
         </div>`
      : `<div class="sub">${esc(f.revisao_status)}${f.revisao_motivo ? ' · ' + esc(f.revisao_motivo) : ''}</div>`;
    return `<div class="linha" data-row="${f.clinicorp_estimate_id}">
      <div><div class="nome">${esc(f.paciente_nome) || '(sem nome)'}</div><div class="sub">${fmtData(f.data_fechamento)}</div></div>
      <div class="sub">${esc(f.profissional_nome)}</div>
      <div class="sub">${BRL(valor)}</div>
      <div><span class="lbl">Valor (R$)</span><input type="number" step="0.01" id="v-${f.clinicorp_estimate_id}" value="${Number(valor || 0)}" ${status !== 'pendente' ? 'disabled' : ''}></div>
      <div><span class="lbl">Entrada (R$)</span><input type="number" step="0.01" id="e-${f.clinicorp_estimate_id}" value="${Number(entrada || 0)}" ${status !== 'pendente' ? 'disabled' : ''}></div>
      ${acoes}
    </div>`;
  }).join('');

  lista.querySelectorAll('button[data-acao]').forEach(btn => {
    btn.addEventListener('click', () => acao(btn.dataset.id, btn.dataset.acao));
  });
}

async function acao(id, tipo) {
  try {
    if (tipo === 'aprovar') {
      const valor = parseFloat(document.getElementById('v-' + id).value);
      const entrada = parseFloat(document.getElementById('e-' + id).value);
      await ComercialApi.revisarConferencia(id, { acao: 'aprovar', valor, entrada });
    } else {
      const motivo = (prompt('Motivo da rejeição:') || '').trim();
      if (!motivo) { alert('Motivo é obrigatório.'); return; }
      await ComercialApi.revisarConferencia(id, { acao: 'rejeitar', motivo });
    }
    const row = document.querySelector(`.linha[data-row="${id}"]`);
    if (row) row.remove();
  } catch (e) { alert('Erro: ' + e.message); }
}

document.getElementById('f-status').addEventListener('change', carregar);
carregar();
