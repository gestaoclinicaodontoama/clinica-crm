// /js/planejamento/editor.js — modal compartilhado "Planejar" (editor de plano de tratamento).
// Extraído de /js/planejamento/app.js p/ ser reusado por /planejamento/ (dentista/gestor) e
// /trilhas/ (Sucesso do Cliente — leitura liberada, salvar dá 403 amigável p/ quem não tem
// role de planejamento). Não guarda token/estado próprio: recebe api()/onSaved() de quem chama.
(() => {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const fmtBRL = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const MSG_SEM_PERMISSAO = 'Você não tem permissão para planejar — peça a alguém com acesso de planejamento.';

  function ehErro403(e) {
    return e && (e.status === 403 || /403|acesso negado|sem permiss/i.test(String(e.message || '')));
  }

  function garantirDialog() {
    let dlg = document.getElementById('dlg-plano-editor');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'dlg-plano-editor';
      document.body.appendChild(dlg);
    }
    return dlg;
  }

  // botões do banco de processos (só em itens com price_id — sub-lotes não têm fieldset próprio)
  function botoesPadrao(item, padroes) {
    if (!item.price_id) return '';
    const padrao = (padroes || []).find(p => String(p.price_id) === String(item.price_id));
    const temEtapas = (item.plano_etapas || []).length > 0;
    return ` <button class="aplicar-padrao btn-ghost"${padrao ? '' : ' disabled title="nenhum padrão cadastrado para este procedimento"'}>⚡ Aplicar padrão</button>
      <button class="salvar-padrao btn-ghost"${temEtapas ? '' : ' disabled title="monte as etapas primeiro"'}>💾 Salvar como padrão</button>`;
  }

  function atualizarSalvarPadrao(fieldset) {
    const bt = fieldset && fieldset.querySelector('.salvar-padrao');
    if (!bt) return;
    const tem = fieldset.querySelectorAll('.etapas li').length > 0;
    bt.disabled = !tem;
    bt.title = tem ? '' : 'monte as etapas primeiro';
  }

  function dividirSubLotes(fieldset) {
    const qtd = prompt('Quantidades separadas por vírgula (ex.: 4,2) — a soma deve bater com o total:');
    if (!qtd) return;
    const partes = qtd.split(',').map(n => Number(n.trim())).filter(n => n >= 1);
    fieldset.dataset.sublotes = JSON.stringify(partes.map((quantidade, i) => ({ quantidade, rotulo: `Sub-lote ${i + 1}` })));
    fieldset.querySelector('legend').insertAdjacentHTML('beforeend', ` <em>(dividido: ${esc(partes.join(' + '))})</em>`);
    // as etapas atuais valem para o 1º sub-lote; o PUT recria conforme a spec (validação de conservação no servidor)
  }

  /**
   * Abre o editor de plano.
   * @param {number|string} id
   * @param {object} opts
   * @param {function(string, object=): Promise<any>} opts.api - fetch autenticado (lança Error c/ .message em falha)
   * @param {function():void} [opts.onSaved] - chamado após concluir/descartar (ex.: recarregar a fila)
   */
  async function abrir(id, opts) {
    const { api, onSaved } = opts || {};
    if (typeof api !== 'function') throw new Error('editor: api() é obrigatório');
    let plano, itens, dentistas, padroes;
    try {
      ({ plano, itens, dentistas, padroes } = await api(`/api/planejamento/plano/${id}`));
    } catch (e) {
      if (ehErro403(e)) return alert(MSG_SEM_PERMISSAO);
      return alert(e.message);
    }
    const dlg = garantirDialog();
    dlg.innerHTML = `<h2>${esc(plano.paciente_nome)}</h2>
      <p class="espelho">Valor: <b>${fmtBRL(plano.valor)}</b> · Entrada: <b>${fmtBRL(plano.entrada)}</b>
        <small>(espelho do Clinicorp — divergiu? <a href="#" id="lnk-diverg">reportar</a>)</small></p>
      <label>Dentista responsável
        <select id="sel-dentista">${(dentistas || []).map(d =>
          `<option value="${esc(d.user_id)}" ${d.user_id === plano.dentista_avaliador_id ? 'selected' : ''}>${esc(d.profissional_nome)}</option>`).join('')}</select></label>
      <div id="itens">${(itens || []).map(item => `
        <fieldset data-item="${esc(item.id)}"${item.price_id ? ` data-price-id="${esc(item.price_id)}" data-proc-name="${esc(item.procedure_name)}"` : ''}><legend>${esc(item.procedure_name)} × ${esc(item.quantidade)}</legend>
          <ol class="etapas">${(item.plano_etapas || []).sort((a, b) => a.ordem - b.ordem).map(e => `
            <li data-etapa="${esc(e.id)}" data-status="${esc(e.status)}"><input class="et-desc" value="${esc(e.descricao)}">
              <input class="et-prof" placeholder="executor" value="${esc(e.profissional_executor || '')}">
              <input class="et-min" type="number" placeholder="min" value="${esc(e.tempo_planejado_min ?? '')}" style="width:70px"> min
              ${e.status !== 'pendente' ? `<em>(${esc(e.status)})</em>` : '<button class="et-rm">×</button>'}</li>`).join('')}
          </ol>
          <button class="add-etapa">+ etapa</button> <button class="dividir">dividir em sub-lotes</button>${botoesPadrao(item, padroes)}
        </fieldset>`).join('') || '<p class="vazio">Sem itens de orçamento vinculados.</p>'}</div>
      <label>Orientação clínica (p/ executor)<textarea id="txt-orientacao">${esc(plano.orientacao_clinica || '')}</textarea></label>
      <label>Recado p/ Sucesso do Cliente<textarea id="txt-recado">${esc(plano.recado_sucesso || '')}</textarea></label>
      <footer>${['descartado', 'cancelado'].includes(plano.status)
          ? `<span class="badge">${esc(plano.status)}${plano.status_motivo ? ' · ' + esc(plano.status_motivo) : ''}</span>
             <button id="bt-reativar" class="btn btn-primario">Reativar plano ↩</button>`
          : `<button id="bt-salvar" class="btn btn-ghost">Salvar rascunho</button>
             <button id="bt-concluir" class="btn btn-primario">Concluir planejamento ✓</button>
             <button id="bt-descartar" class="btn btn-ghost">Não precisa de etapas</button>`}
        <button id="bt-fechar" class="btn btn-ghost">Fechar</button></footer>`;
    dlg.showModal();
    const coletar = () => ({
      dentista_avaliador_id: dlg.querySelector('#sel-dentista')?.value,
      orientacao_clinica: dlg.querySelector('#txt-orientacao').value, recado_sucesso: dlg.querySelector('#txt-recado').value,
      itens: [...dlg.querySelectorAll('[data-item]')].map(f => ({
        id: Number(f.dataset.item),
        sublotes: JSON.parse(f.dataset.sublotes || 'null') || undefined,
        etapas: [...f.querySelectorAll('[data-etapa], li.nova')].map(li => ({
          id: li.dataset.etapa ? Number(li.dataset.etapa) : null, status: li.dataset.status || 'pendente',
          descricao: li.querySelector('.et-desc').value,
          profissional_executor: li.querySelector('.et-prof').value,
          tempo_planejado_min: Number(li.querySelector('.et-min').value) || null })) })),
    });
    dlg.onclick = async ev => {
      const b = ev.target;
      try {
        if (b.id === 'bt-fechar') dlg.close();
        if (b.id === 'bt-reativar') { await api(`/api/planejamento/plano/${id}/reativar`, { method: 'POST' }); alert('Plano reativado — agora dá pra montar as etapas.'); dlg.close(); if (onSaved) onSaved(); }
        if (b.classList.contains('add-etapa')) { const fs = b.closest('fieldset'); fs.querySelector('.etapas').insertAdjacentHTML('beforeend',
          `<li class="nova"><input class="et-desc" placeholder="descrição"><input class="et-prof" placeholder="executor"><input class="et-min" type="number" style="width:70px"> min <button class="et-rm">×</button></li>`); atualizarSalvarPadrao(fs); }
        if (b.classList.contains('et-rm')) { const fs = b.closest('fieldset'); b.closest('li').remove(); atualizarSalvarPadrao(fs); }
        if (b.classList.contains('dividir')) dividirSubLotes(b.closest('fieldset'));
        if (b.classList.contains('aplicar-padrao')) {
          const fs = b.closest('fieldset');
          const padrao = (padroes || []).find(p => String(p.price_id) === String(fs.dataset.priceId));
          if (padrao) {
            const ol = fs.querySelector('.etapas');
            const pendentes = [...ol.querySelectorAll('li')].filter(li => li.classList.contains('nova') || li.dataset.status === 'pendente');
            if (!pendentes.length || confirm(`Substituir as etapas pendentes pelas do padrão "${padrao.procedure_name}"?`)) {
              pendentes.forEach(li => li.remove());
              ol.insertAdjacentHTML('beforeend', (padrao.etapas || []).map(e =>
                `<li class="nova"><input class="et-desc" placeholder="descrição" value="${esc(e.descricao || '')}"><input class="et-prof" placeholder="executor" value="${esc(e.profissional_sugerido || '')}"><input class="et-min" type="number" style="width:70px" value="${esc(e.tempo_sugerido_min ?? '')}"> min <button class="et-rm">×</button></li>`).join(''));
              atualizarSalvarPadrao(fs);
            }
          }
        }
        if (b.classList.contains('salvar-padrao')) {
          const fs = b.closest('fieldset');
          const etapas = [...fs.querySelectorAll('.etapas li')].map(li => ({
            descricao: li.querySelector('.et-desc').value,
            profissional_sugerido: li.querySelector('.et-prof').value,
            tempo_sugerido_min: Number(li.querySelector('.et-min').value) || null }));
          await api('/api/planejamento/padroes', { method: 'POST', body: JSON.stringify({
            price_id: fs.dataset.priceId, procedure_name: fs.dataset.procName, etapas }) });
          alert('Padrão salvo como rascunho — a gestora aprova em seguida. Na próxima vez, este procedimento já vem preenchido.');
        }
        if (b.id === 'lnk-diverg') { ev.preventDefault(); const t = prompt('Descreva a divergência (será corrigida NO Clinicorp):'); if (t) { await api(`/api/planejamento/plano/${id}/divergencia`, { method: 'POST', body: JSON.stringify({ texto: t }) }); alert('Reportada — a CRC corrige no Clinicorp e o sync atualiza o espelho.'); } }
        if (b.id === 'bt-salvar') { await api(`/api/planejamento/plano/${id}`, { method: 'PUT', body: JSON.stringify(coletar()) }); alert('Salvo.'); }
        if (b.id === 'bt-concluir') { await api(`/api/planejamento/plano/${id}`, { method: 'PUT', body: JSON.stringify(coletar()) }); await api(`/api/planejamento/plano/${id}/concluir`, { method: 'POST' }); dlg.close(); if (onSaved) onSaved(); }
        if (b.id === 'bt-descartar') { if (confirm('Este tratamento não precisa de etapas? (o paciente CONTINUA na Sucesso)')) { await api(`/api/planejamento/plano/${id}/descartar`, { method: 'POST' }); dlg.close(); if (onSaved) onSaved(); } }
      } catch (e) {
        if (ehErro403(e)) alert(MSG_SEM_PERMISSAO); else alert(e.message);
      }
    };
  }

  window.PlanejamentoEditor = { abrir };
})();
