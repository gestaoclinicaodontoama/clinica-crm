// public/js/social-media/app.js — calendário de postagem (Fase 1)
(() => {
  const $ = (s) => document.querySelector(s);
  const DIA = 864e5;
  let posts = [], config = { exigir_aprovacao: true, perfis: {} }, minhasRoles = [];
  let segunda = inicioSemana(new Date());
  let editando = null; // post em edição no modal (null = novo)

  function inicioSemana(d) {
    const x = new Date(d); x.setHours(0, 0, 0, 0);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // segunda
    return x;
  }
  const fmtDia = (d) => d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
  const fmtHora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const isGestor = () => minhasRoles.includes('admin') || minhasRoles.includes('gestor');
  const REDES = ['instagram', 'facebook', 'shorts', 'tiktok', 'kwai', 'gmn'];
  const REDE_LBL = { instagram: 'IG', facebook: 'FB', shorts: 'Shorts', tiktok: 'TikTok', kwai: 'Kwai', gmn: 'GMN' };

  async function carregar() {
    const desde = segunda.toISOString();
    const ate = new Date(+segunda + 7 * DIA).toISOString();
    const [cfg, ps, sug, eu] = await Promise.all([
      smApi('/api/social-media/config'),
      smApi(`/api/social-media/posts?desde=${encodeURIComponent(desde)}&ate=${encodeURIComponent(ate)}`),
      smApi('/api/social-media/sugestoes'),
      smApi('/api/me').catch(() => null), // se /api/me não existir, roles ficam vazias (botões de gestor somem)
    ]);
    config = cfg || config;
    posts = (ps && ps.posts) || [];
    minhasRoles = (eu && eu.profile && eu.profile.roles) || (eu && eu.roles) || [];
    renderSemana(); renderSugestoes((sug && sug.sugestoes) || []);
  }

  function renderSemana() {
    $('#lbl-semana').textContent =
      `${segunda.toLocaleDateString('pt-BR')} – ${new Date(+segunda + 6 * DIA).toLocaleDateString('pt-BR')}`;
    const grade = $('#grade'); grade.innerHTML = '';
    let total = 0;
    for (let i = 0; i < 7; i++) {
      const d0 = new Date(+segunda + i * DIA), d1 = new Date(+d0 + DIA);
      const doDia = posts.filter(p => { const t = new Date(p.data_hora); return t >= d0 && t < d1; });
      total += doDia.length;
      const col = document.createElement('div'); col.className = 'dia';
      col.innerHTML = `<h4>${fmtDia(d0)}</h4>`;
      for (const p of doDia) {
        const c = document.createElement('div'); c.className = 'card';
        c.innerHTML = `
          <span class="pill perfil-${esc(p.perfil)}">${p.perfil === 'ama' ? 'AMA' : 'Dr. Marcos'}</span>
          <span class="pill p-${esc(p.status)}">${esc(p.status.replace('_', ' '))}</span>
          <div class="t">${esc(p.titulo)}</div>
          <div class="h">${fmtHora(p.data_hora)} · ${esc(p.formato)}</div>
          <div class="redes">${REDES.map(r => {
            const on = p.redes && p.redes[r] === 'publicado';
            return `<span class="rede ${on ? 'on' : ''}" data-post="${p.id}" data-rede="${r}">${on ? '✓ ' : ''}${REDE_LBL[r]}</span>`;
          }).join('')}</div>`;
        c.addEventListener('click', (ev) => {
          const rd = ev.target.closest('.rede');
          if (rd) { ev.stopPropagation(); return toggleRede(p, rd.dataset.rede); }
          abrirModal(p);
        });
        col.appendChild(c);
      }
      grade.appendChild(col);
    }
    $('#vazio').style.display = total ? 'none' : 'block';
  }

  function renderSugestoes(sugestoes) {
    const box = $('#sugestoes'); box.innerHTML = '';
    for (const s of sugestoes) {
      const p = posts.find(x => x.id === s.post_id);
      const div = document.createElement('div'); div.className = 'sug';
      div.innerHTML = `🔗 <b>${esc(p ? p.titulo : 'post #' + s.post_id)}</b> parece ser
        <a href="${esc(safeUrl(s.permalink))}" target="_blank" rel="noopener">este post do IG</a>
        (Δ ${s.delta_horas}h) — “${esc(s.caption || '')}”
        <button class="btn-primary" data-post="${esc(s.post_id)}" data-media="${esc(s.media_id)}">Vincular</button>`;
      div.querySelector('button').addEventListener('click', async (ev) => {
        await smApi(`/api/social-media/posts/${ev.target.dataset.post}/vincular`, { method: 'PUT', body: { media_id: ev.target.dataset.media } });
        carregar();
      });
      box.appendChild(div);
    }
  }

  async function toggleRede(p, rede) {
    const redes = { ...(p.redes || {}) };
    redes[rede] = redes[rede] === 'publicado' ? null : 'publicado';
    await smApi(`/api/social-media/posts/${p.id}`, { method: 'PUT', body: { redes } });
    carregar();
  }

  function abrirModal(p) {
    editando = p || null;
    $('#mp-titulo').textContent = p ? `Editar: ${p.titulo}` : 'Novo post';
    $('#f-data').value = p ? localInput(p.data_hora) : localInput(new Date(+segunda + 9 * 3600e3).toISOString());
    $('#f-perfil').value = p ? p.perfil : 'ama';
    $('#f-titulo').value = p ? p.titulo : '';
    $('#f-formato').value = p ? p.formato : 'reel';
    $('#f-tema').value = p ? (p.tema || '') : '';
    $('#f-drive').value = p ? p.link_drive : '';
    $('#f-legenda').value = p ? p.legenda : '';
    $('#f-hashtags').value = p ? p.hashtags : '';
    $('#f-obs').value = p ? p.observacoes : '';
    $('#mp-status').innerHTML = p ? `Status: <span class="pill p-${esc(p.status)}">${esc(p.status.replace('_', ' '))}</span>` : '';
    montarAcoes(p);
    $('#modal-post-bg').style.display = 'flex';
  }
  const fecharModal = () => { $('#modal-post-bg').style.display = 'none'; };

  function montarAcoes(p) {
    const box = $('#mp-acoes'); box.innerHTML = '';
    const bt = (label, cls, fn) => { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.addEventListener('click', fn); box.appendChild(b); };
    bt('💾 Salvar', 'btn-primary', salvar);
    if (p) {
      bt('📋 Copiar legenda+hashtags', '', () => {
        navigator.clipboard.writeText(`${$('#f-legenda').value}\n\n${$('#f-hashtags').value}`.trim());
      });
      const st = p.status, aprovDireto = !config.exigir_aprovacao || isGestor();
      if (st === 'rascunho' && config.exigir_aprovacao && !isGestor()) bt('📤 Enviar p/ aprovação', '', () => mudarStatus(p, 'aguardando_aprovacao'));
      if (st === 'rascunho' && aprovDireto) bt('✅ Aprovar', '', () => mudarStatus(p, 'aprovado'));
      if (st === 'aguardando_aprovacao' && isGestor()) { bt('✅ Aprovar', '', () => mudarStatus(p, 'aprovado')); bt('↩️ Devolver', '', () => mudarStatus(p, 'rascunho')); }
      if (st === 'aprovado') bt('🚀 Marcar publicado', '', () => mudarStatus(p, 'publicado'));
      if (st !== 'publicado' && st !== 'cancelado') bt('🗑 Cancelar post', '', () => mudarStatus(p, 'cancelado'));
      if (st === 'cancelado') bt('♻️ Reativar', '', () => mudarStatus(p, 'rascunho'));
    }
    bt('Fechar', 'btn-ghost', fecharModal);
  }

  async function salvar() {
    const body = {
      data_hora: new Date($('#f-data').value).toISOString(),
      perfil: $('#f-perfil').value, titulo: $('#f-titulo').value.trim(),
      formato: $('#f-formato').value, tema: $('#f-tema').value || null, link_drive: $('#f-drive').value.trim(),
      legenda: $('#f-legenda').value, hashtags: $('#f-hashtags').value, observacoes: $('#f-obs').value,
    };
    if (!body.titulo) return alert('Título é obrigatório');
    if (editando) await smApi(`/api/social-media/posts/${editando.id}`, { method: 'PUT', body });
    else await smApi('/api/social-media/posts', { method: 'POST', body });
    fecharModal(); carregar();
  }
  async function mudarStatus(p, status) {
    const r = await smApi(`/api/social-media/posts/${p.id}`, { method: 'PUT', body: { status } }).catch(e => ({ error: String(e) }));
    if (r && r.error) alert(r.error);
    fecharModal(); carregar();
  }

  function localInput(iso) {
    const d = new Date(iso);
    return new Date(+d - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  }
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u)) ? u : '#';

  // Config modal
  $('#bt-cfg').addEventListener('click', async () => {
    $('#cfg-aprovacao').checked = !!config.exigir_aprovacao;
    $('#cfg-perfis').innerHTML = Object.entries(config.perfis || {}).map(([k, p]) =>
      `<div>• <b>${esc(p.nome || k)}</b> — IG ${p.ig_id ? 'conectado ✅' : '<span style="color:var(--yellow)">não vinculado (vincular no Business Suite)</span>'}</div>`).join('');
    $('#modal-cfg-bg').style.display = 'flex';
  });
  $('#cfg-salvar').addEventListener('click', async () => {
    await smApi('/api/social-media/config', { method: 'PUT', body: { exigir_aprovacao: $('#cfg-aprovacao').checked } });
    $('#modal-cfg-bg').style.display = 'none'; carregar();
  });
  $('#cfg-fechar').addEventListener('click', () => { $('#modal-cfg-bg').style.display = 'none'; });

  // Toolbar
  $('#bt-novo').addEventListener('click', () => abrirModal(null));
  $('#bt-prev').addEventListener('click', () => { segunda = new Date(+segunda - 7 * DIA); carregar(); });
  $('#bt-prox').addEventListener('click', () => { segunda = new Date(+segunda + 7 * DIA); carregar(); });
  $('#bt-hoje').addEventListener('click', () => { segunda = inicioSemana(new Date()); carregar(); });
  $('#bt-sync').addEventListener('click', async () => {
    const b = $('#bt-sync'); b.disabled = true; b.textContent = '⏳ Atualizando...';
    try { await smApi('/api/social-media/sync', { method: 'POST', body: {} }); } catch (e) { alert('Sync: ' + e); }
    b.disabled = false; b.textContent = '🔄 Atualizar dados'; carregar();
  });
  document.querySelectorAll('.modal-bg').forEach(m => m.addEventListener('click', (e) => { if (e.target === m) m.style.display = 'none'; }));

  // ======== Aba Desempenho (Fase 2) ========
  const FORMATO_LBL = { VIDEO: 'Reels/vídeos', IMAGE: 'Imagens', CAROUSEL_ALBUM: 'Carrosséis' };
  const COLS = [
    ['data', 'Data'], ['legenda', 'Post'], ['formato', 'Formato'], ['tema', 'Tema'],
    ['reach', 'Alcance'], ['total_interactions', 'Interações'], ['likes', 'Curtidas'],
    ['comments', 'Coment.'], ['shares', 'Compart.'], ['saved', 'Salvos'],
  ];
  let dspDados = null, dspOrdem = { col: 'ig_timestamp', desc: true };
  const fmtNum = (n) => n == null ? '—' : Number(n).toLocaleString('pt-BR');
  const fmtX = (n) => String(n).replace('.', ',') + '×';

  document.querySelectorAll('.tabs .tab[data-tab]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs .tab[data-tab]').forEach(x => x.classList.toggle('on', x === b));
    $('#tab-calendario').style.display = b.dataset.tab === 'calendario' ? '' : 'none';
    $('#tab-desempenho').style.display = b.dataset.tab === 'desempenho' ? '' : 'none';
    if (b.dataset.tab === 'desempenho') carregarTatico();
  }));
  $('#dsp-perfil').addEventListener('change', () => { $('#dsp-mensal').style.display = 'none'; $('#dsp-tatico').style.display = ''; carregarTatico(); });

  async function carregarTatico() {
    $('#dsp-modo-mensal').style.display = isGestor() ? '' : 'none';
    const r = await smApi(`/api/social-media/desempenho/tatico?perfil=${$('#dsp-perfil').value}`).catch(() => null);
    dspDados = r;
    if (!r || r.sem_dados) {
      $('#dsp-destaques').innerHTML = '';
      $('#dsp-tabela').innerHTML = '<div class="msg">Sem dados ainda para este perfil.</div>';
      $('#dsp-agregados').innerHTML = '';
      return;
    }
    $('#dsp-destaques').innerHTML = (r.destaques || []).map(d => `<div>${esc(d)}</div>`).join('');
    renderTabelaTatica();
    renderAgregados(r);
  }

  function renderTabelaTatica() {
    const r = dspDados; if (!r) return;
    const posts = [...r.posts].sort((a, b) => {
      const k = dspOrdem.col === 'data' ? 'ig_timestamp' : dspOrdem.col;
      const va = a[k], vb = b[k];
      const cmp = (typeof va === 'string' || typeof vb === 'string')
        ? String(va || '').localeCompare(String(vb || ''))
        : (va || 0) - (vb || 0);
      return dspOrdem.desc ? -cmp : cmp;
    });
    const th = COLS.map(([k, lbl]) => `<th data-col="${k === 'legenda' ? 'caption' : k === 'data' ? 'ig_timestamp' : k}">${lbl}${(dspOrdem.col === k || (k === 'data' && dspOrdem.col === 'ig_timestamp')) ? (dspOrdem.desc ? ' ▼' : ' ▲') : ''}</th>`).join('');
    const tr = posts.map(p => `<tr>
      <td>${p.ig_timestamp ? new Date(p.ig_timestamp).toLocaleDateString('pt-BR') : '—'}</td>
      <td>${esc((p.caption || '(sem legenda)').slice(0, 60))} <a href="${esc(safeUrl(p.permalink))}" target="_blank" rel="noopener">↗</a></td>
      <td>${esc(FORMATO_LBL[p.media_type] || p.media_type || '—')}</td>
      <td>${esc(p.tema || '—')}</td>
      ${['reach', 'total_interactions', 'likes', 'comments', 'shares', 'saved'].map(k =>
        `<td>${fmtNum(p[k])}${p.selos && p.selos[k] ? `<span class="selo">${fmtX(p.selos[k])}</span>` : ''}</td>`).join('')}
    </tr>`).join('');
    $('#dsp-tabela').innerHTML = `<table class="dsp"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
    document.querySelectorAll('#dsp-tabela th').forEach(el => el.addEventListener('click', () => {
      const col = el.dataset.col;
      dspOrdem = { col, desc: dspOrdem.col === col ? !dspOrdem.desc : true };
      renderTabelaTatica();
    }));
  }

  function renderAgregados(r) {
    const bloco = (titulo, itens, rotulo) => `<div class="dsp-card"><h5>${titulo}</h5>` +
      (itens.length ? itens.map(a => `<div>${esc(rotulo(a.chave))} — ${a.qtd} posts · alcance med. ${fmtNum(a.reach_mediano)}${a.poucos_dados ? ' <span class="dsp-muted">(poucos dados)</span>' : ''}</div>`).join('')
        : '<div class="dsp-muted">dados insuficientes</div>') + '</div>';
    $('#dsp-agregados').innerHTML =
      bloco('Por formato', r.formatos || [], c => FORMATO_LBL[c] || c) +
      bloco('Por tema' + (r.sem_tema ? ` <span class="dsp-muted">(${r.sem_tema} sem tema)</span>` : ''), r.temas || [], c => c) +
      bloco('Dia · horário (BRT)', (r.horarios || []).slice(0, 6), c => c);
  }

  carregar();
})();
