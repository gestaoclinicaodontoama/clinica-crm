import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { MESES_PT, DIAS_PT, COR_CLASSE, formatarData, abrirWhatsApp, templateBar, batchInsertRecallLogs, idsJaLogadosHoje, toast } from "./shared.js";

const sb = createClient(window.__SUPABASE_URL__, window.__SUPABASE_ANON__);
let allPatients = [], selectedOffset = 0, logsHoje = new Set(), userId, tmpl;

async function init() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { window.location.href = "/login.html"; return; }
  userId = user.id;
  tmpl = templateBar("template-bar-aniv", "aniversario", sb);
  const { data, error } = await sb.rpc("birthday_window", { offset_start: -4, offset_end: 4 });
  if (error) { console.error('birthday_window error:', error); }
  allPatients = data || [];

  const hoje = new Date(), mH = hoje.getMonth() + 1, dH = hoje.getDate();
  const deHoje = allPatients.filter(p => p.mes_nasc === mH && p.dia_nasc === dH);
  let prox4Count = 0;
  for (let i = 1; i <= 4; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    prox4Count += allPatients.filter(p => p.mes_nasc === d.getMonth() + 1 && p.dia_nasc === d.getDate()).length;
  }
  document.getElementById("kpi-hoje").textContent = deHoje.length;
  document.getElementById("kpi-prox").textContent = prox4Count;
  document.getElementById("kpi-a").textContent = deHoje.filter(p => p.classe === "A").length;

  logsHoje = await idsJaLogadosHoje(sb, deHoje.map(p => p.paciente_id), "aniversario");
  renderStrip();
  selectDay(0);
}

function renderStrip() {
  const strip = document.getElementById("calendar-strip");
  strip.innerHTML = "";
  for (let i = -4; i <= 4; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const pacs = allPatients.filter(p => p.mes_nasc === d.getMonth() + 1 && p.dia_nasc === d.getDate());
    const classes = [...new Set(pacs.map(p => p.classe))];
    const cell = document.createElement("div");
    cell.className = "strip-cell" + (i === 0 ? " strip-cell--hoje" : "");
    cell.dataset.offset = i;
    cell.innerHTML = `
      <span class="strip-cell__dia-sem">${DIAS_PT[d.getDay()]}</span>
      <span class="strip-cell__dia-num">${d.getDate()}</span>
      <span class="strip-cell__mes">${MESES_PT[d.getMonth()]}</span>
      <div class="strip-cell__dots">${classes.map(c => `<span class="dot" style="background:${COR_CLASSE[c] || '#999'}"></span>`).join("")}</div>
      <span class="strip-cell__count">${pacs.length > 0 ? pacs.length + " aniv." : ""}</span>`;
    cell.addEventListener("click", () => selectDay(i));
    strip.appendChild(cell);
  }
}

function selectDay(offset) {
  selectedOffset = offset;
  document.querySelectorAll(".strip-cell").forEach(c =>
    c.classList.toggle("strip-cell--selected", +c.dataset.offset === offset));
  const d = new Date(); d.setDate(d.getDate() + offset);
  const pacs = allPatients
    .filter(p => p.mes_nasc === d.getMonth() + 1 && p.dia_nasc === d.getDate())
    .sort((a, b) => {
      const ord = { A: 0, B: 1, C: 2 };
      if (ord[a.classe] !== ord[b.classe]) return ord[a.classe] - ord[b.classe];
      return (b.dias_sem_visita || 0) - (a.dias_sem_visita || 0);
    });
  document.getElementById("lista-titulo").textContent =
    `Aniversariantes de ${d.getDate()} de ${MESES_PT[d.getMonth()]}`;
  renderLista(pacs);
  renderBotaoMarcar(pacs, offset);
}

function renderLista(pacs) {
  const el = document.getElementById("lista-aniversariantes");
  if (!pacs.length) {
    el.innerHTML = `<div class="empty-state"><p>Sem aniversariantes neste dia</p><p class="empty-state__hint">Selecione outro dia no calendário acima</p></div>`;
    return;
  }
  el.innerHTML = pacs.map(p => {
    const anoNasc = p.data_nascimento ? new Date(p.data_nascimento + 'T00:00:00').getFullYear() : null;
    const idade = anoNasc ? new Date().getFullYear() - anoNasc : null;
    const agenda = p.proxima_consulta
      ? `<span class="badge badge--agenda">Agenda: ${formatarData(p.proxima_consulta)}</span>`
      : `<span class="badge badge--sem-agenda">Sem agenda futura</span>`;
    const avatar = (p.nome || '?')[0].toUpperCase();
    return `
      <div class="patient-card">
        <div class="patient-card__avatar" style="background:${COR_CLASSE[p.classe] || '#6B6A64'}">${avatar}</div>
        <div class="patient-card__info">
          <strong>${p.nome}</strong>
          <span class="patient-card__meta">${idade != null ? idade + ' anos — ' : ''}${p.qtd_comparecimentos || 0} atendimentos — Última visita: ${formatarData(p.ultima_visita)}</span>
          <div class="patient-card__badges">
            <span class="badge badge--classe badge--classe-${(p.classe || 'c').toLowerCase()}">${p.classe || '-'}</span>
            ${agenda}
          </div>
        </div>
        <button class="btn btn--whatsapp" onclick="window._openWA(${JSON.stringify(p.telefone_celular || '')},${JSON.stringify(p.nome)})">WhatsApp</button>
      </div>`;
  }).join("");
}

window._openWA = (tel, nome) => abrirWhatsApp(tel, tmpl.getCorpo(), nome);

function renderBotaoMarcar(pacs, offset) {
  const wrap = document.getElementById("btn-marcar-wrap");
  if (!pacs.length || offset !== 0) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  const naoMarcados = pacs.filter(p => !logsHoje.has(p.paciente_id));
  if (!naoMarcados.length) {
    wrap.innerHTML = `<button class="btn btn--success" disabled>Enviado ✓</button>`;
    return;
  }
  wrap.innerHTML = `<button class="btn btn--primary" id="btn-marcar-aniv">✓ Marcar envio concluído — ${naoMarcados.length} aniversariante${naoMarcados.length !== 1 ? 's' : ''} de hoje</button>`;
  document.getElementById("btn-marcar-aniv").onclick = async () => {
    const { inserted, error } = await batchInsertRecallLogs(sb, naoMarcados.map(p => p.paciente_id), "aniversario", userId);
    if (error) { toast("Erro: " + error.message, "error"); return; }
    naoMarcados.forEach(p => logsHoje.add(p.paciente_id));
    toast(`Envio registrado para ${inserted} paciente${inserted !== 1 ? 's' : ''}`);
    renderBotaoMarcar(pacs, 0);
  };
}

init();