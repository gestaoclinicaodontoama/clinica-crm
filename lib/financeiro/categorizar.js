const { nucleo, tokens, deacc } = require('./normalizar');

// Cria um categorizador a partir de regras (exato/keyword) e pessoas.
// Ordem das camadas: exato → pessoa → keyword (do mais específico ao mais genérico).
function criarCategorizador({ regras = [], pessoas = [], limiar = 1 }) {
  const exatos = new Map();
  const keywords = new Map(); // token → [{conta_codigo, peso}]
  for (const r of regras) {
    if (r.metodo === 'exato') exatos.set(r.padrao, r.conta_codigo);
    else if (r.metodo === 'keyword') {
      const arr = keywords.get(r.padrao) || [];
      arr.push({ conta: r.conta_codigo, peso: r.peso || 1 });
      keywords.set(r.padrao, arr);
    }
  }
  const pessoasNorm = pessoas
    .filter(p => p.conta_codigo)
    .map(p => ({ nome: deacc(p.nome).toLowerCase(), conta: p.conta_codigo }));

  return function categorizar(descricao) {
    // 1. exato
    const nuc = nucleo(descricao);
    if (exatos.has(nuc)) return { conta_codigo: exatos.get(nuc), metodo: 'exato' };

    // 2. pessoa (nome como palavra inteira no núcleo)
    for (const p of pessoasNorm) {
      const re = new RegExp(`\\b${p.nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (re.test(nuc)) return { conta_codigo: p.conta, metodo: 'pessoa' };
    }

    // 3. keyword com votação + limiar
    const score = new Map();
    for (const t of tokens(descricao)) {
      for (const { conta, peso } of (keywords.get(t) || [])) {
        score.set(conta, (score.get(conta) || 0) + peso);
      }
    }
    if (score.size) {
      const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
      const [conta, top] = ranked[0];
      const segundo = ranked[1]?.[1] || 0;
      if (top >= limiar && top > segundo) return { conta_codigo: conta, metodo: 'regra' };
    }
    return { conta_codigo: null, metodo: null };
  };
}

module.exports = { criarCategorizador };
