# Clinicorp ID Lookup no Formulário de NF — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar campo "ID Clinicorp" no formulário de NF do CRM que, ao ser preenchido, busca e preenche automaticamente CPF e Nome do paciente/tomador.

**Architecture:** Nova rota `GET /api/pacientes/clinicorp/:id` no `server.js` consulta primeiro o Supabase (tabela `pacientes`), com fallback para a Clinicorp API. O frontend adiciona um input de ID e botão 🔍 acima dos campos CPF/Nome tanto para Tomador quanto para Paciente (este último aparece só quando o toggle "paciente diferente" está ativo).

**Tech Stack:** Node.js/Express (backend), HTML/CSS/JS vanilla (frontend, sem framework), Supabase JS SDK, HTTPS nativo Node.js para Clinicorp API.

---

## Mapa de Arquivos

| Arquivo | Ação | O que muda |
|---------|------|-----------|
| `server.js` | Modificar | Nova rota `GET /api/pacientes/clinicorp/:id` (inserir antes de `processarInadimplentes`, linha ~1051) |
| `public/index.html` | Modificar | CSS (~linha 364), HTML em `nfEditFormHtml()` (~linha 2259), nova função `lookupClinicorp()`, atualizar `nfeTogglePac()` |

---

## Observação crítica: `clinicorpGet` retorna `{ status, data }`

A função `clinicorpGet` (server.js:1021) resolve com `{ status: number, data: T }`. Código legado (linhas 1208-1219) acessa `.Name` diretamente no resultado — provavelmente um bug silencioso. A nova rota usa `result?.data` corretamente para acessar o objeto paciente.

---

## Task 1: Supabase — adicionar coluna `cpf` em `pacientes`

**Files:**
- (executado via Supabase MCP — sem arquivo local a commitar)

A tabela `pacientes` existe mas não tem coluna `cpf` (o upsert em server.js:1211 nunca salva CPF). Necessário para o lookup via Supabase.

- [ ] **Step 1: Verificar se coluna existe**

Execute via Supabase MCP (`execute_sql`) ou SQL Editor:

```sql
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'pacientes' AND column_name = 'cpf';
```

Esperado: 0 linhas.

- [ ] **Step 2: Aplicar migration**

```sql
ALTER TABLE pacientes
  ADD COLUMN IF NOT EXISTS cpf text;
```

- [ ] **Step 3: Confirmar**

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'pacientes' AND column_name = 'cpf';
```

Esperado: 1 linha com `column_name=cpf, data_type=text`.

- [ ] **Step 4: Commit placeholder**

```bash
git commit --allow-empty -m "chore: migration pacientes.cpf applied on Supabase"
```

---

## Task 2: Backend — rota `GET /api/pacientes/clinicorp/:id`

**Files:**
- Modify: `server.js` (inserir antes de `function processarInadimplentes`, linha ~1051)

- [ ] **Step 1: Localizar ponto de inserção**

Abra `server.js` e encontre:

```js
function processarInadimplentes(items, today) {
```

A nova rota vai ser inserida exatamente ANTES dessa linha.

- [ ] **Step 2: Inserir a rota**

```js
// GET /api/pacientes/clinicorp/:id — lookup por ID Clinicorp, usado no formulario NF
app.get('/api/pacientes/clinicorp/:id', requireAuth, async (req, res) => {
  const clinicorpId = parseInt(req.params.id, 10);
  if (!clinicorpId || isNaN(clinicorpId) || clinicorpId <= 0) {
    return res.status(400).json({ erro: 'ID invalido' });
  }

  // 1. Busca no Supabase (cache local)
  const { data: row } = await supabase
    .from('pacientes')
    .select('cpf, nome')
    .eq('clinicorp_id', clinicorpId)
    .maybeSingle();

  if (row?.cpf && row?.nome) {
    return res.json({ cpf: row.cpf, nome: row.nome, fonte: 'supabase' });
  }

  // 2. Fallback: Clinicorp API
  // clinicorpGet resolve com { status, data } — objeto paciente em result.data
  try {
    const result = await clinicorpGet('/patient/get', { id: String(clinicorpId) });
    const p = result?.data;
    const nome = p?.Name;
    // Campo CPF varia por conta — candidatos: DocumentNumber, CPF, TaxpayerNumber
    const cpfRaw = p?.DocumentNumber || p?.CPF || p?.TaxpayerNumber;
    if (nome && cpfRaw) {
      return res.json({ cpf: String(cpfRaw).replace(/\D/g, ''), nome, fonte: 'clinicorp' });
    }
  } catch (_) { /* API indisponivel */ }

  return res.status(404).json({ erro: 'Paciente nao encontrado' });
});

```

- [ ] **Step 3: Testar manualmente (servidor local)**

Inicie: `node server.js`

Teste com ID Clinicorp real:
```bash
curl -H "Authorization: Bearer SEU_TOKEN" \
  http://localhost:3000/api/pacientes/clinicorp/12345
```

Esperado (paciente no Supabase): `{"cpf":"01234567890","nome":"Maria Souza","fonte":"supabase"}`
Esperado (só na API Clinicorp): `{"cpf":"...","nome":"...","fonte":"clinicorp"}`
Esperado (inexistente): HTTP 404 `{"erro":"Paciente nao encontrado"}`

**Se `fonte:"clinicorp"` retornar CPF vazio:** adicione log temporário `console.log('[DBG]', JSON.stringify(result?.data))` e identifique o campo correto.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: GET /api/pacientes/clinicorp/:id — lookup CPF+nome por ID Clinicorp"
```

---

## Task 3: Frontend — CSS

**Files:**
- Modify: `public/index.html` (após linha ~364, dentro do bloco de estilos `.nf-*`)

- [ ] **Step 1: Localizar ponto de inserção**

Encontre esta linha em `public/index.html`:

```css
.nf-row-btns button.rst:hover { border-color:#f59e0b; color:#f59e0b; }
```

- [ ] **Step 2: Adicionar CSS logo após essa linha**

```css
.lookup-row { display:flex; gap:6px; align-items:center; }
.lookup-row input { flex:1; }
.lookup-row button { padding:4px 10px; font-size:12px; border:1px solid var(--border); background:var(--bg3); color:var(--text); border-radius:6px; cursor:pointer; font-family:inherit; transition:all .12s; white-space:nowrap; }
.lookup-row button:hover { border-color:var(--accent); color:var(--accent); }
.lookup-row button:disabled { opacity:.5; cursor:default; }
.lookup-ok { border-color:#22c55e !important; }
.lookup-erro { border-color:#ef4444 !important; }
.lookup-msg { font-size:11px; color:#ef4444; min-height:1rem; display:block; margin-top:2px; }
```

- [ ] **Step 3: Verificar (visual)**

Salve e abra o CRM. O formulário NF existente deve ter aparência idêntica — os novos estilos só afetam classes `.lookup-*` que ainda não existem no HTML.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "style: CSS lookup ID Clinicorp no formulario NF"
```

---

## Task 4: Frontend — HTML em `nfEditFormHtml()`

**Files:**
- Modify: `public/index.html` — função `nfEditFormHtml()` (~linha 2259)

Dois blocos a inserir: lookup para Tomador (dentro do grid principal) e lookup para Paciente (antes de `nfe-pac-area`).

- [ ] **Step 1: Adicionar bloco Tomador**

Dentro da template string de `nfEditFormHtml()`, encontre:

```html
        <div>
          <div class="nf-field-label">Tipo Tomador</div>
          <select class="nf-ci-sel" id="nfe-tipo">
```

Insira o seguinte `<div>` ANTES desse trecho (ainda dentro do grid de 4 colunas):

```html
        <div style="grid-column:span 4">
          <div class="nf-field-label">ID Clinicorp — Tomador (opcional)</div>
          <div class="lookup-row">
            <input type="number" class="nf-ci" id="nf-clinicorp-id-tomador" placeholder="ex: 12345" min="1" onkeydown="if(event.key==='Enter'){event.preventDefault();lookupClinicorp('tomador')}">
            <button type="button" id="nf-lookup-btn-tomador" onclick="lookupClinicorp('tomador')">&#128269; Buscar</button>
          </div>
          <span class="lookup-msg" id="nf-lookup-msg-tomador"></span>
        </div>
```

- [ ] **Step 2: Adicionar bloco Paciente**

Ainda em `nfEditFormHtml()`, encontre:

```html
      <div id="nfe-pac-area" style="display:${pac?'grid':'none'};grid-template-columns:1fr 1fr 1fr;gap:10px 16px;margin-top:8px">
```

Insira este bloco ANTES dessa linha:

```html
      <div id="nfe-pac-lookup-area" style="display:${pac?'block':'none'};margin-top:8px">
        <div class="nf-field-label">ID Clinicorp — Paciente (opcional)</div>
        <div class="lookup-row">
          <input type="number" class="nf-ci" id="nf-clinicorp-id-paciente" placeholder="ex: 12345" min="1" onkeydown="if(event.key==='Enter'){event.preventDefault();lookupClinicorp('paciente')}">
          <button type="button" id="nf-lookup-btn-paciente" onclick="lookupClinicorp('paciente')">&#128269; Buscar</button>
        </div>
        <span class="lookup-msg" id="nf-lookup-msg-paciente"></span>
      </div>
```

- [ ] **Step 3: Verificar no browser**

Abra formulário NF. Deve aparecer:
- Campo "ID Clinicorp — Tomador (opcional)" com input e botão antes de Tipo/CPF Tomador
- Marcando "Paciente diferente do tomador" → aparece "ID Clinicorp — Paciente" antes dos campos do paciente

Botões ainda não funcionam (Task 5 implementa a função JS).

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: HTML campos lookup ID Clinicorp em nfEditFormHtml()"
```

---

## Task 5: Frontend — função `lookupClinicorp(target)`

**Files:**
- Modify: `public/index.html` — inserir após `nfeTogglePac()` (~linha 2353)

- [ ] **Step 1: Identificar como o CRM passa o token JWT nas requisições fetch**

Execute no console do browser (com CRM aberto e logado):

```js
// Tente estas variaveis uma por uma ate achar a que tem o token JWT:
window._token; window._authToken; window.authToken; window._jwt;
```

Ou grep no arquivo: procure por `Authorization.*Bearer` em `public/index.html` para ver qual variavel é usada.

Anote o nome da variavel (ex: `_token`). Substitua `window._authToken` na função abaixo pelo nome correto.

- [ ] **Step 2: Inserir função após `nfeTogglePac()`**

```js
async function lookupClinicorp(target) {
  const idInput   = document.getElementById('nf-clinicorp-id-' + target);
  const btn       = document.getElementById('nf-lookup-btn-' + target);
  const msgEl     = document.getElementById('nf-lookup-msg-' + target);
  const cpfInput  = document.getElementById(target === 'tomador' ? 'nfe-cpf' : 'nfe-cpf-pac');
  const nomeInput = document.getElementById(target === 'tomador' ? 'nfe-nome' : 'nfe-nome-pac');

  const id = parseInt(idInput.value, 10);
  if (!id || id <= 0) {
    msgEl.textContent = 'Digite um ID valido';
    idInput.classList.add('lookup-erro');
    return;
  }

  idInput.disabled = true;
  btn.disabled = true;
  btn.textContent = '⏳';
  idInput.classList.remove('lookup-ok', 'lookup-erro');
  msgEl.textContent = '';

  try {
    const token = window._authToken || '';  // SUBSTITUIR pelo nome correto (Step 1)
    const resp = await fetch('/api/pacientes/clinicorp/' + id, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (resp.ok) {
      const data = await resp.json();
      cpfInput.value  = data.cpf  || '';
      nomeInput.value = data.nome || '';
      idInput.classList.add('lookup-ok');
      msgEl.style.color = '#22c55e';
      msgEl.textContent = 'Preenchido via ' + (data.fonte === 'supabase' ? 'cadastro local' : 'Clinicorp API');
      setTimeout(() => {
        idInput.classList.remove('lookup-ok');
        msgEl.textContent = '';
        msgEl.style.color = '#ef4444';
      }, 3000);
    } else if (resp.status === 404) {
      idInput.classList.add('lookup-erro');
      msgEl.textContent = 'Paciente nao encontrado';
    } else {
      idInput.classList.add('lookup-erro');
      msgEl.textContent = 'Erro ' + resp.status + ' ao buscar';
    }
  } catch (_) {
    idInput.classList.add('lookup-erro');
    msgEl.textContent = 'Erro de rede';
  } finally {
    idInput.disabled = false;
    btn.disabled = false;
    btn.textContent = '🔍 Buscar';
  }
}
```

- [ ] **Step 3: Testar no browser — fluxo feliz**

1. Abra formulário NF
2. Digite um ID Clinicorp real no campo Tomador
3. Pressione Enter → input desabilita, botão vira ⏳, depois volta
4. CPF e Nome preenchidos, campo verde por 3s, mensagem "Preenchido via..."

- [ ] **Step 4: Testar — caso de erro**

1. Digite `99999999` → "Paciente nao encontrado", campo vermelho
2. Delete o valor, clique Buscar → "Digite um ID valido"
3. Desligue o servidor e tente → "Erro de rede"

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: lookupClinicorp() — preenchimento automatico CPF+nome por ID Clinicorp"
```

---

## Task 6: Frontend — atualizar `nfeTogglePac()`

**Files:**
- Modify: `public/index.html` — função `nfeTogglePac()` (~linha 2350)

- [ ] **Step 1: Substituir a função**

Atual:
```js
function nfeTogglePac() {
  document.getElementById('nfe-pac-area').style.display =
    document.getElementById('nfe-pac-diff').checked ? 'grid' : 'none';
}
```

Novo:
```js
function nfeTogglePac() {
  const checked = document.getElementById('nfe-pac-diff').checked;
  document.getElementById('nfe-pac-area').style.display = checked ? 'grid' : 'none';
  document.getElementById('nfe-pac-lookup-area').style.display = checked ? 'block' : 'none';
  if (!checked) {
    const idInput = document.getElementById('nf-clinicorp-id-paciente');
    if (idInput) { idInput.value = ''; idInput.classList.remove('lookup-ok', 'lookup-erro'); }
    const msgEl = document.getElementById('nf-lookup-msg-paciente');
    if (msgEl) { msgEl.textContent = ''; }
  }
}
```

- [ ] **Step 2: Testar no browser**

1. Marque "Paciente diferente do tomador" → lookup paciente aparece junto com campos CPF/Nome Paciente
2. Desmarque → bloco some e campo ID é limpo
3. Marque novamente → campo ID está vazio

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: nfeTogglePac() controla visibilidade e limpeza do lookup paciente"
```

---

## Task 7: Deploy e smoke test final

- [ ] **Step 1: Push e deploy**

```bash
git push origin master
```

```bash
curl -X POST http://2.24.94.120:3000/api/deploy/SEU_DEPLOY_TOKEN
```

- [ ] **Step 2: Smoke test em produção**

| Cenário | Ação | Esperado |
|---------|------|---------|
| ID válido (tomador) | Digita ID real, Enter | CPF e Nome preenchidos, campo verde |
| ID vazio / zero | Clica Buscar sem digitar | Mensagem "Digite um ID valido" |
| ID inexistente | Digita `99999999`, Enter | Campo vermelho, "Paciente nao encontrado" |
| Paciente diferente | Marca toggle, digita ID | Bloco aparece, lookup funciona |
| Desmarcar toggle | Desmarca após lookup paciente | Bloco some, ID limpo |
| Campos editáveis | Após lookup, edita CPF manualmente | Campo aceita edição normalmente |
| Salvar NF | Preenche tudo via lookup, salva | NF criada com CPF/Nome corretos no banco |

- [ ] **Step 3: Se `fonte:"clinicorp"` retornar CPF vazio**

Acesse os logs do servidor no Easypanel. Identifique o nome do campo CPF real na resposta da API Clinicorp e corrija em `server.js`:

```js
const cpfRaw = p?.DocumentNumber || p?.CPF || p?.TaxpayerNumber;
// adicione o campo correto antes dos outros
```

Faça novo push + deploy.