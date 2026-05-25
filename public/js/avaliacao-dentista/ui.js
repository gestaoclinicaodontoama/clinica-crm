let _modalAccept = null;
let _modalDecline = null;

export function showToast(message, type = 'info') {
  const container = document.getElementById('avaliacao-toast');
  if (!container) return;

  const item = document.createElement('div');
  item.className = `toast-item ${type}`;
  item.textContent = message;

  container.appendChild(item);
  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transition = 'opacity .3s';
    setTimeout(() => item.remove(), 300);
  }, 4000);
}

export function showModal(htmlContent, onBackdropDismiss) {
  const bg = document.getElementById('avaliacao-modal-bg');
  const box = document.getElementById('avaliacao-modal');
  if (!bg || !box) return;

  box.innerHTML = htmlContent;
  bg.classList.add('open');

  bg.addEventListener('click', (e) => {
    if (e.target === bg) {
      closeModal();
      if (onBackdropDismiss) onBackdropDismiss();
    }
  }, { once: true });
}

export function closeModal() {
  const bg = document.getElementById('avaliacao-modal-bg');
  if (bg) bg.classList.remove('open');
  _modalAccept = null;
  _modalDecline = null;
}

export async function showConsentModal(onAccept, onDecline) {
  let html;
  try {
    const res = await fetch('/avaliacao-dentista/consentimento-lgpd.html');
    html = await res.text();
  } catch (_) {
    showToast('Erro ao carregar termo de consentimento.', 'error');
    if (onDecline) onDecline();
    return;
  }

  showModal(html, onDecline);

  _modalAccept = onAccept;
  _modalDecline = onDecline;

  const box = document.getElementById('avaliacao-modal');
  box.querySelector('#lgpd-btn-aceitar')?.addEventListener('click', () => {
    const cb = _modalAccept;
    closeModal();
    if (cb) cb();
  });
  box.querySelector('#lgpd-btn-recusar')?.addEventListener('click', () => {
    const cb = _modalDecline;
    closeModal();
    if (cb) cb();
  });
}

export function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
