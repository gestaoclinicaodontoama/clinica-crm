// ---- Construtor: lê os campos do formulário e monta a "regra" ----
function coletarRegra() {
  const v = id => document.getElementById(id);
  const regra = {};
  const termo = v('f-termo').value.trim();
  if (termo) {
    const em = ['origem', 'conversa', 'anuncio'].filter(f => v('f-em-' + f).checked);
    regra.interesse = { termo, em };
  }
  const status = [...document.querySelectorAll('#f-status input:checked')].map(c => c.value);
  if (status.length) regra.status = status;
  const dias = parseInt(v('f-dias').value, 10);
  if (Number.isFinite(dias) && dias > 0) regra.periodo = { dias };
  const ddd = v('f-ddd').value.split(',').map(s => s.trim()).filter(s => /^\d{2}$/.test(s));
  if (ddd.length) regra.ddd = ddd;
  const origem = v('f-origem').value.split(',').map(s => s.trim()).filter(Boolean);
  if (origem.length) regra.origem = origem;
  const eng = {};
  if (v('f-respondeu').value) eng.respondeu = v('f-respondeu').value === 'sim';
  const ui = parseInt(v('f-ui-dias').value, 10);
  if (Number.isFinite(ui) && ui > 0) eng.ultima_interacao_dias = ui;
  if (v('f-janela24h').value) eng.janela24h = v('f-janela24h').value === 'sim';
  const camp = parseInt(v('f-recebeu-camp').value, 10);
  if (Number.isFinite(camp) && camp > 0) eng.recebeu_campanha_id = camp;
  if (Object.keys(eng).length) regra.engajamento = eng;
  return regra;
}

// ---- Inverso: aplica uma regra salva de volta no formulário ----
function preencherFormulario(regra) {
  const v = id => document.getElementById(id);
  regra = regra || {};
  const i = regra.interesse || {};
  v('f-termo').value = i.termo || '';
  const em = Array.isArray(i.em) ? i.em : ['origem', 'conversa', 'anuncio'];
  ['origem', 'conversa', 'anuncio'].forEach(f => { v('f-em-' + f).checked = !i.termo || em.includes(f); });
  const status = new Set(regra.status || []);
  document.querySelectorAll('#f-status input').forEach(c => { c.checked = status.has(c.value); });
  v('f-dias').value = (regra.periodo && regra.periodo.dias) || '';
  v('f-ddd').value = (regra.ddd || []).join(', ');
  v('f-origem').value = (regra.origem || []).join(', ');
  const eng = regra.engajamento || {};
  v('f-respondeu').value = eng.respondeu === true ? 'sim' : eng.respondeu === false ? 'nao' : '';
  v('f-ui-dias').value = eng.ultima_interacao_dias || '';
  v('f-janela24h').value = eng.janela24h === true ? 'sim' : eng.janela24h === false ? 'nao' : '';
  v('f-recebeu-camp').value = eng.recebeu_campanha_id || '';
}

// ---- Preview ao vivo (debounce) ----
let _previewTimer = null;
function agendarPreview() { clearTimeout(_previewTimer); _previewTimer = setTimeout(atualizarPreview, 400); }

function _esc(s) { return String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

async function atualizarPreview() {
  const total = document.getElementById('preview-total');
  total.textContent = 'carregando…';
  try {
    const r = await api('/api/publicos/preview', { method: 'POST', body: JSON.stringify({ regra: coletarRegra() }) });
    total.textContent = r.total + ' contatos';
    document.getElementById('preview-amostra').innerHTML = (r.amostra || []).map(l =>
      `<tr><td>${_esc(l.nome)}</td><td>${_esc(l.telefone)}</td><td>${_esc(l.status)}</td><td>${_esc(l.origem)}</td></tr>`).join('');
    const vazio = r.total === 0;
    ['btn-exportar', 'btn-disparar'].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = vazio; });
  } catch (e) { total.textContent = 'erro ao calcular'; console.error(e); }
}

// ---- Públicos salvos ----
async function carregarPublicos() {
  const box = document.getElementById('publicos-salvos');
  try {
    const lista = await api('/api/publicos');
    window._publicos = lista || [];
    box.innerHTML = (lista || []).map(p =>
      `<li data-id="${p.id}" style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
        <span>${_esc(p.nome)}</span>
        <span style="display:flex;gap:6px">
          <button class="btn" style="padding:3px 8px" onclick="aplicarPublico(${p.id})">abrir</button>
          <button class="btn" style="padding:3px 8px" onclick="excluirPublico(${p.id})">excluir</button>
        </span></li>`).join('') || '<li style="color:var(--muted)">nenhum público salvo</li>';
  } catch (e) { console.error(e); }
}
function aplicarPublico(id) {
  const p = (window._publicos || []).find(x => x.id === id);
  if (!p) return;
  preencherFormulario(p.regra || {});
  window._editandoId = id;
  document.getElementById('f-nome').value = p.nome || '';
  atualizarPreview();
}
async function excluirPublico(id) {
  if (!confirm('Excluir este público?')) return;
  try {
    await api('/api/publicos/' + id, { method: 'DELETE' });
    if (window._editandoId === id) window._editandoId = null;
    carregarPublicos();
  } catch (e) { alert('Erro: ' + e.message); }
}
async function salvarPublico() {
  const nome = document.getElementById('f-nome').value.trim();
  if (!nome) { alert('Dê um nome ao público'); return; }
  const body = JSON.stringify({ nome, regra: coletarRegra() });
  try {
    if (window._editandoId) await api('/api/publicos/' + window._editandoId, { method: 'PUT', body });
    else { const r = await api('/api/publicos', { method: 'POST', body }); window._editandoId = r.id; }
    carregarPublicos();
    alert('Público salvo');
  } catch (e) { alert('Erro: ' + e.message); }
}

// ---- Exportar CSV ----
async function exportarCsv() {
  try {
    const resp = await fetch('/api/publicos/exportar', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
      body: JSON.stringify({ regra: coletarRegra() }),
    });
    if (!resp.ok) { alert('Falha ao exportar'); return; }
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'publico.csv'; a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { alert('Erro: ' + e.message); }
}

// ---- Disparar ----
async function abrirDisparoModal() {
  try {
    const tpls = await api('/api/templates');
    const aprov = (tpls || []).filter(t => t.status === 'aprovado');
    document.getElementById('d-template').innerHTML = aprov.map(t => `<option value="${_esc(t.nome)}">${_esc(t.nome)}</option>`).join('');
    const cfg = await api('/api/config/wa');
    const ids = (cfg.sendable && cfg.sendable.length) ? cfg.sendable : Object.keys(cfg.numbers || {});
    const selN = document.getElementById('d-numero');
    selN.innerHTML = ids.map(id => `<option value="${id}">${_esc((cfg.numbers && cfg.numbers[id]) || id)}</option>`).join('');
    if (cfg.defaultPhoneId && ids.includes(cfg.defaultPhoneId)) selN.value = cfg.defaultPhoneId;
    document.getElementById('disparo-modal').style.display = 'flex';
  } catch (e) { alert('Erro: ' + e.message); }
}
async function confirmarDisparo() {
  const body = JSON.stringify({
    regra: coletarRegra(),
    nome_campanha: document.getElementById('d-nome-camp').value.trim(),
    template_nome: document.getElementById('d-template').value,
    wa_number_id: document.getElementById('d-numero').value,
  });
  try {
    const r = await api('/api/publicos/disparar', { method: 'POST', body });
    alert('Disparo iniciado para ' + r.total + ' contatos. Acompanhe na aba Disparos.');
    document.getElementById('disparo-modal').style.display = 'none';
  } catch (e) { alert('Erro: ' + e.message); }
}

// ---- Wiring ----
document.addEventListener('input', e => { if (e.target.closest('#construtor')) agendarPreview(); });
document.addEventListener('change', e => { if (e.target.closest('#construtor')) agendarPreview(); });
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-salvar').onclick = salvarPublico;
  document.getElementById('btn-exportar').onclick = exportarCsv;
  document.getElementById('btn-disparar').onclick = abrirDisparoModal;
  carregarPublicos();
  atualizarPreview();
});
