# Pesquisa de Satisfação via WhatsApp Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enviar automaticamente a Pesquisa de Satisfação (WhatsApp Flow `pesquisa_nps`) às 19h para pacientes atendidos no dia, capturar as respostas estruturadas (`nfm_reply`) e exibir no CRM.

**Architecture:** Job self-healing às 19h BRT no `server.js` consulta a Clinicorp ao vivo (estimates 90d filtrando `ExecutedDate=hoje` + appointments de hoje dos avaliadores), seleciona destinatários com dedup por telefone/3 meses (lógica pura em `lib/pesquisa/selecao.js`, testada), envia o template `pesquisa_nps` pelo número broadcast e grava em `pesquisas_satisfacao`. O webhook `/webhooks/whatsapp` existente ganha parse de `nfm_reply` que casa a resposta com o envio pendente por telefone.

**Tech Stack:** Node.js/Express, Supabase (Postgres + RLS), WhatsApp Cloud API v21.0, front vanilla HTML/JS, `node --test`.

**Spec:** `docs/superpowers/specs/2026-07-17-pesquisa-satisfacao-flow-design.md`

## Global Constraints

- ⚠️ **Working dir concorrente:** o main local desta cópia está divergente de `origin/main`. TODO o trabalho deve ser feito num branch criado de `origin/main` (worktree: `git worktree add ../wt-pesquisa origin/main -b feat/pesquisa-satisfacao` a partir de `clinica-crm/`). Push do branch ao final de cada task; merge fast-forward em main só na task final.
- Template aprovado: `pesquisa_nps` (pt_BR), número broadcast 8700 (`WA_BROADCAST_PHONE_ID`). O Flow já publicado NÃO deve ser editado.
- Campos do payload do Flow: `nps`, `motivo_principal`, `avaliacao_recepcao`, `avaliacao_dentista`, `avaliacao_espera`, `avaliacao_limpeza`, `avaliacao_explicacoes` (dropdowns "1"–"5"), `comentario` (opcional).
- Regra de dedup: **1 pesquisa por telefone (chaveTelefone) a cada 3 meses**. NUNCA normalizar/mesclar telefones com 0 à esquerda (família) — comparar via `chaveTelefone` de `lib/funil/telefone.js`.
- Toda tabela nova: `ENABLE ROW LEVEL SECURITY`, sem policy (acesso só via `/api` com service_role).
- Sem siglas financeiras na UI; "NPS" pode aparecer, mas sempre acompanhado de "nota de recomendação (0–10)".
- Clinicorp: máx ~25 chamadas/h — o job usa ~4 (3 estimates + 1 appointments).
- Testes: `node --test` (padrão do repo). Testes de lógica pura em `lib/pesquisa/*.test.js`; testes de parse em `whatsapp.test.js` (rodar com `node --test whatsapp.test.js`).
- Migração Supabase: aplicar via MCP Supabase (project `mtqdpjhhqzvuklnlfpvi`), verificar com `list_migrations`.
- Deploy: `git push` e `curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"`.

---

### Task 1: Migração — tabela `pesquisas_satisfacao`

**Files:**
- Create: `supabase/migrations/20260717190000_pesquisas_satisfacao.sql`

**Interfaces:**
- Produces: tabela `pesquisas_satisfacao` usada pelas tasks 5–7.

- [ ] **Step 1: Escrever a migração**

```sql
-- Pesquisa de Satisfação via WhatsApp Flow (spec 2026-07-17)
-- Uma linha por ENVIO; a resposta (nfm_reply) atualiza a mesma linha.
-- Linha "órfã" = resposta sem envio pendente (enviado_em/wa_id nulos).
CREATE TABLE public.pesquisas_satisfacao (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id bigint REFERENCES public.leads(id),
  paciente_clinicorp_id text,
  paciente_nome text,
  telefone text NOT NULL,
  dentista_nome text,
  origem text CHECK (origem IN ('tratamento','avaliacao')),
  enviado_em timestamptz,
  wa_id text,
  wa_id_resposta text,
  status text NOT NULL DEFAULT 'enviado' CHECK (status IN ('enviado','respondido','falhou')),
  erro text,
  respondido_em timestamptz,
  nps smallint,
  motivo_principal text,
  avaliacao_recepcao smallint,
  avaliacao_dentista smallint,
  avaliacao_espera smallint,
  avaliacao_limpeza smallint,
  avaliacao_explicacoes smallint,
  comentario text,
  resposta_raw jsonb,
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- Busca da resposta: envio pendente mais recente por telefone (webhook)
CREATE INDEX pesquisas_satisfacao_tel_idx ON public.pesquisas_satisfacao (telefone, status, enviado_em DESC);
-- Dedup 3 meses + listagens por período
CREATE INDEX pesquisas_satisfacao_env_idx ON public.pesquisas_satisfacao (enviado_em DESC);
-- Dedup de reentrega do webhook
CREATE UNIQUE INDEX pesquisas_satisfacao_waresp_uq ON public.pesquisas_satisfacao (wa_id_resposta) WHERE wa_id_resposta IS NOT NULL;
-- Ficha do paciente
CREATE INDEX pesquisas_satisfacao_pac_idx ON public.pesquisas_satisfacao (paciente_clinicorp_id);

-- Regra do projeto: RLS ligada, SEM policy (acesso só pelo servidor/service_role)
ALTER TABLE public.pesquisas_satisfacao ENABLE ROW LEVEL SECURITY;
```

- [ ] **Step 2: Aplicar via MCP Supabase**

Usar `apply_migration` (project `mtqdpjhhqzvuklnlfpvi`) com o SQL acima, nome `pesquisas_satisfacao`.
Verificar: `list_migrations` mostra a migração; `list_tables` mostra a tabela com `rls_enabled: true`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260717190000_pesquisas_satisfacao.sql
git commit -m "feat(pesquisa): tabela pesquisas_satisfacao (RLS ligada, sem policy)"
```

---

### Task 2: Parse de `nfm_reply` no `whatsapp.js` (TDD)

**Files:**
- Modify: `whatsapp.js` (nova função `parseNfmReply` + ajuste em `parseMensagemRecebida` linha ~210 + export)
- Test: `whatsapp.test.js`

**Interfaces:**
- Produces: `parseNfmReply(body)` → `{ from, wamid, phone_number_id, timestamp, respostas } | null`, onde `respostas` é o objeto já parseado do `response_json`. Usada na Task 6.
- Produces: `parseMensagemRecebida` passa a retornar `texto: '📋 Respondeu a Pesquisa de Satisfação'` para mensagens `interactive` com `nfm_reply` (para a thread do módulo Conversas).

- [ ] **Step 1: Escrever os testes que falham**

Adicionar ao final de `whatsapp.test.js` (o helper `body(msg, contact)` já existe no topo do arquivo):

```js
const { parseNfmReply } = require('./whatsapp');

test('nfm_reply: parseNfmReply extrai respostas do response_json', () => {
  const r = parseNfmReply(body({
    from: '5531999990000', id: 'wamid.NFM1', type: 'interactive', timestamp: '1721234567',
    interactive: {
      type: 'nfm_reply',
      nfm_reply: {
        name: 'flow', body: 'Sent',
        response_json: JSON.stringify({
          nps: '9', motivo_principal: 'Atendimento', avaliacao_recepcao: '5',
          avaliacao_dentista: '5', avaliacao_espera: '4', avaliacao_limpeza: '5',
          avaliacao_explicacoes: '5', comentario: 'Tudo ótimo',
        }),
      },
    },
  }));
  assert.strictEqual(r.from, '5531999990000');
  assert.strictEqual(r.wamid, 'wamid.NFM1');
  assert.strictEqual(r.respostas.nps, '9');
  assert.strictEqual(r.respostas.comentario, 'Tudo ótimo');
});

test('nfm_reply: retorna null para mensagem comum e para response_json inválido', () => {
  assert.strictEqual(parseNfmReply(body({ from: '5531999990000', id: 'wamid.T', type: 'text', timestamp: '1', text: { body: 'oi' } })), null);
  assert.strictEqual(parseNfmReply(body({
    from: '5531999990000', id: 'wamid.NFM2', type: 'interactive', timestamp: '1',
    interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{invalido' } },
  })), null);
});

test('nfm_reply: parseMensagemRecebida usa texto amigável', () => {
  const r = parseMensagemRecebida(body({
    from: '5531999990000', id: 'wamid.NFM3', type: 'interactive', timestamp: '1',
    interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{"nps":"8"}' } },
  }));
  assert.strictEqual(r.texto, '📋 Respondeu a Pesquisa de Satisfação');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test whatsapp.test.js`
Expected: FAIL — `parseNfmReply is not a function`.

- [ ] **Step 3: Implementar**

Em `whatsapp.js`, após `parseMensagemRecebida` (linha ~238):

```js
// --------- PARSE de resposta de WhatsApp Flow (nfm_reply) ----------
// Quando o paciente conclui um Flow (ex.: Pesquisa de Satisfação), a resposta
// chega como mensagem interactive/nfm_reply com os campos do formulário em
// response_json (string JSON). Retorna null se não for nfm_reply ou JSON inválido.
function parseNfmReply(body) {
  try {
    const change = body?.entry?.[0]?.changes?.[0];
    if (change?.field !== 'messages') return null;
    const v = change.value;
    const msg = v?.messages?.[0];
    const raw = msg?.interactive?.nfm_reply?.response_json;
    if (!raw) return null;
    const respostas = JSON.parse(raw);
    return {
      from: msg.from,
      wamid: msg.id,
      phone_number_id: v?.metadata?.phone_number_id || '',
      timestamp: msg.timestamp,
      respostas,
    };
  } catch (e) {
    return null;
  }
}
```

Na linha ~210 (`texto:` de `parseMensagemRecebida`), acrescentar o fallback de nfm_reply ao final da cadeia:

```js
texto: msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || (msg.interactive?.nfm_reply ? '📋 Respondeu a Pesquisa de Satisfação' : '') || caption || '',
```

No `module.exports`, adicionar `parseNfmReply,` após `parseStatuses,`.

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test whatsapp.test.js`
Expected: PASS (todos, incluindo os antigos).

- [ ] **Step 5: Commit**

```bash
git add whatsapp.js whatsapp.test.js
git commit -m "feat(pesquisa): parse de nfm_reply (resposta de WhatsApp Flow) no webhook"
```

---

### Task 3: Seleção de destinatários — `lib/pesquisa/selecao.js` (TDD)

**Files:**
- Create: `lib/pesquisa/selecao.js`
- Test: `lib/pesquisa/selecao.test.js`

**Interfaces:**
- Consumes: `chaveTelefone` de `lib/funil/telefone.js` (já existe: normaliza p/ DDD+8/9 dígitos, '' se inválido).
- Produces: `montarDestinatarios({ estimates, appointments, avaliadores, statusCompareceu, telefonePorPaciente, chavesRecentes, hoje })` → `{ destinatarios: [{ paciente_clinicorp_id, paciente_nome, telefone, dentista_nome, origem }], pulados: [{ paciente_nome, motivo }] }`. Usada na Task 5.
  - `estimates`: array cru do `/estimates/list` (com `ProcedureList`).
  - `appointments`: array cru do `/appointment/list` de hoje (TODOS, sem filtro).
  - `avaliadores`: `Set<string>` de ids Clinicorp dos avaliadores (`config_avaliadores`).
  - `statusCompareceu`: `Set<string>` de StatusId (`config_status_compareceu`).
  - `telefonePorPaciente`: `Map<string, string>` clinicorp_id → telefone (da tabela `pacientes`).
  - `chavesRecentes`: `Set<string>` de `chaveTelefone` que receberam pesquisa nos últimos 3 meses.
  - `hoje`: `'YYYY-MM-DD'`.

- [ ] **Step 1: Escrever os testes que falham**

Criar `lib/pesquisa/selecao.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { montarDestinatarios } = require('./selecao');

const HOJE = '2026-07-17';

function estimate(patientId, nome, procs) {
  return { id: '900' + patientId, PatientId: patientId, PatientName: nome, ProcedureList: procs };
}
function procExecHoje(dentista) {
  return { Executed: 'X', ExecutedDate: HOJE + 'T10:00:00', Amount: 100, ProfessionalName: dentista };
}
function base(extra = {}) {
  return {
    estimates: [], appointments: [],
    avaliadores: new Set(), statusCompareceu: new Set(),
    telefonePorPaciente: new Map(), chavesRecentes: new Set(), hoje: HOJE,
    ...extra,
  };
}

test('tratamento executado hoje entra; executado ontem não', () => {
  const r = montarDestinatarios(base({
    estimates: [
      estimate('11', 'Ana', [procExecHoje('Dra. X')]),
      estimate('22', 'Beto', [{ Executed: 'X', ExecutedDate: '2026-07-16T09:00:00', Amount: 50 }]),
      estimate('33', 'Caio', [{ Executed: '', ExecutedDate: HOJE + 'T11:00:00', Amount: 80 }]),
    ],
    telefonePorPaciente: new Map([['11', '5531988887777'], ['22', '5531977776666'], ['33', '5531966665555']]),
  }));
  assert.strictEqual(r.destinatarios.length, 1);
  assert.strictEqual(r.destinatarios[0].paciente_clinicorp_id, '11');
  assert.strictEqual(r.destinatarios[0].origem, 'tratamento');
  assert.strictEqual(r.destinatarios[0].dentista_nome, 'Dra. X');
});

test('avaliação de avaliador com CheckinTime entra; sem comparecimento não', () => {
  const r = montarDestinatarios(base({
    avaliadores: new Set(['5757301300985856']),
    statusCompareceu: new Set(['777']),
    appointments: [
      { id: 'a1', Dentist_PersonId: '5757301300985856', Patient_PersonId: '44', PatientName: 'Dani',
        MobilePhone: '31 98888-1111', CheckinTime: 1721230000000, date: HOJE },
      { id: 'a2', ScheduleToId: '5757301300985856', Patient_PersonId: '55', PatientName: 'Edu',
        MobilePhone: '31 98888-2222', StatusId: '777', date: HOJE },
      { id: 'a3', Dentist_PersonId: '5757301300985856', Patient_PersonId: '66', PatientName: 'Fabi',
        MobilePhone: '31 98888-3333', StatusId: '1', date: HOJE },
      { id: 'a4', Dentist_PersonId: '999', Patient_PersonId: '77', PatientName: 'Gil',
        MobilePhone: '31 98888-4444', CheckinTime: 1721230000000, date: HOJE },
      { id: 'a5', Deleted: 'X', Dentist_PersonId: '5757301300985856', Patient_PersonId: '88',
        PatientName: 'Hugo', MobilePhone: '31 98888-5555', CheckinTime: 1721230000000, date: HOJE },
    ],
  }));
  const nomes = r.destinatarios.map(d => d.paciente_nome).sort();
  assert.deepStrictEqual(nomes, ['Dani', 'Edu']);
  assert.strictEqual(r.destinatarios[0].origem, 'avaliacao');
});

test('dedup: mesmo telefone no lote e telefone recente (3 meses) saem', () => {
  const r = montarDestinatarios(base({
    estimates: [estimate('11', 'Ana', [procExecHoje('Dra. X')])],
    avaliadores: new Set(['10']),
    appointments: [
      // familiar com o MESMO telefone da Ana (sufixo igual, formato diferente)
      { id: 'a1', Dentist_PersonId: '10', Patient_PersonId: '99', PatientName: 'Filho da Ana',
        MobilePhone: '(31) 98888-7777', CheckinTime: 1, date: HOJE },
      // paciente que já recebeu há 1 mês
      { id: 'a2', Dentist_PersonId: '10', Patient_PersonId: '98', PatientName: 'Já Recebeu',
        MobilePhone: '31 97777-0000', CheckinTime: 1, date: HOJE },
    ],
    telefonePorPaciente: new Map([['11', '5531988887777']]),
    chavesRecentes: new Set([require('../funil/telefone').chaveTelefone('31 97777-0000')]),
  }));
  assert.strictEqual(r.destinatarios.length, 1);
  assert.strictEqual(r.destinatarios[0].paciente_nome, 'Ana');
  assert.strictEqual(r.pulados.length, 2);
});

test('tratamento sem telefone: usa fallback do appointment do dia; sem nada → pulado', () => {
  const r = montarDestinatarios(base({
    estimates: [
      estimate('11', 'Ana', [procExecHoje('Dra. X')]),
      estimate('22', 'Beto', [procExecHoje('Dr. Y')]),
    ],
    // Ana não está na tabela pacientes, mas tem agendamento hoje com telefone
    appointments: [{ id: 'a1', Dentist_PersonId: '999', Patient_PersonId: '11', PatientName: 'Ana',
      MobilePhone: '31 96666-1234', date: HOJE }],
  }));
  assert.strictEqual(r.destinatarios.length, 1);
  assert.strictEqual(r.destinatarios[0].telefone, '31 96666-1234');
  assert.strictEqual(r.pulados.length, 1);
  assert.strictEqual(r.pulados[0].motivo, 'sem telefone');
});

test('mesmo paciente em tratamento e avaliação → 1 envio (origem tratamento)', () => {
  const r = montarDestinatarios(base({
    estimates: [estimate('11', 'Ana', [procExecHoje('Dra. X')])],
    avaliadores: new Set(['10']),
    appointments: [{ id: 'a1', Dentist_PersonId: '10', Patient_PersonId: '11', PatientName: 'Ana',
      MobilePhone: '31 98888-7777', CheckinTime: 1, date: HOJE }],
    telefonePorPaciente: new Map([['11', '31 98888-7777']]),
  }));
  assert.strictEqual(r.destinatarios.length, 1);
  assert.strictEqual(r.destinatarios[0].origem, 'tratamento');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test lib/pesquisa/selecao.test.js`
Expected: FAIL — `Cannot find module './selecao'`.

- [ ] **Step 3: Implementar `lib/pesquisa/selecao.js`**

```js
// Seleção de destinatários da Pesquisa de Satisfação (spec 2026-07-17).
// Lógica PURA (sem IO) — o job em server.js busca os dados e chama esta função.
const { chaveTelefone } = require('../funil/telefone');

// ⚠️ from/to do /estimates/list filtra pela data do ORÇAMENTO, não da execução —
// por isso o chamador busca 90 dias e aqui filtramos item a item por ExecutedDate.
function montarDestinatarios({ estimates, appointments, avaliadores, statusCompareceu, telefonePorPaciente, chavesRecentes, hoje }) {
  const pulados = [];
  const candidatos = []; // ordem importa: tratamentos primeiro (vencem no dedup)

  // 1) Tratamentos executados HOJE (itens Executed='X' com ExecutedDate=hoje)
  const vistosTrat = new Set();
  for (const est of estimates || []) {
    const pacId = String(est.PatientId || '');
    for (const p of est.ProcedureList || est.procedureList || []) {
      if (p.Executed !== 'X') continue;
      if (String(p.ExecutedDate || '').slice(0, 10) !== hoje) continue;
      if (vistosTrat.has(pacId)) continue;
      vistosTrat.add(pacId);
      candidatos.push({
        paciente_clinicorp_id: pacId,
        paciente_nome: est.PatientName || '',
        telefone: telefonePorPaciente.get(pacId) || '',
        dentista_nome: p.ProfessionalName || p.DentistName || '',
        origem: 'tratamento',
      });
    }
  }

  // Fallback de telefone dos tratamentos: agendamento de hoje do mesmo paciente
  const telPorApptPaciente = new Map();
  for (const a of appointments || []) {
    if ((a.Deleted || '') === 'X') continue;
    const tel = a.MobilePhone || a.Phone || '';
    const pid = String(a.Patient_PersonId || '');
    if (tel && pid && !telPorApptPaciente.has(pid)) telPorApptPaciente.set(pid, tel);
  }
  for (const c of candidatos) {
    if (!c.telefone) c.telefone = telPorApptPaciente.get(c.paciente_clinicorp_id) || '';
  }

  // 2) Avaliações de HOJE dos avaliadores que compareceram
  // (mesma regra do syncAvaliacoes: CheckinTime OU StatusId em config_status_compareceu)
  const vistosAval = new Set();
  for (const a of appointments || []) {
    if ((a.Deleted || '') === 'X') continue;
    const dentId = String(a.Dentist_PersonId || '');
    const schedId = String(a.ScheduleToId || '');
    if (!avaliadores.has(dentId) && !avaliadores.has(schedId)) continue;
    const compareceu = !!a.CheckinTime || statusCompareceu.has(String(a.StatusId || ''));
    if (!compareceu) continue;
    const pacId = String(a.Patient_PersonId || '');
    if (vistosAval.has(pacId) || vistosTrat.has(pacId)) continue;
    vistosAval.add(pacId);
    candidatos.push({
      paciente_clinicorp_id: pacId,
      paciente_nome: a.PatientName || '',
      telefone: a.MobilePhone || a.Phone || '',
      dentista_nome: '',
      origem: 'avaliacao',
    });
  }

  // 3) Dedup por telefone: dentro do lote + últimos 3 meses (chavesRecentes)
  const destinatarios = [];
  const chavesLote = new Set();
  for (const c of candidatos) {
    const chave = chaveTelefone(c.telefone);
    if (!chave) { pulados.push({ paciente_nome: c.paciente_nome, motivo: 'sem telefone' }); continue; }
    if (chavesLote.has(chave)) { pulados.push({ paciente_nome: c.paciente_nome, motivo: 'telefone repetido no lote' }); continue; }
    if (chavesRecentes.has(chave)) { pulados.push({ paciente_nome: c.paciente_nome, motivo: 'já recebeu nos últimos 3 meses' }); continue; }
    chavesLote.add(chave);
    destinatarios.push(c);
  }

  return { destinatarios, pulados };
}

module.exports = { montarDestinatarios };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test lib/pesquisa/selecao.test.js`
Expected: PASS (5 testes).

- [ ] **Step 5: Rodar a suíte toda**

Run: `npm test`
Expected: PASS (sem quebrar nada existente).

- [ ] **Step 6: Commit**

```bash
git add lib/pesquisa/selecao.js lib/pesquisa/selecao.test.js
git commit -m "feat(pesquisa): seleção de destinatários com dedup por telefone/3 meses"
```

---

### Task 4: Job de envio + scheduler 19h + disparo manual (server.js)

**Files:**
- Modify: `server.js` — novo bloco após o scheduler do sync diário (após linha ~5102) + rota de disparo manual.

**Interfaces:**
- Consumes: `montarDestinatarios` (Task 3), `whatsapp.enviarBroadcast` / `whatsapp.broadcastPhoneId()` (já existem), `clinicorpGet` (server.js:3610), `acharLeadPorTelefone` (server.js:2852), `logEvento` (server.js:140), `registrarJob` (server.js:~5030), tabela `pesquisas_satisfacao` (Task 1).
- Produces: `executarPesquisaSatisfacao(disparo)` → `{ ok, enviados, falhas, pulados }`; rota `POST /api/pesquisa-satisfacao/disparar`; middleware `requirePesquisa`. Usados nas tasks 5–6.

- [ ] **Step 1: Adicionar o require no topo do server.js (junto dos outros requires de lib, ~linha 208)**

```js
const { montarDestinatarios } = require('./lib/pesquisa/selecao');
```

(`chaveTelefone` e `sanitizeStr` já existem no escopo do server.js — linhas 204 e 199 — não importar de novo.)

Registrar o job no `JOB_HEARTBEAT` (linha ~5026, junto das outras entradas) — sem isso `registrarJob('pesquisa_satisfacao', ...)` é um no-op silencioso (`if (!meta) return`):

```js
  pesquisa_satisfacao: { label: 'Pesquisa de Satisfação (WhatsApp)', cadenciaMin: 1440, margemMin: 360 },
```

- [ ] **Step 2: Implementar o job (colar após o scheduler do social media, mantendo o padrão dos blocos vizinhos)**

```js
// ========== PESQUISA DE SATISFAÇÃO (WhatsApp Flow) — spec 2026-07-17 ==========
// Envia o template `pesquisa_nps` (Flow) às 19h BRT para quem foi atendido hoje:
// tratamentos executados (estimates, ExecutedDate=hoje) + avaliações dos
// avaliadores (config_avaliadores) com comparecimento. Dedup: 1 por telefone/3 meses.
const PESQUISA_TEMPLATE = 'pesquisa_nps';
let _pesquisaRodando = false;

async function executarPesquisaSatisfacao(disparo = 'agendado') {
  if (_pesquisaRodando) return { ok: false, error: 'já em execução' };
  _pesquisaRodando = true;
  const t0 = Date.now();
  try {
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

    // 1) Clinicorp ao vivo — estimates 90d em fatias de 30 (from/to filtra pela
    // data do ORÇAMENTO; a execução de hoje mora em orçamentos antigos) + agenda de hoje
    const dataStr = (d) => d.toISOString().slice(0, 10);
    const estimates = [];
    for (let off = 0; off < 90; off += 30) {
      const to = new Date(); to.setDate(to.getDate() - off);
      const from = new Date(); from.setDate(from.getDate() - Math.min(off + 30, 90));
      const part = await clinicorpGet('/estimates/list', { from: dataStr(from), to: dataStr(to) });
      if (Array.isArray(part)) estimates.push(...part);
    }
    const appointments = await clinicorpGet('/appointment/list', { from: hoje, to: hoje });

    // 2) Configs + telefones + dedup 3 meses (Supabase)
    const m3 = new Date(); m3.setMonth(m3.getMonth() - 3);
    const [avalR, stR, recR] = await Promise.all([
      supabase.from('config_avaliadores').select('clinicorp_id').eq('ativo', true),
      supabase.from('config_status_compareceu').select('status_id').eq('compareceu', true),
      // falhou fica de fora: envio que a Meta rejeitou nunca chegou, não conta p/ os 3 meses
      supabase.from('pesquisas_satisfacao').select('telefone').neq('status', 'falhou')
        .gte('enviado_em', m3.toISOString()).limit(5000),
    ]);
    for (const r of [avalR, stR, recR]) if (r.error) throw r.error;
    const avaliadores = new Set((avalR.data || []).map(r => String(r.clinicorp_id)));
    const statusCompareceu = new Set((stR.data || []).map(r => String(r.status_id)));
    const chavesRecentes = new Set((recR.data || []).map(r => chaveTelefone(r.telefone)).filter(Boolean));

    // telefones dos pacientes dos tratamentos (tabela pacientes, em lotes de 200)
    const pacIds = new Set();
    for (const est of (Array.isArray(estimates) ? estimates : [])) {
      const pid = String(est.PatientId || '');
      if (pid) pacIds.add(pid);
    }
    // ⚠️ colunas reais da tabela pacientes: telefone_celular / telefone_fixo (não "telefone")
    const telefonePorPaciente = new Map();
    const idsArr = [...pacIds];
    for (let i = 0; i < idsArr.length; i += 200) {
      const { data: pacs } = await supabase.from('pacientes')
        .select('clinicorp_id, telefone_celular, telefone_fixo').in('clinicorp_id', idsArr.slice(i, i + 200));
      for (const p of pacs || []) {
        const tel = p.telefone_celular || p.telefone_fixo;
        if (tel) telefonePorPaciente.set(String(p.clinicorp_id), tel);
      }
    }

    // 3) Seleção pura
    const { destinatarios, pulados } = montarDestinatarios({
      estimates, appointments: Array.isArray(appointments) ? appointments : [],
      avaliadores, statusCompareceu, telefonePorPaciente, chavesRecentes, hoje,
    });
    console.log(`[pesquisa] ${destinatarios.length} destinatários, ${pulados.length} pulados (${disparo})`);

    // 4) Envio sequencial (~24/min, mesmo ritmo do disparo em massa)
    let enviados = 0, falhas = 0;
    for (const d of destinatarios) {
      const row = {
        paciente_clinicorp_id: d.paciente_clinicorp_id || null,
        paciente_nome: sanitizeStr(d.paciente_nome, 200),
        telefone: sanitizeStr(d.telefone, 30),
        dentista_nome: sanitizeStr(d.dentista_nome || '', 200) || null,
        origem: d.origem, enviado_em: new Date().toISOString(),
      };
      try {
        const resultado = await whatsapp.enviarBroadcast({ para: d.telefone, templateName: PESQUISA_TEMPLATE });
        row.wa_id = resultado?.messages?.[0]?.id || '';
        row.status = 'enviado';
        enviados++;
        const lead = await acharLeadPorTelefone(whatsapp.limparNumero(d.telefone));
        if (lead) {
          row.lead_id = lead.id;
          await supabase.from('mensagens').insert({
            lead_id: lead.id, direcao: 'enviada', canal: 'broadcast',
            texto: '[template: ' + PESQUISA_TEMPLATE + '] 📋 Pesquisa de Satisfação',
            wa_id: row.wa_id, wa_number_id: whatsapp.broadcastPhoneId(),
          });
          logEvento(lead.id, 'pesquisa_enviada', 'Pesquisa de Satisfação enviada (' +
            (d.origem === 'avaliacao' ? 'avaliação' : 'tratamento') + ')',
            { template: PESQUISA_TEMPLATE, origem: d.origem });
        }
      } catch (e) {
        row.status = 'falhou';
        row.erro = sanitizeStr(e.metaMessage || e.message, 300);
        falhas++;
        console.warn('[pesquisa] falha p/ ' + d.paciente_nome + ': ' + row.erro);
      }
      const { error: insErr } = await supabase.from('pesquisas_satisfacao').insert(row);
      if (insErr) console.error('[pesquisa] insert:', insErr.message);
      await new Promise(r => setTimeout(r, 2500));
    }

    const detalhe = { enviados, falhas, pulados: pulados.length };
    await registrarJob('pesquisa_satisfacao', { ok: true, durationS: (Date.now() - t0) / 1000, detalhe });
    return { ok: true, ...detalhe };
  } catch (e) {
    console.error('[pesquisa] erro:', e.message);
    await registrarJob('pesquisa_satisfacao', { ok: false, error: e.message });
    return { ok: false, error: e.message };
  } finally {
    _pesquisaRodando = false;
  }
}

// Scheduler self-healing (mesmo padrão do sync-diario): janela 19:00 BRT;
// se o container estava fora do ar às 19h, recupera no próximo tick até 23:59.
(function agendarPesquisaSatisfacao() {
  function janelaHoje() {
    const hojeBRT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    return { inicio: new Date(`${hojeBRT}T19:00:00-03:00`), fim: new Date(`${hojeBRT}T23:59:59-03:00`) };
  }
  async function verificarEExecutar() {
    if (_pesquisaRodando) return;
    const { inicio, fim } = janelaHoje();
    const agora = Date.now();
    if (agora < inicio.getTime() || agora > fim.getTime()) return; // fora da janela do dia
    try {
      const { data, error } = await supabase.from('pesquisas_satisfacao')
        .select('id').gte('criado_em', inicio.toISOString()).limit(1);
      if (error) throw error;
      if (data && data.length) return; // já rodou hoje (agendado OU manual)
      // dias sem nenhum destinatário também precisam de marca — o registrarJob
      // grava em job_health (tabela real do heartbeat, ver registrarJob ~linha 5033):
      const { data: job } = await supabase.from('job_health')
        .select('last_run_at').eq('job', 'pesquisa_satisfacao').maybeSingle();
      if (job?.last_run_at && new Date(job.last_run_at).getTime() >= inicio.getTime()) return;
    } catch (e) {
      console.error('[pesquisa] checagem falhou:', e.message);
      return; // sem confirmação do DB não dispara (evita duplicar)
    }
    console.log('[pesquisa] disparando envio agendado (19h)');
    executarPesquisaSatisfacao('agendado').catch(e => console.error('[pesquisa]', e.message));
  }
  setTimeout(() => verificarEExecutar().catch(() => {}), 45_000);
  setInterval(() => verificarEExecutar().catch(() => {}), 10 * 60_000);
  console.log('[pesquisa] scheduler self-healing ativo (janela 19:00-23:59 BRT)');
})();
```


- [ ] **Step 3: Middleware + rota de disparo manual (junto das outras rotas, antes do bloco de webhooks)**

```js
const requirePesquisa = requireRole('admin', 'gestor', 'mod_pesquisa_satisfacao');

app.post('/api/pesquisa-satisfacao/disparar', requireAuth, requirePesquisa, rateLimit, async (req, res) => {
  try {
    if (_pesquisaRodando) return res.status(409).json({ error: 'Envio já em execução' });
    // roda solto — o front consulta o resultado pela listagem
    executarPesquisaSatisfacao('manual').catch(e => console.error('[pesquisa-manual]', e.message));
    res.json({ ok: true, mensagem: 'Disparo iniciado' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

(`requireRole(...allowed)` — server.js:430 — retorna middleware; o formato acima está correto, igual a `requireGestor = requireRole('gestor', 'admin')`.)

- [ ] **Step 4: Verificar sintaxe e subir localmente**

Run: `node --check server.js`
Expected: sem erro de sintaxe.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(pesquisa): job 19h self-healing + disparo manual do template pesquisa_nps"
```

---

### Task 5: Captura da resposta no webhook (server.js)

**Files:**
- Modify: `server.js` — dentro de `app.post('/webhooks/whatsapp', ...)` (linha ~2867), após o bloco de ecos (`parseEchoes`, ~linha 2932) e ANTES de `const m = whatsapp.parseMensagemRecebida(req.body)`.

**Interfaces:**
- Consumes: `whatsapp.parseNfmReply` (Task 2), tabela `pesquisas_satisfacao` (Task 1), `acharLeadPorTelefone`, `logEvento`, `chaveTelefone`.
- Produces: respostas do Flow atualizam `pesquisas_satisfacao` + Trajeto. A mensagem também entra na thread pelo fluxo genérico já existente (texto amigável da Task 2).

- [ ] **Step 1: Implementar o bloco**

```js
    // Resposta de WhatsApp Flow (Pesquisa de Satisfação) → pesquisas_satisfacao.
    // Casa por telefone com o envio pendente mais recente (30 dias). Fire-and-forget
    // não: precisa rodar antes do 200 para garantir persistência com reentrega segura.
    try {
      const nfm = whatsapp.parseNfmReply(req.body);
      if (nfm) {
        const { data: jaTem } = await supabase.from('pesquisas_satisfacao')
          .select('id').eq('wa_id_resposta', nfm.wamid).limit(1);
        if (!jaTem?.length) {
          const rsp = nfm.respostas || {};
          const nota = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
          const upd = {
            status: 'respondido', respondido_em: new Date().toISOString(),
            wa_id_resposta: nfm.wamid, resposta_raw: rsp,
            nps: nota(rsp.nps), motivo_principal: sanitizeStr(rsp.motivo_principal || '', 300) || null,
            avaliacao_recepcao: nota(rsp.avaliacao_recepcao),
            avaliacao_dentista: nota(rsp.avaliacao_dentista),
            avaliacao_espera: nota(rsp.avaliacao_espera),
            avaliacao_limpeza: nota(rsp.avaliacao_limpeza),
            avaliacao_explicacoes: nota(rsp.avaliacao_explicacoes),
            comentario: sanitizeStr(rsp.comentario || '', 2000) || null,
          };
          // envio pendente mais recente (30d) para o telefone — comparação por chave
          const alvo = chaveTelefone(nfm.from);
          const d30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
          const { data: pends } = await supabase.from('pesquisas_satisfacao')
            .select('id, telefone, lead_id').eq('status', 'enviado')
            .gte('enviado_em', d30).order('enviado_em', { ascending: false }).limit(500);
          const pend = (pends || []).find(p => chaveTelefone(p.telefone) === alvo) || null;
          if (pend) {
            const { error: upErr } = await supabase.from('pesquisas_satisfacao').update(upd).eq('id', pend.id);
            if (upErr) console.error('[pesquisa-resposta] update:', upErr.message);
            const leadId = pend.lead_id || (await acharLeadPorTelefone(nfm.from))?.id;
            if (leadId) logEvento(leadId, 'pesquisa_respondida',
              'Respondeu a Pesquisa de Satisfação — nota de recomendação ' + (upd.nps ?? '—'),
              { nps: upd.nps, motivo: upd.motivo_principal || '' });
          } else {
            // órfã: resposta sem envio pendente — não perder o dado
            console.warn('[pesquisa-resposta] órfã p/ …' + String(nfm.from).slice(-8));
            const { error: orfErr } = await supabase.from('pesquisas_satisfacao').insert({
              telefone: sanitizeStr(nfm.from, 30), ...upd,
            });
            if (orfErr) console.error('[pesquisa-resposta] órfã:', orfErr.message);
          }
        }
      }
    } catch (e) { console.error('[pesquisa-resposta]', e.message); }
```

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem erro.

- [ ] **Step 3: Teste manual do parse ponta-a-ponta (sem Meta)**

Com o servidor local parado, rodar só os testes:
Run: `node --test whatsapp.test.js lib/pesquisa/selecao.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(pesquisa): webhook captura nfm_reply e casa resposta por telefone"
```

---

### Task 6: API do módulo + card do Painel do Gestor (server.js)

**Files:**
- Modify: `server.js` — rotas novas junto da rota de disparo (Task 4 Step 3); resposta do `/api/painel-gestor` (linha ~8647).

**Interfaces:**
- Consumes: tabela `pesquisas_satisfacao`, `requirePesquisa` (Task 4).
- Produces:
  - `GET /api/pesquisa-satisfacao?from&to` → `{ resumo: { enviadas, respondidas, falhas, taxa, nps_media, medias: { recepcao, dentista, espera, limpeza, explicacoes } }, itens: [...] }`
  - `GET /api/pesquisa-satisfacao/lead/:leadId` → `{ itens: [...] }` — a "ficha do paciente" real do CRM é o Perfil 360º (`/perfil/?id=<lead_id>`), que é por lead; por isso o endpoint é por `lead_id` (a coluna existe em `pesquisas_satisfacao`). Só `requireAuth` + `rateLimit` (o Perfil é usado por CRC/comercial, não só gestores — mesmo nível de acesso do `/api/leads/:id`).
  - `/api/painel-gestor` passa a incluir `pesquisa: { nps_media, respostas, enviadas } | null`.

- [ ] **Step 1: Rotas do módulo**

```js
app.get('/api/pesquisa-satisfacao', requireAuth, requirePesquisa, rateLimit, async (req, res) => {
  try {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const from = re.test(req.query.from || '') ? req.query.from : hoje.slice(0, 8) + '01';
    const to = re.test(req.query.to || '') ? req.query.to : hoje;
    const { data: itens, error } = await supabase.from('pesquisas_satisfacao')
      .select('*')
      .gte('criado_em', from + 'T00:00:00-03:00')
      .lte('criado_em', to + 'T23:59:59-03:00')
      .order('criado_em', { ascending: false })
      .limit(1000);
    if (error) throw error;
    const resp = (itens || []).filter(i => i.status === 'respondido');
    const media = (campo) => {
      const vals = resp.map(i => i[campo]).filter(v => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    res.json({
      periodo: { from, to },
      resumo: {
        enviadas: (itens || []).filter(i => i.enviado_em).length,
        respondidas: resp.length,
        falhas: (itens || []).filter(i => i.status === 'falhou').length,
        taxa: (itens || []).filter(i => i.enviado_em).length
          ? resp.length / (itens || []).filter(i => i.enviado_em).length : null,
        nps_media: media('nps'),
        medias: {
          recepcao: media('avaliacao_recepcao'), dentista: media('avaliacao_dentista'),
          espera: media('avaliacao_espera'), limpeza: media('avaliacao_limpeza'),
          explicacoes: media('avaliacao_explicacoes'),
        },
      },
      itens: itens || [],
    });
  } catch (e) {
    console.error('❌ /api/pesquisa-satisfacao:', e.message);
    res.status(500).json({ error: 'Falha ao listar pesquisas' });
  }
});

app.get('/api/pesquisa-satisfacao/lead/:leadId', requireAuth, rateLimit, async (req, res) => {
  try {
    const leadId = parseInt(req.params.leadId, 10);
    if (Number.isNaN(leadId)) return res.status(400).json({ error: 'ID inválido' });
    const { data: itens, error } = await supabase.from('pesquisas_satisfacao')
      .select('*').eq('lead_id', leadId)
      .order('criado_em', { ascending: false }).limit(50);
    if (error) throw error;
    res.json({ itens: itens || [] });
  } catch (e) {
    res.status(500).json({ error: 'Falha ao buscar pesquisas do paciente' });
  }
});
```

- [ ] **Step 2: Card no `/api/painel-gestor`**

No `Promise.all` da rota (linha ~8590), adicionar ao final do array:

```js
      supabase.from('pesquisas_satisfacao').select('nps, status, enviado_em')
        .gte('criado_em', from + 'T00:00:00-03:00').lte('criado_em', to + 'T23:59:59-03:00').limit(2000),
```

Nomear o resultado `pesqR` na desestruturação (`const [totR, ..., agHR, pesqR] = ...`). Antes do `res.json`:

```js
    // Pesquisa de Satisfação do período
    const pesqRows = pesqR.data || [];
    const pesqResp = pesqRows.filter(p => p.status === 'respondido' && p.nps != null);
    const pesquisa = pesqRows.length ? {
      nps_media: pesqResp.length ? pesqResp.reduce((s, p) => s + p.nps, 0) / pesqResp.length : null,
      respostas: pesqResp.length,
      enviadas: pesqRows.filter(p => p.enviado_em).length,
    } : null;
```

E no objeto do `res.json`, acrescentar `pesquisa,` após `ocupacao`.

- [ ] **Step 3: Verificar sintaxe**

Run: `node --check server.js`
Expected: sem erro.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(pesquisa): API de listagem/ficha do paciente + card no painel do gestor"
```

---

### Task 7: Front — módulo `/pesquisa-satisfacao/`

**Files:**
- Create: `public/pesquisa-satisfacao/index.html`
- Create: `public/js/pesquisa-satisfacao/api.js`
- Create: `public/js/pesquisa-satisfacao/main.js`
- Modify: `public/js/nav-config.js` (item novo em `CRM_NAV`)

**Interfaces:**
- Consumes: `GET /api/pesquisa-satisfacao`, `POST /api/pesquisa-satisfacao/disparar` (Task 6/4).

- [ ] **Step 1: `api.js` (copiar o padrão de auth de outro módulo, ex.: `public/js/capi-saude/api.js`)**

Antes de escrever, abrir `public/js/capi-saude/api.js` (referência confirmada — `public/js/producao/` NÃO existe) e conferir se o padrão local diverge do abaixo — se divergir, seguir o padrão do repo. Implementação de referência:

```js
// API do módulo Pesquisa de Satisfação.
// Token: chave sb-{ref}-auth-token do localStorage (NUNCA k.includes('supabase')).
function _token() {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
      try { return JSON.parse(localStorage.getItem(k)).access_token || ''; } catch { return ''; }
    }
  }
  return '';
}

// Retry 1.5s/3s em 5xx — padrão das páginas principais do CRM.
async function _fetch(url, opts = {}, tentativa = 0) {
  const delays = [1500, 3000];
  const r = await fetch(url, {
    ...opts,
    headers: { 'Authorization': 'Bearer ' + _token(), 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (r.status >= 500 && tentativa < delays.length) {
    await new Promise(res => setTimeout(res, delays[tentativa]));
    return _fetch(url, opts, tentativa + 1);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  return data;
}

async function listarPesquisas(from, to) {
  return _fetch('/api/pesquisa-satisfacao?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to));
}

async function dispararHoje() {
  return _fetch('/api/pesquisa-satisfacao/disparar', { method: 'POST' });
}
```

- [ ] **Step 2: `index.html` + `main.js`**

Página com o padrão visual das outras páginas separadas (usar `public/capi-saude/index.html` como referência de estrutura/tema):
- `<script src="/js/shared-nav.js" data-active="pesquisa-satisfacao"></script>`
- Filtro de período (from/to, default mês corrente) + botão "Disparar pesquisas de hoje" (confirm() antes; POST e toast com "Disparo iniciado").
- Cards de resumo: nota de recomendação média (NPS 0–10), taxa de resposta (respondidas/enviadas), médias por categoria (recepção, dentista, espera, limpeza, explicações — escala 1 a 5), falhas.
- Tabela: data, paciente, dentista, origem (tratamento/avaliação), status, notas, comentário (célula expandível).
- Estados: carregando / vazio ("Nenhuma pesquisa no período") / erro com retry.

- [ ] **Step 3: Item no `CRM_NAV` (`public/js/nav-config.js`)**

Adicionar (junto dos módulos de gestão, após o item `painel-gestor`):

```js
    { slug: 'pesquisa-satisfacao', label: 'Pesquisa de Satisfação', icon: 'dashboard',
      roles: 'admin,gestor,mod_pesquisa_satisfacao', mode: 'link', href: '/pesquisa-satisfacao/' },
```

(Se houver ícone mais adequado já definido em `PATHS` — ex.: um de conversa/estrela — usar; não criar ícone novo sem necessidade.)

- [ ] **Step 4: Registro no módulo Usuários (`public/index.html`) — 3 lugares**

1. Checkbox em "Módulos Extras": `<label ...><input type="checkbox" id="nu-mod-pesquisa_satisfacao"> Pesquisa de Satisfação</label>`
2. `_ROLE_LABELS`: `mod_pesquisa_satisfacao: 'Pesquisa de Satisfação'`
3. `criarUsuario()`: `if (document.getElementById('nu-mod-pesquisa_satisfacao').checked) roles.push('mod_pesquisa_satisfacao');`

- [ ] **Step 5: Teste local**

Run: `node server.js` (com `.env` local) e abrir `http://localhost:3000/pesquisa-satisfacao/`.
Expected: página carrega, sidebar aparece com o item ativo, lista vazia sem erro no console.

- [ ] **Step 6: Commit**

```bash
git add public/pesquisa-satisfacao/ public/js/pesquisa-satisfacao/ public/js/nav-config.js public/index.html
git commit -m "feat(pesquisa): módulo /pesquisa-satisfacao/ com resumo, lista e disparo manual"
```

---

### Task 8: Ficha do paciente (Perfil 360º) + card visual no Painel do Gestor

**Files:**
- Modify: `public/perfil/index.html` (aba "Satisfação" + eventos no mapa `EV`)
- Modify: `public/js/painel/painel-gestor-page.js` (card + texto "entenda")

**Interfaces:**
- Consumes: `GET /api/pesquisa-satisfacao/lead/:leadId` (Task 6); campo `pesquisa` do `/api/painel-gestor` (Task 6).

Nota: a "ficha do paciente" do CRM é o **Perfil 360º** (`public/perfil/index.html`, aberto via `/perfil/?id=<lead_id>` — é o link do nome do paciente no Pacientes 2, que é só uma tabela sem ficha própria).

- [ ] **Step 1: Eventos do Trajeto no mapa `EV` (perfil, linha ~75)**

Sem isso os eventos aparecem como `['•', tipo]` cru. Adicionar ao objeto `EV`:

```js
  pesquisa_enviada:['📋','Pesquisa de Satisfação enviada'],
  pesquisa_respondida:['⭐','Respondeu a Pesquisa de Satisfação'],
```

- [ ] **Step 2: Aba "Satisfação" no Perfil 360º**

Em `renderHead(l)` (linha ~103), adicionar a aba e o painel junto dos existentes:

```html
<div class="tab" data-aba="pesq" onclick="trocarAba('pesq')" id="tab-pesq">⭐ Satisfação</div>
...
<div class="panel" data-aba="pesq"><div class="card" id="panel-pesq"><div class="empty">Carregando…</div></div></div>
```

E em `init()` (linha ~94), após `carregarClinicorp();`, chamar `carregarPesquisas();`. Implementar no mesmo estilo dos carregadores vizinhos:

```js
async function carregarPesquisas(){
  let r; try{ r=await api('/api/pesquisa-satisfacao/lead/'+id); }
  catch(e){ document.getElementById('panel-pesq').innerHTML='<div class="empty">Não foi possível carregar.</div>'; return; }
  const itens=r.itens||[];
  if(!itens.length){ document.getElementById('panel-pesq').innerHTML='<div class="empty">Nenhuma pesquisa de satisfação enviada para este paciente.</div>'; return; }
  document.getElementById('panel-pesq').innerHTML=itens.map(p=>{
    const cat=(rot,v)=>v!=null?`<div class="rx"><div class="l">${rot}</div><div class="v">${v}/5</div></div>`:'';
    if(p.status!=='respondido') return `<div class="ev"><div class="d">${fmtData(p.enviado_em||p.criado_em)}</div>
      <div class="t">Pesquisa ${p.status==='falhou'?'com falha de envio':'enviada, aguardando resposta'}</div></div>`;
    return `<div class="ev"><div class="d">${fmtData(p.respondido_em)}</div>
      <div class="t">Nota de recomendação: <strong>${p.nps!=null?p.nps+'/10':'—'}</strong></div>
      <div class="raiox">${cat('Recepção',p.avaliacao_recepcao)}${cat('Dentista',p.avaliacao_dentista)}${cat('Espera',p.avaliacao_espera)}${cat('Limpeza',p.avaliacao_limpeza)}${cat('Explicações',p.avaliacao_explicacoes)}</div>
      ${p.comentario?`<div class="desc">"${esc(p.comentario)}"</div>`:''}</div>`;
  }).join('');
}
```

(Conferir as classes CSS usadas — `ev`, `rx`, `raiox`, `desc`, `empty` já existem na página; se alguma não se aplicar bem visualmente, ajustar com o CSS local da página.)

- [ ] **Step 3: Card no Painel do Gestor**

Em `public/js/painel/painel-gestor-page.js`:

1. No objeto de textos "entenda" (linha ~62, junto de `ocupacao`), adicionar:

```js
    pesquisa: { oque: 'Nota de recomendação média (0 a 10) das pesquisas de satisfação respondidas no período, enviadas por WhatsApp após o atendimento.',
      conta: 'Média do campo "recomendação" das respostas. Verde ≥ 9, amarelo ≥ 7, vermelho < 7.' },
```

2. Onde os cards do grupo de operação são montados (junto de `ocupacao`, linha ~234):

```js
    const pq = fin && fin.pesquisa;
    if (pq && pq.respostas > 0) {
      const sevPq = pq.nps_media >= 9 ? 'verde' : pq.nps_media >= 7 ? 'amarelo' : 'vermelho';
      cards.b.push(cardHTML('pesquisa', { label: 'Satisfação dos pacientes', sev: sevPq,
        val: pq.nps_media.toFixed(1), nota: pq.respostas + ' resposta' + (pq.respostas > 1 ? 's' : '') +
        ' de ' + pq.enviadas + ' enviadas', modulo: 'Pesquisa de Satisfação' }));
    } else {
      cards.b.push(cardHTML('pesquisa', { label: 'Satisfação dos pacientes', sev: 'neutro', val: '–',
        nota: 'Sem respostas no período', modulo: 'Pesquisa de Satisfação' }));
    }
```

⚠️ Conferir a assinatura real de `cardHTML` (linha 132) e o shape dos objetos vizinhos — replicar exatamente (ex.: se `modulo` não existir como campo, omitir).

- [ ] **Step 4: Teste local**

Abrir `http://localhost:3000/?page=painel-gestor` logado como gestor (card "Satisfação dos pacientes" neutro, "Sem respostas no período") e `/perfil/?id=<um lead qualquer>` (aba "⭐ Satisfação" com estado vazio, sem erro no console).

- [ ] **Step 5: Commit**

```bash
git add public/perfil/index.html public/js/painel/painel-gestor-page.js
git commit -m "feat(pesquisa): aba Satisfação no Perfil 360º + card no painel do gestor"
```

---

### Task 9: Merge, deploy e validação ponta-a-ponta

**Files:** nenhum novo — integração e validação.

- [ ] **Step 1: Rodar a suíte completa**

Run: `npm test && node --test whatsapp.test.js && node --check server.js`
Expected: tudo PASS/sem erro.

- [ ] **Step 2: Merge fast-forward em main e push**

```bash
# no worktree do branch:
git push origin feat/pesquisa-satisfacao
git fetch origin
# se origin/main avançou durante o trabalho, rebase antes:
git rebase origin/main
git push origin feat/pesquisa-satisfacao:main
```

- [ ] **Step 3: Deploy**

```bash
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```

Aguardar ~2 min e conferir logs do serviço no Easypanel: deve aparecer `[pesquisa] scheduler self-healing ativo (janela 19:00-23:59 BRT)`.

- [ ] **Step 4: Validação real (com o Luiz)**

1. **Envio de teste:** inserir manualmente na Clinicorp não é viável — em vez disso, chamar `POST /api/pesquisa-satisfacao/disparar` num dia com atendimentos OU testar o envio isolado com um script one-off no container apontando para o telefone do Luiz (`whatsapp.enviarBroadcast({ para: '<telefone do Luiz>', templateName: 'pesquisa_nps' })`). Se a Meta retornar erro exigindo parâmetro do botão de Flow, adicionar em `whatsapp.js` a função `enviarTemplateFlow` com o componente `{ type: 'button', sub_type: 'flow', index: '0', parameters: [{ type: 'action', action: { flow_token: 'unused' } }] }` e usar no job no lugar de `enviarBroadcast`.
2. **Resposta:** Luiz responde o Flow no celular; conferir no Supabase a linha em `pesquisas_satisfacao` com `status='respondido'` e notas preenchidas.
3. **Thread + Trajeto:** conferir no CRM que a conversa mostra o template enviado e "📋 Respondeu a Pesquisa de Satisfação", e que o Trajeto do lead tem `pesquisa_enviada`/`pesquisa_respondida`.
4. **Módulo e painel:** abrir `/pesquisa-satisfacao/` (resumo reflete o teste) e o Painel do Gestor (card com a nota).
5. **1ª semana:** acompanhar se as avaliações de Marcos/Matheus entram (depende do check-in/status na agenda) — pendência registrada na spec.

- [ ] **Step 5: Atualizar memória/STATUS**

Registrar no `STATUS.md` do Desktop e na memória do projeto: módulo no ar, pendências de validação.
