# Financeiro → Laboratórios — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Módulo vivo de serviços protéticos: 3 tabelas Supabase, importador Gemini com tela de conferência, seed dos ~R$ 163 mil de 2026, e página `/financeiro/laboratorios/` com comparador de preços, prazos, retrabalho, por-dentista e evolução mensal.

**Architecture:** Padrão do repo — Express monolítico (`server.js`) + libs puras testáveis em `lib/protetico/`, agregações no Postgres (RPC única `protetico_resumo`) para não esbarrar no teto de 1000 linhas do Supabase, UI vanilla HTML/JS em `public/financeiro/laboratorios/` com shared-nav. Extração IA em `lib/gemini.js` (novo `extrairNotaProtetico` com `inline_data`, mesmo transporte de `analyzeLigacao`). Nada é gravado sem conferência humana.

**Tech Stack:** Node 18+ (node:test), Express 4, multer (memoryStorage, já existe `_upload` 16 MB), @supabase/supabase-js v2 (service_role), Gemini 2.5 Flash via REST, chart.min.js vendorizado, zod.

**Spec:** `docs/superpowers/specs/2026-07-23-financeiro-laboratorios-design.md`

## Global Constraints

- Worktree `wt-laboratorios`, branch `feat/financeiro-laboratorios` (main local de outra sessão — NÃO tocar).
- Supabase trunca SELECT em 1000 linhas → toda agregação vai em RPC SQL; listagens paginam com `.range()`.
- NUNCA `.catch()` no query-builder do Supabase — `try/catch` no `await`.
- RLS ON nas tabelas novas, sem policies (acesso só via service_role no servidor); RPC nova com `REVOKE ... FROM anon, authenticated`.
- Rotas: `requireAuth, requireFinanceiro` (server.js:508).
- Sem siglas financeiras na UI; textos em pt-BR.
- Retry 5xx no front: 2 tentativas (1,5s/3s) — padrão das páginas do Financeiro.
- PowerShell não é usado para escrever arquivos (Write tool, UTF-8 sem BOM).
- Categoria resolvida em JS (sem extensão `unaccent` no banco): `s.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase()`.
- Commits frequentes na branch; mensagens `feat(protetico): ...`.

---

### Task 1: Migration — tabelas + RPC de resumo

**Files:**
- Create: `supabase/migrations/20260723120000_protetico.sql`

**Interfaces:**
- Produces: tabelas `protetico_notas`, `protetico_itens`, `protetico_categorias`; função `protetico_resumo(p_desde date, p_ate date, p_lab text, p_categoria text, p_dentista text) returns jsonb`.

- [ ] **Step 1: Escrever a migration**

```sql
-- Financeiro → Laboratórios (serviços protéticos). Aplicar REMOTO via MCP antes do deploy.
CREATE TABLE IF NOT EXISTS protetico_notas (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  laboratorio text NOT NULL,
  referencia text NOT NULL,
  periodo_inicio date, periodo_fim date, emitida_em date,
  total_informado numeric(12,2),
  origem text NOT NULL DEFAULT 'import' CHECK (origem IN ('seed','import','manual')),
  criado_por text, criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (laboratorio, referencia)
);
CREATE TABLE IF NOT EXISTS protetico_itens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nota_id bigint NOT NULL REFERENCES protetico_notas(id) ON DELETE CASCADE,
  paciente_nome text NOT NULL,
  dentista_nome text,
  descricao_original text NOT NULL,
  categoria text NOT NULL,
  dente text,
  quantidade int NOT NULL DEFAULT 1 CHECK (quantidade > 0),
  valor_total numeric(12,2) NOT NULL,
  valor_unitario numeric(12,2) GENERATED ALWAYS AS (round(valor_total / quantidade, 2)) STORED,
  data_entrada date, data_prevista date, data_entrega date,
  atrasado boolean,
  reparo boolean NOT NULL DEFAULT false,
  conferir boolean NOT NULL DEFAULT false,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_protetico_itens_nota ON protetico_itens(nota_id);
CREATE INDEX IF NOT EXISTS idx_protetico_itens_datas ON protetico_itens(data_entrega, data_entrada);
CREATE TABLE IF NOT EXISTS protetico_categorias (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  padrao text NOT NULL UNIQUE,
  categoria text NOT NULL
);
ALTER TABLE protetico_notas ENABLE ROW LEVEL SECURITY;
ALTER TABLE protetico_itens ENABLE ROW LEVEL SECURITY;
ALTER TABLE protetico_categorias ENABLE ROW LEVEL SECURITY;

-- Data efetiva: entrega > entrada > emitida_em da nota (regra única da spec)
CREATE OR REPLACE FUNCTION protetico_data_efetiva(i protetico_itens, n protetico_notas)
RETURNS date LANGUAGE sql IMMUTABLE AS
$$ SELECT COALESCE(i.data_entrega, i.data_entrada, n.emitida_em) $$;

CREATE OR REPLACE FUNCTION protetico_resumo(
  p_desde date DEFAULT NULL, p_ate date DEFAULT NULL,
  p_lab text DEFAULT NULL, p_categoria text DEFAULT NULL, p_dentista text DEFAULT NULL
) RETURNS jsonb LANGUAGE sql STABLE AS $$
WITH base AS (
  SELECT i.*, n.laboratorio, protetico_data_efetiva(i, n) AS data_ef
  FROM protetico_itens i JOIN protetico_notas n ON n.id = i.nota_id
  WHERE (p_desde IS NULL OR protetico_data_efetiva(i, n) >= p_desde)
    AND (p_ate   IS NULL OR protetico_data_efetiva(i, n) <= p_ate)
    AND (p_lab IS NULL OR n.laboratorio = p_lab)
    AND (p_categoria IS NULL OR i.categoria = p_categoria)
    AND (p_dentista IS NULL OR i.dentista_nome = p_dentista)
)
SELECT jsonb_build_object(
  'cards', (SELECT jsonb_build_object(
      'total', COALESCE(sum(valor_total),0),
      'itens', count(*),
      'ticket_medio', COALESCE(round(avg(valor_unitario) FILTER (WHERE valor_total > 0),2),0),
      'pct_atraso', round(100.0 * count(*) FILTER (WHERE atrasado) / NULLIF(count(*) FILTER (WHERE atrasado IS NOT NULL),0), 1),
      'pct_reparo', COALESCE(round(100.0 * count(*) FILTER (WHERE reparo) / NULLIF(count(*),0), 1),0)
    ) FROM base),
  'precos', COALESCE((SELECT jsonb_agg(row_to_json(p)) FROM (
      SELECT categoria, laboratorio,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY valor_unitario) AS mediana,
             count(*) AS n
      FROM base WHERE valor_total > 0 AND NOT reparo
      GROUP BY categoria, laboratorio ORDER BY categoria, laboratorio) p), '[]'::jsonb),
  'prazos', COALESCE((SELECT jsonb_agg(row_to_json(z)) FROM (
      SELECT laboratorio,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY (data_entrega - data_entrada)) AS dias_mediana,
             count(*) FILTER (WHERE data_entrega - data_entrada >= 60) AS itens_60d,
             round(100.0 * count(*) FILTER (WHERE atrasado) / NULLIF(count(*) FILTER (WHERE atrasado IS NOT NULL),0),1) AS pct_atraso,
             count(*) AS n
      FROM base WHERE data_entrega IS NOT NULL AND data_entrada IS NOT NULL
      GROUP BY laboratorio ORDER BY laboratorio) z), '[]'::jsonb),
  'dentistas', COALESCE((SELECT jsonb_agg(row_to_json(d)) FROM (
      SELECT COALESCE(dentista_nome,'(sem dentista)') AS dentista, sum(valor_total) AS total, count(*) AS n
      FROM base GROUP BY 1 ORDER BY 2 DESC) d), '[]'::jsonb),
  'mensal', COALESCE((SELECT jsonb_agg(row_to_json(m)) FROM (
      SELECT to_char(date_trunc('month', data_ef),'YYYY-MM') AS mes, laboratorio, sum(valor_total) AS total
      FROM base WHERE data_ef IS NOT NULL GROUP BY 1,2 ORDER BY 1,2) m), '[]'::jsonb),
  'labs', COALESCE((SELECT jsonb_agg(row_to_json(l)) FROM (
      SELECT laboratorio, sum(valor_total) AS total, count(*) AS n
      FROM base GROUP BY 1 ORDER BY 2 DESC) l), '[]'::jsonb)
);
$$;
REVOKE ALL ON FUNCTION protetico_resumo(date,date,text,text,text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION protetico_data_efetiva(protetico_itens, protetico_notas) FROM anon, authenticated;
```

- [ ] **Step 2: Sanidade local** — `node -e "require('fs').readFileSync('supabase/migrations/20260723120000_protetico.sql','utf8')"` (arquivo legível; validação real acontece ao aplicar via MCP na Task 8).
- [ ] **Step 3: Commit** — `git add supabase/migrations/20260723120000_protetico.sql && git commit -m "feat(protetico): migration — notas, itens, categorias + RPC protetico_resumo"`

### Task 2: `lib/protetico/categoria.js` — normalização de categoria (TDD)

**Files:**
- Create: `lib/protetico/categoria.js`, `lib/protetico/categoria.test.js`

**Interfaces:**
- Produces: `resolverCategoria(descricao, padroes) -> string` (padroes = [{padrao, categoria}]; matching por inclusão, sem acento/caixa; mais longo ganha; fallback 'Outros'); `PADROES_SEED` = array default com os padrões reais da spec; `CATEGORIAS` = lista canônica.

- [ ] **Step 1: Teste falhando** — casos reais dos 5 labs:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { resolverCategoria, PADROES_SEED } = require('./categoria');
const casos = [
  ['Coroa Fresada Dissilicato', 'Coroa unitária'],
  ['CMC AMA', 'Coroa unitária'],
  ['Zircônia Ama', 'Coroa unitária'],
  ['Zirconia - Coroa Zirconia 3D', 'Coroa unitária'],
  ['01 coroa total e-max (D: 45)', 'Coroa unitária'],
  ['01 onlay e-max (D: 47)', 'Coroa unitária'],
  ['01 c/impl', 'Coroa unitária'],
  ['01 Rest EMAX 46', 'Coroa unitária'],
  ['Protocolo Fresado Em Zircônia', 'Protocolo'],
  ['PROTOCOLO STG TRILUX SUPERIOR', 'Protocolo'],
  ['PROVA DE PROTOCOLO DE ZIRCONIA', 'Protocolo'],
  ['PROTOCOLO FRESADO PMMA', 'Protocolo'],
  ['PT IMEDIATA SUPERIOR', 'Prótese total'],
  ['PROTESE TOTAL INFERIOR', 'Prótese total'],
  ['PRÓTESE TOTAL COMUM SUPERIOR COM STG', 'Prótese total'],
  ['ROACH PREMIUM TRILUX SUPERIOR', 'Prótese parcial'],
  ['PARCIAL PROVISÓRIA INFERIOR', 'Prótese parcial'],
  ['Provisorio Digital Fresado PMMA', 'Provisório'],
  ['PLACA BRUXISMO', 'Placa de bruxismo'],
  ['PLACA DE BRUXISMO FRESADA', 'Placa de bruxismo'],
  ['Modelo Digital - Total', 'Modelo/acessório'],
  ['Link Cad/ Cam+Parafuso', 'Modelo/acessório'],
  ['Ánalogos Mini Pilar', 'Modelo/acessório'],
  ['tbase', 'Modelo/acessório'],
  ['Muralha de Zetalabor', 'Modelo/acessório'],
  ['PLANO DE CERA INFERIOR', 'Modelo/acessório'],
  ['Enceramento Diagnóstico', 'Enceramento'],
  ['Zirconia - Reparo', 'Reparo'],
  ['Coroa Fresada de Dissilicato - Reparo', 'Reparo'],
  ['Coroa Dissilicato Reparo', 'Reparo'],
  ['01 gengiva', 'Outros'],
  ['Gesso - Acabamento (Cortesia)', 'Outros'],
];
test('resolverCategoria cobre os padrões reais dos 5 labs', () => {
  for (const [desc, esperado] of casos) assert.strictEqual(resolverCategoria(desc, PADROES_SEED), esperado, desc);
});
test('reparo vence coroa (padrão mais específico ganha)', () => {
  assert.strictEqual(resolverCategoria('Coroa Fresada de Dissilicato - Reparo', PADROES_SEED), 'Reparo');
});
```

Nota de precedência: 'reparo' precisa vencer 'coroa', e 'prova de protocolo'/'protocolo fresado pmma' precisam vencer 'pmma'→Provisório. Implementação: ordenar por prioridade explícita (campo `prio`, menor = mais forte) e, dentro da prio, padrão mais longo primeiro. PADROES_SEED: reparo/conserto (prio 0) · prova de protocolo, protocolo (prio 1) · roach, parcial provis, parcial (prio 2) · pt imediata, protese total, prótese total (2) · placa (2) · provisorio, pmma (3) · enceramento (3) · modelo digital, link cad, analogo, tbase, muralha, plano de cera, parafuso (3) · coroa, cmc, zirconia, zirconia, e-max, emax, onlay, c/impl, rest (4).
- [ ] **Step 2: Rodar e ver falhar** — `node --test lib/protetico/categoria.test.js` → FAIL (module not found).
- [ ] **Step 3: Implementar** `categoria.js` (norm() sem acento, sort por prio+length, includes; exporta CATEGORIAS = ['Coroa unitária','Protocolo','Prótese total','Prótese parcial','Provisório','Placa de bruxismo','Modelo/acessório','Enceramento','Reparo','Outros']).
- [ ] **Step 4: Rodar e ver passar** — mesmo comando, PASS.
- [ ] **Step 5: Commit** — `feat(protetico): resolver de categoria com padrões reais dos 5 labs`

### Task 3: `lib/protetico/notas.js` — validação e derivação (TDD)

**Files:**
- Create: `lib/protetico/notas.js`, `lib/protetico/notas.test.js`

**Interfaces:**
- Consumes: `resolverCategoria` da Task 2.
- Produces: `prepararNota({laboratorio, referencia, periodo_inicio, periodo_fim, emitida_em, total_informado, origem, itens[], padroes}) -> { nota, itens, avisos[] }` — valida (laboratorio/referencia obrigatórios; item exige paciente_nome, descricao_original, valor_total numérico ≥ 0, quantidade int > 0; datas ISO ou null), deriva `categoria`, `reparo` (categoria === 'Reparo'), `atrasado` (entrega > prevista, senão null), e aviso de divergência `|total_informado − Σ valor_total| > 0.01`. Lança `Error` com `status=400` e mensagem pt-BR em payload inválido.

- [ ] **Step 1: Teste falhando** — cobre: nota válida completa; item sem paciente → 400; valor "abc" → 400; quantidade 0 → 400; datas nulas ok (Búcio); atrasado true/false/null; reparo derivado; divergência de total gera aviso e NÃO erro.
- [ ] **Step 2: FAIL** → **Step 3: implementar** → **Step 4: PASS** (`node --test lib/protetico/notas.test.js`).
- [ ] **Step 5: Commit** — `feat(protetico): prepararNota — validação, categoria, atraso, divergência`

### Task 4: `lib/gemini.js` — `extrairNotaProtetico`

**Files:**
- Modify: `lib/gemini.js` (nova função + export)

**Interfaces:**
- Produces: `extrairNotaProtetico({ fileBuffer, mimeType }) -> { data: { laboratorio_sugerido, referencia, emitida_em, total_informado, itens:[{paciente, dentista, descricao, dente, quantidade, valor_total, data_entrada, data_prevista, data_entrega, incerto}] }, tokensIn, tokensOut }`.

- [ ] **Step 1: Implementar** seguindo `analyzeLigacao` (inline_data base64 + JSON mode + zod):

```js
const NOTA_PROTETICO_SCHEMA = z.object({
  laboratorio_sugerido: z.string().max(80),
  referencia: z.string().max(120),
  emitida_em: z.string().nullable(),
  total_informado: z.number().nullable(),
  itens: z.array(z.object({
    paciente: z.string(), dentista: z.string().nullable(),
    descricao: z.string(), dente: z.string().nullable(),
    quantidade: z.number().int().positive().default(1),
    valor_total: z.number(),
    data_entrada: z.string().nullable(), data_prevista: z.string().nullable(), data_entrega: z.string().nullable(),
    incerto: z.boolean().default(false),
  })).max(300),
});
```

Prompt (pt-BR): "Você lê cobranças de laboratórios de prótese dentária (relatórios de sistema, notas avulsas, planilhas e cadernos manuscritos fotografados). Extraia TODAS as linhas de serviço… datas em YYYY-MM-DD (ano assumido do documento), valores em número (1.234,56 → 1234.56), quantidade explícita no início da descrição ('02 coroas' → quantidade 2), linha ilegível/duvidosa → incerto=true, NUNCA invente linha ou valor; total_informado = total impresso no documento ou null." Corpo: `parts: [{inline_data:{mime_type, data: base64}}, {text: prompt}]`, `generationConfig` JSON + responseSchema (espelho do zod, mesmos workarounds de `callWithRetry` — reusar `httpsPost` direto com 1 retry sem schema em 400, 429→503, timeout 90s). Export no `module.exports`.
- [ ] **Step 2: Sanidade** — `node -e "const g=require('./lib/gemini'); console.log(typeof g.extrairNotaProtetico)"` → `function`. (Sem unit contra a API; endpoint é testado com mock na Task 6.)
- [ ] **Step 3: Commit** — `feat(protetico): extrairNotaProtetico no gemini.js (inline_data + JSON mode)`

### Task 5: Seed 2026 — dados + script

**Files:**
- Create: `scripts/seed-protetico-2026.data.json`, `scripts/seed-protetico-2026.js`

**Interfaces:**
- Consumes: `prepararNota` (Task 3), `PADROES_SEED` (Task 2).
- Produces: banco populado com as notas 2026; catálogo `protetico_categorias` semeado.

- [ ] **Step 1: Autorar o `data.json`** com TODAS as linhas extraídas na sessão de 23/07 (fonte: os 9 PDFs + 4 fotos lidos; ~250 itens):
  - Ateliê Odonto: 1 nota `referencia: 'Pedidos Finalizados 01/01–31/07/2026'`, 95 pedidos → itens com data_entrada/prevista/entrega por pedido (itens herdam as datas do pedido), dentista = Conv, total_informado 99621.46.
  - LAPROTEC: 6 notas (686, 697, 712, 733, 755, 774) com emitida_em e totais 2100 / 2170 / 5490 / 3925 / 13000 / 21990.
  - Dente & Arte: 1 nota 05/01–23/07, 13 itens, total 5942.00, com dente.
  - Búcio: 4 notas (Caderno 06/01, 04/02, 05/03, 07/05) com itens legíveis (conferir=true nos duvidosos) + 1 nota 'Caderno — página anterior (total avulso)' com total_informado 1710.00 e zero itens, conferir sinalizado no aviso.
  - Marcos Miranda: 1 nota 'MARÇO 2026', 5 itens, total 1710.00, dentista 'Dr. Joaquim'.
- [ ] **Step 2: Script idempotente** — para cada nota do JSON: `select id from protetico_notas where laboratorio=? and referencia=?` → pula se existe; senão `prepararNota` + insert nota + insert itens em lote; semeia `protetico_categorias` com upsert por `padrao`. Usa `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE` do `.env` (mesmo bootstrap dos scripts existentes em `scripts/`). Log final: notas inseridas/puladas, soma por lab, avisos de divergência.
- [ ] **Step 3: Conferência aritmética local** — `node -e` somando o JSON: Ateliê 99621.46 · LAPROTEC 48675.00 · Dente & Arte 5942.00 · Marcos 1710.00 · Búcio (itens) ≈ 5290.00; divergências viram `conferir=true`, não bloqueiam.
- [ ] **Step 4: Commit** — `feat(protetico): seed 2026 — dados dos 5 labs + script idempotente` (rodar contra o banco só na Task 8, depois da migration).

### Task 6: Endpoints no server.js (TDD no que é puro; rota fina)

**Files:**
- Modify: `server.js` (bloco novo "== Protético ==" perto das outras rotas do Financeiro)

**Interfaces:**
- Consumes: `protetico_resumo` RPC (Task 1), `prepararNota` (3), `extrairNotaProtetico` (4), `resolverCategoria/PADROES_SEED` (2), `requireFinanceiro`, `_upload` (multer, server.js:70), `supabase`.
- Produces (todas `requireAuth, requireFinanceiro`):
  - `GET /api/protetico/resumo` (query desde/ate/lab/categoria/dentista) → `supabase.rpc('protetico_resumo', {...})`.
  - `GET /api/protetico/itens` (mesmos filtros + `busca` ilike paciente + `page` 0-based, 100/página) → `{ itens, total }` via `.select('*, protetico_notas!inner(laboratorio, referencia, emitida_em)', { count: 'exact' })` com or() para a data efetiva simplificada: filtra período por `coalesce` não existe no builder → usar RPC? Não: para a TABELA, filtrar por data_entrega quando houver e data_entrada senão é aceitável fazer em SQL via `.or('and(data_entrega.gte.X,data_entrega.lte.Y),and(data_entrega.is.null,data_entrada.gte.X,data_entrada.lte.Y))'` — regra documentada no código; nota sem nenhuma data aparece só sem filtro de período.
  - `GET /api/protetico/categorias` → lista; `POST/PATCH/DELETE /api/protetico/categorias(/:id)`; `POST /api/protetico/categorias/reaplicar` → pagina itens de 1000 em 1000, resolve categoria nova, update em lote dos mudados (inclui recalcular `reparo`).
  - `POST /api/protetico/importar` → `_upload.single('file')`, aceita application/pdf|image/jpeg|image/png (senão 400 pt-BR), chama `extrairNotaProtetico`, resolve categoria por linha, checa duplicata (laboratorio_sugerido+referencia) e devolve `{ extraido, categorias, duplicata: bool }` — **não grava**.
  - `POST /api/protetico/notas` → body `{ nota, itens }` conferidos; `prepararNota`; recusa duplicata (409 com mensagem "Nota já importada — abra a existente"); insert transacional (nota → itens; se itens falharem, delete da nota criada). `origem` = body ('import'|'manual').
  - `PATCH /api/protetico/itens/:id` (paciente_nome, dentista_nome, descricao_original→recategoriza, dente, quantidade, valor_total, datas→recalcula atrasado, conferir) e `DELETE /api/protetico/itens/:id`.
- [ ] **Step 1:** implementar rotas (try/catch padrão, `res.status(err.status||500).json({ error: err.message })`).
- [ ] **Step 2:** `node --check server.js` → OK.
- [ ] **Step 3:** teste do reaplicar/preparar já coberto nas Tasks 2-3; smoke real na Task 8.
- [ ] **Step 4: Commit** — `feat(protetico): rotas resumo/itens/importar/notas/categorias`

### Task 7: Página `/financeiro/laboratorios/`

**Files:**
- Create: `public/financeiro/laboratorios/index.html` (página completa: CSS + JS inline, padrão das irmãs `public/financeiro/saude/index.html`)
- Modify: `public/js/nav-config.js` (linha ~113, após 'financeiro-saude'): `{ slug: 'financeiro-laboratorios', label: 'Laboratórios', roles: 'financeiro,mod_financeiro', mode: 'link', href: '/financeiro/laboratorios/' },`

**Interfaces:** consome os 5 endpoints da Task 6; `<script src="/js/shared-nav.js" data-active="financeiro-laboratorios">`; chart.min.js.

Estrutura (IDs estáveis para teste): header com título "🦷 Laboratórios" + filtros (`#f-desde`,`#f-ate` default 2026-01-01→hoje, `#f-lab`,`#f-cat`,`#f-dent` selects preenchidos do resumo) + botões `#btn-importar`, `#btn-categorias`.
1. `#cards` — 5 cards (Gasto total · Itens · Ticket médio/item · % com atraso, rodapé "só labs que informam previsão" · % retrabalho).
2. `#matriz-precos` — tabela categoria×lab, célula = R$ mediana + `n`; menor da linha `.melhor` (verde), maior `.pior` (vermelho); clique seta filtros lab+categoria e rola pra tabela.
3. `#prazos` — tabela por lab: dias medianos, % atraso (— quando null), itens ≥60d.
4. `#dentistas` — barras horizontais (div/width%, sem lib).
5. `#chart-mensal` — canvas chart.js colunas empilhadas por lab.
6. `#tabela-itens` — paginada (100), busca `#f-busca`, colunas Data · Lab · Paciente · Dentista · Serviço (descricao_original, title=categoria) · Dente · Qtd · Valor · badges 🔧/⚠️ · ✏️/🗑️. Editar = prompt-modal simples com os campos; excluir com confirm.
7. Modal importar (`#modal-importar`, 2 passos): passo 1 file input + drag; passo 2 tabela editável (inputs por célula, select de categoria, linha "＋ adicionar linha na mão"), cabeçalho lab (select com labs existentes + novo), referência, total extraído × soma com `.divergente` em vermelho; Salvar → POST /notas; 409 → mostra "Nota já importada".
8. Modal categorias (`#modal-categorias`): CRUD + botão "Reaplicar catálogo" com resultado ("N itens recategorizados").
Retry fetch 5xx 2x (1,5s/3s); tema segue `data-theme` do shared-nav; rodapé: "Fonte: notas dos laboratórios importadas manualmente — a Clinicorp não expõe o Controle Protético via API."
- [ ] **Step 1:** nav-config + página completa. **Step 2:** `node --check` não se aplica a HTML — validar abrindo local (server `PORT=3300 node server.js` e checar 200 em `/financeiro/laboratorios/`). **Step 3: Commit** — `feat(protetico): página Financeiro → Laboratórios (comparador, prazos, dentistas, importador IA)`

### Task 8: Integração — migration remota, seed, smoke, deploy

- [ ] **Step 1:** `npm test` (suite toda verde) + `node --check server.js`.
- [ ] **Step 2:** aplicar migration via Supabase MCP (`apply_migration`, project do CRM) e conferir `list_tables` mostra as 3 tabelas.
- [ ] **Step 3:** rodar `node scripts/seed-protetico-2026.js` → conferir log: 13 notas, ~250 itens, somas por lab batendo com a spec; `execute_sql`: `select laboratorio, sum(valor_total), count(*) from protetico_itens i join protetico_notas n on n.id=i.nota_id group by 1;`
- [ ] **Step 4:** `select protetico_resumo(null,null,null,null,null)` → JSON com cards/precos/prazos preenchidos.
- [ ] **Step 5:** merge: `git fetch origin && git rebase origin/main` na branch, resolver conflitos (nav-config é o único arquivo compartilhado provável), `git push origin feat/financeiro-laboratorios:main` (fluxo combinado de deploy: push na main → Easypanel).
- [ ] **Step 6:** deploy Easypanel (API tRPC, credenciais salvas) + verificar página no ar servindo 200 e conteúdo novo (memória: checar CONTEÚDO, não só status).
- [ ] **Step 7:** atualizar memória `pending_tests.md` (item novo de validação logada) e `project_lucratividade_tratamento_360.md` (custo de lab agora existe no banco).

## Self-Review (feita em 23/07)

- Cobertura da spec: modelo de dados ✓ (T1) · catálogo editável ✓ (T1/T6/T7) · importador IA sem gravação direta ✓ (T4/T6/T7) · manual fallback ✓ (T7 passo "adicionar linha") · seed ✓ (T5) · comparador/prazo/dentista/mensal/tabela ✓ (T1 RPC + T7) · dedup ✓ (T6 409 + unique) · RLS/revoke ✓ (T1) · testes ✓ (T2/T3/T6) · deploy+validação ✓ (T8).
- Tipos consistentes: `prepararNota` retorna `{nota, itens, avisos}` usado em T5/T6; RPC retorna chaves cards/precos/prazos/dentistas/mensal/labs consumidas na T7.
- Sem placeholders: código real em T1/T2/T4; T3/T6/T7 têm contratos exatos (campos, status codes, IDs) — implementação inline pela mesma sessão que leu os PDFs (dados do seed vêm do contexto desta sessão, único lugar onde existem).
