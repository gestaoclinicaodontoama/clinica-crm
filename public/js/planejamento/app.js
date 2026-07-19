// /js/planejamento/app.js — fila + tela do plano. Requisito de UX (spec): caso típico < 2 min.
(() => {
  const tokenKey = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
  const token = tokenKey ? JSON.parse(localStorage.getItem(tokenKey))?.access_token : null;
  if (!token) { location.href = '/'; return; }
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(path, opts = {}, tent = 0) {
    const r = await fetch(path, { headers: H, ...opts });
    if (r.status >= 500 && tent < 2) { await new Promise(s => setTimeout(s, tent ? 3000 : 1500)); return api(path, opts, tent + 1); }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return r.json();
  }
  const $ = s => document.querySelector(s);
  const fmtBRL = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const seloPgto = t => {
    if (!t) return '';
    const m = { particular: ['Particular','sel-part'], convenio: ['Convênio','sel-conv'], misto: ['Misto','sel-mist'] };
    const [label, cls] = m[t] || [t, 'sel-part'];
    return `<span class="selo ${cls}">${esc(label)}</span>`;
  };
  let abaAtual = 'planejar', config = { prazo_escalonamento_dias: 7 };

  async function carregarFila() {
    $('#fila').innerHTML = '<div class="vazio">Carregando...</div>';
    try {
      const { planos, config: cfg } = await api(`/api/planejamento/fila?aba=${abaAtual}`);
      config = cfg || config;
      const hoje = Date.now();
      $('#fila').innerHTML = planos.length ? `<table><thead><tr>
        <th>Paciente</th><th>Valor</th><th>Entrada</th><th>Aguardando há</th><th></th></tr></thead><tbody>` +
        planos.map(p => {
          const dias = Math.floor((hoje - new Date(p.criado_em).getTime()) / 864e5);
          const atrasado = dias > config.prazo_escalonamento_dias;
          return `<tr class="${atrasado ? 'atrasado' : ''}">
            <td>${esc(p.paciente_nome) || '—'} ${seloPgto(p.tipo_pagamento)}${p.possivel_duplicata ? `<span class="badge badge-amarelo" title="possível duplicata (renegociação?)">⚠ suspeita</span>` : ''}
                ${p.trava_resync ? `<span class="badge badge-vermelho" title="${esc(p.trava_resync)}">🔒 travado</span>` : ''}</td>
            <td>${fmtBRL(p.valor)}</td><td>${fmtBRL(p.entrada)}</td>
            <td>${dias}d ${atrasado ? '🔔' : ''}</td>
            <td><button data-abrir="${esc(p.id)}">Abrir</button>
                ${abaAtual === 'suspeitas' ? `<button data-veredito-ok="${esc(p.id)}">Não é duplicata</button><button data-veredito-dup="${esc(p.id)}">É duplicata</button>` : ''}</td></tr>`;
        }).join('') + '</tbody></table>' : '<p class="vazio">Fila vazia 🎉</p>';
    } catch (e) {
      $('#fila').innerHTML = `<p class="vazio">Erro: ${esc(e.message)}</p>`;
    }
  }

  // Editor extraído p/ /js/planejamento/editor.js (reusado por /trilhas/ — ver house rules da Task F).
  function abrirPlano(id) {
    return window.PlanejamentoEditor.abrir(id, { api, onSaved: carregarFila });
  }

  document.querySelector('.abas').onclick = ev => {
    const b = ev.target.closest('[data-aba]'); if (!b) return;
    document.querySelectorAll('.abas button').forEach(x => x.classList.remove('ativa'));
    b.classList.add('ativa'); abaAtual = b.dataset.aba; carregarFila();
  };
  $('#fila').onclick = async ev => {
    const abrir = ev.target.closest('[data-abrir]'); if (abrir) return abrirPlano(abrir.dataset.abrir);
    const ok = ev.target.closest('[data-veredito-ok]');
    const dup = ev.target.closest('[data-veredito-dup]');
    try {
      if (ok) { await api(`/api/planejamento/plano/${ok.dataset.vereditoOk}/veredito`, { method: 'POST', body: JSON.stringify({ veredito: 'ok' }) }); carregarFila(); }
      if (dup && confirm('Marcar como DUPLICATA cancela este plano e o registro na Sucesso. Confirmar?')) {
        await api(`/api/planejamento/plano/${dup.dataset.vereditoDup}/veredito`, { method: 'POST', body: JSON.stringify({ veredito: 'duplicata' }) }); carregarFila();
      }
    } catch (e) { alert(e.message); }
  };
  carregarFila();
})();
