// public/js/pos-tratamento/shared.js
const MESES_PT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
const DIAS_PT  = ['Dom','Seg','Ter','Qua','Qui','Sex','Sab'];
const COR_CLASSE = { A: '#1E8449', B: '#1A5276', C: '#6B6A64' };

const HONORIFICOS = ['dr.','dra.','sr.','sra.','prof.','profa.'];
function primeiroNome(nome) {
  if (!nome || !nome.trim()) return '';
  const tokens = nome.trim().split(/\s+/);
  return tokens.find(t => !HONORIFICOS.includes(t.toLowerCase())) ?? tokens[0];
}

function formatarData(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getDate()} ${MESES_PT[d.getMonth()]} ${d.getFullYear()}`;
}

function formatarTelefone(tel) {
  if (!tel) return '-';
  const d = tel.replace(/\D/g, '');
  if (d.length === 13) return `(${d.slice(2,4)}) ${d.slice(4,9)}-${d.slice(9)}`;
  return tel;
}

function formatarMoeda(val) {
  if (val == null) return '-';
  return `R$ ${Number(val).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`;
}

function hojeISO() {
  return new Date().toISOString().slice(0, 10);
}

function inicioDoDiaHoje() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.toISOString();
}

function abrirWhatsApp(telefone, templateCorpo, nomeCompleto) {
  let tel = (telefone || '').replace(/\D/g, '');
  if (!tel) { alert('Telefone nao disponivel para este paciente.'); return; }
  if (tel.length === 10 || tel.length === 11) tel = '55' + tel;
  const primeiro = primeiroNome(nomeCompleto) || 'paciente';
  const msg = (templateCorpo || '').replace(/\{nome\}/g, primeiro);
  window.open(`https://wa.me/${tel}?text=${encodeURIComponent(msg)}`, '_blank');
}

function templateBar(containerId, chave, sb) {
  let templateData = { id: null, corpo: '' };
  const container = document.getElementById(containerId);

  async function carregar() {
    const { data, error } = await sb.from('mensagens_padrao_crc')
      .select('id, corpo').eq('chave', chave).single();
    if (!data) { console.error('templateBar:', error); return; }
    templateData = data;
    render();
  }

  function preview80(corpo) {
    return corpo.replace(/\n/g, ' ').slice(0, 80) + (corpo.length > 80 ? '...' : '');
  }

  const TITULO = { aniversario: 'Aniversario', recall: 'Recall', vip: 'VIP' };

  function render() {
    container.innerHTML = `
      <div class="template-bar">
        <span class="template-bar__icon">&#x1F4AC;</span>
        <span class="template-bar__label">MENSAGEM PADRAO</span>
        <span class="template-bar__preview">${preview80(templateData.corpo)}</span>
        <button class="btn btn--ghost btn--sm" id="${containerId}-edit">Editar</button>
      </div>
      <div class="modal-overlay hidden" id="${containerId}-modal">
        <div class="modal">
          <h3 class="modal__title">Editar — Mensagem de ${TITULO[chave] || chave}</h3>
          <p class="modal__hint">Use {nome} para inserir o primeiro nome automaticamente.</p>
          <textarea class="modal__textarea" id="${containerId}-ta" rows="5">${templateData.corpo}</textarea>
          <div class="modal__actions">
            <button class="btn btn--ghost" id="${containerId}-cancel">Cancelar</button>
            <button class="btn btn--primary" id="${containerId}-save">Salvar template</button>
          </div>
        </div>
      </div>`;
    document.getElementById(`${containerId}-edit`).onclick   = () => document.getElementById(`${containerId}-modal`).classList.remove('hidden');
    document.getElementById(`${containerId}-cancel`).onclick = () => document.getElementById(`${containerId}-modal`).classList.add('hidden');
    document.getElementById(`${containerId}-save`).onclick   = salvar;
  }

  async function salvar() {
    const novoCorpo = document.getElementById(`${containerId}-ta`).value.trim();
    if (!novoCorpo) return;
    const { error } = await sb.from('mensagens_padrao_crc').update({ corpo: novoCorpo }).eq('id', templateData.id);
    if (error) { alert('Erro ao salvar: ' + error.message); return; }
    templateData.corpo = novoCorpo;
    document.getElementById(`${containerId}-modal`).classList.add('hidden');
    render();
  }

  carregar();
  return { getCorpo: () => templateData.corpo };
}

// ADAPTED: includes date_contato (date column) for the UNIQUE index
// onConflict: 'paciente_id,tipo,date_contato' (not expression-based)
async function batchInsertRecallLogs(sb, pacienteIds, tipo, userId) {
  if (!pacienteIds.length) return { inserted: 0, error: null };
  const hoje = hojeISO();
  const rows = pacienteIds.map(pid => ({
    paciente_id: pid,
    tipo,
    contactado_por: userId,
    canal: 'whatsapp',
    data_contato: new Date().toISOString(),
    date_contato: hoje,
    status_envio: 'enviado',
    mensagem_id: null,
  }));
  const { error, count } = await sb.from('recall_logs').upsert(rows, {
    onConflict: 'paciente_id,tipo,date_contato',
    ignoreDuplicates: true,
    count: 'exact',
  });
  return { inserted: count ?? rows.length, error };
}

// ADAPTED: uses date_contato (date equality) instead of data_contato (timestamptz range)
async function idsJaLogadosHoje(sb, pacienteIds, tipo) {
  if (!pacienteIds.length) return new Set();
  const { data } = await sb.from('recall_logs').select('paciente_id')
    .eq('tipo', tipo).eq('date_contato', hojeISO()).in('paciente_id', pacienteIds);
  return new Set((data || []).map(r => r.paciente_id));
}

function toast(msg, tipo = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast--${tipo}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

export {
  MESES_PT, DIAS_PT, COR_CLASSE,
  primeiroNome, formatarData, formatarTelefone, formatarMoeda,
  hojeISO, inicioDoDiaHoje, abrirWhatsApp, templateBar,
  batchInsertRecallLogs, idsJaLogadosHoje, toast,
};