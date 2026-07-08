// Painel do Gestor — página SPA (só admin/gestor). Junta 4 fontes já existentes:
// /api/painel-gestor (financeiro), /api/comercial/dashboard (funil),
// /api/meta-insights (marketing), /api/campanhas/preview/abc (prevenção).
// Cada fonte é tolerante a falha — uma quebrar não derruba as outras.
(function () {
  const P = window.PainelGestor;
  const META_FUNIL = { agendamento: 0.45, comparecimento: 0.50, fechamento: 0.25 };

  const PRESETS = [
    { k: 'hoje', l: 'Hoje' }, { k: 'ontem', l: 'Ontem' }, { k: 'semana', l: 'Esta semana' },
    { k: 'mes', l: 'Este mês' }, { k: 'mes_passado', l: 'Mês passado' },
    { k: 'trimestre', l: 'Este trimestre' }, { k: 'semestre', l: 'Este semestre' },
  ];
  const estado = { preset: 'mes_passado', from: null, to: null };
  const isoLocal = (d) => d.toLocaleDateString('sv-SE'); // YYYY-MM-DD local
  function periodoDatas(preset) {
    const h = new Date(), y = h.getFullYear(), m = h.getMonth();
    let from, to = isoLocal(h);
    if (preset === 'hoje') from = isoLocal(h);
    else if (preset === 'ontem') { const o = new Date(h); o.setDate(o.getDate() - 1); from = to = isoLocal(o); }
    else if (preset === 'semana') { const o = new Date(h); o.setDate(o.getDate() - ((o.getDay() + 6) % 7)); from = isoLocal(o); }
    else if (preset === 'mes_passado') { from = isoLocal(new Date(y, m - 1, 1)); to = isoLocal(new Date(y, m, 0)); }
    else if (preset === 'trimestre') from = isoLocal(new Date(y, Math.floor(m / 3) * 3, 1));
    else if (preset === 'semestre') from = isoLocal(new Date(y, m < 6 ? 0 : 6, 1));
    else from = isoLocal(new Date(y, m, 1)); // mes (default)
    return { from, to };
  }
  const presetLabel = (p) => p === 'custom' ? 'período' : ((PRESETS.find(x => x.k === p) || {}).l || 'período');

  function getToken() {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
        try { return JSON.parse(localStorage.getItem(k))?.access_token; } catch {}
      }
    }
    return null;
  }
  async function get(path) {
    const r = await fetch(path, { headers: { Authorization: 'Bearer ' + getToken() } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  }

  const fmt = (v) => v == null ? '–' : 'R$ ' + Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const pct1 = (f) => f == null ? '–' : (f * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
  const pct0 = (f) => f == null ? '–' : Math.round(f * 100) + '%';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mesPt = (ym) => { if (!ym) return ''; const [y, m] = ym.split('-');
    return ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][+m - 1] + '/' + y.slice(2); };

  const EXPLICA = {
    marketing: { oque: 'De cada R$ 1 gasto em anúncio, quanto voltou em faturamento — e quanto custou cada paciente que fechou.',
      bom: 'Acima de 3× o anúncio se paga com folga.', ruim: 'Abaixo de 1,5× o anúncio está no prejuízo.',
      acoes: 'Cortar campanha abaixo da meta, escalar verba na que está acima. Fonte: Agente de Marketing.' },
    funil: { oque: 'A % de gente que passa de uma etapa pra próxima: lead → agendou → compareceu → fechou. Fechamento = tratamento acima de R$ 1.000 (limpezas não contam).',
      bom: 'Agendamento acima de 45%, comparecimento acima de 50% (bom em odontologia) e fechamento acima de 25%.',
      ruim: 'Etapa abaixo da meta trava tudo que vem depois. Hoje o agendamento (~37%) está abaixo dos 40% desde março, e o fechamento é o gargalo histórico.',
      acoes: 'Agendamento: responder o lead mais rápido e ter script de agendamento. Fechamento: treinar a CRC em objeção e preço, oferecer condições de pagamento.' },
    ticket: { oque: 'Valor médio dos tratamentos particulares acima de R$ 1.000 (convênio e pequenos como limpeza ficam fora — poluiriam a média).',
      bom: 'Em tendência de alta.', ruim: 'Caindo, sinal de orçamentos fatiados ou desconto reflexo.',
      acoes: 'Oferecer plano completo, implante/alinhador, evitar fatiar o orçamento.' },
    ocupacao: { oque: 'Horas agendadas ÷ capacidade das 5 salas (seg-sex 8h-18h menos 2h de almoço + sábado 8h-12h).',
      bom: 'Acima de 80% — agenda cheia.', ruim: 'Abaixo de 60% — muita cadeira vazia, e cadeira vazia é receita que não volta.',
      acoes: 'Encaixar retornos e prevenção nos buracos, remarcar faltas no mesmo dia, abrir horários de pico.' },
    faturamento: { oque: 'O que foi vendido no mês (competência), com o crescimento vs o mesmo mês do ano anterior.',
      bom: 'Crescendo ano a ano e acima do ponto de equilíbrio.', ruim: 'Encolhendo vs o ano passado.',
      acoes: 'Sustentar o topo do funil e o ticket médio.' },
    lucro: { oque: 'Quanto sobra no fim (margem) e quanto a receita pode cair antes do prejuízo (folga sobre o ponto de equilíbrio).',
      bom: 'Margem acima de 15% e folga acima de 25%.', ruim: 'Margem fina = pouco colchão pra um mês ruim.',
      acoes: 'Atacar inadimplência e o funil, controlar custo variável e juros.' },
    metaEntrada: {
      oque: 'Quanto de dinheiro NOVO (entradas de contratos fechados) ainda precisa entrar neste mês para bater o alvo — empatar as contas ou fechar com o lucro que você definiu na Análise de Receita.',
      bom: 'Verde: a entrada está caindo no ritmo do mês (ou a meta já foi batida).',
      ruim: 'Vermelho: o mês está passando mais rápido que a entrada está chegando — sem reação, o mês fecha abaixo do alvo.',
      acoes: 'Priorizar fechamentos pendentes, negociar entradas maiores, acionar a lista de orçamentos parados.',
    },
    inadimplencia: { oque: 'Quanto da carteira já venceu e não entrou.',
      bom: 'Abaixo de 5% da carteira.', ruim: 'Acima de 10%, e pior quando já está velho (não se recupera).',
      acoes: 'Régua de cobrança e 2ª via nos primeiros 30 dias; renegociar o antigo.' },
    retencao: { oque: 'Pacientes com prevenção vencida (mais de 180 dias sem vir e sem agenda).',
      bom: 'Fila caindo mês a mês.', ruim: 'Fila crescendo = pacientes sumindo.',
      acoes: 'Campanha de retorno preventivo por WhatsApp e discador, priorizando os de maior valor. Fonte: Retorno de Prevenção.' },
  };

  function injectCSS() {
    if (document.getElementById('pg-css')) return;
    const s = document.createElement('style'); s.id = 'pg-css';
    s.textContent = `
    #painel-gestor-root .pg-head { display:flex; flex-wrap:wrap; align-items:flex-end; gap:12px 20px; margin-bottom:6px; }
    #painel-gestor-root .pg-saude { display:flex; gap:8px; margin-left:auto; }
    .pg-chip { display:flex; align-items:center; gap:7px; background:var(--bg2); border:1px solid var(--border); border-radius:999px; padding:6px 12px; font-size:13px; font-weight:600; }
    .pg-dot { width:9px; height:9px; border-radius:50%; flex:none; }
    .pg-dot.verde{background:var(--green);} .pg-dot.amarelo{background:var(--yellow);} .pg-dot.vermelho{background:var(--red);} .pg-dot.neutro{background:var(--muted);}
    .pg-jornada { color:var(--muted); font-size:12.5px; margin:14px 0 22px; padding-bottom:14px; border-bottom:1px solid var(--border); }
    .pg-jornada b { color:var(--text); font-weight:600; }
    .pg-periodo { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:14px 0 2px; }
    .pg-per { padding:5px 11px; border:1px solid var(--border); background:var(--bg2); color:var(--muted); font:inherit; font-size:12.5px; font-weight:600; border-radius:8px; cursor:pointer; }
    .pg-per.on { background:var(--accent); color:#fff; border-color:var(--accent); }
    .pg-per-custom { display:inline-flex; gap:5px; align-items:center; margin-left:4px; }
    .pg-per-custom input { padding:4px 7px; border:1px solid var(--border); border-radius:8px; background:var(--bg2); color:var(--text); font:inherit; font-size:12px; }
    .pg-bloco { margin-bottom:30px; }
    .pg-eyebrow { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.14em; color:var(--accent); }
    .pg-bloco h2 { font-size:16px; font-weight:700; margin:5px 0 2px; }
    .pg-bloco .pg-desc { color:var(--muted); font-size:13px; margin:0 0 14px; }
    .pg-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(270px,1fr)); gap:14px; }
    .pg-card { position:relative; background:var(--bg2); border:1px solid var(--border); border-radius:14px; padding:15px 16px 13px; overflow:hidden; }
    .pg-card::before { content:""; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--muted); }
    .pg-card.verde::before{background:var(--green);} .pg-card.amarelo::before{background:var(--yellow);} .pg-card.vermelho::before{background:var(--red);}
    .pg-card .pg-label { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
    .pg-card .pg-val { font-size:26px; font-weight:700; letter-spacing:-.02em; margin:5px 0 1px; }
    .pg-card .pg-trend { font-size:12.5px; font-weight:600; margin-left:8px; }
    .pg-trend.good{color:var(--green);} .pg-trend.bad{color:var(--red);} .pg-trend.muted{color:var(--muted);}
    .pg-sev { display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:700; padding:2px 9px; border-radius:999px; margin:2px 0 4px; }
    .pg-sev.verde{background:rgba(34,197,94,.14);color:var(--green);} .pg-sev.amarelo{background:rgba(245,158,11,.14);color:var(--yellow);}
    .pg-sev.vermelho{background:rgba(239,68,68,.14);color:var(--red);} .pg-sev.neutro{background:var(--bg3);color:var(--muted);}
    .pg-card .pg-nota { font-size:12.5px; color:var(--muted); margin:2px 0 8px; }
    .pg-card .pg-mod { font-size:12px; color:var(--muted); }
    .pg-ent { border:none; background:none; color:var(--accent); font:inherit; font-size:12px; font-weight:600; cursor:pointer; padding:0; float:right; }
    .pg-ent-box { display:none; clear:both; margin-top:10px; padding-top:10px; border-top:1px dashed var(--border); font-size:12.5px; line-height:1.5; }
    .pg-ent-box.aberto { display:block; }
    .pg-ent-box .l { display:block; margin:3px 0; } .pg-ent-box .l b { color:var(--text); }
    .pg-funil { background:var(--bg2); border:1px solid var(--border); border-radius:14px; padding:16px 18px; margin-bottom:14px; position:relative; overflow:hidden; }
    .pg-funil::before { content:""; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--yellow); }
    .pg-funil-meta { font-size:12px; color:var(--muted); margin:2px 0 14px; } .pg-funil-meta b{color:var(--text);}
    .pg-flow { display:flex; align-items:stretch; gap:6px; flex-wrap:wrap; }
    .pg-etapa { flex:1 1 110px; background:var(--bg3); border-radius:10px; padding:11px 12px; text-align:center; }
    .pg-etapa .q { font-size:20px; font-weight:700; } .pg-etapa .e { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; margin-top:2px; }
    .pg-conv { flex:0 0 76px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; }
    .pg-conv .t { font-size:15px; font-weight:700; } .pg-conv .a { font-size:10.5px; color:var(--muted); } .pg-conv .s { color:var(--muted); }
    .pg-conv.verde .t{color:var(--green);} .pg-conv.amarelo .t{color:var(--yellow);} .pg-conv.vermelho .t{color:var(--red);}
    .pg-msg { color:var(--muted); font-size:14px; padding:20px; }
    @media (max-width:640px){ .pg-flow{flex-direction:column;} .pg-conv{flex-direction:row;gap:8px;} .pg-conv .s{transform:rotate(90deg);} .pg-saude{margin-left:0;width:100%;} }`;
    document.head.appendChild(s);
  }

  const trendGood = (up) => up ? { a: '▲', c: 'good' } : { a: '▼', c: 'bad' };

  function cardHTML(chave, opts) {
    const { label, val, sev, trend, nota, modulo, href } = opts;
    const e = EXPLICA[chave] || {};
    const id = 'pg-ent-' + chave;
    const sevTxt = { verde: 'Saudável', amarelo: 'Atenção', vermelho: 'Crítico', neutro: 'Informação' }[sev];
    const it = (r, t) => t ? `<span class="l"><b>${r}:</b> ${esc(t)}</span>` : '';
    return `<div class="pg-card ${sev}">
      <button class="pg-ent" data-alvo="${id}">▸ entenda</button>
      <div class="pg-label">${esc(label)}</div>
      <div class="pg-val">${val}${trend ? `<span class="pg-trend ${trend.c}">${trend.a} ${esc(trend.t)}</span>` : ''}</div>
      <div><span class="pg-sev ${sev}"><span class="pg-dot ${sev}"></span>${sevTxt}</span></div>
      <div class="pg-nota">${esc(nota)}</div>
      <div class="pg-mod">${opts.href ? `<a href="${opts.href}" style="color:var(--accent);text-decoration:none">${esc(modulo)} →</a>` : esc(modulo)}</div>
      <div class="pg-ent-box" id="${id}">${it('O que é', e.oque)}${it('Quando é bom', e.bom)}${it('Quando é ruim', e.ruim)}${it('Ações', e.acoes)}</div>
    </div>`;
  }

  function funilNiveis(f) {
    const taxa = (a, b) => (b > 0 ? a / b : null);
    return [[taxa(f.agendaram, f.leads), META_FUNIL.agendamento],
            [taxa(f.compareceram, f.agendaram), META_FUNIL.comparecimento],
            [taxa(f.fecharam, f.compareceram), META_FUNIL.fechamento]]
      .map(([t, meta]) => t == null ? null : P.semFunil(t, meta)).filter(Boolean);
  }

  function funilHTML(f, rotuloPer) {
    const taxa = (a, b) => (b > 0 ? a / b : null);
    const etapas = [
      { q: f.leads, e: 'Leads' }, { q: f.agendaram, e: 'Agendaram' },
      { q: f.compareceram, e: 'Compareceram' }, { q: f.fecharam, e: 'Fecharam' },
    ];
    const convs = [
      { taxa: taxa(f.agendaram, f.leads), meta: META_FUNIL.agendamento },
      { taxa: taxa(f.compareceram, f.agendaram), meta: META_FUNIL.comparecimento },
      { taxa: taxa(f.fecharam, f.compareceram), meta: META_FUNIL.fechamento },
    ];
    let flow = '';
    etapas.forEach((et, i) => {
      flow += `<div class="pg-etapa"><div class="q">${et.q ?? '–'}</div><div class="e">${et.e}</div></div>`;
      if (convs[i]) { const s = convs[i].taxa == null ? 'neutro' : P.semFunil(convs[i].taxa, convs[i].meta);
        flow += `<div class="pg-conv ${s}"><span class="s">→</span><span class="t">${pct0(convs[i].taxa)}</span><span class="a">meta ${pct0(convs[i].meta)}</span></div>`; }
    });
    const niveis = funilNiveis(f);
    const pior = niveis.includes('vermelho') ? 'vermelho' : niveis.includes('amarelo') ? 'amarelo' : niveis.length ? 'verde' : 'neutro';
    const nFraco = niveis.filter(n => n !== 'verde').length;
    const e = EXPLICA.funil;
    return `<div class="pg-funil">
      <button class="pg-ent" data-alvo="pg-ent-funil">▸ entenda</button>
      <div class="pg-label">Funil comercial — onde se perde paciente (${rotuloPer})</div>
      <div style="margin:4px 0"><span class="pg-sev ${pior}"><span class="pg-dot ${pior}"></span>${nFraco ? nFraco + ' etapa(s) abaixo da meta' : 'no ritmo'}</span></div>
      <div class="pg-funil-meta">Saudável: <b>40 / 40 / 30</b> · Meta 2026: <b>45 / 50 / 25</b> (agendamento / comparecimento / fechamento)</div>
      <div class="pg-flow">${flow}</div>
      <div class="pg-ent-box" id="pg-ent-funil"><span class="l"><b>O que é:</b> ${esc(e.oque)}</span><span class="l"><b>Quando é bom:</b> ${esc(e.bom)}</span><span class="l"><b>Quando é ruim:</b> ${esc(e.ruim)}</span><span class="l"><b>Ações:</b> ${esc(e.acoes)}</span></div>
    </div>`;
  }

  window.loadPainelGestor = async function () {
    injectCSS();
    const root = document.getElementById('painel-gestor-root');
    if (!root) return;
    if (!estado.from) { const p = periodoDatas(estado.preset); estado.from = p.from; estado.to = p.to; }
    const per = `from=${estado.from}&to=${estado.to}`;
    const rotuloPer = estado.preset === 'custom'
      ? `${estado.from.split('-').reverse().join('/')} a ${estado.to.split('-').reverse().join('/')}`
      : presetLabel(estado.preset).toLowerCase();
    if (!root.dataset.init) { root.innerHTML = '<div class="pg-msg">Carregando indicadores…</div>'; }

    const [fin, mkt, abc, receita] = await Promise.allSettled([
      get('/api/painel-gestor?' + per),
      get(`/api/meta-insights?desde=${estado.from}&ate=${estado.to}`).catch(() => null),
      get('/api/campanhas/preview/abc?count_only=true'),
      get('/api/analise-receita').catch(() => null),
    ]).then(rs => rs.map(r => r.status === 'fulfilled' ? r.value : null));

    const cards = { a: [], b: [], c: [] };
    const niveisContados = [];

    // ── Elo 1: marketing ──
    const tot = mkt && (mkt.totais || mkt);
    if (tot && (tot.roas != null || tot.cpa != null) && !mkt.sem_token) {
      const sev = tot.roas != null ? P.semRoas(tot.roas) : 'neutro';
      if (tot.roas != null) niveisContados.push(sev);
      cards.a.push(cardHTML('marketing', { label: 'Retorno do marketing', sev,
        val: tot.roas != null ? tot.roas.toFixed(1).replace('.', ',') + '×' : '–',
        nota: `Cada R$ 1 em anúncio voltou ${tot.roas != null ? 'R$ ' + tot.roas.toFixed(2).replace('.', ',') : '–'}` +
          (tot.cpa != null ? ` · custo por paciente ${fmt(tot.cpa)}` : ''), modulo: 'Agente de Marketing' }));
    } else {
      cards.a.push(cardHTML('marketing', { label: 'Retorno do marketing', sev: 'neutro', val: '–',
        nota: 'Sem dado — o token do Meta não está configurado no ambiente.', modulo: 'Agente de Marketing' }));
    }

    // ── Elo 2: funil + ticket + ocupação ──
    let funilBlock = '';
    if (fin && fin.funil) {
      funilBlock = funilHTML(fin.funil, rotuloPer);
      funilNiveis(fin.funil).forEach(n => niveisContados.push(n));
    } else {
      funilBlock = `<div class="pg-msg">Funil indisponível no momento.</div>`;
    }

    const tk = fin && fin.ticketSemConvenio;
    cards.b.push(cardHTML('ticket', { label: 'Ticket médio (particular > R$ 1.000)', sev: 'neutro',
      val: tk ? fmt(tk.valor) : '–', nota: tk && tk.n ? `Média de ${tk.n} tratamentos acima de R$ 1.000 no período (limpezas e pequenos fora).` : 'Sem fechamentos no período.',
      modulo: 'Comercial' }));
    const oc = fin && fin.ocupacao;
    if (oc && oc.pct != null) {
      const sevOc = P.semOcupacao(oc.pct);
      niveisContados.push(sevOc);
      cards.b.push(cardHTML('ocupacao', { label: 'Ocupação da agenda', sev: sevOc, val: pct0(oc.pct),
        nota: `${oc.horasAgendadas}h agendadas de ${oc.horasCapacidade}h de cadeira no período (5 salas).`, modulo: 'Produção' }));
    } else {
      cards.b.push(cardHTML('ocupacao', { label: 'Ocupação da agenda', sev: 'neutro', val: '–',
        nota: 'Sem agenda no período.', modulo: 'Produção' }));
    }

    // ── Elo 3: financeiro ──
    if (fin) {
      const f = fin.faturamento || {}, l = fin.lucro || {}, inad = fin.inadimplencia || {};
      const sevFat = f.crescimentoAnual != null ? P.semCrescimento(f.crescimentoAnual) : 'neutro';
      if (f.crescimentoAnual != null) niveisContados.push(sevFat);
      cards.c.push(cardHTML('faturamento', { label: 'Faturamento (' + rotuloPer + ')', sev: sevFat, val: fmt(f.valor),
        trend: f.crescimentoAnual != null ? { ...trendGood(f.crescimentoAnual >= 0), t: pct0(Math.abs(f.crescimentoAnual)) + ' vs ano anterior' } : null,
        nota: 'O que foi vendido no período (competência). Comparado com o mesmo período do ano passado.', modulo: 'DRE' }));

      const sevM = l.margem != null ? P.semMargem(l.margem) : 'neutro';
      const sevFolga = l.folga != null ? P.semFolga(l.folga) : 'neutro';
      const pior = [sevM, sevFolga].includes('vermelho') ? 'vermelho' : [sevM, sevFolga].includes('amarelo') ? 'amarelo' : 'verde';
      if (l.margem != null) niveisContados.push(pior);
      cards.c.push(cardHTML('lucro', { label: 'Lucro e folga de segurança', sev: l.margem != null ? pior : 'neutro',
        val: 'Margem ' + pct0(l.margem),
        nota: l.folga != null ? `Folga de ${pct0(l.folga)} sobre o mínimo (${fmt(l.pontoEquilibrio)}/mês).` : '', modulo: 'DRE' }));

      // Meta de entrada do mês (Análise de Receita) — sempre o mês corrente,
      // não muda com o seletor de período. Semáforo = RITMO (progresso ÷ fração do mês).
      const pr = receita && !receita.vazio && receita.meta && !receita.meta.erro ? receita.meta.progresso : null;
      if (pr) {
        const hoje = new Date();
        const fracao = hoje.getDate() / new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
        const progresso = pr.alvo > 0 ? 1 - pr.restante / pr.alvo : 1;
        const razao = fracao > 0 ? progresso / fracao : 1;
        const sevME = pr.batida || razao >= 0.9 ? 'verde' : razao >= 0.6 ? 'amarelo' : 'vermelho';
        niveisContados.push(sevME);
        cards.c.push(cardHTML('metaEntrada', { label: 'Meta de entrada do mês', sev: sevME,
          val: pr.batida ? '✅ batida' : 'faltam ' + fmt(pr.restante),
          nota: (pr.fechamentos != null ? `~${pr.fechamentos} fechamentos · ` : '') +
            `${receita.diasUteisRestantes ?? '–'} dias úteis · alvo: ${receita.meta.comLucro ? 'lucro desejado' : 'empatar o mês'}`,
          modulo: 'Análise de Receita', href: '/financeiro/receita/' }));
      } else {
        cards.c.push(cardHTML('metaEntrada', { label: 'Meta de entrada do mês', sev: 'neutro', val: '–',
          nota: 'Sem análise ainda — abra a Análise de Receita e clique em Atualizar dados.',
          modulo: 'Análise de Receita', href: '/financeiro/receita/' }));
      }

      const sevInad = inad.pct != null ? P.semInadimplencia(inad.pct) : 'neutro';
      if (inad.pct != null) niveisContados.push(sevInad);
      cards.c.push(cardHTML('inadimplencia', { label: 'Inadimplência', sev: sevInad, val: pct0(inad.pct),
        nota: (inad.vencido ? `${fmt(inad.vencido)} vencidos da carteira a receber.` : '') +
          (inad.real ? ` Real (parou de pagar e de vir, fez mais que pagou): ${fmt(inad.real.vencidoA)} vencido · exposição ${fmt(inad.real.exposicaoB)}.` : ''),
        modulo: 'A Receber / A Pagar' }));
    }
    if (abc) {
      niveisContados.push('amarelo');
      cards.c.push(cardHTML('retencao', { label: 'Retenção de pacientes', sev: 'amarelo', val: String(abc.total ?? '–'),
        nota: 'Pacientes com prevenção vencida — voltam por quase nada.', modulo: 'Retorno de Prevenção' }));
    }

    const r = P.resumo(niveisContados);
    root.innerHTML = `
      <div class="pg-head">
        <div><h1 style="margin:0">🎯 Painel do Gestor</h1>
          <div style="color:var(--muted);font-size:13px;margin-top:2px">Os indicadores-chave da clínica, do marketing ao lucro</div></div>
        <div class="pg-saude">
          <span class="pg-chip"><span class="pg-dot verde"></span>${r.verdes} saudáveis</span>
          <span class="pg-chip"><span class="pg-dot amarelo"></span>${r.amarelos} de atenção</span>
          <span class="pg-chip"><span class="pg-dot vermelho"></span>${r.vermelhos} críticos</span>
        </div>
      </div>
      <div class="pg-periodo">
        ${PRESETS.map(p => `<button class="pg-per ${p.k === estado.preset ? 'on' : ''}" data-preset="${p.k}">${p.l}</button>`).join('')}
        <span class="pg-per-custom">
          <input type="date" id="pg-de" value="${estado.preset === 'custom' ? estado.from : ''}">
          <input type="date" id="pg-ate" value="${estado.preset === 'custom' ? estado.to : ''}">
          <button class="pg-per ${estado.preset === 'custom' ? 'on' : ''}" id="pg-per-aplicar">Aplicar</button>
        </span>
      </div>
      <div class="pg-jornada">O caminho do dinheiro: <b>atrair</b> um paciente barato → <b>convertê-lo</b> em tratamento e entregar → transformar em <b>lucro que fica</b>.</div>
      <div class="pg-bloco"><div class="pg-eyebrow">Elo 1</div><h2>Atrair pacientes</h2><div class="pg-desc">O marketing traz gente certa a um custo que se paga?</div><div class="pg-grid">${cards.a.join('')}</div></div>
      <div class="pg-bloco"><div class="pg-eyebrow">Elo 2</div><h2>Converter e entregar</h2><div class="pg-desc">Quem chega vira tratamento fechado — e a agenda está cheia?</div>${funilBlock}<div class="pg-grid">${cards.b.join('')}</div></div>
      <div class="pg-bloco"><div class="pg-eyebrow">Elo 3</div><h2>Ganhar e sustentar</h2><div class="pg-desc">No fim, sobra dinheiro — e ele entra e se renova?</div><div class="pg-grid">${cards.c.join('')}</div></div>`;
    root.dataset.init = '1';
  };

  // seletor de período
  document.addEventListener('click', (e) => {
    const pb = e.target.closest('.pg-per[data-preset]');
    if (pb) { estado.preset = pb.dataset.preset; const p = periodoDatas(estado.preset);
      estado.from = p.from; estado.to = p.to; window.loadPainelGestor(); return; }
    const ap = e.target.closest('#pg-per-aplicar');
    if (ap) {
      const de = document.getElementById('pg-de').value, ate = document.getElementById('pg-ate').value;
      if (!de || !ate || de > ate) { alert('Escolha um período válido (de ≤ até).'); return; }
      estado.preset = 'custom'; estado.from = de; estado.to = ate; window.loadPainelGestor();
    }
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.pg-ent'); if (!btn) return;
    const box = document.getElementById(btn.dataset.alvo); if (!box) return;
    const ab = box.classList.toggle('aberto'); btn.textContent = (ab ? '▾ ' : '▸ ') + 'entenda';
  });
})();
