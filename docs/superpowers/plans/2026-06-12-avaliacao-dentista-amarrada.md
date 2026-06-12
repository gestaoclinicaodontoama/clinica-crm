# Avaliação Dentista "amarradinha" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Toda avaliação nasce vinculada a paciente + dentista + data + agendamento; o dentista vê o paciente presente (check-in) e grava sem digitar; o upload de áudio passa a funcionar com erro claro; o Histórico ganha filtros e atribuição manual das avaliações órfãs.

**Architecture:** Vanilla JS frontend (`public/avaliacao-dentista/`) + Express (`server.js`) + Supabase (Postgres). Lógica pura isolada em `lib/avaliacao/*.js` testada com `node:test` (padrão do projeto: `npm test` roda `node --test "lib/**/*.test.js"`). A agenda do dia vem do Clinicorp `/appointment/list` (já usado em `server.js` e `sync/clinicorp-sync.js`). O mapeamento dentista↔Clinicorp fica numa tabela nova. Conversão de áudio via ffmpeg (já presente no projeto para áudio de WhatsApp).

**Tech Stack:** Node.js, Express, Supabase JS, Zod, ffmpeg (child_process), Deepgram (`lib/deepgram.js`), `node:test`.

---

## Contexto do código existente (leia antes de começar)

- **Tabela das avaliações:** `consultas_spin` (NÃO `avaliacoes` — essa é do dashboard comercial). Colunas relevantes hoje: `id` (uuid PK), `dentista_id` (uuid), `paciente_id` (uuid null), `paciente_nome` (text), `paciente_vinculado` (bool), `modo` ('deepgram'|'audio'|'texto'), `started_at`, `ended_at`, `created_at`, `transcript`, `analysis`, `nota_final`, `feedback_ia`, `tipo_tratamento_id`, etc.
- **Endpoints existentes** (`server.js`): `POST /api/avaliacoes` (cria, ~linha 4148), `GET /api/avaliacoes` (lista, ~4220), `GET /api/avaliacoes/:id` (~4295), `PATCH /api/avaliacoes/:id/paciente` (~4366), `PATCH /api/avaliacoes/:id/nome` (~4395), `GET /api/avaliacoes/dentistas` (~3982), `POST /api/avaliacoes/transcrever` (upload, ~3892) + `GET /api/avaliacoes/transcrever/:jobId` (~3917), config admin (~4071/4083).
- **Middlewares:** `requireDentista = requireRole('dentista','admin','mod_avaliacao_dentista')` (~3323), `requireGestor`, `requireDashboardAvaliacao = requireRole('gestor','admin','crc_comercial')` (~3329), `requireModuloAtivo`, `requireAuth`, `requireAdmin`. `loadProfile(req)` retorna `{ roles, name, ... }`.
- **Clinicorp:** `clinicorpGet(apiPath, params)` (~2633) e `DENTISTAS_AVALIACAO` (~2628) com os 2 avaliadores. `/appointment/list?from=&to=` retorna array com `Dentist_PersonId`, `DoctorId`, `Patient_PersonId`, `PatientName`/`Name`, `FromTime`/`fromTime`, `ToTime`, `Date`/`date`, `CheckinTime` (epoch ms), `Deleted`, `id`. `CLINICORP_STATUS_ARRIVED = 5140799724060672`.
- **Frontend copiloto:** `public/js/avaliacao-dentista/copiloto.js` — `renderRoot()` (~800) monta o HTML dentro de `#copiloto-root`; modos via `window._avdMode('deepgram'|'audio'|'texto')`; campo `#avd-paciente-nome`; botão `#avd-btn-iniciar` → `handleIniciar()` (~379); `AvaliacaoApp.currentSession` guarda `{ consultaId, startedAt, mode, transcript, analysis }`. O `POST /api/avaliacoes` é montado no save (procurar onde `paciente_nome:` é enviado, ~685 do copiloto.js).
- **Frontend historico:** `public/js/avaliacao-dentista/historico.js`. **Frontend api helper:** `public/js/avaliacao-dentista/api.js` (`get`, `post`, `patch`...). **main.js** controla abas e roles (`TAB_ROLES`).
- **Migrações:** `supabase/migrations/` timestamp crescente; aplicar via MCP Supabase (project `mtqdpjhhqzvuklnlfpvi`).
- **Deploy:** após `git push`, `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`.

---

## Estrutura de arquivos (criar/modificar)

**Criar:**
- `lib/avaliacao/agenda.js` — `parseAgendaDia(appointments, clinicorpPersonId, hojeISODate)` (lógica pura).
- `lib/avaliacao/agenda.test.js` — testes node:test.
- `lib/avaliacao/audio-format.js` — `detectFormat(contentType, filename)`, `needsConversion(fmt)`, `ffmpegArgsTo16kWav(inputFmt)` (lógica pura).
- `lib/avaliacao/audio-format.test.js` — testes node:test.
- `supabase/migrations/20260612000000_avaliacao_amarracao.sql` — colunas em `consultas_spin` + tabela `dentista_clinicorp_map`.

**Modificar:**
- `server.js` — novos endpoints (mapping, agenda-hoje), mudanças em `POST /api/avaliacoes`, `GET /api/avaliacoes`, upload `/transcrever`, novo `PATCH /api/avaliacoes/:id/atribuir`.
- `public/js/avaliacao-dentista/api.js` — helpers novos se necessário.
- `public/js/avaliacao-dentista/copiloto.js` — cards "paciente presente", amarração no save, upload com paciente/dentista/data.
- `public/js/avaliacao-dentista/historico.js` — colunas Dentista/Paciente/Data, filtros, atribuição de órfãs.
- `public/index.html` — UI admin do mapeamento dentista↔Clinicorp (na área de config do módulo) OU em `public/avaliacao-dentista/`. (Ver Tarefa 4.)

---

## FASE 0 — Investigar o bug do upload (diagnóstico primeiro)

### Task 0: Logging detalhado no upload `/transcrever`

**Files:**
- Modify: `server.js` (rota `POST /api/avaliacoes/transcrever`, ~linha 3892)

- [ ] **Step 1: Adicionar logs de entrada e de erro**

Localizar o handler `app.post('/api/avaliacoes/transcrever', ...)`. Logo após `const buffer = req.body;`, adicionar:

```js
    console.log('[transcrever] upload recebido', JSON.stringify({
      jobId,
      userId: req.user.id,
      contentTypeHeader: req.headers['content-type'] || null,
      xAudioContentType: req.headers['x-audio-content-type'] || null,
      contentTypeUsado: contentType,
      bytes: buffer?.length ?? 0,
    }));
```

No bloco `.catch(e => {` do `transcribeBuffer`, antes do `_transcribeJobs.set(...'error'...)`, adicionar:

```js
        console.error('[transcrever] FALHA Deepgram', JSON.stringify({ jobId, contentType, bytes: buffer?.length ?? 0, erro: e.message }));
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "chore: log detalhado no upload de áudio da avaliação (diagnóstico)"
```

- [ ] **Step 3: Deploy e coleta**

Após push, deploy via curl (ver topo). Pedir ao Luiz para um dentista tentar o upload que falha. Coletar do log do Easypanel as linhas `[transcrever]`. **Resultado esperado:** descobrir `contentTypeUsado`, `bytes` e a mensagem de erro real. Anotar no commit/PR a causa observada (hipótese: `audio/mp4`/`.m4a` rejeitado pelo Deepgram, ou `bytes` zerado por limite de proxy). Esse achado confirma o tratamento da Fase 5.

> **Nota:** As Fases 1–4 e 6 não dependem do resultado da Fase 0. A Fase 5 (conversão ffmpeg) usa o achado para priorizar formatos, mas já cobre os formatos comuns independentemente.

---

## FASE 1 — Schema

### Task 1: Migração — colunas de amarração + tabela de mapeamento

**Files:**
- Create: `supabase/migrations/20260612000000_avaliacao_amarracao.sql`

- [ ] **Step 1: Escrever a migração**

```sql
-- Amarração das avaliações: agendamento + data da consulta + paciente Clinicorp
alter table public.consultas_spin
  add column if not exists clinicorp_appointment_id text,
  add column if not exists clinicorp_patient_id     text,
  add column if not exists data_consulta            date;

comment on column public.consultas_spin.clinicorp_appointment_id is 'id do agendamento no Clinicorp (origem da amarração)';
comment on column public.consultas_spin.data_consulta is 'data real da consulta (≠ created_at, que é quando foi salva)';

create index if not exists idx_consultas_spin_data_consulta on public.consultas_spin (data_consulta);

-- Mapeamento usuário do CRM (dentista) ↔ Dentist_PersonId do Clinicorp
create table if not exists public.dentista_clinicorp_map (
  dentista_id        uuid primary key references auth.users(id) on delete cascade,
  clinicorp_person_id bigint not null,
  nome               text,
  updated_at         timestamptz not null default now(),
  updated_by         uuid
);

comment on table public.dentista_clinicorp_map is 'liga o login do dentista no CRM ao seu Dentist_PersonId no Clinicorp, para puxar a agenda do dia';
```

- [ ] **Step 2: Aplicar via MCP Supabase**

Aplicar com `apply_migration` (project `mtqdpjhhqzvuklnlfpvi`, name `avaliacao_amarracao`). Depois confirmar com `list_migrations` que `20260612000000` aparece, e `list_tables` que `dentista_clinicorp_map` existe com as 5 colunas.

- [ ] **Step 3: Seed dos 2 avaliadores conhecidos (se já tiverem login)**

Descobrir os `dentista_id` (uuid) dos usuários Marcos e Matheus G. via `execute_sql`:

```sql
select id, nome, roles from public.profiles
where roles::text ilike '%dentista%' order by nome;
```

Se Marcos e Matheus aparecerem, inserir o mapeamento (substituir os uuids reais):

```sql
insert into public.dentista_clinicorp_map (dentista_id, clinicorp_person_id, nome) values
  ('<uuid-marcos>',  5757301300985856, 'Marcos - Avaliação'),
  ('<uuid-matheus>', 6576596377468928, 'Matheus G. - Avaliação')
on conflict (dentista_id) do update set clinicorp_person_id = excluded.clinicorp_person_id, nome = excluded.nome;
```

Se não der para identificar com certeza, **pular o seed** — o admin fará pela UI (Tarefa 4). Anotar isso.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260612000000_avaliacao_amarracao.sql
git commit -m "feat: schema de amarração da avaliação (colunas + mapa dentista↔clinicorp)"
```

---

## FASE 2 — Lógica pura da agenda do dia (TDD)

### Task 2: `parseAgendaDia` — filtrar agenda do dentista + flag de presença

**Files:**
- Create: `lib/avaliacao/agenda.js`
- Test: `lib/avaliacao/agenda.test.js`

- [ ] **Step 1: Escrever o teste falhando**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseAgendaDia } = require('./agenda');

const PERSON = 5757301300985856;

test('filtra só os agendamentos do dentista informado', () => {
  const appts = [
    { id: '1', Dentist_PersonId: PERSON, PatientName: 'Ana',  Patient_PersonId: 'p1', fromTime: '08:00', toTime: '08:30' },
    { id: '2', Dentist_PersonId: 999,    PatientName: 'Beto', Patient_PersonId: 'p2', fromTime: '09:00', toTime: '09:30' },
  ];
  const out = parseAgendaDia(appts, PERSON, '2026-06-12');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].paciente_nome, 'Ana');
  assert.strictEqual(out[0].appointment_id, '1');
});

test('aceita match por DoctorId quando Dentist_PersonId ausente', () => {
  const appts = [{ id: '3', DoctorId: PERSON, Name: 'Caio', fromTime: '10:00', toTime: '10:30' }];
  const out = parseAgendaDia(appts, PERSON, '2026-06-12');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].paciente_nome, 'Caio');
});

test('marca presente quando há CheckinTime', () => {
  const appts = [
    { id: '4', Dentist_PersonId: PERSON, PatientName: 'Dora', fromTime: '08:00', toTime: '08:30', CheckinTime: 1749700000000 },
    { id: '5', Dentist_PersonId: PERSON, PatientName: 'Eva',  fromTime: '09:00', toTime: '09:30' },
  ];
  const out = parseAgendaDia(appts, PERSON, '2026-06-12');
  const dora = out.find(o => o.paciente_nome === 'Dora');
  const eva  = out.find(o => o.paciente_nome === 'Eva');
  assert.strictEqual(dora.presente, true);
  assert.strictEqual(eva.presente, false);
});

test('ignora agendamentos deletados', () => {
  const appts = [{ id: '6', Dentist_PersonId: PERSON, PatientName: 'Fred', fromTime: '08:00', toTime: '08:30', Deleted: true }];
  assert.strictEqual(parseAgendaDia(appts, PERSON, '2026-06-12').length, 0);
});

test('ordena presentes primeiro, depois por horário', () => {
  const appts = [
    { id: '7', Dentist_PersonId: PERSON, PatientName: 'Gil',  fromTime: '11:00', toTime: '11:30' },
    { id: '8', Dentist_PersonId: PERSON, PatientName: 'Hugo', fromTime: '08:00', toTime: '08:30', CheckinTime: 1749700000000 },
    { id: '9', Dentist_PersonId: PERSON, PatientName: 'Ivo',  fromTime: '09:00', toTime: '09:30' },
  ];
  const out = parseAgendaDia(appts, PERSON, '2026-06-12');
  assert.deepStrictEqual(out.map(o => o.paciente_nome), ['Hugo', 'Ivo', 'Gil']);
});

test('aceita string ou number como clinicorpPersonId', () => {
  const appts = [{ id: '10', Dentist_PersonId: PERSON, PatientName: 'Ana', fromTime: '08:00', toTime: '08:30' }];
  assert.strictEqual(parseAgendaDia(appts, String(PERSON), '2026-06-12').length, 1);
});

test('lista vazia ou null retorna []', () => {
  assert.deepStrictEqual(parseAgendaDia(null, PERSON, '2026-06-12'), []);
  assert.deepStrictEqual(parseAgendaDia([], PERSON, '2026-06-12'), []);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — `Cannot find module './agenda'`.

- [ ] **Step 3: Implementar**

```js
// lib/avaliacao/agenda.js
// Lógica pura: dado o array de /appointment/list do Clinicorp, filtra os
// agendamentos de um dentista num dia e normaliza para a agenda do copiloto.

function parseAgendaDia(appointments, clinicorpPersonId, _hojeISODate) {
  if (!Array.isArray(appointments)) return [];
  const alvo = String(clinicorpPersonId);

  const itens = appointments
    .filter(a => a && !a.Deleted)
    .filter(a => String(a.Dentist_PersonId) === alvo || String(a.DoctorId) === alvo)
    .map(a => {
      const fromTime = a.FromTime || a.fromTime || '';
      const toTime   = a.ToTime   || a.toTime   || '';
      return {
        appointment_id:      a.id != null ? String(a.id) : null,
        clinicorp_patient_id: a.Patient_PersonId != null ? String(a.Patient_PersonId) : null,
        paciente_nome:       a.PatientName || a.Name || 'Paciente sem nome',
        from_time:           fromTime,
        to_time:             toTime,
        presente:            !!a.CheckinTime,
      };
    });

  // presentes primeiro; dentro de cada grupo, por horário de início
  itens.sort((x, y) => {
    if (x.presente !== y.presente) return x.presente ? -1 : 1;
    return String(x.from_time).localeCompare(String(y.from_time));
  });

  return itens;
}

module.exports = { parseAgendaDia };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS (todos os testes de `agenda.test.js`).

- [ ] **Step 5: Commit**

```bash
git add lib/avaliacao/agenda.js lib/avaliacao/agenda.test.js
git commit -m "feat: parseAgendaDia — agenda do dia do dentista com flag de presença"
```

---

## FASE 3 — Mapeamento dentista↔Clinicorp (backend + UI admin)

### Task 3: Endpoints de mapeamento dentista↔Clinicorp

**Files:**
- Modify: `server.js` (adicionar perto dos outros endpoints `/api/avaliacoes/*`, ex. após `GET /api/avaliacoes/dentistas` ~linha 3991)

- [ ] **Step 1: Adicionar GET (listar mapeamentos + dentistas disponíveis)**

```js
// ── Mapeamento dentista CRM ↔ Dentist_PersonId Clinicorp ───────────────────
app.get('/api/avaliacoes/dentista-map', requireAuth, requireGestor, async (req, res) => {
  try {
    const [{ data: maps }, { data: dentistas }] = await Promise.all([
      supabase.from('dentista_clinicorp_map').select('dentista_id, clinicorp_person_id, nome, updated_at'),
      supabase.from('profiles').select('id, nome').filter('roles', 'cs', '{dentista}').order('nome'),
    ]);
    res.json({
      maps: maps || [],
      dentistas: dentistas || [],
      avaliadores_conhecidos: DENTISTAS_AVALIACAO, // ajuda o admin a escolher o id certo
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Adicionar PUT (definir/atualizar um mapeamento — só admin)**

```js
app.put('/api/avaliacoes/dentista-map/:dentista_id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { dentista_id } = req.params;
    if (!UUID_V4_RE.test(dentista_id)) return res.status(400).json({ error: 'dentista_id deve ser um UUID v4 válido' });
    const personId = parseInt(req.body?.clinicorp_person_id, 10);
    if (isNaN(personId) || personId <= 0) return res.status(400).json({ error: 'clinicorp_person_id deve ser um inteiro positivo' });
    const nome = req.body?.nome ? String(req.body.nome).slice(0, 120) : null;
    const { error } = await supabase.from('dentista_clinicorp_map').upsert({
      dentista_id, clinicorp_person_id: personId, nome,
      updated_at: new Date().toISOString(), updated_by: req.user.id,
    }, { onConflict: 'dentista_id' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 3: Adicionar DELETE (remover mapeamento — só admin)**

```js
app.delete('/api/avaliacoes/dentista-map/:dentista_id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { dentista_id } = req.params;
    if (!UUID_V4_RE.test(dentista_id)) return res.status(400).json({ error: 'dentista_id deve ser um UUID v4 válido' });
    const { error } = await supabase.from('dentista_clinicorp_map').delete().eq('dentista_id', dentista_id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 4: Verificar manualmente**

Run: `node -e "require('./server.js')"` não é viável (sobe o servidor). Em vez disso, validar sintaxe: `node --check server.js`
Expected: sem saída (sintaxe OK).

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: endpoints de mapeamento dentista↔clinicorp (GET/PUT/DELETE)"
```

### Task 4: UI admin do mapeamento (na config do módulo)

**Files:**
- Modify: `public/avaliacao-dentista/index.html` (ou a aba de config existente do módulo) e `public/js/avaliacao-dentista/api.js` se faltar helper.

> **Contexto:** O módulo já tem config admin via `GET/PATCH /api/avaliacoes/config/admin`. A UI de config vive na aba acessível a gestor/admin. Localizar onde essa config é renderizada (procurar `config/admin` em `public/js/avaliacao-dentista/`). Se não houver uma aba de config no frontend separado, adicionar a seção de mapeamento num bloco visível só para admin dentro do `index.html` do módulo.

- [ ] **Step 1: Adicionar seção HTML de mapeamento**

Em `public/avaliacao-dentista/index.html`, dentro de um container visível a admin (ex. perto do banner de módulo), adicionar:

```html
<section id="avd-map-section" hidden style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:18px;margin:14px 0">
  <h3 style="margin:0 0 6px;font-size:15px">Vínculo Dentista → Clinicorp</h3>
  <p style="font-size:12px;color:var(--muted);margin:0 0 12px">Liga o login de cada dentista ao código dele no Clinicorp, para puxar a agenda do dia (paciente presente).</p>
  <div id="avd-map-list"></div>
</section>
```

- [ ] **Step 2: Renderizar e salvar (JS)**

Criar `public/js/avaliacao-dentista/dentista-map.js`:

```js
import { get, put, del } from './api.js';
import { showToast } from './ui.js';

export async function initDentistaMap() {
  const section = document.getElementById('avd-map-section');
  if (!section) return;
  section.hidden = false;
  await render();
}

async function render() {
  const list = document.getElementById('avd-map-list');
  list.innerHTML = 'Carregando...';
  let payload;
  try { payload = await get('/api/avaliacoes/dentista-map'); }
  catch (e) { list.innerHTML = `<span style="color:var(--red)">Erro: ${e.message}</span>`; return; }

  const mapBy = Object.fromEntries((payload.maps || []).map(m => [m.dentista_id, m]));
  const conhecidos = payload.avaliadores_conhecidos || [];

  list.innerHTML = (payload.dentistas || []).map(d => {
    const atual = mapBy[d.id];
    const opts = conhecidos.map(c =>
      `<option value="${c.id}" ${atual && String(atual.clinicorp_person_id) === String(c.id) ? 'selected' : ''}>${c.nome} (${c.id})</option>`
    ).join('');
    return `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <span style="min-width:180px;font-size:13px">${d.nome || d.id}</span>
        <select data-dentista="${d.id}" style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text);font-size:13px">
          <option value="">— não vinculado —</option>
          ${opts}
        </select>
        <button data-save="${d.id}" style="padding:6px 14px;border-radius:8px;background:var(--accent);color:#fff;border:none;font-size:12px;cursor:pointer">Salvar</button>
      </div>`;
  }).join('') || '<span style="color:var(--muted)">Nenhum dentista cadastrado.</span>';

  list.querySelectorAll('[data-save]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.save;
      const sel = list.querySelector(`select[data-dentista="${id}"]`);
      const personId = sel.value;
      try {
        if (!personId) { await del(`/api/avaliacoes/dentista-map/${id}`); showToast('Vínculo removido.', 'info'); }
        else {
          const nome = sel.options[sel.selectedIndex].text;
          await put(`/api/avaliacoes/dentista-map/${id}`, { clinicorp_person_id: personId, nome });
          showToast('Vínculo salvo.', 'success');
        }
      } catch (e) { showToast('Erro: ' + e.message, 'error'); }
    });
  });
}
```

- [ ] **Step 3: Garantir helpers `put` e `del` em `api.js`**

Abrir `public/js/avaliacao-dentista/api.js`. Se não existirem `put`/`del`, adicioná-los seguindo o padrão de `post`/`patch` já presentes (mesma assinatura: método HTTP + token Supabase no header). Exportá-los.

- [ ] **Step 4: Chamar `initDentistaMap()` quando admin abrir o módulo**

Em `public/js/avaliacao-dentista/main.js`, no `boot()` após carregar o usuário, se `roles` inclui `admin`, importar e chamar:

```js
if ((AvaliacaoApp.user?.roles ?? []).includes('admin')) {
  import('./dentista-map.js').then(m => m.initDentistaMap()).catch(() => {});
}
```

- [ ] **Step 5: Incluir o script no index.html**

Garantir que `index.html` do módulo carrega `main.js` como módulo (já carrega). O import dinâmico cobre o resto. Verificar no navegador.

- [ ] **Step 6: Verificação manual**

Logar como admin → abrir `/avaliacao-dentista/` → a seção "Vínculo Dentista → Clinicorp" aparece, lista os dentistas, permite escolher o avaliador e Salvar. Recarregar: seleção persiste. Logar como dentista comum: seção NÃO aparece.

- [ ] **Step 7: Commit**

```bash
git add public/avaliacao-dentista/index.html public/js/avaliacao-dentista/dentista-map.js public/js/avaliacao-dentista/api.js public/js/avaliacao-dentista/main.js
git commit -m "feat: UI admin para vincular dentista ao código Clinicorp"
```

---

## FASE 4 — Agenda do dia "paciente presente" (endpoint + cards)

### Task 5: Endpoint `GET /api/avaliacoes/agenda-hoje`

**Files:**
- Modify: `server.js` (após os endpoints de mapeamento)

- [ ] **Step 1: Implementar o endpoint**

```js
// ── Agenda do dia do dentista (paciente presente) ──────────────────────────
app.get('/api/avaliacoes/agenda-hoje', requireAuth, requireDentista, requireModuloAtivo, rateLimit, async (req, res) => {
  try {
    const { parseAgendaDia } = require('./lib/avaliacao/agenda');
    const p = await loadProfile(req);
    const isGestor = (p.roles || []).some(r => ['gestor', 'admin'].includes(r));

    // dentista alvo: o próprio, ou ?dentista_id= quando gestor/admin sobe áudio por outro
    let alvoDentistaId = req.user.id;
    if (isGestor && req.query.dentista_id) {
      if (!UUID_V4_RE.test(req.query.dentista_id)) return res.status(400).json({ error: 'dentista_id inválido' });
      alvoDentistaId = req.query.dentista_id;
    }

    const { data: map } = await supabase.from('dentista_clinicorp_map')
      .select('clinicorp_person_id').eq('dentista_id', alvoDentistaId).maybeSingle();
    if (!map) return res.status(409).json({ error: 'sem_vinculo', mensagem: 'Dentista sem vínculo com o Clinicorp. Peça ao admin para configurar.' });

    // data: hoje em America/Sao_Paulo, ou ?data=YYYY-MM-DD (gestor sobe retroativo)
    let dia = req.query.data;
    if (dia) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return res.status(400).json({ error: 'data deve ser YYYY-MM-DD' });
    } else {
      dia = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); // UTC-3
    }
    const to = new Date(dia + 'T00:00:00Z'); to.setUTCDate(to.getUTCDate() + 1);
    const toStr = to.toISOString().slice(0, 10);

    const r = await clinicorpGet('/appointment/list', { from: dia, to: toStr });
    const appts = Array.isArray(r.data) ? r.data : (Array.isArray(r) ? r : []);
    const agenda = parseAgendaDia(appts, map.clinicorp_person_id, dia);
    res.json({ data: dia, agenda });
  } catch (e) {
    console.error('[agenda-hoje]', e);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem saída.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: endpoint agenda-hoje (paciente presente via Clinicorp)"
```

### Task 6: Cards "paciente presente" no copiloto

**Files:**
- Modify: `public/js/avaliacao-dentista/copiloto.js`

> **Objetivo:** No topo do copiloto, acima do campo "Nome do paciente", renderizar a agenda do dia. Cada card mostra nome + horário + selo "🟢 Presente" quando aplicável, e um botão "Iniciar consulta". Ao clicar, preenche `AvaliacaoApp.currentPaciente = { nome, clinicorp_patient_id, clinicorp_appointment_id, data_consulta }`, escreve o nome no `#avd-paciente-nome` e chama o fluxo de iniciar.

- [ ] **Step 1: Adicionar o container da agenda no `renderRoot()`**

Em `renderRoot()` (~800), logo antes do bloco `<div style="margin-bottom:16px"> ... Modo de entrada ...`, inserir:

```js
`<div id="avd-agenda" style="margin-bottom:16px"></div>` +
```

(adaptar à concatenação da template string — inserir o `<div id="avd-agenda">` como primeiro filho do `root.innerHTML`).

- [ ] **Step 2: Função que carrega e renderiza a agenda**

Adicionar em `copiloto.js`:

```js
async function carregarAgendaHoje() {
  const box = document.getElementById('avd-agenda');
  if (!box) return;
  box.innerHTML = '<div style="font-size:12px;color:var(--muted)">Carregando agenda do dia…</div>';
  try {
    const r = await get('/api/avaliacoes/agenda-hoje');
    renderAgenda(r.agenda || []);
  } catch (e) {
    if (e.status === 409 || /sem_vinculo/.test(e.message)) {
      box.innerHTML = '<div style="font-size:12px;color:var(--muted)">Agenda indisponível (dentista sem vínculo com o Clinicorp). Você pode digitar o nome do paciente abaixo.</div>';
    } else {
      box.innerHTML = `<div style="font-size:12px;color:var(--muted)">Não foi possível carregar a agenda. <button onclick="window._avdAgendaReload()" style="background:none;border:none;color:var(--accent);cursor:pointer;text-decoration:underline">tentar de novo</button></div>`;
    }
  }
}

function renderAgenda(itens) {
  const box = document.getElementById('avd-agenda');
  if (!box) return;
  const header = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
    <span style="font-size:12px;color:var(--muted)">Agenda de hoje</span>
    <button onclick="window._avdAgendaReload()" style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:4px 10px;color:var(--muted);font-size:11px;cursor:pointer">↻ Atualizar</button>
  </div>`;
  if (!itens.length) {
    box.innerHTML = header + '<div style="font-size:12px;color:var(--muted)">Nenhum paciente na agenda de hoje.</div>';
    return;
  }
  const cards = itens.map((it, i) => `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;border-radius:10px;border:1px solid ${it.presente ? 'rgba(34,197,94,.4)' : 'var(--border)'};background:${it.presente ? 'rgba(34,197,94,.08)' : 'var(--bg3)'};margin-bottom:6px">
      <div>
        <div style="font-size:13.5px;font-weight:600">${it.presente ? '🟢 ' : ''}${escapeHtml(it.paciente_nome)}</div>
        <div style="font-size:11px;color:var(--muted)">${escapeHtml(it.from_time || '')}${it.to_time ? '–' + escapeHtml(it.to_time) : ''}${it.presente ? ' · Presente' : ''}</div>
      </div>
      <button onclick="window._avdIniciarPaciente(${i})" style="padding:7px 14px;border-radius:8px;background:var(--accent);color:#fff;border:none;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">Iniciar consulta</button>
    </div>`).join('');
  box.innerHTML = header + cards;
  window.__avdAgenda = itens; // para o handler do botão
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function iniciarComPaciente(idx) {
  const it = (window.__avdAgenda || [])[idx];
  if (!it) return;
  AvaliacaoApp.currentPaciente = {
    nome: it.paciente_nome,
    clinicorp_patient_id: it.clinicorp_patient_id,
    clinicorp_appointment_id: it.appointment_id,
    data_consulta: new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10),
  };
  const input = document.getElementById('avd-paciente-nome');
  if (input) input.value = it.paciente_nome;
  handleIniciar();
}
```

- [ ] **Step 3: Expor handlers e chamar no init**

No `renderRoot()`, junto de `window._avdIniciar = handleIniciar;`, adicionar:

```js
  window._avdIniciarPaciente = iniciarComPaciente;
  window._avdAgendaReload = carregarAgendaHoje;
```

No `init()` do copiloto (export que `main.js` chama), após `renderRoot()`, adicionar `carregarAgendaHoje();`. Garantir que `get` está importado de `./api.js` no topo do arquivo (provavelmente já está).

- [ ] **Step 4: Limpar `currentPaciente` no `_avdLimpar`**

No `window._avdLimpar` (~872), adicionar `AvaliacaoApp.currentPaciente = null;`.

- [ ] **Step 5: Verificação manual**

Logar como dentista vinculado → abrir copiloto → agenda do dia aparece; paciente com check-in mostra 🟢 Presente no topo. Clicar "Iniciar consulta" preenche o nome e começa a sessão. "↻ Atualizar" recarrega. Dentista sem vínculo: mensagem amigável, campo de nome manual continua funcionando.

- [ ] **Step 6: Commit**

```bash
git add public/js/avaliacao-dentista/copiloto.js
git commit -m "feat: cards de paciente presente no copiloto (iniciar consulta amarrado)"
```

### Task 7: Amarrar paciente/agendamento/data no save (`POST /api/avaliacoes`)

**Files:**
- Modify: `server.js` (`POST /api/avaliacoes`, ~4148)
- Modify: `public/js/avaliacao-dentista/copiloto.js` (montagem do payload de save, ~685)

- [ ] **Step 1: Backend — aceitar e gravar os novos campos**

No destructuring do `req.body` no `POST /api/avaliacoes`, adicionar `clinicorp_appointment_id, clinicorp_patient_id, data_consulta` à lista. No objeto `row` (após `paciente_vinculado: !!paciente_vinculado,`), adicionar:

```js
      clinicorp_appointment_id: clinicorp_appointment_id ? String(clinicorp_appointment_id).slice(0, 64) : null,
      clinicorp_patient_id:     clinicorp_patient_id ? String(clinicorp_patient_id).slice(0, 64) : null,
      data_consulta:            (data_consulta && /^\d{4}-\d{2}-\d{2}$/.test(data_consulta)) ? data_consulta : null,
```

Além disso, permitir que **gestor/admin** gravem em nome de outro dentista. Logo após a validação de `id`, adicionar:

```js
    // Gestor/admin pode salvar avaliação em nome de outro dentista (upload retroativo)
    let dentistaIdFinal = req.user.id;
    if (req.body.dentista_id && req.body.dentista_id !== req.user.id) {
      const pp = await loadProfile(req);
      const isGestor = (pp.roles || []).some(r => ['gestor', 'admin'].includes(r));
      if (isGestor) {
        if (!UUID_V4_RE.test(req.body.dentista_id)) return res.status(400).json({ error: 'dentista_id inválido' });
        dentistaIdFinal = req.body.dentista_id;
      }
    }
```

E trocar, no `row`, `dentista_id: req.user.id` por `dentista_id: dentistaIdFinal`.

> **Nota sobre o fallback do upsert:** logo abaixo há um bloco `if (!consulta) { ... .eq('dentista_id', req.user.id) ... }`. Trocar esse `req.user.id` por `dentistaIdFinal` para o fallback funcionar quando o gestor salva por outro.

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem saída.

- [ ] **Step 3: Frontend — enviar os campos no save**

Em `copiloto.js`, no objeto enviado ao `POST /api/avaliacoes` (onde está `paciente_nome: ...`), adicionar:

```js
    clinicorp_appointment_id: AvaliacaoApp.currentPaciente?.clinicorp_appointment_id || null,
    clinicorp_patient_id:     AvaliacaoApp.currentPaciente?.clinicorp_patient_id || null,
    data_consulta:            AvaliacaoApp.currentPaciente?.data_consulta || new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10),
```

- [ ] **Step 4: Verificação manual**

Iniciar consulta por um card de paciente presente, finalizar e analisar, salvar. Conferir no Supabase (`execute_sql`) que a linha em `consultas_spin` tem `clinicorp_appointment_id`, `clinicorp_patient_id`, `data_consulta` e `dentista_id` corretos:

```sql
select id, dentista_id, paciente_nome, clinicorp_appointment_id, clinicorp_patient_id, data_consulta, created_at
from public.consultas_spin order by created_at desc limit 3;
```

- [ ] **Step 5: Commit**

```bash
git add server.js public/js/avaliacao-dentista/copiloto.js
git commit -m "feat: amarrar agendamento/paciente/data no save da avaliação (+ gestor por outro dentista)"
```

---

## FASE 5 — Upload consertado (plano B)

### Task 8: `audio-format` — detectar formato e decidir conversão (TDD)

**Files:**
- Create: `lib/avaliacao/audio-format.js`
- Test: `lib/avaliacao/audio-format.test.js`

- [ ] **Step 1: Teste falhando**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { detectFormat, needsConversion, ffmpegArgsTo16kWav } = require('./audio-format');

test('detecta m4a por content-type', () => {
  assert.strictEqual(detectFormat('audio/mp4', null), 'm4a');
  assert.strictEqual(detectFormat('audio/x-m4a', null), 'm4a');
});

test('detecta por extensão quando content-type genérico', () => {
  assert.strictEqual(detectFormat('application/octet-stream', 'consulta.m4a'), 'm4a');
  assert.strictEqual(detectFormat('application/octet-stream', 'gravacao.OPUS'), 'opus');
});

test('formatos já aceitos pelo Deepgram não precisam converter', () => {
  assert.strictEqual(needsConversion('mp3'), false);
  assert.strictEqual(needsConversion('wav'), false);
});

test('formatos problemáticos precisam converter', () => {
  assert.strictEqual(needsConversion('m4a'), true);
  assert.strictEqual(needsConversion('opus'), true);
  assert.strictEqual(needsConversion('amr'), true);
});

test('desconhecido converte por segurança', () => {
  assert.strictEqual(detectFormat('application/octet-stream', 'x.bin'), 'desconhecido');
  assert.strictEqual(needsConversion('desconhecido'), true);
});

test('ffmpegArgs gera args de stdin→stdout wav 16k mono', () => {
  const args = ffmpegArgsTo16kWav('m4a');
  assert.ok(args.includes('-i') && args.includes('pipe:0'));
  assert.ok(args.includes('pipe:1'));
  assert.ok(args.includes('16000'));
  assert.ok(args.includes('1')); // mono
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — `Cannot find module './audio-format'`.

- [ ] **Step 3: Implementar**

```js
// lib/avaliacao/audio-format.js
// Decide o formato do áudio enviado e se precisa de conversão para um formato
// que o Deepgram aceita com folga (WAV PCM 16k mono).

const CT_MAP = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'm4a',
  'audio/ogg': 'opus', 'audio/opus': 'opus',
  'audio/amr': 'amr', 'audio/3gpp': 'amr',
  'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/webm': 'webm', 'video/webm': 'webm', 'video/mp4': 'm4a',
};

const EXT_MAP = {
  mp3: 'mp3', wav: 'wav', m4a: 'm4a', aac: 'm4a', mp4: 'm4a',
  ogg: 'opus', opus: 'opus', amr: 'amr', flac: 'flac', webm: 'webm',
};

// Deepgram lida bem com estes; o resto convertemos.
const ACEITOS_SEM_CONVERSAO = new Set(['mp3', 'wav', 'flac']);

function detectFormat(contentType, filename) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (CT_MAP[ct]) return CT_MAP[ct];
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (EXT_MAP[ext]) return EXT_MAP[ext];
  return 'desconhecido';
}

function needsConversion(fmt) {
  return !ACEITOS_SEM_CONVERSAO.has(fmt);
}

function ffmpegArgsTo16kWav(_inputFmt) {
  // lê de stdin (pipe:0), escreve WAV PCM 16k mono em stdout (pipe:1)
  return ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1'];
}

module.exports = { detectFormat, needsConversion, ffmpegArgsTo16kWav };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/avaliacao/audio-format.js lib/avaliacao/audio-format.test.js
git commit -m "feat: detecção de formato de áudio + decisão de conversão (TDD)"
```

### Task 9: Conversão ffmpeg no upload `/transcrever`

**Files:**
- Modify: `server.js` (rota `POST /api/avaliacoes/transcrever`, ~3892)

> **Pré-requisito (confirmado):** ffmpeg JÁ está no container (`Dockerfile:2` → `apk add ffmpeg`) e já é usado em `server.js:39` via `spawn('ffmpeg', ...)`. O `spawn` JÁ está importado no topo (`server.js:11` → `const { execSync, spawn } = require('child_process');`). **NÃO** re-declarar `spawn` nem re-`require('child_process')` — usar o que já existe.

- [ ] **Step 1: Adicionar helper de conversão**

Perto do topo do handler de upload (antes de `app.post('/api/avaliacoes/transcrever'`), adicionar (sem re-importar `spawn` — já está no topo do arquivo):

```js
function converterParaWav16k(buffer, inputFmt) {
  const { ffmpegArgsTo16kWav } = require('./lib/avaliacao/audio-format');
  return new Promise((resolve, reject) => {
    const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ffmpegArgsTo16kWav(inputFmt));
    const out = []; let err = '';
    ff.stdout.on('data', d => out.push(d));
    ff.stderr.on('data', d => { err += d.toString(); });
    ff.on('error', e => reject(new Error('ffmpeg indisponível: ' + e.message)));
    ff.on('close', code => code === 0
      ? resolve(Buffer.concat(out))
      : reject(new Error('ffmpeg falhou (' + code + '): ' + err.slice(0, 300))));
    ff.stdin.on('error', () => {}); // evita EPIPE se ffmpeg fechar cedo
    ff.stdin.write(buffer); ff.stdin.end();
  });
}
```

- [ ] **Step 2: Usar detecção + conversão antes de chamar o Deepgram**

Dentro do handler, substituir o trecho que monta `contentType`/`buffer` e dispara `transcribeBuffer` por:

```js
    const { detectFormat, needsConversion } = require('./lib/avaliacao/audio-format');
    const buffer = req.body;
    const filename = req.headers['x-audio-filename'] || '';
    const rawCt = (req.headers['x-audio-content-type'] || req.headers['content-type'] || '').split(';')[0].trim();
    const fmt = detectFormat(rawCt, filename);

    console.log('[transcrever] upload recebido', JSON.stringify({ jobId, userId: req.user.id, rawCt, filename, fmt, bytes: buffer?.length ?? 0 }));

    if (!buffer || buffer.length === 0) {
      _transcribeJobs.set(jobId, { status: 'error', result: null, error: 'Arquivo vazio ou não recebido.', userId: req.user.id });
      return; // jobId já respondido abaixo
    }

    _transcribeJobs.set(jobId, { status: 'pending', result: null, error: null, userId: req.user.id });
    res.json({ jobId });

    (async () => {
      try {
        let bufFinal = buffer;
        let ctFinal = rawCt || 'audio/mpeg';
        if (needsConversion(fmt)) {
          console.log('[transcrever] convertendo', JSON.stringify({ jobId, fmt }));
          bufFinal = await converterParaWav16k(buffer, fmt);
          ctFinal = 'audio/wav';
        }
        const dgResult = await deepgramLib().transcribeBuffer(bufFinal, ctFinal);
        const words = dgResult?.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
        _transcribeJobs.set(jobId, { status: 'done', result: { words }, error: null, userId: req.user.id });
      } catch (e) {
        console.error('[transcrever] FALHA', JSON.stringify({ jobId, fmt, bytes: buffer?.length ?? 0, erro: e.message }));
        const amigavel = /ffmpeg/.test(e.message)
          ? 'Não consegui converter este áudio. Tente enviar em MP3 ou WAV.'
          : 'Falha ao transcrever o áudio: ' + e.message;
        _transcribeJobs.set(jobId, { status: 'error', result: null, error: amigavel, userId: req.user.id });
      }
    })();

    setTimeout(() => _transcribeJobs.delete(jobId), 15 * 60 * 1000);
    return;
```

> Remover o bloco antigo `_transcribeJobs.set(...pending...); res.json({ jobId }); deepgramLib().transcribeBuffer(...).then(...).catch(...)` e o `setTimeout` duplicado — o código acima substitui tudo. Garantir que `express.raw({ type: '*/*', limit: '300mb' })` continua no middleware da rota.

- [ ] **Step 3: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem saída.

- [ ] **Step 4: Verificação manual (ANTES de depender disso, rodar local)**

Se possível localmente: subir o servidor, enviar um `.m4a` real de 30–60 min pelo modo "Upload de áudio". Esperado: status vira `done`, transcrição aparece. Se ffmpeg não estiver no container, o erro amigável "Tente enviar em MP3 ou WAV" aparece (e o log mostra "ffmpeg indisponível") — nesse caso, instalar ffmpeg no Dockerfile/imagem do CRM antes de seguir.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: upload de áudio converte m4a/opus via ffmpeg + erro claro"
```

### Task 10: Frontend do upload — enviar filename, paciente, dentista e data

**Files:**
- Modify: `public/js/avaliacao-dentista/copiloto.js`

> **Objetivo:** No modo "Upload de áudio", (1) enviar o header `x-audio-filename` com o nome do arquivo; (2) exigir paciente (da agenda do dia ou nome manual); (3) para gestor/admin, permitir escolher dentista e data da consulta antes de subir, e usar a agenda daquele dentista/dia.

- [ ] **Step 1: Enviar filename no upload**

Localizar onde o arquivo é enviado a `/api/avaliacoes/transcrever` (procurar `transcrever` em copiloto.js). No fetch, adicionar ao `headers`:

```js
        'x-audio-filename': (file?.name || '').slice(0, 120),
        'x-audio-content-type': file?.type || 'application/octet-stream',
```

- [ ] **Step 2: Painel de amarração para gestor/admin no modo upload**

No `#avd-pane-audio` (HTML em `renderRoot()`, ~841), abaixo do `<input type="file">`, adicionar um bloco que só aparece para gestor/admin:

```html
<div id="avd-upload-amarra" style="display:none;margin-top:12px;border-top:1px solid var(--border);padding-top:12px">
  <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Esta avaliação é de qual dentista / dia?</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <select id="avd-upload-dentista" style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text);font-size:13px"></select>
    <input type="date" id="avd-upload-data" style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text);font-size:13px">
    <button onclick="window._avdUploadCarregarAgenda()" style="padding:7px 12px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);color:var(--muted);font-size:12px;cursor:pointer">Ver agenda</button>
  </div>
  <select id="avd-upload-paciente" style="margin-top:8px;display:none;width:100%;max-width:360px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text);font-size:13px"></select>
</div>
```

- [ ] **Step 3: Popular dentistas e carregar agenda do dia escolhido**

Adicionar em copiloto.js:

```js
async function setupUploadAmarra() {
  const roles = AvaliacaoApp.user?.roles ?? [];
  const isGestor = roles.some(r => ['gestor', 'admin'].includes(r));
  const box = document.getElementById('avd-upload-amarra');
  if (!box || !isGestor) return;
  box.style.display = 'block';
  const sel = document.getElementById('avd-upload-dentista');
  const dt = document.getElementById('avd-upload-data');
  if (dt && !dt.value) dt.value = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  try {
    const r = await get('/api/avaliacoes/dentistas'); // [{id, nome}]
    sel.innerHTML = '<option value="">— escolha o dentista —</option>' +
      (r || []).map(d => `<option value="${d.id}">${escapeHtml(d.nome || d.id)}</option>`).join('');
  } catch { /* silencioso */ }
  window._avdUploadCarregarAgenda = uploadCarregarAgenda;
}

async function uploadCarregarAgenda() {
  const dentistaId = document.getElementById('avd-upload-dentista')?.value;
  const data = document.getElementById('avd-upload-data')?.value;
  const selPac = document.getElementById('avd-upload-paciente');
  if (!dentistaId || !data) { showToast('Escolha dentista e data.', 'warning'); return; }
  try {
    const r = await get(`/api/avaliacoes/agenda-hoje?dentista_id=${dentistaId}&data=${data}`);
    const itens = r.agenda || [];
    selPac.style.display = 'block';
    selPac.innerHTML = '<option value="">— paciente (ou deixe em branco p/ nome manual) —</option>' +
      itens.map((it, i) => `<option value="${i}">${it.presente ? '🟢 ' : ''}${escapeHtml(it.paciente_nome)} ${escapeHtml(it.from_time || '')}</option>`).join('');
    window.__avdUploadAgenda = itens;
    selPac.onchange = () => {
      const it = (window.__avdUploadAgenda || [])[selPac.value];
      AvaliacaoApp.currentPaciente = it ? {
        nome: it.paciente_nome, clinicorp_patient_id: it.clinicorp_patient_id,
        clinicorp_appointment_id: it.appointment_id, data_consulta: data,
      } : { data_consulta: data };
      const input = document.getElementById('avd-paciente-nome');
      if (input && it) input.value = it.paciente_nome;
    };
  } catch (e) {
    if (e.status === 409) showToast('Esse dentista não tem vínculo com o Clinicorp.', 'warning');
    else showToast('Erro ao carregar agenda: ' + e.message, 'error');
  }
}
```

- [ ] **Step 4: Enviar dentista_id e data no save do upload**

No save (`POST /api/avaliacoes`) do copiloto, garantir que o payload inclui, além dos campos da Task 7:

```js
    dentista_id: AvaliacaoApp.currentUploadDentistaId || undefined, // setado no modo upload por gestor
```

E em `uploadCarregarAgenda`, ao escolher dentista, setar `AvaliacaoApp.currentUploadDentistaId = dentistaId;`. Para o fluxo normal (dentista gravando ao vivo), `currentUploadDentistaId` fica indefinido e o backend usa `req.user.id`.

- [ ] **Step 5: Chamar `setupUploadAmarra()` ao trocar para o modo upload**

Na função `switchMode(mode)` do copiloto, quando `mode === 'audio'`, chamar `setupUploadAmarra();`.

- [ ] **Step 6: Verificação manual**

Como gestor: modo "Upload de áudio" → bloco de amarração aparece → escolher dentista + data → "Ver agenda" lista pacientes daquele dia → escolher paciente → subir `.m4a` → analisar → salvar. Conferir no Supabase que `dentista_id`, `paciente_nome`, `data_consulta`, `clinicorp_appointment_id` foram gravados com o dentista escolhido (não o gestor). Como dentista comum: bloco de amarração NÃO aparece; upload usa o próprio dentista.

- [ ] **Step 7: Commit**

```bash
git add public/js/avaliacao-dentista/copiloto.js
git commit -m "feat: upload amarrado a dentista/paciente/data (gestor sobe por outro)"
```

---

## FASE 6 — Histórico com filtros + atribuição manual de órfãs

### Task 11: `GET /api/avaliacoes` retorna data e nome do dentista

**Files:**
- Modify: `server.js` (`GET /api/avaliacoes`, ~4220)

- [ ] **Step 1: Incluir `data_consulta` e flag de órfã no select**

No `.select(...)` da query (~4240), trocar para incluir os novos campos:

```js
      .select('id, dentista_id, paciente_id, paciente_nome, paciente_vinculado, clinicorp_appointment_id, data_consulta, nota_final, modo, created_at, feedback_ia', { count: 'exact' })
```

- [ ] **Step 2: Anexar nome do dentista ao resultado**

Após obter `data` e antes do `res.json`, resolver nomes dos dentistas em lote:

```js
    let rows = data || [];
    const dentistaIds = [...new Set(rows.map(r => r.dentista_id).filter(Boolean))];
    if (dentistaIds.length) {
      const { data: profs } = await supabase.from('profiles').select('id, nome').in('id', dentistaIds);
      const nomeBy = Object.fromEntries((profs || []).map(p => [p.id, p.nome]));
      rows = rows.map(r => ({
        ...r,
        dentista_nome: nomeBy[r.dentista_id] || null,
        orfa: !r.paciente_vinculado && !r.clinicorp_appointment_id && !r.data_consulta,
      }));
    }
    res.json({ data: rows, total: count || 0, limit, offset });
```

(remover o `res.json` antigo).

- [ ] **Step 3: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem saída.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: histórico de avaliações retorna data, dentista e flag de órfã"
```

### Task 12: `PATCH /api/avaliacoes/:id/atribuir` — atribuir órfã (gestor/admin)

**Files:**
- Modify: `server.js` (perto do `PATCH /api/avaliacoes/:id/paciente`, ~4366)

- [ ] **Step 1: Implementar o endpoint**

```js
// Atribuição manual de avaliação órfã: dentista + paciente (nome) + data, num passo só.
app.patch('/api/avaliacoes/:id/atribuir', requireAuth, async (req, res) => {
  try {
    if (!UUID_V4_RE.test(req.params.id)) return res.status(400).json({ error: 'id deve ser um UUID v4 válido' });
    const p = await loadProfile(req);
    const isGestor = (p.roles || []).some(r => ['gestor', 'admin'].includes(r));
    if (!isGestor) return res.status(403).json({ error: 'Apenas gestor/admin pode atribuir' });

    const { data: consulta } = await supabase.from('consultas_spin').select('id').eq('id', req.params.id).maybeSingle();
    if (!consulta) return res.status(404).json({ error: 'Consulta não encontrada' });

    const patch = {};
    const { dentista_id, paciente_nome, data_consulta, clinicorp_patient_id, clinicorp_appointment_id } = req.body;
    if (dentista_id !== undefined) {
      if (!UUID_V4_RE.test(dentista_id)) return res.status(400).json({ error: 'dentista_id inválido' });
      patch.dentista_id = dentista_id;
    }
    if (paciente_nome !== undefined) {
      const nome = String(paciente_nome || '').trim().slice(0, 120);
      if (!nome) return res.status(400).json({ error: 'paciente_nome não pode ser vazio' });
      patch.paciente_nome = nome;
    }
    if (data_consulta !== undefined) {
      if (data_consulta && !/^\d{4}-\d{2}-\d{2}$/.test(data_consulta)) return res.status(400).json({ error: 'data_consulta deve ser YYYY-MM-DD' });
      patch.data_consulta = data_consulta || null;
    }
    if (clinicorp_patient_id !== undefined) patch.clinicorp_patient_id = clinicorp_patient_id ? String(clinicorp_patient_id).slice(0, 64) : null;
    if (clinicorp_appointment_id !== undefined) patch.clinicorp_appointment_id = clinicorp_appointment_id ? String(clinicorp_appointment_id).slice(0, 64) : null;

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    const { data, error } = await supabase.from('consultas_spin').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ ok: true, consulta: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem saída.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: PATCH /atribuir — atribuir dentista/paciente/data a avaliação órfã"
```

### Task 13: Histórico — colunas, filtros e botão "Atribuir"

**Files:**
- Modify: `public/js/avaliacao-dentista/historico.js`

> **Contexto:** `historico.js` já lista as avaliações de `GET /api/avaliacoes` e (para gestor) tem filtro por dentista/período. Localizar a função que monta as linhas da tabela e a área de filtros.

- [ ] **Step 1: Adicionar colunas Dentista / Paciente / Data na tabela**

Na renderização de cada linha, exibir `r.dentista_nome || '—'`, `r.paciente_nome`, e a data: `r.data_consulta ? formatarData(r.data_consulta) : formatarData(r.created_at)`. Marcar linhas órfãs (`r.orfa === true`) com um selo visual, ex. badge cinza "sem vínculo" ao lado do nome do paciente:

```js
const seloOrfa = r.orfa ? ' <span style="font-size:10px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:1px 6px;color:var(--muted)">sem vínculo</span>' : '';
```

- [ ] **Step 2: Botão "Atribuir" nas linhas órfãs (gestor/admin)**

Se o usuário é gestor/admin e `r.orfa`, adicionar na coluna de ações um botão:

```js
const btnAtribuir = (isGestor && r.orfa)
  ? `<button onclick="window._avdAtribuir('${r.id}')" style="padding:4px 10px;border-radius:8px;background:var(--accent);color:#fff;border:none;font-size:11px;cursor:pointer">Atribuir</button>`
  : '';
```

- [ ] **Step 3: Modal/prompt de atribuição**

Implementar `window._avdAtribuir(id)` que abre um modal simples (reusar padrão de modal do módulo, ou um `prompt` mínimo se não houver). Campos: select de dentista (de `GET /api/avaliacoes/dentistas`), nome do paciente (texto), data (input date). Ao confirmar:

```js
async function atribuir(id, { dentista_id, paciente_nome, data_consulta }) {
  await patch(`/api/avaliacoes/${id}/atribuir`, { dentista_id, paciente_nome, data_consulta });
  showToast('Avaliação atribuída.', 'success');
  await reload(); // recarrega a lista
}
```

Expor `window._avdAtribuir` para abrir o modal e chamar `atribuir(...)`.

- [ ] **Step 4: Filtros por dentista e período**

Confirmar que os filtros já existentes mandam `dentista_id`, `desde`, `ate` na query de `GET /api/avaliacoes`. Se faltar o filtro de dentista para gestor, adicionar um `<select>` populado por `GET /api/avaliacoes/dentistas` que refaz a busca ao mudar.

- [ ] **Step 5: Verificação manual**

Como gestor: abrir Histórico → colunas Dentista/Paciente/Data aparecem → avaliações novas (amarradas) mostram dentista e data corretos → avaliações antigas mostram "sem vínculo" + botão "Atribuir" → atribuir uma (escolher dentista, digitar paciente, data) → linha deixa de ser órfã após recarregar → filtro por dentista e período funciona. Como dentista comum: vê só as próprias, sem botão Atribuir.

- [ ] **Step 6: Commit**

```bash
git add public/js/avaliacao-dentista/historico.js
git commit -m "feat: histórico com dentista/paciente/data, selo de órfã e atribuição manual"
```

---

## FASE 7 — Fechamento

### Task 14: Deploy e validação ponta-a-ponta

- [ ] **Step 1: Rodar a suíte de testes**

Run: `npm test`
Expected: PASS — incluindo `lib/avaliacao/agenda.test.js` e `lib/avaliacao/audio-format.test.js`.

- [ ] **Step 2: Push + deploy**

```bash
git push
```
Depois: `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`

- [ ] **Step 3: Roteiro de validação manual (pedir ao Luiz / dentistas)**

1. **Admin** vincula Marcos e Matheus G. ao Clinicorp na seção de config.
2. **Dentista vinculado** abre o copiloto: agenda do dia aparece, paciente com check-in marcado 🟢 Presente; "Iniciar consulta" começa a gravação sem digitar; ao salvar, a avaliação fica com dentista+paciente+data+agendamento.
3. **Upload `.m4a`** de uma consulta real funciona (ou erro claro se ffmpeg faltar no container).
4. **Gestor** sobe um áudio por outro dentista: escolhe dentista+data+paciente da agenda → salva → fica atribuído ao dentista certo.
5. **Histórico**: novas avaliações mostram dentista/paciente/data; antigas mostram "sem vínculo" + Atribuir; atribuição funciona; filtros por dentista e período funcionam.

- [ ] **Step 4: Atualizar pendências e memória**

Adicionar à lista de pendências do Luiz o item "validar avaliação amarrada (paciente presente + upload + histórico)" com os passos do Step 3.

---

## Self-Review (preenchido)

- **Cobertura da spec:** Paciente presente → Tasks 5–6. Mapeamento dentista → Tasks 1,3,4. Amarração no save → Task 7. Upload consertado (investigação + ffmpeg + formatos + erro claro + progresso) → Tasks 0,8,9,10. Histórico + atribuição manual de órfãs → Tasks 11,12,13. Critérios 1–6 da spec cobertos.
- **Progresso do upload:** a spec pede "barra de progresso". O upload já usa job assíncrono + polling (status pending→done); a UI de progresso existente (`#avd-progress`) cobre o "transcrevendo…". Item tratado como reuso da UI atual, não nova barra de bytes (YAGNI) — anotado para não virar escopo extra.
- **Consistência de tipos:** `clinicorp_appointment_id`/`clinicorp_patient_id` são `text` no banco e enviados como string; `data_consulta` sempre `YYYY-MM-DD`; `parseAgendaDia` devolve `{ appointment_id, clinicorp_patient_id, paciente_nome, from_time, to_time, presente }` — mesmos nomes usados no frontend (`it.appointment_id`, `it.clinicorp_patient_id`, `it.presente`). `AvaliacaoApp.currentPaciente` tem `{ nome, clinicorp_patient_id, clinicorp_appointment_id, data_consulta }` consistente entre Tasks 6, 7 e 10.
- **Sem placeholders:** todos os steps de código têm o código real; steps de frontend sem harness de teste têm verificação manual explícita.
- **Dependência da Fase 0:** documentada como não-bloqueante para as demais fases.
