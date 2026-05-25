import { get } from './api.js';
import { showToast, formatDate } from './ui.js';

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function defaultDesde() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return isoDate(d);
}

function defaultAte() {
  return isoDate(new Date());
}

function renderTabela(rows) {
  if (!rows || rows.length === 0) {
    return `<div style="padding:32px;text-align:center;font-size:13px;color:var(--muted)">Nenhum dado para o período.</div>`;
  }

  const cols = [
    { key: 'dentista_nome', label: 'Dentista' },
    { key: 'total_consultas', label: 'Total' },
    { key: 'nota_media', label: 'Nota Média' },
    { key: 'consultas_com_lead', label: 'Com Lead' },
    { key: 'fechadas', label: 'Fechadas' },
    { key: 'taxa_fechamento', label: 'Taxa' },
    { key: 'custo_total_usd', label: 'Custo USD' },
  ];

  const thead = `<tr>${cols.map(c =>
    `<th style="padding:10px 14px;text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);border-bottom:1px solid var(--border);font-weight:600">${c.label}</th>`
  ).join('')}</tr>`;

  const tbody = rows.map(row => {
    const nota = row.nota_media;
    const notaCor = nota == null ? 'var(--muted)' : nota >= 7 ? 'var(--green)' : nota >= 5 ? 'var(--yellow)' : 'var(--red)';
    const taxa = row.taxa_fechamento;
    return `<tr>
      <td style="padding:10px 14px;font-size:13px;font-weight:600;border-bottom:1px solid var(--border)">${escHtml(row.dentista_nome ?? '—')}</td>
      <td style="padding:10px 14px;font-size:13px;font-family:'DM Mono',monospace;border-bottom:1px solid var(--border)">${row.total_consultas ?? 0}</td>
      <td style="padding:10px 14px;font-size:13px;font-family:'DM Mono',monospace;color:${notaCor};font-weight:700;border-bottom:1px solid var(--border)">${nota != null ? Number(nota).toFixed(1) : '—'}</td>
      <td style="padding:10px 14px;font-size:13px;font-family:'DM Mono',monospace;border-bottom:1px solid var(--border)">${row.consultas_com_lead ?? 0}</td>
      <td style="padding:10px 14px;font-size:13px;font-family:'DM Mono',monospace;border-bottom:1px solid var(--border)">${row.fechadas ?? 0}</td>
      <td style="padding:10px 14px;font-size:13px;font-family:'DM Mono',monospace;border-bottom:1px solid var(--border)">${taxa != null ? taxa + '%' : '—'}</td>
      <td style="padding:10px 14px;font-size:13px;font-family:'DM Mono',monospace;color:var(--muted);border-bottom:1px solid var(--border)">$${row.custo_total_usd != null ? Number(row.custo_total_usd).toFixed(4) : '0.0000'}</td>
    </tr>`;
  }).join('');

  return `
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead>${thead}</thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
}

async function load() {
  const desde = document.getElementById('dash-desde')?.value || defaultDesde();
  const ate = document.getElementById('dash-ate')?.value || defaultAte();

  const loadBtn = document.getElementById('dash-load-btn');
  if (loadBtn) loadBtn.disabled = true;

  const tableZone = document.getElementById('dash-table-zone');
  if (tableZone) tableZone.innerHTML = `<div style="padding:24px;text-align:center;font-size:13px;color:var(--muted)">Carregando...</div>`;

  const badge = document.getElementById('dash-regenerando');
  if (badge) badge.style.display = 'none';

  try {
    const data = await get(`/avaliacoes/dashboard?desde=${encodeURIComponent(desde)}&ate=${encodeURIComponent(ate)}`);

    if (data.regenerando === true && badge) {
      badge.style.display = 'inline-flex';
    }

    if (tableZone) tableZone.innerHTML = renderTabela(data.data ?? []);
  } catch (e) {
    showToast('Erro ao carregar dashboard: ' + e.message, 'error');
    if (tableZone) tableZone.innerHTML = `<div style="padding:24px;text-align:center;font-size:13px;color:var(--red)">Erro ao carregar. Tente novamente.</div>`;
  } finally {
    if (loadBtn) loadBtn.disabled = false;
  }
}

function renderRoot() {
  const root = document.getElementById('dashboard-root');
  if (!root) return;

  root.innerHTML = `
    <div style="margin-bottom:18px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <div>
        <label style="font-size:11.5px;color:var(--muted);display:block;margin-bottom:4px">De</label>
        <input
          type="date"
          id="dash-desde"
          value="${defaultDesde()}"
          style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text);font-size:13px;font-family:inherit"
          aria-label="Data de início do período"
        >
      </div>
      <div>
        <label style="font-size:11.5px;color:var(--muted);display:block;margin-bottom:4px">Até</label>
        <input
          type="date"
          id="dash-ate"
          value="${defaultAte()}"
          style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text);font-size:13px;font-family:inherit"
          aria-label="Data de fim do período"
        >
      </div>
      <div style="align-self:flex-end">
        <button
          id="dash-load-btn"
          onclick="window._dashLoad()"
          style="padding:9px 20px;border-radius:8px;background:var(--accent);color:white;border:none;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit"
          aria-label="Filtrar dashboard pelo período"
        >Filtrar</button>
      </div>
      <span
        id="dash-regenerando"
        style="display:none;align-items:center;gap:6px;font-size:12px;color:var(--yellow);background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);padding:5px 12px;border-radius:20px"
        role="status"
        aria-live="polite"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
        Atualizando insights...
      </span>
    </div>

    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden">
      <div id="dash-table-zone"></div>
    </div>`;

  window._dashLoad = load;
}

export async function init() {
  renderRoot();
  await load();
}
