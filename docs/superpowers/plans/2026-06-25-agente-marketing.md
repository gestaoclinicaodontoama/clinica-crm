# Agente de Marketing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir `/marketing-agente/` — painel read-only que cruza gasto do Meta com faturamento/caixa reais do Clinicorp por campanha, com selos por regra e drill-down auditável, aposentando a página Atribuição.

**Architecture:** Receita vem de RPCs SQL no Supabase (join `leads → pacientes` por telefone → `fin_lancamentos`/`pacientes_financeiro`); gasto vem ao vivo da Meta Ads API (reusa o padrão de `/api/meta-insights`); o backend mescla por `ad_id`, agrupa por campanha e aplica os selos em JS lendo `marketing_config`. Frontend é página estática (express.static) no padrão das outras páginas separadas. Sem LLM.

**Tech Stack:** Node/Express (`server.js`), Supabase Postgres (RPCs via MCP `apply_migration`, projeto `mtqdpjhhqzvuklnlfpvi`), HTML/CSS/JS vanilla, `node:test`.

**Spec:** `docs/superpowers/specs/2026-06-25-agente-marketing-design.md` (ler seção 10 — validação de dados).

---

## Convenções de execução

- **Branch:** trabalhar em branch isolada `feat/agente-marketing` (working dir é concorrente — não commitar direto na main sem worktree).
- **Migrações:** aplicar via MCP Supabase `apply_migration` (projeto `mtqdpjhhqzvuklnlfpvi`), nome em snake_case com timestamp crescente. Salvar o SQL também em `supabase/migrations/<timestamp>_<nome>.sql` (espelho local, padrão do repo).
- **Testes unitários:** `node --test <arquivo>`.
- **Validação de RPC:** rodar `execute_sql` (MCP) com a query de validação e conferir o resultado esperado.
- **Deploy:** só ao final, quando o Luiz validar. Não deployar entre tasks.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `lib/financeiro/mapear-lancamento.js` (modificar) | extrair `paciente_id` do `PersonId` em lançamentos REVENUE |
| `lib/financeiro/mapear-lancamento.test.js` (modificar) | teste da extração REVENUE |
| `supabase/migrations/20260625120000_mkt_paciente_id_revenue.sql` (criar) | backfill `paciente_id` nos REVENUE + índice |
| `supabase/migrations/20260625120100_mkt_config_e_rpcs.sql` (criar) | tabela `marketing_config` + RPCs `marketing_campanhas`, `marketing_drill_leads`, `marketing_drill_paciente` |
| `server.js` (modificar) | endpoints `/api/marketing/*` + rota estática implícita |
| `public/marketing-agente/index.html` (criar) | página do agente |
| `public/js/marketing-agente/api.js` (criar) | helper de auth (token Supabase) |
| `public/js/marketing-agente/app.js` (criar) | render: seletores, cards, selos, drill |
| `public/js/nav-config.js` (modificar) | adicionar item `marketing-agente`, remover `atribuicao` |

---

## FASE A — Fundação de dados

### Task 1: Extrair `paciente_id` nos lançamentos REVENUE

**Files:**
- Modify: `lib/financeiro/mapear-lancamento.js:30`
- Test: `lib/financeiro/mapear-lancamento.test.js`
- Create: `supabase/migrations/20260625120000_mkt_paciente_id_revenue.sql`

**Contexto:** Hoje o `paciente_id` vem só de `RelatedPersonId`, que é `-1` nos REVENUE. O paciente do REVENUE está em `PersonId` (com `PersonType:'PATIENT'`). Sem isso, a lente Faturamento não soma por paciente.

- [ ] **Step 1: Escrever o teste que falha**

Adicionar ao final de `lib/financeiro/mapear-lancamento.test.js`:

```js
test('REVENUE: paciente_id vem de PersonId quando PersonType=PATIENT', () => {
  const revenue = { id: '200', PostType: 'REVENUE', EntryType: 'INSURANCE_PLAN_CLAIM',
    Description: 'Lançamento de Tratamento', Amount: 50.55, Date: '2024-04-19T16:24:01.000Z',
    PersonId: 5892307496337408, PersonType: 'PATIENT', RelatedPersonId: -1 };
  const m = mapear(revenue);
  assert.equal(m.paciente_id, '5892307496337408');
  assert.equal(m.post_type, 'REVENUE');
});

test('RECEIVED continua usando RelatedPersonId', () => {
  const m = mapear({ id: '99', PostType: 'RECEIVED', EntryType: 'INSURANCE_PLAN_CLAIM',
    Description: 'Reconciliação Plano', Amount: 100.5, PostDate: '2026-05-10T13:00:00Z', RelatedPersonId: 7 });
  assert.equal(m.paciente_id, '7');
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `node --test lib/financeiro/mapear-lancamento.test.js`
Expected: FAIL no primeiro novo teste — `paciente_id` vem `null` (porque `RelatedPersonId === -1`).

- [ ] **Step 3: Implementar a correção**

Substituir a linha 30 de `lib/financeiro/mapear-lancamento.js`:

```js
    paciente_id: (e.RelatedPersonId != null && e.RelatedPersonId !== -1) ? String(e.RelatedPersonId) : null,
```

por:

```js
    paciente_id: (function () {
      if (e.RelatedPersonId != null && e.RelatedPersonId !== -1) return String(e.RelatedPersonId);
      if (e.PersonType === 'PATIENT' && e.PersonId != null && e.PersonId !== -1) return String(e.PersonId);
      return null;
    })(),
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `node --test lib/financeiro/mapear-lancamento.test.js`
Expected: PASS em todos (os antigos + os 2 novos).

- [ ] **Step 5: Criar a migração de backfill + índice**

Criar `supabase/migrations/20260625120000_mkt_paciente_id_revenue.sql`:

```sql
-- Backfill: extrai paciente_id dos REVENUE a partir do raw->>'PersonId'
update fin_lancamentos
set paciente_id = raw->>'PersonId'
where post_type = 'REVENUE'
  and (paciente_id is null or paciente_id = '')
  and coalesce(raw->>'PersonType','') = 'PATIENT'
  and coalesce(raw->>'PersonId','') not in ('', '-1');

-- Índice para os joins do agente de marketing
create index if not exists idx_fin_lanc_pac_tipo_data
  on fin_lancamentos (paciente_id, post_type, data);
```

- [ ] **Step 6: Aplicar a migração (MCP) e validar o backfill**

Aplicar via `apply_migration`. Depois validar com `execute_sql`:

```sql
select post_type, count(*) n, count(paciente_id) com_pac
from fin_lancamentos where ativo group by post_type order by n desc;
```

Expected: REVENUE agora tem `com_pac` ≈ `n` (antes era 0). RECEIVED inalterado (~22.137).

- [ ] **Step 7: Commit**

```bash
git add lib/financeiro/mapear-lancamento.js lib/financeiro/mapear-lancamento.test.js supabase/migrations/20260625120000_mkt_paciente_id_revenue.sql
git commit -m "feat(mkt): extrai paciente_id nos REVENUE (faturamento por paciente)"
```

---

### Task 2: Tabela `marketing_config` + RPC `marketing_campanhas`

**Files:**
- Create: `supabase/migrations/20260625120100_mkt_config_e_rpcs.sql`

A RPC retorna **uma linha por `ad_id`** (o backend agrupa por campanha com o nome vindo da Meta). Lente `safra` = filtra leads por `criado_em` no período e soma faturamento all-time; lente `caixa` = soma RECEIVED por `data` no período.

- [ ] **Step 1: Escrever a migração (config + RPC principal)**

Criar `supabase/migrations/20260625120100_mkt_config_e_rpcs.sql`:

```sql
-- 1) Config dos selos (1 linha)
create table if not exists marketing_config (
  id int primary key default 1,
  meta_roas numeric not null default 3.0,
  gasto_minimo numeric not null default 200,
  maturacao_dias int not null default 21,
  cobertura_minima numeric not null default 0.60,
  atualizado_em timestamptz not null default now(),
  constraint marketing_config_singleton check (id = 1)
);
insert into marketing_config (id) values (1) on conflict (id) do nothing;

-- 2) RPC principal: receita por ad_id
-- p_lente: 'safra' (faturamento por coorte do lead) | 'caixa' (RECEIVED no período)
create or replace function marketing_campanhas(p_desde date, p_ate date, p_lente text)
returns json
language sql stable security definer
as $function$
  with meta_leads as (  -- leads com ad_id Meta + sufixo de telefone
    select l.id as lead_id, l.campanha as ad_id, l.criado_em,
           right(regexp_replace(l.telefone,'\D','','g'),8) as suf,
           length(regexp_replace(l.telefone,'\D','','g')) as tlen
    from leads l
    where l.campanha ~ '^\d{6,}$'
  ),
  pares as (  -- par lead<->paciente por telefone (últimos 8 díg.)
    select ml.lead_id, ml.ad_id, ml.criado_em, p.clinicorp_id as cid,
           row_number() over (partition by p.clinicorp_id order by ml.criado_em desc) as rn,
           count(distinct ml.ad_id) over (partition by p.clinicorp_id) as n_camp
    from meta_leads ml
    join pacientes p
      on ml.tlen >= 8
     and right(regexp_replace(p.telefone_celular,'\D','','g'),8) = ml.suf
  ),
  owner as (  -- 1 paciente -> 1 lead dono (o mais recente); incerto se >1 campanha
    select lead_id, ad_id, criado_em, cid, (n_camp > 1) as incerto
    from pares where rn = 1
  ),
  -- universo de leads por ad_id na coorte (p/ cobertura)
  cohort as (
    select campanha as ad_id, count(*) as leads_total, max(criado_em) as lead_recente
    from leads
    where campanha ~ '^\d{6,}$'
      and criado_em >= p_desde and criado_em < (p_ate + 1)
    group by campanha
  ),
  -- owners relevantes p/ a lente:
  owner_lente as (
    select * from owner
    where (p_lente <> 'safra')  -- na caixa, não filtra coorte
       or (criado_em >= p_desde and criado_em < (p_ate + 1))
  ),
  receita as (
    select o.ad_id,
      count(distinct o.lead_id) filter (where not o.incerto) as leads_casados,
      count(distinct o.lead_id) filter (where o.incerto)     as incertos,
      -- faturamento (REVENUE all-time) — só dos não-incertos
      coalesce(sum((select sum(f.valor) from fin_lancamentos f
                    where f.ativo and f.post_type='REVENUE' and f.paciente_id = o.cid::text))
               filter (where not o.incerto), 0) as faturamento,
      -- total contratado (pacientes_financeiro) — conferência
      coalesce(sum((select pf.total_pago+pf.total_vencido+pf.total_futuro
                    from pacientes_financeiro pf where pf.clinicorp_id = o.cid::text))
               filter (where not o.incerto), 0) as total_contratado,
      -- caixa: RECEIVED no período
      coalesce(sum((select sum(f.valor) from fin_lancamentos f
                    where f.ativo and f.post_type='RECEIVED' and f.paciente_id = o.cid::text
                      and f.data >= p_desde and f.data <= p_ate))
               filter (where not o.incerto), 0) as caixa
    from owner_lente o
    group by o.ad_id
  )
  select coalesce(json_agg(row_to_json(r)), '[]'::json) from (
    select c.ad_id,
           c.leads_total,
           coalesce(rc.leads_casados,0) as leads_casados,
           coalesce(rc.incertos,0)      as incertos,
           coalesce(rc.faturamento,0)   as faturamento,
           coalesce(rc.total_contratado,0) as total_contratado,
           coalesce(rc.caixa,0)         as caixa,
           c.lead_recente
    from cohort c
    left join receita rc on rc.ad_id = c.ad_id
    union  -- ad_ids que só aparecem fora da coorte (lente caixa) mas têm caixa
    select rc.ad_id, 0, rc.leads_casados, rc.incertos, rc.faturamento, rc.total_contratado, rc.caixa, null::timestamptz
    from receita rc
    where not exists (select 1 from cohort c where c.ad_id = rc.ad_id)
  ) r;
$function$;
```

- [ ] **Step 2: Aplicar a migração (MCP)**

Aplicar via `apply_migration` (nome `mkt_config_e_rpcs`). Sucesso = sem erro.

- [ ] **Step 3: Validar a RPC (lente safra)**

Run (`execute_sql`):

```sql
select * from json_to_recordset(
  marketing_campanhas('2026-05-01','2026-06-30','safra')
) as x(ad_id text, leads_total int, leads_casados int, incertos int,
       faturamento numeric, total_contratado numeric, caixa numeric, lead_recente timestamptz)
order by faturamento desc nulls last limit 10;
```

Expected: retorna várias linhas (uma por ad_id de mai–jun); pelo menos 1 linha com `faturamento > 0` e `total_contratado > 0` (a campanha dos pacientes que já fecharam). `leads_total` ≥ `leads_casados`.

- [ ] **Step 4: Validar a RPC (lente caixa)**

Run:

```sql
select * from json_to_recordset(
  marketing_campanhas('2026-01-01','2026-06-30','caixa')
) as x(ad_id text, leads_total int, leads_casados int, incertos int,
       faturamento numeric, total_contratado numeric, caixa numeric, lead_recente timestamptz)
order by caixa desc nulls last limit 10;
```

Expected: retorna linhas com `caixa >= 0`; ao menos 1 com `caixa > 0`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260625120100_mkt_config_e_rpcs.sql
git commit -m "feat(mkt): marketing_config + RPC marketing_campanhas (receita por ad_id, 2 lentes)"
```

---

### Task 3: RPCs de drill-down

**Files:**
- Modify: `supabase/migrations/20260625120100_mkt_config_e_rpcs.sql` (anexar) OU nova migração `20260625120200_mkt_drill_rpcs.sql`

Usar **nova migração** para manter cada migração imutável após aplicada.

- [ ] **Step 1: Escrever a migração de drill**

Criar `supabase/migrations/20260625120200_mkt_drill_rpcs.sql`:

```sql
-- Drill nível 2: leads de um conjunto de ad_ids, com status de vínculo + receita por lead
create or replace function marketing_drill_leads(p_ad_ids text[], p_desde date, p_ate date, p_lente text)
returns json
language sql stable security definer
as $function$
  with base as (
    select l.id as lead_id, l.nome, l.campanha as ad_id, l.criado_em, l.status,
           right(regexp_replace(l.telefone,'\D','','g'),8) as suf,
           length(regexp_replace(l.telefone,'\D','','g')) as tlen
    from leads l
    where l.campanha = any(p_ad_ids)
      and (p_lente <> 'safra' or (l.criado_em >= p_desde and l.criado_em < (p_ate + 1)))
  ),
  vinc as (
    select b.*, p.clinicorp_id as cid, p.nome as paciente_nome,
           count(*) over (partition by p.clinicorp_id) as n_leads_no_pac
    from base b
    left join lateral (
      select p.* from pacientes p
      where b.tlen >= 8
        and right(regexp_replace(p.telefone_celular,'\D','','g'),8) = b.suf
      order by p.atualizado_em desc nulls last limit 1
    ) p on true
  )
  select coalesce(json_agg(row_to_json(r) order by r.faturamento desc nulls last), '[]'::json) from (
    select v.lead_id, v.nome, v.ad_id, v.criado_em, v.status,
           v.paciente_nome,
           case when v.cid is null then 'sem_paciente'
                when v.n_leads_no_pac > 1 then 'incerto'
                else 'casado' end as vinculo,
           coalesce((select sum(f.valor) from fin_lancamentos f
                     where f.ativo and f.post_type='REVENUE' and f.paciente_id = v.cid::text), 0) as faturamento,
           coalesce((select sum(f.valor) from fin_lancamentos f
                     where f.ativo and f.post_type='RECEIVED' and f.paciente_id = v.cid::text
                       and f.data >= p_desde and f.data <= p_ate), 0) as caixa
    from vinc v
  ) r;
$function$;

-- Drill nível 3: paciente + lançamentos crus de um lead (auditoria)
create or replace function marketing_drill_paciente(p_lead_id bigint)
returns json
language sql stable security definer
as $function$
  with l as (
    select right(regexp_replace(telefone,'\D','','g'),8) as suf,
           length(regexp_replace(telefone,'\D','','g')) as tlen
    from leads where id = p_lead_id
  ),
  pac as (
    select p.* from pacientes p join l on true
    where l.tlen >= 8 and right(regexp_replace(p.telefone_celular,'\D','','g'),8) = l.suf
    order by p.atualizado_em desc nulls last limit 1
  )
  select coalesce(
    (select json_build_object(
       'vinculado', true,
       'paciente', json_build_object('nome', pac.nome, 'clinicorp_id', pac.clinicorp_id),
       'lancamentos', coalesce((
         select json_agg(json_build_object('data', f.data, 'descricao', f.descricao,
                  'valor', f.valor, 'tipo', f.post_type) order by f.data desc)
         from fin_lancamentos f
         where f.ativo and f.paciente_id = pac.clinicorp_id::text
           and f.post_type in ('REVENUE','RECEIVED')
       ), '[]'::json)
     ) from pac),
    json_build_object('vinculado', false)
  );
$function$;
```

- [ ] **Step 2: Aplicar a migração (MCP)**

Aplicar via `apply_migration` (nome `mkt_drill_rpcs`).

- [ ] **Step 3: Validar os drills**

Primeiro pegar um ad_id e um lead_id reais:

```sql
select campanha, id from leads where campanha ~ '^\d{6,}$' order by criado_em desc limit 3;
```

Depois validar (substituir `<AD_ID>` e `<LEAD_ID>`):

```sql
select marketing_drill_leads(array['<AD_ID>'], '2026-01-01','2026-06-30','safra');
select marketing_drill_paciente(<LEAD_ID>);
```

Expected: `drill_leads` retorna array de leads com campo `vinculo` ∈ {casado,incerto,sem_paciente}; `drill_paciente` retorna `{vinculado:true/false, ...}`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260625120200_mkt_drill_rpcs.sql
git commit -m "feat(mkt): RPCs de drill (leads por campanha + paciente/lançamentos)"
```

---

## FASE B — Backend

### Task 4: Endpoint `GET /api/marketing/campanhas` (merge Meta + selos)

**Files:**
- Modify: `server.js` (adicionar perto do bloco `/api/meta-insights`, ~linha 5990)

**Contexto:** reusa o fetch de insights da Meta (gasto por ad_id + campaign_name), chama a RPC `marketing_campanhas`, mescla por ad_id, agrupa por campanha e aplica os selos lendo `marketing_config`.

- [ ] **Step 1: Implementar o endpoint**

Inserir em `server.js` após o fim do handler `/api/meta-insights` (após a linha 5989):

```js
// ===== AGENTE DE MARKETING =====
app.get('/api/marketing/campanhas', requireAuth, requireRole('admin', 'gestor'), rateLimit, async (req, res) => {
  try {
    const lente = req.query.lente === 'caixa' ? 'caixa' : 'safra';
    const _parseDate = (s) => { const d = new Date(s); if (isNaN(d.getTime())) throw Object.assign(new Error('Data inválida'), { status: 400 }); return d; };
    const periodo = parseInt(req.query.periodo, 10) || 30;
    const dDesde = req.query.desde ? _parseDate(req.query.desde) : new Date(Date.now() - periodo * 86400000);
    const dAte   = req.query.ate   ? _parseDate(req.query.ate)   : new Date();
    const ymd = d => d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

    // 1) Config dos selos
    const { data: cfgRow } = await supabase.from('marketing_config').select('*').eq('id', 1).maybeSingle();
    const cfg = cfgRow || { meta_roas: 3.0, gasto_minimo: 200, maturacao_dias: 21, cobertura_minima: 0.60 };

    // 2) Gasto + campaign_name por ad_id (Meta)
    const insights = {};
    const TOKEN = process.env.META_ACCESS_TOKEN;
    if (TOKEN) {
      const timeRange = JSON.stringify({ since: ymd(dDesde), until: ymd(dAte) });
      const url = 'https://graph.facebook.com/' + META_API_VERSION + '/act_' + META_AD_ACCOUNT_ID +
        '/insights?level=ad&fields=ad_id,ad_name,campaign_name,spend&time_range=' + encodeURIComponent(timeRange) + '&limit=500';
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 25000);
      try {
        const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + TOKEN }, signal: ctrl.signal });
        const j = await r.json();
        (j.data || []).forEach(row => { insights[row.ad_id] = { ad_name: row.ad_name, campaign_name: row.campaign_name || '(sem nome)', spend: parseFloat(row.spend) || 0 }; });
      } catch (_) { /* segue sem gasto */ } finally { clearTimeout(to); }
    }

    // 3) Receita por ad_id (RPC)
    const { data: rpc, error } = await supabase.rpc('marketing_campanhas', { p_desde: ymd(dDesde), p_ate: ymd(dAte), p_lente: lente });
    if (error) throw new Error(error.message);
    const receita = {};
    (rpc || []).forEach(row => { receita[row.ad_id] = row; });

    // 4) Mescla por ad_id -> agrupa por campanha
    const adIds = new Set([...Object.keys(insights), ...Object.keys(receita)]);
    const camps = {}; // campaign_name -> agregado
    for (const adId of adIds) {
      const i = insights[adId] || { ad_name: '(anúncio fora do período)', campaign_name: '(sem campanha Meta)', spend: 0 };
      const r = receita[adId] || { leads_total: 0, leads_casados: 0, incertos: 0, faturamento: 0, total_contratado: 0, caixa: 0, lead_recente: null };
      const nome = i.campaign_name;
      if (!camps[nome]) camps[nome] = { campanha: nome, spend: 0, leads_total: 0, leads_casados: 0, incertos: 0, faturamento: 0, total_contratado: 0, caixa: 0, lead_recente: null, anuncios: [] };
      const c = camps[nome];
      c.spend += i.spend; c.leads_total += r.leads_total; c.leads_casados += r.leads_casados;
      c.incertos += r.incertos; c.faturamento += Number(r.faturamento) || 0;
      c.total_contratado += Number(r.total_contratado) || 0; c.caixa += Number(r.caixa) || 0;
      if (r.lead_recente && (!c.lead_recente || r.lead_recente > c.lead_recente)) c.lead_recente = r.lead_recente;
      c.anuncios.push({ ad_id: adId, ad_name: i.ad_name, spend: i.spend, ...r });
    }

    // 5) Métricas + selo por campanha
    const hoje = Date.now();
    const campanhas = Object.values(camps).map(c => {
      const receitaLente = lente === 'caixa' ? c.caixa : c.faturamento;
      c.roas = c.spend > 0 ? receitaLente / c.spend : null;
      c.cobertura = c.leads_total > 0 ? c.leads_casados / c.leads_total : null;
      const diasRecente = c.lead_recente ? (hoje - new Date(c.lead_recente).getTime()) / 86400000 : 9999;
      if (lente === 'caixa') {
        c.selo = 'caixa';
      } else if (c.cobertura !== null && c.cobertura < Number(cfg.cobertura_minima)) {
        c.selo = 'cobertura_baixa';
      } else if (diasRecente < Number(cfg.maturacao_dias)) {
        c.selo = 'observar';
      } else if (c.spend < Number(cfg.gasto_minimo)) {
        c.selo = 'observar';
      } else if (c.roas !== null && c.roas >= Number(cfg.meta_roas)) {
        c.selo = 'escalar';
      } else {
        c.selo = 'cortar';
      }
      return c;
    }).filter(c => c.spend > 0 || c.leads_total > 0 || c.caixa > 0)
      .sort((a, b) => (lente === 'caixa' ? b.caixa - a.caixa : b.spend - a.spend));

    const totais = campanhas.reduce((t, c) => {
      t.spend += c.spend; t.leads_total += c.leads_total; t.leads_casados += c.leads_casados;
      t.faturamento += c.faturamento; t.caixa += c.caixa; return t;
    }, { spend: 0, leads_total: 0, leads_casados: 0, faturamento: 0, caixa: 0 });
    totais.cobertura = totais.leads_total > 0 ? totais.leads_casados / totais.leads_total : null;
    totais.roas = totais.spend > 0 ? (lente === 'caixa' ? totais.caixa : totais.faturamento) / totais.spend : null;

    res.json({ campanhas, totais, lente, cfg, desde: ymd(dDesde), ate: ymd(dAte), sem_token: !TOKEN });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Subir o server local e testar o endpoint**

Run (server local na porta padrão, com auth — usar um token admin válido do localStorage, ou testar via browser depois). Verificação mínima sem auth:

Run: `node -e "require('./server.js')"` por ~2s para garantir que **não há erro de sintaxe/boot** (Ctrl-C depois).
Expected: server sobe sem `SyntaxError` nem crash no boot.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(mkt): GET /api/marketing/campanhas (merge Meta + selos por regra)"
```

---

### Task 5: Endpoints de drill + config

**Files:**
- Modify: `server.js` (logo após o endpoint da Task 4)

- [ ] **Step 1: Implementar os 3 endpoints**

Inserir em `server.js` após o handler `/api/marketing/campanhas`:

```js
app.get('/api/marketing/drill/leads', requireAuth, requireRole('admin', 'gestor'), rateLimit, async (req, res) => {
  try {
    const adIds = String(req.query.ad_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!adIds.length) return res.json({ leads: [] });
    const lente = req.query.lente === 'caixa' ? 'caixa' : 'safra';
    const ymd = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const desde = req.query.desde ? ymd(req.query.desde) : ymd(Date.now() - 30 * 86400000);
    const ate = req.query.ate ? ymd(req.query.ate) : ymd(Date.now());
    const { data, error } = await supabase.rpc('marketing_drill_leads', { p_ad_ids: adIds, p_desde: desde, p_ate: ate, p_lente: lente });
    if (error) throw new Error(error.message);
    res.json({ leads: data || [] });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/marketing/drill/paciente', requireAuth, requireRole('admin', 'gestor'), rateLimit, async (req, res) => {
  try {
    const leadId = parseInt(req.query.lead_id, 10);
    if (!leadId) return res.status(400).json({ error: 'lead_id obrigatório' });
    const { data, error } = await supabase.rpc('marketing_drill_paciente', { p_lead_id: leadId });
    if (error) throw new Error(error.message);
    res.json(data || { vinculado: false });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/marketing/config', requireAuth, requireRole('admin', 'gestor'), async (req, res) => {
  const { data } = await supabase.from('marketing_config').select('*').eq('id', 1).maybeSingle();
  res.json(data || {});
});

app.put('/api/marketing/config', requireAuth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const b = req.body || {};
    const patch = { id: 1, atualizado_em: new Date().toISOString() };
    for (const k of ['meta_roas', 'gasto_minimo', 'maturacao_dias', 'cobertura_minima']) {
      if (b[k] != null && !isNaN(Number(b[k]))) patch[k] = Number(b[k]);
    }
    const { error } = await supabase.from('marketing_config').upsert(patch, { onConflict: 'id' });
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
```

- [ ] **Step 2: Verificar boot sem erro**

Run: `node -e "require('./server.js')"` por ~2s.
Expected: sobe sem erro.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(mkt): endpoints de drill (leads/paciente) + GET/PUT config"
```

---

## FASE C — Frontend + Navegação

### Task 6: Página `/marketing-agente/`

**Files:**
- Create: `public/marketing-agente/index.html`
- Create: `public/js/marketing-agente/api.js`
- Create: `public/js/marketing-agente/app.js`

- [ ] **Step 1: Criar o helper de auth**

Criar `public/js/marketing-agente/api.js`:

```js
// public/js/marketing-agente/api.js
function _token() {
  for (const k of Object.keys(localStorage))
    if (k.startsWith('sb-') && k.endsWith('-auth-token'))
      try { return JSON.parse(localStorage.getItem(k)).access_token; } catch {}
  return null;
}
async function mktApi(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _token(), ...(opts.headers || {}) } });
  if (r.status === 401) { location.href = '/'; return; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('Erro ' + r.status));
  return j;
}
window.mktApi = mktApi;
```

- [ ] **Step 2: Criar o HTML**

Criar `public/marketing-agente/index.html`:

```html
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agente de Marketing</title>
  <style>
    .mkt-wrap { max-width: 1100px; margin: 0 auto; padding: 16px; }
    .mkt-controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
    .mkt-card { border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; margin-bottom: 10px; background: #fff; }
    .mkt-selo { font-weight: 600; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
    .selo-escalar { background:#dcfce7; color:#166534; }
    .selo-cortar { background:#fee2e2; color:#991b1b; }
    .selo-observar { background:#fef9c3; color:#854d0e; }
    .selo-cobertura_baixa { background:#f1f5f9; color:#475569; }
    .selo-caixa { background:#dbeafe; color:#1e40af; }
    .mkt-num { font-variant-numeric: tabular-nums; }
    .mkt-drill { margin-top:10px; padding-top:10px; border-top:1px dashed #e2e8f0; font-size:13px; }
    .mkt-cobertura { font-size:12px; color:#64748b; }
    .mkt-clickable { cursor:pointer; text-decoration:underline dotted; }
  </style>
</head>
<body>
  <div id="app" class="mkt-wrap">
    <h1>📊 Agente de Marketing</h1>
    <p class="mkt-cobertura">Read-only · cruza gasto Meta × faturamento/caixa real do Clinicorp. Cada número é clicável até o paciente.</p>
    <div class="mkt-controls">
      <label>Lente:
        <select id="lente"><option value="safra">Faturamento (safra)</option><option value="caixa">Caixa (entradas)</option></select>
      </label>
      <label>Período:
        <select id="periodo"><option value="30">30 dias</option><option value="90">90 dias</option><option value="365">12 meses</option></select>
      </label>
      <button id="atualizar">🔄 Atualizar</button>
      <button id="btn-config">⚙️ Parâmetros</button>
    </div>
    <div id="resumo"></div>
    <div id="lista"></div>
  </div>
  <script src="/js/marketing-agente/api.js"></script>
  <script src="/js/marketing-agente/app.js"></script>
  <script src="/js/shared-nav.js" data-active="marketing-agente"></script>
</body>
</html>
```

- [ ] **Step 3: Criar o app.js (render + drill)**

Criar `public/js/marketing-agente/app.js`:

```js
const SELO_LABEL = { escalar:'🟢 Escalar', cortar:'🔴 Cortar/revisar', observar:'🟡 Observar', cobertura_baixa:'⚪ Cobertura baixa', caixa:'💰 Caixa' };
const fmt = n => (Number(n)||0).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
const pct = n => n == null ? '—' : Math.round(n*100) + '%';
let _state = { desde:null, ate:null, lente:'safra' };

async function carregar() {
  const lente = document.getElementById('lente').value;
  const periodo = document.getElementById('periodo').value;
  _state.lente = lente;
  document.getElementById('lista').innerHTML = 'Carregando…';
  try {
    const d = await mktApi(`/api/marketing/campanhas?lente=${lente}&periodo=${periodo}`);
    _state.desde = d.desde; _state.ate = d.ate;
    renderResumo(d); renderLista(d);
  } catch (e) { document.getElementById('lista').innerHTML = '<p style="color:#b91c1c">Erro: '+e.message+'</p>'; }
}

function renderResumo(d) {
  const t = d.totais, rec = d.lente === 'caixa' ? t.caixa : t.faturamento;
  document.getElementById('resumo').innerHTML = `<div class="mkt-card">
    <b>Resumo ${d.desde} → ${d.ate}</b> ${d.sem_token ? '· ⚠️ sem META_ACCESS_TOKEN (gasto = 0)' : ''}<br>
    Gasto: <span class="mkt-num">${fmt(t.spend)}</span> ·
    ${d.lente==='caixa'?'Caixa':'Faturamento'}: <span class="mkt-num">${fmt(rec)}</span> ·
    ROAS: <b>${t.roas==null?'—':t.roas.toFixed(2)+'x'}</b> ·
    Cobertura: ${pct(t.cobertura)} (${t.leads_casados}/${t.leads_total} leads)</div>`;
}

function renderLista(d) {
  if (!d.campanhas.length) { document.getElementById('lista').innerHTML = '<p>Nenhuma campanha no período.</p>'; return; }
  document.getElementById('lista').innerHTML = d.campanhas.map((c, idx) => {
    const rec = d.lente==='caixa' ? c.caixa : c.faturamento;
    return `<div class="mkt-card">
      <div><span class="mkt-selo selo-${c.selo}">${SELO_LABEL[c.selo]}</span> <b>${c.campanha}</b></div>
      <div class="mkt-num">Gasto ${fmt(c.spend)} · ${d.lente==='caixa'?'Caixa':'Faturamento'}
        <span class="mkt-clickable" data-drill="${idx}">${fmt(rec)}</span>
        · ROAS ${c.roas==null?'—':c.roas.toFixed(2)+'x'}</div>
      <div class="mkt-cobertura">Cobertura ${pct(c.cobertura)} (${c.leads_casados}/${c.leads_total})${c.incertos?` · ${c.incertos} vínculo(s) incerto(s)`:''} · contratado ${fmt(c.total_contratado)}</div>
      <div class="mkt-drill" id="drill-${idx}" style="display:none"></div>
    </div>`;
  }).join('');
  document.querySelectorAll('[data-drill]').forEach(el => el.onclick = () => abrirDrill(d.campanhas[el.dataset.drill], el.dataset.drill));
}

async function abrirDrill(camp, idx) {
  const box = document.getElementById('drill-'+idx);
  if (box.style.display === 'block') { box.style.display = 'none'; return; }
  box.style.display = 'block'; box.innerHTML = 'Carregando leads…';
  const adIds = camp.anuncios.map(a => a.ad_id).join(',');
  try {
    const d = await mktApi(`/api/marketing/drill/leads?ad_ids=${encodeURIComponent(adIds)}&lente=${_state.lente}&desde=${_state.desde}&ate=${_state.ate}`);
    box.innerHTML = d.leads.length ? d.leads.map(l => {
      const cls = l.vinculo==='casado' ? 'escalar' : (l.vinculo==='incerto' ? 'observar' : 'cobertura_baixa');
      return `<div>• ${l.nome||'(sem nome)'} — <span class="mkt-selo selo-${cls}">${l.vinculo}</span>
      ${l.paciente_nome?`→ ${l.paciente_nome}`:''} · fat ${fmt(l.faturamento)}
      ${l.vinculo!=='sem_paciente'?`<span class="mkt-clickable" data-lead="${l.lead_id}">ver pagamentos</span>`:''}</div>`;
    }).join('') : '<i>Sem leads.</i>';
    box.querySelectorAll('[data-lead]').forEach(el => el.onclick = () => verPaciente(el.dataset.lead, box));
  } catch (e) { box.innerHTML = 'Erro: '+e.message; }
}

async function verPaciente(leadId, box) {
  const d = await mktApi(`/api/marketing/drill/paciente?lead_id=${leadId}`);
  const div = document.createElement('div'); div.style.margin = '6px 0 6px 16px';
  div.innerHTML = d.vinculado ? `<b>${d.paciente.nome}</b><br>` + (d.lancamentos.length
    ? d.lancamentos.map(x => `${x.data} · ${x.tipo} · ${fmt(x.valor)} · ${x.descricao}`).join('<br>')
    : '<i>sem lançamentos</i>') : '<i>sem paciente vinculado</i>';
  box.appendChild(div);
}

document.getElementById('atualizar').onclick = carregar;
document.getElementById('lente').onchange = carregar;
document.getElementById('periodo').onchange = carregar;
document.getElementById('btn-config').onclick = async () => {
  const cfg = await mktApi('/api/marketing/config');
  const roas = prompt('Meta de ROAS (x):', cfg.meta_roas); if (roas === null) return;
  const gasto = prompt('Gasto mínimo (R$):', cfg.gasto_minimo); if (gasto === null) return;
  const mat = prompt('Maturação (dias):', cfg.maturacao_dias); if (mat === null) return;
  const cob = prompt('Cobertura mínima (0–1):', cfg.cobertura_minima); if (cob === null) return;
  await mktApi('/api/marketing/config', { method:'PUT', body: JSON.stringify({ meta_roas:roas, gasto_minimo:gasto, maturacao_dias:mat, cobertura_minima:cob }) });
  carregar();
};
carregar();
```

- [ ] **Step 4: Verificar no browser (Playwright ou manual)**

Subir o server, logar como admin, abrir `/marketing-agente/`.
Expected: sidebar carrega; resumo aparece (mesmo que com gasto 0 se sem token); lista de campanhas ou "Nenhuma campanha"; clicar no faturamento expande os leads; clicar "ver pagamentos" mostra lançamentos.

- [ ] **Step 5: Commit**

```bash
git add public/marketing-agente public/js/marketing-agente
git commit -m "feat(mkt): página /marketing-agente/ (cards, selos, drill auditável)"
```

---

### Task 7: Navegação — adicionar agente, aposentar Atribuição

**Files:**
- Modify: `public/js/nav-config.js:75` (seção marketing)
- Modify: `server.js:303` (NAV_SLUGS — remover 'atribuicao')

- [ ] **Step 1: Editar o nav-config**

Em `public/js/nav-config.js`, na seção `marketing` (linha ~75), **remover** a linha do `atribuicao` e **adicionar** o item do agente. Substituir:

```js
      { slug: 'atribuicao',          label: 'Atribuição',           roles: 'admin,gestor',                                    mode: 'link', href: '/atribuicao/' },
```

por:

```js
      { slug: 'marketing-agente',    label: 'Agente de Marketing',  roles: 'admin,gestor',                                    mode: 'link', href: '/marketing-agente/' },
```

- [ ] **Step 2: Remover 'atribuicao' do NAV_SLUGS**

Em `server.js:303`, remover `'atribuicao',` da lista `NAV_SLUGS` (linha `'avaliacao-dentista','atribuicao','ligacoes',` → `'avaliacao-dentista','ligacoes',`).

> A página `/atribuicao/` continua existindo no disco (não removemos arquivos), só sai do menu. Se algum usuário tiver `atribuicao` salvo na tabbar mobile, o filtro de `NAV_SLUGS` o ignora — sem erro.

- [ ] **Step 3: Verificar boot + nav**

Run: `node -e "require('./server.js')"` por ~2s → sobe sem erro.
Abrir o CRM logado → seção Marketing mostra "Agente de Marketing" e **não** mostra "Atribuição".

- [ ] **Step 4: Commit**

```bash
git add public/js/nav-config.js server.js
git commit -m "feat(mkt): adiciona Agente de Marketing ao menu e aposenta Atribuição"
```

---

## Encerramento

- [ ] **Deploy** (só após validação do Luiz): `git push` na branch → merge → deploy Easypanel (curl do CLAUDE.md).
- [ ] **Validação manual com o Luiz:** abrir logado, conferir 1 campanha no drill até o pagamento batendo com o Clinicorp. Lembrar que o painel começa magro (poucos dados de junho) — é esperado.
- [ ] Atualizar memória `project_agentes` (Marketing v1 deployado) e `pending_tests` (item de validação).

---

## Notas de escopo (do spec)

- **Sem LLM, read-only, sem ação no Meta.** YAGNI: sem alertas proativos, sem Google Ads, sem snapshot histórico de gasto (v1.1).
- **Selos raramente disparam Escalar/Cortar no começo** (volume baixo → 🟡/⚪). Correto.
- **Cobertura honesta** é parte do produto: nunca mostrar ROAS sem a cobertura ao lado.
