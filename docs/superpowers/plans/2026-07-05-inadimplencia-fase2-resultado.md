# Inadimplência 2.0 — Fase 2 (Resultado da Cobrança) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar uma seção "Resultado da Cobrança" no topo da aba Inadimplência com painel de recuperação (coorte por mês de vencimento), curva do vencido no tempo (24m retroativo) e aging compacto — tudo aditivo, computado dos dados que já são coletados.

**Architecture:** Uma lib pura nova (`lib/financeiro/recuperacao.js`, testada com `node:test`, no padrão de `analise-parcelas.js`) faz os agregados. O `fetchInadimplentesBackground` (que já tem os 24 meses de `/payment/list` na mão) anexa `resultado = {recuperacao, vencido, aging}` ao objeto do cache — zero chamada Clinicorp nova. O frontend (SPA `public/index.html`, aba `page-inadimplentes`) renderiza a seção com **SVG inline** (sem Chart.js).

**Tech Stack:** Node.js + Express, Supabase, `node:test`/`node:assert`, frontend HTML/CSS/JS vanilla + SVG inline. Reusa `lib/financeiro/analise-parcelas.js` (`agingVencido`).

## Global Constraints

- **Fonte única:** os mesmos `allItems` de 24 meses do `/payment/list` já coletados no `fetchInadimplentesBackground`. **Nenhuma chamada Clinicorp nova, nenhum endpoint novo.**
- **Aditivo:** não remover nem alterar nada do módulo A Receber (`public/financeiro/saude/*`, `saude-page.js`). Reusar `analise-parcelas.agingVencido`, não reimplementar aging.
- **Puras:** funções da lib nova sem IO, sem relógio além do `hoje` passado; datas podem vir com hora → normalizar com `.slice(0,10)`; arredondar dinheiro a 2 casas.
- **Frontend vanilla:** SVG inline, **sem Chart.js** na SPA (não adicionar script externo ao `index.html`). Reusar `_inadFmt` e as CSS vars existentes (`--red`, `--green`, `--yellow`, `--muted`, `--border`, `--text`, `--bg2`, `--bg3`).
- Runner de teste: `node --test "lib/**/*.test.js"` (`npm test`).
- Commit só os arquivos da task (`git add <arquivos>`, nunca `git add -A` — repo tem sessões concorrentes).
- Coorte imatura: meses recentes têm taxa naturalmente mais baixa (ainda em cobrança) — a UI sinaliza, não é bug.

---

## File Structure

- **Create** `lib/financeiro/recuperacao.js` — `recuperacaoPorMes(items, hoje, n)` e `vencidoRetroativo(items, hoje, n)`.
- **Create** `lib/financeiro/recuperacao.test.js` — testes `node:test`.
- **Modify** `server.js` — import da lib nova; anexar `processado.resultado` no `fetchInadimplentesBackground`.
- **Modify** `public/index.html` — markup da seção "Resultado da Cobrança" na aba `page-inadimplentes`; helpers SVG; chamada em `_renderInadData`.

---

## Task 1: Lib pura de recuperação + vencido retroativo (TDD)

**Files:**
- Create: `lib/financeiro/recuperacao.js`
- Test: `lib/financeiro/recuperacao.test.js`

**Interfaces:**
- Produces:
  - `recuperacaoPorMes(items, hojeISO, nMeses = 12) -> [{ mes: 'YYYY-MM', atrasou: number, recuperado: number, taxa: number|null }]` — por coorte do **mês de vencimento**: `atrasou` = soma das parcelas que venceram no mês e furaram o prazo (não recebidas OU recebidas depois do vencimento); `recuperado` = dessas, quanto já foi recebido; `taxa` = recuperado/atrasou (null se atrasou = 0). Ordem: mais antigo → mês atual.
  - `vencidoRetroativo(items, hojeISO, nMeses = 24) -> [{ mes: 'YYYY-MM', vencido: number }]` — saldo vencido em aberto no fim de cada mês (o mês corrente é cortado em `hoje`). Ordem: mais antigo → atual.
- Consumed by: Task 2 (`server.js`).

- [ ] **Step 1: Escrever os testes que falham**

```js
// lib/financeiro/recuperacao.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { recuperacaoPorMes, vencidoRetroativo } = require('./recuperacao');

const HOJE = '2026-07-15';

test('recuperacaoPorMes: coorte por mês de vencimento; atrasada=não paga ou paga após vencimento', () => {
  const items = [
    { DueDate: '2026-05-10', Amount: 100 },                                 // maio, não paga → atrasou
    { DueDate: '2026-05-20', Amount: 200, ReceivedDate: '2026-06-01' },     // maio, paga atrasada → atrasou+recuperado
    { DueDate: '2026-06-10', Amount: 50,  ReceivedDate: '2026-06-05' },     // junho, paga adiantada → fora
    { DueDate: '2026-06-15', Amount: 80 },                                  // junho, não paga → atrasou
    { DueDate: '2026-07-01', Amount: 300, ReceivedDate: '2026-07-01' },     // julho, paga no dia → fora
  ];
  const r = recuperacaoPorMes(items, HOJE, 3); // maio, junho, julho
  assert.deepEqual(r.map(x => x.mes), ['2026-05', '2026-06', '2026-07']);
  assert.deepEqual(r[0], { mes: '2026-05', atrasou: 300, recuperado: 200, taxa: 0.667 });
  assert.deepEqual(r[1], { mes: '2026-06', atrasou: 80,  recuperado: 0,   taxa: 0 });
  assert.deepEqual(r[2], { mes: '2026-07', atrasou: 0,   recuperado: 0,   taxa: null });
});

test('vencidoRetroativo: saldo vencido no fim de cada mês; paga em dia não conta; mês atual corta em hoje', () => {
  const items = [
    { DueDate: '2026-04-10', Amount: 100 },                                 // não paga → vencida em todos
    { DueDate: '2026-05-20', Amount: 200, ReceivedDate: '2026-06-10' },     // vencida só em maio (paga em jun/10)
    { DueDate: '2026-06-05', Amount: 50,  ReceivedDate: '2026-06-04' },     // paga (rec<=due-ish) → nunca vencida
    { DueDate: '2026-07-10', Amount: 400 },                                 // não paga; entra só em julho (due<=15/07)
  ];
  const r = vencidoRetroativo(items, HOJE, 3); // fins: maio-31, junho-30, julho-15(hoje)
  assert.deepEqual(r, [
    { mes: '2026-05', vencido: 300 },  // 100 + 200
    { mes: '2026-06', vencido: 100 },  // 100
    { mes: '2026-07', vencido: 500 },  // 100 + 400
  ]);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test "lib/financeiro/recuperacao.test.js"`
Expected: FAIL — `Cannot find module './recuperacao'`.

- [ ] **Step 3: Implementar a lib**

```js
// lib/financeiro/recuperacao.js
// Análises de RESULTADO da cobrança (/payment/list) p/ a aba Inadimplência.
// Puras: recebem itens crus + data 'YYYY-MM-DD'; datas podem vir com hora → slice(0,10).

const dia = s => (s || '').slice(0, 10);
const valor = it => Number(it.AmountWithDiscounts || it.Amount || it.TotalPostAmount || 0) || 0;
function recebida(it) {
  return it.PaymentReceived === 'X' ||
    !!(it.ReceivedDate && it.ReceivedDate !== '' && dia(it.ReceivedDate) !== '0001-01-01');
}
const arred = v => Math.round(v * 100) / 100;

// Meses 'YYYY-MM' dos últimos n (mais antigo → mês atual).
function ultimosMeses(hojeISO, n) {
  let [y, m] = hojeISO.slice(0, 7).split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    let ym = m - i, yy = y;
    while (ym < 1) { ym += 12; yy--; }
    out.push(`${yy}-${String(ym).padStart(2, '0')}`);
  }
  return out;
}

// Recuperação por COORTE do mês de vencimento.
function recuperacaoPorMes(items, hojeISO, nMeses = 12) {
  const meses = ultimosMeses(hojeISO, nMeses);
  const set = new Set(meses);
  const map = new Map(meses.map(mes => [mes, { atrasou: 0, recuperado: 0 }]));
  for (const it of (items || [])) {
    const due = dia(it.DueDate);
    if (!due) continue;
    const mes = due.slice(0, 7);
    if (!set.has(mes)) continue;
    const rec = recebida(it);
    const recDate = rec ? dia(it.ReceivedDate) : null;
    const atrasou = !rec || (recDate && recDate > due); // não paga, ou paga depois do vencimento
    if (!atrasou) continue;
    const v = valor(it);
    const o = map.get(mes);
    o.atrasou += v;
    if (rec) o.recuperado += v;
  }
  return meses.map(mes => {
    const o = map.get(mes);
    const a = arred(o.atrasou), r = arred(o.recuperado);
    return { mes, atrasou: a, recuperado: r, taxa: a > 0 ? Math.round((r / a) * 1000) / 1000 : null };
  });
}

// Saldo VENCIDO em aberto no fim de cada mês (retroativo). Mês corrente cortado em hoje.
function vencidoRetroativo(items, hojeISO, nMeses = 24) {
  const hoje = dia(hojeISO);
  const fimMes = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
  const meses = ultimosMeses(hoje, nMeses);
  const pontos = meses.map(mes => { const fm = fimMes(mes); return { mes, X: fm > hoje ? hoje : fm, vencido: 0 }; });
  for (const it of (items || [])) {
    const due = dia(it.DueDate);
    if (!due) continue;
    const rec = recebida(it) ? dia(it.ReceivedDate) : null;
    const v = valor(it);
    for (const p of pontos) {
      if (due <= p.X && (!rec || rec > p.X)) p.vencido += v;
    }
  }
  return pontos.map(p => ({ mes: p.mes, vencido: arred(p.vencido) }));
}

module.exports = { recuperacaoPorMes, vencidoRetroativo };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test "lib/financeiro/recuperacao.test.js"`
Expected: PASS (2 testes).

- [ ] **Step 5: Suíte inteira (não quebrou nada)**

Run: `npm test`
Expected: os testes de `lib/financeiro/*` passam (recuperacao + inadimplencia + analise-parcelas + fluxo-futuro). Obs.: `lib/monitor/crc.test.js` já tem 3 falhas PRÉ-EXISTENTES na main, não relacionadas — ignorar (não são desta mudança).

- [ ] **Step 6: Commit**

```bash
git add lib/financeiro/recuperacao.js lib/financeiro/recuperacao.test.js
git commit -m "feat(inad): lib pura de recuperacao + vencido retroativo (TDD)"
```

---

## Task 2: Anexar `resultado` ao cache no server

**Files:**
- Modify: `server.js` (require no topo, perto de `_analiseParcelas`; `fetchInadimplentesBackground` ~L3623, logo após `const processado = await processarInadimplentes(...)`)

**Interfaces:**
- Consumes: `recuperacaoPorMes`, `vencidoRetroativo` (Task 1); `_analiseParcelas.agingVencido` (já importado).
- Produces: `inadimplentes_cache.data.resultado = { recuperacao: [...], vencido: [...], aging: {faixas,total} }`, que sobrevive ao `mergeInadimplentesNotas` (faz `{ ...resultado, ... }`) e chega no `/api/inadimplentes`. Consumido pela Task 3.

- [ ] **Step 1: Importar a lib nova**

No topo de `server.js`, perto de `const _analiseParcelas = require('./lib/financeiro/analise-parcelas');`, adicionar:

```js
const _recuperacao = require('./lib/financeiro/recuperacao');
```

- [ ] **Step 2: Anexar `resultado` ao objeto do cache**

Em `fetchInadimplentesBackground`, logo após a linha `const processado = await processarInadimplentes(allItems, today);` e ANTES do `await supabase.from('inadimplentes_cache').upsert({...})`, inserir:

```js
    processado.resultado = {
      recuperacao: _recuperacao.recuperacaoPorMes(allItems, today, 12),
      vencido:     _recuperacao.vencidoRetroativo(allItems, today, 24),
      aging:       _analiseParcelas.agingVencido(allItems, today),
    };
```

(O `upsert` grava `data: processado`, então `resultado` vai junto. `mergeInadimplentesNotas` faz `{ ...resultado, grupo1: ... }`, preservando a chave `resultado`.)

- [ ] **Step 3: Verificar sintaxe + fiação**

Run: `node --check server.js`
Expected: sem saída.
Run: `grep -n "_recuperacao\|processado.resultado" server.js`
Expected: o require + a atribuição `processado.resultado = {...}` (2+ ocorrências do símbolo `_recuperacao`).

(Verificação em runtime — inspecionar `data->'resultado'` no cache — é deferida ao pós-deploy: o cache só recomputa no refresh. Não rodar o servidor nem forçar refresh aqui.)

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(inad): anexa resultado (recuperacao/vencido/aging) ao cache de inadimplentes"
```

---

## Task 3: Frontend — seção "Resultado da Cobrança" (SVG inline)

**Files:**
- Modify: `public/index.html` — markup da seção na aba `page-inadimplentes` (após a barra de header, antes dos cards KPI ~L1243); helpers SVG e `renderInadResultado` (perto de `_renderInadData` ~L5360); chamada dentro de `_renderInadData`.

**Interfaces:**
- Consumes: `data.resultado = { recuperacao:[{mes,atrasou,recuperado,taxa}], vencido:[{mes,vencido}], aging:{faixas:[{faixa,valor}],total} }` (Task 2); helper `_inadFmt`.

- [ ] **Step 1: Markup da seção**

No `public/index.html`, dentro de `<div id="page-inadimplentes" class="page">`, logo após a `<div>` do header (a que tem `<h1>Inadimplentes</h1>` e o botão `inad-refresh-btn`) e ANTES da barra de erro/aviso, inserir:

```html
  <div id="inad-resultado" class="inad-resultado" style="display:none">
    <div class="inad-res-titulo">Resultado da Cobrança</div>
    <div class="inad-res-grid">
      <div class="inad-res-card">
        <div class="inad-res-card-tit">Recuperação por mês <span class="inad-res-sub">(coorte do vencimento)</span></div>
        <div id="inad-res-recup"></div>
      </div>
      <div class="inad-res-card">
        <div class="inad-res-card-tit">Vencido no tempo <span class="inad-res-sub">(saldo em aberto, fim do mês)</span></div>
        <div id="inad-res-vencido"></div>
      </div>
      <div class="inad-res-card">
        <div class="inad-res-card-tit">Aging do vencido <span class="inad-res-sub">(idade do atraso)</span></div>
        <div id="inad-res-aging"></div>
      </div>
    </div>
    <div class="inad-res-nota">Meses recentes ainda estão em cobrança (taxa tende a subir). Histórico reconstruído dos pagamentos — renegociações antigas podem não aparecer.</div>
  </div>
```

- [ ] **Step 2: CSS da seção**

Junto ao bloco de estilos `.inad-*` do `index.html` (perto de `.inad-section {`), adicionar:

```css
.inad-resultado { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; margin-bottom: 18px; }
.inad-res-titulo { font-size: 14px; font-weight: 700; margin-bottom: 12px; }
.inad-res-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
@media (max-width: 900px) { .inad-res-grid { grid-template-columns: 1fr; } }
.inad-res-card { background: var(--bg3); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
.inad-res-card-tit { font-size: 12px; font-weight: 600; margin-bottom: 8px; }
.inad-res-sub { color: var(--muted); font-weight: 400; }
.inad-res-nota { margin-top: 10px; font-size: 11px; color: var(--muted); }
.inad-res-svg { width: 100%; height: auto; display: block; }
.inad-res-manchete { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
```

- [ ] **Step 3: Helpers SVG + render**

Perto de `_renderInadData` no `<script>` do `index.html`, adicionar:

```js
function _svgEscala(vals) { const m = Math.max(1, ...vals); return v => (v / m); }
function _mesCurto(ym) { return ym.slice(5) + '/' + ym.slice(2, 4); } // 'MM/AA'

// Barras agrupadas: atrasou (vermelho) x recuperado (verde) por mês.
function _svgRecuperacao(recup) {
  if (!recup || !recup.length) return '<div style="color:var(--muted);font-size:12px">Sem dados</div>';
  const W = 600, H = 150, pad = 22, n = recup.length;
  const esc = _svgEscala(recup.map(r => r.atrasou));
  const slot = (W - pad * 2) / n, bw = Math.min(10, slot / 3);
  let bars = '';
  recup.forEach((r, i) => {
    const x = pad + i * slot + slot / 2;
    const hA = esc(r.atrasou) * (H - 40), hR = esc(r.recuperado) * (H - 40);
    const recente = i >= n - 2;
    bars += `<rect x="${(x - bw - 1).toFixed(1)}" y="${(H - 20 - hA).toFixed(1)}" width="${bw}" height="${hA.toFixed(1)}" fill="var(--red)" opacity="${recente ? 0.5 : 0.9}"/>`;
    bars += `<rect x="${(x + 1).toFixed(1)}" y="${(H - 20 - hR).toFixed(1)}" width="${bw}" height="${hR.toFixed(1)}" fill="var(--green)" opacity="${recente ? 0.5 : 0.9}"/>`;
    if (i % 2 === 0 || n <= 6) bars += `<text x="${x.toFixed(1)}" y="${H - 6}" font-size="8" fill="var(--muted)" text-anchor="middle">${_mesCurto(r.mes)}</text>`;
  });
  const totA = recup.reduce((s, r) => s + r.atrasou, 0), totR = recup.reduce((s, r) => s + r.recuperado, 0);
  const taxaGeral = totA > 0 ? Math.round((totR / totA) * 100) : 0;
  return `<div class="inad-res-manchete" style="color:var(--green)">${taxaGeral}% recuperado</div>` +
    `<div style="font-size:11px;color:var(--muted);margin-bottom:6px">${_inadFmt(totR)} de ${_inadFmt(totA)} que atrasaram (12m)</div>` +
    `<svg class="inad-res-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${bars}</svg>` +
    `<div style="font-size:10px;color:var(--muted);margin-top:4px"><span style="color:var(--red)">■</span> atrasou &nbsp; <span style="color:var(--green)">■</span> recuperado &nbsp; (barras claras = meses recentes, ainda em cobrança)</div>`;
}

// Linha do saldo vencido no tempo.
function _svgVencido(venc) {
  if (!venc || !venc.length) return '<div style="color:var(--muted);font-size:12px">Sem dados</div>';
  const W = 600, H = 150, pad = 22, n = venc.length;
  const esc = _svgEscala(venc.map(v => v.vencido));
  const px = i => pad + (n === 1 ? (W - pad * 2) / 2 : i * (W - pad * 2) / (n - 1));
  const py = v => (H - 20) - esc(v) * (H - 40);
  const pts = venc.map((v, i) => `${px(i).toFixed(1)},${py(v.vencido).toFixed(1)}`).join(' ');
  const ult = venc[venc.length - 1], prim = venc[0];
  const seta = ult.vencido > prim.vencido ? '<span style="color:var(--red)">▲ subindo</span>' : '<span style="color:var(--green)">▼ caindo</span>';
  let labels = '';
  [0, Math.floor(n / 2), n - 1].forEach(i => { if (venc[i]) labels += `<text x="${px(i).toFixed(1)}" y="${H - 6}" font-size="8" fill="var(--muted)" text-anchor="middle">${_mesCurto(venc[i].mes)}</text>`; });
  return `<div class="inad-res-manchete" style="color:var(--red)">${_inadFmt(ult.vencido)}</div>` +
    `<div style="font-size:11px;color:var(--muted);margin-bottom:6px">saldo vencido hoje · ${seta}</div>` +
    `<svg class="inad-res-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">` +
    `<polyline points="${pts}" fill="none" stroke="var(--red)" stroke-width="2"/>${labels}</svg>`;
}

// Barra horizontal empilhada do aging.
function _svgAging(aging) {
  const faixas = (aging && aging.faixas) || [];
  const tot = faixas.reduce((s, f) => s + f.valor, 0);
  if (!tot) return '<div style="color:var(--muted);font-size:12px">Sem vencido</div>';
  const cores = ['var(--green)', 'var(--yellow)', '#f59e0b', 'var(--red)', '#b91c1c'];
  let x = 0, segs = '', legenda = '';
  faixas.forEach((f, i) => {
    const w = (f.valor / tot) * 100;
    segs += `<div style="width:${w}%;background:${cores[i] || 'var(--muted)'}" title="${f.faixa}: ${_inadFmt(f.valor)}"></div>`;
    if (f.valor > 0) legenda += `<span style="white-space:nowrap"><span style="color:${cores[i]}">■</span> ${f.faixa}: ${_inadFmt(f.valor)}</span>`;
  });
  return `<div class="inad-res-manchete" style="color:var(--red)">${_inadFmt(tot)}</div>` +
    `<div style="font-size:11px;color:var(--muted);margin-bottom:8px">total vencido em aberto</div>` +
    `<div style="display:flex;height:18px;border-radius:5px;overflow:hidden">${segs}</div>` +
    `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;font-size:10px;color:var(--muted)">${legenda}</div>`;
}

function renderInadResultado(resultado) {
  const box = document.getElementById('inad-resultado');
  if (!resultado) { box.style.display = 'none'; return; }
  document.getElementById('inad-res-recup').innerHTML   = _svgRecuperacao(resultado.recuperacao);
  document.getElementById('inad-res-vencido').innerHTML = _svgVencido(resultado.vencido);
  document.getElementById('inad-res-aging').innerHTML   = _svgAging(resultado.aging);
  box.style.display = 'block';
}
```

- [ ] **Step 4: Chamar no `_renderInadData`**

Dentro de `_renderInadData(data)`, adicionar (perto do início, após o cálculo dos KPIs):

```js
  renderInadResultado(data.resultado);
```

- [ ] **Step 5: Verificação estrutural**

- `grep -n "renderInadResultado\|_svgRecuperacao\|_svgVencido\|_svgAging" public/index.html` → definição de cada helper + a chamada em `_renderInadData` (5+ ocorrências).
- Confirmar que o `<div id="inad-resultado">` e os três alvos (`inad-res-recup/vencido/aging`) existem no markup.
- Verificação visual (login → Inadimplência → "Atualizar dados") é **pós-deploy** (sem browser aqui). Antes do refresh, `data.resultado` é `undefined` no cache antigo → `renderInadResultado(undefined)` esconde a seção (sem erro). Após refresh, a seção aparece.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat(inad): secao Resultado da Cobranca (recuperacao/vencido/aging) em SVG"
```

---

## Self-Review (feito)

- **Cobertura da spec:** painel de recuperação (T1 `recuperacaoPorMes` + T3 `_svgRecuperacao`) ✓; curva do vencido retroativa 24m (T1 `vencidoRetroativo` + T3 `_svgVencido`) ✓; aging compacto espelhado da lib compartilhada (T2 reusa `agingVencido` + T3 `_svgAging`) ✓; agregados no `fetchInadimplentesBackground` sem chamada nova, anexados ao cache (T2) ✓; SVG inline sem Chart.js (T3) ✓; nada removido do A Receber ✓; coorte imatura sinalizada (T3 barras claras + nota) ✓; aproximação documentada (T3 nota) ✓.
- **Placeholders:** nenhum — todo passo tem código/comando/saída concretos.
- **Consistência de tipos:** `recuperacaoPorMes`/`vencidoRetroativo` com as mesmas assinaturas em T1 (def+testes) e T2 (uso); `resultado = {recuperacao, vencido, aging}` produzido em T2 e consumido campo-a-campo em T3 (`resultado.recuperacao/.vencido/.aging`; `aging.faixas`, `f.faixa`/`f.valor`; `recuperacao[].atrasou/.recuperado/.taxa/.mes`; `vencido[].vencido/.mes`) — batem.
- **Risco herdado:** aproximação retroativa (renegociação) e coorte imatura — ambos documentados na UI; `lib/monitor/crc.test.js` 3 falhas pré-existentes (não desta mudança).
