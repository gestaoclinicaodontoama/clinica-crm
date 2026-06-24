// Normaliza a entrada do construtor de públicos numa "regra" canônica — só chaves
// conhecidas e valores válidos. Defesa antes de persistir/consultar (o RPC só lê
// chaves conhecidas, mas isto evita lixo no banco).
const FONTES = ['origem', 'conversa', 'anuncio'];

function intPos(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function normalizarRegra(input) {
  const r = input && typeof input === 'object' ? input : {};
  const out = {};

  const i = r.interesse && typeof r.interesse === 'object' ? r.interesse : null;
  if (i && typeof i.termo === 'string' && i.termo.trim()) {
    let em = Array.isArray(i.em) ? i.em.filter(x => FONTES.includes(x)) : [];
    if (!em.length) em = [...FONTES];
    out.interesse = { termo: i.termo.trim(), em };
  }

  if (Array.isArray(r.status)) {
    const s = r.status.filter(x => typeof x === 'string' && x);
    if (s.length) out.status = s;
  }

  const dias = r.periodo && intPos(r.periodo.dias);
  if (dias) out.periodo = { campo: 'criado_em', dias };

  if (Array.isArray(r.ddd)) {
    const d = r.ddd.map(String).filter(x => /^\d{2}$/.test(x));
    if (d.length) out.ddd = d;
  }

  if (Array.isArray(r.origem)) {
    const o = r.origem.filter(x => typeof x === 'string' && x);
    if (o.length) out.origem = o;
  }

  const e = r.engajamento && typeof r.engajamento === 'object' ? r.engajamento : null;
  if (e) {
    const eng = {};
    if (e.respondeu === true || e.respondeu === false) eng.respondeu = e.respondeu;
    const ud = intPos(e.ultima_interacao_dias);
    if (ud) eng.ultima_interacao_dias = ud;
    if (e.janela24h === true || e.janela24h === false) eng.janela24h = e.janela24h;
    const ci = intPos(e.recebeu_campanha_id);
    if (ci) eng.recebeu_campanha_id = ci;
    if (Object.keys(eng).length) out.engajamento = eng;
  }

  return out;
}

module.exports = { normalizarRegra, FONTES };
