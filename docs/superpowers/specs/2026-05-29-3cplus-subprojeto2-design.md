# 3cplus Sub-projeto 2 — Campanha de Discagem Preditiva

**Goal:** Permitir que CRCs lancem campanhas de discagem preditiva pelo CRM, selecionando grupos de pacientes (Curva ABC) ou leads (indicações, recentes, frios), com preview antes de confirmar, e controle de pause/retomada sem sair do sistema.

**Architecture:** 4 campanhas fixas no 3cplus (criadas manualmente uma vez). Cada lançamento substitui o mailing da campanha via API. Backend faz polling de resultados via `GET /api/v1/calls?campaign_id=...`. Arquivo novo `lib/3cplus-campanhas.js` isola a lógica de campanha de `lib/3cplus.js`.

**Tech Stack:** Node.js + Express, Supabase Postgres, 3cplus REST API (gestor token), HTML/CSS/JS vanilla.

---

## 1. Setup no 3cplus (manual, uma vez)

Criar 4 campanhas de discagem preditiva no painel da 3cplus:

| Nome sugerido | Env var | Uso |
|---|---|---|
| `CRM - Retorno ABC` | `THREEC_CAMPAIGN_ABC` | Curva ABC classe A/B, +180 dias sem visita |
| `CRM - Leads Indicações` | `THREEC_CAMPAIGN_INDICACOES` | Leads com origem = indicação |
| `CRM - Leads Recentes` | `THREEC_CAMPAIGN_RECENTES` | Últimos 50 leads não-indicação |
| `CRM - Leads Frios` | `THREEC_CAMPAIGN_FRIOS` | Leads do 51º ao 151º não-indicação |

Os IDs numéricos de cada campanha são configurados como env vars no Easypanel após criação. Nenhum código precisa ser alterado para trocar de campanha.

---

## 2. Banco de dados

### Tabela `campanhas_discagem`

```sql
CREATE TABLE campanhas_discagem (
  id            SERIAL PRIMARY KEY,
  tipo          TEXT NOT NULL CHECK (tipo IN ('abc','indicacoes','recentes','frios')),
  threec_campaign_id INTEGER NOT NULL,
  contatos_total     INTEGER NOT NULL DEFAULT 0,
  contatos_json      JSONB,   -- [{id, nome, telefone, tipo_origem}]
  status             TEXT NOT NULL DEFAULT 'ativa'
                     CHECK (status IN ('ativa','pausada','encerrada')),
  usuario_id         UUID REFERENCES auth.users(id),
  iniciada_em        TIMESTAMPTZ DEFAULT NOW(),
  pausada_em         TIMESTAMPTZ,
  encerrada_em       TIMESTAMPTZ
);
```

Sem tabela de config — IDs de campanha ficam em env vars para simplicidade.

---

## 3. Backend

### Arquivo novo: `lib/3cplus-campanhas.js`

Duas categorias de token — documentadas explicitamente:

```js
// ── Gestor token (THREEC_TOKEN env var) ──────────────────────────────

// Faz upload de mailing para campanha — substitui lista anterior
// contacts: [{nome, telefone}]
async function uploadMailing(campaignId, contacts) { ... }

// Pausa campanha
async function pausarCampanha(campaignId) { ... }

// Retoma campanha pausada
async function retomarCampanha(campaignId) { ... }

// Encerra campanha (stop definitivo)
async function encerrarCampanha(campaignId) { ... }

// Busca calls de uma campanha desde iniciada_em até agora (gestor token)
async function getCallsDaCampanha(campaignId, iniciada_em) { ... }

// ── Token da CRC (agentToken — vem do profile da CRC logada) ─────────

// Loga a CRC na campanha para ela receber as chamadas preditivas
// agentToken = req.user.profile.threec_agent_token (carregado via loadProfile)
// Sem este passo, a CRC não recebe chamadas mesmo com o mailing uploaded
async function loginCrcNaCampanha(agentToken, campaignId) { ... }
```

**⚠️ Risco: endpoints de campanha não testados — verificar antes de implementar.**

Endpoints 3cplus esperados (gestor token):
- Upload mailing: `POST /api/v1/campaigns/{id}/mailing` — body JSON `[{nome, telefone}]`; se exigir CSV, o módulo converte internamente
- Pausar: `POST /api/v1/campaigns/{id}/pause` ou `PATCH /api/v1/campaigns/{id}` com `{status:'paused'}`
- Retomar: `POST /api/v1/campaigns/{id}/resume`
- Encerrar: `POST /api/v1/campaigns/{id}/stop` ou `DELETE /api/v1/campaigns/{id}/mailing`
- Resultado: via `GET /api/v1/calls?campaign_id={id}&start_date=...&end_date=...` (já confirmado funcionando)

O primeiro passo da implementação deve ser testar esses endpoints via curl antes de codificar.

### Novos endpoints em `server.js`

**Preview — retorna lista filtrada sem lançar nada:**
```
GET /api/campanhas/preview/:tipo
```
- `tipo`: `abc` | `indicacoes` | `recentes` | `frios`
- Filtros por tipo:
  - **abc**: tabela `pacientes_abc` onde `classe IN ('A','B')` AND `dias_sem_visita >= 180` AND `proxima_consulta IS NULL` — retorna `{nome, telefone, clinicorp_id, dias_sem_visita}`
  - **indicacoes**: `leads` onde `origem = 'Indicação'` AND `status NOT IN ('Fechou','Perdido')` — retorna `{nome, telefone, id}`
  - **recentes**: `leads` onde `origem != 'Indicação'` AND `status NOT IN ('Fechou','Perdido')` ORDER BY `criado_em DESC` LIMIT 50
  - **frios**: mesmo que recentes, OFFSET 50 LIMIT 101 (51º ao 151º)
- Resposta: `{ total: N, contatos: [...] }`
- Aceita query param `?count_only=true` → retorna só `{ total: N }` sem lista (usado para os contadores dos botões no módulo de Leads)
- Roles: `crc_leads`, `gestor`, `admin`

**Lançar campanha:**
```
POST /api/campanhas/lancar
Body: { tipo: 'abc' | 'indicacoes' | 'recentes' | 'frios' }
```
1. Busca env var do campaign_id pelo tipo
2. Se não configurada → erro 400 "Campanha não configurada"
3. Checa se há campanha com status `ativa` **ou** `pausada` → erro 409 "Encerre ou retome e encerre a campanha atual antes de lançar outra"
4. Re-busca contatos com mesma query do preview (snapshot pode diferir ligeiramente — normal)
5. Filtra contatos sem telefone — silenciosamente removidos
6. Se 0 contatos com telefone → erro 400 "Nenhum contato encontrado com telefone cadastrado"
7. Chama `uploadMailing(campaignId, contatos)` — se falhar → erro 502, nenhum registro criado no DB
8. Insere registro em `campanhas_discagem` com status `ativa` — se falhar → chama `encerrarCampanha(campaignId)` como rollback antes de retornar erro 500
9. Chama `loginCrcNaCampanha(req.user.profile.threec_agent_token, campaignId)` — falha aqui é não-fatal (loga warning, campanha continua ativa, CRC recebe toast de aviso para se logar manualmente)
10. Resposta: `{ ok: true, campanha: { id, tipo, contatos_total } }`
- Roles: `crc_leads`, `gestor`, `admin`

> **Nota:** Somente a CRC que lançou é automaticamente logada na campanha. Outras CRCs que queiram receber chamadas da mesma campanha precisam se logar manualmente no painel da 3cplus.

**Pausar:**
```
POST /api/campanhas/:id/pausar
```
1. Busca campanha pelo id, valida que status = `ativa`
2. Chama `pausarCampanha(threec_campaign_id)`
3. Atualiza status → `pausada`, seta `pausada_em = NOW()`
- Roles: mesmos do lançamento

**Retomar:**
```
POST /api/campanhas/:id/retomar
```
1. Valida status = `pausada`
2. Chama `retomarCampanha(threec_campaign_id)`
3. Atualiza status → `ativa`, limpa `pausada_em`

**Encerrar:**
```
POST /api/campanhas/:id/encerrar
```
1. Chama `encerrarCampanha(threec_campaign_id)`
2. Atualiza status → `encerrada`, seta `encerrada_em = NOW()`

**Campanha ativa:**
```
GET /api/campanhas/ativa
```
- Retorna a campanha mais recente com status `ativa` ou `pausada` (apenas uma pode existir por vez)
- Resposta: `{ campanha: { id, tipo, status, contatos_total, iniciada_em, pausada_em } | null }`
- O widget exibe o nome do tipo independente de qual módulo o usuário está — é a campanha global do sistema

**Resultado da campanha (polling):**
```
GET /api/campanhas/:id/resultado
```
- Busca registro da campanha para obter `iniciada_em` e `contatos_total`
- Chama `getCallsDaCampanha(campaignId, iniciada_em)` — filtra calls desde `iniciada_em` até agora
- Calcula: `atendidas` (status_id=7), `nao_atendeu` (outros status), `na_fila` = `contatos_total - atendidas - nao_atendeu`
- Retorna: `{ atendidas: N, nao_atendeu: N, na_fila: N }`

---

## 4. UI

### Curva ABC (`public/pos-tratamento/curva-abc.html` + `.js`)

Botão **"📞 Enviar para Discagem"** sempre visível na página (o filtro A/B + 180 dias é fixo do backend, não depende do filtro visual da CRC):

```html
<button id="btn-campanha-abc" class="btn btn-call" onclick="lancarCampanhaABC()">
  📞 Enviar para Discagem
</button>
```

`lancarCampanhaABC()`:
1. Chama `GET /api/campanhas/preview/abc`
2. Exibe modal de preview
3. Confirmação → chama `POST /api/campanhas/lancar { tipo: 'abc' }`
4. Toast de sucesso + painel de campanha ativa aparece

**Modal de preview:**
```
┌─────────────────────────────────────────┐
│  Retorno ABC — 47 pacientes             │
│  Classe A/B · Sem consulta há 180+ dias │
│  ┌─────────────────────────────────┐    │
│  │ Nome           | Tel    | Dias  │    │
│  │ João Silva     | 31999  | 210   │    │
│  │ Maria Souza    | 31988  | 195   │    │
│  │ ...                            │    │
│  └─────────────────────────────────┘    │
│  [ Cancelar ]    [ Enviar para discagem]│
└─────────────────────────────────────────┘
```

### Módulo de Leads (`public/index.html`)

Três botões acima da lista de leads (contagens calculadas ao carregar):

```html
<div id="campanha-leads-btns">
  <button onclick="lancarCampanha('indicacoes')">📞 Indicações (<span id="cnt-indicacoes">...</span>)</button>
  <button onclick="lancarCampanha('recentes')">📞 Recentes — 50</button>
  <button onclick="lancarCampanha('frios')">📞 Frios — 51 a 151</button>
</div>
```

`lancarCampanha(tipo)`:
1. Chama `GET /api/campanhas/preview/:tipo`
2. Exibe mesmo modal de preview (adaptado ao tipo)
3. Confirmação → `POST /api/campanhas/lancar { tipo }`

### Painel de campanha ativa (componente compartilhado)

Aparece em Curva ABC e em Leads quando `GET /api/campanhas/ativa` retorna campanha:

```
┌─────────────────────────────────────────────────────────┐
│ 🔵 Campanha ativa: Retorno ABC                          │
│ Enviados: 47 · Atendidos: 12 · Não atendeu: 8 · Fila: 27│
│ Iniciada 14:32          [ ⏸ Pausar ] [ ⏹ Encerrar ]    │
└─────────────────────────────────────────────────────────┘
```

- Atualiza a cada 60s via `GET /api/campanhas/:id/resultado`
- Se pausada: botão muda para `▶ Retomar`
- Encerrar pede confirmação: "Encerrar campanha? Os contatos restantes não serão discados."

O painel é implementado em `public/js/campanha-widget.js` (compartilhado entre módulos via `<script src="/js/campanha-widget.js">`).

**Inicialização e reconciliação de estado:**
1. Ao carregar a página, chama `GET /api/campanhas/ativa`
2. Se retorna campanha → mostra painel, inicia polling de resultado a cada 60s
3. A cada poll de resultado: se `na_fila === 0` e `status === 'ativa'` → chama `POST /api/campanhas/:id/encerrar` automaticamente (campanha terminou naturalmente) e esconde o painel
4. Se o servidor reiniciar com campanha `ativa` no DB mas a 3cplus já terminou, o passo 3 reconcilia no próximo poll (na_fila será 0)

---

## 5. Roles e permissões

| Ação | Roles |
|---|---|
| Preview, lançar, pausar, retomar, encerrar | `crc_leads`, `gestor`, `admin` |
| Ver painel de campanha ativa | `crc_leads`, `gestor`, `admin` |

---

## 6. Tratamento de erros

| Cenário | Comportamento |
|---|---|
| Env var de campanha não configurada | Erro 400: "Configure o ID da campanha no Easypanel" |
| Campanha do mesmo tipo já ativa | Erro 409: "Encerre a campanha atual antes de lançar outra" |
| 0 contatos no filtro | Erro 400: "Nenhum contato encontrado com este filtro" |
| 3cplus retorna erro no upload | Erro 502: mensagem da API repassada |
| Pause/resume com status inválido | Erro 400 descritivo |

---

## 7. Fora de escopo (Sub-projeto 2)

- Automação WhatsApp após 3 tentativas sem resposta → Sub-projeto futuro
- Relatório histórico de todas as campanhas lançadas → futuro
- Criação automática de campanhas no 3cplus (feita manualmente uma vez)
