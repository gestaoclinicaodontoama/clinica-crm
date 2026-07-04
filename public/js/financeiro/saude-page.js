(function () {
  const $ = (id) => document.getElementById(id);
  const fmt = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const MESES_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const rotulo = (ym) => { const [y, m] = ym.split('-').map(Number); return `${MESES_PT[m - 1]}/${String(y).slice(2)}`; };
  const rotuloDia = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  const ymAtual = new Date().toLocaleDateString('sv-SE').slice(0, 7);
  let chart = null, chartTend = null, chartRenov = null, chartProj = null;
  let projDados = null, projMetrica = 'caixa';
  const METRICAS = {
    faturamento: { label: 'Faturamento', desc: 'o que é vendido (antes de entrar no caixa)' },
    caixa: { label: 'Caixa recebido', desc: 'o que efetivamente entra no bolso' },
    lucro: { label: 'Lucro', desc: 'o que sobra: caixa recebido menos as saídas' },
  };

  function cores() {
    const css = getComputedStyle(document.documentElement);
    return {
      green: css.getPropertyValue('--green').trim(), red: css.getPropertyValue('--red').trim(),
      accent: css.getPropertyValue('--accent').trim(), text: css.getPropertyValue('--text').trim(),
      muted: css.getPropertyValue('--muted').trim(), border: css.getPropertyValue('--border').trim(),
    };
  }
  const escalaR$ = (c) => ({
    x: { ticks: { color: c.muted }, grid: { display: false } },
    y: { ticks: { color: c.muted, callback: v => 'R$ ' + Math.round(v / 1000) + 'k' }, grid: { color: c.border } },
  });

  function render(d) {
    // mês vigente é parcial (contas pagas saem do forecast): fica visível na
    // tabela como "em andamento", mas TODOS os totais começam no mês seguinte.
    const atual = d.meses.find(m => m.mes === ymAtual) || null;
    const futuros = d.meses.filter(m => m.mes > ymAtual);
    const comPagar = futuros.filter(m => m.a_pagar != null);
    const receber = futuros.reduce((s, m) => s + m.a_receber, 0);
    const pagar = comPagar.reduce((s, m) => s + m.a_pagar, 0);
    const dif = comPagar.reduce((s, m) => s + m.a_receber - m.a_pagar, 0);
    $('kpi-receber').textContent = fmt(receber);
    $('kpi-pagar').textContent = fmt(pagar);
    $('kpi-pagar-sub').textContent = comPagar.length && comPagar.length < futuros.length
      ? `contas lançadas — ${comPagar.length} meses com previsão` : 'contas lançadas no Clinicorp';
    $('kpi-diferenca').textContent = fmt(dif);
    $('kpi-diferenca').style.color = dif >= 0 ? 'var(--green)' : 'var(--red)';
    $('kpi-dif-sub').textContent = comPagar.length && comPagar.length < futuros.length
      ? `nos ${comPagar.length} meses com previsão de saída` : 'receber − pagar';
    $('kpi-vencido').textContent = fmt(d.vencido);
    $('atualizado').textContent = d.atualizado_em
      ? 'Atualizado em ' + new Date(d.atualizado_em).toLocaleString('pt-BR') : '';
    $('horizonte').textContent = futuros.length
      ? `${rotulo(futuros[0].mes)} → ${rotulo(futuros[futuros.length - 1].mes)}` : 'próximos meses';

    const vazio = !d.meses.length;
    $('vazio').style.display = vazio ? '' : 'none';
    if (vazio) { if (chart) { chart.destroy(); chart = null; } $('tbody').innerHTML = ''; return; }

    const c = cores();
    if (chart) chart.destroy();
    chart = new Chart($('grafico'), {
      type: 'bar',
      data: {
        labels: futuros.map(m => rotulo(m.mes)),
        datasets: [
          { label: 'A receber', data: futuros.map(m => m.a_receber), backgroundColor: c.green },
          { label: 'A pagar', data: futuros.map(m => m.a_pagar), backgroundColor: c.red },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: c.text } } }, scales: escalaR$(c) },
    });

    const linha = (m, extraCls, sufixo) => {
      if (m.a_pagar == null) return `<tr class="${extraCls}"><td>${rotulo(m.mes)}${sufixo}</td><td>${fmt(m.a_receber)}</td><td class="sem-dado">—</td><td class="sem-dado">—</td></tr>`;
      const md = m.a_receber - m.a_pagar;
      return `<tr class="${extraCls} ${md < 0 ? 'ruim' : ''}"><td>${rotulo(m.mes)}${sufixo}</td><td>${fmt(m.a_receber)}</td>` +
        `<td>${fmt(m.a_pagar)}</td><td class="${md >= 0 ? 'dif-pos' : 'dif-neg'}">${fmt(md)}</td></tr>`;
    };
    $('tbody').innerHTML = (atual ? linha(atual, 'em-andamento', ' *') : '') +
      futuros.map(m => linha(m, '', '')).join('');
    $('nota-atual').style.display = atual ? '' : 'none';

    renderTendencia(d, c);
    renderProjecao(d);
    renderAnalises(d, receber, c);
  }

  // Projeção de crescimento: histórico (últimos 12m) + 24m projetados, 3 cenários.
  function renderProjecao(d) {
    const sec = $('sec-projecao');
    const r = window.ProjecaoCresc && d.serie_mensal
      ? window.ProjecaoCresc.projecaoCrescimento(d.serie_mensal) : { erro: 'sem dados' };
    if (r.erro) { sec.style.display = 'none'; return; }
    sec.style.display = '';
    projDados = r;
    desenharProjecao();
  }

  function desenharProjecao() {
    const r = projDados;
    if (!r) return;
    const c = cores();
    const met = projMetrica;
    const gMet = { faturamento: r.gFaturamento, caixa: r.gCaixa, lucro: r.gCaixa }[met];

    // Cartões-resumo do cenário provável (+ faixa conservador–otimista)
    const resP = r.resumo.provavel[met], resC = r.resumo.conservador[met], resO = r.resumo.otimista[met];
    const faixa = (a, b) => `entre ${fmt(a)} e ${fmt(b)}`;
    $('proj-cards').innerHTML =
      `<div class="proj-card"><div class="l">Próximos 12 meses (provável)</div>
        <div class="v">${fmt(resP.m12)}</div><div class="r">${faixa(resC.m12, resO.m12)}</div></div>` +
      `<div class="proj-card"><div class="l">Próximos 24 meses (provável)</div>
        <div class="v">${fmt(resP.m24)}</div><div class="r">${faixa(resC.m24, resO.m24)}</div></div>` +
      `<div class="proj-card"><div class="l">Ritmo de crescimento medido</div>
        <div class="v">${gMet >= 0 ? '+' : ''}${(gMet * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%/ano</div>
        <div class="r">${METRICAS[met].desc}</div></div>`;

    // Série: últimos 12 meses reais + 24 projetados. Cenários ancoram no último real.
    const hist = r.historico.slice(-12);
    const histVals = hist.map(h => h[met]);
    const ancora = histVals[histVals.length - 1];
    const proj = r.projecao.provavel[met]; // ym's iguais entre cenários
    const labels = [...hist.map(h => rotulo(h.ym)), ...proj.map(p => rotulo(p.ym))];
    const nH = hist.length;
    const nulos = (n) => Array.from({ length: n }, () => null);
    // datasets de cenário começam ancorados no último real (posição nH-1) p/ conectar a linha
    const linhaCen = (cen) => [...nulos(nH - 1), ancora, ...r.projecao[cen][met].map(p => p.val)];

    if (chartProj) chartProj.destroy();
    chartProj = new Chart($('grafico-projecao'), {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Conservador', data: linhaCen('conservador'), borderColor: 'transparent',
          backgroundColor: hexA(c.accent, .10), pointRadius: 0, fill: false, tension: .2 },
        { label: 'Faixa (conservador → otimista)', data: linhaCen('otimista'), borderColor: 'transparent',
          backgroundColor: hexA(c.accent, .10), pointRadius: 0, fill: '-1', tension: .2 },
        { label: 'Provável', data: linhaCen('provavel'), borderColor: c.accent,
          borderDash: [6, 4], pointRadius: 0, fill: false, tension: .2 },
        { label: 'Realizado', data: [...histVals, ...nulos(proj.length)], borderColor: c.green,
          pointRadius: 2, fill: false, tension: .2 },
      ]},
      options: { responsive: true, maintainAspectRatio: false, spanGaps: false,
        plugins: { legend: { labels: { color: c.text,
          filter: (it) => it.text !== 'Conservador' } } }, scales: escalaR$(c) },
    });
    $('projecao-resumo').textContent =
      `Linha verde = realizado (últimos 12 meses). Tracejada = projeção provável; a faixa sombreada vai do cenário conservador ao otimista. `
      + `No provável, o ${METRICAS[met].label.toLowerCase()} dos próximos 12 meses soma ${fmt(r.resumo.provavel[met].m12)}.`;
  }

  const hexA = (hex, a) => {
    const h = hex.replace('#', '');
    const n = h.length === 3 ? h.split('').map(x => x + x).join('') : h;
    const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  };

  document.getElementById('proj-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-met]');
    if (!btn) return;
    projMetrica = btn.dataset.met;
    for (const b of e.currentTarget.querySelectorAll('button')) b.classList.toggle('on', b === btn);
    desenharProjecao();
  });

  function renderTendencia(d, c) {
    const retro = d.analises?.retroativo || [];
    const snaps = (d.snapshots || []).filter(s => s.origem === 'diario');
    const sec = $('sec-tendencia');
    if (!retro.length && snaps.length < 2) { sec.style.display = snaps.length ? '' : 'none'; }
    sec.style.display = (retro.length || snaps.length) ? '' : 'none';
    if (!retro.length && !snaps.length) return;
    const labels = [...retro.map(r => rotulo(r.mes)), ...snaps.map(s => rotuloDia(s.data))];
    const nR = retro.length;
    if (chartTend) chartTend.destroy();
    chartTend = new Chart($('grafico-tendencia'), {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Carteira a receber (reconstruída)', data: [...retro.map(r => r.receber), ...snaps.map(() => null)],
          borderColor: c.green, borderDash: [6, 4], pointRadius: 0, tension: .2 },
        { label: 'Carteira a receber (medição diária)', data: [...retro.map(() => null), ...snaps.map(s => s.receber)],
          borderColor: c.green, pointRadius: 2, tension: .2 },
        { label: 'Resultado futuro (receber − pagar)', data: [...retro.map(() => null), ...snaps.map(s => s.resultado)],
          borderColor: c.accent, pointRadius: 2, tension: .2 },
      ]},
      options: { responsive: true, maintainAspectRatio: false, spanGaps: false,
        plugins: { legend: { labels: { color: c.text } } }, scales: escalaR$(c) },
    });
    let resumo = '';
    if (nR >= 4) {
      const a = retro[nR - 4].receber, b = retro[nR - 1].receber;
      const pct = a ? Math.round(((b - a) / a) * 100) : 0;
      resumo += `Carteira a receber ${b >= a ? 'cresceu' : 'encolheu'} ${fmt(Math.abs(b - a))} (${pct >= 0 ? '+' : ''}${pct}%) nos últimos 3 meses. `;
    }
    if (snaps.length >= 2) {
      const s0 = snaps[0], s1 = snaps[snaps.length - 1];
      resumo += `Resultado futuro: ${fmt(s0.resultado)} → ${fmt(s1.resultado)} desde ${rotuloDia(s0.data)}.`;
    } else if (snaps.length === 1) {
      resumo += 'Medições diárias do resultado futuro começaram agora — a linha ganha história a cada sync.';
    }
    $('tendencia-resumo').textContent = resumo;
  }

  function renderAnalises(d, nominal, c) {
    const a = d.analises;
    $('sec-analises').style.display = a ? '' : 'none';
    if (!a) return;

    // Expectativa realista: taxa histórica de não-recebimento sobre o nominal
    const taxa = a.perda?.taxa || 0;
    $('expectativa').innerHTML =
      `<div class="exp-linha"><span>Nominal (mês seguinte → 24m)</span><b>${fmt(nominal)}</b></div>` +
      `<div class="exp-linha"><span>Taxa histórica de não-recebimento</span><b>${(taxa * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</b></div>` +
      `<div class="exp-linha exp-dest"><span>Esperado com base no histórico</span><b>${fmt(nominal * (1 - taxa))}</b></div>` +
      `<div class="exp-nota">Taxa = parcelas vencidas há 180+ dias nunca recebidas (${fmt(a.perda?.perdido)}) ÷ total delas (${fmt(a.perda?.base)}). Recebida com atraso conta como recebida.</div>`;

    // Aging do vencido
    const tot = a.aging?.total || 0;
    $('aging-tabela').innerHTML = '<thead><tr><th>Idade</th><th>Valor</th><th>%</th></tr></thead><tbody>' +
      (a.aging?.faixas || []).map(f =>
        `<tr><td>${f.faixa} dias</td><td>${fmt(f.valor)}</td><td>${tot ? Math.round(f.valor / tot * 100) : 0}%</td></tr>`).join('') +
      `<tr class="tot"><td>Total vencido</td><td>${fmt(tot)}</td><td></td></tr></tbody>`;

    // Concentração por pagador
    const esc = (s) => String(s || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const carteira = d.meses.reduce((s, m) => s + m.a_receber, 0) || 1;
    $('top-tabela').innerHTML = '<thead><tr><th>Pagador</th><th>A vencer</th><th>% carteira</th></tr></thead><tbody>' +
      (a.top || []).map(t =>
        `<tr><td>${esc(t.nome)}</td><td>${fmt(t.valor)}</td><td>${Math.round(t.valor / carteira * 100)}%</td></tr>`).join('') + '</tbody>';

    // Renovação da carteira (novas × recebidas por mês)
    const ren = a.renovacao || [];
    if (chartRenov) chartRenov.destroy();
    if (ren.length) {
      chartRenov = new Chart($('grafico-renovacao'), {
        type: 'bar',
        data: { labels: ren.map(r => rotulo(r.mes) + (r.mes === ymAtual ? ' *' : '')), datasets: [
          { label: 'Carteira nova (contratado)', data: ren.map(r => r.novas), backgroundColor: c.accent },
          { label: 'Recebido no mês', data: ren.map(r => r.recebidas), backgroundColor: c.green },
        ]},
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { color: c.text } } }, scales: escalaR$(c) },
      });
    }
  }

  async function carregar() { render(await FinAPI.saude()); }

  $('btn-sync').addEventListener('click', async () => {
    const b = $('btn-sync'); b.disabled = true; b.textContent = 'Atualizando…';
    try { await FinAPI.sync(); await carregar(); }
    catch (e) { alert('Erro ao atualizar: ' + e.message); }
    finally { b.disabled = false; b.textContent = '🔄 Atualizar dados'; }
  });

  carregar().catch(e => { $('atualizado').textContent = 'Erro ao carregar: ' + e.message; });
})();
