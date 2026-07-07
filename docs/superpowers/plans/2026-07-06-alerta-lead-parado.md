# Alerta de Lead Parado (estagnação comercial) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Avisar/marcar quando um lead comercial trava numa etapa além do prazo (Compareceu 3d, Em negociação 2d por passo do D) — bloco no Meu Dia + card vermelho no kanban + cobrança diária.

**Architecture:** Extende a base do item 3 (RPC `comercial_meu_dia`) com um 5º bloco `parados` (mesmo round-trip). Nova RPC `leads_ultima_atividade(ids)` alimenta o card vermelho do kanban (PostgREST não faz agregação lateral inline → consulta-companheira). "Parado" = sem evento de ATIVIDADE (allowlist, não sistema) há mais que o prazo da etapa. Cron diário reusa o padrão da varredura do item 1.

**Tech Stack:** Node/Express, Supabase (MCP p/ migrations, project `mtqdpjhhqzvuklnlfpvi`), front vanilla, `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-06-alerta-lead-parado-design.md`

⚠️ **AMBIENTE:** trabalhar SEMPRE no worktree `/tmp/wt-parados` (Windows `C:\Users\Luiz Martins\AppData\Local\Temp\wt-parados`), branch `feat-parados`. A outra sessão reseta `main` — nunca trabalhar no working tree principal. Push só no fim (do worktree).

## Global Constraints

- **Regra D0–D5 (Playbook Pós-D5):** cadência ~2 dias por passo do D; estagnação em negociação = "parado no MESMO D sem toque > 2 dias" (avançar o D = `etapa_mudou` = reseta o relógio). NÃO é "X dias em negociação".
- **Allowlist de atividade** (reseta o relógio; idêntica nas 2 RPCs): `mensagem_enviada, mensagem_recebida, ligacao, status_mudou, etapa_mudou, nota_sdr_editada, template_enviado, conversa_assumida, comercial_assumido, mensagem_falhou`. NÃO conta `capi_disparado`/`disparo_massa`/`leads_mesclados`/`lead_criado`.
- Exclui do "parado" quem tem `proximo_contato` no FUTURO.
- EGRESS (cota 155%): matching nas RPCs; kanban usa 1 consulta-companheira por coluna (~30 ids). Nenhum select * em tabela grande novo.
- RPCs SECURITY INVOKER (NÃO DEFINER) + `revoke execute` de public/anon/authenticated (há alerta sistêmico de RPCs abertas a anon; a `comercial_meu_dia` já tinha revoke — recriar re-concede a PUBLIC, então re-aplicar).
- NUNCA `.catch()` direto em builder Supabase — try/catch no await.
- `lead_eventos` usa coluna `criado_em` (não `criada_em`).
- Cron/notificação fire-and-forget; erro não derruba fluxo. Timezone America/São_Paulo.
- Commitar SÓ os arquivos de cada task, no worktree. NUNCA `git add -A`.

---

### Task 1: Migração — config, constraint, RPC `parados`, RPC `leads_ultima_atividade`

**Files:**
- Create (no worktree): `supabase/migrations/20260706120000_alerta_lead_parado.sql`
- Aplicar via MCP Supabase (`apply_migration`, project `mtqdpjhhqzvuklnlfpvi`); conferir com `list_migrations`.

**Interfaces:**
- Produces: `app_config` ganha `parado_prazo_compareceu_dias`(3), `parado_prazo_negociacao_dias`(2), `parado_notif_hora`('09:00'), `parado_notif_envios`(jsonb '{}'); `notificacoes_tipo_check` + `lead_parado`; `comercial_meu_dia(p_uid)` ganha bloco `parados` (item: `id,nome,telefone,status,etapa,dias_parado`); RPC `leads_ultima_atividade(p_ids bigint[])` → `(lead_id bigint, dias_parado int, parado boolean)`.

- [ ] **Step 1: Escrever a migração**

```sql
-- Alerta de lead parado (spec 2026-07-06).
-- 1) config
alter table app_config
  add column if not exists parado_prazo_compareceu_dias int default 3,
  add column if not exists parado_prazo_negociacao_dias int default 2,
  add column if not exists parado_notif_hora text default '09:00',
  add column if not exists parado_notif_envios jsonb default '{}'::jsonb;

-- 2) tipo de notificação novo
alter table notificacoes drop constraint if exists notificacoes_tipo_check;
alter table notificacoes add constraint notificacoes_tipo_check check (tipo = any (array[
  'visita_lead','tarefa_atribuida','tarefa_vencendo','tarefa_resumo','sistema','conferencia_pendente',
  'resumo_crc','capi_alerta','aguardando_resposta','falta_sem_responsavel','falta_recuperar_lembrete',
  'whatsapp_saude','capi_resumo','coleta_lembrete','novo_comparecimento','lead_parado'
]));

-- 3) RPC leads_ultima_atividade — parado? por card (kanban). Allowlist de atividade.
create or replace function public.leads_ultima_atividade(p_ids bigint[])
returns table(lead_id bigint, dias_parado int, parado boolean)
language sql stable as $$
  with cfg as (
    select coalesce(parado_prazo_compareceu_dias,3) c, coalesce(parado_prazo_negociacao_dias,2) n
    from app_config where id=1
  )
  select l.id,
    floor(extract(epoch from (now()-x.ua))/86400)::int as dias_parado,
    case
      when l.proximo_contato is not null and l.proximo_contato > now() then false
      when l.status='Compareceu' then x.ua <= now() - make_interval(days => (select c from cfg))
      when l.status='Em negociação' then x.ua <= now() - make_interval(days => (select n from cfg))
      else false
    end as parado
  from leads l
  cross join lateral (
    select coalesce(max(e.criado_em), l.data_comparecimento, l.data_avaliacao, l.criado_em) as ua
    from lead_eventos e
    where e.lead_id = l.id and e.tipo = any(array[
      'mensagem_enviada','mensagem_recebida','ligacao','status_mudou','etapa_mudou',
      'nota_sdr_editada','template_enviado','conversa_assumida','comercial_assumido','mensagem_falhou'])
  ) x
  where l.id = any(p_ids);
$$;

-- 4) comercial_meu_dia recriada COM o bloco 'parados' (mantém os 4 blocos do item 3).
--    SECURITY INVOKER (default). base ganha data_avaliacao/criado_em p/ o coalesce.
create or replace function public.comercial_meu_dia(p_uid uuid)
returns jsonb language sql stable as $$
  with cfg as (
    select coalesce(parado_prazo_compareceu_dias,3) pc, coalesce(parado_prazo_negociacao_dias,2) pn
    from app_config where id=1
  ),
  base as (
    select id, nome, telefone, status, etapa_negociacao,
           data_comparecimento, data_avaliacao, proximo_contato, valor, crc_comercial_id, criado_em
    from leads
  )
  select jsonb_build_object(
    'para_pegar', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',id,'nome',nome,'telefone',telefone,'data_comparecimento',data_comparecimento
      ) order by data_comparecimento desc), '[]'::jsonb)
      from base where status='Compareceu' and crc_comercial_id is null
        and data_comparecimento >= now() - interval '30 days'
    ),
    'meus_comparecidos', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',id,'nome',nome,'telefone',telefone,'data_comparecimento',data_comparecimento
      ) order by data_comparecimento desc), '[]'::jsonb)
      from base where status='Compareceu'
        and (case when p_uid is null then crc_comercial_id is not null else crc_comercial_id = p_uid end)
    ),
    'minhas_negociacoes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',id,'nome',nome,'telefone',telefone,'etapa',coalesce(etapa_negociacao,'D0'),'valor',valor
      ) order by etapa_negociacao nulls first), '[]'::jsonb)
      from base where status='Em negociação'
        and (case when p_uid is null then crc_comercial_id is not null else crc_comercial_id = p_uid end)
    ),
    'followups', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',id,'nome',nome,'telefone',telefone,'proximo_contato',proximo_contato,'status',status
      ) order by proximo_contato asc), '[]'::jsonb)
      from base where proximo_contato is not null and proximo_contato <= now()
        and (case when p_uid is null then crc_comercial_id is not null else crc_comercial_id = p_uid end)
    ),
    'parados', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',id,'nome',nome,'telefone',telefone,'status',status,'etapa',etapa,'dias_parado',dias_parado
      ) order by dias_parado desc), '[]'::jsonb)
      from (
        select b.id, b.nome, b.telefone, b.status,
          coalesce(b.etapa_negociacao,'D0') as etapa,
          floor(extract(epoch from (now()-x.ua))/86400)::int as dias_parado
        from base b
        cross join lateral (
          select coalesce(max(e.criado_em), b.data_comparecimento, b.data_avaliacao, b.criado_em) as ua
          from lead_eventos e
          where e.lead_id = b.id and e.tipo = any(array[
            'mensagem_enviada','mensagem_recebida','ligacao','status_mudou','etapa_mudou',
            'nota_sdr_editada','template_enviado','conversa_assumida','comercial_assumido','mensagem_falhou'])
        ) x
        where (case when p_uid is null then b.crc_comercial_id is not null else b.crc_comercial_id = p_uid end)
          and (b.proximo_contato is null or b.proximo_contato <= now())
          and (
            (b.status='Compareceu' and x.ua <= now() - make_interval(days => (select pc from cfg)))
            or (b.status='Em negociação' and x.ua <= now() - make_interval(days => (select pn from cfg)))
          )
      ) s
    )
  );
$$;

-- 5) segurança: revoke execute (recriar re-concede a PUBLIC)
revoke execute on function public.comercial_meu_dia(uuid) from public, anon, authenticated;
revoke execute on function public.leads_ultima_atividade(bigint[]) from public, anon, authenticated;
```

- [ ] **Step 2: Aplicar via MCP e verificar**

`apply_migration` (name `alerta_lead_parado`). Depois `execute_sql`:
```sql
select jsonb_array_length(comercial_meu_dia(null)->'parados') as parados;   -- Compareceu 3d+ + negociação 2d+
select * from leads_ultima_atividade(array(select id from leads where status in ('Compareceu','Em negociação') and coalesce(importado_historico,false)=false limit 5));
select has_function_privilege('anon','public.comercial_meu_dia(uuid)','EXECUTE') as anon_cmd,
       has_function_privilege('anon','public.leads_ultima_atividade(bigint[])','EXECUTE') as anon_lua,
       has_function_privilege('service_role','public.leads_ultima_atividade(bigint[])','EXECUTE') as svc_lua;
```
Expected: ⚠️ `parados` = **0 HOJE e isso é CORRETO** — o bloco exige `crc_comercial_id` preenchido (parados = travados DE ALGUÉM) e o dono comercial começou a popular agora no item 3; medido em prod: com dono=0, sem exigir dono=44. NÃO "conserte" o 0 relaxando o filtro. A cobertura dos 44 sem-dono vem de: "para_pegar" (Meu Dia) + card vermelho do kanban (a `leads_ultima_atividade` NÃO exige dono — teste dela abaixo deve mostrar `parado=true` em vários). `leads_ultima_atividade` retorna 5 linhas com `dias_parado`/`parado` (espera-se true na maioria — Compareceu está 84% parado); `anon_cmd=false`, `anon_lua=false`, `svc_lua=true`. Conferir `list_migrations`.

- [ ] **Step 3: Commit**

```bash
cd /tmp/wt-parados && git add supabase/migrations/20260706120000_alerta_lead_parado.sql && git commit -m "feat(db): alerta lead parado — config, RPC parados + leads_ultima_atividade (revoke anon)"
```

---

### Task 2: Server — log `etapa_mudou`, card parado no kanban, cron diário

**Files:**
- Modify (worktree): `server.js` — patchLead (~`:776-826`), rota `/api/kanban/comercial/:coluna` (~`:1053`), + novo cron perto de `enviarVarreduraAguardando` (~`:3055`)

**Interfaces:**
- Consumes: RPCs `leads_ultima_atividade`, `comercial_meu_dia` (Task 1); `criarNotificacao(usuarioId,tipo,titulo,corpo,metadata)` (~`:7071`), `logEvento(leadId,tipo,descricao,metadata,usuarioId)` (~`:111`), `app_config.comercial_pool`/`parado_notif_hora`/`parado_notif_envios`.

- [ ] **Step 1: Log `etapa_mudou` no patchLead**

No `patchLead`, HOJE `status_mudou` só loga em troca de status (`server.js:823` `const statusMudou = req.body.status && req.body.status !== leadAntes.status`). Adicionar, logo após o bloco do `if (statusMudou) {...}` (por volta de `:840`), o log da mudança de etapa (guardando o valor antigo). ⚠️ Capturar `etapa` ANTES do update: no início de `patchLead`, onde já existe `const leadAntes = {...}` (~`:735`), adicionar `etapa_negociacao: lead.etapa_negociacao` ao objeto. Depois do update:

```js
    // Avançar/mudar o D (D1→D2) sem trocar status não gerava evento — logar p/ o
    // alerta de lead parado (mover o D conta como toque da cadência D0–D5).
    if (!statusMudou && req.body.etapa_negociacao !== undefined
        && updated.etapa_negociacao !== leadAntes.etapa_negociacao) {
      logEvento(updated.id, 'etapa_mudou',
        'Etapa: ' + (leadAntes.etapa_negociacao || '—') + ' → ' + (updated.etapa_negociacao || '—'),
        { de: leadAntes.etapa_negociacao, para: updated.etapa_negociacao }, req.user?.id || null);
    }
```

- [ ] **Step 2: Card parado no kanban (consulta-companheira)**

Na rota `/api/kanban/comercial/:coluna`, no ramo que já faz `buildComercialColFilter(...)` e monta `res.json({ leads: data, ... })` (~`:1071-1073`), SÓ para as colunas comerciais que têm prazo (`compareceu`, `d0`–`d5`), enriquecer `data` com `parado`/`dias_parado` antes do `res.json`:

```js
    let leads = data || [];
    if (['compareceu','d0','d1','d2','d3','d4','d5'].includes(coluna) && leads.length) {
      const ids = leads.map(l => l.id);
      const { data: ativ } = await supabase.rpc('leads_ultima_atividade', { p_ids: ids });
      const mapa = new Map((ativ || []).map(a => [a.lead_id, a]));
      leads = leads.map(l => {
        const a = mapa.get(l.id);
        return a ? { ...l, parado: a.parado, dias_parado: a.dias_parado } : l;
      });
    }
    res.json({ leads, total: count ?? 0, page, hasMore: offset + leads.length < (count ?? 0) });
```
(Substitui o `res.json` existente desse ramo; NÃO tocar no ramo `nutricao_`.)

- [ ] **Step 3: Cron diário `varrerLeadsParados`**

Colar após o bloco de `enviarVarreduraAguardando`/seu `setInterval` (~`:3087`). Reusa o padrão: dispara no horário `parado_notif_hora`, dedup por dia via `parado_notif_envios[uid]=hoje`.

```js
async function varrerLeadsParados() {
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const hhmm = new Date().toLocaleTimeString('sv-SE', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  const { data: cfg } = await supabase.from('app_config')
    .select('comercial_pool, parado_notif_hora, parado_notif_envios').eq('id', 1).maybeSingle();
  if (!cfg) return;
  const hora = cfg.parado_notif_hora || '09:00';
  if (hhmm < hora) return;
  const pool = Array.isArray(cfg.comercial_pool) ? cfg.comercial_pool : [];
  const envios = cfg.parado_notif_envios || {};
  let mudou = false;
  for (const uid of pool) {
    if (envios[uid] === hoje) continue;
    const { data, error } = await supabase.rpc('comercial_meu_dia', { p_uid: uid });
    if (error) { console.error('[lead-parado] rpc:', error.message); continue; }
    // marca como enviado SÓ após a RPC ter sucesso (falha transitória → retry no próximo tick;
    // mesmo bug de dedup-antes-do-sucesso já corrigido na varredura do item 1)
    envios[uid] = hoje; mudou = true;
    const n = Array.isArray(data?.parados) ? data.parados.length : 0;
    if (n > 0) {
      await criarNotificacao(uid, 'lead_parado', '⚠️ Leads parados',
        'Você tem ' + n + ' lead' + (n>1?'s':'') + ' parado' + (n>1?'s':'') + ' — resolva no Meu Dia',
        { url: '/meu-dia/' });
    }
  }
  if (mudou) await supabase.from('app_config').update({ parado_notif_envios: envios }).eq('id', 1);
}
setInterval(function () {
  varrerLeadsParados().catch(function (e) { console.error('[lead-parado]', e.message); });
}, 60000);
```

- [ ] **Step 4: Verificar e commitar**

Run (no worktree): `node --check server.js && npm test`
Expected: sem erro; suíte verde (3 falhas pré-existentes de `lib/monitor/crc.test.js` esperadas).
```bash
cd /tmp/wt-parados && git add server.js && git commit -m "feat(comercial): loga etapa_mudou + card parado no kanban + cron diario de leads parados"
```

---

### Task 3: Frontend — bloco ⚠️ Parados no Meu Dia + card vermelho no kanban

**Files:**
- Modify (worktree): `public/meu-dia/index.html`, `public/kanban-comercial/index.html`

**Interfaces:**
- Consumes: `d.parados` de `GET /api/comercial/meu-dia`; `l.parado`/`l.dias_parado` nos cards de `GET /api/kanban/comercial/:coluna`.

- [ ] **Step 1: Bloco ⚠️ Parados no Meu Dia (topo)**

Em `public/meu-dia/index.html`: adicionar uma seção **antes** de "Para pegar" no HTML (com `<h2>⚠️ Parados <span id="count-parados"></span></h2><div id="parados"></div>`). No JS, dentro de `carregar()`, chamar `render('parados', d.parados, false)` como PRIMEIRO render. Ajustar `render()` para, quando `elId==='parados'`, mostrar "parado há X dias" em vermelho e a etapa:

```js
  // dentro de render(), ao montar cada card, se elId==='parados':
  // extra = ' · ' + escHtml(l.etapa) + ' · <b style="color:#dc2626">parado há ' + l.dias_parado + 'd</b>'
```
⚠️ Reusar o `escHtml` já existente na página (do fix de XSS do item 3) em `l.nome` e `l.etapa`. Estado vazio do bloco parados: "🎉 Nada parado — tudo em dia." (o `render` já trata vazio; adicionar a mensagem específica pro id `parados`).

- [ ] **Step 2: Card vermelho no kanban comercial**

Em `public/kanban-comercial/index.html`, no ponto que monta cada card (procurar onde `cardAge`/`crc_comercial_nome` são renderizados), adicionar quando `l.parado`: uma borda/selo vermelho + texto **"⏳ parado Xd"** (`l.dias_parado`). Ex.: adicionar `style="border-left:3px solid #dc2626"` no card e um `<span style="color:#dc2626;font-weight:700">⏳ parado ${l.dias_parado}d</span>`. ⚠️ ancorar no template real do card; escapar nada de novo (dias_parado é número).

- [ ] **Step 3: Verificar**

Run (no worktree):
```bash
node -e "const s=require('fs').readFileSync('/tmp/wt-parados/public/meu-dia/index.html','utf8'); if(!s.includes('parados')) throw new Error('bloco parados'); console.log('meu-dia ok')"
node -e "const s=require('fs').readFileSync('/tmp/wt-parados/public/kanban-comercial/index.html','utf8'); if(!s.includes('parado')) throw new Error('card parado'); console.log('kanban ok')"
```
Expected: ambos `ok`. (Validação visual fica na Task 4.)

- [ ] **Step 4: Commit**

```bash
cd /tmp/wt-parados && git add public/meu-dia/index.html public/kanban-comercial/index.html && git commit -m "feat(comercial): bloco Parados no Meu Dia + card vermelho no kanban"
```

---

### Task 4: Deploy + validação

**Files:** nenhum novo.

- [ ] **Step 1: Rebase + push do worktree**

```bash
cd /tmp/wt-parados
git fetch origin -q && git rebase origin/main    # resolver conflitos se a sessão concorrente mexeu nos mesmos pontos
node --check server.js && npm test               # revalidar pós-rebase
```
Push via token do Windows Credential Manager (GCM trava — ver memória `feedback_git_push_headless`): CredRead → push na URL com token, `feat-parados:main`, redigido. Confirmar `origin/main` = HEAD do worktree.

- [ ] **Step 2: Deploy + swap**

```bash
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```
Aguardar swap: `/api/version` deployedAt muda; conferir marcador servido (ex.: `curl .../meu-dia/ | grep -q 'count-parados'`).

- [ ] **Step 3: Validar via banco + smoke**

```sql
select jsonb_array_length(comercial_meu_dia(null)->'parados');  -- >0
```
Smoke: `/meu-dia/`=200, `/api/comercial/meu-dia`=401. Conferir no ar que `/js/...`/página novos são servidos.

- [ ] **Step 4: Registrar pendências do Luiz em `pending_tests.md`**

Validar logado: (a) bloco ⚠️ Parados no topo do Meu Dia lista os travados com "parado há Xd"; (b) card vermelho no kanban comercial; (c) mover o D de um lead → ele sai de "parado" (o `etapa_mudou` reseta); (d) marcar `proximo_contato` futuro → sai de "parado"; (e) a cobrança das 9h chega pra quem tem parados.

---

## Self-review (feito na escrita)

- **Cobertura do spec:** pré-req etapa_mudou → Task 2 Step 1; config → Task 1; RPC parados → Task 1 + Task 3; leads_ultima_atividade/card kanban → Task 1 + Task 2 Step 2 + Task 3 Step 2; cron diário → Task 2 Step 3; revoke/INVOKER → Task 1 Step 1/5. Bordas (allowlist, proximo_contato futuro, coalesce sem evento, consistência 2 telas via mesma allowlist+config) cobertas.
- **Consistência de nomes:** `leads_ultima_atividade`, `comercial_meu_dia`, `parado`/`dias_parado`, `parado_prazo_*`, `parado_notif_*`, `etapa_mudou`, `varrerLeadsParados` — definidos numa task e consumidos com o mesmo nome nas seguintes. A allowlist de tipos é IDÊNTICA nas 2 RPCs (Task 1) e citada nas Global Constraints.
- **Sem placeholders:** SQL/JS completos. Pontos de leitura in-loco (Task 2 Step 1 objeto leadAntes; Task 3 template do card do kanban) têm instrução exata de onde ancorar.
- **Ponto de atenção:** a allowlist aparece 2x no SQL (Task 1) — duplicação literal aceitável; se divergir, kanban e Meu Dia se contradizem. O reviewer deve conferir que as duas listas são idênticas.
