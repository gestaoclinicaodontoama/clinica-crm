// lib/nfse/emitir.js — orquestra a fila: Pendente → Processando → Emitida/Erro.
// Regra de ouro: SÓ marca Emitida com numero + codigo de verificacao na mão.
// Timeout/queda → fica Processando; reconciliarProcessando consulta por RPS antes de reenviar.
const { montarGerarNfseEnvio, montarConsultarNfsePorRpsEnvio } = require('./montar-xml');
const { chamarWs, parseGerarNfse, parseConsultarPorRps, NfseComunicacaoError } = require('./cliente');
const { uploadNota } = require('./drive');

let _assinar = null;
try { _assinar = require('./assinar'); } catch { /* assinatura não instalada (POC dispensou) */ }

const _job = { rodando: false, processadas: 0, erros: 0, log: [] };
function statusJob() { return { ..._job, log: _job.log.slice(-200) }; }
function _log(msg) {
  _job.log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
  if (_job.log.length > 500) _job.log.splice(0, _job.log.length - 500);
}

function _ambiente() { return process.env.NFSE_AMBIENTE === 'producao' ? 'producao' : 'homologacao'; }

function _linkDanfse(numero, codigoVerificacao) {
  // URL pública confirmada na POC (docs/superpowers/specs/2026-07-09-nfse-poc-achados.md).
  // Se a POC concluiu que não há acesso público, retornar '' (Drive cobre o PDF).
  const base = process.env.NFSE_DANFSE_URL || '';
  if (!base) return '';
  return base.replace('{numero}', encodeURIComponent(numero)).replace('{codigo}', encodeURIComponent(codigoVerificacao || ''));
}

function _logAvisos(prefixo, avisos) {
  if (avisos && avisos.length) _log(`${prefixo} avisos da prefeitura: ${avisos.map((a) => `${a.codigo}: ${a.mensagem}`).join(' | ')}`);
}

/** Update em notas_fiscais com checagem de erro. Nunca lança; retorna true se gravou. */
async function _upd(supabase, id, patch) {
  const { error } = await supabase.from('notas_fiscais').update(patch).eq('id', id);
  if (error) { _log(`⚠️ falha ao gravar nota #${id}: ${error.message}`); return false; }
  return true;
}

async function _prepararXml(nota, emissor, rpsNumero) {
  let xml = montarGerarNfseEnvio(nota, emissor, { numero: rpsNumero, serie: nota.rps_serie || '1' });
  const cert = _assinar && _assinar.carregarCertificado(emissor.sistema);
  if (cert) xml = _assinar.assinarXml(xml, { ...cert, referenciaUri: `rps${rpsNumero}` });
  return xml;
}

/** Processa UMA nota. Exportada para teste. opts.chamarWsImpl injeta o transporte.
 *  Contrato de erro: NfseComunicacaoError → nota fica Processando (reconciliador resolve);
 *  qualquer OUTRO erro (nota inválida, montagem, assinatura) → nota vai a Erro e o lote continua. */
async function _processarUma(supabase, nota, emissor, opts = {}) {
  const ws = opts.chamarWsImpl || chamarWs;
  // 1) reserva RPS (reutiliza se a nota já tem um, ex.: reprocesso de Erro)
  let rpsNumero = nota.rps_numero;
  if (!rpsNumero) {
    const { data, error } = await supabase.rpc('nf_reservar_rps', { p_sistema: nota.sistema });
    if (error || data == null) {
      const msg = error?.message || 'sequência não retornou número';
      _log(`#${nota.id} falha ao reservar RPS: ${msg}`);
      // permanece Pendente (retenta no próximo lote), mas com rastro durável na nota
      await _upd(supabase, nota.id, { erro_msg: `falha ao reservar RPS: ${msg}`.slice(0, 500) });
      return { ok: false };
    }
    rpsNumero = data;
  }

  let xmlEnvio, xmlResp;
  try {
    xmlEnvio = await _prepararXml(nota, emissor, rpsNumero);
    await _upd(supabase, nota.id, {
      status: 'Processando', rps_numero: rpsNumero, ambiente: _ambiente(), xml_envio: xmlEnvio,
    });
    xmlResp = await ws('GerarNfse', xmlEnvio);
  } catch (e) {
    if (e instanceof NfseComunicacaoError) {
      _log(`#${nota.id} comunicação falhou (${e.message}) — fica Processando p/ reconciliar`);
      await _upd(supabase, nota.id, { status: 'Processando', erro_msg: `aguardando reconciliação: ${e.message}` });
      return { ok: false, pendenteReconciliacao: true };
    }
    // nota inválida / falha de montagem ou assinatura: Erro NESTA nota, lote segue.
    // rps_numero é persistido p/ o reprocesso reutilizar a mesma reserva.
    const msg = String(e.message || e);
    _log(`#${nota.id} ❌ erro ao montar/enviar: ${msg}`);
    await _upd(supabase, nota.id, { status: 'Erro', erro_msg: msg.slice(0, 500), rps_numero: rpsNumero });
    return { ok: false };
  }

  const r = parseGerarNfse(xmlResp);
  if (r.ok && r.numero && r.codigoVerificacao) {
    _logAvisos(`#${nota.id}`, r.avisos);
    const gravou = await _upd(supabase, nota.id, {
      status: 'Emitida', num_nota: String(r.numero), codigo_verificacao: r.codigoVerificacao,
      data_emissao: r.dataEmissao || new Date().toISOString(), xml_envio: xmlEnvio, xml_retorno: xmlResp,
      caminho_pdf: _linkDanfse(r.numero, r.codigoVerificacao), erro_msg: '',
    });
    if (!gravou) {
      // A nota EXISTE na prefeitura mas o banco não gravou. A linha segue Processando
      // (do update anterior) — o reconciliador fecha depois. Conta como erro p/ ficar visível.
      _log(`⚠️ nota #${nota.id} EMITIDA na prefeitura (numero ${r.numero}) mas falha ao gravar — reconciliação fecha depois`);
      return { ok: false, pendenteReconciliacao: true };
    }
    _log(`#${nota.id} ✅ Emitida — nota ${r.numero}`);
    uploadNota(supabase, {
      ...nota, num_nota: String(r.numero), xml_retorno: xmlResp,
      caminho_pdf: _linkDanfse(r.numero, r.codigoVerificacao),
    }, emissor).catch(() => {}); // best-effort: nunca atrasa/derruba a emissão
    return { ok: true, numero: r.numero };
  }
  const msg = (r.erros || []).map((e) => `${e.codigo}: ${e.mensagem}`).join(' | ') || 'retorno sem número/código';
  await _upd(supabase, nota.id, { status: 'Erro', erro_msg: msg.slice(0, 500), xml_envio: xmlEnvio, xml_retorno: xmlResp });
  _log(`#${nota.id} ❌ ${msg}`);
  return { ok: false };
}

async function _carregarEmissores(supabase) {
  const { data, error } = await supabase.from('nf_emissores').select('*').eq('ativo', true).limit(10);
  if (error) throw new Error(`nf_emissores: ${error.message}`);
  return Object.fromEntries((data || []).map((e) => [e.sistema, e]));
}

async function processarPendentes(supabase, { onLog, chamarWsImpl } = {}) {
  if (_job.rodando) return { emitidas: 0, erros: 0, detalhes: [], jaRodando: true };
  _job.rodando = true; _job.processadas = 0; _job.erros = 0; _job.log = [];
  try {
    const emissores = await _carregarEmissores(supabase);
    const { data: notas, error } = await supabase.from('notas_fiscais').select('*')
      .eq('status', 'Pendente').in('sistema', Object.keys(emissores)).order('id').limit(500);
    if (error) throw new Error(error.message);
    _log(`${(notas || []).length} pendentes (ambiente: ${_ambiente()})`);
    const detalhes = [];
    for (const nota of notas || []) {
      let r;
      try {
        r = await _processarUma(supabase, nota, emissores[nota.sistema], { chamarWsImpl });
      } catch (e) {
        // último recurso: nenhuma exceção derruba o lote
        _log(`#${nota.id} ❌ erro inesperado no processamento: ${e.message}`);
        r = { ok: false };
      }
      if (r.ok) _job.processadas++; else _job.erros++;
      detalhes.push({ id: nota.id, ...r });
      if (onLog) onLog(statusJob());
    }
    await reconciliarProcessando(supabase, { emissoresPorSistema: emissores, chamarWsImpl });
    return { emitidas: _job.processadas, erros: _job.erros, detalhes };
  } finally {
    _job.rodando = false;
  }
}

async function reconciliarProcessando(supabase, opts = {}) {
  const ws = opts.chamarWsImpl || chamarWs;
  const emissores = opts.emissoresPorSistema || (await _carregarEmissores(supabase));
  const { data: presas, error } = await supabase.from('notas_fiscais').select('*').eq('status', 'Processando').limit(100);
  if (error) throw new Error(error.message);
  let fechadas = 0, voltaram = 0;
  for (const nota of presas || []) {
    const emissor = emissores[nota.sistema];
    if (!emissor || !nota.rps_numero) continue;
    let resp;
    try {
      resp = await ws('ConsultarNfsePorRps', montarConsultarNfsePorRpsEnvio({ rpsNumero: nota.rps_numero, rpsSerie: nota.rps_serie || '1', emissor }));
    } catch (e) {
      _log(`#${nota.id} reconciliação falhou (${e.message}) — segue presa`);
      continue; // segue presa; próximo reconcilio tenta de novo
    }
    const r = parseConsultarPorRps(resp);
    if (r.existe && r.numero && r.codigoVerificacao) {
      _logAvisos(`#${nota.id}`, r.avisos);
      await _upd(supabase, nota.id, {
        status: 'Emitida', num_nota: String(r.numero), codigo_verificacao: r.codigoVerificacao,
        data_emissao: r.dataEmissao || new Date().toISOString(), xml_retorno: resp,
        caminho_pdf: _linkDanfse(r.numero, r.codigoVerificacao), erro_msg: '',
      });
      fechadas++;
      _log(`#${nota.id} ✅ reconciliada — Emitida (nota ${r.numero})`);
      uploadNota(supabase, {
        ...nota, num_nota: String(r.numero), xml_retorno: resp,
        caminho_pdf: _linkDanfse(r.numero, r.codigoVerificacao),
      }, emissor).catch(() => {}); // best-effort: nunca atrasa/derruba a reconciliação
    } else if (r.existe) {
      // InfNfse presente mas sem numero/codigo: NUNCA marcar Emitida às cegas.
      // Não tocar na linha — segue Processando e o próximo reconcilio tenta de novo.
      _log(`⚠️ consulta RPS retornou InfNfse malformado (nota #${nota.id}) — mantida Processando`);
    } else {
      await _upd(supabase, nota.id, { status: 'Pendente', erro_msg: '' });
      voltaram++;
      _log(`#${nota.id} não encontrada na prefeitura — volta a Pendente`);
    }
  }
  return { fechadas, voltaram };
}

module.exports = { processarPendentes, reconciliarProcessando, statusJob, _processarUma };
