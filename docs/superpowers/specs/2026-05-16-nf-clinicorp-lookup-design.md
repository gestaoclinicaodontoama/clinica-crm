# Design: Lookup de Paciente por ID Clinicorp no Formulário de NF

**Data:** 2026-05-16
**Status:** Aprovado para implementação

---

## Visão Geral

Ao preencher uma nota fiscal no CRM, o usuário pode digitar o ID do paciente no Clinicorp e o sistema preenche automaticamente CPF e nome completo. Evita digitação manual e erros de CPF.

O campo de lookup é uma conveniência — os campos CPF e Nome continuam editáveis após o auto-fill.

---

## Arquitetura

```
[Formulário NF no browser]
    ↓ GET /api/pacientes/clinicorp/:id
[server.js — nova rota]
    ↓ 1. SELECT cpf, nome FROM pacientes WHERE clinicorp_id = ?
[Supabase — tabela pacientes]
    ↓ 2. fallback se não encontrar no Supabase
[Clinicorp API — /patient/get]
```

A rota é somente leitura. Não cria nem altera registros. Protegida pelo mesmo middleware de autenticação do CRM.

---

## Pré-requisito: Tabela `pacientes` no Supabase

A tabela precisa existir com pelo menos estas colunas:

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `clinicorp_id` | `integer` (unique) | ID interno do Clinicorp |
| `cpf` | `text` | CPF do paciente (apenas dígitos) |
| `nome` | `text` | Nome completo |

O sync diário (job separado, fora do escopo deste spec) mantém a tabela atualizada a partir da API do Clinicorp. Se a tabela ainda não existir, criar a migration como parte desta feature.

---

## Backend — Nova Rota

**`GET /api/pacientes/clinicorp/:id`**

### Lógica

1. Consulta Supabase: `SELECT cpf, nome FROM pacientes WHERE clinicorp_id = $1 LIMIT 1`
2. Se encontrar → retorna sucesso com `fonte: "supabase"`
3. Se não encontrar → chama `clinicorpGet('/patient/get', { id: String(id) })`
4. Extrai nome e CPF da resposta do Clinicorp
   - Nome: campo `Name`
   - CPF: **⚠️ verificar nome exato do campo na resposta da API** — candidatos: `DocumentNumber`, `CPF`, `TaxpayerNumber`. Confirmar em produção antes de implementar o fallback.
5. Se nenhuma fonte retornar dados → `404`

### Resposta de sucesso (200)

```json
{
  "cpf": "12345678900",
  "nome": "João da Silva",
  "fonte": "supabase"
}
```

### Resposta de erro (404)

```json
{ "erro": "Paciente não encontrado" }
```

### Implementação em `server.js`

```js
app.get('/api/pacientes/clinicorp/:id', requireAuth, async (req, res) => {
  const clinicorpId = parseInt(req.params.id)
  if (!clinicorpId || isNaN(clinicorpId)) {
    return res.status(400).json({ erro: 'ID inválido' })
  }

  // 1. Supabase
  const { data } = await supabase
    .from('pacientes')
    .select('cpf, nome')
    .eq('clinicorp_id', clinicorpId)
    .single()

  if (data?.cpf && data?.nome) {
    return res.json({ cpf: data.cpf, nome: data.nome, fonte: 'supabase' })
  }

  // 2. Fallback Clinicorp API
  try {
    const paciente = await clinicorpGet('/patient/get', { id: String(clinicorpId) })
    const nome = paciente?.Name
    const cpf  = paciente?.DocumentNumber // ⚠️ confirmar campo real
    if (nome && cpf) {
      return res.json({ cpf: cpf.replace(/\D/g, ''), nome, fonte: 'clinicorp' })
    }
  } catch (_) {}

  return res.status(404).json({ erro: 'Paciente não encontrado' })
})
```

---

## Frontend — Formulário de NF

### Onde alterar

`public/index.html` — função `nfEditFormHtml()` que gera o HTML do modal de edição de NF.

### Campos novos

**Tomador** (sempre visível, acima do CPF/Tipo Tomador):

```html
<div class="nf-clinicorp-lookup" data-target="tomador">
  <label>ID Clinicorp (opcional)</label>
  <div class="lookup-row">
    <input type="number" id="nf-clinicorp-id-tomador" placeholder="ex: 12345" min="1">
    <button type="button" id="nf-lookup-btn-tomador">🔍</button>
  </div>
  <span class="lookup-msg" id="nf-lookup-msg-tomador"></span>
</div>
```

**Paciente** (aparece apenas quando "paciente diferente do tomador" está marcado):

```html
<div class="nf-clinicorp-lookup" data-target="paciente" style="display:none">
  <label>ID Clinicorp paciente (opcional)</label>
  <div class="lookup-row">
    <input type="number" id="nf-clinicorp-id-paciente" placeholder="ex: 12345" min="1">
    <button type="button" id="nf-lookup-btn-paciente">🔍</button>
  </div>
  <span class="lookup-msg" id="nf-lookup-msg-paciente"></span>
</div>
```

### Comportamento JavaScript

Função `lookupClinicorp(target)` onde `target` é `"tomador"` ou `"paciente"`:

1. Lê o valor do input de ID
2. Desabilita o input e o botão, mostra spinner no botão
3. Chama `GET /api/pacientes/clinicorp/:id`
4. **Sucesso:** preenche CPF e Nome, aplica classe `lookup-ok` (verde) por 2s
5. **404:** classe `lookup-erro` (vermelho) no input, exibe "Paciente não encontrado"
6. **Erro de rede:** exibe "Erro ao buscar paciente"
7. Reabilita input e botão após qualquer resultado

**Triggers:** Enter no campo de ID ou clique no botão 🔍

**Integração com toggle de paciente diferente:**
- Checkbox marcado → exibir bloco de lookup do paciente
- Desmarcado → ocultar e limpar o campo de ID do paciente

### CSS

```css
.lookup-row { display: flex; gap: 6px; align-items: center; }
.lookup-row input { flex: 1; }
.lookup-ok { border-color: #22c55e !important; }
.lookup-erro { border-color: #ef4444 !important; }
.lookup-msg { font-size: 0.8rem; color: #ef4444; min-height: 1rem; }
```

---

## Fluxo Completo

```
Usuário digita ID "15432" → pressiona Enter
    ↓
GET /api/pacientes/clinicorp/15432
    ↓
Supabase: encontrou { cpf: "01234567890", nome: "Maria Souza" }
    ↓
Frontend preenche cpf_tomador e nome_tomador
Campo ID fica verde por 2s
    ↓
Usuário pode editar manualmente se necessário → salva NF normalmente
```

---

## Tratamento de Erros

| Situação | Backend | Frontend |
|----------|---------|----------|
| ID inválido (letras, zero) | 400 | Não dispara — validação no frontend |
| Não encontrado em nenhuma fonte | 404 | Campo vermelho, "Paciente não encontrado" |
| Supabase indisponível | Fallback para Clinicorp | Transparente |
| Clinicorp API indisponível | 404 | Campo vermelho |
| Erro de rede no frontend | — | "Erro ao buscar paciente" |

---

## Fora de Escopo

- Job de sync diário dos pacientes (spec separado)
- Busca por nome ou CPF (apenas por ID Clinicorp)
- Autocomplete enquanto digita

---

## Pontos em Aberto

1. **Nome do campo CPF na API do Clinicorp** — confirmar antes de implementar o fallback. Testar com um ID real via `clinicorpGet('/patient/get', { id: '123' })` e inspecionar a resposta.
2. **Tabela `pacientes` no Supabase** — verificar se já existe; se não, criar a migration como parte desta implementação.
