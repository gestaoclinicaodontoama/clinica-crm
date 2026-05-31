# Dashboard Comercial — Design (v1)

**Data:** 2026-05-31
**Status:** Aprovado para escrever plano de implementação
**Origem:** Replicar o painel comercial do CRM antigo (appcrc.com.br) dentro do CRM novo, com melhorias.

---

## 1. Contexto

O time comercial (CRC) acompanha o funil da clínica no CRM antigo (appcrc), onde **lançava manualmente** o orçamento de cada pessoa que fez avaliação. Queremos a mesma visão — e melhor — no CRM novo, **automatizando** o que era manual ao puxar os dados da Clinicorp.

O funil é **avaliação-cêntrico**: lead → agendou avaliação → compareceu → orçamento fechado. As avaliações são feitas por dentistas avaliadores específicos (hoje Marcos e Matheus; o time pode crescer). Volume baixo: **2–6 avaliações por período (manhã/tarde), máx ~10/dia** — dezenas por mês.

### Realidade dos dados (verificada em 2026-05-31)
- `pacientes`: 21.326 linhas / `pacientes_abc`: 7.756 — base Clinicorp rica.
- `leads`: **8 linhas** — topo do funil esparso (appcrc ainda é o CRM ativo). Enche quando o import histórico do appcrc rodar (sub-projeto separado).
- O sync atual **só guarda resumos por paciente** (última visita, último pagamento sem valor, "tem orçamento aberto" sem valor). **Não persiste** agendamentos/orçamentos linha a linha — então a matéria-prima do funil precisa passar a ser gravada.

### API Clinicorp (verificada por sondagem read-only)
- `GET /appointment/list?from=&to=` → traz cada agendamento com `Dentist_PersonId`, `Patient_PersonId`, `date`, `StatusId`, `PatientConfirm`, `PatientMessage` ("CONFIRMADO"), `MobilePhone`, `ProfessionalName`. **Comparecimento é derivável** de StatusId/confirmação.
- `GET /estimates/list?from=&to=` → traz cada orçamento: `id`, `Amount`, `Status` (`APPROVED`/`OPEN`), `CreateDate`, `ProfessionalName`, `PatientId`, `PatientName`, `PatientMobilePhone`, `TreatmentId`, `ProcedureList`. (321 no período testado: 192 APPROVED, 129 OPEN.)
- `GET /patient/list_estimates?from=&to=` → agregado do período (Approved/Open/Rejected qty + total amount). Útil como conferência.
- **Não disponível** em estimates: campos de **desconto** e **valor de entrada** (só `Amount`). Entrada é conceito de pagamento/contrato → outro endpoint financeiro, ainda não mapeado.
- Limite: **25 req/hora** por conta. Como o volume é baixo e os dados são persistidos pelo sync, o dashboard lê do Supabase e **não** é afetado pelo limite.

---

## 2. Objetivo

Página `/comercial/` no CRM que mostra o funil comercial com filtro de período e quebra por campanha, em **duas visões lado a lado**:
- **Toda a clínica (por avaliador)** — todas as avaliações dos dentistas avaliadores, independente da origem. Tem dados hoje.
- **Leads rastreados (por campanha)** — recorte das avaliações cujo paciente casa com um lead rastreado do CRM. Esparso hoje, cresce com tracking + import.

---

## 3. Escopo

### No v1 (12 cards, igual appcrc)
**Funil:** (1) Total de leads criados · (2) Total de agendamentos · (3) % de agendamentos · (4) Total e % de leads agendados · (5) Total de comparecimentos · (6) % de comparecimentos · (7) Total de fechamentos · (8) % de fechamentos.
**Valores:** (9) Valor total de oportunidades · (10) Valor total de fechamentos · (11) Ticket médio · (12) Taxa de conversão de vendas.

**Filtros/controles:** período (data início/fim) · seletor de origem/campanha · alternância de visão (clínica / leads rastreados — exibidas lado a lado).

### Fora do v1 (fase 2)
- **Total de desconto aplicado** e **Valor de entrada** (dependem de endpoint financeiro não mapeado).
- Seção "Metas e vendas" do appcrc.
- Quebra detalhada por profissional como tela própria.
- Import histórico do appcrc (sub-projeto separado; quando rodar, popula `leads` e enriquece a visão de leads rastreados retroativamente).
- Tela de edição da config de avaliadores (no v1 a config existe como tabela; edição via UI pode vir depois).

---

## 4. Arquitetura (abordagem A — calcular on-read sobre dados persistidos)

```
Clinicorp API ──(sync estendido)──> Supabase (tabelas pequenas do funil)
                                          │
                       GET /api/comercial/funil  (agrega por período/origem/visão)
                                          │
                                  Página /comercial/  (cards + filtros)
```

Decisão: **persistir** os dados do funil em tabelas pequenas (via sync) em vez de chamar a Clinicorp a cada carga. Motivos: habilita as duas visões e a quebra por campanha (joins), leitura instantânea, e não acopla o painel ao limite de 25 req/h. Volume é baixo, então persistir linha a linha é trivial.

### 4.1 Camada de dados (extensão do sync `sync/clinicorp-sync.js`)
Novas tabelas no Supabase:

- **`avaliacoes`** — uma linha por agendamento de avaliação (dentista avaliador):
  - `clinicorp_appointment_id` (PK natural), `paciente_clinicorp_id`, `telefone` (normalizado), `dentista_nome`, `dentista_clinicorp_id`, `data`, `compareceu` (bool, derivado de StatusId/PatientConfirm), `status_raw`, `lead_id` (nullable, FK → leads, por telefone), `atualizado_em`.
- **`orcamentos`** — uma linha por orçamento (estimate):
  - `clinicorp_estimate_id` (PK natural), `treatment_id`, `paciente_clinicorp_id`, `telefone` (normalizado), `profissional_nome`, `valor` (Amount), `status` (`APPROVED`/`OPEN`/outros), `data_criacao`, `lead_id` (nullable, por telefone), `atualizado_em`.
- **`config_avaliadores`** — lista de dentistas avaliadores:
  - `id`, `clinicorp_id` (nullable), `nome` (como aparece em ProfessionalName/Dentist), `ativo` (bool), `criado_em`. Seed inicial: Marcos e Matheus (nomes exatos confirmados na implementação, pois "Marcos Vinícius Coelho Vidigal Martins" e "Matheus G. - Execução" aparecem nos dados — validar com o usuário quais registros são os avaliadores).

Extensão do sync (roda na cadência atual):
1. `/appointment/list` (janela de período relevante) → filtra agendamentos cujos dentistas estão em `config_avaliadores` → upsert em `avaliacoes`, derivando `compareceu`.
2. `/estimates/list` (mesma janela) → upsert em `orcamentos`.
3. Resolve `lead_id` por telefone normalizado (match com `leads.telefone`) em ambas as tabelas.

> RLS: `avaliacoes`, `orcamentos`, `config_avaliadores` devem nascer com RLS habilitado + policy de leitura para os roles autorizados (não repetir o problema de `lead_eventos`/`anuncios`, hoje com RLS desabilitado).

### 4.2 Backend
- `GET /api/comercial/funil?from=YYYY-MM-DD&to=YYYY-MM-DD&origem=<campanha|all>` (em `server.js`).
- Middleware de role: `requireRole('admin', 'comercial', 'mod_comercial')` (criar role/módulo conforme padrão do CLAUDE.md).
- Calcula e devolve JSON com os 12 cards **para as duas visões** (`clinica` e `leads`). Filtro `origem` aplica-se à visão de leads.

### 4.3 Frontend
- Página separada `/comercial/index.html` + `public/js/comercial/` (segue o padrão de módulo do CLAUDE.md: shared-nav, auth via `sb-{ref}-auth-token`, registro no nav e no módulo de Usuários).
- Layout: cards no estilo appcrc (valor grande + rótulo + ícone colorido), responsivo (mobile-first, como os outros módulos). Filtro de período no topo; alternância/colunas para as duas visões; seletor de campanha.

---

## 5. Lógica do funil (definições)

Para um período `[from, to]`:

**Visão "Toda a clínica (por avaliador)":**
- **Coorte de avaliação** = pacientes com pelo menos uma `avaliacoes` (dentista avaliador) com `data` no período.
- Total de agendamentos = nº de linhas em `avaliacoes` no período.
- Comparecimentos = linhas com `compareceu = true`.
- Fechamentos = pacientes da coorte com `orcamentos.status = APPROVED` (ligados ao mesmo paciente). Evita ambiguidade avaliador-vs-executor ligando o fechamento ao **paciente**, não ao profissional do orçamento.
- Valor de oportunidades = soma de `valor` dos orçamentos (OPEN + APPROVED) dos pacientes da coorte no período.
- Valor de fechamentos = soma de `valor` dos APPROVED.
- Ticket médio = valor de fechamentos ÷ nº de fechamentos.
- Taxa de conversão = fechamentos ÷ total orçado (ou ÷ comparecimentos — definir no plano para casar com a semântica do appcrc).
- Leads criados / leads agendados: nesta visão, "leads" = pacientes (proxy), ou ocultar os 2 cards de lead que só fazem sentido na visão de leads — decidir no plano.

**Visão "Leads rastreados (por campanha)":**
- Mesmas contas, restritas às linhas com `lead_id` não nulo.
- Total de leads criados = `leads` com `created_at` no período.
- Leads agendados = leads com ao menos uma `avaliacoes` ligada.
- Quebra por `origem`/campanha (do lead).

> Detalhes de borda (paciente com múltiplos orçamentos, atribuição de data por criação vs aprovação, telefone duplicado entre leads) serão resolvidos no plano de implementação.

---

## 6. Trade-offs e decisões registradas

- **Abordagem A (on-read sobre dados persistidos)** vs B (materializada) vs C (views): escolhida A por volume pequeno — número fresco, sem peça pesada para manter. Promovível a C se outra tela reusar as contas.
- **Persistir linha a linha** (em vez de chamar Clinicorp ao vivo no dashboard): habilita as duas visões + campanha e desacopla do limite de 25 req/h.
- **Funil ligado ao paciente** (não ao profissional do orçamento): contorna a ambiguidade avaliador/executor observada nos dados.
- **Desconto/entrada fora do v1**: não disponíveis no endpoint de orçamentos; usuário não faz questão agora.

## 7. Riscos / pontos a confirmar na implementação
1. **Quais registros de profissional são os avaliadores** (nomes exatos para `config_avaliadores`). Confirmar com o usuário.
2. **Mapeamento de `StatusId` → compareceu** (taxonomia de status de agendamento da Clinicorp).
3. **Semântica exata dos % do appcrc** (denominadores) para bater os números.
4. **Normalização de telefone** para o match lead↔paciente (DDD, 9º dígito).

## 8. Dependências
- Independente do import histórico do appcrc (sub-projeto à parte). A visão de leads rastreados fica esparsa até lá; a visão de clínica já nasce cheia.
- Pendência de segurança correlata (não bloqueante): habilitar RLS em `lead_eventos`/`pixel_sessions`/`anuncios`.
