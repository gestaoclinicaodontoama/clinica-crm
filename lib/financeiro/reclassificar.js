const { nucleo, deacc } = require('./normalizar');

// Dado um conjunto de lançamentos e uma regra, retorna os que ela deveria classificar
// (ignorando os override_manual).
function alvosDaRegra(lancs, regra) {
  const p = deacc(regra.padrao).toLowerCase();
  return lancs.filter(l => {
    if (l.override_manual) return false;
    const nuc = nucleo(l.descricao);
    if (regra.metodo === 'exato') return nuc === p;
    return new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(nuc);
  });
}

module.exports = { alvosDaRegra };
