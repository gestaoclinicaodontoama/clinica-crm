// lib/funil/series.js
// Série temporal (dia/semana) e quebra por dia da semana, a partir de eventos historico_*.
// Cada métrica conta eventos do tipo correspondente NAQUELE dia (atividade, não coorte).
const DOW = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

// extrai a data local de Brasília (YYYY-MM-DD) de qualquer ISO (o Supabase devolve em UTC).
// Converte o instante pra -03:00 antes de pegar a data, evitando off-by-one perto da meia-noite.
function diaLocal(iso) {
  return new Date(new Date(iso).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function dowLocal(iso) {
  const [y, m, d] = diaLocal(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function semanaLocal(iso) {
  const [y, m, d] = diaLocal(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  const seg = new Date(dt.getTime() - ((dow + 6) % 7) * 86400000); // segunda da semana
  return seg.toISOString().slice(0, 10);
}

const TIPO_METRICA = {
  historico_lead_criado: 'leads',
  historico_compareceu: 'comparecimentos',
  historico_fechou: 'fechamentos',
};

function serieTemporal(eventos, granularidade) {
  const chave = granularidade === 'semana' ? semanaLocal : diaLocal;
  const mapa = new Map();
  for (const e of eventos) {
    const metrica = TIPO_METRICA[e.tipo];
    if (!metrica) continue;
    const k = chave(e.criado_em);
    if (!mapa.has(k)) mapa.set(k, { data: k, leads: 0, comparecimentos: 0, fechamentos: 0 });
    mapa.get(k)[metrica]++;
  }
  return [...mapa.values()].sort((a, b) => (a.data < b.data ? -1 : 1));
}

function porDiaSemana(eventos) {
  const base = DOW.map(dia => ({ dia, leads: 0, fechamentos: 0 }));
  for (const e of eventos) {
    const i = dowLocal(e.criado_em);
    if (e.tipo === 'historico_lead_criado') base[i].leads++;
    else if (e.tipo === 'historico_fechou') base[i].fechamentos++;
  }
  // reordena seg..dom pra leitura comercial
  return [...base.slice(1), base[0]];
}

module.exports = { serieTemporal, porDiaSemana };
