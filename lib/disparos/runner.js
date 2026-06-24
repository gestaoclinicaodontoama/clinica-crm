// Runner de disparo em massa. Processa contatos 'pendente' de uma campanha,
// ~1 envio a cada PAUSA_MS, persistindo estado por contato (resiliente a restart).
const { resolverLead } = require('./matching');
const { templateIndisponivel } = require('./erro-template');

const PAUSA_MS = 2500;
const emExecucao = new Set(); // campanhas rodando neste processo (anti-duplo-start)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// criarLeadLeve: espelha o shape do insert de /api/leads em server.js.
function makeCriarLeadLeve(supabase) {
  return async function criarLeadLeve(contato, nomeCampanha) {
    const { data, error } = await supabase.from('leads').insert({
      nome: contato.nome || contato.primeiro_nome,
      telefone: contato.telefone,
      email: '', origem: 'disparo-csv',
      campanha: '', conteudo: '', fbclid: '', gclid: '', ctwa_clid: '',
      status: 'Lead', valor: null, tipo_trat: '',
      notas_sdr: '', notas_avaliacao: '', notas_comercial: '',
      score_interesse: null, perfil_disc: '',
      etiquetas: nomeCampanha ? [nomeCampanha] : [],
      proximo_contato: null, ultimo_contato: null,
      enviado_meta: false, enviado_google: false, eventos_meta_enviados: [],
    }).select('id').single();
    if (error) throw error;
    return data;
  };
}

// Inicia o runner de uma campanha. Retorna imediatamente (roda solto).
// deps = { supabase, whatsapp, logEvento }.
function iniciarRunner(campanhaId, deps) {
  if (emExecucao.has(campanhaId)) return;
  emExecucao.add(campanhaId);
  _loop(campanhaId, deps)
    .catch(e => console.error('❌ runner', campanhaId, e.message))
    .finally(() => emExecucao.delete(campanhaId));
}

async function _loop(campanhaId, deps) {
  const { supabase, whatsapp, logEvento } = deps;
  const criarLeadLeve = makeCriarLeadLeve(supabase);

  const { data: camp } = await supabase.from('disparos_campanhas')
    .select('*').eq('id', campanhaId).maybeSingle();
  if (!camp) return;

  while (true) {
    // Re-checa status a cada iteracao (permite pausar).
    const { data: atual } = await supabase.from('disparos_campanhas')
      .select('status').eq('id', campanhaId).maybeSingle();
    if (!atual || atual.status !== 'enviando') return;

    const { data: pend } = await supabase.from('disparos_contatos')
      .select('*').eq('campanha_id', campanhaId).eq('status', 'pendente')
      .order('id').limit(1);
    const contato = pend && pend[0];
    if (!contato) {
      await supabase.from('disparos_campanhas')
        .update({ status: 'concluida', concluida_em: new Date().toISOString() })
        .eq('id', campanhaId);
      return;
    }

    try {
      const { lead_id } = await resolverLead(supabase, contato, camp.nome, criarLeadLeve);
      const variaveis = Array.isArray(contato.variaveis) && contato.variaveis.length
        ? contato.variaveis : [contato.primeiro_nome || 'tudo bem'];
      const resultado = await whatsapp.enviarBroadcast({
        para: contato.telefone, templateName: camp.template_nome,
        lang: camp.lang, variaveis,
        phoneNumberId: camp.wa_number_id || undefined,
      });
      const waId = resultado?.messages?.[0]?.id || '';

      await supabase.from('mensagens').insert({
        lead_id, direcao: 'enviada', canal: 'broadcast',
        texto: '[disparo: ' + camp.template_nome + ']',
        wa_id: waId, wa_number_id: camp.wa_number_id || whatsapp.broadcastPhoneId() || '',
      });
      await supabase.from('disparos_contatos').update({
        lead_id, status: 'enviado', wa_id: waId, erro: null,
        enviado_em: new Date().toISOString(),
      }).eq('id', contato.id);
      await supabase.from('leads')
        .update({ ultimo_contato: new Date().toISOString() }).eq('id', lead_id);
      camp.enviados = camp.enviados + 1;
      await supabase.from('disparos_campanhas')
        .update({ enviados: camp.enviados }).eq('id', campanhaId);

      logEvento(lead_id, 'disparo_massa', 'Disparo enviado: ' + camp.template_nome,
        { campanha_id: campanhaId, template: camp.template_nome }, camp.criado_por || null);
    } catch (e) {
      // Template indisponível neste número (WABA diferente): pausa a campanha
      // inteira preservando os 'pendente', em vez de queimar todos os contatos.
      if (templateIndisponivel(e)) {
        const motivo = 'Template "' + camp.template_nome + '" indisponível no número escolhido — verifique a WABA. ' + String(e.message || e);
        await supabase.from('disparos_contatos').update({
          status: 'falha', erro: motivo.slice(0, 300),
        }).eq('id', contato.id);
        await supabase.from('disparos_campanhas')
          .update({ status: 'pausada', auto_pausada: true, falhas: camp.falhas + 1 })
          .eq('id', campanhaId);
        console.error('⛔ disparo pausado (template indisponível) campanha', campanhaId, e.message);
        return; // encerra o loop; usuário troca o número e Retoma
      }
      await supabase.from('disparos_contatos').update({
        status: 'falha', erro: String(e.message || e).slice(0, 300),
      }).eq('id', contato.id);
      camp.falhas = camp.falhas + 1;
      await supabase.from('disparos_campanhas')
        .update({ falhas: camp.falhas }).eq('id', campanhaId);
      console.warn('⚠️ disparo falhou contato', contato.id, e.message);
    }

    await sleep(PAUSA_MS);
  }
}

// No boot: campanhas 'enviando' orfas viram 'pausada' + auto_pausada (avisa o usuario).
async function recuperarOrfas(supabase) {
  const { error } = await supabase.from('disparos_campanhas')
    .update({ status: 'pausada', auto_pausada: true }).eq('status', 'enviando');
  if (error) console.error('❌ recuperarOrfas:', error.message);
}

module.exports = { iniciarRunner, recuperarOrfas, PAUSA_MS };
