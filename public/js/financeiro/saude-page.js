(function () {
  const $ = (id) => document.getElementById(id);
  const fmt = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const MESES_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const rotulo = (ym) => { const [y, m] = ym.split('-').map(Number); return `${MESES_PT[m - 1]}/${String(y).slice(2)}`; };
  let chart = null;

  function render(d) {
    const receber = d.meses.reduce((s, m) => s + m.a_receber, 0);
    const pagar = d.meses.reduce((s, m) => s + m.a_pagar, 0);
    const dif = receber - pagar;
    $('kpi-receber').textContent = fmt(receber);
    $('kpi-pagar').textContent = fmt(pagar);
    $('kpi-diferenca').textContent = fmt(dif);
    $('kpi-diferenca').style.color = dif >= 0 ? 'var(--green)' : 'var(--red)';
    $('kpi-vencido').textContent = fmt(d.vencido);
    $('atualizado').textContent = d.atualizado_em
      ? 'Atualizado em ' + new Date(d.atualizado_em).toLocaleString('pt-BR') : '';
    $('horizonte').textContent = d.meses.length ? `próximos ${d.meses.length} meses` : 'próximos meses';

    const vazio = !d.meses.length;
    $('vazio').style.display = vazio ? '' : 'none';
    if (vazio) { if (chart) { chart.destroy(); chart = null; } $('tbody').innerHTML = ''; return; }

    const css = getComputedStyle(document.documentElement);
    if (chart) chart.destroy();
    chart = new Chart($('grafico'), {
      type: 'bar',
      data: {
        labels: d.meses.map(m => rotulo(m.mes)),
        datasets: [
          { label: 'A receber', data: d.meses.map(m => m.a_receber), backgroundColor: css.getPropertyValue('--green').trim() },
          { label: 'A pagar',   data: d.meses.map(m => m.a_pagar),   backgroundColor: css.getPropertyValue('--red').trim() },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: css.getPropertyValue('--text').trim() } } },
        scales: {
          x: { ticks: { color: css.getPropertyValue('--muted').trim() }, grid: { display: false } },
          y: { ticks: { color: css.getPropertyValue('--muted').trim(), callback: v => 'R$ ' + Math.round(v / 1000) + 'k' },
               grid: { color: css.getPropertyValue('--border').trim() } },
        },
      },
    });

    $('tbody').innerHTML = d.meses.map(m => {
      const md = m.a_receber - m.a_pagar;
      return `<tr class="${md < 0 ? 'ruim' : ''}"><td>${rotulo(m.mes)}</td><td>${fmt(m.a_receber)}</td>` +
        `<td>${fmt(m.a_pagar)}</td><td class="${md >= 0 ? 'dif-pos' : 'dif-neg'}">${fmt(md)}</td></tr>`;
    }).join('');
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
