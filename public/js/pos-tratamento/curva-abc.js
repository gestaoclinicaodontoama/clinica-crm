import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { formatarData, formatarMoeda, abrirWhatsApp, templateBar, toast } from "./shared.js";

const sb = createClient(window.__SUPABASE_URL__, window.__SUPABASE_ANON__);
const PAGE_SIZE = 100;
let paginaAtual = 1, totalRegistros = 0;
let filtroClasse = null, filtroDays = null, filtroSemAgenda = false, buscaTexto = "";
let classTabFilter = "todos";
let sortCol = "total_receita", sortAsc = false;
let stats = {};
let tmpl;
let paginaRows = [];

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
  const rA = totalReceita ? byClass.A.receita / totalReceita * 100 : 0;
  const rB = totalReceita ? byClass.B.receita / totalReceita * 100 : 0;
  const rC = totalReceita ? byClass.C.receita / totalReceita * 100 : 0;

  document.getElementById("abc-bar").innerHTML = `
    <div class="abc-bar__a" style="width:${rA.toFixed(1)}%"></div>
    <div class="abc-bar__b" style="width:${rB.toFixed(1)}%"></div>
    <div class="abc-bar__c" style="width:${rC.toFixed(1)}%"></div>`;

  document.getElementById("abc-bar-legend").innerHTML = `
    <span><span class="abc-dot abc-dot--a"></span> Classe A — ${byClass.A.count} pac. · ${rA.toFixed(1)}% do fat. · ${fmtK(byClass.A.receita)}</span>
    <span><span class="abc-dot abc-dot--b"></span> Classe B — ${byClass.B.count} pac. · ${rB.toFixed(1)}% do fat. · ${fmtK(byClass.B.receita)}</span>
    <span><span class="abc-dot abc-dot--c"></span> Classe C — ${byClass.C.count} pac. · ${rC.toFixed(1)}% do fat. · ${fmtK(byClass.C.receita)}</span>`;

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
    sortCol = "total_receita"; sortAsc = false;
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
    .order(sortCol, { ascending: sortAsc })
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

  paginaRows = data || [];
  renderTabela(paginaRows);
  renderPaginacao();
}

function renderTabela(rows) {
  const wrap = document.getElementById("abc-table-wrap");
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-state"><p>Nenhum paciente encontrado</p></div>`;
    return;
  }

  const sortInd = col => sortCol === col ? (sortAsc ? " ▲" : " ▼") : "";

  wrap.innerHTML = `
    <table class="data-table abc-table">
      <thead><tr>
        <th><input type="checkbox" id="chk-all"></th>
        <th class="sortable-th" data-col="nome">PACIENTE${sortInd("nome")}</th>
        <th class="sortable-th" data-col="classe">CLASSE${sortInd("classe")}</th>
        <th class="sortable-th" data-col="total_receita">FATURAMENTO${sortInd("total_receita")}</th>
        <th class="sortable-th" data-col="dias_sem_visita">ÚLTIMO ATEND.${sortInd("dias_sem_visita")}</th>
        <th class="sortable-th" data-col="proxima_consulta">PRÓXIMA AGENDA${sortInd("proxima_consulta")}</th>
        <th>WHATSAPP</th>
      </tr></thead>
      <tbody>${rows.map((p, idx) => {
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
          <td><button class="abc-wa-btn" data-idx="${idx}" title="WhatsApp">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.126.556 4.12 1.529 5.854L0 24l6.335-1.52A11.952 11.952 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.797 9.797 0 01-5.032-1.386l-.36-.214-3.73.894.952-3.645-.234-.374A9.788 9.788 0 012.182 12C2.182 6.57 6.57 2.182 12 2.182c5.43 0 9.818 4.388 9.818 9.818 0 5.43-4.388 9.818-9.818 9.818z"/></svg>
          </button></td>
        </tr>`;
      }).join("")}
      </tbody>
    </table>`;

  document.getElementById("chk-all").addEventListener("change", function() {
    document.querySelectorAll(".row-chk").forEach(c => c.checked = this.checked);
  });

  wrap.querySelectorAll(".sortable-th").forEach(th => {
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (sortCol === col) { sortAsc = !sortAsc; }
      else { sortCol = col; sortAsc = ["nome", "classe", "proxima_consulta"].includes(col); }
      paginaAtual = 1;
      carregar();
    });
  });

  wrap.querySelectorAll(".abc-wa-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = paginaRows[Number(btn.dataset.idx)];
      if (!p) return;
      const tel = p.pacientes?.telefone_celular || p.telefone || "";
      abrirWhatsApp(tel, tmpl?.getCorpo() || "", p.nome || "");
    });
  });
}

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

async function backendApi(method, path, body) {
  const { data: { session } } = await sb.auth.getSession();
  const r = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: 'Bearer ' + session.access_token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Erro ' + r.status);
  return data;
}

async function lancarCampanhaABC() {
  try {
    const preview = await backendApi('GET', '/api/campanhas/preview/abc');
    if (!preview.total) {
      toast('Nenhum paciente encontrado com os critérios (Classe A/B, 180+ dias sem retorno, sem agenda).', 'error');
      return;
    }
    _abrirModalCampanha('abc', preview);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function _abrirModalCampanha(tipo, preview) {
  const LABELS = {
    abc: { titulo: 'Retorno ABC', sub: 'Classe A/B · Sem consulta há 180+ dias · Sem agenda' },
    indicacoes: { titulo: 'Leads Indicações', sub: 'Leads com origem = indicação · Status ativo' },
    recentes: { titulo: 'Leads Recentes', sub: 'Últimos 50 leads (não-indicação)' },
    frios: { titulo: 'Leads Frios', sub: 'Leads do 51º ao 151º (não-indicação)' },
  };
  const { titulo, sub } = LABELS[tipo] || { titulo: tipo, sub: '' };
  const isCols3 = tipo === 'abc';
  const cols = isCols3 ? ['nome', 'telefone', 'dias_sem_visita'] : ['nome', 'telefone'];
  const colLabels = isCols3 ? ['Nome', 'Telefone', 'Dias'] : ['Nome', 'Telefone'];
  const idField = tipo === 'abc' ? 'clinicorp_id' : 'id';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const contatos = (preview.contatos || []).slice(0, 100);
  const total = preview.total;
  const desmarcados = new Set();
  const bloqueados = new Set();

  function _countSel() {
    return contatos.length - desmarcados.size - bloqueados.size;
  }

  function _buildRows() {
    return contatos.map(c => {
      const id = String(c[idField] || '');
      const isDes = desmarcados.has(id);
      const isBlq = bloqueados.has(id);
      const style = (isDes || isBlq) ? 'opacity:0.4' : '';
      const nuncaBtn = isDes && !isBlq
        ? `<button class="cmp-nunca" data-id="${esc(id)}" data-nome="${esc(c.nome)}" style="font-size:11px;padding:2px 6px;background:#fff5f5;color:#e53e3e;border:1px solid #fed7d7;border-radius:4px;cursor:pointer">🚫 Nunca ligar</button>`
        : '';
      const badge = isBlq ? `<span style="font-size:11px;color:#718096;background:#edf2f7;padding:2px 6px;border-radius:4px">Bloqueado</span>` : '';
      return `<tr style="${style}">
        <td style="padding:6px 8px;border-bottom:1px solid var(--color-border,#e2e8f0)">
          <input type="checkbox" class="cmp-chk" data-id="${esc(id)}" ${isBlq ? 'disabled' : ''} ${isDes || isBlq ? '' : 'checked'}>
        </td>
        ${cols.map(k => `<td style="padding:6px 8px;border-bottom:1px solid var(--color-border,#e2e8f0);font-size:13px">${esc(c[k]) || '—'}</td>`).join('')}
        <td style="padding:6px 8px;border-bottom:1px solid var(--color-border,#e2e8f0)">${nuncaBtn}${badge}</td>
      </tr>`;
    }).join('');
  }

  function _updateCounter() {
    const sel = _countSel();
    overlay.querySelector('#cmp-counter').textContent = `${sel} de ${contatos.length} selecionados`;
    const btn = overlay.querySelector('#cmp-confirmar');
    btn.disabled = sel === 0;
    btn.textContent = sel === 0 ? 'Nenhum contato selecionado' : `📞 Enviar ${sel} para discagem`;
  }

  function _rebuildTable() {
    overlay.querySelector('#cmp-tbody').innerHTML = _buildRows();
    _bindRowEvents();
    _updateCounter();
  }

  function _bindRowEvents() {
    overlay.querySelectorAll('.cmp-chk').forEach(chk => {
      chk.onchange = () => {
        if (!chk.checked) desmarcados.add(chk.dataset.id);
        else desmarcados.delete(chk.dataset.id);
        _rebuildTable();
      };
    });
    overlay.querySelectorAll('.cmp-nunca').forEach(btn => {
      btn.onclick = async () => {
        const { id, nome } = btn.dataset;
        if (!confirm(`Adicionar ${nome} à lista de não ligar? Esta pessoa não será incluída em nenhuma campanha futura.`)) return;
        btn.disabled = true; btn.textContent = '...';
        try {
          await backendApi('POST', '/api/campanhas/nao-ligar', { tipo: tipo === 'abc' ? 'paciente' : 'lead', id });
          bloqueados.add(id);
          desmarcados.delete(id); // evita dupla subtração em _countSel()
          _rebuildTable();
        } catch (e) {
          btn.disabled = false; btn.textContent = '🚫 Nunca ligar';
          toast(e.message || 'Erro ao salvar.', 'error');
        }
      };
    });
  }

  const avisoExtra = total > 100
    ? `<p style="font-size:12px;color:#718096;margin:8px 0 0;padding:8px;background:#fffbeb;border-radius:6px;border:1px solid #fbd38d">ℹ️ Mostrando os primeiros 100 de ${total}. Os demais serão incluídos automaticamente. Use 🚫 Nunca ligar para excluí-los permanentemente.</p>`
    : '';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:620px;max-height:85vh;display:flex;flex-direction:column">
      <h3 class="modal__title">${esc(titulo)} — ${total} contatos</h3>
      <p style="font-size:13px;color:var(--color-text-muted,#718096);margin:0 0 8px">${esc(sub)}</p>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <label style="font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="cmp-selectall" checked> Selecionar todos
        </label>
        <span id="cmp-counter" style="font-size:12px;color:#718096"></span>
      </div>
      <div style="overflow-y:auto;flex:1;border:1px solid var(--color-border,#e2e8f0);border-radius:8px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="width:32px;padding:8px;background:var(--color-surface-alt,#f7fafc);border-bottom:2px solid var(--color-border,#e2e8f0)"></th>
            ${colLabels.map(l => `<th style="padding:8px;text-align:left;font-size:12px;background:var(--color-surface-alt,#f7fafc);border-bottom:2px solid var(--color-border,#e2e8f0)">${l}</th>`).join('')}
            <th style="padding:8px;background:var(--color-surface-alt,#f7fafc);border-bottom:2px solid var(--color-border,#e2e8f0)"></th>
          </tr></thead>
          <tbody id="cmp-tbody"></tbody>
        </table>
      </div>
      ${avisoExtra}
      <div class="modal__actions" style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px">
        <button id="cmp-cancelar" class="btn btn--ghost">Cancelar</button>
        <button id="cmp-confirmar" class="btn btn--success">📞 Enviar ${contatos.length} para discagem</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  _rebuildTable();

  overlay.querySelector('#cmp-selectall').onchange = e => {
    if (e.target.checked) desmarcados.clear();
    else contatos.forEach(c => { const id = String(c[idField]||''); if (!bloqueados.has(id)) desmarcados.add(id); });
    _rebuildTable();
  };
  overlay.querySelector('#cmp-cancelar').onclick = () => overlay.remove();
  overlay.querySelector('#cmp-confirmar').onclick = async () => {
    const btn = overlay.querySelector('#cmp-confirmar');
    const excluir = [...desmarcados];
    const sel = _countSel();
    btn.disabled = true; btn.textContent = 'Enviando...';
    try {
      await backendApi('POST', '/api/campanhas/lancar', { tipo, excluir });
      overlay.remove();
      toast(`Campanha iniciada! ${sel} contatos na fila de discagem.`);
      if (window.campanhaWidgetRefresh) window.campanhaWidgetRefresh();
    } catch (e) {
      btn.disabled = false; btn.textContent = `📞 Enviar ${sel} para discagem`;
      toast(e.message, 'error');
    }
  };
}

window.lancarCampanhaABC = lancarCampanhaABC;