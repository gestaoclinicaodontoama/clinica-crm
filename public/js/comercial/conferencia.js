const BRL = v => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style:'currency', currency:'BRL' }));
const fmtData = d => (d ? d.split('-').reverse().join('/') : '—');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function toast(msg, tipo = 'success') {
  const wrap = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast toast--${tipo}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

let _itens = [];        // itens carregados do banco (filtro de status atual)
let _status = 'pendente'; // status a que _itens corresponde (não ler o select ao renderizar)
let _carregando = false;
let _recarregarPendente = false;

function valorDe(f)   { return f.revisao_status === 'aprovado' ? f.valor_aprovado   : f.valor_particular; }
function entradaDe(f) { return f.revisao_status === 'aprovado' ? f.entrada_aprovada : f.entrada_valor; }

async function carregar() {
  // Se já há uma carga em andamento, marca para recarregar ao terminar — evita
  // descartar a troca de status e renderizar dados de um status com o rótulo de outro.
  if (_carregando) { _recarregarPendente = true; return; }
  _carregando = true;
  const status = document.getElementById('f-status').value;
  const lista = document.getElementById('lista');
  lista.innerHTML = '<div class="vazio">Carregando...</div>';
  let ok = false;
  try {
    const data = await ComercialApi.listarConferencia(status);
    _itens = data.fechamentos || [];
    _status = status;
    ok = true;
  } catch (e) {
    lista.innerHTML = `<div class="vazio">Erro: ${esc(e.message)}</div>`;
    _itens = [];
  } finally {
    _carregando = false;
  }
  if (ok) render();
  if (_recarregarPendente) { _recarregarPendente = false; carregar(); }
}

function render() {
  const status = _status;
  const lista = document.getElementById('lista');
  const termo = (document.getElementById('f-busca').value || '').trim().toLowerCase();

  const itens = termo
    ? _itens.filter(f => (`${f.paciente_nome || ''} ${f.profissional_nome || ''}`).toLowerCase().includes(termo))
    : _itens;

  const total = itens.reduce((s, f) => s + Number(valorDe(f) || 0), 0);
  document.getElementById('conta').innerHTML =
    `<strong>${itens.length}</strong> ${status}(s) · total <strong>${BRL(total)}</strong>`;

  if (!itens.length) {
    lista.innerHTML = `<div class="vazio">${termo ? 'Nenhum resultado para a busca.' : 'Nada por aqui.'}</div>`;
    return;
  }

  lista.innerHTML = itens.map(f => {
    const valor = valorDe(f), entrada = entradaDe(f);
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
    btn.addEventListener('click', () => acao(btn, btn.dataset.id, btn.dataset.acao));
  });
}

async function acao(btn, id, tipo) {
  const row = document.querySelector(`.linha[data-row="${id}"]`);
  const botoes = row ? row.querySelectorAll('button[data-acao]') : [btn];
  botoes.forEach(b => { b.disabled = true; });
  try {
    if (tipo === 'aprovar') {
      const valor = parseFloat(document.getElementById('v-' + id).value);
      const entrada = parseFloat(document.getElementById('e-' + id).value);
      await ComercialApi.revisarConferencia(id, { acao: 'aprovar', valor, entrada });
      toast('Fechamento aprovado');
    } else {
      const motivo = (prompt('Motivo da rejeição:') || '').trim();
      if (!motivo) { botoes.forEach(b => { b.disabled = false; }); return; }
      await ComercialApi.revisarConferencia(id, { acao: 'rejeitar', motivo });
      toast('Fechamento rejeitado');
    }
    _itens = _itens.filter(f => String(f.clinicorp_estimate_id) !== String(id));
    render();
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
    botoes.forEach(b => { b.disabled = false; });
  }
}

async function sincronizar() {
  const btn = document.getElementById('btn-sync');
  const label = document.getElementById('btn-sync-label');
  btn.disabled = true; btn.classList.add('loading');
  label.textContent = 'Sincronizando...';
  try {
    await ComercialApi.sincronizarClinicorp();
    toast('Sincronização iniciada — pode levar alguns minutos. A lista será atualizada ao concluir.');
    await aguardarSync();
  } catch (e) {
    toast('Erro ao sincronizar: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.classList.remove('loading');
    label.textContent = 'Atualizar dados';
  }
}

// Faz polling do status do sync por até ~10min; recarrega a lista ao concluir.
// Um sync pode dormir ~1h10 ao bater o rate limit da Clinicorp — por isso o
// timeout não significa "terminou", apenas que paramos de aguardar na tela.
async function aguardarSync() {
  const inicio = Date.now();
  while (Date.now() - inicio < 10 * 60 * 1000) {
    await new Promise(r => setTimeout(r, 6000));
    let st;
    try { st = await ComercialApi.syncStatus(); } catch (_) { continue; }
    if (st && st.running === false && st.last) {
      await carregar();
      if (st.last.ok) toast('Dados atualizados');
      else toast('Sync terminou com erro: ' + (st.last.error || 'desconhecido'), 'error');
      return;
    }
  }
  // timeout: o sync ainda pode estar rodando (ex.: espera de rate limit).
  toast('Sincronização ainda em andamento — recarregue a lista em alguns minutos.');
  await carregar();
}

document.getElementById('f-status').addEventListener('change', carregar);
document.getElementById('f-busca').addEventListener('input', render);
document.getElementById('btn-reload').addEventListener('click', carregar);
document.getElementById('btn-sync').addEventListener('click', sincronizar);
carregar();
