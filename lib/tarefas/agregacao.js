// lib/tarefas/agregacao.js
// Funções puras de agregação para o dashboard de coletas.
// Recebem dados JÁ somados no SQL (poucas linhas) e calculam taxas/forma.

function somarLista(rows) {
  const obj = {};
  for (const r of (rows || [])) obj[r.chave] = Number(r.total) || 0;
  return obj;
}

function calcularConversoes(somas, conversoes) {
  if (!Array.isArray(conversoes)) return [];
  return conversoes.map(c => {
    const valor_de = Number(somas[c.de]) || 0;
    const valor_para = Number(somas[c.para]) || 0;
    const taxa = valor_de > 0 ? valor_para / valor_de : null;
    return { de: c.de, para: c.para, rotulo: c.rotulo, valor_de, valor_para, taxa };
  });
}

module.exports = { somarLista, calcularConversoes };
