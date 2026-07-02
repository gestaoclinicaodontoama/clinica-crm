// Página da DRE v2 — orquestra FinAPI + DREAnalise e renderiza a tabela/KPIs.
(function () {
  const A = window.DREAnalise;

  // Esqueleto da cascata: grupos na ordem do GRUPOS_DRE + subtotais intercalados.
  const LINHAS = [
    { tipo: 'grupo', codigo: '1', natureza: 'entrada' },
    { tipo: 'grupo', codigo: '2', natureza: 'saida' },
    { tipo: 'subtotal', chave: 'receitaLiquida', label: 'RECEITA LÍQUIDA' },
    { tipo: 'grupo', codigo: '3.0', natureza: 'saida' },
    { tipo: 'grupo', codigo: '3.1', natureza: 'saida' },
    { tipo: 'grupo', codigo: '3.2', natureza: 'saida' },
    { tipo: 'grupo', codigo: '3.3', natureza: 'saida' },
    { tipo: 'subtotal', chave: 'lucroBruto', label: 'LUCRO BRUTO' },
    { tipo: 'grupo', codigo: '4', natureza: 'saida' },
    { tipo: 'subtotal', chave: 'resultadoOperacional', label: 'RESULTADO OPERACIONAL' },
    { tipo: 'grupo', codigo: '5', natureza: 'saida' },
    { tipo: 'grupo', codigo: '7', natureza: 'saida' },
    { tipo: 'subtotal', chave: 'resultadoFinal', label: 'RESULTADO FINAL' },
  ];

  const $ = (id) => document.getElementById(id);
  const fmt = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtPct = (f) => (f * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
  const fmtMes = (ym) => {
    const [y, m] = ym.split('-');
    return ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][Number(m) - 1] + '/' + y.slice(2);
  };
  const valorClass = (v) => Number(v) >= 0 ? 'valor-positivo' : 'valor-negativo';

  // Defaults: mês corrente
  (function () {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    $('from').value = ym;
    $('to').value = ym;
  })();

  const lastDayOf = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  };

  // Estado de expansão dos grupos
  const LS_KEY = 'dre_grupos_abertos';
  let abertos;
  try { abertos = new Set(JSON.parse(localStorage.getItem(LS_KEY) || '[]')); }
  catch { abertos = new Set(); }
  const salvarAbertos = () => localStorage.setItem(LS_KEY, JSON.stringify([...abertos]));

  window._dreState = null; // { meses, semCat, from, to, mesesCompletos }

  window.carregar = async function carregar() {
    const fromYm = $('from').value, toYm = $('to').value;
    const msg = $('dreMsg'), wrap = $('dreWrap'), btn = $('btnCarregar');
    if (!fromYm || !toYm || fromYm > toYm) {
      msg.textContent = 'Selecione um período válido.'; msg.style.display = '';
      wrap.style.display = 'none'; return;
    }
    const nMeses = (Number(toYm.slice(0, 4)) - Number(fromYm.slice(0, 4))) * 12
      + (Number(toYm.slice(5)) - Number(fromYm.slice(5))) + 1;
    if (nMeses > 24) {
      msg.textContent = 'Período máximo: 24 meses.'; msg.style.display = '';
      wrap.style.display = 'none'; return;
    }
    const from = fromYm + '-01';
    const to = toYm + '-' + String(lastDayOf(toYm)).padStart(2, '0');

    msg.textContent = 'Carregando…'; msg.style.display = '';
    wrap.style.display = 'none'; $('kpis').style.display = 'none';
    $('semCat').style.display = 'none'; btn.disabled = true;
    try {
      const r = await FinAPI.dreMensal(from, to);
      const hoje = new Date();
      const mesesCompletos = r.meses.filter(m => A.mesCompleto(m.ym, hoje));
      window._dreState = { meses: r.meses, semCat: r.sem_categoria, from, to, mesesCompletos };
      renderSemCat(r.sem_categoria);
      renderTabela(window._dreState);
      if (window.renderKpis) window.renderKpis(window._dreState); // Task 6
      msg.style.display = 'none'; wrap.style.display = '';
    } catch (e) {
      msg.textContent = 'Erro ao carregar DRE: ' + e.message;
      msg.style.display = ''; wrap.style.display = 'none';
    } finally { btn.disabled = false; }
  };

  window.sincronizar = async function sincronizar() {
    const btn = $('btnSync');
    btn.disabled = true; btn.textContent = 'Sincronizando…';
    try {
      await FinAPI.sync();
      btn.textContent = 'Sincronizado!';
      await window.carregar();
    } catch (e) {
      $('dreMsg').textContent = 'Erro ao sincronizar: ' + e.message;
      $('dreMsg').style.display = '';
    } finally {
      btn.disabled = false;
      setTimeout(() => { btn.textContent = 'Atualizar dados'; }, 2000);
    }
  };

  function renderSemCat(sc) {
    const el = $('semCat');
    if (!sc || !sc.qtd) { el.style.display = 'none'; return; }
    el.innerHTML = `⚠️ <b>${sc.qtd}</b> lançamento${sc.qtd > 1 ? 's' : ''} sem categoria no período ` +
      `(<b>${fmt(sc.total)}</b> fora da DRE) — ` +
      `<a href="/financeiro/a-categorizar.html">categorizar agora</a>`;
    el.style.display = '';
  }

  // ── Tabela ──────────────────────────────────────────────────────────────────
  function renderTabela(st) {
    const { meses, mesesCompletos } = st;
    const multi = meses.length > 1;
    const hoje = new Date();
    const subs = meses.map(m => A.subtotais(m));
    const subTotal = A.subtotais(somarMeses(meses));
    const receitaBrutaTotal = subTotal.receitaBruta;
    const nComp = mesesCompletos.length;

    let html = '<table class="dre"><thead><tr><th class="col-conta">Conta</th>';
    if (multi) {
      for (const m of meses) {
        const parcial = !A.mesCompleto(m.ym, hoje);
        html += `<th${parcial ? ' class="col-parcial" title="mês em andamento (fora da média)"' : ''}>${fmtMes(m.ym)}${parcial ? '*' : ''}</th>`;
      }
      html += '<th>Média</th>';
    }
    html += '<th>Total</th><th>AV%</th></tr></thead><tbody>';

    for (const linha of LINHAS) {
      if (linha.tipo === 'grupo') html += renderGrupo(linha, st, subs, receitaBrutaTotal, nComp, multi);
      else html += renderSubtotal(linha, subs, subTotal, receitaBrutaTotal, multi);
    }
    html += '</tbody></table>';
    $('dre').innerHTML = html;

    // toggle de grupos
    for (const tr of document.querySelectorAll('tr.grupo')) {
      tr.addEventListener('click', () => {
        const cod = tr.dataset.grupo;
        if (abertos.has(cod)) abertos.delete(cod); else abertos.add(cod);
        salvarAbertos();
        renderTabela(window._dreState);
      });
    }
    if (window.plugarDrill) window.plugarDrill(); // Task 6
  }

  function somarMeses(meses) {
    // DRE "total": soma grupo a grupo e conta a conta
    const porGrupo = new Map();
    for (const m of meses) for (const g of (m.grupos || [])) {
      if (!porGrupo.has(g.codigo)) porGrupo.set(g.codigo, { codigo: g.codigo, titulo: g.titulo, total: 0, contas: new Map() });
      const ag = porGrupo.get(g.codigo);
      ag.total += g.total;
      for (const c of (g.contas || [])) {
        if (!ag.contas.has(c.codigo)) ag.contas.set(c.codigo, { codigo: c.codigo, nome: c.nome, total: 0 });
        ag.contas.get(c.codigo).total += c.total;
      }
    }
    const grupos = [...porGrupo.values()].map(g => ({ ...g, contas: [...g.contas.values()] }));
    return { grupos };
  }

  const acharGrupo = (dre, cod) => (dre.grupos || []).find(g => g.codigo === cod);

  function celulaValor({ valor, anterior, natureza, mediaVal, nComp, ehSaida, parcial }) {
    const pct = A.variacao(natureza, valor, anterior);
    const cls = A.classeVariacao(natureza, pct);
    const anom = (ehSaida && !parcial) ? A.nivelAnomalia(valor, mediaVal, nComp) : null;
    let td = `<td class="${anom ? 'anom-' + (anom === 'vermelho' ? 'verm' : 'ambar') : ''}${parcial ? ' col-parcial' : ''}"`;
    if (anom) td += ` title="${fmt(valor)} vs média ${fmt(mediaVal)}"`;
    td += `>${fmt(valor)}`;
    if (pct != null) {
      td += `<span class="var ${cls || 'neutro'}">${pct > 0 ? '▲' : '▼'} ${fmtPct(Math.abs(pct))}</span>`;
    }
    return td + '</td>';
  }

  function renderGrupo(linha, st, subs, receitaBrutaTotal, nComp, multi) {
    const { meses, mesesCompletos } = st;
    const hoje = new Date();
    const cod = linha.codigo;
    const grupoTotal = acharGrupo(somarMeses(meses), cod) || { titulo: tituloGrupo(meses, cod), total: 0, contas: [] };
    const aberto = abertos.has(cod);
    const valores = meses.map(m => (acharGrupo(m, cod) || {}).total || 0);
    const mediaVal = A.media(mesesCompletos.map(m => (acharGrupo(m, cod) || {}).total || 0));

    let html = `<tr class="grupo${aberto ? ' aberto' : ''}" data-grupo="${cod}">` +
      `<td class="col-conta"><span class="chev">▸</span>${grupoTotal.titulo}</td>`;
    if (multi) {
      valores.forEach((v, i) => {
        html += celulaValor({
          valor: v, anterior: i > 0 ? valores[i - 1] : null, natureza: linha.natureza,
          mediaVal, nComp, ehSaida: linha.natureza === 'saida',
          parcial: !A.mesCompleto(meses[i].ym, hoje),
        });
      });
      html += `<td>${mediaVal == null ? '–' : fmt(mediaVal)}</td>`;
    }
    const avG = A.av(grupoTotal.total, receitaBrutaTotal);
    html += `<td class="${valorClass(grupoTotal.total)}">${fmt(grupoTotal.total)}</td>` +
      `<td>${avG == null ? '–' : fmtPct(avG)}</td></tr>`;

    if (aberto) {
      // união de contas (do total somado — cobre conta que só existe num mês)
      for (const conta of grupoTotal.contas.sort((a, b) => a.codigo < b.codigo ? -1 : 1)) {
        html += `<tr class="conta"><td class="col-conta">${conta.codigo} ${conta.nome}</td>`;
        if (multi) {
          const vals = meses.map(m => {
            const g = acharGrupo(m, cod);
            return ((g && g.contas.find(c => c.codigo === conta.codigo)) || {}).total || 0;
          });
          const medC = A.media(mesesCompletos.map(m => {
            const g = acharGrupo(m, cod);
            return ((g && g.contas.find(c => c.codigo === conta.codigo)) || {}).total || 0;
          }));
          vals.forEach((v, i) => {
            const parcial = !A.mesCompleto(meses[i].ym, hoje);
            const pct = A.variacao(linha.natureza, v, i > 0 ? vals[i - 1] : null);
            const cls = A.classeVariacao(linha.natureza, pct);
            const anom = (linha.natureza === 'saida' && !parcial) ? A.nivelAnomalia(v, medC, nComp) : null;
            html += `<td class="valor-conta ${anom ? 'anom-' + (anom === 'vermelho' ? 'verm' : 'ambar') : ''}${parcial ? ' col-parcial' : ''}"` +
              ` data-conta="${conta.codigo}" data-ym="${meses[i].ym}"` +
              (anom ? ` title="${fmt(v)} vs média ${fmt(medC)}"` : '') + `>${fmt(v)}`;
            if (pct != null) html += `<span class="var ${cls || 'neutro'}">${pct > 0 ? '▲' : '▼'} ${fmtPct(Math.abs(pct))}</span>`;
            html += '</td>';
          });
          html += `<td>${medC == null ? '–' : fmt(medC)}</td>`;
        }
        const avC = A.av(conta.total, receitaBrutaTotal);
        html += `<td class="valor-conta" data-conta="${conta.codigo}" data-ym="total">${fmt(conta.total)}</td>` +
          `<td>${avC == null ? '–' : fmtPct(avC)}</td></tr>`;
      }
    }
    return html;
  }

  function tituloGrupo(meses, cod) {
    for (const m of meses) { const g = acharGrupo(m, cod); if (g) return g.titulo; }
    return cod;
  }

  function renderSubtotal(linha, subs, subTotal, receitaBrutaTotal, multi) {
    const hoje = new Date();
    const st = window._dreState;
    let html = `<tr class="subtotal"><td class="col-conta">${linha.label}</td>`;
    if (multi) {
      const vals = subs.map(s => s[linha.chave]);
      vals.forEach((v, i) => {
        const parcial = !A.mesCompleto(st.meses[i].ym, hoje);
        const pct = A.variacao('entrada', v, i > 0 ? vals[i - 1] : null);
        const cls = A.classeVariacao('entrada', pct);
        const margem = A.av(v, subs[i].receitaBruta);
        html += `<td class="${valorClass(v)}${parcial ? ' col-parcial' : ''}">${fmt(v)}` +
          (margem != null ? `<span class="margem">${fmtPct(margem)}</span>` : '') +
          (pct != null ? `<span class="var ${cls || 'neutro'}">${pct > 0 ? '▲' : '▼'} ${fmtPct(Math.abs(pct))}</span>` : '') +
          '</td>';
      });
      const medS = A.media(st.mesesCompletos.map(m => A.subtotais(m)[linha.chave]));
      html += `<td>${medS == null ? '–' : fmt(medS)}</td>`;
    }
    const total = subTotal[linha.chave];
    const margemT = A.av(total, receitaBrutaTotal);
    html += `<td class="${valorClass(total)}">${fmt(total)}` +
      (margemT != null ? `<span class="margem">${fmtPct(margemT)}</span>` : '') + '</td>' +
      `<td>${margemT == null ? '–' : fmtPct(margemT)}</td></tr>`;
    return html;
  }

  window.carregar();
})();
