'use strict';
// Validação e derivação de uma nota protética + itens antes de gravar.
// Não toca no banco — puro e testável. Erros de payload = Error com status 400 (pt-BR).

const { resolverCategoria } = require('./categoria');

function erro400(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

function dataOuNull(v, campo) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!RE_DATA.test(s) || isNaN(Date.parse(s))) throw erro400(`Item com data inválida em ${campo}: "${v}" (use AAAA-MM-DD)`);
  return s;
}

function numero(v, campo) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.'));
  if (!isFinite(n)) throw erro400(`Item com ${campo} inválido: "${v}"`);
  return n;
}

function prepararNota({ laboratorio, referencia, periodo_inicio, periodo_fim, emitida_em, total_informado, origem, criado_por, itens, padroes }) {
  if (!String(laboratorio || '').trim()) throw erro400('Informe o laboratório.');
  if (!String(referencia || '').trim()) throw erro400('Informe a referência da nota (nº ou descrição).');
  if (!Array.isArray(itens) || itens.length === 0) throw erro400('A nota precisa de pelo menos um item.');
  const origemOk = ['seed', 'import', 'manual'].includes(origem) ? origem : 'import';

  const itensPreparados = itens.map((it, idx) => {
    const paciente = String(it.paciente_nome || '').trim();
    if (!paciente) throw erro400(`Item ${idx + 1} sem paciente.`);
    const descricao = String(it.descricao_original || '').trim();
    if (!descricao) throw erro400(`Item ${idx + 1} sem descrição do serviço.`);
    const quantidade = numero(it.quantidade ?? 1, 'quantidade');
    if (!Number.isInteger(quantidade) || quantidade <= 0) throw erro400(`Item ${idx + 1} com quantidade inválida: "${it.quantidade}"`);
    const valor = Math.round(numero(it.valor_total, 'valor') * 100) / 100;
    if (valor < 0) throw erro400(`Item ${idx + 1} com valor negativo.`);

    const dataEntrada = dataOuNull(it.data_entrada, 'data de entrada');
    const dataPrevista = dataOuNull(it.data_prevista, 'data prevista');
    const dataEntrega = dataOuNull(it.data_entrega, 'data de entrega');
    const categoria = resolverCategoria(descricao, padroes);

    return {
      paciente_nome: paciente,
      dentista_nome: String(it.dentista_nome || '').trim() || null,
      descricao_original: descricao,
      categoria,
      dente: String(it.dente || '').trim() || null,
      quantidade,
      valor_total: valor,
      data_entrada: dataEntrada,
      data_prevista: dataPrevista,
      data_entrega: dataEntrega,
      atrasado: (dataPrevista && dataEntrega) ? (dataEntrega > dataPrevista) : null,
      reparo: categoria === 'Reparo',
      conferir: Boolean(it.conferir),
    };
  });

  const avisos = [];
  const soma = Math.round(itensPreparados.reduce((s, i) => s + i.valor_total, 0) * 100) / 100;
  const totalInf = (total_informado == null || total_informado === '') ? null : numero(total_informado, 'total informado');
  if (totalInf != null && Math.abs(totalInf - soma) > 0.01) {
    avisos.push(`Total informado (R$ ${totalInf.toFixed(2)}) diverge da soma dos itens (R$ ${soma.toFixed(2)}).`);
  }

  const nota = {
    laboratorio: String(laboratorio).trim(),
    referencia: String(referencia).trim(),
    periodo_inicio: dataOuNull(periodo_inicio, 'período (início)'),
    periodo_fim: dataOuNull(periodo_fim, 'período (fim)'),
    emitida_em: dataOuNull(emitida_em, 'emissão'),
    total_informado: totalInf,
    origem: origemOk,
    criado_por: String(criado_por || '').trim() || null,
  };

  return { nota, itens: itensPreparados, avisos };
}

module.exports = { prepararNota };
