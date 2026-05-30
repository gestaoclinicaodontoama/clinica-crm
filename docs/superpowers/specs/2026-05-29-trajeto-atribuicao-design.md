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
| `clinicorp_faltou` | agendamento passado há +24h sem checkin, appointment ainda existe no Clinicorp (não foi cancelado), lead ainda "Agendado" — detectado no sync de 10min | null |
| `pixel_pagina` | visita ao site via fbclid (clinicaodontoama.com.br) | null |

**`metadata` por tipo (exemplos):**

```json
// status_mudou
{ "de": "Lead", "para": "Agendado" }

// template_enviado
{ "template": "retorno_prevencao_protocolo", "categoria": "UTILITY" }

// template_respondido
{ "template": "retorno_prevencao_protocolo", "tempo_resposta_min": 37 }

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
Em seguida, insere um evento `pixel_pagina` em `lead_eventos` para cada sessão vinculada.

**Retenção dupla:** o registro permanece em `pixel_sessions` (para vínculos futuros) E em `lead_eventos` (para exibição no Trajeto). Não há deleção.

**Limitação conhecida:** leads que chegam via WhatsApp (CTWA, sem fbclid na URL) não terão sessões de site vinculadas, mesmo que tenham visitado antes.

---

### 2.3 `anuncios`

Catálogo manual de anúncios para exibição de nomes legíveis na UI.

```sql
CREATE TABLE anuncios (
  id         bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  fonte      text NOT NULL CHECK (fonte IN ('meta', 'google')),
  chave      text NOT NULL UNIQUE, -- ad_id numérico (Meta) ou utm_campaign em lowercase (Google)
  nome       text NOT NULL,        -- obrigatório: nome legível ex: "pqe ipanema protese CTA 3"
  descricao  text DEFAULT '',
  ativo      boolean DEFAULT true,
  criado_em  timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- Trigger para manter atualizado_em correto em UPDATEs
CREATE OR REPLACE FUNCTION update_anuncios_atualizado_em()
RETURNS TRIGGER AS $$
BEGIN NEW.atualizado_em = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_anuncios_atualizado_em
BEFORE UPDATE ON anuncios
FOR EACH ROW EXECUTE FUNCTION update_anuncios_atualizado_em();
```

**Normalização de chave:** sempre armazenada e comparada em **lowercase**. No insert/update do catálogo: `chave = chave.toLowerCase()`. No lookup: `WHERE chave = lower($chave)`. Garante que `"Implante-Ipanema"` e `"implante-ipanema"` resolvem para o mesmo anúncio.

**Resolução de nome:** ao exibir um anúncio, o sistema busca `anuncios.nome` pela chave (lowercase). Se não cadastrado, exibe a chave (ID/string) com link para o Gerenciador correspondente.

---

## 3. Campo "Anúncio" no Perfil do Lead

Adicionado no painel direito do lead (abaixo de "Origem"):

```
ANÚNCIO
[nome catalogado] ↗  |  [badge: CTWA ✓ / Google / Orgânico]
```

- Se tem `ctwa_clid`: badge verde `CTWA ✓`, link para `https://adsmanager.facebook.com` (Gerenciador geral — não tentamos construir URL por ID pois exigiria account_id não armazenado)
- Se tem `gclid`: badge azul `Google`, link para `https://ads.google.com`
- Se tem `fbclid` mas sem `ctwa_clid`: badge cinza `Meta (fbclid)`
- Se nenhum: badge cinza `Orgânico / Direto`
- Nome exibido: lookup em `anuncios` pela chave (`campanha`). Fallback: valor bruto de `campanha`. Se `campanha` vazio mas tem `ctwa_clid`: exibe "Meta Ads (sem campanha)".

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

Timeline exibe **mais recente no topo**:

```
📞 30/05 09:15 — Ligação: 4min 32s
📅 29/05 16:05 — Agendado no Clinicorp: Dr. Marcos — 10/06/2026
📡 29/05 16:02 — CAPI: Schedule enviado à Meta
🔄 29/05 16:02 — Status: Lead → Agendado (por: Luiz)
↩️  29/05 15:47 — Respondeu ao template (37 min depois)
📋 29/05 15:10 — Template enviado: retorno_prevencao_protocolo (UTILITY)
💬 29/05 14:33 — Mensagem recebida: "Olá! Tenho interesse..."
🟢 29/05 14:33 — Entrou via anúncio "pqe ipanema protese CTA 3" (CTWA ✓)
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

**Definições das métricas (cards e colunas da tabela):**
- *Total leads via anúncio* (card): leads com `campanha` não vazio OU `ctwa_clid` OU `gclid` não vazio, no período
- *Agendados atribuídos* (card + coluna): leads atribuídos com `data_agendamento IS NOT NULL` (proxy correto — `status` atual pode já ter avançado além de "Agendado")
- *Compareceu* (coluna da tabela): leads atribuídos com `data_comparecimento IS NOT NULL` — não é card de resumo
- *Fechados atribuídos* (card + coluna): leads atribuídos com `status = 'Fechou'`
- *Receita atribuída* (card + coluna): soma de `valor` WHERE `status = 'Fechou'` AND `valor IS NOT NULL` AND lead atribuível

**Filtro de período:** Últimos 7d / 30d / 90d / Período personalizado (padrão: 30d)

**Campo de filtro:** `leads.criado_em` — filtra quando o lead ENTROU no sistema, não quando fechou. Isso responde "qual campanha desse período gerou leads, e quantos deles converteram". Fechamentos e receita são contados independentemente do status atual.

**Tabela por anúncio:**

| Fonte | Anúncio | Leads | Agendados | Compareceu | Fechados | Receita | Conv. Lead→Fechou |
|-------|---------|-------|-----------|------------|----------|---------|------------------|
| Meta | pqe ipanema protese CTA 3 | 12 | 8 | 6 | 4 | R$ 34.000 | 33% |
| Google | implante-ipanema-search | 5 | 3 | 3 | 2 | R$ 18.000 | 40% |
| — | Orgânico / Direto | 7 | 2 | 1 | 1 | R$ 8.500 | 14% |

**Regras de agrupamento:**
- `campanha` não vazio + (`ctwa_clid` ou `fbclid` não vazio) → fonte Meta, chave = `campanha`
- `ctwa_clid` não vazio mas `campanha` vazio → fonte Meta, grupo especial "Meta Ads (sem campanha)"
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

O CRM serve o script via **rota Express dinâmica** (não arquivo estático) para injetar o token em tempo de execução. O site adiciona no `<head>`:

```html
<script src="https://plataformaama-plataforma.uc5as5.easypanel.host/track.js" defer></script>
```

`defer` em script externo funciona corretamente — carrega em paralelo e executa após o HTML, sem bloquear o site.

**Rota no server.js:**

```js
app.get('/track.js', (req, res) => {
  const token = process.env.PIXEL_TRACK_TOKEN || '';
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(`(function(){
  var p=new URLSearchParams(location.search);
  var f=p.get('fbclid')||localStorage.getItem('_ama_fbclid');
  if(f)localStorage.setItem('_ama_fbclid',f);
  if(!f)return;
  fetch('https://plataformaama-plataforma.uc5as5.easypanel.host/t',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token:${JSON.stringify(token)},fbclid:f,evento:'PageView',pagina:location.pathname,referrer:document.referrer})
  }).catch(function(){});
})();`);
});
```

O token é injetado via `JSON.stringify(token)` — nunca concatenado diretamente (evita injeção). O valor real fica em `PIXEL_TRACK_TOKEN` no `.env`.

**Segurança:** CRM valida `token === process.env.PIXEL_TRACK_TOKEN` no endpoint `/t`. Token gerado uma única vez (random 32 bytes hex) na implementação.

**Sobre SRI (Subresource Integrity):** não aplicável — o script é auto-hospedado no próprio CRM (não é CDN de terceiro). SRI quebraria o site a cada deploy. A proteção é o HTTPS já ativo no domínio Easypanel.

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
