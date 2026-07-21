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
  const limparCod = n => String(n || '').replace(/^\s*\d{2,}\s*[-–—.]\s*/, '').trim();   // tira o código Clinicorp do nome (só exibição)
  const MSG_SEM_PERMISSAO = 'Você não tem permissão para planejar — peça a alguém com acesso de planejamento.';

  // options do dropdown de executor (lista de nomes — executores ativos do Clinicorp); valor legado texto-livre vira option p/ não se perder
  function optionsExecutor(listaNomes, valor) {
    const nomes = (listaNomes || []).filter(Boolean);
    const v = valor || '';
    if (v && !nomes.includes(v)) nomes.unshift(v);
    return '<option value=""></option>' + nomes.map(n =>
      `<option value="${esc(n)}"${n === v ? ' selected' : ''}>${esc(n)}</option>`).join('');
  }

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

  // mini-diálogo do "✓": data (default hoje) + intenção de anotar na ficha do Clinicorp (gancho do robô)
  function miniDialogoExec(escopo) {
    return new Promise(resolve => {
      let d = document.getElementById('dlg-exec-data');
      if (!d) { d = document.createElement('dialog'); d.id = 'dlg-exec-data'; document.body.appendChild(d); }
      const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
      d.innerHTML = `<h3>Marcar como executado</h3>
        ${escopo ? `<p class="exec-escopo">${esc(escopo)}</p>` : ''}
        <label>Data <input id="ex-data" type="date" value="${hoje}"></label>
        <label><input id="ex-ficha" type="checkbox"> Anotar na ficha do Clinicorp</label>
        <footer><button id="ex-ok" class="btn btn-primario">Confirmar ✓</button>
        <button id="ex-cancel" class="btn btn-ghost">Cancelar</button></footer>`;
      d.onclick = ev => {
        // resolve ANTES do close: se algum engine disparasse 'close' síncrono, o onclose (null) venceria.
        // resolve duplo é no-op — o primeiro ganha.
        if (ev.target.id === 'ex-ok') { resolve({ data: d.querySelector('#ex-data').value || hoje, anotar: d.querySelector('#ex-ficha').checked }); d.close(); }
        if (ev.target.id === 'ex-cancel') { resolve(null); d.close(); }
      };
      d.onclose = () => resolve(null);   // Esc fecha = cancelar
      d.showModal();
    });
  }

  // mini-diálogo do "+ fase externa": select do catálogo + "outra…" (input livre + salvar na lista)
  function dialogoAddFase(catalogo) {
    return new Promise(resolve => {
      let d = document.getElementById('dlg-add-fase');
      if (!d) { d = document.createElement('dialog'); d.id = 'dlg-add-fase'; document.body.appendChild(d); }
      d.innerHTML = `<h3>+ fase externa</h3>
        <label>Fase
          <select id="af-sel">${(catalogo || []).map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}<option value="__outra">outra…</option></select>
        </label>
        <div id="af-outra">
          <label>Nome <input id="af-nome" placeholder="nome da fase"></label>
          <label><input type="checkbox" id="af-salvar"> salvar na lista p/ próxima vez</label>
        </div>
        <footer><button id="af-ok" class="btn btn-primario">Adicionar</button>
        <button id="af-cancel" class="btn btn-ghost">Cancelar</button></footer>`;
      const sel = d.querySelector('#af-sel');
      const bloco = d.querySelector('#af-outra');
      bloco.style.display = sel.value === '__outra' ? '' : 'none';
      d.onchange = ev => {
        if (ev.target.id === 'af-sel') bloco.style.display = sel.value === '__outra' ? '' : 'none';
      };
      d.onclick = ev => {
        if (ev.target.id === 'af-ok') {
          const outra = sel.value === '__outra';
          const nome = (outra ? d.querySelector('#af-nome').value : sel.value).trim();
          if (!nome) { alert('Informe o nome da fase.'); return; }
          resolve({ nome, salvar: outra && d.querySelector('#af-salvar').checked });
          d.close();
        }
        if (ev.target.id === 'af-cancel') { resolve(null); d.close(); }
      };
      d.onclose = () => resolve(null);   // Esc fecha = cancelar
      d.showModal();
    });
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
    let plano, itens, dentistas, padroes, executores, fases_catalogo, pode_planejar;
    try {
      ({ plano, itens, dentistas, padroes, executores, fases_catalogo, pode_planejar } = await api(`/api/planejamento/plano/${id}`));
    } catch (e) {
      if (ehErro403(e)) return alert(MSG_SEM_PERMISSAO);
      return alert(e.message);
    }
    const planejador = pode_planejar !== false;   // default true p/ cache velho (campo ainda não vem no payload)
    const podeExecutar = !['concluido', 'descartado', 'cancelado'].includes(plano.status) && planejador;
    // executores = todos os profissionais ativos do Clinicorp (RPC executores_ativos, 90d de agenda/produção);
    // fallback p/ os nomes de planejamento_dentistas se o servidor ainda não mandar o campo (cache pós-deploy)
    const nomesExec = (executores && executores.length) ? executores : (dentistas || []).map(d => d.profissional_nome);
    const dlg = garantirDialog();
    dlg.innerHTML = `<h2>${esc(plano.paciente_nome)}</h2>
      <p class="espelho">Valor: <b>${fmtBRL(plano.valor)}</b> · Entrada: <b>${fmtBRL(plano.entrada)}</b>
        <small>(espelho do Clinicorp — divergiu? <a href="#" id="lnk-diverg">reportar</a>)</small></p>
      <label>Dentista responsável
        <select id="sel-dentista">${(dentistas || []).map(d =>
          `<option value="${esc(d.user_id)}" ${d.user_id === plano.dentista_avaliador_id ? 'selected' : ''}>${esc(d.profissional_nome)}</option>`).join('')}</select></label>
      <div id="itens">${(itens || []).map(item => `
        <fieldset data-item="${esc(item.id)}"${item.price_id ? ` data-price-id="${esc(item.price_id)}" data-proc-name="${esc(item.procedure_name)}"` : ''}><legend>${esc(limparCod(item.procedure_name))}${item.tipo === 'externo' ? ' 🧪 externa' : ''} × ${esc(item.quantidade)}
            <span class="item-mover"><button type="button" class="mv-up" title="Subir na ordem de execução">▲</button><button type="button" class="mv-down" title="Descer na ordem de execução">▼</button></span></legend>
          <label class="item-exec">Executor <select class="item-prof">${optionsExecutor(nomesExec,item.profissional_executor)}</select></label>
          <ol class="etapas">${(item.plano_etapas || []).sort((a, b) => a.ordem - b.ordem).map(e => {
            const pend = e.status === 'pendente';
            return `
            <li data-etapa="${esc(e.id)}" data-status="${esc(e.status)}"><input class="et-desc" value="${esc(e.descricao)}"${pend ? '' : ' disabled'}>
              <select class="et-prof"${pend ? '' : ' disabled'}>${optionsExecutor(nomesExec,e.profissional_executor)}</select>
              <input class="et-min" type="number" placeholder="min" value="${esc(e.tempo_planejado_min ?? '')}" style="width:70px"${pend ? '' : ' disabled'}> min
              ${pend ? `${podeExecutar ? '<button class="et-exec" title="Marcar executado">✓</button>' : ''}<button class="et-rm">×</button>` : `<em>(${esc(e.status)})</em>`}</li>`; }).join('')}
          </ol>
          ${(item.sublotes || []).map(sl => {
            const ets = (sl.plano_etapas || []).sort((a, b) => a.ordem - b.ordem);
            return ets.length ? `<div class="sublote-bloco"><b>${esc(sl.rotulo || sl.procedure_name || '')}</b><ul class="etapas-filho">${ets.map(e => `
              <li data-etapa-filho="${esc(e.id)}"><span>${esc(e.descricao)}</span> <small>${esc(e.profissional_executor || '')}</small>
                ${e.status === 'pendente' ? (podeExecutar ? '<button class="et-exec-filho" title="Marcar executado">✓</button>' : '') : `<em>(${esc(e.status)})</em>`}</li>`).join('')}</ul></div>` : '';
          }).join('')}
          ${planejador ? '<button class="add-etapa">+ etapa</button> ' : ''}${item.tipo !== 'externo' && planejador ? '<button class="dividir">dividir em sub-lotes</button>' : ''}${podeExecutar ? ' <button class="exec-todos" title="Conclui as etapas SÓ deste procedimento">✓ Executar procedimento</button>' : ''}${planejador ? botoesPadrao(item, padroes) : ''}${item.tipo === 'externo' ? ' <button class="rm-fase">× remover fase</button>' : ''}
        </fieldset>`).join('') || '<p class="vazio">Sem itens de orçamento vinculados.</p>'}</div>
      ${!['descartado', 'cancelado', 'concluido'].includes(plano.status) ? '<button id="bt-add-fase" class="btn btn-ghost">+ fase externa</button>' : ''}
      <label>Orientação clínica (p/ executor)<textarea id="txt-orientacao">${esc(plano.orientacao_clinica || '')}</textarea></label>
      <label>Recado p/ Sucesso do Cliente<textarea id="txt-recado">${esc(plano.recado_sucesso || '')}</textarea></label>
      <footer>${['descartado', 'cancelado'].includes(plano.status)
          ? `<span class="badge">${esc(plano.status)}${plano.status_motivo ? ' · ' + esc(plano.status_motivo) : ''}</span>
             <button id="bt-reativar" class="btn btn-primario">Reativar plano ↩</button>`
          : `${planejador ? `<button id="bt-salvar" class="btn btn-ghost">Salvar rascunho</button>
             <button id="bt-concluir" class="btn btn-primario">Concluir planejamento ✓</button>
             <button id="bt-descartar" class="btn btn-ghost">Não precisa de etapas</button>` : ''}
             <button id="bt-tracker" class="btn btn-ghost" title="Copiar link de acompanhamento do paciente">🔗 link do paciente</button>
             <button id="bt-tracker-regen" class="btn btn-ghost" title="Gera um link novo; o antigo para de funcionar (gestora)">regenerar</button>
             <button id="bt-tracker-revogar" class="btn btn-ghost" title="Mata o link sem emitir outro (gestora)">revogar</button>`}
        <button id="bt-fechar" class="btn btn-ghost">Fechar</button></footer>`;
    dlg.showModal();
    dlg.onchange = ev => {
      if (ev.target.classList && ev.target.classList.contains('item-prof')) {
        // herda p/ etapas VAZIAS do fieldset (não sobrescreve escolha individual)
        ev.target.closest('fieldset').querySelectorAll('select.et-prof:not([disabled])')
          .forEach(s => { if (!s.value) s.value = ev.target.value; });
      }
    };
    const coletar = () => ({
      dentista_avaliador_id: dlg.querySelector('#sel-dentista')?.value,
      orientacao_clinica: dlg.querySelector('#txt-orientacao').value, recado_sucesso: dlg.querySelector('#txt-recado').value,
      itens: [...dlg.querySelectorAll('[data-item]')].map(f => ({
        id: Number(f.dataset.item),
        profissional_executor: f.querySelector('.item-prof')?.value || '',
        sublotes: JSON.parse(f.dataset.sublotes || 'null') || undefined,
        etapas: [...f.querySelectorAll('[data-etapa], li.nova')].map(li => ({
          id: li.dataset.etapa ? Number(li.dataset.etapa) : null, status: li.dataset.status || 'pendente',
          descricao: li.querySelector('.et-desc').value,
          profissional_executor: li.querySelector('.et-prof').value,
          tempo_planejado_min: Number(li.querySelector('.et-min').value) || null })) })),
    });
    const reabrir = () => abrir(id, opts);   // re-render completo com dados frescos
    // alvo: {todos:true, itemId} | {etapaFilhoId} | {itemId, etapaIndex}
    // ⚠️ o pré-PUT deleta e recria TODAS as pendentes (ids novos, ordem = índice na lista enviada) —
    // nunca usar o id do DOM p/ etapa; resolve pós-PUT por (item, ordem == índice-entre-pendentes).
    async function executarFluxo(alvo) {
      const escolha = await miniDialogoExec(alvo.escopo);
      if (!escolha) return;
      await api(`/api/planejamento/plano/${id}`, { method: 'PUT', body: JSON.stringify(coletar()) });   // salvar-antes: nada do modal se perde
      let payload;
      if (alvo.todos) payload = { item_id: alvo.itemId };            // id de item sobrevive ao PUT
      else if (alvo.etapaFilhoId) payload = { etapa_id: alvo.etapaFilhoId };   // filho está fora do coletar(): id sobrevive (salvo re-divisão → cai no 404 amigável)
      else {
        const fresco = await api(`/api/planejamento/plano/${id}`);
        const item = (fresco.itens || []).find(i => i.id === alvo.itemId);
        const acha = lst => (lst || []).find(e => e.status === 'pendente' && e.ordem === alvo.etapaIndex);
        let achada = item ? acha(item.plano_etapas) : null;
        if (!achada && item && (item.sublotes || []).length) achada = acha(item.sublotes[0].plano_etapas);   // dividido nesta sessão: etapas foram pro 1º sub-lote
        if (!achada) { alert('Plano atualizado — clique ✓ novamente.'); return reabrir(); }
        payload = { etapa_id: achada.id };
      }
      try {
        await api(`/api/planejamento/plano/${id}/executar`, { method: 'POST',
          body: JSON.stringify({ ...payload, data: escolha.data, anotar_ficha: escolha.anotar }) });
      } catch (e) {
        if (/não encontrada|nao encontrada|404/i.test(String(e.message || ''))) { alert('Plano atualizado — clique ✓ novamente.'); return reabrir(); }
        throw e;
      }
      if (onSaved) onSaved();   // status do plano pode ter mudado → recarrega a fila/Trilhas atrás do modal
      return reabrir();
    }
    dlg.onclick = async ev => {
      const b = ev.target;
      try {
        if (b.id === 'bt-fechar') dlg.close();
        if (b.id === 'bt-reativar') { await api(`/api/planejamento/plano/${id}/reativar`, { method: 'POST' }); alert('Plano reativado — agora dá pra montar as etapas.'); dlg.close(); if (onSaved) onSaved(); }
        if (b.id === 'bt-add-fase') {
          const escolha = await dialogoAddFase(fases_catalogo);
          if (!escolha) return;
          try {
            await api(`/api/planejamento/plano/${id}/fase-externa`, { method: 'POST',
              body: JSON.stringify({ nome: escolha.nome, salvar_lista: escolha.salvar }) });
            if (onSaved) onSaved();   // status do plano pode ter mudado
            return reabrir();
          } catch (e2) { alert(e2.message); }
        }
        if (b.classList.contains('rm-fase')) {
          const fs = b.closest('fieldset[data-item]');
          if (!confirm('Remover esta fase externa?')) return;
          try {
            await api(`/api/planejamento/plano/${id}/fase-externa/${fs.dataset.item}/remover`, { method: 'POST' });
            if (onSaved) onSaved();   // status do plano pode ter mudado (ex.: era a última fase pendente → concluiu)
            return reabrir();
          } catch (e2) { alert(e2.message); }
        }
        if (b.classList.contains('mv-up')) {
          const fs = b.closest('fieldset[data-item]');
          const prev = fs && fs.previousElementSibling;
          if (prev && prev.matches('fieldset[data-item]')) fs.parentNode.insertBefore(fs, prev);
        }
        if (b.classList.contains('mv-down')) {
          const fs = b.closest('fieldset[data-item]');
          const next = fs && fs.nextElementSibling;
          if (next && next.matches('fieldset[data-item]')) fs.parentNode.insertBefore(next, fs);
        }
        if (b.classList.contains('add-etapa')) { const fs = b.closest('fieldset'); fs.querySelector('.etapas').insertAdjacentHTML('beforeend',
          `<li class="nova"><input class="et-desc" placeholder="descrição"><select class="et-prof">${optionsExecutor(nomesExec,fs.querySelector('.item-prof')?.value || '')}</select><input class="et-min" type="number" style="width:70px"> min ${podeExecutar ? '<button class="et-exec" title="Marcar executado">✓</button>' : ''}<button class="et-rm">×</button></li>`); atualizarSalvarPadrao(fs); }
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
                `<li class="nova"><input class="et-desc" placeholder="descrição" value="${esc(e.descricao || '')}"><select class="et-prof">${optionsExecutor(nomesExec,e.profissional_sugerido || '')}</select><input class="et-min" type="number" style="width:70px" value="${esc(e.tempo_sugerido_min ?? '')}"> min ${podeExecutar ? '<button class="et-exec" title="Marcar executado">✓</button>' : ''}<button class="et-rm">×</button></li>`).join(''));
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
        if (b.id === 'bt-tracker' || b.id === 'bt-tracker-regen' || b.id === 'bt-tracker-revogar') {
          const acao = b.id === 'bt-tracker-regen' ? 'regenerar' : (b.id === 'bt-tracker-revogar' ? 'revogar' : null);
          if (acao && !confirm('O link atual vai parar de funcionar. Continuar?')) return;
          try {
            const r = await api(`/api/planejamento/plano/${id}/tracker-link`, { method: 'POST', body: JSON.stringify(acao ? { acao } : {}) });
            if (r.revogado) alert('Link revogado — o paciente não acessa mais.');
            else { try { await navigator.clipboard.writeText(r.url); alert('Link copiado — cole no WhatsApp do paciente.'); } catch { prompt('Copie o link:', r.url); } }
          } catch (e2) { alert(e2.message); }
          return;
        }
        if (b.classList.contains('exec-todos')) {
          const fs = b.closest('fieldset');
          const nome = limparCod(fs.dataset.procName) || (fs.querySelector('legend')?.textContent || '').split('×')[0].trim();
          const nPend = [...fs.querySelectorAll('.etapas li')].filter(x => x.classList.contains('nova') || x.dataset.status === 'pendente').length
            + fs.querySelectorAll('.etapas-filho .et-exec-filho').length;
          const escopo = nPend
            ? `Só o procedimento "${nome}" (${nPend} etapa(s) pendente(s)). Os demais procedimentos NÃO são afetados.`
            : `Só o procedimento "${nome}" (sem etapas — será marcado como realizado). Os demais procedimentos NÃO são afetados.`;
          await executarFluxo({ todos: true, itemId: Number(fs.dataset.item), escopo });
        }
        if (b.classList.contains('et-exec-filho')) {
          const li = b.closest('li');
          await executarFluxo({ etapaFilhoId: Number(li.dataset.etapaFilho), escopo: `Só a etapa "${(li.querySelector('span')?.textContent || '').trim()}".` });
        }
        if (b.classList.contains('et-exec')) {
          const fs = b.closest('fieldset'); const li = b.closest('li');
          // índice ENTRE PENDENTES/NOVAS (mesmo predicado do filtro do PUT) — concluídas e filhos NÃO contam
          const pendentes = [...fs.querySelectorAll('.etapas li')].filter(x => x.classList.contains('nova') || x.dataset.status === 'pendente');
          const nome = limparCod(fs.dataset.procName) || (fs.querySelector('legend')?.textContent || '').split('×')[0].trim();
          await executarFluxo({ itemId: Number(fs.dataset.item), etapaIndex: pendentes.indexOf(li),
            escopo: `Só a etapa "${(li.querySelector('.et-desc')?.value || '').trim()}" de "${nome}".` });
        }
      } catch (e) {
        if (ehErro403(e)) alert(MSG_SEM_PERMISSAO); else alert(e.message);
      }
    };
  }

  window.PlanejamentoEditor = { abrir };
})();
