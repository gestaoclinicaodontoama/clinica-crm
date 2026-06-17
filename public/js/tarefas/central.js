// public/js/tarefas/central.js
// Central de Tarefas — Hoje + Nova Tarefa + Minha Rotina

(function () {
  'use strict';

  // ── CONSTANTES ───────────────────────────────────────────────────────────────
  const CATEGORIAS = ['Leads', 'Comercial', 'Pacientes', 'Financeiro', 'Administrativo', 'Marketing'];
  const PRIO_ORDER = { alta: 0, normal: 1, baixa: 2 };
  const DIAS_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  // mapa id → tipo_resultado (para não depender de parsing de DOM)
  const _tipoResultado = {};

  // ── TOAST ────────────────────────────────────────────────────────────────────
  function toast(msg, tipo = 'info') {
    const wrap = document.getElementById('tarefas-toast');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'toast-item ' + tipo;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // ── TABS ─────────────────────────────────────────────────────────────────────
  function initTabs() {
    document.querySelectorAll('.mod-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.mod-tab').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        document.querySelectorAll('.mod-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        const pane = document.getElementById('tab-' + btn.dataset.tab);
        if (pane) pane.classList.add('active');

        if (btn.dataset.tab === 'hoje') loadHoje();
        if (btn.dataset.tab === 'rotina') loadRotina();
        if (btn.dataset.tab === 'nova') renderNovaForm();
      });
    });
  }

  // ── UTILITÁRIOS ──────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function hoje() {
    // data local no formato YYYY-MM-DD
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function isAtrasada(t, refHoje) {
    if (t.status !== 'pendente') return false;
    // data_ref anterior a hoje
    if (t.data_ref && t.data_ref < refHoje) return true;
    // prazo passado
    if (t.prazo && t.prazo < new Date().toISOString()) return true;
    return false;
  }

  function fmtPrazo(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const vencido = d < now;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return { text: `${dd}/${mm} ${hh}:${mi}`, vencido };
  }

  function fmtFreq(t) {
    if (t.frequencia === 'diaria') return 'Diária';
    if (t.frequencia === 'semanal') {
      const dias = (t.dias_semana || []).map(d => DIAS_LABELS[d]).join(', ');
      return 'Semanal — ' + (dias || '?');
    }
    if (t.frequencia === 'mensal') return 'Mensal — dia ' + (t.dia_mes || '?');
    return t.frequencia || '';
  }

  // ── RENDERIZA TAREFA ITEM ────────────────────────────────────────────────────
  function renderTarefaItem(t, refHoje) {
    _tipoResultado[t.id] = t.tipo_resultado;

    const atrasada = isAtrasada(t, refHoje);
    const concluida = t.status === 'concluida';
    const classes = ['tarefa-item', atrasada ? 'atrasada' : '', concluida ? 'concluida' : ''].filter(Boolean).join(' ');

    // prazo
    let prazoHtml = '';
    if (t.prazo) {
      const p = fmtPrazo(t.prazo);
      prazoHtml = `<span class="tarefa-prazo${p.vencido ? ' vencido' : ''}">${esc(p.text)}</span>`;
    }

    // vínculo
    let vinculoHtml = '';
    if (t.lead_id) {
      vinculoHtml = `<a class="tarefa-link" href="/kanban-leads/?lead=${esc(t.lead_id)}" target="_blank">↗ lead</a>`;
    } else if (t.paciente_clinicorp_id) {
      vinculoHtml = `<a class="tarefa-link" href="/pacientes/?cid=${encodeURIComponent(t.paciente_clinicorp_id)}" target="_blank">↗ paciente</a>`;
    }

    // meta (para tipo numero)
    let metaHtml = '';
    if (t.tipo_resultado === 'numero' && t.meta != null) {
      metaHtml = `<span class="chip numero">(meta: ${esc(t.meta)} ${esc(t.unidade || '')})</span>`;
    }

    // valor_resultado (concluída numero)
    let valorHtml = '';
    if (concluida && t.tipo_resultado === 'numero' && t.valor_resultado != null) {
      valorHtml = `<span class="tarefa-valor-result">${esc(t.valor_resultado)} ${esc(t.unidade || '')}</span>`;
    }

    // inline numero input (pendente + numero)
    let numeroInputHtml = '';
    if (!concluida && t.tipo_resultado === 'numero') {
      numeroInputHtml = `
        <div class="numero-inline" id="ni-${esc(t.id)}" style="display:none">
          <input type="number" step="any" id="ni-val-${esc(t.id)}" placeholder="valor" aria-label="Valor resultado">
          <span>${esc(t.unidade || '')}</span>
          <button class="btn btn-primary btn-sm" onclick="_concluirNumero('${esc(t.id)}')">Confirmar</button>
          <button class="btn btn-ghost btn-sm" onclick="_cancelarNumero('${esc(t.id)}')">Cancelar</button>
        </div>`;
    }

    // botão deletar (só pendente — apenas o criador deveria ver; sem info de criador no frontend, mostramos sempre e o backend rejeita se não for)
    const delBtn = !concluida
      ? `<button class="tarefa-del" onclick="_deletarTarefa('${esc(t.id)}')" title="Excluir tarefa">×</button>`
      : '';

    return `
      <div class="${classes}" data-id="${esc(t.id)}" data-tipo="${esc(t.tipo_resultado || 'check')}">
        <input type="checkbox" class="tarefa-check"
          ${concluida ? 'checked' : ''}
          onchange="_toggleTarefa('${esc(t.id)}', this)"
          aria-label="Marcar tarefa como ${concluida ? 'pendente' : 'concluída'}"
        >
        <div class="tarefa-body">
          <div class="tarefa-titulo">${esc(t.titulo)}</div>
          <div class="tarefa-meta">
            ${t.categoria ? `<span class="chip cat">${esc(t.categoria)}</span>` : ''}
            ${t.prioridade ? `<span class="chip ${esc(t.prioridade)}">${esc(t.prioridade)}</span>` : ''}
            ${metaHtml}
            ${valorHtml}
            ${prazoHtml}
            ${vinculoHtml}
          </div>
          ${t.descricao ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">${esc(t.descricao)}</div>` : ''}
          ${numeroInputHtml}
        </div>
        ${delBtn}
      </div>`;
  }

  // ── TOGGLE TAREFA (concluir / reabrir) ──────────────────────────────────────
  window._toggleTarefa = async function (id, cb) {
    const item = document.querySelector(`.tarefa-item[data-id="${id}"]`);
    const tipo = _tipoResultado[id] || (item ? item.dataset.tipo : 'check');
    const concluindo = cb.checked;

    if (concluindo && tipo === 'numero') {
      // mostrar input inline em vez de concluir imediatamente
      cb.checked = false; // desfaz o check visualmente até confirmar
      const ni = document.getElementById('ni-' + id);
      if (ni) ni.style.display = 'flex';
      return;
    }

    try {
      if (concluindo) {
        await tarefasApi('/api/tarefas/' + id, {
          method: 'PATCH',
          body: JSON.stringify({ acao: 'concluir' }),
        });
        toast('Tarefa concluída!', 'success');
      } else {
        await tarefasApi('/api/tarefas/' + id, {
          method: 'PATCH',
          body: JSON.stringify({ acao: 'reabrir' }),
        });
        toast('Tarefa reaberta.', 'info');
      }
      loadHoje();
    } catch (e) {
      toast(e.message, 'error');
      cb.checked = !concluindo; // reverter
    }
  };

  window._concluirNumero = async function (id) {
    const input = document.getElementById('ni-val-' + id);
    const val = input ? parseFloat(input.value) : NaN;
    if (isNaN(val)) { toast('Informe um valor numérico.', 'warning'); return; }
    try {
      await tarefasApi('/api/tarefas/' + id, {
        method: 'PATCH',
        body: JSON.stringify({ acao: 'concluir', valor_resultado: val }),
      });
      toast('Tarefa concluída com valor ' + val + '!', 'success');
      loadHoje();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  window._cancelarNumero = function (id) {
    const ni = document.getElementById('ni-' + id);
    if (ni) ni.style.display = 'none';
    const cb = document.querySelector(`.tarefa-item[data-id="${id}"] .tarefa-check`);
    if (cb) cb.checked = false;
  };

  window._deletarTarefa = async function (id) {
    if (!confirm('Excluir esta tarefa?')) return;
    try {
      await tarefasApi('/api/tarefas/' + id, { method: 'DELETE' });
      toast('Tarefa excluída.', 'info');
      loadHoje();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  // ── LOAD HOJE ────────────────────────────────────────────────────────────────
  async function loadHoje() {
    const root = document.getElementById('hoje-root');
    if (!root) return;
    root.innerHTML = '<p class="loading-msg">Carregando...</p>';

    try {
      const data = await tarefasApi('/api/tarefas?data=hoje');
      const tarefas = data.tarefas || [];
      const refHoje = data.hoje || hoje();

      // Atualizar subtítulo
      const sub = document.getElementById('tarefas-subtitle');
      if (sub) {
        const d = new Date(refHoje + 'T12:00:00');
        const opts = { weekday: 'long', day: 'numeric', month: 'long' };
        sub.textContent = d.toLocaleDateString('pt-BR', opts);
      }

      const atrasadas = tarefas.filter(t => t.status === 'pendente' && isAtrasada(t, refHoje));
      const pendentes = tarefas.filter(t => t.status === 'pendente' && !isAtrasada(t, refHoje))
        .sort((a, b) => {
          const pa = PRIO_ORDER[a.prioridade] ?? 1;
          const pb = PRIO_ORDER[b.prioridade] ?? 1;
          if (pa !== pb) return pa - pb;
          if (a.prazo && b.prazo) return a.prazo.localeCompare(b.prazo);
          if (a.prazo) return -1;
          if (b.prazo) return 1;
          return 0;
        });
      const concluidas = tarefas.filter(t => t.status === 'concluida');

      if (tarefas.length === 0) {
        root.innerHTML = `
          <div class="empty-msg">
            <div class="empty-icon">✅</div>
            Nenhuma tarefa para hoje. Bom trabalho!
          </div>`;
        return;
      }

      let html = '';

      if (atrasadas.length > 0) {
        html += `<div class="tarefa-group-title atrasadas">Atrasadas (${atrasadas.length})</div>`;
        atrasadas.forEach(t => { html += renderTarefaItem(t, refHoje); });
      }

      if (pendentes.length > 0) {
        html += `<div class="tarefa-group-title">Pendentes (${pendentes.length})</div>`;
        pendentes.forEach(t => { html += renderTarefaItem(t, refHoje); });
      }

      if (concluidas.length > 0) {
        let conclHtml = '';
        concluidas.forEach(t => { conclHtml += renderTarefaItem(t, refHoje); });
        html += `
          <details class="concluidas-section">
            <summary>Concluídas (${concluidas.length})</summary>
            ${conclHtml}
          </details>`;
      }

      root.innerHTML = html;
    } catch (e) {
      root.innerHTML = `<p class="loading-msg" style="color:var(--red)">Erro ao carregar: ${esc(e.message)}</p>`;
    }
  }

  // ── LOAD ROTINA ──────────────────────────────────────────────────────────────
  async function loadRotina() {
    const root = document.getElementById('rotina-root');
    if (!root) return;
    root.innerHTML = '<p class="loading-msg">Carregando...</p>';

    try {
      const data = await tarefasApi('/api/tarefas/templates');
      const templates = (data.templates || []).filter(t => t.escopo === 'pessoal');

      let html = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <div>
            <div style="font-size:15px;font-weight:600">Rotina pessoal</div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px">Tarefas geradas automaticamente para você</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="_openNovaRotina()">+ Adicionar</button>
        </div>`;

      if (templates.length === 0) {
        html += `
          <div class="empty-msg">
            <div class="empty-icon">📋</div>
            Nenhuma rotina criada ainda.<br>
            <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="_openNovaRotina()">Criar primeira rotina</button>
          </div>`;
      } else {
        templates.forEach(t => {
          html += `
            <div class="rotina-item" data-tid="${esc(t.id)}">
              <div class="rotina-body">
                <div class="rotina-titulo">${esc(t.titulo)}</div>
                <div class="rotina-meta">
                  <span class="chip">${esc(fmtFreq(t))}</span>
                  ${t.categoria ? `<span class="chip cat">${esc(t.categoria)}</span>` : ''}
                  ${t.prioridade ? `<span class="chip ${esc(t.prioridade)}">${esc(t.prioridade)}</span>` : ''}
                  ${t.tipo_resultado === 'numero' && t.meta != null ? `<span class="chip numero">meta: ${esc(t.meta)} ${esc(t.unidade || '')}</span>` : ''}
                  ${t.arrasta ? '<span class="chip" style="color:var(--yellow);border-color:rgba(245,158,11,.3)">arrasta</span>' : ''}
                </div>
              </div>
              <button class="tarefa-del" onclick="_deletarTemplate('${esc(t.id)}')" title="Excluir rotina">×</button>
            </div>`;
        });
      }

      root.innerHTML = html;
    } catch (e) {
      root.innerHTML = `<p class="loading-msg" style="color:var(--red)">Erro ao carregar: ${esc(e.message)}</p>`;
    }
  }

  window._deletarTemplate = async function (id) {
    if (!confirm('Excluir esta rotina? As tarefas já geradas não serão excluídas.')) return;
    try {
      await tarefasApi('/api/tarefas/templates/' + id, { method: 'DELETE' });
      toast('Rotina excluída.', 'info');
      loadRotina();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  // ── NOVA ROTINA MODAL ────────────────────────────────────────────────────────
  window._openNovaRotina = function () {
    const modal = document.getElementById('tarefas-modal');
    const bg = document.getElementById('tarefas-modal-bg');
    if (!modal || !bg) return;

    modal.innerHTML = `
      <h2>Nova rotina pessoal</h2>
      <div class="form-row">
        <label class="form-label">Título *</label>
        <input class="form-input" id="rt-titulo" type="text" placeholder="Ex: Ligar para leads do dia" autocomplete="off">
      </div>
      <div class="form-row-2">
        <div>
          <label class="form-label">Frequência *</label>
          <select class="form-select" id="rt-freq" onchange="_onRotinaFreqChange()">
            <option value="">Selecione</option>
            <option value="diaria">Diária</option>
            <option value="semanal">Semanal</option>
            <option value="mensal">Mensal</option>
          </select>
        </div>
        <div>
          <label class="form-label">Prioridade</label>
          <select class="form-select" id="rt-prio">
            <option value="normal">Normal</option>
            <option value="alta">Alta</option>
            <option value="baixa">Baixa</option>
          </select>
        </div>
      </div>

      <div id="rt-dias-wrap" style="display:none" class="form-row">
        <label class="form-label">Dias da semana</label>
        <div class="dias-grid">
          ${DIAS_LABELS.map((d, i) => `
            <label class="dia-btn" id="dia-label-${i}">
              <input type="checkbox" id="rt-dia-${i}" value="${i}" onchange="_toggleDia(${i})"> ${d}
            </label>`).join('')}
        </div>
      </div>

      <div id="rt-diames-wrap" style="display:none" class="form-row">
        <label class="form-label">Dia do mês</label>
        <input class="form-input" id="rt-diames" type="number" min="1" max="31" placeholder="Ex: 1">
      </div>

      <div class="form-row-2">
        <div>
          <label class="form-label">Categoria</label>
          <select class="form-select" id="rt-cat">
            <option value="">Nenhuma</option>
            ${CATEGORIAS.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="form-label">Tipo de resultado</label>
          <select class="form-select" id="rt-tipo" onchange="_onRotinaNumeroChange()">
            <option value="check">Check (feito/não feito)</option>
            <option value="numero">Número (valor numérico)</option>
          </select>
        </div>
      </div>

      <div id="rt-numero-wrap" style="display:none" class="form-row-2">
        <div>
          <label class="form-label">Unidade</label>
          <input class="form-input" id="rt-unidade" type="text" placeholder="Ex: ligações, R$">
        </div>
        <div>
          <label class="form-label">Meta</label>
          <input class="form-input" id="rt-meta" type="number" step="any" placeholder="Ex: 10">
        </div>
      </div>

      <div class="form-row">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
          <input type="checkbox" id="rt-arrasta">
          <span><strong>Arrasta</strong> — se não concluída hoje, aparece amanhã</span>
        </label>
      </div>

      <div class="form-actions">
        <button class="btn btn-ghost" onclick="_closeModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="_salvarRotina()">Criar rotina</button>
      </div>`;

    bg.classList.add('open');
  };

  window._onRotinaFreqChange = function () {
    const freq = document.getElementById('rt-freq').value;
    const diasWrap = document.getElementById('rt-dias-wrap');
    const diamesWrap = document.getElementById('rt-diames-wrap');
    if (diasWrap) diasWrap.style.display = freq === 'semanal' ? '' : 'none';
    if (diamesWrap) diamesWrap.style.display = freq === 'mensal' ? '' : 'none';
  };

  window._onRotinaNumeroChange = function () {
    const tipo = document.getElementById('rt-tipo').value;
    const wrap = document.getElementById('rt-numero-wrap');
    if (wrap) wrap.style.display = tipo === 'numero' ? '' : 'none';
  };

  window._toggleDia = function (i) {
    const label = document.getElementById('dia-label-' + i);
    const cb = document.getElementById('rt-dia-' + i);
    if (label && cb) label.classList.toggle('checked', cb.checked);
  };

  window._salvarRotina = async function () {
    const titulo = (document.getElementById('rt-titulo').value || '').trim();
    const freq = document.getElementById('rt-freq').value;
    const prio = document.getElementById('rt-prio').value;
    const cat = document.getElementById('rt-cat').value;
    const tipo = document.getElementById('rt-tipo').value;
    const arrasta = document.getElementById('rt-arrasta').checked;

    if (!titulo) { toast('Informe o título.', 'warning'); return; }
    if (!freq) { toast('Selecione a frequência.', 'warning'); return; }

    const body = { titulo, escopo: 'pessoal', frequencia: freq, prioridade: prio, arrasta };
    if (cat) body.categoria = cat;
    if (tipo) body.tipo_resultado = tipo;

    if (freq === 'semanal') {
      const dias = [];
      for (let i = 0; i < 7; i++) {
        const cb = document.getElementById('rt-dia-' + i);
        if (cb && cb.checked) dias.push(i);
      }
      if (dias.length === 0) { toast('Selecione ao menos um dia da semana.', 'warning'); return; }
      body.dias_semana = dias;
    }
    if (freq === 'mensal') {
      const dm = parseInt(document.getElementById('rt-diames').value, 10);
      if (!dm || dm < 1 || dm > 31) { toast('Informe o dia do mês (1–31).', 'warning'); return; }
      body.dia_mes = dm;
    }
    if (tipo === 'numero') {
      const un = (document.getElementById('rt-unidade').value || '').trim();
      const mt = parseFloat(document.getElementById('rt-meta').value);
      if (un) body.unidade = un;
      if (!isNaN(mt)) body.meta = mt;
    }

    try {
      await tarefasApi('/api/tarefas/templates', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      toast('Rotina criada!', 'success');
      _closeModal();
      loadRotina();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  // ── NOVA TAREFA FORM (tab) ───────────────────────────────────────────────────
  function renderNovaForm() {
    const root = document.getElementById('nova-root');
    if (!root) return;

    root.innerHTML = `
      <div style="max-width:560px">
        <div style="margin-bottom:20px">
          <div style="font-size:15px;font-weight:600">Nova tarefa pontual</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">Cria uma tarefa avulsa apenas para você</div>
        </div>

        <div class="form-row">
          <label class="form-label">Título *</label>
          <input class="form-input" id="nt-titulo" type="text" placeholder="Ex: Enviar proposta para paciente" autocomplete="off">
        </div>

        <div class="form-row">
          <label class="form-label">Descrição</label>
          <textarea class="form-textarea" id="nt-desc" placeholder="Detalhes opcionais..."></textarea>
        </div>

        <div class="form-row-2">
          <div>
            <label class="form-label">Prioridade</label>
            <select class="form-select" id="nt-prio">
              <option value="normal">Normal</option>
              <option value="alta">Alta</option>
              <option value="baixa">Baixa</option>
            </select>
          </div>
          <div>
            <label class="form-label">Categoria</label>
            <select class="form-select" id="nt-cat">
              <option value="">Nenhuma</option>
              ${CATEGORIAS.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="form-row-2">
          <div>
            <label class="form-label">Prazo (opcional)</label>
            <input class="form-input" id="nt-prazo" type="datetime-local">
          </div>
          <div>
            <label class="form-label">Tipo de resultado</label>
            <select class="form-select" id="nt-tipo" onchange="_onNovaTipoChange()">
              <option value="check">Check (feito/não feito)</option>
              <option value="numero">Número (valor numérico)</option>
            </select>
          </div>
        </div>

        <div id="nt-numero-wrap" style="display:none" class="form-row-2">
          <div>
            <label class="form-label">Unidade</label>
            <input class="form-input" id="nt-unidade" type="text" placeholder="Ex: ligações, R$">
          </div>
          <div>
            <label class="form-label">Meta</label>
            <input class="form-input" id="nt-meta" type="number" step="any" placeholder="Ex: 10">
          </div>
        </div>

        <div class="form-actions" style="justify-content:flex-start">
          <button class="btn btn-primary" onclick="_salvarNovaTarefa()">Criar tarefa</button>
          <button class="btn btn-ghost" onclick="_limparNovaForm()">Limpar</button>
        </div>
      </div>`;
  }

  window._onNovaTipoChange = function () {
    const tipo = document.getElementById('nt-tipo').value;
    const wrap = document.getElementById('nt-numero-wrap');
    if (wrap) wrap.style.display = tipo === 'numero' ? '' : 'none';
  };

  window._salvarNovaTarefa = async function () {
    const titulo = (document.getElementById('nt-titulo').value || '').trim();
    const desc = (document.getElementById('nt-desc').value || '').trim();
    const prio = document.getElementById('nt-prio').value;
    const cat = document.getElementById('nt-cat').value;
    const prazo = document.getElementById('nt-prazo').value;
    const tipo = document.getElementById('nt-tipo').value;

    if (!titulo) { toast('Informe o título.', 'warning'); return; }

    const body = { titulo, prioridade: prio, tipo_resultado: tipo };
    if (desc) body.descricao = desc;
    if (cat) body.categoria = cat;
    if (prazo) body.prazo = new Date(prazo).toISOString();
    if (tipo === 'numero') {
      const un = (document.getElementById('nt-unidade').value || '').trim();
      const mt = parseFloat(document.getElementById('nt-meta').value);
      if (un) body.unidade = un;
      if (!isNaN(mt)) body.meta = mt;
    }

    try {
      await tarefasApi('/api/tarefas', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      toast('Tarefa criada!', 'success');
      _limparNovaForm();
      // muda para aba Hoje
      const btnHoje = document.getElementById('tab-btn-hoje');
      if (btnHoje) btnHoje.click();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  window._limparNovaForm = function () {
    const fields = ['nt-titulo', 'nt-desc', 'nt-prazo', 'nt-unidade', 'nt-meta'];
    fields.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const prio = document.getElementById('nt-prio'); if (prio) prio.value = 'normal';
    const cat = document.getElementById('nt-cat'); if (cat) cat.value = '';
    const tipo = document.getElementById('nt-tipo'); if (tipo) tipo.value = 'check';
    const wrap = document.getElementById('nt-numero-wrap'); if (wrap) wrap.style.display = 'none';
  };

  // ── FECHAR MODAL ─────────────────────────────────────────────────────────────
  window._closeModal = function () {
    const bg = document.getElementById('tarefas-modal-bg');
    if (bg) bg.classList.remove('open');
  };

  // Fechar ao clicar no backdrop
  document.addEventListener('click', function (e) {
    const bg = document.getElementById('tarefas-modal-bg');
    if (e.target === bg) _closeModal();
  });

  // ── INIT ─────────────────────────────────────────────────────────────────────
  function init() {
    initTabs();
    loadHoje();
    renderNovaForm();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
