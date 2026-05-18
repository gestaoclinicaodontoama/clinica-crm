import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { formatarData, formatarTelefone, formatarMoeda, abrirWhatsApp, templateBar, batchInsertRecallLogs, idsJaLogadosHoje, toast } from "./shared.js";

const sb = createClient(window.__SUPABASE_URL__, window.__SUPABASE_ANON__);
const PAGE_SIZE = 50;
let abaAtual = "180", classesAtivas = ["A", "B"], paginaAtual = 1, totalRegistros = 0, paginaData = [], userId, tmpl;

async function carregarKPIs() {
  const [r1, r2, r3] = await Promise.all([
    sb.from("pacientes_abc").select("*", { count: "exact", head: true })
      .in("classe", ["A", "B"]).is("proxima_consulta", null).gte("dias_sem_visita", 180),
    sb.from("pacientes_abc").select("*", { count: "exact", head: true })
      .in("classe", ["A", "B"]).is("proxima_consulta", null).gte("dias_sem_visita", 180).lt("dias_sem_visita", 360),
    sb.from("pacientes_abc").select("*", { count: "exact", head: true })
      .in("classe", ["A", "B"]).is("proxima_consulta", null).gte("dias_sem_visita", 360),
  ]);
  document.getElementById("kpi-total").textContent = r1.count ?? "—";
  document.getElementById("kpi-180").textContent = r2.count ?? "—";
  document.getElementById("kpi-360").textContent = r3.count ?? "—";
}

window._syncClinicorp = async function() {
  const btn   = document.getElementById("btn-sync-clinicorp");
  const label = document.getElementById("btn-sync-label");
  btn.disabled = true;
  btn.classList.add("loading");
  label.textContent = "Sincronizando...";
  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch("/api/admin/sync-clinicorp", {
      method: "POST",
      headers: { "Authorization": `Bearer ${session?.access_token || ""}` }
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.msg || "Erro no servidor");
    label.textContent = "Aguardando...";
    // Aguarda 5s para o sync processar os dados mais simples antes de recarregar
    await new Promise(r => setTimeout(r, 5000));
    await Promise.all([carregarKPIs(), carregar()]);
    toast("Dados atualizados");
  } catch (e) {
    toast("Erro ao sincronizar: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
    label.textContent = "Atualizar dados";
  }
};

async function init() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { window.location.href = "/login.html"; return; }
  userId = user.id;
  tmpl = templateBar("template-bar-recall", "recall", sb);

  await carregarKPIs();

  document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("tab--active"));
    btn.classList.add("tab--active");
    abaAtual = btn.dataset.tab;
    classesAtivas = ["A", "B"];
    document.querySelectorAll(".chip").forEach(c => c.classList.add("chip--active"));
    paginaAtual = 1;
    carregar();
  }));

  document.querySelectorAll(".chip").forEach(chip => chip.addEventListener("click", () => {
    chip.classList.toggle("chip--active");
    classesAtivas = [...document.querySelectorAll(".chip.chip--active")].map(c => c.dataset.classe);
    if (!classesAtivas.length) {
      classesAtivas = ["A", "B"];
      document.querySelectorAll(".chip").forEach(c => c.classList.add("chip--active"));
    }
    paginaAtual = 1;
    carregar();
  }));

  carregar();
}

async function carregar() {
  const from = (paginaAtual - 1) * PAGE_SIZE, to = from + PAGE_SIZE - 1;
  const tipo = abaAtual === "180" ? "recall_180" : "recall_360";

  let q = sb.from("pacientes_abc")
    .select("paciente_id, clinicorp_id, classe, dias_sem_visita, ultima_visita, total_receita, proxima_consulta, pacientes!inner(id, nome, telefone_celular)", { count: "exact" })
    .in("classe", classesAtivas)
    .is("proxima_consulta", null)
    .order("dias_sem_visita", { ascending: false })
    .range(from, to);

  if (abaAtual === "180") q = q.gte("dias_sem_visita", 180).lt("dias_sem_visita", 360);
  else q = q.gte("dias_sem_visita", 360);

  const { data, count, error } = await q;
  if (error) { console.error(error); return; }

  totalRegistros = count ?? 0;
  paginaData = (data || []).map(r => ({
    paciente_id: r.paciente_id,
    nome: r.pacientes?.nome || "—",
    clinicorp_id: r.clinicorp_id || null,
    telefone_celular: r.pacientes?.telefone_celular || "",
    classe: r.classe,
    dias_sem_visita: r.dias_sem_visita,
    ultima_visita: r.ultima_visita,
    total_receita: r.total_receita,
  }));

  renderTabela();
  renderPaginacao();
  await atualizarProgresso(tipo);
  await renderBotaoMarcar(tipo);
}

function renderTabela() {
  const wrap = document.getElementById("recall-table-wrap");
  if (!paginaData.length) {
    wrap.innerHTML = `<div class="empty-state"><p>Nenhum paciente nesta faixa — ótimo trabalho!</p></div>`;
    return;
  }
  const badgeCls = abaAtual === "180" ? "badge--amber" : "badge--red";
  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>Paciente</th><th>Classe</th><th>Dias sem visita</th>
        <th>Última visita</th><th>Valor histórico</th><th>WhatsApp</th>
      </tr></thead>
      <tbody>${paginaData.map(p => `
        <tr>
          <td><strong>${p.nome}</strong><br><small>${p.clinicorp_id ? "#" + p.clinicorp_id + " · " : ""}${formatarTelefone(p.telefone_celular)}</small></td>
          <td><span class="badge badge--classe badge--classe-${(p.classe || 'c').toLowerCase()}">${p.classe}</span></td>
          <td><span class="badge ${badgeCls}">${p.dias_sem_visita} dias</span></td>
          <td>${formatarData(p.ultima_visita)}</td>
          <td>${formatarMoeda(p.total_receita)}</td>
          <td><button class="btn btn--whatsapp btn--sm" onclick="window._openWARecall(${JSON.stringify(p.telefone_celular)},${JSON.stringify(p.nome)})">WhatsApp</button></td>
        </tr>`).join("")}
      </tbody>
    </table>`;
}

window._openWARecall = (tel, nome) => abrirWhatsApp(tel, tmpl.getCorpo(), nome);

function renderPaginacao() {
  const totalPags = Math.ceil(totalRegistros / PAGE_SIZE);
  const el = document.getElementById("pagination");
  if (totalPags <= 1) { el.innerHTML = ""; return; }
  el.innerHTML = Array.from({ length: totalPags }, (_, i) => i + 1)
    .map(n => `<button class="page-btn${n === paginaAtual ? " page-btn--active" : ""}" onclick="window._irPagina(${n})">${n}</button>`)
    .join("");
}
window._irPagina = async n => { paginaAtual = n; await carregar(); };

async function atualizarProgresso(tipo) {
  const ids = paginaData.map(p => p.paciente_id);
  const jaLogados = await idsJaLogadosHoje(sb, ids, tipo);
  const filtrado = JSON.stringify([...classesAtivas].sort()) !== JSON.stringify(["A", "B"]);
  const label = filtrado
    ? `Filtro de classe ativo — ${jaLogados.size} de ${ids.length} desta página marcados hoje`
    : `${jaLogados.size} de ${totalRegistros} pacientes marcados hoje`;
  document.getElementById("progress-label").textContent = label;
}

async function renderBotaoMarcar(tipo) {
  const wrap = document.getElementById("btn-marcar-recall-wrap");
  if (!paginaData.length) { wrap.innerHTML = ""; return; }
  const ids = paginaData.map(p => p.paciente_id);
  const jaLogados = await idsJaLogadosHoje(sb, ids, tipo);
  const naoMarcados = paginaData.filter(p => !jaLogados.has(p.paciente_id));
  if (!naoMarcados.length) {
    wrap.innerHTML = `<button class="btn btn--success" disabled>Enviado ✓</button>`;
    return;
  }
  const faixa = abaAtual === "180" ? "180–359 dias" : "360+ dias";
  const totalPags = Math.ceil(totalRegistros / PAGE_SIZE);
  const label = totalPags > 1
    ? `✓ Marcar ${naoMarcados.length} desta página (${faixa})`
    : `✓ Marcar como contatados — ${naoMarcados.length} pacientes (${faixa})`;
  wrap.innerHTML = `<button class="btn btn--primary" id="btn-marcar-recall">${label}</button>`;
  document.getElementById("btn-marcar-recall").onclick = async () => {
    const { inserted, error } = await batchInsertRecallLogs(sb, naoMarcados.map(p => p.paciente_id), tipo, userId);
    if (error) { toast("Erro: " + error.message, "error"); return; }
    toast(`Registrado para ${inserted} paciente${inserted !== 1 ? "s" : ""}`);
    await carregar();
  };
}

init();