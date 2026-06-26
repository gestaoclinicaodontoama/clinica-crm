// Etapas do funil expostas como "métricas" do painel de Qualidade de Lead.
// A ordem importa: METRICAS[0] é o default ("sem interesse"). `tom` decide a cor
// da pill no front (ruim = vermelho, bom = verde).
const METRICAS = [
  { key: 'sem_interesse', label: 'Sem interesse',       status: ['Perdido', 'Não tem Interesse'], tom: 'ruim' },
  { key: 'perdido',       label: 'Perdido',             status: ['Perdido'],                       tom: 'ruim' },
  { key: 'qualificacao',  label: 'Em qualificação',     status: ['Em qualificação'],               tom: 'bom'  },
  { key: 'agendada',      label: 'Avaliação agendada',  status: ['Avaliação agendada'],            tom: 'bom'  },
  { key: 'compareceu',    label: 'Compareceu',          status: ['Compareceu'],                    tom: 'bom'  },
  { key: 'negociacao',    label: 'Em negociação',       status: ['Em negociação'],                 tom: 'bom'  },
  { key: 'fechou',        label: 'Fechou',              status: ['Fechou'],                        tom: 'bom'  },
];

function metricaPorKey(key) {
  return METRICAS.find(m => m.key === key) || METRICAS[0];
}

function valorDaMetrica(porStatus, metrica) {
  return metrica.status.reduce((s, st) => s + ((porStatus && porStatus[st]) || 0), 0);
}

function rankCampanhas(campanhas, metricaKey, opts) {
  const { ordenarPor = 'volume', minLeads = 5 } = opts || {};
  const metrica = metricaPorKey(metricaKey);
  let rows = (campanhas || []).map((c, idx) => {
    const valor = valorDaMetrica(c.por_status, metrica);
    return Object.assign({}, c, { valor, taxa: c.total > 0 ? valor / c.total : 0, _idx: idx });
  }).filter(r => r.valor > 0);
  if (ordenarPor === 'taxa') {
    rows = rows.filter(r => r.total >= minLeads).sort((a, b) => (b.taxa - a.taxa) || (b.valor - a.valor) || (a._idx - b._idx));
  } else {
    rows.sort((a, b) => (b.valor - a.valor) || (a._idx - b._idx));
  }
  return rows.map(r => {
    const { _idx, ...rest } = r;
    return rest;
  });
}

module.exports = { METRICAS, metricaPorKey, valorDaMetrica, rankCampanhas };
