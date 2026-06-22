# Retorno de Prevenção — Lista de pacientes por última prevenção (180 dias)

**Goal:** Saber, para cada paciente, **quando foi a última vez que fez prevenção** e quem está vencido (>180 dias), pra CRC trazer de volta. "Prevenção" tem vários nomes por convênio; a solução normaliza pelo **nome do procedimento** (com a lista aprovada pelo Luiz) sobre os **procedimentos realizados** (`Executed="X"`) do Clinicorp. A entrega vive dentro da página **Curva ABC evoluída** (coluna nova + colunas ordenáveis + filtros), não numa página separada.

**Tech Stack:** Node.js + Express (`server.js`), Supabase Postgres, HTML/CSS/JS vanilla. Deploy Easypanel.

**Faseamento:** **Fase 1** (este spec) = coleta + dados + página com a lista funcionando. **Fase 2** (esboçada no fim) = seleção múltipla → discador 3cplus + "não ligar" (nunca mais / este mês).

---

## Validação ao vivo (maio/2026) — o que sustenta o desenho

Testado contra dados reais da API antes de codar:

- **Fonte autoritativa = `estimates/list`** (procedimentos com `Executed="X"` + `ExecutedDate`). `appointment/list` (só ~18% têm procedimento estruturado; campo `Procedures` é texto livre), `payment/list` e `financial/list_summary` (descrições genéricas) **não servem**.
- **Resolução de nome: `PriceId`→catálogo `procedures/list.id` = 96,6%** (806/834). ⚠️ o `id` do catálogo casa com `PriceId`, NÃO com `Procedure_CharacteristicId`.
- **Matching por NOME, não por código:** casar só por código deu 39 procedimentos em maio; por **nome normalizado** deu **223 procedimentos / 108 pacientes** (159 adulto, 64 infantil). Várias listas de preço registram o procedimento sem o código → código sozinho sub-conta ~5×.
- Profissionais batem: Helen (119) = prevenção adulto/TSB; Ana Luiza (62) = infantil.

---

## Decisões fechadas no brainstorm

- **Definição de "fez prevenção":** procedimento de prevenção **realizado** (`Executed="X"`), data = `ExecutedDate`. Ciclo = **180 dias** (vencido = >180d ou nunca).
- **O que conta (lista do Luiz, vira config editável):** profilaxia/polimento coronário; aplicação tópica de flúor / verniz / remineralização; controle de biofilme/placa; atividade educativa; **raspagem SUPRA-gengival**; aplicação de selante; aplicação de cariostático; **condicionamento** (infantil); pacotes de prevenção/atendimento preventivo.
- **O que NÃO conta:** **Consulta sozinha** (81000065/81000030 — genérica, vem em tudo; só conta se acompanhada de procedimento preventivo, o que já acontece naturalmente porque o gatilho é o procedimento preventivo, não a consulta); **raspagem SUB-gengival e manutenção periodontal** (tratamento perio, exige especialista, não está na lista); ortodontia, prótese, cálculo salivar, exodontia/pulpotomia, imobilização dentária.
- **Categorias = Adulto × Infantil.** Infantil = especialidade `Odontopediatria` **ou** profissional Dra. Ana Luiza. Sem categoria "periodontia" no retorno de prevenção.
- **Página única:** evoluir `curva-abc.html` (colunas ordenáveis + coluna "última prevenção" + filtro Adulto/Infantil + preset "Retorno de Prevenção"). **Remover `recall.html`** do menu (era recall por visita, conceito errado).
- **Escopo de pacientes:** todos da base ABC (com histórico), incluindo "Nunca fez prevenção". Cuidado com "Nunca": Clinicorp é recente → cruzar com `ultima_visita` pra distinguir "veio mas sem prevenção" de "sumido há anos".
- **Ordenação default da visão prevenção:** vencidos do **menos vencido (≈180d) ao mais** (mais fácil recuperar quem vinha certinho).
- **Histórico:** desde o início do Clinicorp (~2023→hoje).

---

## 1. Banco de dados

### 1.1 Config de classificação — `prevencao_procedimentos`

Tabela editável (espírito de `tratamentos_config`), **semeada com a lista do Luiz**. Matching por `nome_norm` (nome sem código/acento/caixa). Permite ligar/desligar item a item.

```sql
CREATE TABLE prevencao_procedimentos (
  id            BIGSERIAL PRIMARY KEY,
  nome_norm     TEXT NOT NULL UNIQUE,   -- chave de match (normalizada)
  nome_exibicao TEXT NOT NULL,
  categoria     TEXT NOT NULL,          -- 'adulto' | 'infantil' | 'excluir'
  incluir       BOOLEAN NOT NULL DEFAULT TRUE,
  observacao    TEXT,
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);
```

**Seed (`incluir=true`):** `profilaxia` / `polimento coronario`; `aplicacao topica de fluor` / `verniz fluoretado` / `fluor verniz` / `remineralizacao` / `fluorterapia`; `controle de biofilme` / `controle de placa` / `remocao dos fatores de retencao do biofilme`; `atividade educativa` / `orientacao de higiene`; `raspagem supra`; `aplicacao de selante`; `aplicacao de cariostatico`; `condicionamento` (→categoria `infantil`); `pacote de prevencao` / `pacote de atendimento` / `pacote atendimento preventivo`; `prevencao`.

**Regras duras no código (não dependem do seed):** `consulta` nunca dispara sozinha; qualquer `sub-gengival` é ignorado; categoria vira `infantil` se expertise=`Odontopediatria` ou profissional Ana Luiza.

> Matching por nome cobre convênios novos automaticamente (mesmo procedimento, nomes/códigos variados). Procedimento executado sem match → "não classificado" (auditoria), não conta.

### 1.2 Eventos detalhados — `prevencao_eventos`

```sql
CREATE TABLE prevencao_eventos (
  id                BIGSERIAL PRIMARY KEY,
  clinicorp_id      BIGINT NOT NULL,     -- Patient_PersonId
  data              DATE NOT NULL,       -- ExecutedDate
  categoria         TEXT NOT NULL,       -- 'adulto' | 'infantil'
  procedimento      TEXT,                -- nome resolvido via PriceId
  expertise         TEXT,
  dentist_person_id BIGINT,
  profissional      TEXT,
  bill_type         TEXT,                -- 'CLAIM' (convênio) | particular
  treatment_id      BIGINT,
  sincronizado_em   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (clinicorp_id, data, categoria, treatment_id)
);
CREATE INDEX idx_prev_eventos_pac ON prevencao_eventos (clinicorp_id);
```

Dedup natural: vários procedimentos preventivos no mesmo dia/tratamento colapsam numa data (resolve "soma de procedimentos = uma limpeza").

### 1.3 Agregados em `pacientes_abc`

O sync já faz UPSERT nesta tabela; o mesmo sync computa estas colunas:

```sql
ALTER TABLE pacientes_abc
  ADD COLUMN ultima_prevencao          DATE,   -- max(adulto, infantil)
  ADD COLUMN ultima_prevencao_adulto   DATE,
  ADD COLUMN ultima_prevencao_infantil DATE,
  ADD COLUMN dias_sem_prevencao        INTEGER;
```

### 1.4 (Fase 2) Estender `nao_ligar_pacientes`

```sql
ALTER TABLE nao_ligar_pacientes
  ADD COLUMN tipo       TEXT NOT NULL DEFAULT 'permanente',  -- 'permanente' | 'temporario'
  ADD COLUMN expira_em  DATE,
  ADD COLUMN motivo     TEXT,
  ADD COLUMN criado_por UUID;
```

---

## 2. Coleta / classificação (server.js)

### 2.1 Fonte e resolução

`GET /estimates/list?from&to` (datas YYYY-MM-DD; lote por período). Para cada estimate, cada item de `ProcedureList` com `Executed="X"`:
- Resolver `(nome, expertise)` via `PriceId`→catálogo (`procedures/list`, cacheado). Fallback `SpecialtyId`→`procedures/list_specialties` (cacheado).
- Campos usados: `ExecutedDate`, `Dentist_PersonId`, `ProfessionalName`/`DentistName`, `Patient_PersonId`, `BillType`, `TreatmentId`.

### 2.2 Classificação

1. `nome_norm` = normaliza (tira código `^\d.\- -`, tira acentos, lowercase).
2. Se contém `sub` + `gengiv` → ignora. Se começa com `consulta` → ignora (não dispara sozinha).
3. Procura match em `prevencao_procedimentos` (`incluir=true`). Sem match → "não classificado" (auditoria), não conta.
4. Categoria = a do config; força `infantil` se `expertise='Odontopediatria'` ou profissional Ana Luiza (`ANA_LUIZA_PERSON_ID` em `app_config`).
5. Upsert em `prevencao_eventos` (dedup por `treatment_id` + data + categoria).

### 2.3 Agregação

- `ultima_prevencao_adulto` / `ultima_prevencao_infantil` = max(`ExecutedDate`) por categoria; `ultima_prevencao` = max das duas.
- `dias_sem_prevencao` = dias desde `ultima_prevencao`.
- Incluir as 4 colunas no upsert de `pacientes_abc` (server.js ~3665).

### 2.4 Sync diário vs histórico

- **Histórico:** chunks de `estimates/list` mês a mês (~2023→hoje, ~30 chamadas, 1×). O filtro de data pega execuções do período mesmo de orçamentos antigos (verificado).
- **Diário:** sync das 2h ganha 1–2 chamadas (últimos ~7 dias). Confirmar no build se `from/to` filtra por CreateDate ou LastChange; se CreateDate, usar janela maior/reprocessar por `ExecutedDate`.
- `POST /api/admin/sync-clinicorp` já existe e dispara tudo. Rate limit 25/h cabe folgado.

---

## 3. Frontend — `curva-abc.html` evoluída

Reusa layout/CSS atuais (`pos-tratamento.css`, `nav.js`, KPIs, busca, chips de classe, paginação, "Enviar para Discagem").

### 3.1 Colunas (ordenáveis por clique no cabeçalho)

`Nome · Classe (A/B/C) · Total gasto · Nº visitas · Última prevenção · Dias desde · Status`

- **Status:** 🔴 vencido (>180d) · 🟡 150–180d · 🟢 em dia · ⚪ nunca.
- **Nunca:** badge ⚪ + tooltip cruzando `ultima_visita` ("veio em <data>, sem prevenção" vs "sem visita há +X anos / possível pré-Clinicorp").
- Clica "Total gasto" → visão ABC; clica "Última prevenção" → visão recall.

### 3.2 Filtros

- **Chip de categoria:** Todas · Adulto · Infantil (Dra. Ana Luiza) → troca qual data alimenta Última prevenção/Dias/Status.
- Reusa chips de classe (A/B/C) e faixa de dias.

### 3.3 Preset "Retorno de Prevenção"

Atalho que aplica: ordenar por última prevenção ↑ (menos vencido primeiro) + Status=vencido.

### 3.4 Dados

Lê `pacientes_abc` (anon key já no HTML) com as 4 colunas novas. Sem endpoint novo na Fase 1.

### 3.5 Auditoria

Tela/relatório simples "procedimentos não classificados" (executados sem match na config) pra Luiz revisar e completar a config. Garante que nada é contado errado em silêncio.

---

## 4. Sidebar (fonte única `public/js/nav-config.js`)

Conforme CLAUDE.md, o menu é definido só em `CRM_NAV`. Na seção `{ id:'pos', label:'CRC Pós Tratamento' }`:
- **Remover** o item `recall` (slug `recall`, `/pos-tratamento/recall.html`) e seu `badge-recall`.
- **Adicionar** item da Curva ABC / Retorno de Prevenção apontando para `/pos-tratamento/curva-abc.html` (hoje a curva-abc não está no menu). Label sugerido: "Curva ABC / Prevenção". Badge opcional contando vencidos.
- `data-active` da página = slug do item.

Arquivos `recall.html`/`recall.js` podem ficar no repo sem link (decidir na implementação).

---

## 5. Fase 2 (esboço — não implementar agora)

- **Seleção múltipla** (checkbox + selecionar todos filtrados) → "Enviar para Discagem" reusando `campanhas_discagem` / 3cplus (`lancarCampanhaABC`).
- **"Não ligar"** por linha: "🚫 nunca mais" (permanente) e "este mês" (`expira_em` = fim do mês) em `nao_ligar_pacientes` estendida; suprimidos esmaecem e saem do discador.
- **Log de contato:** `recall_logs` com `tipo='prevencao'`.

---

## 6. Testes / verificação

- **Seed:** revisado pelo Luiz; contaminantes em `excluir` (sub-gengival, manutenção perio, ortodontia, prótese, cálculo salivar, exodontia/pulpotomia, imobilização).
- **Classificação:** amostra de `prevencao_eventos` conferida (nenhum tratamento ativo virou prevenção; nº de maio ≈ 223 proc / 108 pacientes).
- **Agregados:** paciente conhecido — `ultima_prevencao` = último ExecutedDate de profilaxia/flúor/etc.
- **Auditoria:** lista de não-classificados funcional.
- **"Nunca":** paciente antigo sem prevenção → ⚪ com tooltip certo.
- **UI:** ordenação por coluna; troca de categoria recalcula Status; preset; sidebar (recall fora, curva-abc dentro).
- **Rate limit:** histórico (~30 chamadas) + diário (1–2) cabem em 25/h.

## 7. Riscos

- **Resolução de nome (96,6%):** ~3,4% sem match → auditoria. Monitorar e completar config.
- **`ExecutedDate`:** confirmar sempre preenchido em `Executed="X"` (fallback `z_LastChange_Date`).
- **Filtro de data do `estimates/list`:** confirmar CreateDate vs LastChange p/ o incremental (§2.4).
- **`ANA_LUIZA_PERSON_ID`:** obter/configurar em `app_config`.
- **Catálogo muda por convênio:** novos procedimentos caem em auditoria → adicionar à config.
</content>
