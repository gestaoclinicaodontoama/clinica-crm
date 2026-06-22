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

### 1.3 Agregados — `prevencao_status` (NÃO em `pacientes_abc`)

⚠️ **Verificado:** de 108 pacientes de prevenção de maio, só 95 estão em `pacientes_abc` e 99 em `pacientes` — pacientes convênio-only (sem receita particular) não entram no ABC. Então os agregados **não podem viver na `pacientes_abc`**, senão a lista perde ~12% do público de prevenção. Ficam numa tabela própria por `clinicorp_id`, cobrindo TODO mundo que fez prevenção:

```sql
CREATE TABLE prevencao_status (
  clinicorp_id              BIGINT PRIMARY KEY,   -- Patient_PersonId
  nome                      TEXT,                 -- fallback do estimates (PatientName)
  telefone                  TEXT,
  ultima_prevencao          DATE,                 -- max(adulto, infantil)
  ultima_prevencao_adulto   DATE,
  ultima_prevencao_infantil DATE,
  qtd_prevencoes            INTEGER DEFAULT 0,
  dias_sem_prevencao        INTEGER,
  atualizado_em             TIMESTAMPTZ DEFAULT NOW()
);
```

A página junta `prevencao_status` (última prevenção) com `pacientes` (cadastro) e `pacientes_abc` (classe/gasto/visitas, via LEFT JOIN — nulo para convênio-only). Ver §3.4.

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

- Por paciente: `ultima_prevencao_adulto` / `_infantil` = max(`ExecutedDate`) por categoria; `ultima_prevencao` = max das duas; `qtd_prevencoes` = nº de datas distintas; `dias_sem_prevencao` = dias desde `ultima_prevencao`.
- **Upsert em `prevencao_status`** (não em `pacientes_abc`), com `nome`/`telefone` vindos do estimate (cobre quem não está em `pacientes`).
- **Fechar o gap de cadastro:** pacientes presentes nos estimates mas ausentes de `pacientes` → upsert mínimo em `pacientes` (clinicorp_id, nome, telefone) pra aparecerem na lista e poderem ser ligados.

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

Universo da lista = **todos os pacientes que fizeram prevenção** (`prevencao_status`) **+** pacientes ABC sem prevenção (para os "Nunca"). Join: `pacientes` (cadastro) ⟕ `prevencao_status` (última prevenção) ⟕ `pacientes_abc` (classe/gasto/visitas — nulo p/ convênio-only, mostrado como "sem classe"). Provavelmente uma **VIEW** ou endpoint que faz esse join server-side (mais robusto que 3 queries no cliente). Sem dado novo de procedimento na Fase 1 além do que o sync grava.

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
- **Filtro de data do `estimates/list`:** confirmar CreateDate vs LastChange p/ o incremental (§2.4). Único ponto técnico ainda não verificado.
- **`ANA_LUIZA_PERSON_ID`:** obter/configurar em `app_config`.
- **Catálogo muda por convênio:** novos procedimentos caem em auditoria → adicionar à config.
- **Volume / UX:** a base de prevenção é baixa por mês (~100 pacientes) → a maioria dos pacientes vai estar "vencido" ou "nunca". A lista será grande; a priorização (ordenar por menos vencido + classe/gasto) e a paginação são essenciais pra não virar uma lista inútil de milhares.

### Verificado ao vivo (não são mais riscos)
- ✅ `ExecutedDate` preenchida em 100% dos `Executed="X"` (maio e 2024-05).
- ✅ Cobertura histórica: `estimates/list` retorna execuções de 2024 normalmente.
- ✅ `Patient_PersonId` (estimates) = `clinicorp_id` (bate em `pacientes`).
- ✅ Gap convênio-only tratado: agregados em `prevencao_status` + upsert de cadastro faltante (§1.3/§2.3).
</content>
