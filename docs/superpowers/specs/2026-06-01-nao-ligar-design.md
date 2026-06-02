# Não Ligar — Exclusão Pontual e Blacklist Permanente nas Campanhas de Discagem

**Goal:** Permitir que CRCs excluam contatos específicos antes de lançar uma campanha (exclusão pontual via checkbox no modal) e marquem contatos como "nunca ligar" (blacklist permanente que os remove de todas as campanhas futuras automaticamente).

**Architecture:** Modal de preview ganha checkboxes + botão "🚫 Nunca ligar" inline. Backend recebe lista de IDs a excluir no lançamento. Blacklist persistida em `nao_ligar_pacientes` (separada de `pacientes_abc` para não ser sobrescrita pela sync Clinicorp) e coluna `nao_ligar` na tabela `leads`. `buscarContatos()` filtra blacklist buscando os IDs bloqueados primeiro e filtrando em JS (Supabase client não suporta NOT EXISTS nativo).

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

CREATE POLICY "nao_ligar_pacientes_select" ON nao_ligar_pacientes
  FOR SELECT USING (
    (auth.jwt() -> 'user_metadata' ->> 'role') IN ('crc_leads','crc_comercial','gestor','admin')
  );

CREATE POLICY "nao_ligar_pacientes_insert" ON nao_ligar_pacientes
  FOR INSERT WITH CHECK (
    (auth.jwt() -> 'user_metadata' ->> 'role') IN ('crc_leads','crc_comercial','gestor','admin')
  );

CREATE POLICY "nao_ligar_pacientes_delete" ON nao_ligar_pacientes
  FOR DELETE USING (
    (auth.jwt() -> 'user_metadata' ->> 'role') IN ('gestor','admin')
  );
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

- `tipo: 'paciente'` → `INSERT INTO nao_ligar_pacientes (clinicorp_id) VALUES ($id) ON CONFLICT DO NOTHING`
- `tipo: 'lead'` → `UPDATE leads SET nao_ligar = true WHERE id = $id`
- Roles: `requireCrcLead`
- Resposta: `{ ok: true }`
- Erro 400 se `tipo` não for 'paciente' ou 'lead', ou se `id` estiver ausente

### Alteração em `buscarContatos(tipo)`

**abc — filtrar com lista em memória** (Supabase client não suporta NOT EXISTS nativo):

```js
// 1. Buscar blacklist
const { data: bloqueados } = await supabase
  .from('nao_ligar_pacientes')
  .select('clinicorp_id');
const bloqueadosSet = new Set((bloqueados || []).map(r => String(r.clinicorp_id)));

// 2. Buscar pacientes normalmente
const { data } = await supabase
  .from('pacientes_abc')
  .select('nome, telefone, clinicorp_id, dias_sem_visita')
  .in('classe', ['A', 'B'])
  .gte('dias_sem_visita', 180)
  .is('proxima_consulta', null);

// 3. Filtrar blacklist em JS
return (data || []).filter(p => !bloqueadosSet.has(String(p.clinicorp_id)));
```

**indicacoes / recentes / frios** — adicionar `.eq('nao_ligar', false)` na query Supabase existente (é coluna nativa, sem overhead extra).

### Alteração em `POST /api/campanhas/lancar`

Aceita campo opcional `excluir: string[]` no body. O campo significa coisas diferentes por tipo:
- `tipo: 'abc'` → lista de `clinicorp_id` a excluir
- `tipo: 'indicacoes' | 'recentes' | 'frios'` → lista de `id` (UUID) de lead a excluir

Após buscar contatos (já sem blacklist), filtra adicionalmente:

```js
const excluirSet = new Set((body.excluir || []).map(String));
if (excluirSet.size > 0) {
  const idField = body.tipo === 'abc' ? 'clinicorp_id' : 'id';
  contatos = contatos.filter(c => !excluirSet.has(String(c[idField])));
}
```

### Alteração em `GET /api/campanhas/preview/:tipo`

Sem mudança no backend — o endpoint já retorna todos os contatos. O limite de exibição (100) é só no frontend.

O campo de ID retornado por cada tipo (usado para exclusão):
- `abc` → `clinicorp_id` (já retornado na query atual)
- `indicacoes / recentes / frios` → `id` (UUID do lead, já retornado)

---

## 3. UI — Modal de preview (compartilhado)

O mesmo modal é usado em Curva ABC (`curva-abc.js`) e Leads (`index.html`). As mudanças se aplicam a ambos.

### Limite de exibição e aviso

O modal exibe **até 100 contatos**. Se `preview.total > 100`, exibir aviso abaixo da tabela:

> ℹ️ Mostrando os primeiros 100 de N. Os demais serão incluídos automaticamente. Use 🚫 Nunca ligar para excluí-los permanentemente.

Contatos além do 100º são sempre incluídos no lançamento (não há como excluí-los pontualmente nesta campanha — somente via "Nunca ligar" em campanhas futuras).

### Estrutura da linha

Cada linha ganha checkbox à esquerda:

```
☑  João Silva     | 31999...  | 210 dias
☐  Maria Souza    | 31988...  | 195 dias   [🚫 Nunca ligar]  ← aparece ao desmarcar
```

- Todos os checkboxes começam marcados
- Cabeçalho da tabela: checkbox "Selecionar todos / Desmarcar todos" + contador `"X de N selecionados"` onde N = quantidade exibida (≤ 100)
- Ao desmarcar uma linha: linha fica `opacity: 0.45` + botão **"🚫 Nunca ligar"** aparece inline
- Ao re-marcar uma linha desmarcada (sem "nunca ligar"): volta ao normal, botão some
- Ao clicar **"🚫 Nunca ligar"**: exibir `confirm()` com mensagem `"Adicionar [Nome] à lista de não ligar? Esta pessoa não será incluída em nenhuma campanha futura."` — se confirmado, chama `POST /api/campanhas/nao-ligar`; se cancelado, nada muda
- Após confirmar "nunca ligar": botão some, linha permanece desmarcada e ganha badge cinza `"Bloqueado"`, checkbox fica desabilitado (não pode re-marcar)
- Linhas já na blacklist: não aparecem (filtradas no backend antes do preview)

### Botão Confirmar

- Label dinâmico: `"📞 Enviar X para discagem"` onde X = quantidade de checkboxes marcados
- Ao confirmar: coleta IDs das linhas **desmarcadas** (não-bloqueadas) → envia `{ tipo, excluir: [ids] }` para `POST /api/campanhas/lancar`
- Se 0 contatos selecionados: botão desabilitado com label `"Nenhum contato selecionado"`

### Implementação por módulo

**`curva-abc.js`** — modificar `_abrirModalCampanha()`:
- ID de exclusão: `c.clinicorp_id`
- Chamar blacklist via `backendApi('POST', '/api/campanhas/nao-ligar', { tipo: 'paciente', id: c.clinicorp_id })`

**`index.html`** — modificar `_abrirModalCampanhaLeads()`:
- ID de exclusão: `c.id`
- Chamar blacklist via `api('/api/campanhas/nao-ligar', { method: 'POST', body: JSON.stringify({ tipo: 'lead', id: c.id }) })`

---

## 4. Roles e permissões

| Ação | Roles |
|---|---|
| Marcar como "nunca ligar" | `crc_leads`, `crc_comercial`, `gestor`, `admin` |
| Excluir da blacklist (reverter) | `gestor`, `admin` — via Supabase direto (sem UI neste escopo) |

---

## 5. Tratamento de erros

| Cenário | Comportamento |
|---|---|
| Erro ao salvar "nunca ligar" | Toast de erro inline, linha volta ao estado desmarcado normal (sem badge "Bloqueado") |
| Lançamento com `excluir` inválido (IDs não encontrados) | Backend ignora silenciosamente — filtro em Set não quebra |
| `nao_ligar` column ausente em leads antigos | `DEFAULT false` garante compatibilidade retroativa |

---

## 6. Fora de escopo

- UI para listar e remover pessoas da blacklist (gestores acessam via Supabase se necessário)
- Exclusão de contatos além do 100º de forma pontual (somente "nunca ligar" os exclui permanentemente)
- Sincronização bidirecional com o 3cplus
- Exclusão em lote (ex.: "remover todos da classe C")
