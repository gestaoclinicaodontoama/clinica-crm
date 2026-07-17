// public/js/pesquisa-satisfacao/main.js
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = id => document.getElementById(id);
  const fmtData = iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const fmtNota = n => n == null ? '—' : (Math.round(n * 10) / 10).toLocaleString('pt-BR');
  const ORIGEM_LBL = { tratamento: 'Tratamento', avaliacao: 'Avaliação' };
  const STATUS_LBL = { enviado: 'Enviado', respondido: 'Respondido', falhou: 'Falhou' };

  function hojeISO() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  }
  function inicioMesISO() {
    return hojeISO().slice(0, 8) + '01';
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3500);
  }

  function renderCards(resumo) {
    const taxaPct = resumo.taxa == null ? '—' : Math.round(resumo.taxa * 100) + '%';
    const m = resumo.medias || {};
    $('cards').innerHTML = `
      <div class="card"><div class="num">${esc(fmtNota(resumo.nps_media))}</div><div class="lbl">Nota de recomendação (0–10)</div></div>
      <div class="card"><div class="num">${esc(taxaPct)}</div><div class="lbl">Taxa de resposta</div></div>
      <div class="card"><div class="num">${esc(resumo.enviadas ?? 0)}</div><div class="lbl">Pesquisas enviadas</div></div>
      <div class="card"><div class="num">${esc(resumo.respondidas ?? 0)}</div><div class="lbl">Pesquisas respondidas</div></div>
      <div class="card falhas"><div class="num">${esc(resumo.falhas ?? 0)}</div><div class="lbl">Falhas de envio</div></div>
      <div class="card"><div class="num">${esc(fmtNota(m.recepcao))}</div><div class="lbl">Recepção (1–5)</div></div>
      <div class="card"><div class="num">${esc(fmtNota(m.dentista))}</div><div class="lbl">Dentista (1–5)</div></div>
      <div class="card"><div class="num">${esc(fmtNota(m.espera))}</div><div class="lbl">Tempo de espera (1–5)</div></div>
      <div class="card"><div class="num">${esc(fmtNota(m.limpeza))}</div><div class="lbl">Limpeza (1–5)</div></div>
      <div class="card"><div class="num">${esc(fmtNota(m.explicacoes))}</div><div class="lbl">Explicações (1–5)</div></div>
    `;
  }

  function notasCell(item) {
    if (item.status !== 'respondido') return '<span class="notas">—</span>';
    const partes = [
      item.nps != null ? ('NPS ' + item.nps) : null,
      item.avaliacao_recepcao != null ? ('Recep. ' + item.avaliacao_recepcao) : null,
      item.avaliacao_dentista != null ? ('Dentista ' + item.avaliacao_dentista) : null,
      item.avaliacao_espera != null ? ('Espera ' + item.avaliacao_espera) : null,
      item.avaliacao_limpeza != null ? ('Limpeza ' + item.avaliacao_limpeza) : null,
      item.avaliacao_explicacoes != null ? ('Explic. ' + item.avaliacao_explicacoes) : null,
    ].filter(Boolean);
    return '<span class="notas">' + esc(partes.join(' · ')) + '</span>';
  }

  function renderTabela(itens) {
    const tab = $('tabela');
    if (!itens || !itens.length) {
      tab.innerHTML = '<tr><td class="estado">Nenhuma pesquisa no período</td></tr>';
      return;
    }
    let h = '<tr><th>Data</th><th>Paciente</th><th>Dentista</th><th>Origem</th><th>Status</th><th>Notas</th><th>Comentário</th></tr>';
    for (const it of itens) {
      const data = it.respondido_em || it.enviado_em;
      const comentario = it.comentario ? esc(it.comentario) : '—';
      h += `<tr>
        <td>${esc(fmtData(data))}</td>
        <td>${esc(it.paciente_nome || '—')}</td>
        <td>${esc(it.dentista_nome || '—')}</td>
        <td>${esc(ORIGEM_LBL[it.origem] || it.origem || '—')}</td>
        <td><span class="pill ${esc(it.status)}">${esc(STATUS_LBL[it.status] || it.status)}</span></td>
        <td>${notasCell(it)}</td>
        <td class="comentario" title="Clique para expandir" onclick="this.classList.toggle('aberto')">${comentario}</td>
      </tr>`;
    }
    tab.innerHTML = h;
  }

  async function carregar() {
    const from = $('f-from').value || inicioMesISO();
    const to = $('f-to').value || hojeISO();
    $('sub').textContent = 'carregando…';
    $('tabela').innerHTML = '<tr><td class="estado">carregando…</td></tr>';
    try {
      const d = await window.PesquisaSatisfacaoAPI.listarPesquisas(from, to);
      renderCards(d.resumo || {});
      renderTabela(d.itens || []);
      $('sub').textContent = 'período ' + esc(d.periodo?.from || from) + ' a ' + esc(d.periodo?.to || to);
    } catch (e) {
      $('sub').innerHTML = '<span class="erro">Erro ao carregar: ' + esc(e.message) + '</span> '
        + '<button class="btn" id="btn-retry" style="margin-left:8px">Tentar de novo</button>';
      $('tabela').innerHTML = '<tr><td class="estado erro">Não foi possível carregar as pesquisas.</td></tr>';
      const retry = $('btn-retry');
      if (retry) retry.onclick = carregar;
    }
  }

  function initFiltros() {
    $('f-from').value = inicioMesISO();
    $('f-to').value = hojeISO();
    $('btn-filtrar').onclick = carregar;
  }

  function initDisparo() {
    const btn = $('btn-disparar');
    btn.onclick = async () => {
      if (!confirm('Disparar as pesquisas de satisfação de hoje agora? O envio roda em segundo plano.')) return;
      btn.disabled = true;
      const txt = btn.textContent;
      btn.textContent = 'Disparando…';
      try {
        const r = await window.PesquisaSatisfacaoAPI.dispararHoje();
        toast(r.mensagem || 'Disparo iniciado');
      } catch (e) {
        if (String(e.message).includes('409') || /já em execução/i.test(e.message)) {
          toast('Já existe um disparo em execução.');
        } else {
          toast('Erro: ' + e.message);
        }
      } finally {
        btn.disabled = false;
        btn.textContent = txt;
      }
    };
  }

  initFiltros();
  initDisparo();
  carregar();
})();
