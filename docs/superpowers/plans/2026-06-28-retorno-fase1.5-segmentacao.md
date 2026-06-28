# Retorno Fase 1.5 — Segmentação (Perio + Convênio + VIP) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fechar as réguas do Retorno antes do agente: perio passa a CONTAR como categoria de prevenção (+selo), gravar convênio (`bill_type`), e VIPs com intervalo por-paciente marcável inline na Curva ABC.

**Architecture:** Extensão da Fase 1 (já em produção). `lib/prevencao/classificacao.js` ganha categoria `perio`; `sync/clinicorp-sync.js` (`syncPrevencao`, que deriva de `producao_procedimentos`) agrega perio + grava `bill_type`; migração adiciona colunas; `public/js/pos-tratamento/curva-abc.js` ganha badges/filtro/régua-efetiva/marcação-VIP. Frontend é vanilla com cliente Supabase direto (RLS).

**Tech Stack:** Node.js, Supabase Postgres (migração via MCP `apply_migration`, projeto `mtqdpjhhqzvuklnlfpvi`), HTML/JS vanilla, `node:test`.

**Spec:** `docs/superpowers/specs/2026-06-26-retorno-prevencao-fase1.5-segmentacao-design.md`

## Convenções
- Worktree isolado `feat/retorno-fase15` (já criado, off `origin/main`). NÃO usar o checkout principal (concorrente).
- Testes: `node --test "lib/**/*.test.js"`. Sintaxe: `node --check <arquivo>`.
- syncPrevencao roda contra Clinicorp/Supabase prod (idempotente). Precisa de `.env` no worktree (já copiado em sessões anteriores; se faltar: `cp ../../../.env .env`).
- Deploy só ao final, após validação.

---

## Task 1: Classificador — sub-gengival vira categoria `perio`

**Files:**
- Modify: `lib/prevencao/classificacao.js:30`
- Test: `lib/prevencao/classificacao.test.js`

- [ ] **Step 1: Atualizar o teste (TDD) — sub-gengival passa a ser `perio`**

Em `lib/prevencao/classificacao.test.js`, no teste `'consulta sozinha, sub-gengival e tratamentos NÃO contam'`, **remover** a linha:
```js
  assert.strictEqual(classificar({ nome: '85300039 - Raspagem sub-gengival/alisamento radicular' }), null);
```
E adicionar um teste novo logo após esse bloco:
```js
test('sub-gengival/alisamento conta como perio', () => {
  assert.strictEqual(classificar({ nome: '85300039 - Raspagem sub-gengival/alisamento radicular' }), 'perio');
  assert.strictEqual(classificar({ nome: 'Raspagem Subgengival' }), 'perio');
  assert.strictEqual(classificar({ nome: 'Alisamento radicular' }), 'perio');
  // perio não vira infantil mesmo com odontopediatria
  assert.strictEqual(classificar({ nome: 'Raspagem sub-gengival', expertise: 'Odontopediatria' }), 'perio');
  // manutenção periodontal (sem raspagem) segue fora
  assert.strictEqual(classificar({ nome: 'Manutenção periodontal' }), null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/prevencao/classificacao.test.js`
Expected: FAIL no teste novo (`classificar(...sub-gengival...)` retorna `null`, esperado `'perio'`).

- [ ] **Step 3: Implementar**

Em `lib/prevencao/classificacao.js`, trocar a linha 30:
```js
  if (n.includes('sub') && n.includes('gengiv')) return null;   // raspagem sub-gengival = tratamento
```
por:
```js
  if ((n.includes('sub') && n.includes('gengiv')) || n.includes('alisamento radicular')) return 'perio'; // prevenção do periodontista
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/prevencao/classificacao.test.js`
Expected: PASS em todos.

- [ ] **Step 5: Commit**

```bash
git add lib/prevencao/classificacao.js lib/prevencao/classificacao.test.js
git commit -m "feat(prevencao): sub-gengival/alisamento vira categoria perio (conta)"
```

---

## Task 2: Migração — colunas perio + intervalo VIP

**Files:** aplicar via MCP `apply_migration` (projeto `mtqdpjhhqzvuklnlfpvi`), nome `prevencao_fase15`. Espelhar em `supabase/migrations/20260628120000_prevencao_fase15.sql`.

- [ ] **Step 1: Criar o arquivo de migração**

`supabase/migrations/20260628120000_prevencao_fase15.sql`:
```sql
alter table pacientes_abc
  add column if not exists perio boolean default false,
  add column if not exists ultima_prevencao_perio date;

alter table vip_pacientes
  add column if not exists intervalo_dias integer;
```

- [ ] **Step 2: Aplicar via MCP**

`apply_migration(name='prevencao_fase15', query=<conteúdo acima>)`.

- [ ] **Step 3: Verificar**

`execute_sql`:
```sql
select column_name from information_schema.columns
where table_name='pacientes_abc' and column_name in ('perio','ultima_prevencao_perio')
union all
select column_name from information_schema.columns
where table_name='vip_pacientes' and column_name='intervalo_dias';
```
Expected: 3 linhas.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260628120000_prevencao_fase15.sql
git commit -m "chore(prevencao): migration fase1.5 (perio + ultima_prevencao_perio + vip intervalo_dias)"
```

---

## Task 3: `syncPrevencao` — agregar perio, gravar bill_type, flag perio

**Files:**
- Modify: `sync/clinicorp-sync.js` (função `syncPrevencao`)

A função atual deriva de `producao_procedimentos`, agrega `{adulto, infantil}` por `paciente_id` e faz upsert em `pacientes_abc`. Precisa: (a) ler `bill_type`; (b) aceitar categoria `perio` no agregado; (c) gravar `bill_type` no evento; (d) upsert `ultima_prevencao_perio` + `perio` boolean.

- [ ] **Step 1: Incluir `bill_type` no SELECT de produção**

Localizar (na `syncPrevencao`):
```js
    selectAll('producao_procedimentos', 'procedure_name, executed_date, paciente_nome, dentist_name'),
```
Trocar por:
```js
    selectAll('producao_procedimentos', 'procedure_name, executed_date, paciente_nome, dentist_name, bill_type'),
```

- [ ] **Step 2: Evento com bill_type + agregar perio**

Localizar o bloco do loop que monta `eventos.push({...})` e o `aggByPac`:
```js
    const a = aggByPac.get(pac.id) || { clinicorp_id: cidStr, adulto: null, infantil: null };
    if (data > (a[categoria] || '')) a[categoria] = data;
    aggByPac.set(pac.id, a);
```
Trocar o `eventos.push(...)` para incluir `bill_type`:
```js
      eventos.push({ clinicorp_id: cidStr, data, categoria, procedimento: pr.procedure_name, profissional: pr.dentist_name || null, bill_type: pr.bill_type || null });
```
E o agregado para suportar `perio` (a chave `categoria` já é dinâmica — 'adulto'|'infantil'|'perio' — então só garantir o slot inicial):
```js
    const a = aggByPac.get(pac.id) || { clinicorp_id: cidStr, adulto: null, infantil: null, perio: null };
    if (data > (a[categoria] || '')) a[categoria] = data;
    aggByPac.set(pac.id, a);
```

- [ ] **Step 3: Upsert com ultima_prevencao_perio + perio + ultima incluindo perio**

Localizar a montagem de `rows` no final da função:
```js
  for (const [paciente_id, a] of aggByPac) {
    const ultima = [a.adulto, a.infantil].filter(Boolean).sort().slice(-1)[0] || null;
    rows.push({
      paciente_id, clinicorp_id: a.clinicorp_id,
      ultima_prevencao: ultima,
      ultima_prevencao_adulto: a.adulto,
      ultima_prevencao_infantil: a.infantil,
      dias_sem_prevencao: ultima ? daysSince(ultima) : null,
    });
  }
```
Trocar por (inclui perio no `ultima` + colunas):
```js
  for (const [paciente_id, a] of aggByPac) {
    const ultima = [a.adulto, a.infantil, a.perio].filter(Boolean).sort().slice(-1)[0] || null;
    rows.push({
      paciente_id, clinicorp_id: a.clinicorp_id,
      ultima_prevencao: ultima,
      ultima_prevencao_adulto: a.adulto,
      ultima_prevencao_infantil: a.infantil,
      ultima_prevencao_perio: a.perio,
      perio: a.perio != null,
      dias_sem_prevencao: ultima ? daysSince(ultima) : null,
    });
  }
```

- [ ] **Step 4: Verificar sintaxe**

Run: `node --check sync/clinicorp-sync.js`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add sync/clinicorp-sync.js
git commit -m "feat(prevencao): syncPrevencao agrega perio + grava bill_type + flag perio"
```

---

## Task 4: Rodar syncPrevencao e validar os dados

- [ ] **Step 1: Rodar (popula prod, idempotente)**

Run (do worktree, precisa de `.env`):
`node -e "require('./sync/clinicorp-sync').syncPrevencao().then(r=>{console.log(JSON.stringify(r));process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"`
Expected: log `Prevenção: N eventos, M pacientes agregados` sem erro.

- [ ] **Step 2: Validar via MCP `execute_sql`**

```sql
select
  (select count(*) from pacientes_abc where perio) com_perio,
  (select count(*) from pacientes_abc where ultima_prevencao_perio is not null) com_data_perio,
  (select count(*) from prevencao_eventos where categoria='perio') eventos_perio,
  (select count(*) from prevencao_eventos where bill_type is not null) com_billtype;
```
Expected: `com_perio` ≈ 40; `eventos_perio` > 0; `com_billtype` > 0 (antes era 0).

---

## Task 5: Curva ABC — VIP map, régua efetiva, badges, filtro cohorte, marcação VIP inline

**Files:**
- Modify: `public/js/pos-tratamento/curva-abc.js`
- Modify: `public/pos-tratamento/curva-abc.html`
- Modify: `public/css/pos-tratamento.css`

- [ ] **Step 1: VIP map + régua efetiva + statusPrev por intervalo**

No topo de `curva-abc.js`, após `let catPrev = "todas";` (linha ~10), adicionar:
```js
let vipMap = new Map(); // paciente_id -> intervalo_dias
const intervaloEfetivo = p => vipMap.has(p.paciente_id) ? (vipMap.get(p.paciente_id) || 120) : 180;
```
Trocar `prevCol` para incluir perio:
```js
const prevCol = () => catPrev === "adulto" ? "ultima_prevencao_adulto"
                    : catPrev === "infantil" ? "ultima_prevencao_infantil"
                    : catPrev === "perio" ? "ultima_prevencao_perio"
                    : "ultima_prevencao";
```
Trocar `statusPrev` para aceitar intervalo:
```js
function statusPrev(dateStr, intervalo = 180) {
  if (!dateStr) return { txt: "Nunca", cls: "st-nunca" };
  const dias = Math.floor((Date.now() - new Date(dateStr)) / 86400000);
  if (dias > intervalo) return { txt: `${dias}d`, cls: "st-vencido" };
  if (dias >= intervalo - 30) return { txt: `${dias}d`, cls: "st-perto" };
  return { txt: `${dias}d`, cls: "st-emdia" };
}
```

- [ ] **Step 2: Carregar VIPs no init**

Em `init()`, antes de `await carregar();`, adicionar `await carregarVips();`. Adicionar a função:
```js
async function carregarVips() {
  const { data } = await sb.from("vip_pacientes").select("paciente_id, intervalo_dias");
  vipMap = new Map((data || []).map(v => [v.paciente_id, v.intervalo_dias]));
}
```

- [ ] **Step 3: SELECT inclui perio; filtro de cohorte**

Na `carregar()`, trocar o `.select(...)`:
```js
    .select("paciente_id, clinicorp_id, nome, classe, total_receita, ultima_visita, dias_sem_visita, proxima_consulta, telefone, ultima_prevencao, ultima_prevencao_adulto, ultima_prevencao_infantil, ultima_prevencao_perio, perio, pacientes!inner(id, telefone_celular)", { count: "exact" })
```
Depois dos outros filtros (após `if (buscaTexto) ...`), adicionar o filtro de cohorte perio/VIP:
```js
  if (catPrev === "perio") q = q.eq("perio", true);
  else if (catPrev === "vip") {
    const ids = [...vipMap.keys()];
    q = q.in("paciente_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  }
```

- [ ] **Step 4: Badges Perio/VIP + status por régua efetiva + botão VIP por linha**

Na `renderTabela`, dentro do `.map`, trocar a célula de nome (o bloco `abc-patient-cell`) para incluir badges, e a célula de status para usar o intervalo efetivo. Substituir:
```js
                <div class="abc-patient-name">${p.nome||"—"}</div>
```
por:
```js
                <div class="abc-patient-name">${p.nome||"—"}
                  ${p.perio ? `<span class="cohorte-badge cb-perio">Perio</span>` : ""}
                  ${vipMap.has(p.paciente_id) ? `<span class="cohorte-badge cb-vip">⭐VIP ${vipMap.get(p.paciente_id) || 120}d</span>` : ""}
                  <button class="vip-toggle" data-pid="${p.paciente_id}" data-nome="${(p.nome||'').replace(/"/g,'&quot;')}" title="${vipMap.has(p.paciente_id) ? 'Remover VIP' : 'Marcar VIP'}">${vipMap.has(p.paciente_id) ? '★' : '☆'}</button>
                </div>
```
E a célula de status — substituir:
```js
          <td><span class="prev-status ${statusPrev(p[prevCol()]).cls}">${statusPrev(p[prevCol()]).txt}</span></td>
```
por:
```js
          <td><span class="prev-status ${statusPrev(p[prevCol()], intervaloEfetivo(p)).cls}">${statusPrev(p[prevCol()], intervaloEfetivo(p)).txt}</span></td>
```

- [ ] **Step 5: Handler do botão VIP (marca/desmarca + intervalo)**

No fim da `renderTabela` (após o bind dos `.abc-wa-btn`), adicionar:
```js
  wrap.querySelectorAll(".vip-toggle").forEach(btn => {
    btn.addEventListener("click", async () => {
      const pid = btn.dataset.pid, nome = btn.dataset.nome;
      if (vipMap.has(pid)) {
        if (!confirm(`Remover ${nome} dos VIPs?`)) return;
        const { error } = await sb.from("vip_pacientes").delete().eq("paciente_id", pid);
        if (error) { toast("Erro: " + error.message, "error"); return; }
        toast(`${nome} removido dos VIPs`);
      } else {
        const v = prompt(`Intervalo de retorno do VIP ${nome} (dias):`, "120");
        if (v === null) return;
        const intervalo = parseInt(v, 10);
        if (isNaN(intervalo) || intervalo < 1) { toast("Intervalo inválido", "error"); return; }
        const { data: { user } } = await sb.auth.getUser();
        const { error } = await sb.from("vip_pacientes").insert({ paciente_id: pid, adicionado_por: user?.id || null, intervalo_dias: intervalo, obs: "PPAMA" });
        if (error) { toast("Erro: " + error.message, "error"); return; }
        toast(`${nome} marcado como VIP (${intervalo}d)`);
      }
      await carregarVips();
      await carregar();
    });
  });
```

- [ ] **Step 6: Chips de cohorte no HTML**

Em `curva-abc.html`, no grupo `#prev-cat-chips` (que hoje tem Todas/Adulto/Infantil), adicionar os chips Perio e VIP:
```html
                <button class="abc-chip prev-cat" data-cat="perio">Perio</button>
                <button class="abc-chip prev-cat" data-cat="vip">VIP</button>
```
(colocar junto dos `data-cat="adulto"`/`"infantil"` existentes).

- [ ] **Step 7: CSS dos badges**

Em `public/css/pos-tratamento.css`, adicionar:
```css
.cohorte-badge{font-size:10px;font-weight:600;padding:1px 6px;border-radius:999px;margin-left:6px;vertical-align:middle}
.cb-perio{background:#e0e7ff;color:#3730a3}
.cb-vip{background:#fef3c7;color:#92400e}
.vip-toggle{background:none;border:none;cursor:pointer;font-size:14px;color:#d97706;margin-left:4px;vertical-align:middle}
```

- [ ] **Step 8: Verificar sintaxe + browser**

Run: `node --check public/js/pos-tratamento/curva-abc.js` → exit 0.
Subir local/logar: abrir `/pos-tratamento/curva-abc.html` → chips Perio/VIP filtram; badge Perio aparece (~40); marcar um paciente como VIP (★) com intervalo → vira ⭐VIP Nd e Status reflete o intervalo menor; desmarcar volta.

- [ ] **Step 9: Commit**

```bash
git add public/js/pos-tratamento/curva-abc.js public/pos-tratamento/curva-abc.html public/css/pos-tratamento.css
git commit -m "feat(prevencao): curva-abc — badges perio/VIP, régua efetiva, filtro cohorte, marcar VIP inline"
```

---

## Task 6: Nav — remover a página VIPs

**Files:**
- Modify: `public/js/nav-config.js` (seção `pos`)

- [ ] **Step 1: Remover o item `vips`**

Em `public/js/nav-config.js`, na seção `{ id: 'pos' ... }`, remover a linha do item `{ slug: 'vips', ... }`.

- [ ] **Step 2: Verificar + commit**

Run: `node --check public/js/nav-config.js` → exit 0.
```bash
git add public/js/nav-config.js
git commit -m "chore(nav): remove pagina VIPs (marcacao agora inline na Curva ABC)"
```

---

## Task 7: Validação final

- [ ] Suíte: `node --test "lib/**/*.test.js"` — sem novas falhas (as 3 pré-existentes de `lib/monitor/crc.test.js` permanecem).
- [ ] `execute_sql` confere perio (~40), eventos_perio>0, bill_type preenchido (Task 4 já fez).
- [ ] Manual: marcar/desmarcar VIP, filtro cohorte, badges (Task 5 Step 8).
- [ ] Deploy (após OK do Luiz): merge `feat/retorno-fase15` → main, push, deploy Easypanel.

---

## Self-Review (cobertura do spec)
- §2 Perio conta (categoria) → Task 1 (classificador) + Task 3 (agrega) + Task 5 (badge/filtro). ✅
- §2b bill_type/convênio → Task 2 (n/a) + Task 3 (grava). Regra por-paciente/dia já é o comportamento atual (dedup), inalterado. ✅
- §3 VIP intervalo por-paciente → Task 2 (coluna) + Task 5 (régua efetiva + marcação). ✅
- §4 marcar VIP inline + remove página → Task 5 (botão/handler) + Task 6 (nav). ✅
- §5 tela (badges, status efetivo, filtro cohorte) → Task 5. ✅
- Fora de escopo (agente, config periodontista, recall-log) — não incluído. ✅
