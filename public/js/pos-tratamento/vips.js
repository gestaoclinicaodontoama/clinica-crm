import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { COR_CLASSE, formatarData, formatarTelefone, abrirWhatsApp, templateBar, batchInsertRecallLogs, idsJaLogadosHoje, toast } from "./shared.js";

const sb = createClient(window.__SUPABASE_URL__, window.__SUPABASE_ANON__);
const PAGE_SIZE = 20;
let paginaAtual = 1, totalVips = 0, paginaData = [], userId, tmpl;
let pacienteSelecionado = null;

async function init() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { window.location.href = "/login.html"; return; }
  userId = user.id;
  tmpl = templateBar("template-bar-vip", "vip", sb);

  document.getElementById("btn-abrir-modal").onclick = abrirModal;
  document.getElementById("btn-cancelar-modal").onclick = fecharModal;
  document.getElementById("btn-salvar-vip").onclick = salvarVip;

  const inputBusca = document.getElementById("busca-paciente");
  let debounceTimer;
  inputBusca.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => buscarPacientes(inputBusca.value.trim()), 300);
  });

  document.getElementById("modal-adicionar").addEventListener("click", e => {
    if (e.target === e.currentTarget) fecharModal();
  });

  await carregar();
}

async function carregar() {
  const from = (paginaAtual - 1) * PAGE_SIZE, to = from + PAGE_SIZE - 1;

  const { data, count, error } = await sb.from("vip_pacientes")
    .select(`id, paciente_id, adicionado_em, obs,
      pacientes!inner(id, nome, telefone_celular, clinicorp_id,
        pacientes_abc(classe, qtd_comparecimentos, ultima_visita, proxima_consulta, dias_sem_visita))`,
      { count: "exact" })
    .order("adicionado_em", { ascending: false })
    .range(from, to);

  if (error) { console.error(error); return; }
  totalVips = count ?? 0;
  paginaData = (data || []).map(r => {
    const abc = r.pacientes?.pacientes_abc?.[0] || {};
    return {
      vip_id: r.id,
      paciente_id: r.paciente_id,
      nome: r.pacientes?.nome || "—",
      clinicorp_id: r.pacientes?.clinicorp_id || null,
      telefone_celular: r.pacientes?.telefone_celular || "",
      adicionado_em: r.adicionado_em,
      obs: r.obs || "",
      classe: abc.classe || null,
      qtd_comparecimentos: abc.qtd_comparecimentos ?? null,
      ultima_visita: abc.ultima_visita || null,
      proxima_consulta: abc.proxima_consulta || null,
      dias_sem_visita: abc.dias_sem_visita ?? null,
    };
  });

  renderGrid();
  renderPaginacao();
  await atualizarProgresso();
  await renderBotaoMarcar();
}

function renderGrid() {
  const grid = document.getElementById("vip-grid");
  if (!paginaData.length) {
    grid.innerHTML = `<div class="empty-state"><p>Nenhum paciente VIP ainda</p><p class="empty-state__hint">Use o botao "Adicionar VIP" para comecar</p></div>`;
    return;
  }
  grid.innerHTML = paginaData.map((p, idx) => {
    const classBadge = p.classe
      ? `<span class="badge badge--classe badge--classe-${p.classe.toLowerCase()}">${p.classe}</span>`
      : `<span class="badge badge--muted">Sem ABC</span>`;
    const agenda = p.proxima_consulta
      ? `<span class="badge badge--agenda">${formatarData(p.proxima_consulta)}</span>`
      : `<span class="badge badge--sem-agenda">Sem agenda</span>`;
    const avatarBg = COR_CLASSE[p.classe] || '#6B6A64';
    const atendimentos = p.qtd_comparecimentos !== null
      ? `${p.qtd_comparecimentos} atendimentos`
      : `<span class="vip-sem-dados">Sincronizar ABC para ver histórico</span>`;
    return `
      <div class="vip-card" data-vip-id="${p.vip_id}" data-pac-id="${p.paciente_id}">
        <div class="vip-card__header">
          <div class="patient-card__avatar" style="background:${avatarBg}">${(p.nome[0] || '?').toUpperCase()}</div>
          <div class="vip-card__name-block">
            <strong>${p.nome}</strong>
            <small>${p.clinicorp_id ? "#" + p.clinicorp_id + " · " : ""}${formatarTelefone(p.telefone_celular)}</small>
          </div>
          <button class="btn btn--danger btn--xs vip-card__remove" data-vip-id="${p.vip_id}" data-nome="${p.nome.replace(/"/g, '&quot;')}">Remover</button>
        </div>
        <div class="vip-card__body">
          <div class="vip-card__badges">${classBadge}${agenda}</div>
          <div class="vip-card__meta">
            ${p.ultima_visita ? `<span>Ultima visita: ${formatarData(p.ultima_visita)}</span>` : ''}
            <span>${atendimentos}</span>
            ${p.dias_sem_visita !== null ? `<span>${p.dias_sem_visita} dias sem visita</span>` : ''}
          </div>
          <div class="vip-card__obs" data-vip-id="${p.vip_id}">
            ${p.obs
              ? `<span class="obs-text">${p.obs}</span> <button class="btn btn--ghost btn--xs edit-obs-btn">Editar</button>`
              : `<button class="btn btn--ghost btn--xs edit-obs-btn">+ Adicionar obs</button>`}
          </div>
        </div>
        <div class="vip-card__footer">
          <button class="btn btn--whatsapp vip-wa-btn" data-idx="${idx}">WhatsApp</button>
        </div>
      </div>`;
  }).join("");

  grid.querySelectorAll(".vip-wa-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = paginaData[Number(btn.dataset.idx)];
      if (!p) return;
      abrirWhatsApp(p.telefone_celular, tmpl.getCorpo(), p.nome);
    });
  });

  grid.querySelectorAll(".vip-card__remove").forEach(btn => {
    btn.addEventListener("click", () => confirmarRemover(btn.dataset.vipId, btn.dataset.nome));
  });

  grid.querySelectorAll(".edit-obs-btn").forEach(btn => {
    const obsDiv = btn.closest(".vip-card__obs");
    const vipId = obsDiv.dataset.vipId;
    btn.addEventListener("click", () => editarObs(obsDiv, vipId));
  });
}

function editarObs(obsDiv, vipId) {
  const textoAtual = obsDiv.querySelector(".obs-text")?.textContent || "";
  obsDiv.innerHTML = `
    <textarea class="obs-inline-ta" maxlength="500" rows="2">${textoAtual}</textarea>
    <div class="obs-inline-actions">
      <button class="btn btn--ghost btn--xs obs-cancel">Cancelar</button>
      <button class="btn btn--primary btn--xs obs-save">Salvar</button>
    </div>`;
  obsDiv.querySelector(".obs-cancel").onclick = () => carregar();
  obsDiv.querySelector(".obs-save").onclick = async () => {
    const novaObs = obsDiv.querySelector(".obs-inline-ta").value.trim();
    const { error } = await sb.from("vip_pacientes").update({ obs: novaObs || null }).eq("id", vipId);
    if (error) { toast("Erro ao salvar: " + error.message, "error"); return; }
    toast("Observacao salva");
    await carregar();
  };
}

function confirmarRemover(vipId, nome) {
  const card = document.querySelector(`.vip-card[data-vip-id="${vipId}"]`);
  if (!card) return;
  const footer = card.querySelector(".vip-card__footer");
  footer.innerHTML = `
    <span class="confirm-inline__text">Remover ${nome}?</span>
    <button class="btn btn--ghost btn--xs confirm-cancel">Nao</button>
    <button class="btn btn--danger btn--xs confirm-ok">Sim, remover</button>`;
  footer.querySelector(".confirm-cancel").onclick = () => carregar();
  footer.querySelector(".confirm-ok").onclick = async () => {
    const { error } = await sb.from("vip_pacientes").delete().eq("id", vipId);
    if (error) { toast("Erro ao remover: " + error.message, "error"); return; }
    toast(`${nome} removido dos VIPs`);
    await carregar();
  };
}

function renderPaginacao() {
  const totalPags = Math.ceil(totalVips / PAGE_SIZE);
  const el = document.getElementById("vip-pagination");
  if (totalPags <= 1) { el.innerHTML = ""; return; }
  el.innerHTML = Array.from({ length: totalPags }, (_, i) => i + 1)
    .map(n => `<button class="page-btn${n === paginaAtual ? " page-btn--active" : ""}" onclick="window._irPaginaVip(${n})">${n}</button>`)
    .join("");
}
window._irPaginaVip = async n => { paginaAtual = n; await carregar(); };

async function atualizarProgresso() {
  const { count: totalY } = await sb.from("vip_pacientes").select("*", { count: "exact", head: true });
  const ids = paginaData.map(p => p.paciente_id);
  const jaLogados = await idsJaLogadosHoje(sb, ids, "vip");
  document.getElementById("vip-progress").textContent =
    `${jaLogados.size} de ${totalY ?? 0} VIPs contatados hoje`;
}

async function renderBotaoMarcar() {
  const wrap = document.getElementById("btn-marcar-vip-wrap");
  if (!paginaData.length) { wrap.innerHTML = ""; return; }
  const ids = paginaData.map(p => p.paciente_id);
  const jaLogados = await idsJaLogadosHoje(sb, ids, "vip");
  const naoMarcados = paginaData.filter(p => !jaLogados.has(p.paciente_id));
  if (!naoMarcados.length) {
    wrap.innerHTML = `<button class="btn btn--success" disabled>Enviado ✓</button>`;
    return;
  }
  const totalPags = Math.ceil(totalVips / PAGE_SIZE);
  const label = totalPags > 1
    ? `✓ Marcar ${naoMarcados.length} desta pagina como contatados`
    : `✓ Marcar como contatados — ${naoMarcados.length} VIP${naoMarcados.length !== 1 ? "s" : ""}`;
  wrap.innerHTML = `<button class="btn btn--primary" id="btn-marcar-vip">${label}</button>`;
  document.getElementById("btn-marcar-vip").onclick = async () => {
    const { inserted, error } = await batchInsertRecallLogs(sb, naoMarcados.map(p => p.paciente_id), "vip", userId);
    if (error) { toast("Erro: " + error.message, "error"); return; }
    toast(`Registrado para ${inserted} VIP${inserted !== 1 ? "s" : ""}`);
    await carregar();
  };
}

function abrirModal() {
  pacienteSelecionado = null;
  document.getElementById("busca-paciente").value = "";
  document.getElementById("search-results").innerHTML = "";
  document.getElementById("obs-input").value = "";
  document.getElementById("obs-wrap").classList.add("hidden");
  document.getElementById("btn-salvar-vip").classList.add("hidden");
  document.getElementById("modal-adicionar").classList.remove("hidden");
  document.getElementById("busca-paciente").focus();
}

function fecharModal() {
  document.getElementById("modal-adicionar").classList.add("hidden");
  pacienteSelecionado = null;
}

async function buscarPacientes(q) {
  const results = document.getElementById("search-results");
  if (q.length < 3) { results.innerHTML = ""; return; }

  const vipIds = paginaData.map(p => p.paciente_id);
  let query = sb.from("pacientes").select("id, nome, telefone_celular").ilike("nome", `%${q}%`).limit(10);

  const { data, error } = await query;
  if (error) { results.innerHTML = `<p class="search-error">Erro na busca</p>`; return; }

  const filtrado = (data || []).filter(p => !vipIds.includes(p.id));
  if (!filtrado.length) { results.innerHTML = `<p class="search-empty">Nenhum resultado</p>`; return; }

  results.innerHTML = filtrado.map(p => `
    <div class="search-result-item" data-id="${p.id}" data-nome="${(p.nome||'').replace(/"/g,'&quot;')}" data-tel="${p.telefone_celular || ''}">
      <strong>${p.nome}</strong>
      <small>${p.telefone_celular || 'sem telefone'}</small>
    </div>`).join("");

  results.querySelectorAll(".search-result-item").forEach(item => {
    item.addEventListener("click", () => selecionarPaciente(item.dataset.id, item.dataset.nome, item.dataset.tel));
  });
}

function selecionarPaciente(id, nome, tel) {
  pacienteSelecionado = { id, nome, tel };
  document.getElementById("search-results").innerHTML =
    `<div class="selected-patient"><strong>✓ ${nome}</strong> <small>${tel || 'sem telefone'}</small></div>`;
  document.getElementById("busca-paciente").value = nome;
  document.getElementById("obs-wrap").classList.remove("hidden");
  document.getElementById("btn-salvar-vip").classList.remove("hidden");
}

async function salvarVip() {
  if (!pacienteSelecionado) return;
  const obs = document.getElementById("obs-input").value.trim() || null;
  const { error } = await sb.from("vip_pacientes").insert({
    paciente_id: pacienteSelecionado.id,
    adicionado_por: userId,
    obs,
  });
  if (error) { toast("Erro ao adicionar VIP: " + error.message, "error"); return; }
  toast(`${pacienteSelecionado.nome} adicionado aos VIPs`);
  fecharModal();
  paginaAtual = 1;
  await carregar();
}

init();