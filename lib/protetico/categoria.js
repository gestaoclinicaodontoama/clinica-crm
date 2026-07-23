'use strict';
// Normalização de descrições de serviços protéticos → categoria canônica comparável.
// Matching por inclusão, sem acento/caixa; prioridade explícita (menor = mais forte)
// e, dentro da mesma prioridade, o padrão mais longo ganha.

const CATEGORIAS = [
  'Coroa unitária', 'Protocolo', 'Prótese total', 'Prótese parcial', 'Provisório',
  'Placa de bruxismo', 'Modelo/acessório', 'Enceramento', 'Reparo', 'Outros',
];

// prio 0 = reparo (vence tudo) · 1 = compostos fortes · 2 = tipos de prótese · 3 = acessórios/genéricos · 4 = coroa
const PADROES_SEED = [
  { padrao: 'reparo', categoria: 'Reparo', prio: 0 },
  { padrao: 'conserto', categoria: 'Reparo', prio: 0 },
  { padrao: 'protocolo', categoria: 'Protocolo', prio: 1 },
  { padrao: 'modelo digital', categoria: 'Modelo/acessório', prio: 1 },
  { padrao: 'pt imediata', categoria: 'Prótese total', prio: 2 },
  { padrao: 'protese total', categoria: 'Prótese total', prio: 2 },
  { padrao: 'roach', categoria: 'Prótese parcial', prio: 2 },
  { padrao: 'parcial', categoria: 'Prótese parcial', prio: 2 },
  { padrao: 'placa', categoria: 'Placa de bruxismo', prio: 2 },
  { padrao: 'plano de cera', categoria: 'Modelo/acessório', prio: 2 },
  { padrao: 'enceramento', categoria: 'Enceramento', prio: 2 },
  { padrao: 'provisor', categoria: 'Provisório', prio: 3 },
  { padrao: 'pmma', categoria: 'Provisório', prio: 3 },
  { padrao: 'link cad', categoria: 'Modelo/acessório', prio: 3 },
  { padrao: 'analogo', categoria: 'Modelo/acessório', prio: 3 },
  { padrao: 'tbase', categoria: 'Modelo/acessório', prio: 3 },
  { padrao: 'muralha', categoria: 'Modelo/acessório', prio: 3 },
  { padrao: 'parafuso', categoria: 'Modelo/acessório', prio: 3 },
  { padrao: 'coroa', categoria: 'Coroa unitária', prio: 4 },
  { padrao: 'cmc', categoria: 'Coroa unitária', prio: 4 },
  { padrao: 'zirconia', categoria: 'Coroa unitária', prio: 4 },
  { padrao: 'dissilicato', categoria: 'Coroa unitária', prio: 4 },
  { padrao: 'e-max', categoria: 'Coroa unitária', prio: 4 },
  { padrao: 'emax', categoria: 'Coroa unitária', prio: 4 },
  { padrao: 'onlay', categoria: 'Coroa unitária', prio: 4 },
  { padrao: 'c/impl', categoria: 'Coroa unitária', prio: 4 },
  { padrao: 'rest', categoria: 'Coroa unitária', prio: 4 },
  { padrao: 'resina impressa', categoria: 'Coroa unitária', prio: 4 },
];

function norm(s) {
  return String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// padroes: [{padrao, categoria, prio?}] — prio ausente (catálogo editado pelo usuário) = 3
function resolverCategoria(descricao, padroes) {
  const d = norm(descricao);
  if (!d) return 'Outros';
  const ordenados = [...(padroes || [])].sort((a, b) =>
    ((a.prio ?? 3) - (b.prio ?? 3)) || (norm(b.padrao).length - norm(a.padrao).length));
  for (const p of ordenados) {
    const alvo = norm(p.padrao);
    if (alvo && d.includes(alvo)) return p.categoria;
  }
  return 'Outros';
}

module.exports = { resolverCategoria, PADROES_SEED, CATEGORIAS, norm };
