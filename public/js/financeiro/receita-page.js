// Página Análise de Receita — lê /api/analise-receita e renderiza os 6 blocos.
// Sem sigla financeira na cópia (regra do Luiz) — tudo por extenso.
(function () {
  const $ = (id) => document.getElementById(id);
  const fmt = (v) => v == null ? '—' :
    'R$ ' + Math.round(v).toLocaleString('pt-BR');
  const pct = (v) => v == null ? '—' :
    (v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + '%';
  const MESES_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const rotulo = (ym) => MESES_PT[Number(ym.slice(5, 7)) - 1] + '/' + ym.slice(2, 4);
  const ymAtual = new Date().toISOString().slice(0, 7);
  let charts = {};
  const cores = () => {
    const s = getComputedStyle(document.documentElement);
    return { accent: s.getPropertyValue('--accent').trim(), green: s.getPropertyValue('--green').trim(),
      yellow: s.getPropertyValue('--yellow').trim(), red: s.getPropertyValue('--red').trim(),
      muted: s.getPropertyValue('--muted').trim(), text: s.getPropertyValue('--text').trim() };
  };
  const escala = (c) => ({ x: { ticks: { color: c.muted } }, y: { ticks: { color: c.muted,
    callback: (v) => 'R$ ' + (v / 1000).toLocaleString('pt-BR') + 'k' } } });
  const novoChart = (id, cfg) => {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart($(id), cfg);
  };
  // Retry 5xx: 2 tentativas extra (1,5s / 3s) — padrão das páginas principais.
  async function comRetry(fn) {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) {
        const retriavel = e.status == null || e.status >= 500;
        if (!retriavel || i >= 2) throw e;
        await new Promise(r => setTimeout(r, i === 0 ? 1500 : 3000));
      }
    }
  }

  function renderSintese(d, c) {
    const prev = d.mesCorrente?.recorrentePrevisto;
    const r = d.reguas || {};
    const barra = (idBar, idRot, regua) => {
      const p = (regua > 0 && prev != null) ? prev / regua : null;
      $(idBar).style.width = p == null ? '0%' : Math.min(100, p * 100) + '%';
      $(idRot).textContent = p == null ? 'réguas indisponíveis'
        : `${pct(p)} (${fmt(prev)} de ${fmt(regua)})`;
      return p;
    };
    barra('deg1-bar', 'deg1-rot', r.fixas);
    const p2 = barra('deg2-bar', 'deg2-rot', r.saidaTotal);
    $('sintese-num').textContent = p2 == null ? '—' :
      `${rotulo(ymAtual)} nasceu ${pct(p2)} pago`;
    $('sintese-entenda').textContent =
      `Base recorrente prevista para o mês: ${fmt(d.mesCorrente?.recorrenteCru)} contratados × ` +
      `${pct(d.realizacao?.geral?.taxa)} de realização histórica = ${fmt(prev)}. ` +
      `Réguas = médias dos últimos ${r.nMeses || 0} meses fechados: fixas ${fmt(r.fixas)}, ` +
      `saída total ${fmt(r.saidaTotal)}. Quanto maior a fatia do mês que o recorrente cobre ` +
      `sozinho, menos o resultado depende de vender naquele mês.`;
  }

  function renderCalculadora(d) {
    const mi = d.metaInputs || {}, m = d.meta || {};
    $('calc-fat').value = mi.metaFaturamento ?? '';
    if (mi.lucroPct != null) { $('calc-lucro-modo').value = 'pct'; $('calc-lucro').value = Math.round(mi.lucroPct * 1000) / 10; }
    else { $('calc-lucro-modo').value = 'reais'; $('calc-lucro').value = mi.lucroReais ?? ''; }
    $('calc-receb').value = mi.recebiveisLiquidos ?? '';
    $('calc-pagar').value = mi.contasAPagar ?? '';
    const det = mi.detalhe || {};
    $('calc-receb-det').textContent = `medido: ${fmt(det.recorrenteCru)} contratados × ${pct(det.taxa)} de realização + convênio ${fmt(det.convenio)}`;
    $('calc-pagar-det').textContent = `medido: média das saídas dos últimos 6 meses (${fmt(mi.defaults?.pagar)})`;
    if (m.erro) { $('calc-resultados').innerHTML = `<div class="meta-linha"><span>${m.erro === 'contas a pagar indisponiveis' ? 'Contas a pagar indisponíveis — a DRE precisa de meses fechados.' : m.erro}</span></div>`; return; }
    const linha = (rot, v) => `<div class="meta-linha"><span>${rot}</span><b>${v}</b></div>`;
    const pctFat = (a) => a.pctFat != null ? ` (${pct(a.pctFat)} da meta de faturamento)` : '';
    let html = '<div class="calc-res">';
    html += `<div class="meta-destaque">Empatar o mês</div>`;
    html += linha('Entrada mínima', fmt(m.breakEven.entrada) + pctFat(m.breakEven));
    if (m.comLucro) {
      html += `<div class="meta-destaque">Com o lucro desejado</div>`;
      html += linha('Caixa total necessário', fmt(m.comLucro.fluxoNecessario));
      html += linha('Lucro projetado', fmt(m.comLucro.lucroProjetado));
      html += linha('Entrada necessária', fmt(m.comLucro.entrada) + pctFat(m.comLucro));
    }
    const p = m.progresso || {};
    html += `<div class="meta-destaque">Andamento do mês</div>`;
    html += linha('Entrada já recebida', fmt(d.mesCorrente?.entradaRecebida));
    html += p.batida ? linha('Situação', '<span style="color:var(--green)">✅ meta de entrada batida</span>')
      : linha('Faltam', fmt(p.restante) +
          (p.vendasNecessarias != null ? ` · ≈ ${fmt(p.vendasNecessarias)} em vendas` : '') +
          (p.fechamentos != null ? ` · ~${p.fechamentos} fechamentos` : '') +
          ` · ${(d.diasUteisRestantes ?? '—').toLocaleString('pt-BR')} dias úteis`);
    if (m.viabilidade) {
      const t = { confortavel: '🟢 Confortável', justo: '🟡 Justo', apertado: '🔴 Apertado' }[m.viabilidade.status];
      html += `<div class="verd ${m.viabilidade.status}">${t}: você precisa que ${pct(m.viabilidade.necessarioPct)} do faturamento vire entrada — historicamente ${pct(m.viabilidade.historicoPct)} vira.` +
        (m.viabilidade.status === 'apertado' ? ' Venda acima da meta, negocie entradas maiores ou aceite lucro menor.' : '') + `</div>`;
    }
    $('calc-resultados').innerHTML = html + '</div>';
  }

  function renderSafras(d) {
    const arr = d.safra || [];
    const mesTxt = (v) => v == null ? '—' : v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + 'm';
    $('safra-contratado').innerHTML =
      '<thead><tr><th>Safra</th><th>Aprovado</th><th>Prazo contratado</th></tr></thead><tbody>' +
      arr.map(s => `<tr><td>${rotulo(s.safra)}</td><td>${fmt(s.aprovado)}</td><td>${mesTxt(s.prazoContratado)}</td></tr>`).join('') + '</tbody>';
    $('safra-real').innerHTML =
      '<thead><tr><th>Safra</th><th>Contratado</th><th>Real até agora</th><th>% recebido</th></tr></thead><tbody>' +
      arr.map(s => `<tr class="${s.emCurso ? 'em-curso' : ''}"><td>${rotulo(s.safra)}${s.emCurso ? ' *' : ''}</td>` +
        `<td>${mesTxt(s.prazoContratado)}</td><td>${mesTxt(s.prazoReal)}</td><td>${pct(s.pctRecebido)}</td></tr>`).join('') +
      '</tbody><tfoot><tr><td colspan="4" style="font-size:11px;color:var(--muted);text-align:left">* em curso — prazo real ainda provisório</td></tr></tfoot>';
  }

  function renderCurvaSafra(d) {
    const cs = d.curvaSafra || [];
    const el = $('safra-curva');
    if (!el) return;
    if (!cs.length || cs.every(s => !(s.curva || []).length)) { el.innerHTML = ''; return; }
    const maxIdade = Math.max(...cs.map(s => (s.curva || []).length));
    let html = '<thead><tr><th>Safra</th>' +
      Array.from({ length: maxIdade }, (_, i) => `<th>${i}m</th>`).join('') + '</tr></thead><tbody>';
    for (const s of cs) {
      html += `<tr><td>${rotulo(s.safra)}</td>` + Array.from({ length: maxIdade }, (_, i) => {
        const v = (s.curva || [])[i];
        if (v == null) return '<td></td>';
        return `<td style="background:rgba(34,197,94,${(0.06 + v * 0.5).toFixed(2)});text-align:center">${Math.round(v * 100)}%</td>`;
      }).join('') + '</tr>';
    }
    el.innerHTML = html + '</tbody>';
  }

  function renderDecomposicao(d, c) {
    const dec = d.decomposicao || [];
    novoChart('grafico-decomposicao', {
      type: 'bar',
      data: { labels: dec.map(x => rotulo(x.mes) + (x.mes === ymAtual ? ' *' : '')), datasets: [
        { label: 'Entrada nova', data: dec.map(x => x.entrada), backgroundColor: c.accent, stack: 's' },
        { label: 'Base recorrente', data: dec.map(x => x.recorrente), backgroundColor: c.green, stack: 's' },
      ]},
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: c.text } } },
        scales: { x: { stacked: true, ticks: { color: c.muted } },
          y: { stacked: true, ticks: { color: c.muted,
            callback: (v) => 'R$ ' + (v / 1000).toLocaleString('pt-BR') + 'k' } } } },
    });
    $('tabela-decomposicao').innerHTML =
      '<thead><tr><th>Mês</th><th>Entrada nova</th><th>Recorrente</th><th>Total</th><th>% recorrente</th></tr></thead><tbody>' +
      dec.map(x => { const t = x.entrada + x.recorrente;
        return `<tr><td>${rotulo(x.mes)}${x.mes === ymAtual ? ' *' : ''}</td><td>${fmt(x.entrada)}</td>` +
          `<td>${fmt(x.recorrente)}</td><td>${fmt(t)}</td><td>${t ? pct(x.recorrente / t) : '—'}</td></tr>`;
      }).join('') + '</tbody>';
  }

  function renderRumo(d, c) {
    const dec = (d.decomposicao || []).filter(x => x.mes < ymAtual);
    const r = d.rumo || {};
    const frase = (nome, a) => !a ? '' :
      a.status === 'cruzou' ? `✅ o recorrente já cobre ${nome}. ` :
      a.status === 'a_caminho' ? `No ritmo atual, cobre ${nome} em ~${a.meses} meses (≈ ${rotulo(a.mesAlvo)}). ` :
      `No ritmo atual, não cruza ${nome} — o recorrente não está crescendo. `;
    $('rumo-texto').textContent = r.erro ? 'Histórico insuficiente para projetar.'
      : frase('as despesas fixas', r.fixas) + frase('a saída total', r.total);
    const reta = (regua) => dec.map(() => regua);
    novoChart('grafico-rumo', {
      type: 'line',
      data: { labels: dec.map(x => rotulo(x.mes)), datasets: [
        { label: 'Base recorrente', data: dec.map(x => x.recorrente), borderColor: c.green,
          backgroundColor: c.green, tension: .3 },
        { label: 'Despesas fixas (média)', data: reta(d.reguas?.fixas), borderColor: c.yellow,
          borderDash: [6, 4], pointRadius: 0 },
        { label: 'Saída total (média)', data: reta(d.reguas?.saidaTotal), borderColor: c.red,
          borderDash: [6, 4], pointRadius: 0 },
      ]},
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: c.text } } }, scales: escala(c) },
    });
  }

  function renderColchao(d, c) {
    const col = d.colchao || {};
    $('colchao-texto').textContent = col.mesesCobertos == null
      ? 'Régua das fixas indisponível.'
      : `Se as vendas parassem hoje, a carteira cobre as despesas fixas por ~${col.mesesCobertos} ` +
        `${col.mesesCobertos === 1 ? 'mês' : 'meses'}.`;
    const meses = col.meses || [];
    novoChart('grafico-colchao', {
      type: 'line',
      data: { labels: meses.map(x => rotulo(x.mes)), datasets: [
        { label: 'Recorrente já contratado (ajustado)', data: meses.map(x => x.previsto),
          borderColor: c.green, backgroundColor: c.green + '33', fill: true, tension: .3 },
        { label: 'Despesas fixas (média)', data: meses.map(() => d.reguas?.fixas),
          borderColor: c.yellow, borderDash: [6, 4], pointRadius: 0 },
      ]},
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: c.text } } }, scales: escala(c) },
    });
  }

  function renderQualidade(d) {
    const rm = d.realizacaoMes || [];
    $('qualidade-tabela').innerHTML =
      '<thead><tr><th>Mês</th><th>Boleto</th><th>Cartão de crédito</th><th>Outras formas</th></tr></thead><tbody>' +
      rm.map(x => `<tr><td>${rotulo(x.mes)}</td><td>${pct(x.boleto)}</td><td>${pct(x.cartao)}</td><td>${pct(x.outras)}</td></tr>`).join('') +
      `<tr class="tot"><td>Média (6m)</td><td>${pct(d.realizacao?.['Boleto']?.taxa)}</td>` +
      `<td>${pct(d.realizacao?.['Cartão de Crédito']?.taxa)}</td><td>${pct(d.realizacao?.outras?.taxa)}</td></tr></tbody>`;
  }

  function render(d) {
    $('nota-vazio').style.display = d.vazio ? '' : 'none';
    if (d.vazio) { $('atualizado').textContent = 'Sem análise gravada ainda.'; return; }
    const quando = new Date(d.atualizado_em);
    $('atualizado').textContent = 'Atualizado em ' + quando.toLocaleString('pt-BR');
    $('nota-velho').style.display = (Date.now() - quando.getTime() > 36 * 3600 * 1000) ? '' : 'none';
    const c = cores();
    renderSintese(d, c);
    renderCalculadora(d);
    renderSafras(d);
    renderCurvaSafra(d);
    renderDecomposicao(d, c);
    renderRumo(d, c);
    renderColchao(d, c);
    renderQualidade(d);
  }

  let dados = null;
  async function carregar() {
    dados = await comRetry(() => FinAPI.analiseReceita());
    render(dados);
  }

  $('calc-salvar').addEventListener('click', async () => {
    const num = (id) => { const v = $(id).value.trim(); return v === '' ? null : Number(v); };
    const lucro = num('calc-lucro');
    const modoPct = $('calc-lucro-modo').value === 'pct';
    if (modoPct && lucro != null && (lucro < 0 || lucro >= 95)) { alert('Lucro em % deve ficar entre 0 e 94.'); return; }
    const body = { mes: ymAtual + '-01',
      meta_faturamento: num('calc-fat'),
      lucro_alvo: modoPct ? null : lucro,
      lucro_alvo_pct: modoPct && lucro != null ? Math.round(lucro * 10) / 1000 : null,
      recebiveis_override: num('calc-receb'),
      pagar_override: num('calc-pagar') };
    // campo igual ao default medido → null (volta a acompanhar o medido)
    const mi = dados?.metaInputs || {};
    if (body.recebiveis_override === mi.defaults?.recebiveis) body.recebiveis_override = null;
    if (body.pagar_override === mi.defaults?.pagar) body.pagar_override = null;
    const b = $('calc-salvar'); b.disabled = true;
    try { await FinAPI.analiseReceitaMeta(body); await carregar(); }
    catch (e) { alert('Erro ao salvar: ' + e.message); }
    finally { b.disabled = false; }
  });

  $('btn-sync').addEventListener('click', async () => {
    const b = $('btn-sync'); b.disabled = true; b.textContent = 'Atualizando…';
    try {
      const antes = dados?.atualizado_em;
      await FinAPI.analiseReceitaSync();
      // O refresh roda em background (~1–2 min): sondar o atualizado_em a cada 15s.
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 15000));
        const novo = await FinAPI.analiseReceita();
        if (novo.atualizado_em !== antes) { dados = novo; render(novo); break; }
      }
    } catch (e) { alert('Erro ao atualizar: ' + e.message); }
    finally { b.disabled = false; b.textContent = '🔄 Atualizar dados'; }
  });

  carregar().catch(e => { $('atualizado').textContent = 'Erro ao carregar: ' + e.message; });
})();
