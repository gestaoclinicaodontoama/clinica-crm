# Monitor de Saúde dos Syncs — Design (Fase 1)

**Data:** 2026-07-07
**Status:** aprovado (brainstorming) — aguardando revisão do spec

## Objetivo e contexto

O sync diário já quebrou silenciosamente antes (dados congelados ~13 dias em jun/26;
o monitor do CAPI nasceu de um episódio irmão). Hoje o `sync_log` grava `ok`, `error`
e `steps` por fase, mas **ninguém é avisado** quando falha — e o pior modo de falha é
o silencioso: a fase roda "ok" e traz **0** porque algo upstream quebrou, indistinguível
de "dia fraco". O pedido do Luiz (motivado pela fase nova `emails_leads`): uma página
que mostre, para cada fase, **o que veio vs o normal**, com **justificativa em
português** quando desviar ("não sei avaliar sozinho"), + alerta no sino/push.

## Decisões (do brainstorming)

- **"Deveria pegar" = comparar com o normal recente** (mediana das últimas rodadas),
  não expectativa fixa nem re-consulta à Clinicorp. Com **justificativa por fase**.
- **Alerta em falha OU fase zerada/abaixo do normal** (pega degradação silenciosa),
  com dedup.
- **Fase 1 (este spec):** só o que **já registra** no `sync_log` — sync Clinicorp 02h
  (trigger `agendado`/`manual`/afins) e social media 03:15 (trigger `social-media%`).
- **Fase 2 (fora deste spec):** instrumentar os jobs órfãos que hoje só logam no
  console (financeiro mês corrente, fluxo futuro 24m, comparecimentos 10min) com um
  heartbeat, e trazê-los pra mesma página.
- **Clona a arquitetura do monitor do CAPI** (padrão validado da casa): lib pura +
  endpoint + página + tick de alerta.

## Componentes

### 1. `lib/sync/health.js` — funções puras (testáveis isoladas)

Recebe as últimas ~30 linhas do `sync_log` e o `agora`; devolve estruturas prontas.

- **Separação por job:** Clinicorp = `trigger` NÃO começa com `social-media`;
  Social Media = começa com `social-media`. (Parametrizado numa constante `JOBS` com
  `{ id, label, triggerPrefix|exclude, janelaHHMM, margemMin }` — fácil estender na Fase 2.)
- **Parser de step:** cada valor de `steps` vira `{ tipo, n }`:
  - string começando com `"erro:"` → `{ tipo:'erro' }` (guarda a mensagem);
  - número, ou string com número extraível (ex.: `"50 mídias"` → 50) → `{ tipo:'num', n }`;
  - `"pulado…"`, `"sem mudança"`, `"ok"` e demais textos → `{ tipo:'neutro' }`.
- **Típico por fase:** mediana dos valores `num` da fase nas rodadas **completas**
  (`finished_at` não nulo e `steps` não nulo) do mesmo job. Rodadas `ok=null`
  (começou e nunca terminou) ficam **fora** do típico.
- **Classificação da última rodada completa,** fase a fase:
  | Situação | Status |
  |---|---|
  | step `erro:` | 🔴 `erro` (mensagem crua exibida) |
  | valor 0 **e** típico ≥ 3 | 🔴 `zerou` |
  | valor < 40% do típico **e** típico ≥ 3 | 🟡 `abaixo` |
  | típico < 3 (fase naturalmente pequena/variável) | ⚪ `neutro` — mostra números, nunca alarma (anti-falso-positivo; ex.: `leads_fechados`, `emails_leads` têm dias legítimos de 0) |
  | `pulado`/`sem mudança`/`ok` | ⚪ `neutro` |
  | dentro do normal | 🟢 `ok` |
  | fase existe no histórico mas **sumiu** da última rodada | ⚪ `sumiu` — nota "fase não apareceu na última rodada" (sem alerta: pode ser refactor legítimo, mas fica visível) |
- **Estados do job (acima das fases):**
  - última rodada `ok=false` → 🔴 `falhou` (mostra `error`);
  - última linha com `ok=null` e `started_at` velho (> 2h) → 🔴 `travou no meio`;
  - **nenhuma rodada desde a janela do dia + margem** (Clinicorp: 02:00 BRT + 120min
    ⇒ alerta só depois das 04:00; social: 03:15 + 120min) → 🔴 `não rodou`;
  - antes da janela+margem → usa a rodada de ontem normalmente (sem alarme).
- **`avaliarGatilhosSync(rows, agora)`** → lista no MESMO formato do
  `capiHealth.avaliarGatilhos` (`{ gatilho, escopo, status:'ok'|'ruim', detalhe }`):
  - `sync_falha` (escopo = job) — falhou / travou no meio;
  - `sync_nao_rodou` (escopo = job);
  - `sync_fase` (escopo = `job:fase`) — fase 🔴 `zerou`/`erro` ou 🟡 `abaixo`.

### 2. Alerta — tick de 30 min reaproveitando a máquina do CAPI

Um só caminho de código (padrão `capiChecarGatilhos`): `setInterval` de 30 min no
`server.js` → carrega `sync_log` → `avaliarGatilhosSync` → **`capiHealth.decidirAlertas`**
(reuso da função pronta: vira-ok→ruim notifica 1×, cooldown 12h, fingerprint, reset
silencioso) → estado persistido na **tabela existente `capi_monitor_estado`**
(`unique(gatilho, escopo)` comporta os gatilhos novos; sem tabela nova, sem migration).
Notificação: `criarNotificacao(gestor, 'sync_alerta', 'Alerta Sync', corpo, { url: '/sync-saude/' })`
para roles admin/gestor — mesmo loop do CAPI.

### 3. Endpoints (`requireAuth` + `requireGestor`)

- **`GET /api/admin/sync-saude`** — devolve por job: status geral, última rodada
  (quando, duração, gatilho), tabela de fases `{ fase, hoje, tipico, status,
  mensagemErro? }`, erros recentes (7d) e histórico das últimas 7 rodadas
  (`{ quando, ok, duration_s }`). Sub-falha → resposta parcial com flag, não 500
  (padrão do endpoint do CAPI).
- **`POST /api/admin/sync-saude/recheck`** — roda a checagem de gatilhos na hora
  (botão "Re-checar agora"; espelho do recheck do CAPI).

### 4. `public/sync-saude/` + `public/js/sync-saude/api.js` + nav

Página no padrão `shared-nav` + `api.js` (igual `/capi-saude/`). De cima pra baixo,
por job (Clinicorp primeiro, depois Social Media):
1. **Status geral** 🟢/🔴 + "rodou hoje às X, durou Ys" + botão **Re-checar agora**
   (chama um `POST /api/admin/sync-saude/recheck` que roda o tick na hora);
2. **Tabela de fases:** Fase | Hoje | Típico | Status — quando 🔴/🟡/⚪`sumiu`, linha de
   **justificativa** logo abaixo;
3. **Erros recentes** (mensagem crua + quando);
4. **Histórico** (últimas 7 rodadas: data, ok/falhou, duração).

**Justificativas:** dicionário fixo no frontend (`FASE_INFO`), um verbete por fase em
português: *o que a fase faz · o que significa vir 0/abaixo · o que checar primeiro*.
Ex.: `emails_leads` → "Preenche e-mail dos leads com o cadastro do Clinicorp. Vir 0 é
normal em dia sem paciente novo; desconfie se `novos_pacientes` também caiu." Fases sem
verbete ganham texto genérico (não quebra ao surgir fase nova). Sem IA: determinístico
e grátis.

Item no `nav-config.js`: `slug:'sync-saude'`, label "Saúde dos Syncs", roles
`admin,gestor`, `mode:'link'`, `href:'/sync-saude/'` (mesma seção do Monitor CAPI).

## Fluxo de dados

```
sync_log (Clinicorp 02h + social media 03:15, já gravam hoje)
   │
   ├── GET /api/admin/sync-saude ──▶ lib/sync/health.js ──▶ página /sync-saude/
   │                                   (típico, classificação, estados de job)
   └── tick 30 min ──▶ avaliarGatilhosSync ──▶ capiHealth.decidirAlertas (REUSO)
                              │                        │
                              ▼                        ▼
                     capi_monitor_estado (REUSO)   criarNotificacao → sino+push gestores
```

## Tratamento de erro

- Tick em try/catch com guarda de reentrância (`_syncSaudeChecando`) — nunca derruba o
  servidor; tick perdido se recupera no próximo (mesmo padrão CAPI).
- Leitura do `sync_log` falhou → tick loga e sai (sem alarme falso); página devolve
  parcial com flag de erro.
- `steps` nulo/malformado → rodada tratada como incompleta (fora do típico).
- Fuso: janelas calculadas em BRT (`America/Sao_Paulo`), mesmo helper de data do
  scheduler existente.
- Antispam: herdado do `decidirAlertas` (1 push na virada ok→ruim, lembrete no máximo
  a cada 12h, reset silencioso ao normalizar).

## Testes (TDD — `lib/sync/health.test.js`, roda no `node --test`)

Um teste por comportamento:
- parser: número puro, `"50 mídias"`, `"erro: X"`, `"pulado (…)"`, `"ok"`;
- típico: mediana só de rodadas completas; `ok=null` fora;
- classificação: erro→🔴; 0 com típico≥3→🔴; 39% do típico→🟡; 41%→🟢; típico<3 com 0→⚪;
  fase no histórico ausente da última→⚪`sumiu`;
- estados de job: `ok=false`→falhou; `ok=null` velho→travou; sem rodada pós-janela+margem
  →não rodou; antes da margem→sem alarme;
- separação de jobs: linhas `social-media%` não poluem o típico do Clinicorp e vice-versa;
- gatilhos: saída no formato aceito pelo `decidirAlertas` (integração com fixture).

**Validação manual pós-deploy:** abrir `/sync-saude/` logado e conferir as fases
contra `select steps from sync_log order by started_at desc limit 1`; clicar
Re-checar; amanhã após as 02h conferir que a página reflete a rodada nova. O caminho
do alerta se valida sem forçar falha em produção: o teste de integração do
`decidirAlertas` cobre a virada ok→ruim, e a linha `ok=false` real do social media
já presente no `sync_log` (erro `#10` de 07/07) serve de fixture pra conferir na
página que um erro real aparece 🔴 com a mensagem crua.

## Fora de escopo (Fase 2 e além)

- Instrumentar jobs órfãos: financeiro mês corrente, fluxo futuro 24m, sync de
  comparecimentos (10 min), refresh de inadimplentes — exigem heartbeat próprio
  (helper `registrarJob`) antes de aparecer na página.
- Notificadores (resumo CRC, varreduras, mensagens agendadas): não puxam dados; só
  entrariam com heartbeat na Fase 2 se sentir falta.
- Gráfico de tendência por fase (YAGNI até sentir falta).
- Configuração de limites pela UI (constantes em `health.js`, como no CAPI).
