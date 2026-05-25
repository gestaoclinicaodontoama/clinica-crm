import { AvaliacaoApp } from './state.js';
import { get } from './api.js';
import { showToast } from './ui.js';

const TAB_ROLES = {
  copiloto:  ['dentista', 'admin'],
  historico: ['dentista', 'admin'],
  dashboard: ['gestor',   'admin'],
};

function hasRole(roles, allowed) {
  return allowed.some(r => roles.includes(r));
}

function applyTheme() {
  const saved = localStorage.getItem('crm-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
}

function setupTabs() {
  const roles = AvaliacaoApp.user?.roles ?? [];

  document.querySelectorAll('.mod-tab').forEach(btn => {
    const tab = btn.dataset.tab;
    const allowed = TAB_ROLES[tab] ?? [];
    if (!hasRole(roles, allowed)) {
      btn.hidden = true;
    }
    btn.addEventListener('click', () => navigateTo(tab));
  });
}

function navigateTo(tab) {
  const roles = AvaliacaoApp.user?.roles ?? [];
  const allowed = TAB_ROLES[tab] ?? [];

  if (!hasRole(roles, allowed)) {
    showToast('Sem permissão para acessar esta tela.', 'error');
    return;
  }

  if (tab === 'copiloto') {
    const config = AvaliacaoApp.config;
    if (config && config.modulo_ativo !== 'true') {
      const banner = document.getElementById('banner-modulo-inativo');
      if (banner) banner.classList.add('visible');
      showToast('O módulo está desativado pela gestão.', 'warning');
      return;
    }
  }

  document.querySelectorAll('.mod-tab').forEach(b => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  document.querySelectorAll('.mod-pane').forEach(p => {
    p.classList.toggle('active', p.id === `tab-${tab}`);
  });

  window.location.hash = `tab=${tab}`;
  AvaliacaoApp.currentTab = tab;
  AvaliacaoApp.emit('tab:change', { tab });

  loadTabModule(tab);
}

const _loaded = new Set();

async function loadTabModule(tab) {
  if (_loaded.has(tab)) return;
  _loaded.add(tab);

  try {
    if (tab === 'copiloto') {
      const { init } = await import('./copiloto.js');
      await init();
    } else if (tab === 'historico') {
      const { init } = await import('./historico.js');
      await init();
    } else if (tab === 'dashboard') {
      const { init } = await import('./dashboard.js');
      await init();
    }
  } catch (e) {
    console.error(`Erro ao carregar módulo ${tab}:`, e);
    showToast(`Erro ao carregar a aba "${tab}".`, 'error');
    _loaded.delete(tab);
  }
}

function resolveInitialTab(roles) {
  const hash = window.location.hash.replace('#', '');
  const params = new URLSearchParams(hash);
  const requested = params.get('tab');

  if (requested && TAB_ROLES[requested] && hasRole(roles, TAB_ROLES[requested])) {
    return requested;
  }

  if (hasRole(roles, ['dentista', 'admin'])) return 'copiloto';
  if (hasRole(roles, ['gestor'])) return 'dashboard';
  return null;
}

async function boot() {
  applyTheme();

  try {
    AvaliacaoApp.user = await get('/me');
  } catch (e) {
    if (e.status === 401) {
      window.location.href = '/';
      return;
    }
    showToast('Erro ao carregar usuário.', 'error');
    return;
  }

  try {
    AvaliacaoApp.config = await get('/avaliacoes/config');
  } catch (e) {
    if (e.status !== 503) {
      showToast('Aviso: configuração do módulo indisponível.', 'warning');
    }
  }

  const roles = AvaliacaoApp.user?.roles ?? [];

  if (AvaliacaoApp.config && AvaliacaoApp.config.modulo_ativo !== 'true') {
    const banner = document.getElementById('banner-modulo-inativo');
    if (banner) banner.classList.add('visible');
  }

  setupTabs();

  const initialTab = resolveInitialTab(roles);
  if (initialTab) {
    navigateTo(initialTab);
  } else {
    const firstVisible = document.querySelector('.mod-tab:not([hidden])');
    if (firstVisible) navigateTo(firstVisible.dataset.tab);
  }
}

boot();
