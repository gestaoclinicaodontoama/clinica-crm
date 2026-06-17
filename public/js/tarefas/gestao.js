// public/js/tarefas/gestao.js
// Gestão de Tarefas — Painel / Atribuir / Moldes por cargo / Histórico

(function () {
  'use strict';

  // ── CONSTANTES ───────────────────────────────────────────────────────────────
  const CATEGORIAS = ['Leads', 'Comercial', 'Pacientes', 'Financeiro', 'Administrativo', 'Marketing'];
  const DIAS_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const ROLES_CARGO = ['crc_leads', 'crc_comercial', 'crc_sucesso', 'crc_pos_tratamento', 'gestor', 'auxiliar_adm'];

  // id → nome map, and full list for checkboxes
  let _pessoaMap = {}; // { [id]: nome }
  let _pessoas = [];   // [{ id, nome, roles }]

  // ── TOAST ────────────────────────────────────────────────────────────────────
  function toast(msg, tipo) {
    tipo = tipo || 'info';
    const wrap = document.getElementById('tarefas-toast');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'toast-item ' + tipo;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }

  // ── UTILITÁRIOS ──────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function hojeISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function nomePessoa(id) {
    return _pessoaMap[id] || id || '(sem nome)';
  }

  function fmtFreq(t) {
    if (t.frequencia === 'diaria') return 'Diária';
    if (t.frequencia === 'semanal') {
      const dias = (t.dias_semana || []).map(function (d) { return DIAS_LABELS[d]; }).join(', ');
      return 'Semanal — ' + (dias || '?');
    }
    if (t.frequencia === 'mensal') return 'Mensal — dia ' + (t.dia_mes || '?');
    return t.frequencia || '';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function fmtMoney(n) {
    if (n == null || isNaN(n)) return '';
    return 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ── TABS ─────────────────────────────────────────────────────────────────────
  function initTabs() {
    document.querySelectorAll('.mod-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.mod-tab').forEach(function (b) {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        document.querySelectorAll('.mod-pane').forEach(function (p) { p.classList.remove('active'); });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        const pane = document.getElementById('tab-' + btn.dataset.tab);
        if (pane) pane.classList.add('active');

        if (btn.dataset.tab === 'painel')    renderPainelFilters();
        if (btn.dataset.tab === 'atribuir')  renderAtribuirForm();
        if (btn.dataset.tab === 'moldes')    loadMoldes();
        if (btn.dataset.tab === 'historico') renderHistoricoFilters();
      });
    });
  }

  // ── FECHAR MODAL ─────────────────────────────────────────────────────────────
  window._closeModal = function () {
    const bg = document.getElementById('tarefas-modal-bg');
    if (bg) bg.classList.remove('open');
  };

  document.addEventListener('click', function (e) {
    const bg = document.getElementById('tarefas-modal-bg');
    if (e.target === bg) window._closeModal();
  });

  // ── LOAD PESSOAS ─────────────────────────────────────────────────────────────
  async function loadPessoas() {
    try {
      const data = await tarefasApi('/api/tarefas/pessoas');
      _pessoas = data.pessoas || [];
      _pessoaMap = {};
      _pessoas.forEach(function (p) { _pessoaMap[p.id] = p.nome; });
    } catch (e) {
      toast('Erro ao carregar pessoas: ' + e.message, 'error');
    }
  }

  // ── PAINEL TAB ───────────────────────────────────────────────────────────────
  function renderPainelFilters() {
    const root = document.getElementById('painel-root');
    if (!root) return;
    const h = hojeISO();
    root.innerHTML = `
      <div class="painel-filters">
        <div>
          <label>De</label>
          <input type="date" id="painel-de" value="${esc(h)}">
        </div>
        <div>
          <label>Até</label>
          <input type="date" id="painel-ate" value="${esc(h)}">
        </div>
        <button class="btn btn-primary btn-sm" onclick="_loadPainel()">Atualizar</button>
      </div>
      <div id="painel-table-wrap"><p class="loading-msg">Carregando...</p></div>`;
    loadPainelData();
  }

  async function loadPainelData() {
    const wrap = document.getElementById('painel-table-wrap');
    if (!wrap) return;
    const de  = (document.getElementById('painel-de')  || {}).value  || hojeISO();
    const ate = (document.getElementById('painel-ate') || {}).value || hojeISO();
    wrap.innerHTML = '<p class="loading-msg">Carregando...</p>';
    try {
      const data = await tarefasApi('/api/tarefas/gestao?de=' + encodeURIComponent(de) + '&ate=' + encodeURIComponent(ate));
      const resumo = data.resumo || {};
      const ids = Object.keys(resumo);

      if (ids.length === 0) {
        wrap.innerHTML = `<div class="empty-msg"><div class="empty-icon">📊</div>Nenhuma tarefa no período.</div>`;
        return;
      }

      // sort by nome
      ids.sort(function (a, b) { return nomePessoa(a).localeCompare(nomePessoa(b), 'pt-BR'); });

      let rows = '';
      ids.forEach(function (id) {
        const r = resumo[id];
        const pct = r.total > 0 ? Math.round(100 * r.concluidas / r.total) : 0;
        const media = r.n_valor > 0 ? (r.soma_valor / r.n_valor) : null;
        rows += `
          <tr>
            <td style="font-weight:500">${esc(nomePessoa(id))}</td>
            <td>
              <div class="pct-bar">
                <div class="pct-bar-bg"><div class="pct-bar-fill" style="width:${pct}%"></div></div>
                <span class="pct-label">${pct}%</span>
              </div>
            </td>
            <td style="color:${r.atrasadas > 0 ? 'var(--red)' : 'var(--muted)'}">
              ${r.atrasadas > 0 ? '<strong>' + r.atrasadas + '</strong>' : r.atrasadas}
            </td>
            <td>${r.total}</td>
            <td style="font-size:12px;color:var(--muted)">
              ${r.n_valor > 0 ? esc(r.soma_valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) + (media != null ? ' <span style="opacity:.7">(média ' + media.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ')</span>' : '') : '—'}
            </td>
          </tr>`;
      });

      wrap.innerHTML = `
        <div class="gestao-table-wrap">
          <table class="gestao-table">
            <thead>
              <tr>
                <th>Pessoa</th>
                <th>% Concluído</th>
                <th>Atrasadas</th>
                <th>Total</th>
                <th>Número (soma / média)</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    } catch (e) {
      wrap.innerHTML = '<p class="loading-msg" style="color:var(--red)">Erro: ' + esc(e.message) + '</p>';
    }
  }

  window._loadPainel = function () { loadPainelData(); };

  // ── ATRIBUIR TAB ─────────────────────────────────────────────────────────────
  function renderAtribuirForm() {
    const root = document.getElementById('atribuir-root');
    if (!root) return;

    const pessoasHtml = _pessoas.length === 0
      ? '<p style="font-size:13px;color:var(--muted);padding:8px 12px">Nenhuma pessoa ativa encontrada.</p>'
      : _pessoas.map(function (p) {
          return `<label class="pessoa-check">
            <input type="checkbox" class="at-pessoa-cb" value="${esc(p.id)}">
            ${esc(p.nome)}
          </label>`;
        }).join('');

    root.innerHTML = `
      <div style="max-width:560px">
        <div style="margin-bottom:20px">
          <div style="font-size:15px;font-weight:600">Atribuir tarefa à equipe</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">Cria uma tarefa pontual para uma ou mais pessoas</div>
        </div>

        <div class="form-row">
          <label class="form-label">Título *</label>
          <input class="form-input" id="at-titulo" type="text" placeholder="Ex: Ligar para leads pendentes" autocomplete="off">
        </div>

        <div class="form-row">
          <label class="form-label">Descrição</label>
          <textarea class="form-textarea" id="at-desc" placeholder="Detalhes opcionais..."></textarea>
        </div>

        <div class="form-row-2">
          <div>
            <label class="form-label">Prioridade</label>
            <select class="form-select" id="at-prio">
              <option value="normal">Normal</option>
              <option value="alta">Alta</option>
              <option value="baixa">Baixa</option>
            </select>
          </div>
          <div>
            <label class="form-label">Categoria</label>
            <select class="form-select" id="at-cat">
              <option value="">Nenhuma</option>
              ${CATEGORIAS.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('')}
            </select>
          </div>
        </div>

        <div class="form-row">
          <label class="form-label">Prazo (opcional)</label>
          <input class="form-input" id="at-prazo" type="datetime-local" style="max-width:260px">
        </div>

        <div class="form-row">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <label class="form-label" style="margin:0">Atribuir para *</label>
            <button class="btn btn-ghost btn-sm" onclick="_atSelectAll()">Selecionar todos</button>
          </div>
          <div class="pessoas-list" id="at-pessoas-list">
            ${pessoasHtml}
          </div>
        </div>

        <div class="form-actions" style="justify-content:flex-start">
          <button class="btn btn-primary" onclick="_salvarAtribuicao()">Criar tarefa(s)</button>
          <button class="btn btn-ghost" onclick="_limparAtribuirForm()">Limpar</button>
        </div>
      </div>`;
  }

  window._atSelectAll = function () {
    document.querySelectorAll('.at-pessoa-cb').forEach(function (cb) { cb.checked = true; });
  };

  window._salvarAtribuicao = async function () {
    const titulo = (document.getElementById('at-titulo').value || '').trim();
    const desc   = (document.getElementById('at-desc').value || '').trim();
    const prio   = document.getElementById('at-prio').value;
    const cat    = document.getElementById('at-cat').value;
    const prazo  = document.getElementById('at-prazo').value;

    if (!titulo) { toast('Informe o título.', 'warning'); return; }

    const assignee_ids = [];
    document.querySelectorAll('.at-pessoa-cb:checked').forEach(function (cb) { assignee_ids.push(cb.value); });
    if (assignee_ids.length === 0) { toast('Selecione ao menos uma pessoa.', 'warning'); return; }

    const body = { titulo, prioridade: prio, assignee_ids: assignee_ids };
    if (desc)  body.descricao = desc;
    if (cat)   body.categoria = cat;
    if (prazo) body.prazo = new Date(prazo).toISOString();

    try {
      await tarefasApi('/api/tarefas', { method: 'POST', body: JSON.stringify(body) });
      toast('Tarefa criada para ' + assignee_ids.length + ' pessoa(s)!', 'success');
      _limparAtribuirForm();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  window._limparAtribuirForm = function () {
    const ids = ['at-titulo', 'at-desc', 'at-prazo'];
    ids.forEach(function (id) { const el = document.getElementById(id); if (el) el.value = ''; });
    const prio = document.getElementById('at-prio'); if (prio) prio.value = 'normal';
    const cat  = document.getElementById('at-cat');  if (cat)  cat.value  = '';
    document.querySelectorAll('.at-pessoa-cb').forEach(function (cb) { cb.checked = false; });
  };

  // ── MOLDES TAB ───────────────────────────────────────────────────────────────
  async function loadMoldes() {
    const root = document.getElementById('moldes-root');
    if (!root) return;
    root.innerHTML = '<p class="loading-msg">Carregando...</p>';
    try {
      const data = await tarefasApi('/api/tarefas/templates');
      const templates = (data.templates || []).filter(function (t) { return t.escopo === 'role'; });

      let html = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <div>
            <div style="font-size:15px;font-weight:600">Moldes por cargo</div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px">Rotinas geradas automaticamente por função</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="_openNovoMolde()">+ Novo molde</button>
        </div>`;

      if (templates.length === 0) {
        html += `
          <div class="empty-msg">
            <div class="empty-icon">🗂️</div>
            Nenhum molde por cargo criado ainda.<br>
            <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="_openNovoMolde()">Criar primeiro molde</button>
          </div>`;
      } else {
        templates.forEach(function (t) {
          html += `
            <div class="rotina-item" data-tid="${esc(t.id)}">
              <div class="rotina-body">
                <div class="rotina-titulo">${esc(t.titulo)}</div>
                <div class="rotina-meta">
                  <span class="chip">${esc(t.role || '')}</span>
                  <span class="chip">${esc(fmtFreq(t))}</span>
                  ${t.categoria    ? '<span class="chip cat">' + esc(t.categoria) + '</span>' : ''}
                  ${t.prioridade   ? '<span class="chip ' + esc(t.prioridade) + '">' + esc(t.prioridade) + '</span>' : ''}
                  ${t.tipo_resultado === 'numero' && t.meta != null ? '<span class="chip numero">meta: ' + esc(t.meta) + ' ' + esc(t.unidade || '') + '</span>' : ''}
                  ${t.arrasta ? '<span class="chip" style="color:var(--yellow);border-color:rgba(245,158,11,.3)">arrasta</span>' : ''}
                </div>
              </div>
              <button class="tarefa-del" onclick="_deletarMolde('${esc(t.id)}')" title="Excluir molde">×</button>
            </div>`;
        });
      }

      root.innerHTML = html;
    } catch (e) {
      root.innerHTML = '<p class="loading-msg" style="color:var(--red)">Erro: ' + esc(e.message) + '</p>';
    }
  }

  window._deletarMolde = async function (id) {
    if (!confirm('Excluir este molde? As tarefas já geradas não serão excluídas.')) return;
    try {
      await tarefasApi('/api/tarefas/templates/' + id, { method: 'DELETE' });
      toast('Molde excluído.', 'info');
      loadMoldes();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  window._openNovoMolde = function () {
    const modal = document.getElementById('tarefas-modal');
    const bg    = document.getElementById('tarefas-modal-bg');
    if (!modal || !bg) return;

    modal.innerHTML = `
      <h2>Novo molde por cargo</h2>

      <div class="form-row">
        <label class="form-label">Título *</label>
        <input class="form-input" id="ml-titulo" type="text" placeholder="Ex: Ligar para leads do dia" autocomplete="off">
      </div>

      <div class="form-row-2">
        <div>
          <label class="form-label">Cargo *</label>
          <select class="form-select" id="ml-role">
            <option value="">Selecione</option>
            ${ROLES_CARGO.map(function (r) { return '<option value="' + esc(r) + '">' + esc(r) + '</option>'; }).join('')}
          </select>
        </div>
        <div>
          <label class="form-label">Frequência *</label>
          <select class="form-select" id="ml-freq" onchange="_onMoldeFreqChange()">
            <option value="">Selecione</option>
            <option value="diaria">Diária</option>
            <option value="semanal">Semanal</option>
            <option value="mensal">Mensal</option>
          </select>
        </div>
      </div>

      <div id="ml-dias-wrap" style="display:none" class="form-row">
        <label class="form-label">Dias da semana</label>
        <div class="dias-grid">
          ${DIAS_LABELS.map(function (d, i) {
            return '<label class="dia-btn" id="ml-dia-label-' + i + '"><input type="checkbox" id="ml-dia-' + i + '" value="' + i + '" onchange="_toggleMoldeDia(' + i + ')"> ' + d + '</label>';
          }).join('')}
        </div>
      </div>

      <div id="ml-diames-wrap" style="display:none" class="form-row">
        <label class="form-label">Dia do mês (1–31)</label>
        <input class="form-input" id="ml-diames" type="number" min="1" max="31" placeholder="Ex: 1" style="max-width:120px">
      </div>

      <div class="form-row-2">
        <div>
          <label class="form-label">Prioridade</label>
          <select class="form-select" id="ml-prio">
            <option value="normal">Normal</option>
            <option value="alta">Alta</option>
            <option value="baixa">Baixa</option>
          </select>
        </div>
        <div>
          <label class="form-label">Categoria</label>
          <select class="form-select" id="ml-cat">
            <option value="">Nenhuma</option>
            ${CATEGORIAS.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('')}
          </select>
        </div>
      </div>

      <div class="form-row-2">
        <div>
          <label class="form-label">Tipo de resultado</label>
          <select class="form-select" id="ml-tipo" onchange="_onMoldeNumeroChange()">
            <option value="check">Check (feito/não feito)</option>
            <option value="numero">Número (valor numérico)</option>
          </select>
        </div>
        <div></div>
      </div>

      <div id="ml-numero-wrap" style="display:none" class="form-row-2">
        <div>
          <label class="form-label">Unidade</label>
          <input class="form-input" id="ml-unidade" type="text" placeholder="Ex: ligações, R$">
        </div>
        <div>
          <label class="form-label">Meta</label>
          <input class="form-input" id="ml-meta" type="number" step="any" placeholder="Ex: 10">
        </div>
      </div>

      <div class="form-row">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
          <input type="checkbox" id="ml-arrasta">
          <span><strong>Arrasta</strong> — se não concluída hoje, aparece amanhã</span>
        </label>
      </div>

      <div class="form-actions">
        <button class="btn btn-ghost" onclick="_closeModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="_salvarMolde()">Criar molde</button>
      </div>`;

    bg.classList.add('open');
  };

  window._onMoldeFreqChange = function () {
    const freq = document.getElementById('ml-freq').value;
    const diasWrap   = document.getElementById('ml-dias-wrap');
    const diamesWrap = document.getElementById('ml-diames-wrap');
    if (diasWrap)   diasWrap.style.display   = freq === 'semanal' ? '' : 'none';
    if (diamesWrap) diamesWrap.style.display = freq === 'mensal'  ? '' : 'none';
  };

  window._onMoldeNumeroChange = function () {
    const tipo = document.getElementById('ml-tipo').value;
    const wrap = document.getElementById('ml-numero-wrap');
    if (wrap) wrap.style.display = tipo === 'numero' ? '' : 'none';
  };

  window._toggleMoldeDia = function (i) {
    const label = document.getElementById('ml-dia-label-' + i);
    const cb    = document.getElementById('ml-dia-' + i);
    if (label && cb) label.classList.toggle('checked', cb.checked);
  };

  window._salvarMolde = async function () {
    const titulo  = (document.getElementById('ml-titulo').value || '').trim();
    const role    = document.getElementById('ml-role').value;
    const freq    = document.getElementById('ml-freq').value;
    const prio    = document.getElementById('ml-prio').value;
    const cat     = document.getElementById('ml-cat').value;
    const tipo    = document.getElementById('ml-tipo').value;
    const arrasta = document.getElementById('ml-arrasta').checked;

    if (!titulo) { toast('Informe o título.', 'warning'); return; }
    if (!role)   { toast('Selecione o cargo.', 'warning'); return; }
    if (!freq)   { toast('Selecione a frequência.', 'warning'); return; }

    const body = { titulo, escopo: 'role', role: role, frequencia: freq, prioridade: prio, arrasta: arrasta };
    if (cat)  body.categoria = cat;
    if (tipo) body.tipo_resultado = tipo;

    if (freq === 'semanal') {
      const dias = [];
      for (let i = 0; i < 7; i++) {
        const cb = document.getElementById('ml-dia-' + i);
        if (cb && cb.checked) dias.push(i);
      }
      if (dias.length === 0) { toast('Selecione ao menos um dia da semana.', 'warning'); return; }
      body.dias_semana = dias;
    }
    if (freq === 'mensal') {
      const dm = parseInt(document.getElementById('ml-diames').value, 10);
      if (!dm || dm < 1 || dm > 31) { toast('Informe o dia do mês (1–31).', 'warning'); return; }
      body.dia_mes = dm;
    }
    if (tipo === 'numero') {
      const un = (document.getElementById('ml-unidade').value || '').trim();
      const mt = parseFloat(document.getElementById('ml-meta').value);
      if (un) body.unidade = un;
      if (!isNaN(mt)) body.meta = mt;
    }

    try {
      await tarefasApi('/api/tarefas/templates', { method: 'POST', body: JSON.stringify(body) });
      toast('Molde criado!', 'success');
      window._closeModal();
      loadMoldes();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  // ── HISTÓRICO TAB ────────────────────────────────────────────────────────────
  function renderHistoricoFilters() {
    const root = document.getElementById('historico-root');
    if (!root) return;
    const h = hojeISO();

    const pessoaOptions = '<option value="">Todos</option>' +
      _pessoas.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.nome) + '</option>'; }).join('');

    const catOptions = '<option value="">Todas</option>' +
      CATEGORIAS.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');

    root.innerHTML = `
      <div class="painel-filters" style="margin-bottom:20px">
        <div>
          <label>De</label>
          <input type="date" id="hist-de" value="${esc(h)}">
        </div>
        <div>
          <label>Até</label>
          <input type="date" id="hist-ate" value="${esc(h)}">
        </div>
        <div>
          <label>Pessoa</label>
          <select id="hist-pessoa">${pessoaOptions}</select>
        </div>
        <div>
          <label>Categoria</label>
          <select id="hist-cat">${catOptions}</select>
        </div>
        <button class="btn btn-primary btn-sm" onclick="_loadHistorico()">Buscar</button>
      </div>
      <div id="hist-list-wrap"><p class="loading-msg">Clique em "Buscar" para carregar.</p></div>`;
  }

  async function loadHistoricoData() {
    const wrap = document.getElementById('hist-list-wrap');
    if (!wrap) return;
    const de      = (document.getElementById('hist-de')     || {}).value || hojeISO();
    const ate     = (document.getElementById('hist-ate')    || {}).value || hojeISO();
    const pessoa  = (document.getElementById('hist-pessoa') || {}).value || '';
    const cat     = (document.getElementById('hist-cat')    || {}).value || '';

    let url = '/api/tarefas/gestao?de=' + encodeURIComponent(de) + '&ate=' + encodeURIComponent(ate);
    if (pessoa) url += '&pessoa=' + encodeURIComponent(pessoa);
    if (cat)    url += '&categoria=' + encodeURIComponent(cat);

    wrap.innerHTML = '<p class="loading-msg">Carregando...</p>';
    try {
      const data = await tarefasApi(url);
      const tarefas = data.tarefas || [];

      if (tarefas.length === 0) {
        wrap.innerHTML = '<div class="empty-msg"><div class="empty-icon">🔍</div>Nenhuma tarefa no período/filtro.</div>';
        return;
      }

      const hoje = hojeISO();
      let html = '';
      tarefas.forEach(function (t) {
        const atrasada = t.status === 'pendente' && t.data_ref < hoje;
        let statusHtml;
        if (t.status === 'concluida') {
          const quando = t.concluida_em ? ' em ' + fmtDate(t.concluida_em.substring(0, 10)) : '';
          statusHtml = '<span class="hist-status-concluida">Concluída' + esc(quando) + '</span>';
        } else if (atrasada) {
          statusHtml = '<span class="hist-status-atrasada">Atrasada</span>';
        } else {
          statusHtml = '<span class="hist-status-pendente">Pendente</span>';
        }

        const valorHtml = (t.tipo_resultado === 'numero' && t.valor_resultado != null)
          ? '<span class="chip numero">' + esc(t.valor_resultado) + ' ' + esc(t.unidade || '') + '</span>'
          : '';

        html += `
          <div class="hist-item">
            <div class="hist-body">
              <div class="hist-titulo">${esc(t.titulo)}</div>
              <div class="hist-meta">
                <span style="font-size:11.5px;color:var(--muted)">${esc(nomePessoa(t.assignee_id))}</span>
                <span style="font-size:11.5px;color:var(--muted);font-family:'DM Mono',monospace">${esc(fmtDate(t.data_ref))}</span>
                ${t.categoria ? '<span class="chip cat">' + esc(t.categoria) + '</span>' : ''}
                ${t.prioridade ? '<span class="chip ' + esc(t.prioridade) + '">' + esc(t.prioridade) + '</span>' : ''}
                ${statusHtml}
                ${valorHtml}
              </div>
            </div>
          </div>`;
      });

      wrap.innerHTML = html;
    } catch (e) {
      wrap.innerHTML = '<p class="loading-msg" style="color:var(--red)">Erro: ' + esc(e.message) + '</p>';
    }
  }

  window._loadHistorico = function () { loadHistoricoData(); };

  // ── INIT ─────────────────────────────────────────────────────────────────────
  async function init() {
    initTabs();
    await loadPessoas();
    renderPainelFilters();
    renderAtribuirForm();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
