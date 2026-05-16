import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { formatarData, formatarMoeda, abrirWhatsApp, templateBar, toast } from "./shared.js";

const sb = createClient(window.__SUPABASE_URL__, window.__SUPABASE_ANON__);
const PAGE_SIZE = 100;
let paginaAtual = 1, totalRegistros = 0;
let filtroClasse = null, filtroDays = null, filtroSemAgenda = false, buscaTexto = "";
let classTabFilter = "todos";
let stats = {};
let tmpl;

async function init() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { window.location.href = "/login.html"; return; }
  tmpl = templateBar("abc-template-bar", "recall", sb);

  await carregarStats();
  setupListeners();
  await carregar();
}

async function carregarStats() {
  const { data, error } = await sb.rpc("abc_stats");
  if (error) { console.error("abc_stats:", error); return; }
  const s = (Array.isArray(data) ? data[0] : data) || {};

  const byClass = {
    A: { count: Number(s.a_count || 0), receita: Number(s.a_receita || 0) },
    B: { count: Number(s.b_count || 0), receita: Number(s.b_receita || 0) },
    C: { count: Number(s.c_count || 0), receita: Number(s.c_receita || 0) },
  };
  const totalReceita = Number(s.total_receita || 0);

  stats = { total: Number(s.total || 0), byClass, totalReceita, semRetorno: Number(s.sem_retorno || 0) };

  document.getElementById("kpi-total").textContent = stats.total.toLocaleString("pt-BR");
  document.getElementById("kpi-a").textContent = byClass.A.count.toLocaleString("pt-BR");
  document.getElementById("kpi-a-sub").textContent =
    byClass.A.count + " pac. · " + fmtK(byClass.A.receita);
  document.getElementById("kpi-sem-retorno").textContent = stats.semRetorno.toLocaleString("pt-BR");

  renderDistBar(byClass, totalReceita);
}

function fmtK(val) {
  if (val >= 1e6) return "R$" + (val / 1e6).toFixed(1).replace(".", ",") + "M";
  if (val >= 1e3) return "R$" + Math.round(val / 1e3) + "k";
  return "R$" + Math.round(val);
}

function renderDistBar(byClass, totalReceita) {
  const total = byClass.A.count + byClass.B.count + byClass.C.count || 1;
  const pA = (byClass.A.count / total * 100).toFixed(1);
  const pB = (byClass.B.count / total * 100).toFixed(1);
  const pC = (100 - parseFloat(pA) - parseFloat(pB)).toFixed(1);
  const rA = byClass.A.receita / totalReceita * 100;
  const rB = byClass.B.receita / totalReceita * 100;
  const rC = byClass.C.receita / totalReceita * 100;

  document.getElementById("abc-bar").innerHTML = `
    <div class="abc-bar__a" style="width:${rA.toFixed(1)}%"></div>
    <div class="abc-bar__b" style="width:${rB.toFixed(1)}%"></div>
    <div class="abc-bar__c" style="width:${rC.toFixed(1)}%"></div>`;

  document.getElementById("abc-bar-legend").innerHTML = `
    <span><span class="abc-dot abc-dot--a"></span> Classe A — ${byClass.A.count} pac. · ${rA.toFixed(1)}% do fat. · ${fmtK(byClass.A.receita)}</span>
    <span><span class="abc-dot abc-dot--b"></span> Classe B — ${byClass.B.count} pac. · ${rB.toFixed(1)}% do fat. · ${fmtK(byClass.B.receita)}</span>
    <span><span class="abc-dot abc-dot--c"></span> Classe C — ${byClass.C.count} pac. · ${rC.toFixed(1)}% do fat. · ${fmtK(byClass.C.receita)}</span>`;

  const semRetornoByClass = {};
  ["A","B","C"].forEach(c => { semRetornoByClass[c] = 0; });

  document.getElementById("abc-cards-row").innerHTML = ["A","B","C"].map(c => {
    const cl = byClass[c];
    const ticket = cl.count ? cl.receita / cl.count : 0;
    return `<div class="abc-summary-card abc-summary-card--${c.toLowerCase()}">
      <div class="abc-summary-card__badge">${c}</div>
      <div class="abc-summary-card__count">${cl.count.toLocaleString("pt-BR")} pacientes</div>
      <div class="abc-summary-card__ticket">Ticket médio: ${formatarMoeda(ticket)}</div>
    </div>`;
  }).join("");
}

function setupListeners() {
  document.querySelectorAll(".abc-tab").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll(".abc-tab").forEach(b => b.classList.remove("abc-tab--active"));
    btn.classList.add("abc-tab--active");
    classTabFilter = btn.dataset.filter;
    paginaAtual = 1; carregar();
  }));

  document.querySelectorAll(".abc-chip[data-classe]").forEach(chip => {
    chip.addEventListener("click", () => {
      chip.classList.toggle("abc-chip--active");
      const ativos = [...document.querySelectorAll(".abc-chip[data-classe].abc-chip--active")].map(c => c.dataset.classe);
      filtroClasse = ativos.length ? ativos : null;
      paginaAtual = 1; syncClearBtn(); carregar();
    });
  });

  document.querySelectorAll(".abc-chip[data-days]").forEach(chip => {
    chip.addEventListener("click", () => {
      const wasActive = chip.classList.contains("abc-chip--active");
      document.querySelectorAll(".abc-chip[data-days]").forEach(c => c.classList.remove("abc-chip--active"));
      if (!wasActive) { chip.classList.add("abc-chip--active"); filtroDays = Number(chip.dataset.days); }
      else filtroDays = null;
      paginaAtual = 1; syncClearBtn(); carregar();
    });
  });

  document.querySelector(".abc-chip[data-filter='sem-agenda']").addEventListener("click", function() {
    this.classList.toggle("abc-chip--active");
    filtroSemAgenda = this.classList.contains("abc-chip--active");
    paginaAtual = 1; syncClearBtn(); carregar();
  });

  let debounceTimer;
  document.getElementById("abc-search").addEventListener("input", function() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      buscaTexto = this.value.trim();
      paginaAtual = 1; syncClearBtn(); carregar();
    }, 350);
  });

  document.getElementById("abc-clear-btn").addEventListener("click", () => {
    filtroClasse = null; filtroDays = null; filtroSemAgenda = false; buscaTexto = "";
    classTabFilter = "todos";
    document.getElementById("abc-search").value = "";
    document.querySelectorAll(".abc-chip").forEach(c => c.classList.remove("abc-chip--active"));
    document.querySelectorAll(".abc-tab").forEach(b => b.classList.remove("abc-tab--active"));
    document.querySelector(".abc-tab[data-filter='todos']").classList.add("abc-tab--active");
    paginaAtual = 1; syncClearBtn(); carregar();
  });
}

function syncClearBtn() {
  const active = filtroClasse || filtroDays || filtroSemAgenda || buscaTexto || classTabFilter !== "todos";
  document.getElementById("abc-clear-btn").classList.toggle("hidden", !active);
}

async function carregar() {
  const from = (paginaAtual - 1) * PAGE_SIZE, to = from + PAGE_SIZE - 1;

  let q = sb.from("pacientes_abc")
    .select("paciente_id, clinicorp_id, nome, classe, total_receita, ultima_visita, dias_sem_visita, proxima_consulta, telefone, pacientes!inner(id, telefone_celular)", { count: "exact" })
    .order("total_receita", { ascending: false })
    .range(from, to);

  if (classTabFilter !== "todos") q = q.eq("classe", classTabFilter);
  if (filtroClasse) q = q.in("classe", filtroClasse);
  if (filtroDays) q = q.gte("dias_sem_visita", filtroDays);
  if (filtroSemAgenda) q = q.is("proxima_consulta", null);
  if (buscaTexto) q = q.ilike("nome", "%" + buscaTexto + "%");

  const { data, count, error } = await q;
  if (error) { console.error(error); return; }

  totalRegistros = count ?? 0;
  const shown = Math.min(from + PAGE_SIZE, totalRegistros);
  document.getElementById("abc-list-count").textContent =
    totalRegistros.toLocaleString("pt-BR") + " pacientes · mostrando " + (from + 1) + "-" + shown;

  renderTabela(data || []);
  renderPaginacao();
}

function renderTabela(rows) {
  const wrap = document.getElementById("abc-table-wrap");
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-state"><p>Nenhum paciente encontrado</p></div>`;
    return;
  }
  wrap.innerHTML = `
    <table class="data-table abc-table">
      <thead><tr>
        <th><input type="checkbox" id="chk-all"></th>
        <th>PACIENTE</th><th>CLASSE</th><th>FATURAMENTO ▼</th>
        <th>ÚLTIMO ATEND.</th><th>PRÓXIMA AGENDA</th><th>WHATSAPP</th>
      </tr></thead>
      <tbody>${rows.map(p => {
        const initials = (p.nome || "?").trim().split(/\s+/).slice(0,2).map(w => w[0]).join("").toUpperCase();
        const tel = p.pacientes?.telefone_celular || p.telefone || "";
        const daysColor = p.dias_sem_visita >= 365 ? "badge--red" : p.dias_sem_visita >= 180 ? "badge--amber" : "badge--green-soft";
        const agendaHtml = p.proxima_consulta
          ? `<span class="abc-agenda-dot abc-agenda-dot--ok"></span><span class="abc-agenda-date">${formatarData(p.proxima_consulta)}</span>`
          : `<span class="abc-agenda-dot abc-agenda-dot--none"></span><span class="abc-agenda-none">Sem agenda</span>`;
        return `<tr>
          <td><input type="checkbox" class="row-chk" data-id="${p.paciente_id}"></td>
          <td>
            <div class="abc-patient-cell">
              <div class="abc-avatar abc-avatar--${(p.classe||"c").toLowerCase()}">${initials}</div>
              <div>
                <div class="abc-patient-name">${p.nome||"—"}</div>
                ${p.clinicorp_id ? `<div class="abc-patient-id">#${p.clinicorp_id}</div>` : ""}
              </div>
            </div>
          </td>
          <td><span class="badge badge--classe badge--classe-${(p.classe||"c").toLowerCase()}">${p.classe||"?"}</span></td>
          <td class="abc-receita">${fmtK(Number(p.total_receita||0))}</td>
          <td><span class="badge ${daysColor}">${p.dias_sem_visita != null ? p.dias_sem_visita + " dias" : "—"}</span></td>
          <td><div class="abc-agenda-cell">${agendaHtml}</div></td>
          <td><button class="abc-wa-btn" onclick="window._abcWA(${JSON.stringify(tel)},${JSON.stringify(p.nome||'')})" title="WhatsApp">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.126.556 4.12 1.529 5.854L0 24l6.335-1.52A11.952 11.952 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.797 9.797 0 01-5.032-1.386l-.36-.214-3.73.894.952-3.645-.234-.374A9.788 9.788 0 012.182 12C2.182 6.57 6.57 2.182 12 2.182c5.43 0 9.818 4.388 9.818 9.818 0 5.43-4.388 9.818-9.818 9.818z"/></svg>
          </button></td>
        </tr>`;
      }).join("")}
      </tbody>
    </table>`;

  document.getElementById("chk-all").addEventListener("change", function() {
    document.querySelectorAll(".row-chk").forEach(c => c.checked = this.checked);
  });
}

window._abcWA = (tel, nome) => abrirWhatsApp(tel, tmpl?.getCorpo() || "", nome);

function renderPaginacao() {
  const totalPags = Math.ceil(totalRegistros / PAGE_SIZE);
  const el = document.getElementById("abc-pagination");
  if (totalPags <= 1) { el.innerHTML = ""; return; }
  const pages = [];
  for (let i = 1; i <= Math.min(totalPags, 20); i++) {
    pages.push(`<button class="page-btn${i===paginaAtual?" page-btn--active":""}" onclick="window._abcPag(${i})">${i}</button>`);
  }
  if (totalPags > 20) pages.push(`<span class="page-ellipsis">… ${totalPags}</span>`);
  el.innerHTML = pages.join("");
}
window._abcPag = n => { paginaAtual = n; carregar(); };

init();