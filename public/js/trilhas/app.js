// /js/trilhas/app.js — página da Sucesso do Cliente: lista de pacientes vendidos (Trilha de
// Tratamento), drawer com a trilha (itens→etapas), reusa o editor de plano (Planejar) e o fluxo
// de inclusão manual ("+ Adicionar paciente"). Ver Task F da Transição do Planejamento.
(() => {
  const tokenKey = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
  const token = tokenKey ? JSON.parse(localStorage.getItem(tokenKey))?.access_token : null;
  if (!token) { location.href = '/'; return; }
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Retry padrão do CRM p/ 5xx: 2 tentativas extras (1,5s / 3s) — copiado de /js/planejamento/app.js.
  async function api(path, opts = {}, tent = 0) {
    const r = await fetch(path, { headers: H, ...opts });
    if (r.status >= 500 && tent < 2) { await new Promise(s => setTimeout(s, tent ? 3000 : 1500)); return api(path, opts, tent + 1); }
    if (!r.ok) { const e = new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  }
  const $ = s => document.querySelector(s);
  const fmtBRL = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const seloPgto = t => {
    if (!t) return '';
    const m = { particular: ['Particular', 'sel-part'], convenio: ['Convênio', 'sel-conv'], misto: ['Misto', 'sel-mist'] };
    const [label, cls] = m[t] || [t, 'sel-part'];
    return `<span class="selo ${cls}">${esc(label)}</span>`;
  };
  const ORIGEM_LABEL = { sync_novo: 'novo', backlog: 'histórico', sucesso_manual: 'manual' };
  const STATUS_INFO = {
    aguardando_planejamento: { label: 'Sem planejamento', cls: 'status-sem' },
    planejado:               { label: 'Planejado',        cls: 'status-planejado' },
    em_andamento:             { label: 'Em andamento',      cls: 'status-andamento' },
    concluido:                { label: 'Concluído',         cls: 'status-concluido' },
    descartado:               { label: 'Sem etapas necessárias', cls: 'status-descartado' },
    cancelado:                { label: 'Cancelado',         cls: 'status-cancelado' },
  };
  const statusInfo = s => STATUS_INFO[s] || { label: s || '—', cls: 'status-descartado' };

  let planosTodos = [], filtro = 'todos';

  // ── LISTA ────────────────────────────────────────────────────────────────
  async function carregar() {
    $('#tabela').innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    try {
      const { planos } = await api('/api/planejamento/fila?aba=sucesso');
      planosTodos = planos || [];
      renderResumo(planosTodos);
      renderTabela();
    } catch (e) {
      $('#tabela').innerHTML = `<div class="empty">Erro: ${esc(e.message)}</div>`;
    }
  }

  function renderResumo(planos) {
    const total = planos.length;
    const planejados = planos.filter(p => ['planejado', 'em_andamento', 'concluido'].includes(p.status)).length;
    const sem = planos.filter(p => p.status === 'aguardando_planejamento').length;
    const pct = total ? Math.round((planejados / total) * 100) : 0;
    $('#rTotal').textContent = total;
    $('#rPlanejados').textContent = planejados;
    $('#rSem').textContent = sem;
    $('#rPct').textContent = `${pct}% já planejados`;
    $('#rBar').style.width = `${pct}%`;
  }

  function planosFiltrados() {
    if (filtro === 'sem') return planosTodos.filter(p => p.status === 'aguardando_planejamento');
    if (filtro === 'tratamento') return planosTodos.filter(p => p.status === 'em_andamento');
    return planosTodos;
  }

  function linha(p) {
    const dias = Math.floor((Date.now() - new Date(p.criado_em).getTime()) / 864e5);
    const info = statusInfo(p.status);
    const origemLbl = ORIGEM_LABEL[p.origem];
    return `<tr class="linha-clicavel" data-abrir-row="${esc(p.id)}">
      <td>
        <span class="paciente-nome">${esc(p.paciente_nome) || '—'}</span>
        ${seloPgto(p.tipo_pagamento)}
        ${origemLbl ? `<span class="tag-origem">${esc(origemLbl)}</span>` : ''}
        ${p.possivel_duplicata ? `<span class="badge badge-amarelo" title="possível duplicata (renegociação?)">⚠ suspeita</span>` : ''}
      </td>
      <td>${fmtBRL(p.valor)}<span class="venda-entrada">entrada ${fmtBRL(p.entrada)}</span></td>
      <td class="dias">${dias}d</td>
      <td><span class="status-badge ${info.cls}">${esc(info.label)}</span></td>
      <td><button data-abrir="${esc(p.id)}">Abrir</button><button data-planejar="${esc(p.id)}">Planejar</button></td>
    </tr>`;
  }

  function renderTabela() {
    const lista = planosFiltrados();
    const el = $('#tabela');
    if (!lista.length) { el.innerHTML = '<div class="empty">Nenhum paciente nesta visão.</div>'; return; }
    el.innerHTML = `<table><thead><tr>
      <th>Paciente</th><th>Venda</th><th>Acompanhamento</th><th>Planejamento</th><th></th>
    </tr></thead><tbody>${lista.map(linha).join('')}</tbody></table>`;
  }

  $('#chips').onclick = ev => {
    const b = ev.target.closest('[data-filtro]'); if (!b) return;
    document.querySelectorAll('#chips .chip').forEach(c => c.classList.remove('ativo'));
    b.classList.add('ativo');
    filtro = b.dataset.filtro;
    renderTabela();
  };

  $('#tabela').addEventListener('click', ev => {
    const planejar = ev.target.closest('[data-planejar]');
    if (planejar) return abrirPlanejar(planejar.dataset.planejar);
    const abrir = ev.target.closest('[data-abrir]');
    if (abrir) return abrirDrawer(abrir.dataset.abrir);
    const row = ev.target.closest('[data-abrir-row]');
    if (row) return abrirDrawer(row.dataset.abrirRow);
  });

  // ── DRAWER (trilha do tratamento) ───────────────────────────────────────
  function fecharDrawer() {
    $('#drawer').classList.remove('open');
    $('#overlay').classList.remove('show');
  }
  $('#drawerClose').onclick = fecharDrawer;
  $('#overlay').onclick = fecharDrawer;

  async function abrirDrawer(id) {
    $('#drawerBody').innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    $('#drawer').classList.add('open');
    $('#overlay').classList.add('show');
    try {
      const data = await api(`/api/planejamento/plano/${id}`);
      renderDrawer(data);
    } catch (e) {
      $('#drawerBody').innerHTML = `<p class="empty">Erro: ${esc(e.message)}</p>`;
    }
  }

  function flatEtapas(itens) {
    const flat = [];
    for (const item of itens || []) {
      for (const e of [...(item.plano_etapas || [])].sort((a, b) => a.ordem - b.ordem)) flat.push(e);
      for (const sub of [...(item.sublotes || [])].sort((a, b) => a.ordem - b.ordem)) {
        for (const e of [...(sub.plano_etapas || [])].sort((a, b) => a.ordem - b.ordem)) flat.push(e);
      }
    }
    return flat;
  }
  function idPrimeiraPendente(itens) {
    const pend = flatEtapas(itens).find(e => e.status === 'pendente');
    return pend ? pend.id : null;
  }
  function proximoPasso(itens) {
    const flat = flatEtapas(itens);
    const pend = flat.find(e => e.status === 'pendente');
    if (pend) return pend.descricao;
    return flat.length ? 'Todas as etapas planejadas foram concluídas.' : 'Sem etapas planejadas ainda.';
  }
  function stepperLi(e, currentId) {
    const cls = e.status !== 'pendente' ? 'done' : (e.id === currentId ? 'current' : '');
    const meta = [e.profissional_executor, e.tempo_planejado_min ? `${e.tempo_planejado_min} min` : null].filter(Boolean).join(' · ');
    return `<li class="${cls}"><div class="desc">${esc(e.descricao)}</div>${meta ? `<div class="meta">${esc(meta)}</div>` : ''}</li>`;
  }
  function itemBlocoHTML(item, currentId) {
    const raizEtapas = [...(item.plano_etapas || [])].sort((a, b) => a.ordem - b.ordem);
    const subs = [...(item.sublotes || [])].sort((a, b) => a.ordem - b.ordem);
    let html = `<div class="item-bloco"><h3>${esc(item.procedure_name)} × ${esc(item.quantidade)}</h3>`;
    if (raizEtapas.length) html += `<ol class="stepper">${raizEtapas.map(e => stepperLi(e, currentId)).join('')}</ol>`;
    for (const sub of subs) {
      const subEtapas = [...(sub.plano_etapas || [])].sort((a, b) => a.ordem - b.ordem);
      html += `<div class="rotulo-sublote">${esc(sub.rotulo || sub.procedure_name)}</div>`;
      html += subEtapas.length ? `<ol class="stepper">${subEtapas.map(e => stepperLi(e, currentId)).join('')}</ol>` : '<p class="vazio" style="padding:4px 0">Sem etapas.</p>';
    }
    if (!raizEtapas.length && !subs.length) html += '<p class="vazio" style="padding:4px 0">Sem etapas planejadas.</p>';
    html += '</div>';
    return html;
  }

  function renderDrawer({ plano, itens }) {
    const info = statusInfo(plano.status);
    const origemLbl = ORIGEM_LABEL[plano.origem];
    const currentId = idPrimeiraPendente(itens);
    const corpo = (itens && itens.length)
      ? itens.map(item => itemBlocoHTML(item, currentId)).join('')
      : `<p class="vazio">${plano.descricao_manual ? esc(plano.descricao_manual) : 'Sem itens de orçamento vinculados a este plano.'}</p>`;
    $('#drawerBody').innerHTML = `
      <h2>${esc(plano.paciente_nome) || '—'}</h2>
      <div class="sub">${fmtBRL(plano.valor)} · entrada ${fmtBRL(plano.entrada)}
        ${seloPgto(plano.tipo_pagamento)}
        ${origemLbl ? `<span class="tag-origem">${esc(origemLbl)}</span>` : ''}
        <span class="status-badge ${info.cls}" style="margin-left:6px">${esc(info.label)}</span></div>
      ${plano.recado_sucesso ? `<div class="recado"><b>Recado p/ Sucesso do Cliente</b><br>${esc(plano.recado_sucesso)}</div>` : ''}
      <div class="proximo"><b>Próximo passo</b>${esc(proximoPasso(itens))}</div>
      ${corpo}
      <footer>
        <button class="btn btn-primario" id="btDrawerPlanejar">Planejar</button>
        <button class="btn btn-ghost" id="btDrawerFechar">Fechar</button>
      </footer>`;
    $('#btDrawerFechar').onclick = fecharDrawer;
    $('#btDrawerPlanejar').onclick = () => abrirPlanejar(plano.id);
  }

  // ── PLANEJAR (editor compartilhado) ─────────────────────────────────────
  function abrirPlanejar(id) {
    return window.PlanejamentoEditor.abrir(id, { api, onSaved: () => { fecharDrawer(); carregar(); } });
  }

  // ── + ADICIONAR PACIENTE ────────────────────────────────────────────────
  $('#btAdicionar').onclick = abrirAdicionar;

  function abrirAdicionar() {
    const dlg = $('#dlgAdd');
    dlg.innerHTML = `
      <h2>Adicionar paciente à Trilha</h2>
      <label>Buscar paciente (nome ou telefone)
        <input type="text" id="addBusca" placeholder="Digite ao menos 2 caracteres">
      </label>
      <div id="addResultados"></div>
      <button type="button" class="link-manual" id="addManualLink">Não encontrei o paciente/orçamento — descrever à mão</button>
      <div id="addManualForm" style="display:none"></div>
      <footer><button class="btn btn-ghost" id="addFechar">Fechar</button></footer>`;
    dlg.showModal();
    $('#addFechar').onclick = () => dlg.close();
    $('#addManualLink').onclick = () => mostrarFormManual();
    let deb;
    $('#addBusca').oninput = ev => {
      clearTimeout(deb);
      const q = ev.target.value.trim();
      if (q.length < 2) { $('#addResultados').innerHTML = ''; return; }
      deb = setTimeout(() => buscarPaciente(q), 350);
    };
  }

  async function buscarPaciente(q) {
    const el = $('#addResultados');
    el.innerHTML = '<div class="vazio"><span class="spinner"></span></div>';
    try {
      const { pacientes } = await api(`/api/planejamento/buscar-paciente?q=${encodeURIComponent(q)}`);
      el.innerHTML = (pacientes || []).length ? pacientes.map(resultadoHTML).join('') : '<p class="vazio">Nenhum paciente encontrado.</p>';
    } catch (e) {
      el.innerHTML = `<p class="vazio">Erro: ${esc(e.message)}</p>`;
    }
  }

  function resultadoHTML(p) {
    const fone = [p.telefone_celular, p.telefone_fixo].filter(Boolean).join(' / ');
    const orcs = (p.orcamentos || []).map(o => `
      <div class="orc-linha">
        <span>${fmtBRL(o.valor_particular ?? o.valor)} ${seloPgto(o.selo)} <span style="color:var(--muted)">(${esc(o.status || '')})</span></span>
        <button class="btn btn-ghost" data-sel-orc="${esc(o.clinicorp_estimate_id)}" data-sel-pac="${esc(p.clinicorp_id)}"
          data-sel-nome="${esc(p.nome)}" data-sel-fone="${esc(fone)}">Incluir este orçamento</button>
      </div>`).join('');
    return `<div class="busca-resultado">
      <div class="nome">${esc(p.nome)}</div>
      <div class="fone">${esc(fone) || 'sem telefone cadastrado'}</div>
      ${orcs || '<p class="vazio" style="padding:4px 0">Sem orçamentos encontrados.</p>'}
      <button type="button" class="link-manual" data-sem-orc data-pac="${esc(p.clinicorp_id)}" data-nome="${esc(p.nome)}" data-fone="${esc(fone)}">Sem orçamento — descrever tratamento p/ este paciente</button>
    </div>`;
  }

  $('#dlgAdd').addEventListener('click', async ev => {
    const selOrc = ev.target.closest('[data-sel-orc]');
    const semOrc = ev.target.closest('[data-sem-orc]');
    if (selOrc) {
      if (!confirm('Incluir este orçamento na Trilha da Sucesso?')) return;
      try {
        await api('/api/planejamento/incluir-manual', {
          method: 'POST', body: JSON.stringify({
            paciente_clinicorp_id: selOrc.dataset.selPac || null,
            paciente_nome: selOrc.dataset.selNome,
            telefone: selOrc.dataset.selFone,
            estimate_id: selOrc.dataset.selOrc,
          }),
        });
        $('#dlgAdd').close();
        await carregar();
      } catch (e) { alert(e.message); }
    }
    if (semOrc) mostrarFormManual({ paciente_clinicorp_id: semOrc.dataset.pac, paciente_nome: semOrc.dataset.nome, telefone: semOrc.dataset.fone });
  });

  function mostrarFormManual(pref) {
    pref = pref || {};
    const wrap = $('#addManualForm');
    wrap.style.display = '';
    wrap.innerHTML = `
      <label>Nome do paciente<input type="text" id="mNome" value="${esc(pref.paciente_nome || '')}"></label>
      <label>Telefone<input type="text" id="mFone" value="${esc(pref.telefone || '')}"></label>
      <label>Descrição do tratamento<textarea id="mDesc" placeholder="Ex.: reabilitação superior — a orçar"></textarea></label>
      <label>Tipo de pagamento (opcional)
        <select id="mTipo"><option value="">—</option><option value="particular">Particular</option><option value="convenio">Convênio</option><option value="misto">Misto</option></select>
      </label>
      <footer><button class="btn btn-primario" id="mEnviar">Incluir na trilha</button></footer>`;
    $('#mEnviar').onclick = async () => {
      const nome = $('#mNome').value.trim();
      const desc = $('#mDesc').value.trim();
      if (!nome) return alert('Informe o nome do paciente.');
      if (!desc) return alert('Descreva o tratamento (à mão).');
      try {
        await api('/api/planejamento/incluir-manual', {
          method: 'POST', body: JSON.stringify({
            paciente_clinicorp_id: pref.paciente_clinicorp_id || null,
            paciente_nome: nome,
            telefone: $('#mFone').value.trim(),
            descricao_manual: desc,
            tipo_pagamento: $('#mTipo').value || null,
          }),
        });
        $('#dlgAdd').close();
        await carregar();
      } catch (e) { alert(e.message); }
    };
  }

  carregar();
})();
