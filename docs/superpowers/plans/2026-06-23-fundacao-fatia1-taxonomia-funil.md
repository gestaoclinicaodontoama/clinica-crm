# Fundação — Fatia 1: Taxonomia Canônica do Funil + Carteira Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir as 3 taxonomias de status conflitantes por **um conjunto canônico de estágios** na tabela `leads`, e introduzir os atributos paralelos `carteira` e `motivo_perda` + o estado transversal `estado_frio`, para que o funil passe a contar certo (Dra. Izabela e base importada fora dos números ativos).

**Architecture:** Migração de dados em produção (Supabase, tabela `leads` com 15.816 linhas) via `apply_migration`, seguida de ajustes no monólito `server.js` (constante `FUNIL`, validação de `patchLead`, agregação do funil) e no `public/index.html` (mapeamento visual do funil). Sem tabelas novas — a separação Pessoa/Oportunidade é a Fatia 2. Cada passo de dados é precedido por uma query de verificação (snapshot antes) e seguido por verificação (invariantes depois).

**Tech Stack:** Supabase Postgres (MCP `apply_migration` / `execute_sql`, project `mtqdpjhhqzvuklnlfpvi`), Node.js + Express (`server.js`), HTML/JS vanilla (`public/index.html`).

**Decisões da Fatia 1 (do brainstorm + dados reais):**
- **Estágios canônicos:** `Novo`, `Em qualificação`, `Avaliação agendada`, `Compareceu`, `Em negociação`, `Fechou`, `Perdido`.
- **`carteira`** (text, default `'Comercial'`): valor `'Dra. Izabela'` sai do funil/metas.
- **`motivo_perda`** (text, null): preenchido ao virar `Perdido`.
- **`estado_frio`** (text, null): `'nunca_agendou'` (❄️) ou `'orcou_sem_fechar'` (💸) — deriva a aba Reativação. (A automação de "esfriar por inatividade" é fatia futura; aqui só semeamos o estado a partir do histórico.)
- **Base 13k:** `Nutrir` importado **sem nenhum marco** → `estado_frio='nunca_agendou'`, stage `Novo`. Quem tiver marco fica de fora dessa regra.

**Mapa de migração de `status` (origem → destino), baseado na distribuição real:**

| Status atual | n | → status novo | extra |
|---|---|---|---|
| Nutrir (importado, sem marco) | ~13.044 | Novo | `estado_frio='nunca_agendou'` |
| Nutrir (com algum marco) | ~110 | (ver Task 5 regra) | — |
| Compareceu | 1.436 | Compareceu | — |
| Fechou | 621 | Fechou | — |
| Lead | 247 | Novo | — |
| Não tem Interesse | 137 | Perdido | `motivo_perda='Sem interesse'` |
| Reclassificar | 103 | Novo | — |
| Agendado | 52 | Avaliação agendada | — |
| Em conversa - Lead Qualificado | 26 | Em qualificação | — |
| Dra. Izabela | 25 | Em qualificação | `carteira='Dra. Izabela'` |
| Faltou | 13 | Em qualificação | — (precisa reagendar) |
| Em nutrição | 2 | Em negociação | `estado_frio='orcou_sem_fechar'` |

> Estágios `Orçado`/`D0..D5` não existem nos dados (código morto) — sem linhas a migrar, mas o mapa do código os cobre por segurança.

---

## Pré-requisito: branch de trabalho

- [ ] **Step 0a: Garantir branch isolado (worktrees concorrentes na `main`)**

Run:
```bash
cd "/c/Users/Luiz Martins/Desktop/Projeto Claude Code/clinica-crm"
git branch --show-current
```
Se for `main`, criar branch:
```bash
git checkout -b fundacao-fatia1-taxonomia
```
Expected: branch `fundacao-fatia1-taxonomia` ativo.

---

## Task 1: Snapshot de segurança da tabela `leads`

**Files:**
- Nenhum arquivo de código — operação de banco via MCP Supabase.

- [ ] **Step 1: Criar tabela de backup completa antes de qualquer alteração**

Aplicar migração (MCP `apply_migration`, name `backup_leads_pre_fatia1`):
```sql
create table public.leads_backup_pre_fatia1 as table public.leads;
```

- [ ] **Step 2: Verificar que o backup tem o mesmo total**

Run (MCP `execute_sql`):
```sql
select
  (select count(*) from public.leads) as leads,
  (select count(*) from public.leads_backup_pre_fatia1) as backup;
```
Expected: `leads` e `backup` iguais (15.816 ou o total corrente).

- [ ] **Step 3: Salvar snapshot da distribuição atual de status (para conferência final)**

Run (MCP `execute_sql`) e **guardar a saída no PR/commit**:
```sql
select status, count(*) n,
  count(*) filter (where importado_historico) importados,
  count(data_agendamento) tem_agend,
  count(data_orcamento) tem_orc
from public.leads group by status order by n desc;
```
Expected: a distribuição conhecida (Nutrir ~13.154, Compareceu 1.436, etc.).

---

## Task 2: Adicionar colunas `carteira`, `motivo_perda`, `estado_frio`

**Files:**
- Banco via MCP Supabase (migração `add_carteira_motivo_frio`).

- [ ] **Step 1: Verificar que as colunas ainda não existem (deve falhar/retornar vazio)**

Run (MCP `execute_sql`):
```sql
select column_name from information_schema.columns
where table_schema='public' and table_name='leads'
and column_name in ('carteira','motivo_perda','estado_frio');
```
Expected: 0 linhas.

- [ ] **Step 2: Aplicar migração das colunas**

Aplicar migração (MCP `apply_migration`, name `add_carteira_motivo_frio`):
```sql
alter table public.leads
  add column carteira text not null default 'Comercial',
  add column motivo_perda text,
  add column estado_frio text;

comment on column public.leads.carteira is 'Comercial (entra no funil/metas) ou Dra. Izabela (fora). Fatia 1.';
comment on column public.leads.estado_frio is 'null | nunca_agendou (❄️) | orcou_sem_fechar (💸). Deriva aba Reativação.';
```

- [ ] **Step 3: Verificar colunas criadas com default aplicado**

Run (MCP `execute_sql`):
```sql
select count(*) total, count(*) filter (where carteira='Comercial') comercial
from public.leads;
```
Expected: `total` = `comercial` (todas começam como Comercial).

---

## Task 3: Migrar a carteira `Dra. Izabela`

**Files:**
- Banco via MCP Supabase (migração `migrate_carteira_izabela`).

- [ ] **Step 1: Conferir quantos vão virar carteira (esperado 25)**

Run (MCP `execute_sql`):
```sql
select count(*) from public.leads where status='Dra. Izabela';
```
Expected: 25.

- [ ] **Step 2: Aplicar migração da carteira**

Aplicar migração (MCP `apply_migration`, name `migrate_carteira_izabela`):
```sql
update public.leads
set carteira='Dra. Izabela', status='Em qualificação'
where status='Dra. Izabela';
```

- [ ] **Step 3: Verificar resultado**

Run (MCP `execute_sql`):
```sql
select count(*) filter (where carteira='Dra. Izabela') na_carteira,
       count(*) filter (where status='Dra. Izabela') sobrou_status
from public.leads;
```
Expected: `na_carteira` = 25, `sobrou_status` = 0.

---

## Task 4: Semear `estado_frio` 'orcou_sem_fechar' (Em nutrição)

**Files:**
- Banco via MCP Supabase (migração `seed_frio_orcou`).

- [ ] **Step 1: Conferir alvo (Em nutrição, esperado 2)**

Run (MCP `execute_sql`):
```sql
select count(*) from public.leads where status='Em nutrição';
```
Expected: 2.

- [ ] **Step 2: Aplicar migração**

Aplicar migração (MCP `apply_migration`, name `seed_frio_orcou`):
```sql
update public.leads
set estado_frio='orcou_sem_fechar', status='Em negociação'
where status='Em nutrição';
```

- [ ] **Step 3: Verificar**

Run (MCP `execute_sql`):
```sql
select count(*) from public.leads where estado_frio='orcou_sem_fechar';
```
Expected: 2.

---

## Task 5: Semear `estado_frio` 'nunca_agendou' (base 13k) — respeitando "se nunca vieram"

**Files:**
- Banco via MCP Supabase (migração `seed_frio_nunca_agendou`).

- [ ] **Step 1: Conferir alvo — Nutrir SEM nenhum marco (nunca veio)**

Run (MCP `execute_sql`):
```sql
select count(*) from public.leads
where status='Nutrir'
  and data_agendamento is null
  and data_comparecimento is null
  and data_avaliacao is null
  and data_orcamento is null
  and data_fechamento is null
  and clinicorp_appointment_id is null;
```
Expected: ~13.040+ (a base que nunca veio). **Anotar o número exato.**

- [ ] **Step 2: Aplicar migração (só os sem marco viram frio + Novo)**

Aplicar migração (MCP `apply_migration`, name `seed_frio_nunca_agendou`):
```sql
update public.leads
set estado_frio='nunca_agendou', status='Novo'
where status='Nutrir'
  and data_agendamento is null
  and data_comparecimento is null
  and data_avaliacao is null
  and data_orcamento is null
  and data_fechamento is null
  and clinicorp_appointment_id is null;
```

- [ ] **Step 3: Verificar — sobra de 'Nutrir' COM marco (tratada na Task 6)**

Run (MCP `execute_sql`):
```sql
select count(*) filter (where estado_frio='nunca_agendou') frios,
       count(*) filter (where status='Nutrir') nutrir_restante
from public.leads;
```
Expected: `frios` ≈ número do Step 1; `nutrir_restante` = poucas dezenas (as que têm algum marco).

- [ ] **Step 4: Remapear os 'Nutrir' que TÊM marco (vieram em algum momento) pelo estágio mais avançado**

Aplicar migração (MCP `apply_migration`, name `remap_nutrir_com_marco`):
```sql
update public.leads set status = case
  when data_fechamento   is not null then 'Fechou'
  when data_orcamento    is not null then 'Em negociação'
  when data_comparecimento is not null or data_avaliacao is not null then 'Compareceu'
  when data_agendamento  is not null then 'Avaliação agendada'
  when clinicorp_appointment_id is not null then 'Compareceu'
  else 'Novo'
end
where status='Nutrir';
```

- [ ] **Step 5: Verificar que não sobrou nenhum 'Nutrir'**

Run (MCP `execute_sql`):
```sql
select count(*) nutrir_restante from public.leads where status='Nutrir';
```
Expected: `nutrir_restante` = 0.

---

## Task 6: Remapear os status restantes para o conjunto canônico

**Files:**
- Banco via MCP Supabase (migração `remap_status_canonico`).

- [ ] **Step 1: Ver o que ainda não é canônico**

Run (MCP `execute_sql`):
```sql
select status, count(*) n from public.leads
where status not in ('Novo','Em qualificação','Avaliação agendada','Compareceu','Em negociação','Fechou','Perdido')
group by status order by n desc;
```
Expected: `Lead`, `Não tem Interesse`, `Reclassificar`, `Agendado`, `Em conversa - Lead Qualificado`, `Faltou`, e possíveis `Orçado`/`D0..D5` (0). (`Nutrir` já foi 100% tratado na Task 5.)

- [ ] **Step 2: Aplicar migração de remapeamento**

Aplicar migração (MCP `apply_migration`, name `remap_status_canonico`):
```sql
-- Perdidos por desinteresse (com motivo)
update public.leads set status='Perdido', motivo_perda='Sem interesse'
  where status='Não tem Interesse';

-- Entradas do funil
update public.leads set status='Novo' where status in ('Lead','Reclassificar');
update public.leads set status='Em qualificação' where status in ('Em conversa - Lead Qualificado','Faltou');
update public.leads set status='Avaliação agendada' where status='Agendado';
update public.leads set status='Em negociação' where status in ('Orçado','D0','D1','D2','D3','D4','D5');
-- 'Compareceu','Fechou' já são canônicos; nada a fazer.
```

- [ ] **Step 3: Verificar que 100% dos status são canônicos**

Run (MCP `execute_sql`):
```sql
select count(*) fora_do_canon from public.leads
where status not in ('Novo','Em qualificação','Avaliação agendada','Compareceu','Em negociação','Fechou','Perdido');
```
Expected: `fora_do_canon` = 0.

- [ ] **Step 4: Conferir distribuição final + invariante de total**

Run (MCP `execute_sql`):
```sql
select
  (select count(*) from public.leads) total_agora,
  (select count(*) from public.leads_backup_pre_fatia1) total_backup,
  (select count(*) from public.leads where estado_frio is not null) frios,
  (select count(*) from public.leads where carteira='Dra. Izabela') izabela;
```
Expected: `total_agora` = `total_backup` (nenhuma linha perdida).

---

## Task 7: Atualizar a constante `FUNIL` e a validação no `server.js`

**Files:**
- Modify: `server.js:69` (constante `FUNIL`)
- Modify: `server.js` (`EVENTOS_FUNIL`, ~linha 2561)
- Modify: `server.js` (validação em `patchLead`, ~linha 681)

- [ ] **Step 1: Trocar a constante `FUNIL` pelo conjunto canônico**

Em `server.js:69`, substituir a linha:
```js
const FUNIL = ['Lead', 'Dra. Izabela', 'Em conversa - Lead Qualificado', 'Agendado', 'Faltou', 'Compareceu', 'Orçado', 'Nutrir', 'Não tem Interesse', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'Reclassificar', 'Em nutrição', 'Fechou', 'Perdido'];
```
por:
```js
const FUNIL = ['Novo', 'Em qualificação', 'Avaliação agendada', 'Compareceu', 'Em negociação', 'Fechou', 'Perdido'];
const CARTEIRAS = ['Comercial', 'Dra. Izabela'];
const ESTADOS_FRIO = ['nunca_agendou', 'orcou_sem_fechar'];
```

- [ ] **Step 2: Atualizar `EVENTOS_FUNIL` (mapa do CAPI Meta) PRESERVANDO os eventos + travar leads importados**

⚠️ **CRÍTICO — CAPI.** O objeto `EVENTOS_FUNIL` (`server.js:2561`) é o **mapa do CAPI**: decide qual evento a Meta recebe em cada etapa. As chaves usam os nomes ANTIGOS de status. Renomear os status sem atualizar aqui **quebra o CAPI**. Substituir o objeto inteiro por (mesmos eventos Meta, nomes de status canônicos):
```js
const EVENTOS_FUNIL = {
  'Novo':               'LeadSubmitted',   // era 'Lead'
  'Em qualificação':    'LeadQualified',   // era 'Em conversa - Lead Qualificado'
  'Avaliação agendada': 'Schedule',        // era 'Agendado'
  'Compareceu':         'Contact',
  'Em negociação':      null,              // era 'Orçado'/'D0-D5' (já eram null)
  'Fechou':             'Purchase',
  'Perdido':            null,
};
```
Os eventos enviados à Meta (LeadSubmitted/LeadQualified/Schedule/Contact/Purchase) ficam **idênticos** — só muda o nome do status que os aciona. A config do lado da Meta (Pixel, dataset linha ~2614, token, page_id) **não é tocada**.

Em seguida, no início de `dispararConversaoMeta` (logo após a checagem de `PIXEL`/`TOKEN`, ~linha 2587), adicionar a trava para os importados antigos não dispararem CAPI numa edição futura:
```js
  if (lead.importado_historico) { console.log('⏭️  Lead importado #' + lead.id + ' não dispara CAPI'); return; }
```

- [ ] **Step 3: Ajustar os efeitos colaterais de `patchLead` para os novos estágios**

Em `patchLead` (~linha 681), os blocos que setavam datas por status usam nomes antigos (`'Agendado'`, `'D0'`, `'Em nutrição'`). Atualizar para:
```js
if (v === 'Avaliação agendada' && !lead.data_agendamento) patch.data_agendamento = agora;
if (v === 'Avaliação agendada') { patch.crc_agendamento_id = req.user?.id || null; patch.crc_agendamento_nome = req.user?.profile?.nome || null; }
if (v === 'Compareceu' && !lead.data_comparecimento) patch.data_comparecimento = agora;
if (v === 'Em negociação' && !lead.data_avaliacao) patch.data_avaliacao = agora;
if (v === 'Em negociação' && !lead.data_orcamento) patch.data_orcamento = agora;
if (v === 'Fechou' && !lead.data_fechamento) patch.data_fechamento = agora;
```

- [ ] **Step 4: Permitir `carteira` e `motivo_perda` no `ALLOWED` do patch**

No array `ALLOWED` de `patchLead`, adicionar `'carteira'`, `'motivo_perda'`. Após a lista existente:
```js
const ALLOWED = [
  'nome','telefone','email','origem','status','valor','tipo_trat',
  'notas_sdr','notas_avaliacao','notas_comercial',
  'score_interesse','perfil_disc','etiquetas',
  'proximo_contato','ultimo_contato',
  'crc_comercial_id','crc_comercial_nome',
  'crc_agendamento_id','crc_agendamento_nome',
  'carteira','motivo_perda',
];
```
E validar carteira logo após a validação de status:
```js
if (k === 'carteira' && !CARTEIRAS.includes(v)) return res.status(400).json({ error: 'Carteira inválida' });
```

- [ ] **Step 5: Reiniciar o server local e checar boot sem erro**

Run:
```bash
cd "/c/Users/Luiz Martins/Desktop/Projeto Claude Code/clinica-crm"
node --check server.js && echo "OK: sintaxe válida"
```
Expected: `OK: sintaxe válida` (sem `SyntaxError`). `node --check` valida sem iniciar o servidor.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(funil): FUNIL canônico (7 estágios) + carteira/motivo_perda no patchLead"
```

---

## Task 8: Excluir carteira `Dra. Izabela` e frios da contagem ATIVA do funil

**Files:**
- Modify: `server.js` (endpoint de agregação por status, ~linha 779 `porStatus`)

- [ ] **Step 1: Localizar a agregação do funil**

Run:
```bash
grep -n "porStatus\|statusMap" server.js | head
```

- [ ] **Step 2: Filtrar a base ativa**

No cálculo de `porStatus`/`statusMap`, restringir a leads ativos comerciais. A query/loop deve considerar apenas:
```js
// somente funil ativo: carteira Comercial, sem estado_frio
// (frios e carteira Dra. Izabela ficam em visões próprias)
.eq('carteira', 'Comercial')
.is('estado_frio', null)
```
Aplicar o mesmo filtro onde o funil/contagem é montado (Supabase query builder). Manter um parâmetro para visões que QUEREM ver frios (aba Reativação) — não remover o dado, só separar a contagem ativa.

- [ ] **Step 3: Verificar via endpoint**

Run (com server local rodando):
```bash
curl -s "http://localhost:3000/api/leads/funil" -H "Authorization: Bearer <token>" | head
```
Expected: a soma do funil ativo **não** inclui os ~13k frios nem os 25 da Izabela. (Se não houver token à mão, validar pela query SQL equivalente.)

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(funil): contagem ativa exclui carteira Dra. Izabela e leads frios"
```

---

## Task 9: Atualizar o funil visual e os badges no `public/index.html`

**Files:**
- Modify: `public/index.html` (`FUNIL_ETAPAS` ~linha 1808, `classBadge`, exibição de carteira/frio)

- [ ] **Step 1: Substituir `FUNIL_ETAPAS` pelos estágios canônicos**

Localizar `const FUNIL_ETAPAS = [` e substituir por:
```js
const FUNIL_ETAPAS = [
  { label:'Novo',               match:['Novo'] },
  { label:'Em qualificação',    match:['Em qualificação'] },
  { label:'Avaliação agendada', match:['Avaliação agendada'] },
  { label:'Compareceu',         match:['Compareceu'] },
  { label:'Em negociação',      match:['Em negociação'] },
  { label:'Fechou',             match:['Fechou'] },
];
const FUNIL_CORES = {
  'Novo':'#4f8ef7','Em qualificação':'#8b9467','Avaliação agendada':'#f59e0b',
  'Compareceu':'#a855f7','Em negociação':'#06b6d4','Fechou':'#22c55e',
};
```

- [ ] **Step 2: Garantir que o filtro do funil visual ignore frios e carteira Izabela**

No `renderFunil()`, ao montar `counts`, filtrar a base:
```js
const leads = _funilLeads.filter(l => l.carteira === 'Comercial' && !l.estado_frio);
```
(Os perdidos e a aba Reativação seguem tratados à parte, como hoje os perdidos já são.)

- [ ] **Step 3: Mostrar selo de carteira no modal do lead**

No `resumo-card` de `abrirModal`, adicionar a linha de carteira após Status:
```js
<div class="resumo-item"><span class="l">Carteira</span><span class="v">${escHtml(l.carteira || 'Comercial')}</span></div>
```

- [ ] **Step 4: Verificação visual manual**

Run:
```bash
cd "/c/Users/Luiz Martins/Desktop/Projeto Claude Code/clinica-crm" && node server.js
```
Abrir `http://localhost:3000`, página Funil. Conferir: 6 barras canônicas; total do funil ~ centenas (não 15 mil); badges de status renderizam sem `undefined`.
Expected: funil limpo, sem os 13k frios inflando.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(funil): visual com estágios canônicos + selo de carteira"
```

---

## Task 10: Caçar referências a status antigos no resto do código

**Files:**
- Modify: arquivos em `public/` e `server.js` que ainda citem status antigos (kanban-comercial, dashboard, atribuição, etc.)

- [ ] **Step 1: Localizar todas as referências aos status antigos**

Run:
```bash
cd "/c/Users/Luiz Martins/Desktop/Projeto Claude Code/clinica-crm"
grep -rnE "Nutrir|Em nutrição|'Agendado'|\"Agendado\"|Não tem Interesse|Reclassificar|Em conversa - Lead Qualificado|'Lead'|Orçado|'D[0-5]'" public/ server.js | grep -v node_modules
```
Expected: uma lista de ocorrências (filtros de kanban, dashboards, labels). Anotar cada arquivo:linha.

- [ ] **Step 2: Corrigir cada ocorrência para o nome canônico**

Para cada resultado do Step 1, trocar pelo equivalente canônico (`Lead`→`Novo`, `Agendado`→`Avaliação agendada`, `Orçado`/`D0-5`→`Em negociação`, `Nutrir`/`Em nutrição`→tratar como estado_frio/Reativação). Se uma página filtra por status, ajustar para os 7 canônicos. **Não** alterar `lead_eventos` (histórico) nem textos de migração já aplicados.

- [ ] **Step 3: Confirmar que não sobrou referência viva**

Run o mesmo grep do Step 1.
Expected: apenas ocorrências aceitáveis (comentários, histórico) — nenhum filtro/label de UI usando nome antigo.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix(funil): atualiza referências de status antigos em telas e rotas"
```

---

## Task 11: Conferência final e deploy

**Files:**
- Nenhum — verificação + deploy.

- [ ] **Step 1: Invariante final no banco**

Run (MCP `execute_sql`):
```sql
select status, count(*) n,
  count(*) filter (where estado_frio is not null) frios,
  count(*) filter (where carteira='Dra. Izabela') izabela
from public.leads group by status order by n desc;
```
Expected: só os 7 status canônicos; soma total = backup; ~13k com `estado_frio`.

- [ ] **Step 2: Merge na main (worktree isolado) e deploy**

```bash
git checkout main && git merge --no-ff fundacao-fatia1-taxonomia
git push
curl -s -X POST "http://2.24.94.120:3000/api/deploy/64e3f591d5f8f89c7d01ddc665d41609a5259db3bbe968e6"
```
Expected: deploy disparado no Easypanel.

- [ ] **Step 3: Smoke test em produção**

Abrir a URL pública, página Funil + abrir um lead. Confirmar funil limpo e que editar status de um lead salva (valida `patchLead` com `FUNIL` novo).

---

## Notas para a Fatia 2 (não implementar aqui)
- Separação `Pessoa` + `Oportunidade` (tabelas novas, migração de FK, conversa ligada ao número/família).
- Automação de "esfriar por inatividade" + aba Reativação como tela (aqui só semeamos `estado_frio`).
- Corrigir `lead_id` NULL em `avaliacoes`/`orcamentos` e reconciliar `valor`.
- Segurança: RLS desativado em 18 tabelas (plano próprio).
