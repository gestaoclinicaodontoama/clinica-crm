import { get, put, del } from './api.js';
import { showToast } from './ui.js';

/** Escape HTML special chars to prevent XSS from server-returned strings. */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function initDentistaMap() {
  const section = document.getElementById('avd-map-section');
  if (!section) return;
  section.hidden = false;
  await render();
}

async function render() {
  const list = document.getElementById('avd-map-list');
  list.innerHTML = 'Carregando...';
  let payload;
  try { payload = await get('/api/avaliacoes/dentista-map'); }
  catch (e) { list.innerHTML = `<span style="color:var(--red)">Erro: ${esc(e.message)}</span>`; return; }

  const mapBy = Object.fromEntries((payload.maps || []).map(m => [m.dentista_id, m]));
  const conhecidos = payload.avaliadores_conhecidos || [];

  list.innerHTML = (payload.dentistas || []).map(d => {
    const atual = mapBy[d.id];
    const opts = conhecidos.map(c =>
      `<option value="${esc(c.id)}" ${atual && String(atual.clinicorp_person_id) === String(c.id) ? 'selected' : ''}>${esc(c.nome)} (${esc(c.id)})</option>`
    ).join('');
    return `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <span style="min-width:180px;font-size:13px">${esc(d.nome || d.id)}</span>
        <select data-dentista="${esc(d.id)}" style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text);font-size:13px">
          <option value="">— não vinculado —</option>
          ${opts}
        </select>
        <button data-save="${esc(d.id)}" style="padding:6px 14px;border-radius:8px;background:var(--accent);color:#fff;border:none;font-size:12px;cursor:pointer">Salvar</button>
      </div>`;
  }).join('') || '<span style="color:var(--muted)">Nenhum dentista cadastrado.</span>';

  list.querySelectorAll('[data-save]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.save;
      const sel = list.querySelector(`select[data-dentista="${id}"]`);
      const personId = sel.value;
      try {
        if (!personId) { await del(`/api/avaliacoes/dentista-map/${id}`); showToast('Vínculo removido.', 'info'); }
        else {
          const nome = sel.options[sel.selectedIndex].text;
          await put(`/api/avaliacoes/dentista-map/${id}`, { clinicorp_person_id: personId, nome });
          showToast('Vínculo salvo.', 'success');
        }
      } catch (e) { showToast('Erro: ' + e.message, 'error'); }
    });
  });
}
