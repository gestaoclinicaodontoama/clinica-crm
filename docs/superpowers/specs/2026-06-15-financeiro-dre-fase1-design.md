# Módulo Financeiro / DRE — Fase 1 (Design)

**Data:** 2026-06-15
**Status:** Aprovado para implementação (pendente revisão final do spec)
**Autor:** Brainstorm Luiz + Claude

## 1. Contexto e objetivo

A clínica controla a DRE hoje **manualmente em Excel**: exporta os lançamentos do Clinicorp,
classifica cada linha por categoria (usando um de-para próprio) e monta a DRE via tabela dinâmica.
Esse processo é trabalhoso, frágil (classificação manual derrapa) e não fica dentro do CRM.

**Objetivo da Fase 1:** automatizar esse ciclo dentro do CRM — sincronizar os lançamentos do
Clinicorp, **categorizá-los automaticamente** e gerar a **DRE gerencial consolidada** (regime de caixa),
substituindo o Excel. Receita e despesa **já existem no Clinicorp**; o CRM é a camada gerencial
(categorização + relatório) que falta.

Projeto maior é multi-fases (ver §11). Este spec cobre **só a Fase 1**.

## 2. Arquitetura (Opção B — CRM como camada gerencial)

```
CLINICORP (fonte)                         CRM (Supabase + Express)
financial/list_summary ──► Sync noturno ──► fin_lancamentos (espelho)
                                                  │
                                   Motor de categorização (3 camadas, nesta ordem)
                                   ── 1. exato de-para (semente histórica)
                                   ── 2. registro de pessoas (dentistas/staff)
                                   ── 3. palavra-chave/token (com limiar de confiança)
                                                  │
                              ┌───────────────────┼────────────────────┐
                         auto-classificado   "A categorizar" (1 clique)  override manual
                                                  │
                                          DRE gerencial (cascata 1→7, caixa)
```

Stack: Node/Express (`server.js`), Supabase (Postgres + RLS), frontend HTML/CSS/JS vanilla,
módulo na sidebar (ver `AGENTS.md`). Sem dependência de digitação dupla — tudo vem do Clinicorp.

## 3. Fonte de dados — semântica do Clinicorp (validada)

Ver memória `reference_clinicorp_financial_api`. Endpoint principal: `GET /financial/list_summary?from&to`
(1 request traz o mês inteiro; rate limit 24/h deixa de ser problema com sync em lote).

- **Despesa:** `PostType === "EXPENSES"` (ou `EntryType === "ACCOUNTS_PAYMENT"`).
  Descrição: `"Pagamento de Conta: <fornecedor> - <AMA|MAR|PF> N/M"`. `AccountId` é a conta
  bancária de saída (não a categoria).
- **Data/mês da DRE (regime de caixa):** ✅ **CONFIRMADO usar `Date`** (não `PostDate`). Experimento em
  Maio/2026: RECEIVED por `Date` = R$252.078 (= `cash_flow.in` R$252.046, dif R$32); por `PostDate` =
  R$242.696 (joga ~22 lançamentos pro mês errado). `mapear` usa `dataLocal(e.Date || e.PostDate)`.
  `PostDate` é data de postagem/conciliação; `Date` é o evento de caixa. Guardar a data bruta em `raw`.
  **⚠️ Fuso horário:** o Clinicorp envia data em **UTC** (`...Z`). Converter para
  **`America/Sao_Paulo` antes de extrair o mês/dia** — senão um Pix recebido 31/03 22h (Brasília)
  cai em Abril. **Forte candidato à origem do R$30,57** (divergência de borda de mês por fuso).
- **Estornos/devoluções:** aparecem como lançamento de saída (descrição "Estorno...") → categoria
  `5.5 Devolução de recebimento` (resolvido pelo motor de categorização como qualquer despesa).
- **Sinal da fonte:** assumir `Amount` positivo (confirmado nos dados). Se a API trouxer `Amount`
  negativo (raro), normalizar para `valor` positivo invertendo o `fluxo` (entra↔sai) na ingestão.
- **Receita (regime de caixa):** `PostType === "RECEIVED"` (= `cash_flow.in`, validado no centavo).
  **Não** usar `REVENUE` (competência/faturamento) na DRE de caixa — fica guardado para Fase 2.
  - **Convênio:** `EntryType === "INSURANCE_PLAN_CLAIM"` / descrição "Reconciliação Plano"
    (bate com `health_insurance` do cash_flow).
  - **Particular:** o restante, por forma de pgto via descrição: dinheiro ("Pagamento de Tratamento"),
    cartão ("Reconciliação c/ Cartão"), boleto ("Reconciliação c/ Boletos"), pix ("Confirmação Pix").
  - **Juros de paciente** (`INTEREST_RECEIVED`, boleto pago após vencimento) = receita legítima,
    já dentro de `RECEIVED`. Tratado **dentro de Particular** (decisão do Luiz).
  - **Subsplit Particular → Entrada vs Parcelas** (categorias atuais da planilha, em
    `P:\LUIZ\AMA -ADMIN\2026\2026.xlsx`): **não há coluna que separe** — é regra **stateful** do Luiz:
    *primeiro pagamento do paciente = Entrada* (incl. quando a entrada é parcelada no cartão: todas as
    baixas dessa entrada = Entrada); *demais = Parcelas*. Exige histórico **completo** por paciente
    (agrupar por `RelatedPersonId`/paciente, ordenar por data; tratar o caso da entrada-parcelada-no-cartão).
    **Incluído na Fase 1, mas o split só é ativado após o backfill 2024-2025** (senão pacientes antigos
    teriam o 1º pagamento de 2026 marcado erroneamente como Entrada). Até lá, Particular fica unificado.

**Validação feita:** Março/2026 reproduzido da API bate com a planilha — Convênio exato (R$72.985,41),
resultado final R$117.271 vs R$117.302 (dif R$30,57 = ruído manual do Excel, não do método).

## 4. Modelo de dados (Supabase)

- **`fin_contas`** — plano de contas canônico (árvore). Campos: `id`, `codigo` (ex.: "3.1.7"),
  `nome`, `grupo` (ex.: "3.1 - CUSTOS MATERIAL"), `tipo` (receita/imposto/custo/despesa/financeiro/investimento),
  `ordem`, `ativo`. Semeado com as 30 categorias do Excel (§5).
- **`fin_lancamentos`** — espelho dos lançamentos do Clinicorp. Campos: `id`, `clinicorp_id` (único,
  idempotência), `data` (date no fuso America/Sao_Paulo, ver §3), `descricao`,
  `valor` (**`numeric(14,2)`, sempre positivo**; nunca float — evita lixo/erro de centavo da API;
  o sinal na DRE vem do grupo da conta — receita soma, despesa subtrai),
  `fluxo` (entra/sai — derivado de PostType; **renomeado** de "tipo" para não confundir com
  `fin_contas.tipo`), `post_type`, `entry_type`,
  `forma_pgto` (dinheiro/cartao/boleto/pix/convenio/—), `empresa` (AMA/MAR/PF/—, do sufixo),
  `paciente_id` (RelatedPersonId, para o subsplit Entrada/Parcelas), `receita_sub` (entrada/parcelas/—),
  `conta_id` (FK fin_contas, nullable até categorizar),
  `classificacao_metodo` (exato/regra/pessoa/manual — como foi classificado),
  `override_manual` (bool — true quando o usuário fixou a categoria nesta linha; sync não sobrescreve),
  `ativo` (bool — vira false na reconciliação se sumiu do Clinicorp, ver §9),
  `visto_em` (timestamp do último sync que confirmou o lançamento), `raw` (jsonb do original).
- **`fin_regras`** — regras de categorização. Campos: `id`, `metodo` (exato/keyword/pessoa — evita o
  3º "tipo"), `padrao` (texto/descrição-núcleo/nome), `conta_id` (FK), `prioridade`, `origem`
  (semente/manual), `criado_por`, `hits` (contador). Semeado com o de-para histórico (§6). Criar/editar
  uma regra **dispara reclassificação retroativa** dos lançamentos compatíveis sem `override_manual` (ver §6).
- **`fin_pessoas`** — registro de pessoas para nomes próprios. Campos: `id`, `nome`, `papel`
  (dentista_socio/dentista_cnpj/funcionario/tecnico/...), `conta_id` (FK default), `empresa`, `ativo`.
- **`fin_sync_log`** — auditoria de sync: `id`, `periodo`, `qtd_lancamentos`, `novos`, `quando`, `status`, `erro`.

Idempotência: upsert por `clinicorp_id`. Re-sync de um mês nunca duplica.

## 5. Plano de contas canônico (semente)

Extraído de `descricao e cat certa.xlsm` (de-para). **Fonte autoritativa/atual: `P:\LUIZ\AMA -ADMIN`**
(servidor). 30 categorias, cascata da DRE:

```
1 - RECEITA              Convênio · Particular (→ Entrada · Parcelas, ativado pós-backfill)
2 - IMPOSTOS             2.1 SIMPLES · 2.2 Cofins · 2.3 CSLL · 2.4 IRPJ · 2.6 PIS · 2.7 ISS · 2.8 Carnê Leão
3.0 - TARIFAS            3.0.1 Tarifa cartão de crédito
3.1 - CUSTOS MATERIAL    3.1.2 Lab. Prótese · 3.1.3 Dentais · 3.1.4 Farmácias · 3.1.5 Gases · 3.1.6 Implantes · 3.1.7 Invisalign
3.2 - MÃO DE OBRA DENT.   3.2.1 Dentistas Sócios · 3.2.2 Dentistas CNPJ
3.3 - CUSTOS INDIRETOS   3.3.1 Técnicos · 3.3.2 Transporte
4 - DESPESAS FIXAS       4.1.1 RH · 4.1.2 Administrativo · 4.1.3 Comercial · 4.1.4 Marketing · 4.1.5 Conservação · 4.1.6 Cursos
5 - FINANCEIRAS          5.1 Empréstimos (Juros) · 5.5 Devolução de recebimento
7 - INVESTIMENTOS        7.3 Reforma · 7.5 Investimentos
```

O plano é editável no CRM (adicionar/renomear/reordenar categorias).

## 6. Motor de categorização (3 camadas + inbox + override)

Cada lançamento de despesa passa pelas camadas **nesta ordem** (do mais específico ao mais genérico);
a primeira que resolver vence:

1. **Descrição exata (de-para):** normaliza a descrição (tira prefixo "Pagamento de Conta:",
   sufixo de empresa "- AMA/MAR/PF", parcela "N/M", acentos) e busca match exato nas `fin_regras`
   `metodo = exato`. Semeado com o de-para histórico (~2.100 descrições). Cobre ~60%.
2. **Registro de pessoas:** descrições com nome próprio (ex.: "Pagamento Fernanda", "Pró labore X")
   resolvidas pelo cadastro `fin_pessoas` — match do **nome normalizado** (sem acento/caixa) como
   palavra inteira dentro da descrição já limpa → papel → conta default. **Vem antes da palavra-chave**
   porque nome próprio é mais específico que token genérico — sem isso, "Pagamento Amanda" cairia numa
   regra keyword errada (foi o que errou a linha 3.2 Dentistas na validação).
3. **Palavra-chave/token (com limiar de confiança):** regras `metodo = keyword` (ex.: contém
   "Invisalign" → 3.1.7; "Neodent" → 3.1.6; "Salário/Férias/FGTS" → 4.1.1; impostos por nome).
   Derivadas do de-para (tokens distintos votam categoria) e editáveis. **Só auto-aplica acima de um
   limiar de confiança** (ex.: vencedor com ≥N votos e margem clara sobre o 2º lugar); **abaixo do
   limiar → vai pra "A categorizar"** em vez de chutar. Uma auto-categorização errada corrompe a DRE
   silenciosamente — é pior que cair na fila. Cobre +~36% com o limiar calibrado.

**Não resolvido →** fica em `conta_id = null`, aparece na caixa **"A categorizar"**. Ao classificar,
o usuário escolhe **o alcance**:
- **"Só esta"** → marca `override_manual = true` apenas neste lançamento (exceção pontual; não cria regra).
- **"Todas iguais"** → cria/atualiza uma `fin_regras` e **reclassifica retroativamente** todos os
  lançamentos compatíveis (passados e futuros) que **não** tenham `override_manual = true`.

**Reclassificação retroativa:** criar/editar regra ou cadastrar pessoa roda **na hora** sobre o
histórico (não espera o próximo sync). Lançamentos com `override_manual = true` são preservados.

**Override:** toda linha — inclusive auto-classificada — tem botão de **trocar a categoria**, com a
mesma escolha "só esta" vs "todas iguais". Padroniza o "administrativo vs pessoal".

**Receita:** classificada por forma de pgto (§3) automaticamente; Convênio vs Particular direto do
`EntryType`/descrição. Sem inbox (determinística).

## 7. Empresas (AMA/MAR/PF)

A `empresa` é extraída do sufixo da descrição e **gravada** em cada lançamento já na Fase 1
(custo marginal zero — sai do mesmo parsing). Porém os **relatórios por empresa** ficam para a
Fase 2 (a receita não traz empresa separada na API e precisa de tratamento extra). Fase 1 entrega a
**DRE consolidada**; o dado de empresa fica armazenado para uso posterior.

## 8. Telas (frontend)

Módulo independente na sidebar (`/financeiro/`), role `mod_financeiro` (+ admin).

> **Registro obrigatório do módulo (ver `AGENTS.md`):** ao criar, registrar o role em 5 lugares —
> Perfil Base / Módulos Extras / `_ROLE_LABELS` / middleware `server.js` (`requireRole`) / `data-roles`
> no nav — e incluir `shared-nav.js` (entrada + `data-active`) nas páginas separadas. Auth em páginas
> separadas usa `public/js/financeiro/api.js` com o token `sb-{ref}-auth-token`.

Páginas:

1. **DRE** — cascata montada por `fin_contas.grupo`/`codigo` + `ordem` (não por `tipo`), com receita
   (Particular dividido por `receita_sub` quando ativo), grupos de despesa e resultado; seletor de
   período (mês/intervalo); drill-down (clicar numa categoria lista os lançamentos, só `ativo = true`).
   Botão "Atualizar dados" (sync manual, padrão do projeto). Exportar (CSV/Excel).
2. **A categorizar** — fila de lançamentos sem categoria; classificação em 1 clique com sugestão;
   ação memoriza (cria regra/pessoa).
3. **Lançamentos** — lista filtrável (período, empresa, categoria, fluxo entra/sai) com override por
   linha (com a escolha "só esta" vs "todas iguais" do §6). Inclui filtro "inativos" (reconciliados).
4. **Cadastros** — plano de contas, regras de categorização, pessoas.

## 9. Sync

- Estende o padrão de sync Clinicorp já existente (`sync/clinicorp-api.js`, rate limiter).
- **Agendado** (diário) — pelo mesmo mecanismo de agendamento já usado pelos outros syncs do CRM
  (reusar; não introduzir scheduler novo) — **+ manual** (botão "Atualizar dados", padrão do projeto).
  Puxa `list_summary` do período (mês corrente + retroativo configurável). Upsert idempotente por
  `clinicorp_id`; marca `visto_em = now` nos confirmados. Reclassifica lançamentos `conta_id = null`.
- **Reconciliação de apagados/estornados:** para cada período re-sincronizado, os lançamentos do CRM
  daquele período **não** confirmados neste sync (sem `visto_em` atualizado) viram `ativo = false`
  (soft-delete) e saem da DRE. Evita "fantasma" quando um pagamento é apagado/editado no Clinicorp.
  Sync nunca sobrescreve linhas com `override_manual = true` (preserva a categoria, mas atualiza valor/ativo).
- **Backfill em ordem: 2026 → 2025 → 2024.** Valida cada ano contra os Excels existentes (2024 não tem
  DRE manual — foi o ano da migração pro Clinicorp; conferir se foi lançado certinho no Clinicorp).
- **Após o backfill completo**, ativar o subsplit Particular Entrada/Parcelas (recalcula `receita_sub`
  com base no histórico completo por paciente). Antes disso, Particular fica unificado.

## 10. Erros, segurança, testes

- **Erros:** sync registra falha em `fin_sync_log` sem derrubar; UI mostra "última sincronização".
  Lançamento sem match nunca quebra — cai em "A categorizar".
- **Segurança:** RLS por role; credenciais Clinicorp no servidor (nunca no front). Dados financeiros
  **não** versionados no git (já validado: temporários removidos).
- **⚠️ Supabase:** nunca `.catch()` direto no builder (ver `reference_supabase_catch_builder`); usar try/catch no await.
- **Testes/validação — critério de aceite (por linha, não só % classificado):**
  reproduzir um mês fechado (ex.: Março/2026) e conferir contra o Excel, exigindo:
  1. **Receita de caixa = `cash_flow.in`** no centavo; Convênio exato.
  2. **Cada linha da cascata** (1, 2, 3.0, 3.1, 3.2, 3.3, 4, 5, 7) dentro da tolerância vs o Excel,
     **após** semente + cadastro de pessoas — porque "% classificado alto" pode esconder erro de
     categoria (na validação, 96,6% classificado ainda errou a linha 3.2 Dentistas sem o cadastro).
  3. **Resultado final** dentro de ~R$30 (ruído manual do Excel).
  Repetir o aceite a cada ano do backfill (2026, 2025, 2024).
- **Checkpoint multi-empresa (risco):** confirmar no 1º backfill que a chamada única
  (`business_id=clinicaama`) captura a **receita das 3 entidades** (AMA+MAR+PF) e não só a AMA —
  conferindo o total contra o Excel consolidado. Se faltar receita de MAR/PF, avaliar chamada por
  `business_id` adicional. (Março bateu consolidado, indício de que captura tudo — mas validar explícito.)

## 11. Fora de escopo (próximas fases)

- **Fase 2:** contas financeiras (6+ contas/cartões), import OFX + conciliação bancária, fluxo de caixa
  (realizado + previsto via `REVENUE`/forecast), DRE/despesa **por empresa** (AMA/MAR/PF).
- **Fase 3:** migração da fonte bancária para **Pluggy** (Open Finance automático), centro de custo
  por dentista, orçado × realizado, previsões. Import bancário desenhado plugável desde já (OFX → Pluggy).

## 12. Decisões tomadas / questões em aberto

**Decididas:**
- Juros recebidos de paciente: **dentro de Particular**.
- Backfill: **2026 → 2025 → 2024** (2024 sem DRE manual, só validar lançamento no Clinicorp).
- Subsplit Particular Entrada/Parcelas: **na Fase 1, ativado só após o backfill completo**.

**Em aberto:**
- Caso da **entrada parcelada no cartão** (N baixas que são todas Entrada): confirmar se dá pra detectar
  100% via Clinicorp (linkar baixas à transação/tratamento original) ou se exige ajuste manual pontual.
- Papel exato de cada pessoa no `fin_pessoas` — preencher no onboarding do módulo.
