# Auditoria de Registro Clínico Diário — Design

**Data:** 2026-07-16
**Objetivo:** permitir ao gestor verificar, dia a dia, se a equipe registrou no Clinicorp o que foi produzido — cruzando quem foi atendido (agenda) com o que foi marcado como executado (produção).

## Contexto e limitação assumida

A API pública do Clinicorp **não expõe o conteúdo da ficha clínica/prontuário** (sem endpoint de evolução/anamnese — ver `docs/clinicorp-endpoints.md`). O sinal disponível de "a equipe registrou algo" é o procedimento marcado como **Executado** (`producao_procedimentos`, já sincronizado diariamente). A tela deixa essa limitação explícita: "sem registro" = não há procedimento cobrável executado naquele dia — é sinal para conferir, não prova de que nada foi anotado na ficha.

Decisões do brainstorm (16/07):
- Sinal de documentação = **procedimento Executado** (não orçamento).
- Escopo = só consultas **compareceu** (check-in OU status de comparecimento).
- Categorias `Avalia%` **ficam fora** (funil já auditado no Dashboard Comercial).
- Categorias `Manuten%` aparecem em **seção separada**, sem contar como pendência (visita de ajuste normalmente não gera procedimento cobrável).
- Entrega = **página no CRM** (aba nova no módulo Produção), sem alerta automático por ora.

## Verificações feitas (16/07, banco de produção)

- `paciente_clinicorp_id` casa entre as duas tabelas: 164/165 pacientes com produção (30d) existem na agenda com o mesmo ID. `syncProducao` preenche o campo na mesma noite (`est.PatientId`).
- `checkin_time` sozinho cobre só ~41% da agenda → precisa do `StatusId` combinado (mesma regra já validada no sync de avaliações: `!!CheckinTime || config_status_compareceu`).
- Casamento por dia exato: ±1 dia quase não muda (77→83 de 272) — manter dia exato.
- Baseline real: ~28% dos atendimentos com check-in (fora avaliação, 14d) têm produção no mesmo dia. A tela vai nascer cheia de pendências — comportamento esperado.

## Arquitetura

### 1. Migração — `agenda_appointments` (+2 colunas)

```sql
ALTER TABLE agenda_appointments
  ADD COLUMN IF NOT EXISTS status_id  text,
  ADD COLUMN IF NOT EXISTS compareceu boolean;
CREATE INDEX IF NOT EXISTS agenda_appointments_compareceu_date_idx
  ON agenda_appointments (appointment_date) WHERE compareceu = true;
```

Sem policy nova (tabela já tem RLS; front não a lê direto — tudo via `/api` com service_role).

### 2. Sync — `syncAgenda()` em `sync/clinicorp-sync.js`

- Passar a persistir `status_id: String(a.StatusId || '') || null`.
- Calcular `compareceu = !!a.CheckinTime || cfg.statusCompareceu.has(statusId)` — reaproveitando o `cfg` de `loadFunilConfig()` (já carregado no `runSync`; `syncAgenda` passa a receber `cfg` como parâmetro).
- Nenhuma chamada nova à API. O sync rebusca 90 dias toda noite → as colunas se auto-preenchem para os 90 dias passados na primeira execução pós-deploy.

### 3. API — `GET /api/producao/auditoria-registro?data=YYYY-MM-DD`

- Auth: `requireAuth, requireProducao` (mesmo padrão das demais rotas de Produção).
- `data` default = ontem (BRT). Validar formato.
- Lógica (consultas via supabase-js, agregação leve em JS — volume diário é pequeno, ~60 linhas):
  1. Agenda do dia: `deleted = false`, `compareceu = true`, `category` nula ou não-`Avalia%`.
  2. Produção do dia: `producao_procedimentos` com `executed_date = data`, agrupada por `paciente_clinicorp_id` (lista de `procedure_name` + `dentist_name`).
  3. Cada atendimento vira `{ paciente, dentista, horario, categoria, registrado: bool, procedimentos: [...] }`, casando por `paciente_clinicorp_id`.
  4. Separar em três grupos: `sem_registro` (clínicos sem produção), `com_registro`, `manutencao` (categoria `Manuten%`, com flag de registro mas fora da contagem de pendência).
  5. `resumo`: totais + por dentista (`{ dentist_name, atendidos, registrados, pendentes }`).
- Resposta: `{ data, resumo, sem_registro, com_registro, manutencao }`.
- Edge cases: atendimento sem `paciente_clinicorp_id` (raro, ~0,5%) entra como `registrado: false` com aviso `sem_id: true`; dia sem sync ainda (hoje) → a UI avisa que o dado do dia só fecha após o sync das 02:00.

### 4. UI — página "Registro Diário" na seção Clínica / Produção

- Segue o padrão das páginas irmãs (`/producao/`, `/producao/dentista/`): nova página `public/producao/registro/index.html` + `shared-nav.js` com `data-active="producao-registro"`.
- Novo subitem no array `items` da seção `producao` em `public/js/nav-config.js`:
  `{ slug: 'producao-registro', label: 'Registro Diário', roles: 'financeiro,mod_financeiro,mod_producao', mode: 'link', href: '/producao/registro/' }`.
- Sem role nova → nenhuma mudança no módulo de Usuários (reusa `mod_producao`).
- Componentes:
  - Seletor de data (default ontem) + botões ◀ ▶ dia anterior/seguinte.
  - Cartão-resumo: "X de Y atendimentos com registro — Z pendentes".
  - Tabela **Pendentes** (destaque): paciente, dentista, horário, categoria.
  - Tabela **Com registro**: mesmas colunas + procedimentos registrados.
  - Seção colapsada **Manutenção** (informativa, fora da contagem).
  - Mini-tabela por dentista (atendidos / registrados / pendentes).
  - Rodapé com a limitação: "Mostra se existe procedimento executado no Clinicorp no dia — não lê o texto da ficha clínica."
- Retry 5xx padrão do CRM (1,5s/3s, 2x).

## Fora de escopo (registrado para depois)

- Alerta automático diário (WhatsApp/e-mail) — Luiz optou por página apenas; fácil de acrescentar depois em cima da mesma API.
- Auditoria de avaliações (orçamento criado no dia) — já coberta pelo Dashboard Comercial.
- Leitura do texto da ficha — impossível pela API pública hoje.

## Testes

- Unit (JS puro, padrão `lib/`): função de classificação `classificarDia(atendimentos, producao)` → grupos e resumo corretos (casos: com/sem registro, manutenção, avaliação excluída, sem `paciente_clinicorp_id`, dia vazio).
- Manual pós-deploy: rodar sync manual, abrir a aba com data de ontem e conferir 2–3 pacientes contra o Clinicorp logado.
