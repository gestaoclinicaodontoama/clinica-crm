// Fluxo futuro (a receber × a pagar) a partir do /financial/list_cash_flow.
// A resposta NÃO tem ano — cada item vem só com month:"July". A ordem é
// cronológica a partir do from; o ano é derivado andando um cursor de mês
// pelo NOME (tolera mês omitido pela API sem deslocar os seguintes).
const MESES_EN = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Janela [hoje, último dia do 24º mês à frente] em YYYY-MM-DD.
function janela24m(hojeISO) {
  const [y, m] = hojeISO.slice(0, 7).split('-').map(Number);
  const fim = new Date(Date.UTC(y, m - 1 + 25, 0)); // dia 0 do mês seguinte ao 24º
  return { from: hojeISO, to: fim.toISOString().slice(0, 10) };
}

function parseCashFlow(resposta, fromISO) {
  let [y, m] = fromISO.slice(0, 7).split('-').map(Number);
  const out = [];
  for (const item of (resposta || [])) {
    const alvo = MESES_EN.indexOf(item.month) + 1; // 1-12; 0 = nome desconhecido
    if (!alvo) continue;
    while (m !== alvo) { m++; if (m > 12) { m = 1; y++; } }
    out.push({
      mes: `${y}-${String(m).padStart(2, '0')}`,
      a_receber: Number(item.in_forecast) || 0,
      a_pagar: Number(item.out_forecast) || 0,
    });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function totais(meses) {
  const receber = meses.reduce((s, x) => s + x.a_receber, 0);
  const pagar = meses.reduce((s, x) => s + x.a_pagar, 0);
  return { receber, pagar, diferenca: receber - pagar };
}

module.exports = { parseCashFlow, janela24m, totais };
