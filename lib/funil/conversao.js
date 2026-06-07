// lib/funil/conversao.js
// Recebe etapas ordenadas [{id, rotulo, n}] (contagem em leads distintos) e
// devolve pct do topo + conversão da etapa anterior + flag de cobertura desigual + gargalo.
function pct(num, den) { return den > 0 ? num / den : 0; }

function calcularFunil(etapasBrutas) {
  const topo = etapasBrutas.length ? etapasBrutas[0].n : 0;
  const etapas = etapasBrutas.map((e, i) => {
    const anterior = i > 0 ? etapasBrutas[i - 1].n : null;
    const cobertura_suspeita = anterior !== null && e.n > anterior;
    let conv_etapa_anterior = null;
    if (i > 0) {
      conv_etapa_anterior = cobertura_suspeita ? 1 : pct(e.n, anterior);
    }
    return {
      id: e.id, rotulo: e.rotulo, n: e.n,
      pct_do_topo: pct(e.n, topo),
      conv_etapa_anterior,
      cobertura_suspeita,
    };
  });

  // gargalo = etapa (exceto topo) com menor conversão real (ignora as suspeitas)
  let gargalo = null;
  for (let i = 1; i < etapas.length; i++) {
    const e = etapas[i];
    if (e.cobertura_suspeita) continue;
    if (!gargalo || e.conv_etapa_anterior < gargalo.conv) {
      gargalo = { id: e.id, rotulo: e.rotulo, conv: e.conv_etapa_anterior };
    }
  }
  return { etapas, gargalo };
}

module.exports = { calcularFunil };
