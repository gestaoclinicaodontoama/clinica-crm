# Handoff Comercial + "Meu Dia" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar dono comercial ao lead que comparece (claim-first), avisar as CRC comerciais no Compareceu, e dar a elas uma home "Meu Dia" com 4 blocos filtrados.

**Architecture:** Notificação e claim como helpers server-side (molde do `assumirConversaSeSemDono` já existente); os 4 blocos do Meu Dia numa RPC Postgres única (egress: um round-trip, payload pequeno). Página separada `public/meu-dia/` no padrão do kanban-comercial. Home padrão via redirect no landing do index para role `crc_comercial`.

**Tech Stack:** Node/Express, Supabase (MCP p/ migrations, project `mtqdpjhhqzvuklnlfpvi`), front vanilla, `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-05-handoff-comercial-design.md`

## Global Constraints

- NUNCA `.catch()` direto em builder Supabase — try/catch no await, ou `.then().catch()` sobre promise.
- `crc_comercial_id` NUNCA sobrescrito se já tem dono (guard `.is('crc_comercial_id', null)`).
- Notificação/claim são fire-and-forget: erro neles não pode derrubar o fluxo de status.
- Somas/filtros/joins no SQL (RPC), nunca no JS (limite 1000 linhas; cota Supabase 155%).
- `tasks`/notificações: tipo novo `novo_comparecimento` exige ampliar `notificacoes_tipo_check` (senão insert falha em silêncio).
- Pool comercial (Bruna `a42c4931-15da-4169-8813-8137d791a117`, Gabriela `469ea2d5-dc68-463e-a4ed-02d2d019cd18`) vem de `app_config.comercial_pool` (semeado por role).
- Fila "para pegar" = `status='Compareceu' AND crc_comercial_id IS NULL AND data_comparecimento >= hoje-30` (exclui o backlog de 1.412).
- Timezone America/Sao_Paulo onde aplicável.
- Commitar SÓ os arquivos de cada task; NUNCA `git add -A` (working dir compartilhado com outra sessão).
- Deploy: `git push` (se GCM travar, usar token do Windows Cred Manager via CredRead — ver memória feedback_git_push_headless) → `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`.

---

### Task 1: Migração — constraint de notificação, pool config, RPC do Meu Dia

**Files:**
- Create: `supabase/migrations/20260705150000_handoff_comercial.sql`
- Aplicar via MCP Supabase (`apply_migration`); conferir com `list_migrations`.

**Interfaces:**
- Produces: constraint `notificacoes_tipo_check` + `novo_comparecimento`; `app_config.comercial_pool jsonb`; RPC `comercial_meu_dia(p_uid uuid) -> jsonb` com chaves `para_pegar, meus_comparecidos, minhas_negociacoes, followups` (cada uma = array de objetos lead).

- [ ] **Step 1: Escrever a migração**

```sql
-- Handoff comercial (spec 2026-07-05).
-- 1) tipo de notificação novo (o CHECK bloqueia tipos fora da lista)
alter table notificacoes drop constraint if exists notificacoes_tipo_check;
alter table notificacoes add constraint notificacoes_tipo_check check (tipo = any (array[
  'visita_lead','tarefa_atribuida','tarefa_vencendo','tarefa_resumo','sistema','conferencia_pendente',
  'resumo_crc','capi_alerta','aguardando_resposta','falta_sem_responsavel','falta_recuperar_lembrete',
  'whatsapp_saude','capi_resumo','coleta_lembrete','novo_comparecimento'
]));

-- 2) pool comercial (ids das CRC comerciais ativas)
alter table app_config add column if not exists comercial_pool jsonb;
update app_config set comercial_pool = (
  select coalesce(jsonb_agg(id order by nome), '[]'::jsonb) from profiles
  where roles @> array['crc_comercial']::text[] and coalesce(ativo,true)
) where id = 1 and comercial_pool is null;

-- 3) RPC dos 4 blocos do Meu Dia. p_uid = CRC logada; null = agregado (gestor).
create or replace function public.comercial_meu_dia(p_uid uuid)
returns jsonb language sql stable as $$
  with base as (
    select id, nome, telefone, status, etapa_negociacao,
           data_comparecimento, proximo_contato, valor, crc_comercial_id
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
    )
  );
$$;
```

- [ ] **Step 2: Aplicar via MCP e verificar**

Aplicar com `apply_migration` (name `handoff_comercial`). Depois `execute_sql`:
```sql
select jsonb_array_length(comercial_pool) from app_config where id=1;
select jsonb_array_length(comercial_meu_dia(null)->'para_pegar') as para_pegar,
       jsonb_array_length(comercial_meu_dia(null)->'minhas_negociacoes') as negociacoes;
```
Expected: pool = 2; `para_pegar` ≈ 34, `negociacoes` ≈ 26 (medidos em prod). Se pool != 2, conferir `select id,nome,roles from profiles where roles @> array['crc_comercial']::text[]`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260705150000_handoff_comercial.sql
git commit -m "feat(db): handoff comercial — tipo notif, pool config, RPC comercial_meu_dia"
```

---

### Task 2: Server — claim, aviso no Compareceu, e endpoints

**Files:**
- Modify: `server.js` — helpers novos + hooks nos 3 pontos de Compareceu + auto-claim no `patchLead` + 2 endpoints

**Interfaces:**
- Consumes: RPC `comercial_meu_dia` (Task 1); helpers `criarNotificacao(usuarioId, tipo, titulo, corpo, metadata)` (~`server.js:7071`), `logEvento(leadId, tipo, descricao, metadata, usuarioId)` (~`server.js:107`), `sanitizeStr`.
- Produces: `assumirComercialSeSemDono(lead, user)`, `notificarComercialCompareceu(lead)`; rotas `POST /api/comercial/pegar/:id`, `GET /api/comercial/meu-dia`.

- [ ] **Step 1: Ler os pontos de integração**

Confirmar no `server.js`: (a) `assumirConversaSeSemDono` (~`:2038`, o molde); (b) os 3 pontos que setam Compareceu — `patchLead` (`:755`, tem `req.user`), sync `:3933` e `:3963` (sem `req.user`), webhook `:4137` (sem `req.user`); (c) `patchLead` já lê `req.user?.profile?.nome` (`:754`) → `req.user.profile.roles` disponível; (d) middleware de role p/ as rotas (ex.: `requireKanbanComercial` `:406`, ou montar `requireRole('crc_comercial','gestor','admin')`).

- [ ] **Step 2: Adicionar os 2 helpers (após `assumirConversaSeSemDono`, ~`:2049`)**

```js
// Claim-first comercial: 1ª ação da CRC comercial sobre o lead a torna dona.
// Só preenche quando vazio (guard .is) — nunca sobrescreve.
function assumirComercialSeSemDono(lead, user) {
  if (!lead || lead.crc_comercial_id || !user?.id) return;
  const nomeCrc = sanitizeStr(user.profile?.nome || '', 100);
  supabase.from('leads')
    .update({ crc_comercial_id: user.id, crc_comercial_nome: nomeCrc })
    .eq('id', lead.id).is('crc_comercial_id', null)
    .then(({ error }) => {
      if (!error) logEvento(lead.id, 'comercial_assumido', 'Assumido no comercial por ' + (nomeCrc || 'CRC'), {}, user.id);
    })
    .catch(() => {});
}

// Handoff: avisa o pool comercial quando um lead compareceu sem dono comercial.
async function notificarComercialCompareceu(lead) {
  try {
    if (!lead || lead.crc_comercial_id) return;
    const { data: cfg } = await supabase.from('app_config').select('comercial_pool').eq('id', 1).maybeSingle();
    const pool = Array.isArray(cfg?.comercial_pool) ? cfg.comercial_pool : [];
    for (const uid of pool) {
      await criarNotificacao(uid, 'novo_comparecimento', '🤝 Novo comparecido',
        (lead.nome || 'Paciente') + ' compareceu — pegar no Meu Dia',
        { url: '/meu-dia/', lead_id: lead.id });
    }
  } catch (e) { console.error('[handoff-comercial]', e.message); }
}
```

- [ ] **Step 3: Hook nos 3 pontos de Compareceu**

**patchLead** — no bloco `if (v === 'Compareceu' ...)` (~`:755`), decidir claim (se quem edita é comercial) vs notificar pool:
```js
        if (v === 'Compareceu' && !lead.data_comparecimento) patch.data_comparecimento = agora;
        if (v === 'Compareceu') {
          const ehComercial = (req.user?.profile?.roles || []).includes('crc_comercial');
          if (ehComercial && !lead.crc_comercial_id) {
            patch.crc_comercial_id = req.user.id; patch.crc_comercial_nome = req.user.profile?.nome || null;
          } else if (!lead.crc_comercial_id) { req._notifCompareceu = true; }
        }
```
E DEPOIS do update bem-sucedido em `patchLead` (onde já dispara CAPI, ~`:813`), adicionar:
```js
    if (req._notifCompareceu) notificarComercialCompareceu(lead);
```

**Auto-claim em Em negociação (drag do kanban)** — no bloco `if (v === 'Em negociação' ...)`:
```js
        if (v === 'Em negociação') {
          const ehComercial = (req.user?.profile?.roles || []).includes('crc_comercial');
          if (ehComercial && !lead.crc_comercial_id) {
            patch.crc_comercial_id = req.user.id; patch.crc_comercial_nome = req.user.profile?.nome || null;
          }
        }
```

**Sync** (`:3933` e `:3963`, sem req.user) e **webhook** (`:4137`) — logo após cada `update({status:'Compareceu'...})` bem-sucedido, chamar `notificarComercialCompareceu(lead)` (o objeto `lead`/registro disponível no escopo de cada ponto). Fire-and-forget.

- [ ] **Step 4: Endpoint POST /api/comercial/pegar/:id (botão Pegar)**

Adicionar (perto das outras rotas comerciais):
```js
app.post('/api/comercial/pegar/:id', requireAuth, requireRole('crc_comercial','gestor','admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const { data: lead } = await supabase.from('leads').select('id, crc_comercial_id, nome').eq('id', id).maybeSingle();
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    if (lead.crc_comercial_id) return res.json({ ok: false, ja_tem_dono: true });
    const nome = sanitizeStr(req.user.profile?.nome || '', 100);
    const { error } = await supabase.from('leads')
      .update({ crc_comercial_id: req.user.id, crc_comercial_nome: nome })
      .eq('id', id).is('crc_comercial_id', null);
    if (error) throw error;
    logEvento(id, 'comercial_assumido', 'Pego no Meu Dia por ' + (nome || 'CRC'), {}, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```
(Se `requireRole` não existir com essa assinatura, usar o middleware `requireKanbanComercial` já definido — confirmar no Step 1.)

- [ ] **Step 5: Endpoint GET /api/comercial/meu-dia**

```js
app.get('/api/comercial/meu-dia', requireAuth, requireRole('crc_comercial','gestor','admin'), async (req, res) => {
  try {
    const roles = req.user.profile?.roles || [];
    const gestor = roles.includes('admin') || roles.includes('gestor');
    // gestor/admin vê agregado (p_uid null); CRC comercial vê só o dela
    const p_uid = gestor ? null : req.user.id;
    const { data, error } = await supabase.rpc('comercial_meu_dia', { p_uid });
    if (error) throw error;
    res.json(data || { para_pegar: [], meus_comparecidos: [], minhas_negociacoes: [], followups: [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 6: Verificar e commitar**

Run: `node --check server.js && npm test`
Expected: sem erro; suíte verde (as 3 falhas de `lib/monitor/crc.test.js` são pré-existentes).
```bash
git add server.js
git commit -m "feat(comercial): handoff no Compareceu (claim + notifica pool) + endpoints meu-dia/pegar"
```

---

### Task 3: Frontend — página Meu Dia, nav, home padrão, claim no WhatsApp comercial

**Files:**
- Create: `public/meu-dia/index.html`, `public/js/meu-dia/api.js`
- Modify: `public/js/nav-config.js` (item novo), `public/index.html` (COMERCIAL_STATUSES + redirect de landing)

**Interfaces:**
- Consumes: `GET /api/comercial/meu-dia` e `POST /api/comercial/pegar/:id` (Task 2).

- [ ] **Step 1: Copiar o api.js do padrão existente**

Copiar `public/js/avaliacao-dentista/api.js` para `public/js/meu-dia/api.js` sem alterar (é o boilerplate de auth/refresh/retry padrão do projeto; expõe `request(method, path, body)`). Confirmar que exporta `request` (ou o nome usado pelas outras páginas).

- [ ] **Step 2: Criar `public/meu-dia/index.html`**

Página no padrão das separadas: inclui `<script src="/js/shared-nav.js" data-active="meu-dia"></script>` e `<script src="/js/meu-dia/api.js"></script>`. Estrutura: header "Meu Dia" + 4 seções (`para_pegar`, `meus_comparecidos`, `minhas_negociacoes`, `followups`), cada uma um `<div>` container. JS:

```html
<script>
async function carregar() {
  let d;
  try { d = await request('GET', '/api/comercial/meu-dia'); }
  catch (e) { document.getElementById('erro').textContent = 'Erro ao carregar: ' + e.message; return; }
  render('para-pegar', d.para_pegar, true);
  render('meus-comparecidos', d.meus_comparecidos, false);
  render('minhas-negociacoes', d.minhas_negociacoes, false);
  render('followups', d.followups, false);
}
function _fone(t){ return (t||'').replace(/\D/g,''); }
function render(elId, itens, comPegar) {
  const el = document.getElementById(elId);
  const cont = document.getElementById('count-' + elId);
  if (cont) cont.textContent = itens.length;
  if (!itens.length) {
    el.innerHTML = '<div class="vazio">' + (elId==='followups'
      ? 'Nenhum follow-up marcado — use o 📅 no lead.' : 'Nada aqui por enquanto.') + '</div>';
    return;
  }
  el.innerHTML = itens.map(l => {
    const wa = _fone(l.telefone) ? '<a href="https://wa.me/55' + _fone(l.telefone) + '" target="_blank">💬</a>' : '';
    const extra = l.etapa ? ' · ' + l.etapa : (l.proximo_contato ? ' · vence ' + new Date(l.proximo_contato).toLocaleDateString('pt-BR') : '');
    const pegar = comPegar ? '<button onclick="pegar(' + l.id + ',this)">Pegar</button>' : '';
    return '<div class="card"><a href="/?abrir_lead=' + l.id + '">' + (l.nome||'(sem nome)') + '</a>'
      + extra + ' ' + wa + ' ' + pegar + '</div>';
  }).join('');
}
async function pegar(id, btn) {
  btn.disabled = true; btn.textContent = '...';
  try {
    const r = await request('POST', '/api/comercial/pegar/' + id);
    if (r.ja_tem_dono) { alert('Outra CRC já pegou este lead.'); }
    await carregar();
  } catch (e) { btn.disabled = false; btn.textContent = 'Pegar'; alert('Erro: ' + e.message); }
}
carregar();
</script>
```
CSS mínimo inline no padrão das outras páginas (cards, seções, contadores). Cada seção tem um `<h2>` com `<span id="count-...">`. Um `<div id="erro">` p/ falha de carga. (Seguir o visual das páginas existentes — cores via variáveis CSS do tema.)

- [ ] **Step 3: Adicionar item no nav (`public/js/nav-config.js`)**

Na seção `crc-comercial` (`:60-66`), adicionar como PRIMEIRO item da lista (fica no topo da seção):
```js
      { slug: 'meu-dia', label: '📅 Meu Dia', roles: 'admin,gestor,crc_comercial', mode: 'link', href: '/meu-dia/' },
```

- [ ] **Step 4: Home padrão da CRC comercial (`public/index.html`)**

⚠️ Os roles chegam de forma ASSÍNCRONA em `loadCurrentUser()` (`public/index.html:5946`): `_currentUser = d` e `const roles = Array.isArray(d.roles) ? d.roles : []` (`:5950`). O landing default no `iniciarApp` roda ANTES disso resolver, então o redirect tem que ficar DENTRO de `loadCurrentUser`, logo após a linha `const roles = ...` (`:5950`), onde os roles já existem:
```js
    // Home padrão: CRC comercial pura cai no Meu Dia (só no landing inicial).
    const _semParam = !new URLSearchParams(location.search).get('page') && !new URLSearchParams(location.search).get('abrir_lead');
    if (_semParam && roles.includes('crc_comercial') && !roles.includes('admin') && !roles.includes('gestor')
        && !location.pathname.startsWith('/meu-dia')) {
      location.href = '/meu-dia/'; return;
    }
```
⚠️ ANCORE no código real: usar a variável `roles` já computada em `:5950` (não inventar outra); confirmar a numeração exata antes de inserir. O guard `location.pathname.startsWith('/meu-dia')` evita loop.

- [ ] **Step 5: Claim no WhatsApp comercial (`public/index.html`)**

Localizar `COMERCIAL_STATUSES` (~`:2582`, `new Set(['Em negociação','Fechou','Perdido'])`) e adicionar `'Compareceu'`:
```js
const COMERCIAL_STATUSES = new Set(['Compareceu','Em negociação','Fechou','Perdido']);
```
(O bloco em `:2884` já usa esse Set para auto-setar `crc_comercial_id` client-side quando vazio — passa a cobrir Compareceu.)

- [ ] **Step 6: Verificar**

Run: `node -e "const s=require('fs').readFileSync('public/index.html','utf8'); if(!s.includes(\"'Compareceu','Em negociação'\")) throw new Error('COMERCIAL_STATUSES'); console.log('ok')"` → `ok`.
Conferir `node --check server.js` (sanidade, não mudou). Registrar Meu Dia no módulo Usuários NÃO é necessário (não é role novo; usa roles existentes).

- [ ] **Step 7: Commit**

```bash
git add public/meu-dia/index.html public/js/meu-dia/api.js public/js/nav-config.js public/index.html
git commit -m "feat(comercial): tela Meu Dia + nav + home padrão + claim no Compareceu (WhatsApp comercial)"
```

---

### Task 4: Deploy + validação

**Files:** nenhum novo.

- [ ] **Step 1: Push + deploy**

```bash
git push    # se GCM travar: token via Windows Cred Manager (CredRead), push na URL com token, redigido
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```
Se divergir de origin (sessão concorrente): fast-forward se possível; senão worktree isolado + cherry-pick dos commits desta feature (padrão da memória; nunca `--force`).

- [ ] **Step 2: Smoke test no ar**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://plataformaama-plataforma.uc5as5.easypanel.host/meu-dia/
curl -s -o /dev/null -w "%{http_code}\n" https://plataformaama-plataforma.uc5as5.easypanel.host/api/comercial/meu-dia
```
Expected: `200` (página) e `401` (API sem token). Conferir o swap (deployedAt novo em `/api/version`).

- [ ] **Step 3: Validar via banco (leitura)**

```sql
select jsonb_array_length(comercial_meu_dia(null)->'para_pegar') as para_pegar;  -- ~34
-- após uma CRC comercial "Pegar" ou trabalhar um lead:
select count(*) from leads where crc_comercial_id is not null;                    -- deve subir de 0
select tipo, count(*) from notificacoes where tipo='novo_comparecimento' group by tipo;
```

- [ ] **Step 4: Registrar pendências do Luiz em `pending_tests.md`**

Validar logado: (a) logar como CRC comercial (Bruna/Gabriela) cai no Meu Dia; (b) os 4 blocos aparecem (para pegar ~34, negociações ~26, meus comparecidos/followups possivelmente vazios no início); (c) botão Pegar seta o dono e o lead move de "para pegar" → "meus comparecidos"; (d) mover um card no kanban comercial ou responder no WhatsApp comercial também vira dona; (e) quando um lead novo compareça, as CRC comerciais recebem a notificação 🤝.

---

## Self-review (feito na escrita)

- **Cobertura do spec:** migração/constraint/pool/RPC → Task 1; aviso no Compareceu (3 pontos) → Task 2 Step 3; claim (helper + patchLead + Pegar + WhatsApp) → Task 2 (Steps 2-4) + Task 3 Step 5; tela Meu Dia (4 blocos) → Task 1 (RPC) + Task 3; home padrão → Task 3 Step 4; egress (RPC única) → Task 1. Bordas (guard .is, duplo clique Pegar, backlog 30d, follow-ups vazio, fire-and-forget) cobertas.
- **Consistência de nomes:** `comercial_meu_dia`, `comercial_pool`, `assumirComercialSeSemDono`, `notificarComercialCompareceu`, `novo_comparecimento`, rotas `/api/comercial/pegar/:id` e `/api/comercial/meu-dia` — definidos numa task e consumidos com o mesmo nome nas seguintes.
- **Sem placeholders:** SQL/JS completos. Os pontos de leitura in-loco (Task 2 Step 1 assinatura de middleware; Task 3 Step 4 fonte real dos roles no index) têm instrução explícita de ancorar no código real.
- **Confirmado na escrita:** `requireRole(...allowed)` É variádico (`server.js:393`) → `requireRole('crc_comercial','gestor','admin')` funciona. Roles no index = `_currentUser`/`roles` computado em `loadCurrentUser` (`public/index.html:5946-5950`, ASSÍNCRONO) — o redirect de home foi ancorado lá (Step 4), não no landing síncrono do `iniciarApp`.
