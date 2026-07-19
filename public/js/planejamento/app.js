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

  async function abrirPlano(id) {
    const { plano, itens, dentistas } = await api(`/api/planejamento/plano/${id}`);
    const dlg = $('#dlg-plano');
    dlg.innerHTML = `<h2>${esc(plano.paciente_nome)}</h2>
      <p class="espelho">Valor: <b>${fmtBRL(plano.valor)}</b> · Entrada: <b>${fmtBRL(plano.entrada)}</b>
        <small>(espelho do Clinicorp — divergiu? <a href="#" id="lnk-diverg">reportar</a>)</small></p>
      <label>Dentista responsável
        <select id="sel-dentista">${dentistas.map(d =>
          `<option value="${esc(d.user_id)}" ${d.user_id === plano.dentista_avaliador_id ? 'selected' : ''}>${esc(d.profissional_nome)}</option>`).join('')}</select></label>
      <div id="itens">${itens.map(item => `
        <fieldset data-item="${esc(item.id)}"><legend>${esc(item.procedure_name)} × ${esc(item.quantidade)}</legend>
          <ol class="etapas">${(item.plano_etapas || []).sort((a, b) => a.ordem - b.ordem).map(e => `
            <li data-etapa="${esc(e.id)}" data-status="${esc(e.status)}"><input class="et-desc" value="${esc(e.descricao)}">
              <input class="et-prof" placeholder="executor" value="${esc(e.profissional_executor || '')}">
              <input class="et-min" type="number" placeholder="min" value="${esc(e.tempo_planejado_min ?? '')}" style="width:70px"> min
              ${e.status !== 'pendente' ? `<em>(${esc(e.status)})</em>` : '<button class="et-rm">×</button>'}</li>`).join('')}
          </ol>
          <button class="add-etapa">+ etapa</button> <button class="dividir">dividir em sub-lotes</button>
        </fieldset>`).join('')}</div>
      <label>Orientação clínica (p/ executor)<textarea id="txt-orientacao">${esc(plano.orientacao_clinica || '')}</textarea></label>
      <label>Recado p/ Sucesso do Cliente<textarea id="txt-recado">${esc(plano.recado_sucesso || '')}</textarea></label>
      <footer><button id="bt-salvar" class="btn btn-ghost">Salvar rascunho</button>
        <button id="bt-concluir" class="btn btn-primario">Concluir planejamento ✓</button>
        <button id="bt-descartar" class="btn btn-ghost">Não precisa de etapas</button>
        <button id="bt-fechar" class="btn btn-ghost">Fechar</button></footer>`;
    dlg.showModal();
    const coletar = () => ({
      dentista_avaliador_id: $('#sel-dentista').value,
      orientacao_clinica: $('#txt-orientacao').value, recado_sucesso: $('#txt-recado').value,
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
        if (b.classList.contains('add-etapa')) b.closest('fieldset').querySelector('.etapas').insertAdjacentHTML('beforeend',
          `<li class="nova"><input class="et-desc" placeholder="descrição"><input class="et-prof" placeholder="executor"><input class="et-min" type="number" style="width:70px"> min <button class="et-rm">×</button></li>`);
        if (b.classList.contains('et-rm')) b.closest('li').remove();
        if (b.classList.contains('dividir')) dividirSubLotes(b.closest('fieldset'));
        if (b.id === 'lnk-diverg') { ev.preventDefault(); const t = prompt('Descreva a divergência (será corrigida NO Clinicorp):'); if (t) { await api(`/api/planejamento/plano/${id}/divergencia`, { method: 'POST', body: JSON.stringify({ texto: t }) }); alert('Reportada — a CRC corrige no Clinicorp e o sync atualiza o espelho.'); } }
        if (b.id === 'bt-salvar') { await api(`/api/planejamento/plano/${id}`, { method: 'PUT', body: JSON.stringify(coletar()) }); alert('Salvo.'); }
        if (b.id === 'bt-concluir') { await api(`/api/planejamento/plano/${id}`, { method: 'PUT', body: JSON.stringify(coletar()) }); await api(`/api/planejamento/plano/${id}/concluir`, { method: 'POST' }); dlg.close(); carregarFila(); }
        if (b.id === 'bt-descartar') { if (confirm('Este tratamento não precisa de etapas? (o paciente CONTINUA na Sucesso)')) { await api(`/api/planejamento/plano/${id}/descartar`, { method: 'POST' }); dlg.close(); carregarFila(); } }
      } catch (e) { alert(e.message); }
    };
  }

  function dividirSubLotes(fieldset) {
    const qtd = prompt('Quantidades separadas por vírgula (ex.: 4,2) — a soma deve bater com o total:');
    if (!qtd) return;
    const partes = qtd.split(',').map(n => Number(n.trim())).filter(n => n >= 1);
    fieldset.dataset.sublotes = JSON.stringify(partes.map((quantidade, i) => ({ quantidade, rotulo: `Sub-lote ${i + 1}` })));
    fieldset.querySelector('legend').insertAdjacentHTML('beforeend', ` <em>(dividido: ${esc(partes.join(' + '))})</em>`);
    // as etapas atuais valem para o 1º sub-lote; o PUT recria conforme a spec (validação de conservação no servidor)
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
