# Inadimplência 2.0 — Fase 3 (Ponto de Desistência) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar um bloco "Ponto de Desistência" na aba Inadimplência mostrando, entre os planos parcelados que travaram, a distribuição de "parou na parcela N" (do começo) e "faltando N pro fim" (do fim).

**Architecture:** Uma função pura nova `pontoDesistencia` em `lib/financeiro/recuperacao.js` (reusa os helpers de lá, testada com `node:test`) reconstrói o ponto de parada por tratamento. O `fetchInadimplentesBackground` já existente anexa `resultado.desistencia`. O frontend renderiza um bloco com dois histogramas de barras em SVG inline.

**Tech Stack:** Node.js, `node:test`/`node:assert`, frontend HTML/CSS/JS vanilla + SVG inline.

## Global Constraints

- **Fonte única:** os mesmos `allItems` de 24 meses do `/payment/list` já coletados no `fetchInadimplentesBackground`. **Nenhuma chamada Clinicorp nova, nenhum endpoint novo.**
- **Aditivo:** não remover/alterar nada existente. A função nova vai em `recuperacao.js` reusando `dia`/`valor`/`recebida` de lá (não criar 3º arquivo, não reimplementar helpers).
- **`MaxInstallmentsCount` é lixo — NÃO usar.** Tamanho do plano = `max(InstallmentNumber) + 1` por tratamento. `InstallmentNumber` é 0-based (0 = entrada).
- **Renegociação:** descartar itens com `Canceled` verdadeiro (`'X'` ou `true`); deduplicar por `InstallmentNumber` (posição conta como paga se qualquer item não-cancelado nela foi recebido).
- **Coorte = só planos que travaram** (existe posição não paga e vencida após a última paga). Fora: quitados e em-dia.
- **Puras:** sem IO/relógio além do `hoje` passado; datas `.slice(0,10)`.
- **Frontend vanilla:** SVG inline, sem Chart.js/script externo; reusar `_svgEscala`/`_inadFmt` e as CSS vars existentes.
- Runner: `node --test "lib/**/*.test.js"`. `lib/monitor/crc.test.js` tem 3 falhas PRÉ-EXISTENTES — ignorar.
- Commit só os arquivos da task (`git add <arquivos>`, nunca `git add -A`).

---

## File Structure

- **Modify** `lib/financeiro/recuperacao.js` — adicionar `pontoDesistencia(items, hojeISO)` + exportar.
- **Modify** `lib/financeiro/recuperacao.test.js` — testes da função nova.
- **Modify** `server.js` — adicionar `desistencia:` ao objeto `processado.resultado` (~L3627).
- **Modify** `public/index.html` — bloco markup `#inad-desistencia`; CSS `.inad-des-grid`; helpers `_svgDesistencia`/`renderInadDesistencia`; chamada em `renderInadResultado`.

---

## Task 1: `pontoDesistencia` na lib (TDD)

**Files:**
- Modify: `lib/financeiro/recuperacao.js`
- Test: `lib/financeiro/recuperacao.test.js`

**Interfaces:**
- Produces: `pontoDesistencia(items, hojeISO) -> { parouEm: [{parcela:number, planos:number}], faltando: [{faltam:number, planos:number}], totalTravados: number, modaParouEm: number|null }`. `parcela` 0-based (0 = entrada); `faltam` agrupado em `10` para "10+"; ambos ordenados crescente. Consumido por Task 2.

- [ ] **Step 1: Escrever os testes que falham**

Adicionar ao final de `lib/financeiro/recuperacao.test.js` (antes de nada; append):

```js
const { pontoDesistencia } = require('./recuperacao');

test('pontoDesistencia: parou na parcela N e faltando pro fim (plano que travou)', () => {
  const items = [
    { TreatmentId: 'A', InstallmentNumber: 0, ReceivedDate: '2026-01-01' },
    { TreatmentId: 'A', InstallmentNumber: 1, ReceivedDate: '2026-02-01' },
    { TreatmentId: 'A', InstallmentNumber: 2, ReceivedDate: '2026-03-01' },
    { TreatmentId: 'A', InstallmentNumber: 3, DueDate: '2026-04-01' }, // não paga, vencida
  ];
  const r = pontoDesistencia(items, '2026-07-15');
  assert.equal(r.totalTravados, 1);
  assert.deepEqual(r.parouEm, [{ parcela: 3, planos: 1 }]);   // planLen 4, ultimaPaga 2 → parou na 3
  assert.deepEqual(r.faltando, [{ faltam: 1, planos: 1 }]);   // 4 - 3 = 1
  assert.equal(r.modaParouEm, 3);
});

test('pontoDesistencia: ignora Canceled + dedup por posição (renegociação)', () => {
  const items = [
    { TreatmentId: 'B', InstallmentNumber: 0, ReceivedDate: '2026-01-01' },
    { TreatmentId: 'B', InstallmentNumber: 1, Canceled: 'X', DueDate: '2026-02-01' }, // cancelada → ignora
    { TreatmentId: 'B', InstallmentNumber: 1, ReceivedDate: '2026-02-05' },           // renegociada, paga
    { TreatmentId: 'B', InstallmentNumber: 2, DueDate: '2026-03-01' },                // não paga, vencida
  ];
  const r = pontoDesistencia(items, '2026-07-15');
  assert.equal(r.totalTravados, 1);
  assert.deepEqual(r.parouEm, [{ parcela: 2, planos: 1 }]);   // planLen 3, ultimaPaga 1 (dedup paga) → parou na 2
  assert.deepEqual(r.faltando, [{ faltam: 1, planos: 1 }]);
});

test('pontoDesistencia: exclui quitado e em-dia; entrada nunca paga = parcela 0; faltando 10+', () => {
  const items = [
    // C: quitado (tudo pago) → fora
    { TreatmentId: 'C', InstallmentNumber: 0, ReceivedDate: '2026-01-01' },
    { TreatmentId: 'C', InstallmentNumber: 1, ReceivedDate: '2026-02-01' },
    // D: em-dia (próxima ainda não venceu) → fora
    { TreatmentId: 'D', InstallmentNumber: 0, ReceivedDate: '2026-01-01' },
    { TreatmentId: 'D', InstallmentNumber: 1, DueDate: '2026-12-01' }, // futura
    // E: nunca pagou, entrada vencida, plano de 12 → parou na 0, faltando 12 → bucket 10
    ...Array.from({ length: 12 }, (_, i) => ({ TreatmentId: 'E', InstallmentNumber: i, DueDate: '2026-04-01' })),
  ];
  const r = pontoDesistencia(items, '2026-07-15');
  assert.equal(r.totalTravados, 1);                          // só E
  assert.deepEqual(r.parouEm, [{ parcela: 0, planos: 1 }]);
  assert.deepEqual(r.faltando, [{ faltam: 10, planos: 1 }]); // 12 → "10+"
  assert.equal(r.modaParouEm, 0);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test "lib/financeiro/recuperacao.test.js"`
Expected: FAIL — `pontoDesistencia` não é uma função / undefined.

- [ ] **Step 3: Implementar a função**

Em `lib/financeiro/recuperacao.js`, ANTES da linha `module.exports = ...`, adicionar:

```js
// Ponto de desistência: por tratamento, onde o pagamento parou.
// planLen = max(InstallmentNumber)+1 (o MaxInstallmentsCount da API é lixo).
// Ignora Canceled; dedup por posição (paga se qualquer não-cancelada foi recebida).
// Coorte = só planos travados (posição não paga e vencida após a última paga).
function pontoDesistencia(items, hojeISO) {
  const hoje = dia(hojeISO);
  const byT = new Map(); // TreatmentId -> Map(pos -> {paga, vencidaAberta})
  for (const it of (items || [])) {
    if (it.Canceled === 'X' || it.Canceled === true) continue;
    const t = String(it.TreatmentId || '');
    if (!t) continue;
    const n = Number(it.InstallmentNumber);
    if (Number.isNaN(n)) continue;
    if (!byT.has(t)) byT.set(t, new Map());
    const pos = byT.get(t);
    const cur = pos.get(n) || { paga: false, vencidaAberta: false };
    const due = dia(it.DueDate);
    if (recebida(it)) cur.paga = true;
    else if (due && due < hoje) cur.vencidaAberta = true;
    pos.set(n, cur);
  }
  const parouCount = new Map(), faltaCount = new Map();
  let totalTravados = 0;
  for (const pos of byT.values()) {
    const nums = [...pos.keys()];
    if (!nums.length) continue;
    const planLen = Math.max(...nums) + 1;
    const pagas = nums.filter(k => pos.get(k).paga);
    const ultimaPaga = pagas.length ? Math.max(...pagas) : -1;
    const travou = nums.some(k => k > ultimaPaga && pos.get(k).vencidaAberta && !pos.get(k).paga);
    if (!travou) continue;
    totalTravados++;
    const parouEm = ultimaPaga + 1;             // 0 = nunca pagou (entrada)
    const faltando = planLen - parouEm;         // parcelas da falha até o fim
    parouCount.set(parouEm, (parouCount.get(parouEm) || 0) + 1);
    const fk = faltando >= 10 ? 10 : faltando;  // 10 = "10+"
    faltaCount.set(fk, (faltaCount.get(fk) || 0) + 1);
  }
  let modaParouEm = null, modaN = 0;
  for (const [k, v] of parouCount) if (v > modaN) { modaN = v; modaParouEm = k; }
  const parouEm = [...parouCount.entries()].sort((a, b) => a[0] - b[0]).map(([parcela, planos]) => ({ parcela, planos }));
  const faltando = [...faltaCount.entries()].sort((a, b) => a[0] - b[0]).map(([faltam, planos]) => ({ faltam, planos }));
  return { parouEm, faltando, totalTravados, modaParouEm };
}
```

E alterar a linha de export para incluir a função:

```js
module.exports = { recuperacaoPorMes, vencidoRetroativo, pontoDesistencia };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test "lib/financeiro/recuperacao.test.js"`
Expected: PASS (os 3 testes de recuperação/vencido anteriores + os 3 novos de desistência).

- [ ] **Step 5: Suíte inteira**

Run: `npm test`
Expected: `lib/financeiro/*` passa; as 3 falhas de `lib/monitor/crc.test.js` são pré-existentes (ignorar).

- [ ] **Step 6: Commit**

```bash
git add lib/financeiro/recuperacao.js lib/financeiro/recuperacao.test.js
git commit -m "feat(inad): pontoDesistencia (parou-na-parcela / faltando-pro-fim) na lib (TDD)"
```

---

## Task 2: Anexar `desistencia` ao `resultado` no server

**Files:**
- Modify: `server.js` (o objeto `processado.resultado = { ... }` no `fetchInadimplentesBackground`, ~L3627)

**Interfaces:**
- Consumes: `pontoDesistencia` (Task 1), já via `const _recuperacao = require('./lib/financeiro/recuperacao');` (import existente da Fase 2).
- Produces: `resultado.desistencia = { parouEm, faltando, totalTravados, modaParouEm }` no cache, consumido pela Task 3.

- [ ] **Step 1: Adicionar a linha ao objeto `resultado`**

Localizar por conteúdo o bloco (dentro de `fetchInadimplentesBackground`):

```js
    processado.resultado = {
      recuperacao: _recuperacao.recuperacaoPorMes(allItems, today, 12),
      vencido:     _recuperacao.vencidoRetroativo(allItems, today, 24),
      aging:       _analiseParcelas.agingVencido(allItems, today),
    };
```

Adicionar a linha `desistencia`:

```js
    processado.resultado = {
      recuperacao: _recuperacao.recuperacaoPorMes(allItems, today, 12),
      vencido:     _recuperacao.vencidoRetroativo(allItems, today, 24),
      aging:       _analiseParcelas.agingVencido(allItems, today),
      desistencia: _recuperacao.pontoDesistencia(allItems, today),
    };
```

(Confirmar que `_recuperacao` já está importado no topo — é da Fase 2; se não estiver, é um bug de merge: reportar.)

- [ ] **Step 2: Verificar**

Run: `node --check server.js` → sem saída.
Run: `grep -n "pontoDesistencia\|desistencia:" server.js` → 1 ocorrência (a nova linha).
(Runtime deferido ao pós-deploy — cache só recomputa no refresh.)

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(inad): anexa desistencia ao resultado do cache de inadimplentes"
```

---

## Task 3: Frontend — bloco "Ponto de Desistência" (SVG)

**Files:**
- Modify: `public/index.html` — markup (após `#inad-resultado`, ~L1270); CSS (`.inad-des-grid`, junto ao `.inad-res-*`); helpers (`_svgDesistencia`, `renderInadDesistencia`, perto de `renderInadResultado` ~L5485); chamada dentro de `renderInadResultado`.

**Interfaces:**
- Consumes: `data.resultado.desistencia = { parouEm:[{parcela,planos}], faltando:[{faltam,planos}], totalTravados, modaParouEm }` (Task 2); helper `_svgEscala` (existente).

- [ ] **Step 1: Markup do bloco**

Em `public/index.html`, logo APÓS o fechamento do `<div id="inad-resultado">` (a linha `</div>` após o `.inad-res-nota`, ~L1270) e ANTES de `<div id="inad-error-bar" ...>`, inserir:

```html
  <div id="inad-desistencia" class="inad-resultado" style="display:none">
    <div class="inad-res-titulo">Ponto de Desistência</div>
    <div id="inad-des-resumo" style="font-size:12px;color:var(--muted);margin-bottom:10px"></div>
    <div class="inad-des-grid">
      <div class="inad-res-card">
        <div class="inad-res-card-tit">Parou na parcela <span class="inad-res-sub">(do começo)</span></div>
        <div id="inad-des-parou"></div>
      </div>
      <div class="inad-res-card">
        <div class="inad-res-card-tit">Faltando pro fim <span class="inad-res-sub">(parcelas que restavam)</span></div>
        <div id="inad-des-falta"></div>
      </div>
    </div>
    <div class="inad-res-nota">Só planos parcelados que travaram (pagou, parou, e a próxima venceu). Tamanho do plano estimado pelas parcelas geradas; renegociações e planos com mais de 24 meses podem não aparecer completos.</div>
  </div>
```

- [ ] **Step 2: CSS**

Junto ao bloco `.inad-res-grid { ... }` (perto de `.inad-resultado {`), adicionar:

```css
.inad-des-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 900px) { .inad-des-grid { grid-template-columns: 1fr; } }
```

- [ ] **Step 3: Helpers de render**

Logo ANTES de `function renderInadResultado(resultado) {` (~L5485), adicionar:

```js
// Histograma de barras verticais genérico (planos por bucket).
function _svgDesistencia(dados, getLabel, cor) {
  if (!dados || !dados.length) return '<div style="color:var(--muted);font-size:12px">Sem planos travados</div>';
  const W = 300, H = 130, pad = 18, n = dados.length;
  const esc = _svgEscala(dados.map(d => d.planos));
  const slot = (W - pad * 2) / n, bw = Math.min(24, slot * 0.6);
  let bars = '';
  dados.forEach((d, i) => {
    const x = pad + i * slot + slot / 2;
    const h = esc(d.planos) * (H - 34);
    bars += `<rect x="${(x - bw / 2).toFixed(1)}" y="${(H - 20 - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${cor}" opacity="0.9"/>`;
    bars += `<text x="${x.toFixed(1)}" y="${(H - 20 - h - 3).toFixed(1)}" font-size="8" fill="var(--text)" text-anchor="middle">${d.planos}</text>`;
    bars += `<text x="${x.toFixed(1)}" y="${H - 6}" font-size="8" fill="var(--muted)" text-anchor="middle">${getLabel(d)}</text>`;
  });
  return `<svg class="inad-res-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${bars}</svg>`;
}

function renderInadDesistencia(des) {
  const box = document.getElementById('inad-desistencia');
  if (!des || !des.totalTravados) { box.style.display = 'none'; return; }
  const lblParou = d => d.parcela === 0 ? 'entrada' : d.parcela + 'ª';
  const lblFalta = d => d.faltam >= 10 ? '10+' : String(d.faltam);
  const moda = des.modaParouEm === 0 ? 'na entrada' : 'na ' + des.modaParouEm + 'ª parcela';
  document.getElementById('inad-des-resumo').innerHTML =
    `<span class="inad-res-manchete" style="color:var(--red)">${des.totalTravados}</span> planos travados · a maioria trava <b>${moda}</b>`;
  document.getElementById('inad-des-parou').innerHTML = _svgDesistencia(des.parouEm, lblParou, 'var(--red)');
  document.getElementById('inad-des-falta').innerHTML = _svgDesistencia(des.faltando, lblFalta, 'var(--yellow)');
  box.style.display = 'block';
}
```

- [ ] **Step 4: Chamar dentro de `renderInadResultado`**

Alterar `renderInadResultado` para também tratar a desistência (esconder quando não há `resultado`, renderizar quando há):

```js
function renderInadResultado(resultado) {
  const box = document.getElementById('inad-resultado');
  if (!resultado) { box.style.display = 'none'; renderInadDesistencia(null); return; }
  document.getElementById('inad-res-recup').innerHTML   = _svgRecuperacao(resultado.recuperacao);
  document.getElementById('inad-res-vencido').innerHTML = _svgVencido(resultado.vencido);
  document.getElementById('inad-res-aging').innerHTML   = _svgAging(resultado.aging);
  box.style.display = 'block';
  renderInadDesistencia(resultado.desistencia);
}
```

- [ ] **Step 5: Verificação estrutural (sem browser)**

- `grep -n "renderInadDesistencia\|_svgDesistencia\|inad-des-parou\|inad-des-falta" public/index.html` → helpers definidos + chamada em `renderInadResultado` + os dois divs no markup (6+ hits).
- Confirmar que `<div id="inad-desistencia">` e os divs `inad-des-resumo/parou/falta` existem; que `renderInadDesistencia(null)` esconde sem erro; e que `renderInadDesistencia({totalTravados:0,...})` também esconde.
- Verificação visual (login → Inadimplência → "Atualizar dados") é **pós-deploy**.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat(inad): bloco Ponto de Desistencia (parou-na-parcela / faltando) em SVG"
```

---

## Self-Review (feito)

- **Cobertura da spec:** dois cortes parou-na-parcela + faltando-pro-fim (T1 `pontoDesistencia` + T3 dois SVG) ✓; planLen = max(InstallmentNumber)+1, MaxInstallmentsCount não usado (T1) ✓; filtra Canceled + dedup por posição (T1) ✓; coorte = só travados, exclui quitado/em-dia (T1 + teste) ✓; rótulos entrada/1ª e "10+" (T1 bucket + T3 labels) ✓; anexado ao resultado do background sem chamada nova (T2) ✓; SVG inline sem Chart.js, esconde quando ausente/zero (T3) ✓; resumo com a moda (T3) ✓.
- **Placeholders:** nenhum — todo passo tem código/comando concretos.
- **Consistência de tipos:** `pontoDesistencia -> {parouEm:[{parcela,planos}], faltando:[{faltam,planos}], totalTravados, modaParouEm}` definido em T1 (def+testes), produzido em T2 (`resultado.desistencia`), consumido em T3 (`des.parouEm/.faltando/.totalTravados/.modaParouEm`; `d.parcela/.planos`, `d.faltam/.planos`) — batem.
- **Risco herdado:** planos >24m incompletos e renegociação — documentados na nota da UI (T3).
