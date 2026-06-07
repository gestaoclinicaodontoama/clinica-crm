// lib/funil/periodo.js
// Resolve presets de período em limites ISO com fuso de Brasília (-03:00),
// + período anterior de mesma duração + granularidade do gráfico.
const TZ = '-03:00';

function ymd(d) {
  // componentes em UTC-3 (Brasília) sem libs externas
  const t = new Date(d.getTime() - 3 * 3600 * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), day: t.getUTCDate() };
}
function dateStr(y, m, day) {
  const mm = String(m + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}
function fromISO(s) { return `${s}T00:00:00${TZ}`; }
function toISO(s) { return `${s}T23:59:59${TZ}`; }
function addDaysStr(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return dateStr(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
}
function diffDays(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

function resolvePeriodo(preset, fromStr, toStr, now = new Date()) {
  const { y, m, day } = ymd(now);
  const hoje = dateStr(y, m, day);
  let from, to;

  if (preset === 'hoje') { from = hoje; to = hoje; }
  else if (preset === '7d') { from = addDaysStr(hoje, -6); to = hoje; }
  else if (preset === '30d') { from = addDaysStr(hoje, -29); to = hoje; }
  else if (preset === 'mes') { from = dateStr(y, m, 1); to = dateStr(y, m, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()); }
  else { from = fromStr; to = toStr; } // custom

  const dur = diffDays(from, to); // dias inclusivos = dur+1
  let antFrom, antTo;
  if (preset === 'mes') {
    const pm = m === 0 ? 11 : m - 1;
    const py = m === 0 ? y - 1 : y;
    antFrom = dateStr(py, pm, 1);
    antTo = dateStr(py, pm, new Date(Date.UTC(py, pm + 1, 0)).getUTCDate());
  } else {
    antTo = addDaysStr(from, -1);
    antFrom = addDaysStr(antTo, -dur);
  }

  const granularidade = dur > 60 ? 'semana' : 'dia';
  return {
    from: fromISO(from), to: toISO(to),
    anterior: { from: fromISO(antFrom), to: toISO(antTo) },
    granularidade, preset,
  };
}

module.exports = { resolvePeriodo };
