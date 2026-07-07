const { CONTAS, GRUPOS_DRE, byCodigo } = require('./taxonomia');

// Recebe lançamentos {fluxo, valor, conta_codigo} → estrutura de DRE em cascata.
function montarDRE(lancs) {
  const porConta = new Map();      // codigo → soma (com sinal)
  for (const l of lancs) {
    if (!l.conta_codigo) continue;
    const sinal = l.fluxo === 'entra' ? 1 : -1;
    porConta.set(l.conta_codigo, (porConta.get(l.conta_codigo) || 0) + sinal * l.valor);
  }
  const r2 = (n) => Math.round(n * 100) / 100;

  const grupos = GRUPOS_DRE.map(g => {
    const contas = CONTAS
      .filter(c => c.grupo.startsWith(g.titulo.split(' - ')[0] + ' ') || c.grupo === g.titulo)
      .filter(c => porConta.has(c.codigo))
      .map(c => ({ codigo: c.codigo, nome: c.nome, total: r2(porConta.get(c.codigo)) }))
      .sort((a, b) => byCodigo(a.codigo).ordem - byCodigo(b.codigo).ordem);
    return { codigo: g.codigo, titulo: g.titulo, total: r2(contas.reduce((s, c) => s + c.total, 0)), contas };
  });

  const receita = grupos.find(g => g.codigo === '1')?.total || 0;
  // Grupo 9 (provisões) é reserva, não afeta o resultado — fica fora da soma.
  // (Grupo 8, distribuição, segue somado: `resultado` = resultado após distribuições.)
  const resultado = r2(grupos.filter(g => g.codigo !== '9').reduce((s, g) => s + g.total, 0));
  return { receita: r2(receita), grupos, resultado };
}

module.exports = { montarDRE };
