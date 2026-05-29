# Design: Trajeto do Paciente + Atribuição por Anúncio

**Data:** 2026-05-29  
**Status:** Aprovado  
**Escopo:** CRM AMA — rastreio completo da jornada do paciente e atribuição de conversões por anúncio

---

## 1. Visão Geral

Três entregas conectadas:

1. **Campo "Anúncio" no perfil do lead** — mostra de qual anúncio o lead veio, com nome catalogado ou ID com link
2. **Página de Atribuição** (`/atribuicao/`) — relatório separado para admin/gestor com funil de conversão por anúncio (Meta + Google)
3. **Aba "Trajeto"** no perfil do lead — timeline cronológica de tudo que aconteceu com o paciente, incluindo eventos do CRM e visitas ao site via anúncio

---

## 2. Schema — Novas Tabelas

### 2.1 `lead_eventos`

Registra todo evento relevante do ciclo de vida do lead. Nunca bloqueia a operação principal (fire-and-forget).

```sql
CREATE TABLE lead_eventos (
  id            bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  lead_id       bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tipo          text NOT NULL,
  descricao     text NOT NULL,
  metadata      jsonb DEFAULT '{}',
  usuario_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL, -- null = evento automático
  criado_em     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lead_eventos_lead_id ON lead_eventos(lead_id, criado_em DESC);
```

**Tipos de evento:**

| tipo | quando | usuario_id |
|------|--------|------------|
| `lead_criado` | lead inserido no sistema | null (automático) ou id do usuário |
| `status_mudou` | kanban move (de → para) | id do usuário |
| `mensagem_recebida` | paciente envia mensagem via WA | null |
| `mensagem_enviada` | equipe envia mensagem via WA | id do usuário |
| `template_enviado` | template WA disparado | id do usuário |
| `template_respondido` | resposta detectada em até 48h após template | null |
| `template_sem_resposta` | 48h passaram sem resposta ao template | null |
| `ligacao` | chamada via 3cplus iniciada | id do usuário |
| `capi_disparado` | evento enviado à Meta via CAPI | null |
| `clinicorp_agendado` | botão "Agendar no Clinicorp" acionado | id do usuário |
| `clinicorp_faltou` | agendamento passado há +24h sem checkin no Clinicorp (lead ainda "Agendado") — detectado no sync de 10min | null |
| `pixel_pagina` | visita ao site via fbclid (clinicaodontoama.com.br) | null |

**`metadata` por tipo (exemplos):**

```json
// status_mudou
{ "de": "Lead", "para": "Agendado" }

// template_enviado / template_respondido
{ "template": "retorno_prevencao_protocolo", "categoria": "UTILITY", "tempo_resposta_min": 37 }

// capi_disparado
{ "evento": "Schedule", "valor": 0 }

// pixel_pagina
{ "pagina": "/implante-dentario", "referrer": "facebook.com" }

// clinicorp_agendado
{ "dentista": "Dr. Marcos", "data": "2026-06-10" }
```

---

### 2.2 `pixel_sessions`

Rastrea visitantes anônimos do site que vieram via anúncio (fbclid obrigatório). Vincula ao lead quando fbclid coincide.

```sql
CREATE TABLE pixel_sessions (
  id        bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  fbclid    text NOT NULL,
  lead_id   bigint REFERENCES leads(id) ON DELETE SET NULL,
  pagina    text NOT NULL,
  evento    text NOT NULL DEFAULT 'PageView',
  metadata  jsonb DEFAULT '{}',
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pixel_sessions_fbclid ON pixel_sessions(fbclid);
CREATE INDEX idx_pixel_sessions_lead_id ON pixel_sessions(lead_id);
```

**Vínculo automático:** quando um lead é criado ou atualizado com `fbclid`, o sistema executa:
```sql
UPDATE pixel_sessions SET lead_id = $leadId WHERE fbclid = $fbclid AND lead_id IS NULL;
```
E converte as sessões anônimas em eventos `pixel_pagina` na `lead_eventos`.

**Limitação conhecida:** leads que chegam via WhatsApp (CTWA, sem fbclid na URL) não terão sessões de site vinculadas, mesmo que tenham visitado antes.

---

### 2.3 `anuncios`

Catálogo manual de anúncios para exibição de nomes legíveis na UI.

```sql
CREATE TABLE anuncios (
  id         bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  fonte      text NOT NULL CHECK (fonte IN ('meta', 'google')),
  chave      text NOT NULL UNIQUE, -- ad_id numérico (Meta) ou utm_campaign string (Google)
  nome       text NOT NULL,        -- obrigatório: nome legível ex: "pqe ipanema protese CTA 3"
  descricao  text DEFAULT '',
  ativo      boolean DEFAULT true,
  criado_em  timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
```

**Resolução de nome:** ao exibir um anúncio, o sistema busca `anuncios.nome` pela chave. Se não cadastrado, exibe a chave (ID/string) com link para o Gerenciador correspondente.

---

## 3. Campo "Anúncio" no Perfil do Lead

Adicionado no painel direito do lead (abaixo de "Origem"):

```
ANÚNCIO
[nome catalogado] ↗  |  [badge: CTWA ✓ / Google / Orgânico]
```

- Se tem `ctwa_clid`: badge verde `CTWA ✓`, link para `business.facebook.com/adsmanager/...?selected_campaign_ids=...`
- Se tem `gclid`: badge azul `Google`, link para Google Ads
- Se tem `fbclid` mas sem `ctwa_clid`: badge cinza `Meta (fbclid)`
- Se nenhum: badge cinza `Orgânico / Direto`
- Nome exibido: lookup em `anuncios` pela chave (`campanha`). Fallback: valor bruto de `campanha`.

---

## 4. Aba "Trajeto" no Perfil do Lead

Nova aba no painel de detalhe do lead (ao lado das informações existentes).

### 4.1 Layout

Timeline vertical, mais recente no topo. Cada item:

```
[ícone] [dia/mês HH:MM] — descrição
```

Todos os horários em **America/Sao_Paulo (UTC-3)**, exibidos no formato `dia/mês HH:MM`.

**Ícones por tipo:**
| tipo | ícone |
|------|-------|
| lead_criado | 🟢 |
| status_mudou | 🔄 |
| mensagem_recebida | 💬 |
| mensagem_enviada | 📤 |
| template_enviado | 📋 |
| template_respondido | ↩️ |
| template_sem_resposta | ⏳ |
| ligacao | 📞 |
| capi_disparado | 📡 |
| clinicorp_agendado | 📅 |
| clinicorp_faltou | ❌ |
| pixel_pagina | 🌐 |

### 4.2 Exemplos de linha

```
🟢 29/05 14:33 — Entrou via anúncio "pqe ipanema protese CTA 3" (CTWA ✓)
💬 29/05 14:33 — Mensagem recebida: "Olá! Tenho interesse..."
📋 29/05 15:10 — Template enviado: retorno_prevencao_protocolo (UTILITY)
↩️  29/05 15:47 — Respondeu ao template (37 min depois)
🔄 29/05 16:02 — Status: Lead → Agendado (por: Luiz)
📡 29/05 16:02 — CAPI: Schedule enviado à Meta
📅 29/05 16:05 — Agendado no Clinicorp: Dr. Marcos — 10/06/2026
📞 30/05 09:15 — Ligação: 4min 32s
🌐 28/05 11:20 — Visitou: /implante-dentario (via anúncio Meta)
```

### 4.3 Paginação

Carrega os **últimos 50 eventos** por padrão. Botão "Carregar mais" busca os próximos 50.

### 4.4 Detecção de resposta ao template

Quando uma mensagem é recebida via webhook:
1. Busca o evento `template_enviado` mais recente desse lead sem `template_respondido` subsequente
2. Se esse template foi enviado há menos de 48h, registra `template_respondido` com `tempo_resposta_min`
3. O `setInterval` de 10 min que já existe no servidor (`syncComparecimentos`) é estendido para também verificar templates enviados há mais de 48h sem resposta e registrar `template_sem_resposta`

---

## 5. Página de Atribuição (`/atribuicao/`)

Página separada, acessível para roles `admin` e `gestor`.

### 5.1 Estrutura

**Cards de resumo (topo):**
```
Total leads via anúncio | Agendados atribuídos | Fechados atribuídos | Receita atribuída
```

**Filtro de período:** Últimos 7d / 30d / 90d / Período personalizado (padrão: 30d)

**Tabela por anúncio:**

| Fonte | Anúncio | Leads | Agendados | Compareceu | Fechados | Receita | Conv. Lead→Fechou |
|-------|---------|-------|-----------|------------|----------|---------|------------------|
| Meta | pqe ipanema protese CTA 3 | 12 | 8 | 6 | 4 | R$ 34.000 | 33% |
| Google | implante-ipanema-search | 5 | 3 | 3 | 2 | R$ 18.000 | 40% |
| — | Orgânico / Direto | 7 | 2 | 1 | 1 | R$ 8.500 | 14% |

**Regras de agrupamento:**
- `campanha` não vazio + `ctwa_clid` ou `fbclid` → fonte Meta, chave = `campanha`
- `gclid` não vazio → fonte Google, chave = `campanha` (utm_campaign)
- Demais → "Orgânico / Direto"

**Nome exibido:** lookup em `anuncios` pela chave. Fallback: chave bruta com link ao Gerenciador.

### 5.2 Gerenciamento do catálogo de anúncios

Dentro da página `/atribuicao/`, seção colapsável "Catálogo de Anúncios":
- Listar anúncios cadastrados
- Formulário para adicionar: fonte (meta/google), chave, nome, descrição
- Editar/desativar existentes
- Visível apenas para `admin`

---

## 6. Script de Rastreio no Site

Adicionado em `clinicaodontoama.com.br` no `<head>` com atributo `defer`.

```html
<script defer>
(function(){
  var p = new URLSearchParams(location.search);
  var fbclid = p.get('fbclid') || localStorage.getItem('_fbclid');
  if(fbclid) localStorage.setItem('_fbclid', fbclid);
  if(!fbclid) return;
  fetch('https://plataformaama-plataforma.uc5as5.easypanel.host/t', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: 'PIXEL_TOKEN_AQUI',
      fbclid: fbclid,
      evento: 'PageView',
      pagina: location.pathname,
      referrer: document.referrer
    })
  }).catch(function(){});
})();
</script>
```

**Segurança:** token estático `PIXEL_TOKEN` verificado pelo CRM (variável de ambiente `PIXEL_TRACK_TOKEN`).

**CORS:** endpoint `/t` retorna `Access-Control-Allow-Origin: https://clinicaodontoama.com.br`.

**Rate limit:** o `rateLimit` existente do server.js é aplicado ao `/t`.

**Comportamento:** fire-and-forget — `.catch(function(){})` garante que falha silenciosa não afeta o site.

---

## 7. Helper `logEvento`

Função utilitária no `server.js`, sempre não-bloqueante:

```js
function logEvento(leadId, tipo, descricao, metadata = {}, usuarioId = null) {
  supabase.from('lead_eventos').insert({
    lead_id: leadId, tipo, descricao, metadata, usuario_id: usuarioId
  }).then(() => {}).catch(e => console.error('logEvento:', e.message));
}
```

Chamada em todos os pontos do server.js sem `await` — nunca bloqueia a resposta principal.

---

## 8. Pontos de integração no server.js

| Onde | Evento logado |
|------|--------------|
| Criação de lead (webhook WA, /lead, manual) | `lead_criado` |
| `patchLead` — mudança de status | `status_mudou` |
| Envio de mensagem WA | `mensagem_enviada` |
| Recebimento via webhook WA | `mensagem_recebida` + detecção de `template_respondido` |
| Envio de template | `template_enviado` |
| Chamada 3cplus | `ligacao` |
| `dispararConversaoMeta` | `capi_disparado` |
| Botão "Agendar no Clinicorp" | `clinicorp_agendado` |
| Sync 10min: agendamento +24h sem checkin | `clinicorp_faltou` |
| Endpoint `/t` | `pixel_pagina` + link fbclid→lead |

---

## 9. Acesso e Navegação

- `/atribuicao/` adicionada ao sidebar nav com `data-roles="admin,gestor"`
- Entrada em `shared-nav.js` com slug `atribuicao`
- Aba "Trajeto" visível para todos os roles que têm acesso ao perfil do lead

---

## 10. O que está fora do escopo (desta versão)

- Rastreio de vídeos (YouTube/Google) — deferido
- Busca de nome do anúncio via Meta API em tempo real — catálogo manual resolve
- No-shows enviados ao Meta CAPI — evento negativo, não envia
- Sessões de site sem fbclid (orgânico) — limitação aceita e documentada
