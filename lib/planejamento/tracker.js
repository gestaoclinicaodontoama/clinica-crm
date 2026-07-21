// lib/planejamento/tracker.js — entrega ④: página pública do paciente. Lógica PURA (sem IO/Supabase):
// resumo do plano (progresso/sessões) + render HTML. A rota em server.js só faz as queries e chama aqui.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Primeiro nome p/ saudação: tira o sufixo "(id)" do FIM (padrão Clinicorp) e pega o 1º token. */
function primeiroNome(nome) {
  const limpo = String(nome || '').replace(/\s*\(\d+\)\s*$/, '').trim();
  return limpo.split(/\s+/)[0] || '';
}

const _conc = s => s === 'concluida' || s === 'concluida_retroativa';
const fmtData = iso => { const d = new Date(iso); return isNaN(d) ? null : d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }); };

/**
 * Progresso: etapas concluídas ÷ (todas as etapas + itens raiz sem NENHUMA etapa) —
 * item não detalhado conta 1 pendente (mesma filosofia do temItemSemEtapa da máquina de estados).
 * Etapa sintética (ordem 999 ou descricao == nome do procedimento) vira sessão sem descrição (só a data).
 * Etapas PENDENTES não são listadas (só contam no total) — não expor passo-a-passo futuro.
 */
function resumoTracker(raizes, fallbackExecutor) {
  let done = 0, total = 0;
  const procedimentos = (raizes || []).map(item => {
    const etapas = [...(item.plano_etapas || []), ...((item.sublotes || []).flatMap(s => s.plano_etapas || []))];
    const concluidas = etapas.filter(e => _conc(e.status));
    if (etapas.length) { total += etapas.length; done += concluidas.length; } else { total += 1; }
    const status = etapas.length && concluidas.length === etapas.length ? 'concluido'
      : (concluidas.length ? 'em_andamento' : 'a_fazer');
    const sessoes = concluidas
      .slice().sort((a, b) => String(a.concluida_em || '').localeCompare(String(b.concluida_em || '')))
      .map(e => ({
        descricao: (e.ordem === 999 || e.descricao === item.procedure_name) ? null : (e.descricao || null),
        data: e.concluida_em ? fmtData(e.concluida_em) : null,
      }));
    return { nome: item.procedure_name || '', status, executor: item.profissional_executor || fallbackExecutor || null, sessoes };
  });
  const pct = total ? Math.round((done / total) * 100) : 0;
  return { pct, procedimentos };
}

const ICONE = { concluido: '✅', em_andamento: '🔵', a_fazer: '⚪' };
const ROTULO = { concluido: 'Concluído', em_andamento: 'Em andamento', a_fazer: 'A fazer' };

function _shell(body) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Seu tratamento — Clínica AMA</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f6f8fb;color:#1c2733}
  .wrap{max-width:520px;margin:0 auto;padding:20px 16px 48px}
  h1{font-size:1.35rem;margin:.2em 0}.sub{color:#5b6b7b;margin:0 0 18px}
  .barra{background:#e3e9f0;border-radius:999px;height:14px;overflow:hidden;margin:6px 0 4px}
  .barra i{display:block;height:100%;background:#2f7d4f;border-radius:999px}
  .pct{font-weight:700;color:#2f7d4f}
  .card{background:#fff;border:1px solid #e3e9f0;border-radius:12px;padding:12px 14px;margin:10px 0}
  .card h3{margin:0 0 2px;font-size:1rem}.exec{color:#5b6b7b;font-size:.85rem;margin:0}
  .sess{margin:8px 0 0;padding-left:18px;color:#33414f;font-size:.9rem}.sess li{margin:2px 0}
  .prox{background:#eef6ff;border-color:#cfe3f8}
  .parabens{background:#effaf1;border-color:#bfe6c8;text-align:center;font-weight:600}
  footer{margin-top:22px;color:#5b6b7b;font-size:.85rem;text-align:center}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

function renderTracker({ nome, concluido, resumo, proxima }) {
  const procs = (resumo.procedimentos || []).map(p => `
    <div class="card"><h3>${ICONE[p.status] || ''} ${esc(p.nome)} <small style="color:#5b6b7b;font-weight:400">· ${ROTULO[p.status] || ''}</small></h3>
      ${p.executor ? `<p class="exec">Profissional: ${esc(p.executor)}</p>` : ''}
      ${p.sessoes.length ? `<ul class="sess">${p.sessoes.map(s =>
        `<li>${s.descricao ? `${esc(s.descricao)} — ` : 'Realizado em '}${esc(s.data || '')}</li>`).join('')}</ul>` : ''}
    </div>`).join('');
  const prox = proxima ? `<div class="card prox">📅 Sua próxima consulta: <b>${esc(fmtData(`${proxima.appointment_date}T12:00:00-03:00`) || '')}${proxima.from_time ? ` às ${esc(String(proxima.from_time).slice(0, 5))}` : ''}</b></div>` : '';
  return _shell(`
    <h1>Olá${nome ? `, ${esc(nome)}` : ''}!</h1><p class="sub">Acompanhe seu tratamento na Clínica AMA</p>
    <div class="barra"><i style="width:${Math.max(0, Math.min(100, Number(resumo.pct) || 0))}%"></i></div>
    <p class="pct">${Math.max(0, Math.min(100, Number(resumo.pct) || 0))}% concluído</p>
    ${concluido ? '<div class="card parabens">🎉 Parabéns — seu tratamento foi concluído!</div>' : ''}
    ${prox}${procs}
    <footer>Dúvidas? Fale com a gente no WhatsApp da clínica 💬</footer>`);
}

function renderNeutro() {
  return _shell(`<h1>Link inválido ou tratamento não disponível</h1>
    <p class="sub">Fale com a clínica para receber um novo link de acompanhamento.</p>`);
}

module.exports = { primeiroNome, resumoTracker, renderTracker, renderNeutro };
