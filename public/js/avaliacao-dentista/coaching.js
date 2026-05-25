import { post, get } from './api.js';
import { showToast, showModal } from './ui.js';

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function detalharEtapa(consultaId, etapaIdx, etapaNome) {
  const loadingHtml = `
    <div style="padding:20px;text-align:center">
      <div style="width:24px;height:24px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:avd-spin .8s linear infinite;margin:0 auto 14px"></div>
      <style>@keyframes avd-spin{to{transform:rotate(360deg)}}</style>
      <div style="font-size:13px;color:var(--muted)">Gerando coaching detalhado...</div>
    </div>`;
  showModal(loadingHtml);

  try {
    const result = await post(`/avaliacoes/${consultaId}/detalhar/${etapaIdx}`);
    const momentos = result?.detalhe?.momentos ?? result?.momentos ?? [];
    const nome = etapaNome ?? `Etapa ${etapaIdx + 1}`;

    const html = `
      <div>
        <h2 id="avaliacao-modal-title" style="font-size:16px;font-weight:700;margin-bottom:18px">
          Coaching: ${escHtml(nome)}
        </h2>
        ${momentos.length === 0
          ? `<p style="font-size:13px;color:var(--muted)">Nenhum momento crítico identificado nesta etapa.</p>`
          : momentos.map((m, i) => `
            <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:12px">
              <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Momento ${i + 1}</div>
              <blockquote style="font-size:12.5px;font-family:'DM Mono',monospace;color:var(--text);background:var(--bg2);border-left:3px solid var(--accent);padding:8px 12px;border-radius:4px;margin:0 0 10px">${escHtml(m.trecho ?? '')}</blockquote>
              <div style="font-size:13px;margin-bottom:6px"><strong>Problema:</strong> ${escHtml(m.problema ?? '')}</div>
              <div style="font-size:13px;color:var(--green)"><strong>Alternativa:</strong> ${escHtml(m.alternativa ?? '')}</div>
            </div>`).join('')}
        <button
          onclick="document.getElementById('avaliacao-modal-bg').classList.remove('open')"
          style="margin-top:6px;padding:9px 22px;border-radius:8px;background:var(--bg3);color:var(--text);border:1px solid var(--border);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit"
          aria-label="Fechar coaching"
        >Fechar</button>
      </div>`;

    showModal(html);
  } catch (e) {
    const msg = e.status === 429
      ? 'Limite de detalhamentos diários atingido.'
      : `Erro ao gerar coaching: ${e.message}`;
    showModal(`
      <div>
        <h2 id="avaliacao-modal-title" style="font-size:16px;font-weight:700;margin-bottom:14px">Erro</h2>
        <p style="font-size:13px;color:var(--red);margin-bottom:16px">${escHtml(msg)}</p>
        <button
          onclick="document.getElementById('avaliacao-modal-bg').classList.remove('open')"
          style="padding:9px 22px;border-radius:8px;background:var(--bg3);color:var(--text);border:1px solid var(--border);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit"
        >Fechar</button>
      </div>`);
    showToast(msg, 'error');
  }
}

export async function carregarMeuPlano() {
  return get('/avaliacoes/benchmark/meu-plano');
}
