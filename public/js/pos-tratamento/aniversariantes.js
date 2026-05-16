import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { MESES_PT, COR_CLASSE, formatarData, abrirWhatsApp, templateBar, batchInsertRecallLogs, idsJaLogadosHoje, toast } from "./shared.js";

const sb = createClient(window.__SUPABASE_URL__, window.__SUPABASE_ANON__);
let allPatients = [], selectedDay = null, logsHoje = new Set(), userId, tmpl;
let calMonth, calYear;
let selectedPatients = new Set();

async function init() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { window.location.href = "/login.html"; return; }
  userId = user.id;
  tmpl = templateBar("template-bar-aniv", "aniversario", sb);

  const now = new Date();
  calMonth = now.getMonth() + 1;
  calYear  = now.getFullYear();
  selectedDay = now.getDate();

  await carregarMes(calMonth);
}

async function carregarMes(month) {
  const { data, error } = await sb.rpc("birthday_month", { p_month: month });
  if (error) console.error("birthday_month error:", error);
  allPatients = data || [];

  const hoje = new Date();
  const mH = hoje.getMonth() + 1, dH = hoje.getDate();

  // KPIs
  const deHoje  = allPatients.filter(p => p.mes_nasc === mH && p.dia_nasc === dH);
  const doMes   = allPatients;
  const aDoMes  = allPatients.filter(p => p.classe === "A");

  const byClasse = { A: 0, B: 0, C: 0 };
  deHoje.forEach(p => { byClasse[p.classe] = (byClasse[p.classe] || 0) + 1; });

  const kpiHojeEl = document.getElementById("kpi-hoje");
  kpiHojeEl.innerHTML = `
    <span class="kpi-big">${deHoje.length}</span>
    <span class="kpi-dots">
      ${["A","B","C"].filter(c => byClasse[c]).map(c =>
        `<span class="kpi-dot" style="background:${COR_CLASSE[c]}"></span> ${c}: ${byClasse[c]}`
      ).join(" · ")}
    </span>`;

  // "Selecionados (dia)" starts as today's count
  updateKpiSelecionados(selectedDay || dH);

  document.getElementById("kpi-mes").textContent = doMes.length;
  const byMes = { A: 0, B: 0, C: 0 };
  doMes.forEach(p => { byMes[p.classe] = (byMes[p.classe] || 0) + 1; });
  document.getElementById("kpi-mes-sub").innerHTML =
    ["A","B","C"].filter(c => byMes[c]).map(c =>
      `<span class="kpi-dot" style="background:${COR_CLASSE[c]}"></span> ${c}: ${byMes[c]}`
    ).join(" ");

  document.getElementById("kpi-a-mes").textContent = aDoMes.length;

  logsHoje = await idsJaLogadosHoje(sb, deHoje.map(p => p.paciente_id), "aniversario");

  renderCal();
  selectDay(selectedDay || dH);
}

function updateKpiSelecionados(day) {
  const pacs = allPatients.filter(p => p.dia_nasc === day);
  const d = new Date(calYear, calMonth - 1, day);
  const MESES_FULL = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
  document.getElementById("kpi-selecionados").textContent = pacs.length;
  document.getElementById("kpi-selecionados-data").textContent = day + " de " + MESES_FULL[d.getMonth()];
}

function renderCal() {
  const cal = document.getElementById("aniv-calendar");
  const headerEl = document.getElementById("cal-month-label");
  headerEl.textContent = MESES_PT[calMonth - 1].toUpperCase() + " " + calYear;

  const hoje = new Date();
  const isThisMonth = calMonth === (hoje.getMonth() + 1) && calYear === hoje.getFullYear();
  const todayDay = isThisMonth ? hoje.getDate() : -1;

  const firstDay = new Date(calYear, calMonth - 1, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();

  // Count birthdays per day
  const bdByDay = {};
  allPatients.forEach(p => {
    if (!bdByDay[p.dia_nasc]) bdByDay[p.dia_nasc] = { total: 0, classes: new Set() };
    bdByDay[p.dia_nasc].total++;
    bdByDay[p.dia_nasc].classes.add(p.classe);
  });

  let cells = "";
  for (let i = 0; i < firstDay; i++) cells += `<div class="cal-cell cal-cell--empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const bd = bdByDay[d];
    const isToday = d === todayDay;
    const isSelected = d === selectedDay && calMonth === (new Date().getMonth() + 1);
    const cls = ["cal-cell", isToday && "cal-cell--today", isSelected && "cal-cell--selected"].filter(Boolean).join(" ");
    const dots = bd ? [...bd.classes].map(c => `<span class="cal-dot" style="background:${COR_CLASSE[c]}"></span>`).join("") : "";
    const badge = bd ? `<span class="cal-badge">${bd.total}</span>` : "";
    cells += `<div class="${cls}" data-day="${d}">
      <span class="cal-day-num">${d}</span>
      ${badge}
      <div class="cal-dots">${dots}</div>
    </div>`;
  }

  cal.innerHTML = cells;
  cal.querySelectorAll(".cal-cell[data-day]").forEach(cell => {
    cell.addEventListener("click", () => selectDay(Number(cell.dataset.day)));
  });
}

function selectDay(day) {
  selectedDay = day;
  document.querySelectorAll(".cal-cell").forEach(c => c.classList.remove("cal-cell--selected"));
  const target = document.querySelector(`.cal-cell[data-day="${day}"]`);
  if (target) target.classList.add("cal-cell--selected");

  updateKpiSelecionados(day);
  selectedPatients.clear();

  const pacs = allPatients
    .filter(p => p.dia_nasc === day)
    .sort((a, b) => {
      const ord = { A: 0, B: 1, C: 2 };
      if (ord[a.classe] !== ord[b.classe]) return ord[a.classe] - ord[b.classe];
      return (b.dias_sem_visita || 0) - (a.dias_sem_visita || 0);
    });

  const hoje = new Date();
  const isToday = day === hoje.getDate() && calMonth === hoje.getMonth() + 1 && calYear === hoje.getFullYear();
  const MESES_FULL = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];

  const sectionTitle = document.getElementById("aniv-list-title");
  sectionTitle.textContent = isToday
    ? "🎂 ANIVERSARIANTES DE HOJE"
    : "ANIVERSARIANTES DE " + day + " DE " + MESES_FULL[calMonth - 1].toUpperCase();

  renderLista(pacs, isToday);
}

function renderLista(pacs, isToday) {
  const listEl = document.getElementById("aniv-lista");
  const headerEl = document.getElementById("aniv-list-header");

  if (!pacs.length) {
    headerEl.innerHTML = "";
    listEl.innerHTML = `<div class="empty-state"><p>Sem aniversariantes neste dia</p></div>`;
    return;
  }

  headerEl.innerHTML = `
    <label class="aniv-select-all">
      <input type="checkbox" id="chk-select-all"> Selecionar todos do dia (${pacs.length})
    </label>`;
  document.getElementById("chk-select-all").addEventListener("change", function() {
    pacs.forEach(p => {
      if (this.checked) selectedPatients.add(p.paciente_id);
      else selectedPatients.delete(p.paciente_id);
    });
    document.querySelectorAll(".aniv-chk").forEach(c => c.checked = this.checked);
    renderBotaoMarcar(pacs, isToday);
  });

  listEl.innerHTML = pacs.map(p => {
    const initials = (p.nome || "?").trim().split(/\s+/).slice(0,2).map(w => w[0]).join("").toUpperCase();
    const anoNasc = p.data_nascimento ? new Date(p.data_nascimento + "T00:00:00").getFullYear() : null;
    const idade = anoNasc ? calYear - anoNasc : null;
    const tel = p.telefone_celular || p.telefone || "";

    let daysHtml = "";
    if (p.dias_sem_visita != null) {
      const d = p.dias_sem_visita;
      if (d >= 365) daysHtml = `<span class="aniv-days aniv-days--red">● ${d} dias sem vir</span>`;
      else if (d >= 180) daysHtml = `<span class="aniv-days aniv-days--amber">⚠ ${d} dias sem vir</span>`;
      else daysHtml = `<span class="aniv-days aniv-days--green">✓ ${d} dias</span>`;
    }

    const agenda = p.proxima_consulta
      ? `<span class="aniv-agenda">📅 ${formatarData(p.proxima_consulta)}</span>`
      : `<span class="aniv-no-agenda">Sem agenda</span>`;

    return `<div class="aniv-row" data-id="${p.paciente_id}">
      <input type="checkbox" class="aniv-chk" data-id="${p.paciente_id}" ${selectedPatients.has(p.paciente_id) ? "checked" : ""}>
      <div class="aniv-avatar" style="background:${COR_CLASSE[p.classe] || "#6B6A64"}">${initials}</div>
      <div class="aniv-info">
        <div class="aniv-name">${p.nome || "—"}${p.clinicorp_id ? ` <span class="aniv-id">#${p.clinicorp_id}</span>` : ""}</div>
        <div class="aniv-meta">
          <span class="badge badge--classe badge--classe-${(p.classe||"c").toLowerCase()}">${p.classe||"?"}</span>
          ${idade != null ? `<span>${idade} anos</span>` : ""}
          <span>✂ ${p.qtd_comparecimentos || 0} atend.</span>
          ${daysHtml}
          ${agenda}
        </div>
      </div>
      <button class="aniv-wa-btn" onclick="window._anivWA(${JSON.stringify(tel)},${JSON.stringify(p.nome||'')})" title="WhatsApp">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.126.556 4.12 1.529 5.854L0 24l6.335-1.52A11.952 11.952 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.797 9.797 0 01-5.032-1.386l-.36-.214-3.73.894.952-3.645-.234-.374A9.788 9.788 0 012.182 12C2.182 6.57 6.57 2.182 12 2.182c5.43 0 9.818 4.388 9.818 9.818 0 5.43-4.388 9.818-9.818 9.818z"/></svg>
      </button>
    </div>`;
  }).join("");

  document.querySelectorAll(".aniv-chk").forEach(chk => {
    chk.addEventListener("change", function() {
      const id = this.dataset.id;
      if (this.checked) selectedPatients.add(id);
      else selectedPatients.delete(id);
      renderBotaoMarcar(pacs, isToday);
    });
  });

  renderBotaoMarcar(pacs, isToday);
}

function renderBotaoMarcar(pacs, isToday) {
  const wrap = document.getElementById("btn-marcar-wrap");
  if (!pacs.length || !isToday) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");

  const naoMarcados = pacs.filter(p => !logsHoje.has(p.paciente_id));
  if (!naoMarcados.length) {
    wrap.innerHTML = `<button class="btn btn--success" disabled>Enviado ✓</button>`; return;
  }

  const toMark = selectedPatients.size > 0
    ? pacs.filter(p => selectedPatients.has(p.paciente_id) && !logsHoje.has(p.paciente_id))
    : naoMarcados;

  const label = selectedPatients.size > 0
    ? `✓ Marcar ${toMark.length} selecionados`
    : `✓ Marcar envio — ${naoMarcados.length} aniversariante${naoMarcados.length !== 1 ? "s" : ""} de hoje`;

  wrap.innerHTML = `<button class="btn btn--primary" id="btn-marcar-aniv">${label}</button>`;
  document.getElementById("btn-marcar-aniv").onclick = async () => {
    const { inserted, error } = await batchInsertRecallLogs(sb, toMark.map(p => p.paciente_id), "aniversario", userId);
    if (error) { toast("Erro: " + error.message, "error"); return; }
    toMark.forEach(p => logsHoje.add(p.paciente_id));
    toast(`Envio registrado para ${inserted} paciente${inserted !== 1 ? "s" : ""}`);
    renderBotaoMarcar(pacs, isToday);
  };
}

window._anivWA = (tel, nome) => abrirWhatsApp(tel, tmpl?.getCorpo() || "", nome);

// Month navigation
document.getElementById("cal-prev").addEventListener("click", () => {
  calMonth--; if (calMonth < 1) { calMonth = 12; calYear--; }
  selectedDay = null; carregarMes(calMonth);
});
document.getElementById("cal-next").addEventListener("click", () => {
  calMonth++; if (calMonth > 12) { calMonth = 1; calYear++; }
  selectedDay = null; carregarMes(calMonth);
});

init();