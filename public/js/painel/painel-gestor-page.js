// Painel do Gestor — página SPA (só admin/gestor). Junta 4 fontes já existentes:
// /api/painel-gestor (financeiro), /api/comercial/dashboard (funil),
// /api/meta-insights (marketing), /api/campanhas/preview/abc (prevenção).
// Cada fonte é tolerante a falha — uma quebrar não derruba as outras.
(function () {
  const P = window.PainelGestor;
  const META_FUNIL = { agendamento: 0.45, comparecimento: 0.50, fechamento: 0.25 };

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
    funil: { oque: 'A % de gente que passa de uma etapa pra próxima: lead → agendou → compareceu → fechou.',
      bom: 'Funil saudável ~40/40/30. Meta de vocês: 45/50/25.', ruim: 'Etapa abaixo da meta trava tudo que vem depois.',
      acoes: 'Agendamento: responder o lead rápido, script de agendamento. Fechamento: treinar a CRC em objeção e preço.' },
    ticket: { oque: 'Valor médio das vendas particulares aprovadas (convênio fora — margem baixa não entra na conta).',
      bom: 'Em tendência de alta.', ruim: 'Caindo, sinal de orçamentos fatiados ou desconto reflexo.',
      acoes: 'Oferecer plano completo, implante/alinhador, evitar fatiar o orçamento.' },
    ocupacao: { oque: 'Horas de agenda preenchidas ÷ horas disponíveis dos dentistas.',
      bom: 'Acima de 85%.', ruim: 'Cadeira vazia é receita que não volta.',
      acoes: 'Falta ligar à escala dos dentistas (dentista_config) para calcular de verdade — hoje incompleto.' },
    faturamento: { oque: 'O que foi vendido no mês (competência), com o crescimento vs o mesmo mês do ano anterior.',
      bom: 'Crescendo ano a ano e acima do ponto de equilíbrio.', ruim: 'Encolhendo vs o ano passado.',
      acoes: 'Sustentar o topo do funil e o ticket médio.' },
    lucro: { oque: 'Quanto sobra no fim (margem) e quanto a receita pode cair antes do prejuízo (folga sobre o ponto de equilíbrio).',
      bom: 'Margem acima de 15% e folga acima de 25%.', ruim: 'Margem fina = pouco colchão pra um mês ruim.',
      acoes: 'Atacar inadimplência e o funil, controlar custo variável e juros.' },
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

  function cardHTML(chave, { label, val, sev, trend, nota, modulo }) {
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
      <div class="pg-mod">${esc(modulo)}</div>
      <div class="pg-ent-box" id="${id}">${it('O que é', e.oque)}${it('Quando é bom', e.bom)}${it('Quando é ruim', e.ruim)}${it('Ações', e.acoes)}</div>
    </div>`;
  }

  function funilHTML(k) {
    const taxa = (a, b) => (b > 0 ? a / b : null);
    const etapas = [
      { q: k.leads, e: 'Leads' }, { q: k.agendados, e: 'Agendaram' },
      { q: k.compareceram, e: 'Compareceram' }, { q: k.fecharam, e: 'Fecharam' },
    ];
    const convs = [
      { taxa: taxa(k.agendados, k.leads), meta: META_FUNIL.agendamento },
      { taxa: taxa(k.compareceram, k.agendados), meta: META_FUNIL.comparecimento },
      { taxa: taxa(k.fecharam, k.compareceram), meta: META_FUNIL.fechamento },
    ];
    let flow = '';
    etapas.forEach((et, i) => {
      flow += `<div class="pg-etapa"><div class="q">${et.q ?? '–'}</div><div class="e">${et.e}</div></div>`;
      if (convs[i]) { const s = convs[i].taxa == null ? 'neutro' : P.semFunil(convs[i].taxa, convs[i].meta);
        flow += `<div class="pg-conv ${s}"><span class="s">→</span><span class="t">${pct0(convs[i].taxa)}</span><span class="a">meta ${pct0(convs[i].meta)}</span></div>`; }
    });
    const niveis = convs.map(c => c.taxa == null ? null : P.semFunil(c.taxa, c.meta)).filter(Boolean);
    const pior = niveis.includes('vermelho') ? 'vermelho' : niveis.includes('amarelo') ? 'amarelo' : 'verde';
    const nFraco = niveis.filter(n => n !== 'verde').length;
    const e = EXPLICA.funil;
    return `<div class="pg-funil" style="--x:0">
      <button class="pg-ent" data-alvo="pg-ent-funil">▸ entenda</button>
      <div class="pg-label">Funil comercial — onde se perde paciente (últimos 30 dias)</div>
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
    if (!root.dataset.init) { root.innerHTML = '<div class="pg-msg">Carregando indicadores…</div>'; }

    const [fin, com, mkt, abc] = await Promise.allSettled([
      get('/api/painel-gestor'),
      get('/api/comercial/dashboard?preset=30d'),
      get('/api/meta-insights').catch(() => null),
      get('/api/campanhas/preview/abc?count_only=true'),
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
    if (com && com.kpis) {
      funilBlock = funilHTML(com.kpis);
      const k = com.kpis, taxa = (a, b) => (b > 0 ? a / b : null);
      [taxa(k.agendados, k.leads) && P.semFunil(taxa(k.agendados, k.leads), META_FUNIL.agendamento),
       taxa(k.compareceram, k.agendados) && P.semFunil(taxa(k.compareceram, k.agendados), META_FUNIL.comparecimento),
       taxa(k.fecharam, k.compareceram) && P.semFunil(taxa(k.fecharam, k.compareceram), META_FUNIL.fechamento)]
        .forEach(n => n && niveisContados.push(n));
    } else {
      funilBlock = `<div class="pg-msg">Funil indisponível no momento.</div>`;
    }

    const tk = fin && fin.ticketSemConvenio;
    cards.b.push(cardHTML('ticket', { label: 'Ticket médio (sem convênio)', sev: 'neutro',
      val: tk ? fmt(tk.valor) : '–', nota: tk && tk.n ? `Média de ${tk.n} fechamentos particulares em 90 dias.` : 'Sem fechamentos no período.',
      modulo: 'Comercial' }));
    cards.b.push(cardHTML('ocupacao', { label: 'Ocupação da agenda', sev: 'neutro', val: 'a conectar',
      nota: 'Falta ligar à escala dos dentistas para calcular. Em breve.', modulo: 'Produção' }));

    // ── Elo 3: financeiro ──
    if (fin) {
      const f = fin.faturamento || {}, l = fin.lucro || {}, inad = fin.inadimplencia || {};
      const sevFat = f.crescimentoAnual != null ? P.semCrescimento(f.crescimentoAnual) : 'neutro';
      if (f.crescimentoAnual != null) niveisContados.push(sevFat);
      cards.c.push(cardHTML('faturamento', { label: 'Faturamento do mês', sev: sevFat, val: fmt(f.valor),
        trend: f.crescimentoAnual != null ? { ...trendGood(f.crescimentoAnual >= 0), t: pct0(Math.abs(f.crescimentoAnual)) + ' ao ano' } : null,
        nota: f.mes ? `Competência de ${mesPt(f.mes)} (último mês fechado).` : '', modulo: 'DRE' }));

      const sevM = l.margem != null ? P.semMargem(l.margem) : 'neutro';
      const sevFolga = l.folga != null ? P.semFolga(l.folga) : 'neutro';
      const pior = [sevM, sevFolga].includes('vermelho') ? 'vermelho' : [sevM, sevFolga].includes('amarelo') ? 'amarelo' : 'verde';
      if (l.margem != null) niveisContados.push(pior);
      cards.c.push(cardHTML('lucro', { label: 'Lucro e folga de segurança', sev: l.margem != null ? pior : 'neutro',
        val: 'Margem ' + pct0(l.margem),
        nota: l.folga != null ? `Folga de ${pct0(l.folga)} sobre o mínimo (${fmt(l.pontoEquilibrio)}/mês).` : '', modulo: 'DRE' }));

      const sevInad = inad.pct != null ? P.semInadimplencia(inad.pct) : 'neutro';
      if (inad.pct != null) niveisContados.push(sevInad);
      cards.c.push(cardHTML('inadimplencia', { label: 'Inadimplência', sev: sevInad, val: pct0(inad.pct),
        nota: inad.vencido ? `${fmt(inad.vencido)} vencidos da carteira a receber.` : '', modulo: 'A Receber / A Pagar' }));
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
      <div class="pg-jornada">O caminho do dinheiro: <b>atrair</b> um paciente barato → <b>convertê-lo</b> em tratamento e entregar → transformar em <b>lucro que fica</b>.</div>
      <div class="pg-bloco"><div class="pg-eyebrow">Elo 1</div><h2>Atrair pacientes</h2><div class="pg-desc">O marketing traz gente certa a um custo que se paga?</div><div class="pg-grid">${cards.a.join('')}</div></div>
      <div class="pg-bloco"><div class="pg-eyebrow">Elo 2</div><h2>Converter e entregar</h2><div class="pg-desc">Quem chega vira tratamento fechado — e a agenda está cheia?</div>${funilBlock}<div class="pg-grid">${cards.b.join('')}</div></div>
      <div class="pg-bloco"><div class="pg-eyebrow">Elo 3</div><h2>Ganhar e sustentar</h2><div class="pg-desc">No fim, sobra dinheiro — e ele entra e se renova?</div><div class="pg-grid">${cards.c.join('')}</div></div>`;
    root.dataset.init = '1';
  };

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.pg-ent'); if (!btn) return;
    const box = document.getElementById(btn.dataset.alvo); if (!box) return;
    const ab = box.classList.toggle('aberto'); btn.textContent = (ab ? '▾ ' : '▸ ') + 'entenda';
  });
})();
