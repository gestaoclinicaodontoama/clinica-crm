# Módulo Públicos (Sub-projeto 1) — Plano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Módulo `/publicos/` que monta uma lista de leads por filtros (interesse/status/período/DDD/origem/engajamento), mostra preview ao vivo, e de lá dispara (reusando o Disparo em Massa + seletor de número) ou exporta CSV.

**Architecture:** O matching vive em 2 funções Postgres (`publico_contar`/`publico_buscar`) que interpretam uma `regra jsonb` com SQL estático + predicados condicionais (sem SQL dinâmico). Unidades testáveis em JS isoladas (`lib/publicos/regra.js`, `lib/publicos/csv.js`). Endpoints novos em `server.js`; página separada em `public/publicos/`. Reusa runner/seletor de número do Disparo em Massa.

**Tech Stack:** Node.js + Express (`server.js`), HTML/JS vanilla (`public/`), Supabase (Postgres + RPC), `node:test`.

## Global Constraints

- Project Supabase: `mtqdpjhhqzvuklnlfpvi`. Migrações via MCP Supabase (`apply_migration`), ordem crescente de timestamp; verificar com `list_migrations`.
- **Execução = commit LOCAL apenas.** Os implementadores NÃO dão `git push` nem deploy — só `git commit` no worktree. Integração (push p/ origin/main) e **deploy** são feitos UMA vez, pelo controller, no fim (finishing-a-development-branch). Isso evita disparar build do Easypanel no meio e conflitar com deploy de outra sessão.
- Deploy (só no fim, único): após push em origin/main, `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`. ⚠️ Antes, confirmar que não há outro deploy em andamento (ver [[feedback_easypanel_swap_travado]]: build pode não trocar o container; coordenar para um único build do origin/main mais recente).
- Supabase JS trunca em 1000 linhas — contagem e paginação SEMPRE no banco (`publico_contar`/`publico_buscar`); nunca somar/contar no JS.
- Telefones com 0 à esquerda = família: NUNCA normalizar/mesclar; só prefixar `55` em números de 10–11 dígitos que não começam com `55`.
- Interesse combina 3 sinais (OR): `origem ILIKE`, `mensagens.texto ILIKE`, `referral_data::text ILIKE`. Fontes default = `["origem","conversa","anuncio"]`.
- `regra` só com chaves conhecidas (normalizada no servidor antes de persistir/consultar).
- Nav é fonte única em `public/js/nav-config.js` — não editar menu direto no index/shared-nav.
- Roles do módulo: `admin,gestor,crc_comercial,mod_publicos`.
- Testes em `lib/**` rodam com `npm test` (`node --test "lib/**/*.test.js"`).

## Estrutura de arquivos

- Create `supabase/migrations/20260624120000_publicos.sql` — tabela `publicos` + `_ddd_do_telefone` + `publico_buscar` + `publico_contar`.
- Create `lib/publicos/regra.js` + `lib/publicos/regra.test.js` — normalização da regra (pura).
- Create `lib/publicos/csv.js` + `lib/publicos/csv.test.js` — geração de CSV (pura).
- Modify `server.js` — middleware `requirePublicos` + endpoints preview/CRUD/exportar/disparar.
- Modify `public/js/nav-config.js` — ícone `publicos` + item de menu.
- Modify `public/index.html` — registro do módulo no cadastro de Usuários (`mod_publicos`).
- Create `public/publicos/index.html`, `public/js/publicos/api.js`, `public/js/publicos/app.js` — a página.

---

### Task 1: Migração — tabela `publicos` + funções de matching

**Files:**
- Create: `supabase/migrations/20260624120000_publicos.sql`

**Interfaces:**
- Produces: tabela `publicos(id, nome, regra jsonb, criado_por, criado_em, atualizado_em)`; `public._ddd_do_telefone(text) returns text`; `public.publico_buscar(regra jsonb, _limit int, _offset int) returns table(id bigint, nome text, telefone text, status text, origem text, criado_em timestamptz)` (`_limit` null = sem limite); `public.publico_contar(regra jsonb) returns bigint`.

- [ ] **Step 1: Criar o arquivo de migração**

`supabase/migrations/20260624120000_publicos.sql`:
```sql
-- Públicos: segmentos salvos (regra dinâmica) para montar listas de disparo.
create table if not exists public.publicos (
  id bigserial primary key,
  nome text not null,
  regra jsonb not null default '{}'::jsonb,
  criado_por uuid,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- DDD a partir do telefone: tira 55/0 à esquerda. Só LÊ (não altera cadastro).
create or replace function public._ddd_do_telefone(t text)
returns text language sql immutable as $$
  select case
    when t ~ '^55' then substring(t from 3 for 2)
    when t ~ '^0'  then substring(t from 2 for 2)
    else substring(t from 1 for 2)
  end;
$$;

-- Busca leads que casam com a regra. _limit null = sem limite (usado pelo contar).
create or replace function public.publico_buscar(regra jsonb, _limit int default 20, _offset int default 0)
returns table(id bigint, nome text, telefone text, status text, origem text, criado_em timestamptz)
language sql stable as $$
  with p as (
    select
      nullif(regra->'interesse'->>'termo','')                as termo,
      coalesce(regra->'interesse'->'em', '["origem","conversa","anuncio"]'::jsonb) as fontes,
      regra->'status'                                        as status_arr,
      (regra->'periodo'->>'dias')::int                       as dias,
      regra->'ddd'                                           as ddd_arr,
      regra->'origem'                                        as origem_arr,
      (regra->'engajamento'->>'respondeu')::boolean          as resp,
      (regra->'engajamento'->>'ultima_interacao_dias')::int  as ui_dias,
      (regra->'engajamento'->>'janela24h')::boolean          as j24,
      (regra->'engajamento'->>'recebeu_campanha_id')::bigint as camp
  )
  select l.id, l.nome, l.telefone, l.status, l.origem, l.criado_em
  from leads l, p
  where coalesce(l.telefone,'') <> ''
    and (p.termo is null or (
         (p.fontes ? 'origem'   and l.origem ilike '%'||p.termo||'%')
      or (p.fontes ? 'conversa' and exists(select 1 from mensagens m where m.lead_id=l.id and m.texto ilike '%'||p.termo||'%'))
      or (p.fontes ? 'anuncio'  and l.referral_data::text ilike '%'||p.termo||'%')
    ))
    and (p.status_arr is null or jsonb_array_length(p.status_arr)=0 or l.status in (select jsonb_array_elements_text(p.status_arr)))
    and (p.dias is null or l.criado_em >= now() - (p.dias || ' days')::interval)
    and (p.ddd_arr is null or jsonb_array_length(p.ddd_arr)=0 or public._ddd_do_telefone(l.telefone) in (select jsonb_array_elements_text(p.ddd_arr)))
    and (p.origem_arr is null or jsonb_array_length(p.origem_arr)=0 or l.origem in (select jsonb_array_elements_text(p.origem_arr)))
    and (p.resp is null or p.resp = exists(select 1 from mensagens m where m.lead_id=l.id and m.direcao='recebida'))
    and (p.ui_dias is null or exists(select 1 from mensagens m where m.lead_id=l.id and m.criada_em >= now() - (p.ui_dias || ' days')::interval))
    and (p.j24 is null or p.j24 = exists(select 1 from mensagens m where m.lead_id=l.id and m.direcao='recebida' and m.criada_em >= now() - interval '24 hours'))
    and (p.camp is null or exists(select 1 from disparos_contatos dc where dc.lead_id=l.id and dc.campanha_id=p.camp and dc.status='enviado'))
  order by l.criado_em desc
  limit _limit offset _offset;
$$;

-- Conta reusando a mesma lógica (DRY): _limit null = todos.
create or replace function public.publico_contar(regra jsonb)
returns bigint language sql stable as $$
  select count(*)::bigint from public.publico_buscar(regra, null, 0);
$$;
```

- [ ] **Step 2: Aplicar via MCP Supabase**

Aplicar (`apply_migration`, name `publicos`, project `mtqdpjhhqzvuklnlfpvi`, query = conteúdo do arquivo).

- [ ] **Step 3: Verificar no banco (via execute_sql)**

```sql
-- coluna/tabela existe
select count(*) from public.publicos;
-- interesse invisalign + 30d + DDD31 ≈ 52 (sanity, alinha com a lista já conhecida)
select public.publico_contar('{"interesse":{"termo":"invisalign","em":["origem","conversa","anuncio"]},"status":["Lead","Nutrir","Em conversa - Lead Qualificado"],"periodo":{"dias":30},"ddd":["31"]}'::jsonb);
-- regra vazia conta a base inteira (com telefone)
select public.publico_contar('{}'::jsonb);
-- amostra paginada
select * from public.publico_buscar('{"interesse":{"termo":"invisalign"},"ddd":["31"]}'::jsonb, 5, 0);
```
Expected: a 1ª query roda; o contar de invisalign/30d/DDD31 dá um número na casa de ~50 (não precisa ser exatamente 52 — a lista original cruzou também status; aqui confirmamos que está na mesma ordem de grandeza e > 0); regra vazia dá um número grande; a amostra retorna ≤5 linhas com colunas certas.

- [ ] **Step 4: Verificar no histórico de migrações**

`list_migrations` (MCP) → confirmar `20260624120000` presente.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260624120000_publicos.sql
git commit -m "feat(publicos): tabela publicos + funcoes de matching (publico_buscar/contar)"
```

---

### Task 2: `lib/publicos/regra.js` — normalização da regra

**Files:**
- Create: `lib/publicos/regra.js`
- Test: `lib/publicos/regra.test.js`

**Interfaces:**
- Produces: `normalizarRegra(input) -> regra` — devolve um objeto canônico só com chaves conhecidas e valores válidos. Omite chaves vazias/ inválidas. Default de `interesse.em` = `["origem","conversa","anuncio"]` quando há `termo` mas `em` vazio.

- [ ] **Step 1: Write the failing test**

`lib/publicos/regra.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizarRegra } = require('./regra');

test('regra vazia/sujeira vira objeto vazio', () => {
  assert.deepStrictEqual(normalizarRegra(null), {});
  assert.deepStrictEqual(normalizarRegra({ lixo: 1, foo: 'bar' }), {});
});

test('interesse: termo sem fontes assume as 3 fontes', () => {
  assert.deepStrictEqual(normalizarRegra({ interesse: { termo: ' invisalign ' } }),
    { interesse: { termo: 'invisalign', em: ['origem','conversa','anuncio'] } });
});

test('interesse: fontes inválidas são filtradas; sem termo descarta interesse', () => {
  assert.deepStrictEqual(normalizarRegra({ interesse: { termo: 'x', em: ['conversa','xpto'] } }),
    { interesse: { termo: 'x', em: ['conversa'] } });
  assert.deepStrictEqual(normalizarRegra({ interesse: { termo: '   ' } }), {});
});

test('status/origem só strings; arrays vazios somem', () => {
  assert.deepStrictEqual(normalizarRegra({ status: ['Lead', 2, null], origem: [] }),
    { status: ['Lead'] });
});

test('periodo: dias inteiro positivo; senão some', () => {
  assert.deepStrictEqual(normalizarRegra({ periodo: { dias: '30' } }),
    { periodo: { campo: 'criado_em', dias: 30 } });
  assert.deepStrictEqual(normalizarRegra({ periodo: { dias: 0 } }), {});
});

test('ddd: só 2 dígitos', () => {
  assert.deepStrictEqual(normalizarRegra({ ddd: ['31', 5, 'abc', '331'] }), { ddd: ['31'] });
});

test('engajamento: booleans e inteiros positivos; chaves inválidas somem', () => {
  assert.deepStrictEqual(
    normalizarRegra({ engajamento: { respondeu: true, ultima_interacao_dias: '15', janela24h: false, recebeu_campanha_id: 7, xpto: 1 } }),
    { engajamento: { respondeu: true, ultima_interacao_dias: 15, janela24h: false, recebeu_campanha_id: 7 } });
  assert.deepStrictEqual(normalizarRegra({ engajamento: { respondeu: 'sim' } }), {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/publicos/regra.test.js`
Expected: FAIL ("Cannot find module './regra'").

- [ ] **Step 3: Write minimal implementation**

`lib/publicos/regra.js`:
```js
// Normaliza a entrada do construtor de públicos numa "regra" canônica — só chaves
// conhecidas e valores válidos. Defesa antes de persistir/consultar (o RPC só lê
// chaves conhecidas, mas isto evita lixo no banco).
const FONTES = ['origem', 'conversa', 'anuncio'];

function intPos(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function normalizarRegra(input) {
  const r = input && typeof input === 'object' ? input : {};
  const out = {};

  const i = r.interesse && typeof r.interesse === 'object' ? r.interesse : null;
  if (i && typeof i.termo === 'string' && i.termo.trim()) {
    let em = Array.isArray(i.em) ? i.em.filter(x => FONTES.includes(x)) : [];
    if (!em.length) em = [...FONTES];
    out.interesse = { termo: i.termo.trim(), em };
  }

  if (Array.isArray(r.status)) {
    const s = r.status.filter(x => typeof x === 'string' && x);
    if (s.length) out.status = s;
  }

  const dias = r.periodo && intPos(r.periodo.dias);
  if (dias) out.periodo = { campo: 'criado_em', dias };

  if (Array.isArray(r.ddd)) {
    const d = r.ddd.map(String).filter(x => /^\d{2}$/.test(x));
    if (d.length) out.ddd = d;
  }

  if (Array.isArray(r.origem)) {
    const o = r.origem.filter(x => typeof x === 'string' && x);
    if (o.length) out.origem = o;
  }

  const e = r.engajamento && typeof r.engajamento === 'object' ? r.engajamento : null;
  if (e) {
    const eng = {};
    if (e.respondeu === true || e.respondeu === false) eng.respondeu = e.respondeu;
    const ud = intPos(e.ultima_interacao_dias);
    if (ud) eng.ultima_interacao_dias = ud;
    if (e.janela24h === true || e.janela24h === false) eng.janela24h = e.janela24h;
    const ci = intPos(e.recebeu_campanha_id);
    if (ci) eng.recebeu_campanha_id = ci;
    if (Object.keys(eng).length) out.engajamento = eng;
  }

  return out;
}

module.exports = { normalizarRegra, FONTES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/publicos/regra.test.js`
Expected: PASS (7 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/publicos/regra.js lib/publicos/regra.test.js
git commit -m "feat(publicos): normalizarRegra (regra canonica do construtor)"
```

---

### Task 3: `lib/publicos/csv.js` — geração de CSV

**Files:**
- Create: `lib/publicos/csv.js`
- Test: `lib/publicos/csv.test.js`

**Interfaces:**
- Produces: `montarCsv(rows) -> string` — cabeçalho `nome,telefone,telefone_wa,status,origem`; `telefone_wa` = `55`+número quando faltar (10–11 dígitos sem `55`); telefones de família (0 à esquerda / >11 dígitos) ficam intactos; escapa vírgula/aspas/quebra.

- [ ] **Step 1: Write the failing test**

`lib/publicos/csv.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const { montarCsv } = require('./csv');

test('cabeçalho + linha simples', () => {
  const csv = montarCsv([{ nome: 'Ana', telefone: '553199990000', status: 'Lead', origem: 'Google' }]);
  assert.strictEqual(csv.split('\n')[0], 'nome,telefone,telefone_wa,status,origem');
  assert.strictEqual(csv.split('\n')[1], 'Ana,553199990000,553199990000,Lead,Google');
});

test('telefone sem 55 ganha 55 só no telefone_wa', () => {
  const linha = montarCsv([{ nome: 'B', telefone: '31988887777', status: 'Lead', origem: '' }]).split('\n')[1];
  assert.strictEqual(linha, 'B,31988887777,5531988887777,Lead,');
});

test('telefone de família (0 à esquerda) fica intacto', () => {
  const linha = montarCsv([{ nome: 'Fam', telefone: '031991148016', status: 'Lead', origem: '' }]).split('\n')[1];
  assert.strictEqual(linha, 'Fam,031991148016,031991148016,Lead,');
});

test('escapa vírgula e aspas no nome', () => {
  const linha = montarCsv([{ nome: 'Silva, "Jr"', telefone: '5531999990000', status: 'Lead', origem: '' }]).split('\n')[1];
  assert.strictEqual(linha, '"Silva, ""Jr""",5531999990000,5531999990000,Lead,');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/publicos/csv.test.js`
Expected: FAIL ("Cannot find module './csv'").

- [ ] **Step 3: Write minimal implementation**

`lib/publicos/csv.js`:
```js
// CSV de um público. telefone_wa prefixa 55 só quando faltar (10–11 dígitos);
// telefones de família (0 à esquerda, >11 dígitos) e já-com-55 ficam intactos.
function _wa(tel) {
  const n = String(tel == null ? '' : tel).replace(/\D/g, '');
  if ((n.length === 10 || n.length === 11) && !n.startsWith('55')) return '55' + n;
  return n;
}

function _esc(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function montarCsv(rows) {
  const head = 'nome,telefone,telefone_wa,status,origem';
  const linhas = (rows || []).map(r =>
    [_esc(r.nome), _esc(r.telefone), _esc(_wa(r.telefone)), _esc(r.status), _esc(r.origem)].join(','));
  return [head, ...linhas].join('\n');
}

module.exports = { montarCsv };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/publicos/csv.test.js`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/publicos/csv.js lib/publicos/csv.test.js
git commit -m "feat(publicos): montarCsv (export preservando telefone de familia)"
```

---

### Task 4: Endpoint de preview + middleware `requirePublicos`

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `normalizarRegra` (Task 2), RPCs `publico_contar`/`publico_buscar` (Task 1).
- Produces: `requirePublicos` middleware; `POST /api/publicos/preview` → `{ total, amostra }`.

> `server.js` não tem harness de teste — verificação por `node --check` + curl manual.

- [ ] **Step 1: Importar o módulo de regra**

Junto dos outros `require('./lib/...')` no topo do `server.js`, adicionar:
```js
const { normalizarRegra } = require('./lib/publicos/regra');
```

- [ ] **Step 2: Definir o middleware de acesso**

Perto dos outros `requireX = requireRole(...)` (ex.: onde fica `requireDisparos`/`requireConversas`), adicionar:
```js
const requirePublicos = requireRole('admin', 'gestor', 'crc_comercial', 'mod_publicos');
```

- [ ] **Step 3: Endpoint de preview**

Adicionar (perto dos endpoints de disparos):
```js
app.post('/api/publicos/preview', requireAuth, requirePublicos, async (req, res) => {
  try {
    const regra = normalizarRegra(req.body && req.body.regra);
    const { data: totalData, error: e1 } = await supabase.rpc('publico_contar', { regra });
    if (e1) throw e1;
    const { data: amostra, error: e2 } = await supabase.rpc('publico_buscar', { regra, _limit: 20, _offset: 0 });
    if (e2) throw e2;
    res.json({ total: Number(totalData) || 0, amostra: amostra || [] });
  } catch (e) {
    console.error('❌ publicos/preview:', e.message);
    res.status(500).json({ error: e.message });
  }
});
```
> Sem `rateLimit` apertado (é chamado com debounce). Mantém `requireAuth` + `requirePublicos`.

- [ ] **Step 4: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem saída.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(publicos): middleware requirePublicos + endpoint de preview"
```

---

### Task 5: CRUD de públicos salvos

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `normalizarRegra`, `requirePublicos`.
- Produces: `GET /api/publicos`, `POST /api/publicos`, `PUT /api/publicos/:id`, `DELETE /api/publicos/:id`.

- [ ] **Step 1: Adicionar os 4 endpoints**

```js
app.get('/api/publicos', requireAuth, requirePublicos, async (req, res) => {
  try {
    const { data, error } = await supabase.from('publicos')
      .select('id,nome,regra,criado_em,atualizado_em').order('atualizado_em', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/publicos', requireAuth, requirePublicos, async (req, res) => {
  try {
    const nome = sanitizeStr(req.body.nome, 120);
    if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
    const regra = normalizarRegra(req.body && req.body.regra);
    const { data, error } = await supabase.from('publicos')
      .insert({ nome, regra, criado_por: req.user.id }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/publicos/:id', requireAuth, requirePublicos, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const nome = sanitizeStr(req.body.nome, 120);
    if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
    const regra = normalizarRegra(req.body && req.body.regra);
    const { error } = await supabase.from('publicos')
      .update({ nome, regra, atualizado_em: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/publicos/:id', requireAuth, requirePublicos, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { error } = await supabase.from('publicos').delete().eq('id', id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```
> `sanitizeStr` já existe no `server.js` (usado pelos disparos). `req.user.id` segue o padrão dos outros endpoints autenticados.

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem saída.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(publicos): CRUD de publicos salvos"
```

---

### Task 6: Endpoint de exportar CSV

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `normalizarRegra`, `publico_buscar`, `montarCsv` (Task 3).
- Produces: `POST /api/publicos/exportar` → `text/csv` (download).

- [ ] **Step 1: Importar o gerador de CSV**

No topo, junto dos requires:
```js
const { montarCsv } = require('./lib/publicos/csv');
```

- [ ] **Step 2: Endpoint de exportar (paginando no banco)**

```js
app.post('/api/publicos/exportar', requireAuth, requirePublicos, async (req, res) => {
  try {
    const regra = normalizarRegra(req.body && req.body.regra);
    const PAGINA = 1000;
    const rows = [];
    for (let offset = 0; ; offset += PAGINA) {
      const { data, error } = await supabase.rpc('publico_buscar', { regra, _limit: PAGINA, _offset: offset });
      if (error) throw error;
      const pagina = data || [];
      rows.push(...pagina);
      if (pagina.length < PAGINA) break;
    }
    const csv = montarCsv(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="publico.csv"');
    res.send(csv);
  } catch (e) {
    console.error('❌ publicos/exportar:', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 3: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem saída.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(publicos): exportar CSV paginando no banco"
```

---

### Task 7: Endpoint de disparar (cria campanha + inicia runner)

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `normalizarRegra`, `publico_buscar`, `whatsapp.getPhoneNumbers`/`defaultPhoneId`, `templateAprovado`, `disparoRunner.iniciarRunner`.
- Produces: `POST /api/publicos/disparar` → `{ campanha_id, total }`.

> Reusa as tabelas `disparos_campanhas`/`disparos_contatos` e o runner. Como os leads já existem, grava `lead_id` direto (pula matching/criação de lead).

- [ ] **Step 1: Localizar o handler existente `POST /api/disparos/:id/iniciar`**

Ler esse handler no `server.js` para copiar EXATAMENTE: (a) a montagem do objeto `deps` passado a `disparoRunner.iniciarRunner(id, deps)`, e (b) a guarda de "uma campanha `enviando` por vez" (resposta 409 se já houver outra ativa). O endpoint novo deve reusar os dois.

- [ ] **Step 2: Endpoint de disparar**

```js
app.post('/api/publicos/disparar', requireAuth, requirePublicos, async (req, res) => {
  try {
    const nome = sanitizeStr(req.body.nome_campanha, 120);
    const template_nome = sanitizeStr(req.body.template_nome, 100);
    if (!nome) return res.status(400).json({ error: 'Nome da campanha obrigatório' });
    if (!template_nome) return res.status(400).json({ error: 'Template obrigatório' });
    if (!(await templateAprovado(template_nome))) return res.status(400).json({ error: 'Template não aprovado pela Meta' });

    // Número: ausente = default (2873); presente precisa ter token.
    const sendable = await whatsapp.getPhoneNumbers();
    let wa_number_id = sanitizeStr(req.body.wa_number_id || '', 50);
    if (!wa_number_id) wa_number_id = whatsapp.defaultPhoneId() || '';
    else if (!sendable[wa_number_id]) return res.status(400).json({ error: 'Número sem credencial de envio configurada' });

    // Guarda: uma campanha enviando por vez (MESMA lógica do /api/disparos/:id/iniciar — Step 1).
    const { data: ativa } = await supabase.from('disparos_campanhas').select('id').eq('status', 'enviando').limit(1);
    if (ativa && ativa.length) return res.status(409).json({ error: 'Já há uma campanha em envio. Aguarde concluir.' });

    // Resolve TODOS os leads do público (paginado no banco).
    const regra = normalizarRegra(req.body && req.body.regra);
    const PAGINA = 1000;
    const leads = [];
    for (let offset = 0; ; offset += PAGINA) {
      const { data, error } = await supabase.rpc('publico_buscar', { regra, _limit: PAGINA, _offset: offset });
      if (error) throw error;
      const pagina = data || [];
      leads.push(...pagina);
      if (pagina.length < PAGINA) break;
    }
    if (!leads.length) return res.status(400).json({ error: 'Público sem contatos' });

    // Cria a campanha (rascunho) com o número escolhido.
    const { data: camp, error: cErr } = await supabase.from('disparos_campanhas').insert({
      nome, template_nome, lang: 'pt_BR', total: leads.length, wa_number_id,
      status: 'rascunho', criado_por: req.user.id,
    }).select().single();
    if (cErr) throw cErr;

    // Contatos JÁ com lead_id (são leads existentes — pula matching).
    const contatos = leads.map(l => {
      const primeiro = (l.nome || '').trim().split(/\s+/)[0] || 'tudo bem';
      return { campanha_id: camp.id, lead_id: l.id, nome: l.nome, primeiro_nome: primeiro,
        telefone: l.telefone, variaveis: [primeiro], status: 'pendente' };
    });
    for (let i = 0; i < contatos.length; i += 500) {
      const { error: iErr } = await supabase.from('disparos_contatos').insert(contatos.slice(i, i + 500));
      if (iErr) throw iErr;
    }

    // Marca enviando + inicia o runner (deps montadas como no /iniciar — Step 1).
    await supabase.from('disparos_campanhas').update({ status: 'enviando', iniciada_em: new Date().toISOString() }).eq('id', camp.id);
    disparoRunner.iniciarRunner(camp.id, /* deps = MESMO objeto do /api/disparos/:id/iniciar */ DEPS_DO_INICIAR);

    res.json({ campanha_id: camp.id, total: leads.length });
  } catch (e) {
    console.error('❌ publicos/disparar:', e.message);
    res.status(500).json({ error: e.message });
  }
});
```
> ⚠️ Substituir `DEPS_DO_INICIAR` pelo objeto `deps` EXATO montado no handler `/api/disparos/:id/iniciar` (Step 1) — geralmente `{ supabase, whatsapp, logEvento }`. Não inventar; copiar do handler existente para garantir o mesmo shape (`logEvento` etc.).

- [ ] **Step 3: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem saída.

- [ ] **Step 4: Verificação manual (após deploy)**

Criar um público pequeno (ex.: DDD 31 + 1 termo raro que case ~2 leads), disparar com template aprovado e número 2873; conferir em `disparos_campanhas`/`disparos_contatos` que a campanha nasceu com `wa_number_id` e os `lead_id` certos, e que aparece na aba Disparos.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(publicos): disparar publico (cria campanha + inicia runner, reusa numero)"
```

---

### Task 8: Nav + registro no módulo de Usuários

**Files:**
- Modify: `public/js/nav-config.js`
- Modify: `public/index.html` (cadastro de Usuários)

**Interfaces:**
- Produces: item de menu `publicos` (mode `link`, `/publicos/`); role extra `mod_publicos` no cadastro de usuário.

- [ ] **Step 1: Ícone + item no `nav-config.js`**

Em `public/js/nav-config.js`, no objeto `PATHS`, adicionar um ícone `publicos` (um SVG path distinto — ex.: um "alvo"/segmento; use um `d=` simples coerente com os demais ícones do arquivo). Depois, no array `CRM_NAV`, adicionar como item top-level (perto de `disparos`):
```js
{ slug: 'publicos', label: 'Públicos', icon: 'publicos', roles: 'admin,gestor,crc_comercial,mod_publicos', mode: 'link', href: '/publicos/' },
```

- [ ] **Step 2: Registrar `mod_publicos` no cadastro de Usuários**

Em `public/index.html`, na seção "Módulos Extras" do cadastro de usuário (onde estão `mod_inadimplentes`, `mod_notas_fiscais` etc.), seguir o padrão do CLAUDE.md em 3 pontos:
1. Checkbox: `<label ...><input type="checkbox" id="nu-mod-publicos"> Públicos</label>`
2. `_ROLE_LABELS`: adicionar `mod_publicos: 'Públicos'`
3. `criarUsuario()`: adicionar `if (document.getElementById('nu-mod-publicos').checked) roles.push('mod_publicos');`

(Localizar cada ponto por conteúdo — buscar por `mod_inadimplentes` mostra os 3 lugares análogos.)

- [ ] **Step 3: Verificação manual**

Abrir o app: o item "Públicos" aparece no menu para admin; clicar leva a `/publicos/` (página da Task 9). No cadastro de usuário, o checkbox "Públicos" aparece em Módulos Extras.

- [ ] **Step 4: Commit**

```bash
git add public/js/nav-config.js public/index.html
git commit -m "feat(publicos): item de menu + registro mod_publicos no cadastro de usuarios"
```

---

### Task 9: Página — scaffold + construtor + preview ao vivo

**Files:**
- Create: `public/publicos/index.html`
- Create: `public/js/publicos/api.js`
- Create: `public/js/publicos/app.js`

**Interfaces:**
- Consumes: `POST /api/publicos/preview` (Task 4), `GET /api/config/wa` (números), `GET /api/templates` (templates).
- Produces: `coletarRegra()` (lê os campos do formulário → objeto regra) e `atualizarPreview()` (debounce → preview). Expostos para a Task 10.

> Espelhar um módulo separado existente para auth/sidebar. Verificação manual (sem harness de front).

- [ ] **Step 1: `api.js` (auth) espelhando um módulo existente**

Criar `public/js/publicos/api.js` copiando o padrão de `public/js/pacientes/api.js` (busca o token `sb-{ref}-auth-token` com `k.startsWith('sb-') && k.endsWith('-auth-token')`; expõe `api(path, opts)` que injeta o `Authorization: Bearer`). **Garantir que o arquivo também exponha `getToken()`** (retorna o JWT atual) — usado no download de CSV da Task 10. Se o `pacientes/api.js` já tiver um getter equivalente, reusar o mesmo nome e ajustar a Task 10.

- [ ] **Step 2: `index.html` com sidebar + layout de 2 colunas**

Criar `public/publicos/index.html` seguindo o esqueleto de uma página separada (ex.: `public/atribuicao/index.html`): `<head>` com o CSS compartilhado, `<script src="/js/shared-nav.js" data-active="publicos"></script>`, depois `<script src="/js/publicos/api.js"></script>` e `<script src="/js/publicos/app.js"></script>`. Corpo: coluna esquerda = formulário do construtor (envolver num container `id="construtor"` — os listeners de preview do `app.js` usam `e.target.closest('#construtor')`) com os campos:
- Interesse: input `#f-termo` + 3 checkboxes `#f-em-origem`/`#f-em-conversa`/`#f-em-anuncio` (marcados por default).
- Status: grupo de checkboxes `#f-status` com o DOMÍNIO ATUAL do funil (migrado pela reestruturação em jun/2026): `Novo`, `Em qualificação`, `Avaliação agendada`, `Em negociação`, `Compareceu`, `Fechou`, `Perdido`, `Não tem Interesse`. (Os valores antigos `Lead`/`Nutrir`/`Em conversa - Lead Qualificado` não existem mais.)
- Período: `#f-dias` (número; vazio = sem filtro).
- DDD: input de chips `#f-ddd` (lista separada por vírgula → array de 2 dígitos).
- Origem: input de chips `#f-origem` (lista separada por vírgula, texto livre — ex.: `Facebook - Invisalign`; popular com valores reais da base fica como polimento futuro).
- Engajamento: `#f-respondeu` (select Sim/Não/—), `#f-ui-dias` (número), `#f-janela24h` (select Sim/Não/—), `#f-recebeu-camp` (select de campanhas — opcional, pode ficar vazio nesta task).
Coluna direita: `#preview-total` ("— contatos"), `#preview-amostra` (tabela), e a barra de ações (botões ficam funcionais na Task 10; já deixar os elementos `#btn-salvar`, `#btn-exportar`, `#btn-disparar`).

- [ ] **Step 3: `app.js` — coletarRegra + preview com debounce**

Criar `public/js/publicos/app.js`:
```js
function coletarRegra() {
  const v = id => document.getElementById(id);
  const regra = {};
  const termo = v('f-termo').value.trim();
  if (termo) {
    const em = ['origem','conversa','anuncio'].filter(f => v('f-em-'+f).checked);
    regra.interesse = { termo, em };
  }
  const status = [...document.querySelectorAll('#f-status input:checked')].map(c => c.value);
  if (status.length) regra.status = status;
  const dias = parseInt(v('f-dias').value, 10);
  if (Number.isFinite(dias) && dias > 0) regra.periodo = { dias };
  const ddd = v('f-ddd').value.split(',').map(s => s.trim()).filter(s => /^\d{2}$/.test(s));
  if (ddd.length) regra.ddd = ddd;
  const origem = v('f-origem').value.split(',').map(s => s.trim()).filter(Boolean);
  if (origem.length) regra.origem = origem;
  const eng = {};
  if (v('f-respondeu').value) eng.respondeu = v('f-respondeu').value === 'sim';
  const ui = parseInt(v('f-ui-dias').value, 10);
  if (Number.isFinite(ui) && ui > 0) eng.ultima_interacao_dias = ui;
  if (v('f-janela24h').value) eng.janela24h = v('f-janela24h').value === 'sim';
  const camp = parseInt((v('f-recebeu-camp')||{}).value, 10);
  if (Number.isFinite(camp) && camp > 0) eng.recebeu_campanha_id = camp;
  if (Object.keys(eng).length) regra.engajamento = eng;
  return regra;
}

let _previewTimer = null;
function agendarPreview() {
  clearTimeout(_previewTimer);
  _previewTimer = setTimeout(atualizarPreview, 400);
}

async function atualizarPreview() {
  const total = document.getElementById('preview-total');
  total.textContent = 'carregando…';
  try {
    const r = await api('/api/publicos/preview', { method: 'POST', body: JSON.stringify({ regra: coletarRegra() }) });
    total.textContent = r.total + ' contatos';
    const tb = document.getElementById('preview-amostra');
    tb.innerHTML = (r.amostra || []).map(l =>
      `<tr><td>${(l.nome||'').replace(/</g,'&lt;')}</td><td>${l.telefone||''}</td><td>${l.status||''}</td><td>${(l.origem||'').replace(/</g,'&lt;')}</td></tr>`).join('');
    const vazio = r.total === 0;
    ['btn-exportar','btn-disparar'].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = vazio; });
  } catch (e) { total.textContent = 'erro ao calcular'; console.error(e); }
}

document.addEventListener('input', e => { if (e.target.closest('#construtor')) agendarPreview(); });
document.addEventListener('change', e => { if (e.target.closest('#construtor')) agendarPreview(); });
window.addEventListener('DOMContentLoaded', () => { atualizarPreview(); });
```
> Nota: origem é input de chips (texto livre, igual ao DDD) — sem depender de endpoint de distinct. Popular com os valores reais da base (`GET /api/publicos/origens`) fica como polimento futuro, fora deste plano.

- [ ] **Step 4: Verificação manual**

Abrir `/publicos/`: a sidebar aparece, o formulário renderiza, e ao digitar "invisalign" + marcar status + DDD 31 o `#preview-total` atualiza (debounce) mostrando um número coerente com a base; a amostra lista linhas.

- [ ] **Step 5: Commit**

```bash
git add public/publicos/index.html public/js/publicos/api.js public/js/publicos/app.js
git commit -m "feat(publicos): pagina do construtor + preview ao vivo"
```

---

### Task 10: Página — salvar/listar públicos + exportar + disparar

**Files:**
- Modify: `public/publicos/index.html`
- Modify: `public/js/publicos/app.js`

**Interfaces:**
- Consumes: `coletarRegra()`/`atualizarPreview()` (Task 9), `GET/POST/PUT/DELETE /api/publicos` (Task 5), `POST /api/publicos/exportar` (Task 6), `POST /api/publicos/disparar` (Task 7), `GET /api/config/wa`, `GET /api/templates`.

- [ ] **Step 1: Lista de públicos salvos (carregar/editar/excluir)**

Em `app.js`, adicionar:
```js
async function carregarPublicos() {
  const box = document.getElementById('publicos-salvos');
  try {
    const lista = await api('/api/publicos');
    box.innerHTML = (lista || []).map(p =>
      `<li data-id="${p.id}"><span>${(p.nome||'').replace(/</g,'&lt;')}</span>
        <button onclick="aplicarPublico(${p.id})">abrir</button>
        <button onclick="excluirPublico(${p.id})">excluir</button></li>`).join('');
    window._publicos = lista || [];
  } catch (e) { console.error(e); }
}
function aplicarPublico(id) {
  const p = (window._publicos || []).find(x => x.id === id);
  if (!p) return;
  preencherFormulario(p.regra || {});  // espelho de coletarRegra: seta os campos a partir da regra
  window._editandoId = id;
  document.getElementById('f-nome').value = p.nome || '';
  atualizarPreview();
}
async function excluirPublico(id) {
  if (!confirm('Excluir este público?')) return;
  await api('/api/publicos/' + id, { method: 'DELETE' });
  if (window._editandoId === id) window._editandoId = null;
  carregarPublicos();
}
```
Implementar `preencherFormulario(regra)` como o inverso de `coletarRegra` (setar `#f-termo`, checkboxes de fonte/status, `#f-dias`, `#f-ddd`, origem, engajamento). Mostrar os campos vazios quando a chave não existir.

- [ ] **Step 2: Salvar (novo ou editar)**

```js
async function salvarPublico() {
  const nome = document.getElementById('f-nome').value.trim();
  if (!nome) { alert('Dê um nome ao público'); return; }
  const body = JSON.stringify({ nome, regra: coletarRegra() });
  if (window._editandoId) await api('/api/publicos/' + window._editandoId, { method: 'PUT', body });
  else { const r = await api('/api/publicos', { method: 'POST', body }); window._editandoId = r.id; }
  carregarPublicos();
  alert('Público salvo');
}
document.getElementById('btn-salvar').onclick = salvarPublico;
```

- [ ] **Step 3: Exportar CSV**

```js
async function exportarCsv() {
  const resp = await fetch('/api/publicos/exportar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
    body: JSON.stringify({ regra: coletarRegra() }),
  });
  if (!resp.ok) { alert('Falha ao exportar'); return; }
  const blob = await resp.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'publico.csv'; a.click();
  URL.revokeObjectURL(a.href);
}
document.getElementById('btn-exportar').onclick = exportarCsv;
```
> `getToken()` é o getter exposto pelo `api.js` (Task 9 Step 1) que retorna o JWT. Se o `api.js` do projeto já usar outro nome, alinhar os dois.

- [ ] **Step 4: Disparar (modal template + número, reusando o seletor)**

Adicionar um modal com `#d-template` (select), `#d-numero` (select), `#d-nome-camp` (input). Popular template e número:
```js
async function abrirDisparoModal() {
  const tpls = await api('/api/templates');
  const aprov = (tpls || []).filter(t => t.status === 'aprovado');
  document.getElementById('d-template').innerHTML = aprov.map(t => `<option value="${t.nome}">${t.nome}</option>`).join('');
  const cfg = await api('/api/config/wa');
  const ids = (cfg.sendable && cfg.sendable.length) ? cfg.sendable : Object.keys(cfg.numbers || {});
  const selN = document.getElementById('d-numero');
  selN.innerHTML = ids.map(id => `<option value="${id}">${(cfg.numbers && cfg.numbers[id]) || id}</option>`).join('');
  if (cfg.defaultPhoneId && ids.includes(cfg.defaultPhoneId)) selN.value = cfg.defaultPhoneId;
  document.getElementById('disparo-modal').style.display = 'flex';
}
async function confirmarDisparo() {
  const body = JSON.stringify({
    regra: coletarRegra(),
    nome_campanha: document.getElementById('d-nome-camp').value.trim(),
    template_nome: document.getElementById('d-template').value,
    wa_number_id: document.getElementById('d-numero').value,
  });
  try {
    const r = await api('/api/publicos/disparar', { method: 'POST', body });
    alert('Disparo iniciado para ' + r.total + ' contatos. Acompanhe na aba Disparos.');
    document.getElementById('disparo-modal').style.display = 'none';
  } catch (e) { alert('Erro: ' + (e.message || e)); }
}
document.getElementById('btn-disparar').onclick = abrirDisparoModal;
```
E no `DOMContentLoaded`, chamar `carregarPublicos()`.

- [ ] **Step 5: Verificação manual (após deploy)**

`/publicos/`: montar filtro → Salvar (aparece na lista) → abrir de novo (campos voltam) → Exportar (baixa CSV correto) → Disparar (modal com 2873 default + template aprovado) → confirma → "Disparo iniciado" e a campanha aparece na aba Disparos com o número certo.

- [ ] **Step 6: Commit**

```bash
git add public/publicos/index.html public/js/publicos/app.js
git commit -m "feat(publicos): salvar/listar publicos + exportar CSV + disparar (modal numero+template)"
```

---

## Self-Review (feita)

- **Cobertura da spec:** tabela+funções → Task 1; normalizarRegra → Task 2; CSV → Task 3; preview → Task 4; CRUD → Task 5; exportar → Task 6; disparar (reusa runner+número) → Task 7; nav+roles → Task 8; página construtor+preview → Task 9; salvar/exportar/disparar UI → Task 10. Interesse=origem+conversa+anúncio → Task 1 (RPC) + Task 9 (checkboxes). Limite 1000 → RPC + paginação nos endpoints. Família 0-à-esquerda → Task 3 (`_wa`).
- **Placeholders:** o único marcador intencional é `DEPS_DO_INICIAR` na Task 7 — explicitado como "copiar o objeto `deps` exato do handler `/api/disparos/:id/iniciar`", com instrução de localizá-lo no Step 1. Não é um placeholder vago: é uma instrução de reuso de código existente (não reproduzível sem ler o handler).
- **Consistência de tipos:** `normalizarRegra` (Task 2) consumido igual em 4/5/6/7; `publico_buscar(regra,_limit,_offset)` e `publico_contar(regra)` (Task 1) chamados com os mesmos nomes de parâmetro nos endpoints; `montarCsv(rows)` (Task 3) usado na Task 6; `coletarRegra()`/`atualizarPreview()` (Task 9) reusados na Task 10; `sendable` (do `/api/config/wa`, feature já em produção) consumido na Task 10.
