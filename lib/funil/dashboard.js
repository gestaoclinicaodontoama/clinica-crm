// lib/funil/dashboard.js
// Orquestra as funções puras + IO num payload canônico único.
const { calcularFunil } = require('./conversao');
const { serieTemporal, porDiaSemana } = require('./series');
const { compararKpis } = require('./comparacao');
const eventosMod = require('./eventos');
const { montarCoorte } = eventosMod;

async function montarDashboard(sb, periodo, origem, deps = {}) {
  const buscarCoorte = deps.buscarCoorte || eventosMod.buscarCoorte;
  const buscarAtividade = deps.buscarAtividade || eventosMod.buscarAtividade;

  const atual = await buscarCoorte(sb, periodo.from, periodo.to);
  const anterior = await buscarCoorte(sb, periodo.anterior.from, periodo.anterior.to);
  // atividade = eventos cujo criado_em cai NO período (por data de evento, não coorte)
  const atividade = await buscarAtividade(sb, periodo.from, periodo.to);

  const cAtual = montarCoorte(atual.criados, atual.eventos, atual.origemPorLead, origem);
  const cAnterior = montarCoorte(anterior.criados, anterior.eventos, anterior.origemPorLead, origem);

  const funil = calcularFunil(cAtual.etapas);

  // série/dia-semana = atividade dos eventos NO período (não a coorte)
  const serie = { granularidade: periodo.granularidade, pontos: serieTemporal(atividade, periodo.granularidade) };
  const por_dia_semana = porDiaSemana(atividade);

  const comparacao = compararKpis(
    { leads: cAtual.kpis.leads, fechamentos: cAtual.kpis.fechamentos, venda: cAtual.kpis.venda },
    { leads: cAnterior.kpis.leads, fechamentos: cAnterior.kpis.fechamentos, venda: cAnterior.kpis.venda },
  );

  const origens = [...new Set([...atual.origemPorLead.values()].filter(Boolean))].sort();

  return { periodo, origem: origem || 'all', origens, funil, kpis: cAtual.kpis, comparacao, serie, por_dia_semana };
}

module.exports = { montarDashboard };
