# Recuperação de Falta (no-show) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformar cada falta de avaliação (no-show) em ação de recuperação: detecção pela agenda do Clinicorp → etiqueta "Faltou" + tarefa atribuída → cadência de 3 toques → auto-Perdido com trava.

**Architecture:** Matching pesado (agenda×pacientes×leads) e escrita de etiqueta ficam em RPCs Postgres (migração). Timing da cadência numa lib pura testável (`lib/recuperacao/cadencia.js`). Orquestração num cron in-process no `server.js` (`varrerFaltasAvaliacao`, `setInterval` ~3h) que lê as RPCs, decide via a lib pura, e cria tarefas/notificações reusando os helpers existentes. Estado por falta numa tabela de controle `recuperacao_faltas` (única por `clinicorp_appt_id`).

**Tech Stack:** Node/Express, Supabase (MCP p/ migrations, project `mtqdpjhhqzvuklnlfpvi`), `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-05-recuperacao-falta-design.md`

## Global Constraints

- NUNCA `.catch()` direto em builder Supabase — try/catch no await, ou `.then().catch()` sobre promise.
- Somas/filtros/joins grandes no SQL (RPC), nunca no JS (limite 1000 linhas do client).
- Erro numa falta não pode derrubar o processamento das outras (try/catch por item no cron).
- `tasks.assignee_id` é **NOT NULL** — dono desconhecido usa rodízio provisório entre as 3 CRC de Leads (nunca null).
- Categorias de avaliação: `category ILIKE 'Avalia%'`. CRC Pós = categoria `ILIKE '%Pós%'`; demais avaliações = "leads".
- Falta = `agenda_appointments`: `appointment_date < hoje`, `not deleted`, `checkin_time` null/vazio, `category ILIKE 'Avalia%'`.
- Timezone America/Sao_Paulo para idades/toques (padrão dos outros crons).
- Só processar faltas com `appointment_date >= hoje-30` (sem backfill retroativo).
- Commitar SÓ os arquivos de cada task; NUNCA `git add -A` (working dir compartilhado com outra sessão).
- Deploy: `git push` → `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`.

---

### Task 1: Migração — tabela de controle, RPCs, config, constraint de notificação

**Files:**
- Create: `supabase/migrations/20260705120000_recuperacao_faltas.sql`
- Aplicar via MCP Supabase (`apply_migration`, project `mtqdpjhhqzvuklnlfpvi`); conferir com `list_migrations`.

**Interfaces:**
- Produces:
  - Tabela `recuperacao_faltas` (colunas na seção Componente 1 do spec).
  - RPC `detectar_faltas_avaliacao(dias int default 30)` → set of `(clinicorp_appt_id text, patient_name text, category text, dentist_name text, appointment_date date, telefone text, lead_id bigint, crc_agendamento_id uuid)` — faltas de avaliação da janela que **ainda não estão** em `recuperacao_faltas`.
  - RPC `falta_esta_recuperada(p_appt_id text)` → boolean (regras da seção 4 do spec).
  - RPC `lead_add_etiqueta(p_lead_id bigint, p_tag text)` → void (append idempotente no array `etiquetas`).
  - `app_config`: `recuperacao_falta_crc_leads jsonb`, `recuperacao_falta_crc_pos uuid`, `recuperacao_falta_rodizio_idx int default 0`.
  - `notificacoes_tipo_check` ampliado com `falta_sem_responsavel`, `falta_recuperar_lembrete`.

- [ ] **Step 1: Escrever a migração**

```sql
-- Recuperação de falta (spec 2026-07-05). Tabela de controle + RPCs de matching.
create table if not exists public.recuperacao_faltas (
  id bigserial primary key,
  clinicorp_appt_id text unique not null,
  patient_name text,
  category text,
  dentist_name text,
  appointment_date date,
  telefone text,
  lead_id bigint references public.leads(id),
  crc_responsavel_id uuid references public.profiles(id),
  status text not null default 'aberta',   -- aberta | recuperada | perdida | encerrada
  toques_enviados int not null default 0,
  ultimo_toque_em timestamptz,
  task_id bigint references public.tasks(id),
  criada_em timestamptz not null default now(),
  recuperada_em timestamptz
);
alter table public.recuperacao_faltas enable row level security;
-- leitura p/ papéis internos (mesmo padrão das outras tabelas do CRM)
drop policy if exists recuperacao_faltas_read on public.recuperacao_faltas;
create policy recuperacao_faltas_read on public.recuperacao_faltas for select using (auth.role() = 'authenticated');

-- normaliza telefone (só dígitos, últimos 8) — casa lead por sufixo
create or replace function public._sufixo8(t text) returns text
language sql immutable as $$ select right(regexp_replace(coalesce(t,''),'\D','','g'), 8) $$;

-- Faltas de avaliação novas (não presentes em recuperacao_faltas), enriquecidas.
create or replace function public.detectar_faltas_avaliacao(dias int default 30)
returns table(clinicorp_appt_id text, patient_name text, category text, dentist_name text,
              appointment_date date, telefone text, lead_id bigint, crc_agendamento_id uuid)
language sql stable as $$
  with faltas as (
    select a.clinicorp_appt_id, a.patient_name, a.category, a.dentist_name, a.appointment_date
    from agenda_appointments a
    where a.appointment_date < current_date
      and a.appointment_date >= current_date - dias
      and not a.deleted
      and (a.checkin_time is null or a.checkin_time = '')
      and a.category ilike 'Avalia%'
      and not exists (select 1 from recuperacao_faltas r where r.clinicorp_appt_id = a.clinicorp_appt_id)
  ),
  comtel as (
    select f.*,
      (select regexp_replace(p.telefone_celular,'\D','','g') from pacientes p
       where lower(trim(p.nome)) = lower(trim(f.patient_name)) and coalesce(p.telefone_celular,'') <> '' limit 1) as tel
    from faltas f
  )
  select c.clinicorp_appt_id, c.patient_name, c.category, c.dentist_name, c.appointment_date,
    c.tel as telefone,
    l.id as lead_id,
    l.crc_agendamento_id
  from comtel c
  left join lateral (
    select id, crc_agendamento_id from leads l2
    where c.tel is not null and public._sufixo8(l2.telefone) = public._sufixo8(c.tel)
    order by id desc limit 1
  ) l on true;
$$;

-- Recuperada? consulta posterior com check-in OU futura marcada OU lead avançou.
create or replace function public.falta_esta_recuperada(p_appt_id text)
returns boolean language sql stable as $$
  with r as (select * from recuperacao_faltas where clinicorp_appt_id = p_appt_id)
  select coalesce((
    -- consulta posterior à falta: com check-in (voltou) ou futura (remarcou)
    exists (
      select 1 from agenda_appointments a, r
      where lower(trim(a.patient_name)) = lower(trim(r.patient_name))
        and not a.deleted
        and a.appointment_date > r.appointment_date
        and ((a.checkin_time is not null and a.checkin_time <> '') or a.appointment_date >= current_date)
    )
    or exists (
      select 1 from leads l, r
      where l.id = r.lead_id and l.status in ('Compareceu','Em negociação','Fechou')
    )
  ), false);
$$;

-- Append idempotente de etiqueta no lead.
create or replace function public.lead_add_etiqueta(p_lead_id bigint, p_tag text)
returns void language sql as $$
  update leads set etiquetas =
    (select array(select distinct e from unnest(coalesce(etiquetas,'{}') || array[p_tag]) e))
  where id = p_lead_id and not (coalesce(etiquetas,'{}') @> array[p_tag]);
$$;

-- Config
alter table app_config
  add column if not exists recuperacao_falta_crc_leads jsonb,
  add column if not exists recuperacao_falta_crc_pos uuid,
  add column if not exists recuperacao_falta_rodizio_idx int default 0;

update app_config set recuperacao_falta_crc_leads = (
  select coalesce(jsonb_agg(id order by nome), '[]'::jsonb) from profiles
  where roles @> array['crc_leads']::text[] and coalesce(ativo,true)
) where id = 1 and recuperacao_falta_crc_leads is null;

update app_config set recuperacao_falta_crc_pos = (
  select id from profiles where roles @> array['crc_pos_tratamento']::text[] and coalesce(ativo,true) order by nome limit 1
) where id = 1 and recuperacao_falta_crc_pos is null;

-- Amplia o CHECK de notificacoes.tipo (estava restrito; bloquearia os tipos novos)
alter table notificacoes drop constraint if exists notificacoes_tipo_check;
alter table notificacoes add constraint notificacoes_tipo_check check (tipo = any (array[
  'visita_lead','tarefa_atribuida','tarefa_vencendo','tarefa_resumo','sistema','conferencia_pendente',
  'resumo_crc','capi_alerta','aguardando_resposta','falta_sem_responsavel','falta_recuperar_lembrete'
]));
```

- [ ] **Step 2: Aplicar via MCP e verificar**

Aplicar com `apply_migration` (name `recuperacao_faltas`). Depois rodar via `execute_sql`:
```sql
select count(*) from detectar_faltas_avaliacao(30);
select recuperacao_falta_crc_leads, recuperacao_falta_crc_pos from app_config where id=1;
select jsonb_array_length(recuperacao_falta_crc_leads) from app_config where id=1;
```
Expected: 1ª retorna as faltas recentes (>0, com telefone/lead preenchidos na maioria); 2ª: array com 3 uuids + o uuid da Cristiane; 3ª: `3`. Se `crc_leads` vier != 3 ou `crc_pos` null, conferir `select id, nome, roles from profiles where roles @> array['crc_leads']::text[]` e ajustar.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260705120000_recuperacao_faltas.sql
git commit -m "feat(db): recuperacao_faltas — tabela, RPCs de deteccao/recuperacao, config, constraint notif"
```

---

### Task 2: Sync de consultas futuras na agenda (pré-requisito da seção 0)

**Files:**
- Modify: `sync/clinicorp-sync.js` — função `syncAgenda()` (~linha 628-682)

**Interfaces:**
- Consumes: nada. Produces: `agenda_appointments` passa a conter consultas futuras (~60 dias), necessárias para detectar remarcação e para a trava do auto-Perdido.

**Contexto:** `syncAgenda` hoje só puxa para trás via `fetchRangeChunked('/appointment/list', AGENDA_DIAS)` (o helper é backward-only, `sync/clinicorp-sync.js:326-336`). Medido: 0 consultas futuras em `agenda_appointments`. O padrão de fetch futuro já existe no arquivo em `sync/clinicorp-sync.js:64-66` (`api.get('/appointment/list', {from: today, to: future60})`).

- [ ] **Step 1: Adicionar o fetch futuro ao `raw` de `syncAgenda`**

Em `syncAgenda()`, logo após `const raw = await fetchRangeChunked('/appointment/list', AGENDA_DIAS);` (linha 635), inserir:

```js
  // Consultas FUTURAS (~60d): sem isto agenda_appointments só tem passado, e a
  // recuperação de falta não detecta remarcação nem trava o auto-Perdido.
  const _hoje = new Date();
  const _fut = new Date(_hoje); _fut.setDate(_fut.getDate() + 60);
  const dateStrLocal = d => d.toISOString().slice(0, 10);
  const futuras = await api.get('/appointment/list', { from: dateStrLocal(_hoje), to: dateStrLocal(_fut) });
  if (Array.isArray(futuras)) raw.push(...futuras);
```

(Se já existir um helper `dateStr` no escopo do módulo — confirmar no topo do arquivo — reusar em vez de declarar `dateStrLocal`. O dedup por `seenIds` logo abaixo já cuida de sobreposição.)

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check sync/clinicorp-sync.js`
Expected: sem erro.

- [ ] **Step 3: Commit**

```bash
git add sync/clinicorp-sync.js
git commit -m "feat(sync): agenda puxa consultas futuras (60d) p/ recuperacao de falta"
```

(Validação de que futuras aparecem em `agenda_appointments` fica na Task 5, após o sync rodar/ser disparado.)

---

### Task 3: Lib pura da cadência (TDD)

**Files:**
- Create: `lib/recuperacao/cadencia.js`
- Test: `lib/recuperacao/cadencia.test.js`

**Interfaces:**
- Produces:
  - `diasDesde(dataFalta, hoje) -> int` (dias inteiros entre as duas datas ISO `YYYY-MM-DD`).
  - `toqueDevido(dataFalta, hoje, toquesEnviados) -> 0|3|7|10|null` — qual marco de toque está devido AGORA e ainda não foi enviado; `null` se nada devido.
  - `podeAutoPerder({leadEncontrado, statusLead, temConsultaFutura, tarefaConcluida}) -> boolean` — trava do D+10.

- [ ] **Step 1: Escrever os testes**

```js
// lib/recuperacao/cadencia.test.js
const test = require('node:test');
const assert = require('node:assert');
const { diasDesde, toqueDevido, podeAutoPerder } = require('./cadencia');

test('diasDesde conta dias inteiros', () => {
  assert.strictEqual(diasDesde('2026-07-01', '2026-07-01'), 0);
  assert.strictEqual(diasDesde('2026-07-01', '2026-07-04'), 3);
  assert.strictEqual(diasDesde('2026-07-01', '2026-07-11'), 10);
});

test('toqueDevido retorna o marco ainda não enviado', () => {
  // 0 toques enviados, dia da falta → D+0 devido
  assert.strictEqual(toqueDevido('2026-07-01', '2026-07-01', 0), 0);
  // D+0 já enviado (1), 3 dias depois → D+3 devido
  assert.strictEqual(toqueDevido('2026-07-01', '2026-07-04', 1), 3);
  // 3 dias mas D+3 já enviado (2) → nada devido ainda
  assert.strictEqual(toqueDevido('2026-07-01', '2026-07-04', 2), null);
  // 7 dias, 2 enviados → D+7 devido
  assert.strictEqual(toqueDevido('2026-07-01', '2026-07-08', 2), 7);
  // 10 dias, 3 enviados → D+10 (auto-Perdido) devido
  assert.strictEqual(toqueDevido('2026-07-01', '2026-07-11', 3), 10);
  // 1 dia só, D+0 enviado → nada ainda
  assert.strictEqual(toqueDevido('2026-07-01', '2026-07-02', 1), null);
});

test('podeAutoPerder exige todas as travas', () => {
  const ok = { leadEncontrado: true, statusLead: 'Avaliação agendada', temConsultaFutura: false, tarefaConcluida: false };
  assert.strictEqual(podeAutoPerder(ok), true);
  assert.strictEqual(podeAutoPerder({ ...ok, leadEncontrado: false }), false); // sem lead
  assert.strictEqual(podeAutoPerder({ ...ok, statusLead: 'Fechou' }), false);   // já cliente
  assert.strictEqual(podeAutoPerder({ ...ok, statusLead: 'Perdido' }), false);
  assert.strictEqual(podeAutoPerder({ ...ok, temConsultaFutura: true }), false); // remarcou
  assert.strictEqual(podeAutoPerder({ ...ok, tarefaConcluida: true }), false);   // CRC já trabalhou
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/recuperacao/cadencia.test.js`
Expected: FAIL — `Cannot find module './cadencia'`

- [ ] **Step 3: Implementar**

```js
// lib/recuperacao/cadencia.js
// Timing puro da cadência de recuperação de falta (spec 2026-07-05).
const MARCOS = [0, 3, 7, 10]; // D+0, D+3, D+7, D+10(auto-Perdido)
const PRE_FECHAMENTO_BLOQUEIA = new Set(['Fechou', 'Perdido']);

function diasDesde(dataFalta, hoje) {
  const a = new Date(dataFalta + 'T00:00:00Z');
  const b = new Date(hoje + 'T00:00:00Z');
  return Math.floor((b - a) / 86400000);
}

// Qual marco está devido agora e ainda não foi enviado (toquesEnviados = quantos
// marcos já disparados, em ordem). Retorna o marco (0/3/7/10) ou null.
function toqueDevido(dataFalta, hoje, toquesEnviados) {
  const d = diasDesde(dataFalta, hoje);
  const proximo = MARCOS[toquesEnviados];         // próximo marco a disparar
  if (proximo === undefined) return null;          // já disparou todos
  return d >= proximo ? proximo : null;
}

function podeAutoPerder({ leadEncontrado, statusLead, temConsultaFutura, tarefaConcluida }) {
  return !!leadEncontrado
    && !PRE_FECHAMENTO_BLOQUEIA.has(statusLead)
    && !temConsultaFutura
    && !tarefaConcluida;
}

module.exports = { diasDesde, toqueDevido, podeAutoPerder, MARCOS };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/recuperacao/cadencia.test.js` → 3 testes PASS. Depois `npm test` (suíte inteira; ⚠️ há 3 falhas PRÉ-EXISTENTES em `lib/monitor/crc.test.js` — confirmar que não há novas).

- [ ] **Step 5: Commit**

```bash
git add lib/recuperacao/cadencia.js lib/recuperacao/cadencia.test.js
git commit -m "feat(recuperacao): lib pura de timing da cadencia (TDD)"
```

---

### Task 4: Cron de orquestração `varrerFaltasAvaliacao` no server.js

**Files:**
- Modify: `server.js` — adicionar a função + `setInterval`, perto dos outros crons (ex.: após `syncComparecimentos`/`cronTarefas`)

**Interfaces:**
- Consumes: RPCs da Task 1 (`detectar_faltas_avaliacao`, `falta_esta_recuperada`, `lead_add_etiqueta`); lib da Task 3 (`toqueDevido`, `podeAutoPerder`); helpers existentes `criarNotificacao(usuarioId, tipo, titulo, corpo, metadata)`, `logEvento(leadId, tipo, descricao, metadata, usuarioId)`.

- [ ] **Step 1: Ler os pontos de reuso**

Confirmar no `server.js`: a assinatura de `criarNotificacao` (~linha 6937) e de `logEvento` (~linha 107), e o padrão de insert em `tasks` (POST /api/tarefas, ~linha 7104-7123: campos `titulo, descricao, tipo:'pontual', data_ref, created_by, prioridade, categoria, prazo, lead_id, status:'pendente', assignee_id`). Confirmar como o server importa libs de `lib/` (require no topo).

- [ ] **Step 2: Adicionar require e a função (colar após a definição de `syncComparecimentos`)**

No topo, junto dos requires de `lib/`: `const { toqueDevido, podeAutoPerder } = require('./lib/recuperacao/cadencia');`

```js
// ===== Recuperação de falta de avaliação (spec 2026-07-05) =====
// Detecta no-shows pela agenda, cria etiqueta+tarefa, roda cadência D+0/3/7/10.
function _hojeSP() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

async function _criarTarefaRecuperacao(falta, assigneeId) {
  const desc = [
    'Paciente faltou à avaliação (' + (falta.category || 's/ categoria') + ').',
    falta.telefone ? 'Tel: ' + falta.telefone : 'Sem telefone no cadastro — buscar no Clinicorp.',
    falta.dentist_name ? 'Dentista: ' + falta.dentist_name : null,
    'Data da falta: ' + falta.appointment_date,
    'Ligar para remarcar.',
  ].filter(Boolean).join('\n');
  const { data, error } = await supabase.from('tasks').insert({
    titulo: 'Recuperar falta — ' + (falta.patient_name || 'paciente'),
    descricao: desc, tipo: 'pontual', data_ref: _hojeSP(),
    created_by: assigneeId, prioridade: 'alta', categoria: 'recuperacao_falta',
    prazo: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    lead_id: falta.lead_id || null, assignee_id: assigneeId, status: 'pendente',
  }).select('id').single();
  if (error) { console.error('[recuperacao] task:', error.message); return null; }
  return data.id;
}

async function _donoProvisorioRodizio() {
  const { data: cfg } = await supabase.from('app_config')
    .select('recuperacao_falta_crc_leads, recuperacao_falta_rodizio_idx').eq('id', 1).maybeSingle();
  const lista = Array.isArray(cfg?.recuperacao_falta_crc_leads) ? cfg.recuperacao_falta_crc_leads : [];
  if (!lista.length) return { dono: null, todos: [] };
  const idx = (cfg.recuperacao_falta_rodizio_idx || 0) % lista.length;
  const dono = lista[idx];
  await supabase.from('app_config').update({ recuperacao_falta_rodizio_idx: idx + 1 }).eq('id', 1);
  return { dono, todos: lista };
}

async function varrerFaltasAvaliacao() {
  const hoje = _hojeSP();
  // 1) NOVAS faltas
  const { data: novas, error: eNovas } = await supabase.rpc('detectar_faltas_avaliacao', { dias: 30 });
  if (eNovas) { console.error('[recuperacao] detectar:', eNovas.message); return; }
  const { data: cfg } = await supabase.from('app_config')
    .select('recuperacao_falta_crc_pos').eq('id', 1).maybeSingle();
  const crcPos = cfg?.recuperacao_falta_crc_pos || null;
  for (const f of (novas || [])) {
    try {
      // define responsável
      let assignee = null, semDono = false;
      if ((f.category || '').match(/pós|pos/i) && crcPos) assignee = crcPos;
      else if (f.crc_agendamento_id) assignee = f.crc_agendamento_id;
      let todosLeads = [];
      if (!assignee) { const r = await _donoProvisorioRodizio(); assignee = r.dono; todosLeads = r.todos; semDono = true; }
      if (!assignee) continue; // sem config → não cria (evita task órfã)
      const taskId = await _criarTarefaRecuperacao(f, assignee);
      if (f.lead_id) await supabase.rpc('lead_add_etiqueta', { p_lead_id: f.lead_id, p_tag: 'Faltou' });
      await supabase.from('recuperacao_faltas').insert({
        clinicorp_appt_id: f.clinicorp_appt_id, patient_name: f.patient_name, category: f.category,
        dentist_name: f.dentist_name, appointment_date: f.appointment_date, telefone: f.telefone,
        lead_id: f.lead_id || null, crc_responsavel_id: semDono ? null : assignee,
        status: 'aberta', toques_enviados: 1, ultimo_toque_em: new Date().toISOString(), task_id: taskId,
      });
      if (semDono) {
        for (const uid of todosLeads) {
          await criarNotificacao(uid, 'falta_sem_responsavel', 'Falta sem responsável',
            (f.patient_name || 'Paciente') + ' faltou (' + (f.category || '') + '). Atribuída provisoriamente; remaneje se for de outra.',
            { url: '/tarefas/', task_id: taskId });
        }
      }
    } catch (e) { console.error('[recuperacao] nova falta:', e.message); }
  }
  // 2) ABERTAS: recuperação + cadência
  const { data: abertas } = await supabase.from('recuperacao_faltas').select('*').eq('status', 'aberta');
  for (const r of (abertas || [])) {
    try {
      const { data: recuperada } = await supabase.rpc('falta_esta_recuperada', { p_appt_id: r.clinicorp_appt_id });
      if (recuperada) {
        if (r.task_id) await supabase.from('tasks').update({ status: 'concluida' }).eq('id', r.task_id);
        await supabase.from('recuperacao_faltas').update({ status: 'recuperada', recuperada_em: new Date().toISOString() }).eq('id', r.id);
        continue;
      }
      const marco = toqueDevido(r.appointment_date, hoje, r.toques_enviados);
      if (marco === null) continue;
      if (marco === 10) {
        // auto-Perdido com trava. Já passamos pela checagem de recuperação acima e
        // NÃO recuperou → logo não há consulta futura (futura tornaria recuperada).
        // Por isso temConsultaFutura é definitivamente false aqui (sem RPC extra).
        let statusLead = null, tarefaConcluida = false;
        if (r.lead_id) {
          const { data: l } = await supabase.from('leads').select('status').eq('id', r.lead_id).maybeSingle();
          statusLead = l?.status || null;
        }
        if (r.task_id) {
          const { data: t } = await supabase.from('tasks').select('status').eq('id', r.task_id).maybeSingle();
          tarefaConcluida = t?.status === 'concluida';
        }
        if (podeAutoPerder({ leadEncontrado: !!r.lead_id, statusLead, temConsultaFutura: false, tarefaConcluida })) {
          await supabase.from('leads').update({ status: 'Perdido', motivo_perda: 'Faltou e não retornou' }).eq('id', r.lead_id);
          logEvento(r.lead_id, 'status_mudou', 'Auto-Perdido: faltou e não retornou', { de: statusLead, para: 'Perdido' }, null);
          if (r.task_id) await supabase.from('tasks').update({ status: 'concluida' }).eq('id', r.task_id);
          await supabase.from('recuperacao_faltas').update({ status: 'perdida' }).eq('id', r.id);
        } else {
          await supabase.from('recuperacao_faltas').update({ status: 'encerrada' }).eq('id', r.id);
        }
        continue;
      }
      // toque D+3 ou D+7: renotifica o dono (ou as 3 se sem dono)
      const alvo = r.crc_responsavel_id ? [r.crc_responsavel_id] : (await _donoProvisorioRodizio()).todos;
      for (const uid of alvo) {
        await criarNotificacao(uid, 'falta_recuperar_lembrete', 'Lembrete: recuperar falta',
          'D+' + marco + ' — ' + (r.patient_name || 'paciente') + ' ainda não voltou. Insista na remarcação.',
          { url: '/tarefas/', task_id: r.task_id });
      }
      await supabase.from('recuperacao_faltas').update({
        toques_enviados: r.toques_enviados + 1, ultimo_toque_em: new Date().toISOString(),
      }).eq('id', r.id);
    } catch (e) { console.error('[recuperacao] cadencia:', e.message); }
  }
}

setInterval(function () {
  varrerFaltasAvaliacao().catch(function (e) { console.error('[recuperacao]', e.message); });
}, 3 * 3600 * 1000);
```

⚠️ Nota sobre `toques_enviados`: o D+0 grava a linha já com `toques_enviados: 1` (o 1º marco, índice 0, foi disparado na criação). Assim `toqueDevido` na próxima varredura usa índice 1 → marco 3. Confere com os testes da Task 3.

- [ ] **Step 3: Verificar**

Run: `node --check server.js && npm test`
Expected: sem erro de sintaxe; suíte verde (só as 3 falhas pré-existentes do crc.test.js).

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(recuperacao): cron varreFaltasAvaliacao — etiqueta+tarefa+cadencia+auto-Perdido"
```

---

### Task 5: Deploy + validação ponta-a-ponta

**Files:** nenhum novo.

- [ ] **Step 1: Push + deploy**

```bash
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```
Se o push divergir de outra sessão: `git fetch` + rebase dos commits desta feature sobre `origin/main` (worktree isolado se necessário — padrão da memória; nunca `--force`).

- [ ] **Step 2: Smoke test no ar**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://plataformaama-plataforma.uc5as5.easypanel.host/
```
Expected: `200`. Conferir log do container sem erro de boot.

- [ ] **Step 3: Disparar o sync da agenda (para trazer as futuras) e conferir**

Via MCP Supabase, após o sync 02h (ou disparar `POST /api/admin/sync-clinicorp` se disponível):
```sql
select count(*) filter (where appointment_date >= current_date and not deleted) as futuras from agenda_appointments;
```
Expected: `futuras > 0` (o pré-requisito da Task 2 funcionando).

- [ ] **Step 4: Conferir a primeira varredura**

O cron roda a cada 3h; para não esperar, conferir após a 1ª execução (ou reiniciar o container):
```sql
select status, count(*) from recuperacao_faltas group by status;
select r.status, r.category, r.patient_name, r.telefone, r.lead_id, r.crc_responsavel_id, t.assignee_id, t.titulo
from recuperacao_faltas r left join tasks t on t.id = r.task_id order by r.criada_em desc limit 10;
```
Expected: linhas `aberta` criadas; tarefas com `assignee_id` preenchido (nunca null); etiqueta "Faltou" nos leads reencontrados (`select count(*) from leads where 'Faltou' = any(etiquetas)`).

- [ ] **Step 5: Registrar pendências de validação do Luiz**

Adicionar a `pending_tests.md`: validar logado (a) a coluna "Faltou" do kanban de leads passa a se preencher sozinha; (b) as CRC recebem a tarefa de recuperação (dono certo quando identificável, senão as 3 notificadas); (c) conferir em ~10 dias se o auto-Perdido só encerrou quem realmente não voltou; (d) checar que remarcações (consulta futura) tiram a falta da cadência.

---

## Self-review (feito na escrita)

- **Cobertura do spec:** seção 0 (sync futuras) → Task 2; Componente 1 (tabela) + RPCs → Task 1; Componente 2 (detecção) → Task 1 (RPC) + Task 4 (orquestração); Componente 3 (toques/auto-Perdido) → Task 3 (timing) + Task 4 (execução); Componente 4 (recuperado) → Task 1 (`falta_esta_recuperada`); Componente 5 (notificações) → Task 1 (constraint) + Task 4; Componente 6 (config) → Task 1. Bordas (família via sufixo-8, homônimos, dedup por unique, try/catch por item, sem `.catch` no builder) cobertas.
- **Consistência de nomes:** `detectar_faltas_avaliacao`, `falta_esta_recuperada`, `lead_add_etiqueta`, `recuperacao_faltas`, `toqueDevido`, `podeAutoPerder`, `varrerFaltasAvaliacao` — definidos numa task e consumidos com o mesmo nome nas seguintes.
- **Sem placeholders:** todo step tem SQL/JS completo. Os dois pontos de leitura in-loco (Task 2 reuso de `dateStr`; Task 4 confirmação das assinaturas) têm instrução exata do que confirmar.
- **Simplificação intencional (auto-Perdido):** a checagem de recuperação roda no INÍCIO de cada iteração das abertas e faz `continue` se recuperou. Logo, ao chegar no branch `marco === 10`, a falta comprovadamente NÃO recuperou, o que já implica "sem consulta futura" (uma futura tornaria `falta_esta_recuperada` true). Por isso `temConsultaFutura: false` é passado direto, sem RPC extra. Caso de borda (remarcação surgir exatamente entre a checagem e o D+10) é coberto na varredura seguinte, que marcaria `recuperada` e não reverteria um Perdido — risco aceitável dado o intervalo de 3h e a raridade; o reviewer deve confirmar que um Perdido indevido nesse caso raro é recuperável manualmente (é: a CRC reabre o lead).
