const MS_MIN = 60000;

function _dentro(iso, periodo) {
  const t = new Date(iso).getTime();
  return t >= new Date(periodo.from).getTime() && t <= new Date(periodo.to).getTime();
}

function montarMonitorCrc({ periodo, eventos = [], recebidas = [], ligacoes = [], esperasAbertas = [] }) {
  const porCrc = new Map();
  const crc = (id) => {
    if (!porCrc.has(id)) porCrc.set(id, {
      usuario_id: id, conversasSet: new Set(), mensagens: 0, templates: 0,
      agendamentos: 0, movimentacoes: { total: 0, porDestino: {} },
      ligacoes: { total: 0, atendidas: 0 }, anotacoes: 0,
      respostas: 0, esperaMsTotal: 0,
    });
    return porCrc.get(id);
  };

  for (const e of eventos) {
    if (!e.usuario_id || !_dentro(e.criado_em, periodo)) continue;
    const c = crc(e.usuario_id);
    if (e.tipo === 'mensagem_enviada') { c.mensagens++; c.conversasSet.add(e.lead_id); }
    else if (e.tipo === 'template_enviado') { c.templates++; c.conversasSet.add(e.lead_id); }
    else if (e.tipo === 'status_mudou') {
      const para = (e.metadata && e.metadata.para) || '?';
      c.movimentacoes.total++;
      c.movimentacoes.porDestino[para] = (c.movimentacoes.porDestino[para] || 0) + 1;
      if (para === 'Avaliação agendada') c.agendamentos++;
    }
    else if (e.tipo === 'nota_sdr_editada') c.anotacoes++;
  }

  for (const l of ligacoes) {
    if (!l.usuario_id) continue;
    const c = crc(l.usuario_id);
    c.ligacoes.total++;
    if ((l.duracao_segundos || 0) > 0) c.ligacoes.atendidas++;
  }

  const respPorLead = new Map();
  for (const e of eventos) {
    if (e.tipo !== 'mensagem_enviada' && e.tipo !== 'template_enviado') continue;
    if (!respPorLead.has(e.lead_id)) respPorLead.set(e.lead_id, []);
    respPorLead.get(e.lead_id).push(e);
  }
  for (const arr of respPorLead.values()) arr.sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em));
  const recPorLead = new Map();
  for (const r of recebidas) {
    if (!recPorLead.has(r.lead_id)) recPorLead.set(r.lead_id, []);
    recPorLead.get(r.lead_id).push(r);
  }
  for (const [leadId, recs] of recPorLead) {
    recs.sort((a, b) => new Date(a.criada_em) - new Date(b.criada_em));
    const resps = respPorLead.get(leadId) || [];
    let ri = 0, pendente = null;
    const fechar = (resp) => {
      if (resp.usuario_id) {
        const c = crc(resp.usuario_id);
        c.respostas++;
        c.esperaMsTotal += new Date(resp.criado_em).getTime() - pendente;
      }
      pendente = null;
    };
    for (const rec of recs) {
      const t = new Date(rec.criada_em).getTime();
      while (ri < resps.length && new Date(resps[ri].criado_em).getTime() < t) {
        if (pendente !== null) fechar(resps[ri]);
        ri++;
      }
      if (pendente === null) pendente = t;
    }
    while (ri < resps.length && pendente !== null) { fechar(resps[ri]); ri++; }
  }

  const lista = [...porCrc.values()].map(c => ({
    usuario_id: c.usuario_id,
    conversas: c.conversasSet.size,
    mensagens: c.mensagens,
    templates: c.templates,
    agendamentos: c.agendamentos,
    movimentacoes: c.movimentacoes,
    ligacoes: c.ligacoes,
    anotacoes: c.anotacoes,
    respostas: c.respostas,
    primeiraRespostaMediaMin: c.respostas ? Math.round(c.esperaMsTotal / c.respostas / MS_MIN) : null,
  })).sort((a, b) => b.conversas - a.conversas);

  const todosLeads = new Set();
  for (const c of porCrc.values()) for (const id of c.conversasSet) todosLeads.add(id);
  const soma = (k) => lista.reduce((s, c) => s + c[k], 0);
  const esperaTotal = [...porCrc.values()].reduce((s, c) => s + c.esperaMsTotal, 0);
  const respTotal = soma('respostas');

  return {
    porCrc: lista,
    time: {
      conversas: todosLeads.size,
      mensagens: soma('mensagens'),
      templates: soma('templates'),
      agendamentos: soma('agendamentos'),
      movimentacoes: lista.reduce((s, c) => s + c.movimentacoes.total, 0),
      ligacoes: {
        total: lista.reduce((s, c) => s + c.ligacoes.total, 0),
        atendidas: lista.reduce((s, c) => s + c.ligacoes.atendidas, 0),
      },
      anotacoes: soma('anotacoes'),
      respostas: respTotal,
      primeiraRespostaMediaMin: respTotal ? Math.round(esperaTotal / respTotal / MS_MIN) : null,
      semResposta: esperasAbertas,
    },
  };
}

function resumoCrcTexto(monitor, nomes, dataBR) {
  nomes = nomes || {};
  dataBR = dataBR || '';
  const t = monitor.time;
  const plural = (n, s, p) => n + ' ' + (n === 1 ? s : p);
  const cab = 'Resumo CRC ' + dataBR + ' — ' + plural(t.conversas, 'conversa', 'conversas') +
    ', ' + plural(t.agendamentos, 'agendamento', 'agendamentos') +
    ', ' + t.semResposta.length + ' sem resposta';
  const partes = monitor.porCrc.map(c => {
    const nome = (nomes[c.usuario_id] || 'CRC').split(' ')[0];
    return nome + ' ' + c.conversas + 'c/' + c.agendamentos + 'a';
  });
  return partes.length ? cab + ' | ' + partes.join(' · ') : cab;
}

module.exports = { montarMonitorCrc, resumoCrcTexto };
