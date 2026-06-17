// public/js/tarefas/gestao.js
// Gestão de Tarefas — Painel / Criar / Histórico

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
        if (btn.dataset.tab === 'criar')     renderCriarForm();
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

  // ── CRIAR TAB ────────────────────────────────────────────────────────────────
  function renderCriarForm() {
    const root = document.getElementById('criar-root');
    if (!root) return;

    const pessoasHtmlDem = _pessoas.length === 0
      ? '<p style="font-size:13px;color:var(--muted);padding:8px 12px">Nenhuma pessoa ativa encontrada.</p>'
      : _pessoas.map(function (p) {
          return `<label class="pessoa-check">
            <input type="checkbox" class="cr-pessoa-dem-cb" value="${esc(p.id)}">
            ${esc(p.nome)}
          </label>`;
        }).join('');

    const pessoasHtmlRot = _pessoas.length === 0
      ? '<p style="font-size:13px;color:var(--muted);padding:8px 12px">Nenhuma pessoa ativa encontrada.</p>'
      : _pessoas.map(function (p) {
          return `<label class="pessoa-check">
            <input type="checkbox" class="cr-pessoa-rot-cb" value="${esc(p.id)}">
            ${esc(p.nome)}
          </label>`;
        }).join('');

    const diasHtml = DIAS_LABELS.map(function (d, i) {
      return '<label class="dia-btn" id="cr-dia-label-' + i + '"><input type="checkbox" id="cr-dia-' + i + '" value="' + i + '" onchange="_toggleCriarDia(' + i + ')"> ' + d + '</label>';
    }).join('');

    const cargosHtml = ROLES_CARGO.map(function (r) {
      return '<option value="' + esc(r) + '">' + esc(r) + '</option>';
    }).join('');

    const catsHtml = CATEGORIAS.map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('');

    root.innerHTML = `
      <div style="max-width:560px">

        <div class="tipo-toggle">
          <button class="tipo-btn active" id="cr-btn-demanda" onclick="_onTipoAtividade('demanda')">Demanda</button>
          <button class="tipo-btn"        id="cr-btn-rotina"  onclick="_onTipoAtividade('rotina')">Rotina</button>
        </div>

        <div class="form-row">
          <label class="form-label">Título *</label>
          <input class="form-input" id="cr-titulo" type="text" placeholder="Ex: Ligar para leads pendentes" autocomplete="off">
        </div>
        <div class="form-row">
          <label class="form-label">Descrição</label>
          <textarea class="form-textarea" id="cr-desc" placeholder="Detalhes opcionais..."></textarea>
        </div>
        <div class="form-row-2">
          <div>
            <label class="form-label">Prioridade</label>
            <select class="form-select" id="cr-prio">
              <option value="normal">Normal</option>
              <option value="alta">Alta</option>
              <option value="baixa">Baixa</option>
            </select>
          </div>
          <div>
            <label class="form-label">Categoria</label>
            <select class="form-select" id="cr-cat">
              <option value="">Nenhuma</option>
              ${catsHtml}
            </select>
          </div>
        </div>
        <div class="form-row-2">
          <div>
            <label class="form-label">Tipo de resultado</label>
            <select class="form-select" id="cr-tipo-resultado" onchange="_onCriarNumeroChange()">
              <option value="check">Check (feito/não feito)</option>
              <option value="numero">Número (valor numérico)</option>
            </select>
          </div>
          <div></div>
        </div>
        <div id="cr-numero-wrap" style="display:none" class="form-row-2">
          <div>
            <label class="form-label">Unidade</label>
            <input class="form-input" id="cr-unidade" type="text" placeholder="Ex: ligações, R$">
          </div>
          <div>
            <label class="form-label">Meta</label>
            <input class="form-input" id="cr-meta" type="number" step="any" placeholder="Ex: 10">
          </div>
        </div>
        <div class="form-row">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
            <input type="checkbox" id="cr-arrasta">
            <span><strong>Arrasta</strong> — se não concluída hoje, aparece amanhã</span>
          </label>
        </div>

        <div id="cr-demanda-section">
          <div class="form-row">
            <label class="form-label">Prazo (opcional)</label>
            <input class="form-input" id="cr-prazo" type="datetime-local" style="max-width:260px">
          </div>
          <div class="form-row">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <label class="form-label" style="margin:0">Para quem *</label>
              <button class="btn btn-ghost btn-sm" onclick="_criarSelectAll('dem')">Selecionar todos</button>
            </div>
            <div class="pessoas-list">${pessoasHtmlDem}</div>
          </div>
        </div>

        <div id="cr-rotina-section" style="display:none">
          <div class="form-row-2">
            <div>
              <label class="form-label">Frequência</label>
              <select class="form-select" id="cr-freq" onchange="_onRotinaFreqChange()">
                <option value="diaria">Diária</option>
                <option value="semanal">Semanal</option>
                <option value="mensal">Mensal</option>
              </select>
            </div>
            <div></div>
          </div>
          <div id="cr-dias-wrap" style="display:none" class="form-row">
            <label class="form-label">Dias da semana</label>
            <div class="dias-grid">${diasHtml}</div>
          </div>
          <div id="cr-diames-wrap" style="display:none" class="form-row">
            <label class="form-label">Dia do mês (1–31)</label>
            <input class="form-input" id="cr-diames" type="number" min="1" max="31" placeholder="Ex: 1" style="max-width:120px">
          </div>
          <div class="form-row">
            <label class="form-label">Destino</label>
            <div style="display:flex;gap:20px;margin-top:4px">
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
                <input type="radio" name="cr-destino" id="cr-destino-cargo" value="cargo" checked onchange="_onRotinaDestinoChange()">
                Por cargo
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
                <input type="radio" name="cr-destino" id="cr-destino-pessoas" value="pessoas" onchange="_onRotinaDestinoChange()">
                Pessoas específicas
              </label>
            </div>
          </div>
          <div id="cr-cargo-wrap" class="form-row">
            <label class="form-label">Cargo</label>
            <select class="form-select" id="cr-role" style="max-width:260px">
              <option value="">Selecione</option>
              ${cargosHtml}
            </select>
          </div>
          <div id="cr-pessoas-rotina-wrap" style="display:none" class="form-row">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <label class="form-label" style="margin:0">Para quem *</label>
              <button class="btn btn-ghost btn-sm" onclick="_criarSelectAll('rot')">Selecionar todos</button>
            </div>
            <div class="pessoas-list">${pessoasHtmlRot}</div>
          </div>
        </div>

        <div class="form-actions" style="justify-content:flex-start;margin-top:20px">
          <button class="btn btn-primary" onclick="_salvarCriar()">Criar tarefa(s)</button>
          <button class="btn btn-ghost" onclick="_limparCriar()">Limpar</button>
        </div>
      </div>`;
  }

  window._onTipoAtividade = function (tipo) {
    const btnDem = document.getElementById('cr-btn-demanda');
    const btnRot = document.getElementById('cr-btn-rotina');
    const secDem = document.getElementById('cr-demanda-section');
    const secRot = document.getElementById('cr-rotina-section');
    if (!btnDem) return;
    const isDemanda = tipo === 'demanda';
    btnDem.classList.toggle('active', isDemanda);
    btnRot.classList.toggle('active', !isDemanda);
    secDem.style.display = isDemanda ? '' : 'none';
    secRot.style.display = isDemanda ? 'none' : '';
  };

  window._onCriarNumeroChange = function () {
    const tipo = document.getElementById('cr-tipo-resultado').value;
    const wrap = document.getElementById('cr-numero-wrap');
    if (wrap) wrap.style.display = tipo === 'numero' ? '' : 'none';
  };

  window._onRotinaFreqChange = function () {
    const freq     = document.getElementById('cr-freq').value;
    const diasWrap = document.getElementById('cr-dias-wrap');
    const diaMWrap = document.getElementById('cr-diames-wrap');
    if (diasWrap) diasWrap.style.display = freq === 'semanal' ? '' : 'none';
    if (diaMWrap) diaMWrap.style.display = freq === 'mensal'  ? '' : 'none';
  };

  window._onRotinaDestinoChange = function () {
    const checked     = document.querySelector('input[name="cr-destino"]:checked');
    const cargoWrap   = document.getElementById('cr-cargo-wrap');
    const pessoasWrap = document.getElementById('cr-pessoas-rotina-wrap');
    if (!checked) return;
    const isCargo = checked.value === 'cargo';
    if (cargoWrap)   cargoWrap.style.display   = isCargo ? '' : 'none';
    if (pessoasWrap) pessoasWrap.style.display = isCargo ? 'none' : '';
  };

  window._toggleCriarDia = function (i) {
    const label = document.getElementById('cr-dia-label-' + i);
    const cb    = document.getElementById('cr-dia-' + i);
    if (label && cb) label.classList.toggle('checked', cb.checked);
  };

  window._criarSelectAll = function (scope) {
    document.querySelectorAll('.cr-pessoa-' + scope + '-cb').forEach(function (cb) { cb.checked = true; });
  };

  window._salvarCriar = async function () {
    const titulo = (document.getElementById('cr-titulo').value || '').trim();
    if (!titulo) { toast('Informe o título.', 'warning'); return; }

    const desc    = (document.getElementById('cr-desc').value || '').trim();
    const prio    = document.getElementById('cr-prio').value;
    const cat     = document.getElementById('cr-cat').value;
    const tipoRes = document.getElementById('cr-tipo-resultado').value;
    const arrasta = document.getElementById('cr-arrasta').checked;
    const isDemanda = document.getElementById('cr-btn-demanda').classList.contains('active');

    const commonBody = { titulo, prioridade: prio, tipo_resultado: tipoRes, arrasta };
    if (desc) commonBody.descricao = desc;
    if (cat)  commonBody.categoria = cat;
    if (tipoRes === 'numero') {
      const un   = (document.getElementById('cr-unidade').value || '').trim();
      const meta = document.getElementById('cr-meta').value;
      if (un)   commonBody.unidade = un;
      if (meta) commonBody.meta = Number(meta);
    }

    if (isDemanda) {
      const prazo = document.getElementById('cr-prazo').value;
      const assignee_ids = [];
      document.querySelectorAll('.cr-pessoa-dem-cb:checked').forEach(function (cb) { assignee_ids.push(cb.value); });
      if (assignee_ids.length === 0) { toast('Selecione ao menos uma pessoa.', 'warning'); return; }
      const body = Object.assign({}, commonBody, { assignee_ids });
      if (prazo) body.prazo = new Date(prazo).toISOString();
      try {
        await tarefasApi('/api/tarefas', { method: 'POST', body: JSON.stringify(body) });
        toast('Demanda criada para ' + assignee_ids.length + ' pessoa(s)!', 'success');
        _limparCriar();
      } catch (e) { toast(e.message, 'error'); }

    } else {
      const freq    = document.getElementById('cr-freq').value;
      const checked = document.querySelector('input[name="cr-destino"]:checked');
      const destino = checked ? checked.value : 'cargo';
      const body    = Object.assign({}, commonBody, { frequencia: freq });

      if (freq === 'semanal') {
        const dias = [];
        for (let i = 0; i < 7; i++) {
          const cb = document.getElementById('cr-dia-' + i);
          if (cb && cb.checked) dias.push(i);
        }
        if (dias.length === 0) { toast('Selecione ao menos um dia da semana.', 'warning'); return; }
        body.dias_semana = dias;
      }
      if (freq === 'mensal') {
        const dm = parseInt(document.getElementById('cr-diames').value, 10);
        if (!dm || dm < 1 || dm > 31) { toast('Informe o dia do mês (1–31).', 'warning'); return; }
        body.dia_mes = dm;
      }

      if (destino === 'cargo') {
        const role = document.getElementById('cr-role').value;
        if (!role) { toast('Selecione o cargo.', 'warning'); return; }
        body.escopo = 'role';
        body.role   = role;
      } else {
        const assignee_ids = [];
        document.querySelectorAll('.cr-pessoa-rot-cb:checked').forEach(function (cb) { assignee_ids.push(cb.value); });
        if (assignee_ids.length === 0) { toast('Selecione ao menos uma pessoa.', 'warning'); return; }
        body.escopo       = 'usuarios';
        body.assignee_ids = assignee_ids;
      }

      try {
        await tarefasApi('/api/tarefas/templates', { method: 'POST', body: JSON.stringify(body) });
        toast('Rotina criada!', 'success');
        _limparCriar();
      } catch (e) { toast(e.message, 'error'); }
    }
  };

  window._limparCriar = function () {
    ['cr-titulo','cr-desc','cr-prazo','cr-unidade','cr-meta','cr-diames'].forEach(function (id) {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    const prio    = document.getElementById('cr-prio');           if (prio)    prio.value    = 'normal';
    const cat     = document.getElementById('cr-cat');            if (cat)     cat.value     = '';
    const tipoRes = document.getElementById('cr-tipo-resultado'); if (tipoRes) tipoRes.value = 'check';
    const freq    = document.getElementById('cr-freq');           if (freq)    freq.value    = 'diaria';
    const role    = document.getElementById('cr-role');           if (role)    role.value    = '';
    const arrasta = document.getElementById('cr-arrasta');        if (arrasta) arrasta.checked = false;
    const numWrap = document.getElementById('cr-numero-wrap');    if (numWrap) numWrap.style.display = 'none';
    const dWrap   = document.getElementById('cr-dias-wrap');      if (dWrap)   dWrap.style.display   = 'none';
    const dmWrap  = document.getElementById('cr-diames-wrap');    if (dmWrap)  dmWrap.style.display  = 'none';
    for (let i = 0; i < 7; i++) {
      const cb    = document.getElementById('cr-dia-' + i);        if (cb)    cb.checked = false;
      const label = document.getElementById('cr-dia-label-' + i);  if (label) label.classList.remove('checked');
    }
    document.querySelectorAll('.cr-pessoa-dem-cb, .cr-pessoa-rot-cb').forEach(function (cb) { cb.checked = false; });
    const destCargo = document.getElementById('cr-destino-cargo'); if (destCargo) destCargo.checked = true;
    _onRotinaDestinoChange();
    _onTipoAtividade('demanda');
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
