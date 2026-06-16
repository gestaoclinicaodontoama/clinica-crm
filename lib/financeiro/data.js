// Converte timestamp ISO (UTC) para data/mês no fuso America/Sao_Paulo.
const TZ = 'America/Sao_Paulo';
const FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

function dataLocal(iso) {
  if (!iso) return null;
  return FMT.format(new Date(iso));       // en-CA → "YYYY-MM-DD"
}
function mesLocal(iso) {
  const d = dataLocal(iso);
  return d ? d.slice(0, 7) : null;        // "YYYY-MM"
}

module.exports = { dataLocal, mesLocal, TZ };
