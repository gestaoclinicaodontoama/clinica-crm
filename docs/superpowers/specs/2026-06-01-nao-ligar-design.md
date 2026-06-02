# Não Ligar — Exclusão Pontual e Blacklist Permanente nas Campanhas de Discagem

**Goal:** Permitir que CRCs excluam contatos específicos antes de lançar uma campanha (exclusão pontual via checkbox no modal) e marquem contatos como "nunca ligar" (blacklist permanente que os remove de todas as campanhas futuras automaticamente).

**Architecture:** Modal de preview ganha checkboxes + botão "🚫 Nunca ligar" inline. Backend recebe lista de IDs a excluir no lançamento. Blacklist persistida em `nao_ligar_pacientes` (separada de `pacientes_abc` para não ser sobrescrita pela sync Clinicorp) e coluna `nao_ligar` na tabela `leads`. `buscarContatos()` filtra blacklist automaticamente em todos os previews e lançamentos.

**Tech Stack:** Node.js + Express, Supabase Postgres, HTML/CSS/JS vanilla.

---

## 1. Banco de dados

### Tabela nova: `nao_ligar_pacientes`

```sql
CREATE TABLE nao_ligar_pacientes (
  clinicorp_id TEXT PRIMARY KEY,
  criado_em    TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE nao_ligar_pacientes ENABLE ROW LEVEL SECURITY;
-- SELECT e INSERT para roles crc_leads, crc_comercial, gestor, admin
-- DELETE para roles gestor, admin (remoção da blacklist só por gestores)
```

Separada de `pacientes_abc` porque a sync do Clinicorp faz UPSERT e sobrescreveria colunas adicionadas lá.

### Coluna nova em `leads`

```sql
ALTER TABLE leads ADD COLUMN nao_ligar BOOLEAN NOT NULL DEFAULT false;
```

---

## 2. Backend

### Endpoint novo

```
POST /api/campanhas/nao-ligar
Body: { tipo: 'paciente' | 'lead', id: string }
```

- `tipo: 'paciente'` → insere `clinicorp_id = id` em `nao_ligar_pacientes` (ON CONFLICT DO NOTHING — idempotente)
- `tipo: 'lead'` → `UPDATE leads SET nao_ligar = true WHERE id = id`
- Roles: `requireCrcLead`
- Resposta: `{ ok: true }`

### Alteração em `buscarContatos(tipo)`

Todos os 4 tipos filtram blacklist automaticamente:

- **abc:** adiciona `AND NOT EXISTS (SELECT 1 FROM nao_ligar_pacientes nlp WHERE nlp.clinicorp_id = p.clinicorp_id::text)`
- **indicacoes / recentes / frios:** adiciona `AND nao_ligar = false`

### Alteração em `POST /api/campanhas/lancar`

Aceita campo opcional `excluir: string[]` no body (lista de IDs — `clinicorp_id` para abc, `id` de lead para os demais). Após buscar contatos, filtra adicionalmente:

```js
const excluirSet = new Set(body.excluir || []);
let contatos = await buscarContatos(tipo);
if (excluirSet.size > 0) {
  contatos = contatos.filter(c => !excluirSet.has(String(c.clinicorp_id || c.id)));
}
```

### Alteração em `GET /api/campanhas/preview/:tipo`

Passa a retornar **até 100 contatos** (era 20 — o limite era só no frontend, o backend já retornava tudo; agora o frontend exibe até 100).

---

## 3. UI — Modal de preview (compartilhado)

O mesmo modal é usado em Curva ABC (`curva-abc.js`) e Leads (`index.html`). As mudanças se aplicam a ambos.

### Estrutura da linha

Cada linha ganha checkbox à esquerda:

```
☑  João Silva     | 31999...  | 210 dias    [🚫 Nunca ligar]  ← aparece só ao desmarcar
```

- Todos os checkboxes começam marcados
- Cabeçalho da tabela: `☑ Selecionar todos` + contador `"X de N selecionados"`
- Ao desmarcar uma linha: linha fica `opacity: 0.4` + botão **"🚫 Nunca ligar"** aparece inline
- Ao clicar "🚫 Nunca ligar": chama `POST /api/campanhas/nao-ligar` → botão some, linha permanece desmarcada e ganha badge `"Bloqueado"`
- Ao re-marcar uma linha desmarcada (que NÃO foi marcada como nunca ligar): volta ao normal
- Linhas já na blacklist: não aparecem (filtradas no backend antes do preview)

### Botão Confirmar

- Label dinâmico: `"📞 Enviar X para discagem"` (atualiza conforme checkboxes)
- Ao confirmar: coleta IDs desmarcados → envia `{ tipo, excluir: [...] }` para `POST /api/campanhas/lancar`
- Se 0 contatos selecionados: botão desabilitado

### Implementação

- `curva-abc.js`: modificar `_abrirModalCampanha()` — o ID de exclusão é `c.clinicorp_id` (campo já retornado pelo preview abc)
- `index.html`: modificar `_abrirModalCampanhaLeads()` — o ID de exclusão é `c.id` (campo já retornado pelos previews de leads)
- O helper `cw_api` / `api()` já disponível em cada contexto é usado para chamar `POST /api/campanhas/nao-ligar`

---

## 4. Roles e permissões

| Ação | Roles |
|---|---|
| Marcar como "nunca ligar" | `crc_leads`, `crc_comercial`, `gestor`, `admin` |
| Excluir da blacklist | `gestor`, `admin` (via Supabase direto — sem UI neste escopo) |

---

## 5. Fora de escopo

- UI para listar e remover pessoas da blacklist (gestores acessam via Supabase se necessário)
- Sincronização bidirecional com o 3cplus
- Exclusão em lote (ex.: "remover todos da classe C")
