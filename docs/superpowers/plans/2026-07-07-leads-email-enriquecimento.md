# Enriquecimento de e-mail dos leads via Clinicorp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preencher `leads.email` a partir de `pacientes.email` (Clinicorp), casando por sufixo-8 de telefone, para o CAPI enviar `em` e subir o EMQ (baseline 3,4/10).

**Architecture:** Uma função Postgres (`enriquecer_emails_leads()`) faz todo o casamento e update em SQL; um backfill único a executa agora; um hook isolado no sync diário (`sync/clinicorp-sync.js`) a executa após a fase de novos pacientes. O CAPI não muda — `_enviarEventoMetaUnico` já envia `em` quando `lead.email` existe.

**Tech Stack:** Postgres (Supabase, project `mtqdpjhhqzvuklnlfpvi`), Node.js (sync), MCP Supabase para migration/SQL.

**Spec:** `docs/superpowers/specs/2026-07-07-leads-email-enriquecimento-design.md`

## Global Constraints

- Função nasce trancada: `REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role` (regra de segurança do CLAUDE.md).
- Sem `SECURITY DEFINER` (o servidor chama via service_role, que ignora RLS).
- Anti-colisão: só sufixos com `count(distinct email) = 1` entre pacientes válidos.
- Leads com telefone cujos dígitos começam com `0` NUNCA são enriquecidos (convenção familiar da casa — e-mail seria do titular, pessoa errada).
- E-mail válido = `~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'`; gravar `lower(trim(email))`.
- Só preencher leads com `email IS NULL OR email = ''` — nunca sobrescrever.
- Migrations aplicadas via MCP Supabase (`apply_migration`), verificadas com `list_migrations`.
- Deploy: após `git push`, `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`.

---

### Task 1: Migration — função `enriquecer_emails_leads()`

**Files:**
- Create: `supabase/migrations/20260707130000_enriquecer_emails_leads.sql`

**Interfaces:**
- Produces: função `public.enriquecer_emails_leads() returns integer` (nº de leads atualizados), executável apenas por `service_role`. Task 3 e Task 4 a chamam.

- [ ] **Step 1: Escrever o arquivo de migration**

Conteúdo exato de `supabase/migrations/20260707130000_enriquecer_emails_leads.sql`:

```sql
-- Enriquece leads.email a partir de pacientes.email (Clinicorp), casando por
-- sufixo-8 do telefone. Guardas: e-mail válido; 1 e-mail distinto por sufixo
-- (anti-colisão de família); leads com dígitos iniciando em 0 são pulados
-- (convenção da casa: 0 à esquerda = familiar usando o número do titular).
-- Só preenche leads sem e-mail — nunca sobrescreve. Retorna nº de atualizados.
create or replace function public.enriquecer_emails_leads()
returns integer
language sql
as $$
with pac as (
  select right(regexp_replace(coalesce(telefone_celular, ''), '\D', '', 'g'), 8) as suf8,
         lower(trim(email)) as email
  from pacientes
  where email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    and length(regexp_replace(coalesce(telefone_celular, ''), '\D', '', 'g')) >= 8
),
unicos as (
  -- 2+ pacientes com o MESMO e-mail contam como 1 (ok); e-mails distintos
  -- no mesmo sufixo = ambíguo, fica de fora.
  select suf8, min(email) as email
  from pac
  group by suf8
  having count(distinct email) = 1
),
alvo as (
  select l.id, u.email
  from leads l
  join unicos u
    on u.suf8 = right(regexp_replace(l.telefone, '\D', '', 'g'), 8)
  where (l.email is null or l.email = '')
    and l.telefone is not null
    and regexp_replace(l.telefone, '\D', '', 'g') !~ '^0'
    and length(regexp_replace(l.telefone, '\D', '', 'g')) >= 8
),
upd as (
  update leads l
  set email = a.email
  from alvo a
  where l.id = a.id
  returning 1
)
select coalesce(count(*), 0)::int from upd;
$$;

-- Trancada por padrão (regra do CLAUDE.md): só o servidor (service_role) executa.
revoke all on function public.enriquecer_emails_leads() from public, anon, authenticated;
grant execute on function public.enriquecer_emails_leads() to service_role;
```

- [ ] **Step 2: Aplicar via MCP**

MCP `apply_migration` no projeto `mtqdpjhhqzvuklnlfpvi` com `name: enriquecer_emails_leads` e o SQL acima.
Depois MCP `list_migrations` — esperado: `20260707130000` na lista.

- [ ] **Step 3: Verificar o trancamento (teste de segurança)**

MCP `execute_sql`:

```sql
select grantee, privilege_type
from information_schema.routine_privileges
where routine_name = 'enriquecer_emails_leads';
```

Esperado: **apenas** linhas de `service_role` (e o owner `postgres`). Se aparecer `anon`, `authenticated` ou `PUBLIC` → falhou; re-executar o bloco de revoke.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260707130000_enriquecer_emails_leads.sql
git commit -m "feat(leads): função enriquecer_emails_leads (email via pacientes, sufixo-8)"
```

---

### Task 2: Preview e validação das guardas (antes de escrever qualquer linha)

**Files:** nenhum (só queries de leitura via MCP `execute_sql`).

**Interfaces:**
- Consumes: mesma lógica de CTEs da Task 1 (versão SELECT, sem o `upd`).
- Produces: números de referência para a Task 3 (contagem esperada do backfill).

- [ ] **Step 1: Contagem + amostra de 10 pares (conferir a olho)**

```sql
with pac as (
  select right(regexp_replace(coalesce(telefone_celular, ''), '\D', '', 'g'), 8) as suf8,
         lower(trim(email)) as email
  from pacientes
  where email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    and length(regexp_replace(coalesce(telefone_celular, ''), '\D', '', 'g')) >= 8
),
unicos as (
  select suf8, min(email) as email from pac
  group by suf8 having count(distinct email) = 1
),
alvo as (
  select l.id, l.nome, l.telefone, u.email
  from leads l
  join unicos u on u.suf8 = right(regexp_replace(l.telefone, '\D', '', 'g'), 8)
  where (l.email is null or l.email = '')
    and l.telefone is not null
    and regexp_replace(l.telefone, '\D', '', 'g') !~ '^0'
    and length(regexp_replace(l.telefone, '\D', '', 'g')) >= 8
)
select (select count(*) from alvo) as total_a_enriquecer,
       (select json_agg(t) from (select nome, telefone, email from alvo limit 10) t) as amostra;
```

Esperado: `total_a_enriquecer` na casa de ~1.500–1.900 (estimativa por sufixo dava 1.864, antes dos filtros de e-mail válido/colisão/zero). **Conferir a amostra a olho:** nome do lead compatível com o e-mail (mesma pessoa/família).

- [ ] **Step 2: Verificar a guarda de colisão**

```sql
with pac as (
  select right(regexp_replace(coalesce(telefone_celular, ''), '\D', '', 'g'), 8) as suf8,
         lower(trim(email)) as email
  from pacientes
  where email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    and length(regexp_replace(coalesce(telefone_celular, ''), '\D', '', 'g')) >= 8
)
select count(*) as sufixos_ambiguos_excluidos
from (select suf8 from pac group by suf8 having count(distinct email) > 1) x;
```

Esperado: número > 0 (existem famílias com e-mails distintos) — confirma que a guarda está filtrando algo real. Anotar o número.

- [ ] **Step 3: Verificar a regra do zero**

```sql
with alvo_sem_guarda as (
  select l.id from leads l
  where (l.email is null or l.email = '')
    and regexp_replace(coalesce(l.telefone,''), '\D', '', 'g') ~ '^0'
)
select count(*) as leads_familia_0prefixo from alvo_sem_guarda;
```

Esperado: contagem dos leads-família que a guarda protege (só informativo). Se a amostra do Step 1 contiver QUALQUER telefone começando com 0 → bug no filtro, parar e corrigir a Task 1 antes de seguir.

---

### Task 3: Backfill único

**Files:** nenhum (execução via MCP `execute_sql`).

**Interfaces:**
- Consumes: `enriquecer_emails_leads()` da Task 1; contagem esperada da Task 2.

- [ ] **Step 1: Executar o backfill**

```sql
select enriquecer_emails_leads() as atualizados;
```

Esperado: `atualizados` == `total_a_enriquecer` do preview (Task 2 Step 1).

- [ ] **Step 2: Testar idempotência (2ª rodada = 0)**

```sql
select enriquecer_emails_leads() as atualizados_2a_rodada;
```

Esperado: `0`.

- [ ] **Step 3: Conferir o efeito**

```sql
select count(*) filter (where email is not null and email <> '') as leads_com_email,
       count(*) as leads_total
from leads;
```

Esperado: `leads_com_email` ≈ 7 (originais) + o número do backfill.

---

### Task 4: Hook no sync diário

**Files:**
- Modify: `sync/clinicorp-sync.js:926` (logo após a Fase 4 `novos_pacientes`)

**Interfaces:**
- Consumes: `enriquecer_emails_leads()` (Task 1); helper `step(nome, fn, fallback)` e objeto `result.steps` já existentes no `runSync`.

- [ ] **Step 1: Adicionar a fase**

Em `sync/clinicorp-sync.js`, logo depois de:

```js
  // Fase 4: inserir novos pacientes detectados
  await step('novos_pacientes', () => insertNewPatients(payMap, apptMap));
```

inserir:

```js
  // Fase 4b: enriquecer e-mail dos leads a partir de pacientes (sufixo-8) —
  // alimenta o `em` do CAPI (EMQ). Isolada: falha aqui não derruba o resto.
  await step('emails_leads', async () => {
    const { data, error } = await supabase.rpc('enriquecer_emails_leads');
    if (error) throw new Error(error.message);
    result.steps.emails_leads = data ?? 0;
    log(`E-mails de leads enriquecidos via pacientes: ${data ?? 0}`);
  });
```

(O `step()` já faz o try/catch e registra erro em `result.steps` — padrão das demais fases.)

- [ ] **Step 2: Verificar sintaxe**

```bash
node --check sync/clinicorp-sync.js
```

Esperado: sem output (OK).

- [ ] **Step 3: Testar a fase de verdade (uma execução real da RPC via Node)**

```bash
node -e "
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
s.rpc('enriquecer_emails_leads').then(({data, error}) => {
  console.log('rpc =>', { data, error: error && error.message });
  process.exit(error ? 1 : 0);
});"
```

Esperado: `rpc => { data: 0, error: null }` (0 porque o backfill da Task 3 já rodou — o que valida idempotência + permissão do service_role de uma vez).

- [ ] **Step 4: Commit, push e deploy**

```bash
git add sync/clinicorp-sync.js
git commit -m "feat(sync): fase emails_leads — enriquece leads.email via pacientes no ciclo diário"
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

(Se o `git push` travar: fluxo headless — token via CredRead do Credential Manager, `git -c credential.helper= push https://x-access-token:$TOKEN@github.com/gestaoclinicaodontoama/clinica-crm main`.)

---

### Task 5: Validação pós-deploy (pendências)

**Files:** nenhum.

- [ ] **Step 1: Amanhã (08/07):** conferir no `sync_log` a chave `emails_leads` nos steps do sync das 02:00 (número ≥ 0, sem `erro:`):

```sql
select iniciado_em, steps->>'emails_leads' as emails_leads
from sync_log order by iniciado_em desc limit 3;
```

- [ ] **Step 2: Em ~3–4 dias (10–11/07):** puxar o EMQ de novo (MCP `ads_get_dataset_quality`, datasets `981176104681444` e `904146029308947`) e comparar com o baseline **3,4**. O `em` só aparece nos eventos novos de fundo de funil, então a subida é gradual.

- [ ] **Step 3:** registrar os dois itens acima na lista de pendências do Luiz (memória `pending_tests.md`).
