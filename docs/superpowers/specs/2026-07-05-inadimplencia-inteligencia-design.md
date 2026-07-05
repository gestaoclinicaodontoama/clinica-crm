# Inadimplência 2.0 — Inteligência de Recuperação

> Spec de design (brainstorm 2026-07-05). Evolui o módulo **Inadimplentes** (aba SPA
> em `index.html`, `page-inadimplentes`) de uma lista de trabalho manual para um
> painel que **prioriza pela exposição real**, **facilita a cobrança** e **mede o
> resultado**. Nada do que existe é removido sem substituição equivalente.

## Objetivo

O pedido do Luiz é a **opção 3 (visibilidade/resultado)** levada até o fim, mais três
inteligências: (a) saúde de pagamentos recorrentes e novas entradas, (b) **em que parcela
as pessoas param de pagar**, e (c) **quanto o paciente já pagou vs. quanto já entregamos**
(produção realizada). No caminho, o brainstorm agregou: relocar a inteligência de carteira
que hoje vive (deslocada) no A Receber/A Pagar, refinar os 3 grupos, o sinal "ainda vem à
clínica", e dois reforços quase gratuitos descobertos ao inspecionar a API — cobrança com
2ª via de boleto e cobrar quem paga (não o paciente).

## Estado atual (o que NÃO muda de fundação)

- **Fonte:** `/payment/list` (24 meses, chunks de 2 meses) em background 1×/dia, cache 23h
  em `inadimplentes_cache`. Botão "Atualizar dados" força refresh.
- **Classificação hoje** (`processarInadimplentes`, `server.js`): por paciente com parcela
  vencida em aberto → **Em Cobrança** (1 vencida, tem futura), **Possível Renegociação**
  (2+ vencidas, tem futura), **Críticos** (sem parcela futura).
- **UI:** cards + tabela por grupo (paciente, total vencido, à vencer, dias de atraso,
  dias p/ próximo, Responsável [Gabi/Bruna/Dr. Marcos], Próximo Passo, OBS, WhatsApp).
- **Notas** em `inadimplentes_notas` (responsavel, proximo_passo, obs). Badge no menu.
- **A Receber/A Pagar** (`financeiro/saude`) já calcula, via `lib/financeiro/analise-parcelas.js`:
  aging (faixas 1–30…180+), taxa de perda (180+), novas×recebidas/mês, carteira retroativa,
  top pagadores. Snapshot diário em `fin_saude_snapshots`.

## Decisões do brainstorm (fechadas)

1. **Relocar** a inteligência de *vencido/perda/recuperação* do A Receber → Inadimplência
   (some de lá). **Espelhar** só *novas×recebidas por mês* (aparece nos dois). Caixa futuro
   e top pagadores **ficam** no A Receber.
2. **Não criar score paralelo.** Evoluir os 3 grupos + colar selos por paciente.
3. Redefinir **Crítico por exposição real**, não por "sem parcela futura".
4. Incluir **"ainda vem à clínica?"** (duas leituras: consulta futura marcada; veio nos últimos 90d).
5. Incluir **WhatsApp com 2ª via de boleto** e **cobrar o pagador** (`PayerPhone`), não o paciente.

## Achados de dados (validados na API em 2026-07-05)

Uma chamada ao `/payment/list` confirmou os campos por parcela:

- **Ponto de desistência viável e explícito:** `InstallmentNumber` (nº da parcela; pode começar
  em 0), `TreatmentId` (agrupa o plano), `MaxInstallmentsCount` (total do plano), `PaymentReceived`/
  `InstallmentPaid` (pago?). Não precisa reconstruir — o campo existe.
- **2ª via no próprio feed:** `BoletoUrl`, `BoletoDigitalLine` (linha digitável), campos de Pix.
- **Forma de pagamento:** `PaymentForm` (Boleto/Cartão/Pix), `Type`.
- **Pagador ≠ paciente:** `PayerName`, `PayerPhone` (ex.: paciente criança, quem paga é a mãe).

Produção realizada (`producao_procedimentos`): tem `amount`, `clinicorp_treatment_id`,
`clinicorp_estimate_id`, **mas não o id do paciente**. Agenda (`agenda_appointments`): guarda
`patient_name` (não id) e o sync só puxa **90 dias passados**.

## Fundação de dados (Fase 0 — encanamento, sem UI)

Três ajustes no `sync/clinicorp-sync.js` + backfills. Baixo risco, invisível ao usuário.

1. **Produção ganha id do paciente.**
   - Sync corrente: gravar `paciente_clinicorp_id = String(est.PatientId || '')` ao montar as
     linhas de `producao_procedimentos` (o estimate já traz o campo).
   - **Backfill do histórico (correção da revisão):** re-rodar o estimates/list **não** recupera
     procedimentos antigos (a API só devolve estimates recentes). Em vez disso, **preencher pelo
     tratamento**: `producao_procedimentos.clinicorp_treatment_id` → `TreatmentId` do `/payment/list`
     (24m) → `PatientId`. Um script de backfill monta o mapa `TreatmentId→PatientId` a partir dos
     itens de pagamento já coletados e faz `UPDATE` das linhas de produção sem id.
   - Migração: `ALTER TABLE producao_procedimentos ADD COLUMN paciente_clinicorp_id text;` + índice.

2. **Agenda ganha id do paciente + janela futura.**
   - Gravar `paciente_clinicorp_id = String(a.Patient_PersonId || a.PatientId || '')`.
   - `syncAgenda`: além dos 90d passados, coletar também **90d futuros** (`/appointment/list`
     numa janela `today → today+90`). Dobra as chamadas da agenda (aceitável).
   - Migração: `ALTER TABLE agenda_appointments ADD COLUMN paciente_clinicorp_id text;` + índice.

3. **Cobrança captura os campos novos por paciente.** Ao processar `/payment/list`, além do que
   já agrega, guardar por paciente (na parcela **mais antiga em aberto**): `PayerName`, `PayerPhone`,
   `BoletoUrl`, `BoletoDigitalLine`, `PaymentForm`; e por tratamento: `InstallmentNumber`,
   `MaxInstallmentsCount` (para a Fase 3). Persistir no `inadimplentes_cache.data` (mesmo pacote)
   ou colunas dedicadas — decidir na implementação (preferir o pacote existente, menos migração).

## Fase 1 — Lista inteligente e fácil de agir (o coração)

Melhora a aba atual sem remover colunas.

- **Grupos refinados.** `processarInadimplentes` passa a considerar exposição e engajamento:
  - **Crítico** = **já entregamos mais do que ele pagou** (`entregue > pago`) **E** parou
    (sem parcela futura **e** sem consulta futura marcada). Quem não começou o tratamento
    (entregue ≈ 0) sai do vermelho.
  - Em Cobrança / Renegociação mantêm o sentido operacional (1 vs 2+ vencidas com futura).
- **Dois selos por linha:**
  - *Pago vs. entregue*: `pago = pacientes_financeiro.total_pago`; `entregue = Σ producao_procedimentos.amount`
    do paciente (via `paciente_clinicorp_id`). Selo vermelho se `entregue > pago` (estamos no
    vermelho com ele), verde se `pago ≥ entregue`. Mostrar os dois valores no hover/coluna.
  - *Vem à clínica?*: verde = tem consulta futura marcada; amarelo = veio nos últimos 90d
    (agenda passada ou `executed_date` recente); cinza = sumiu.
- **Cobrar quem paga.** O botão de WhatsApp usa `PayerPhone` (fallback: telefone do paciente).
  Rótulo mostra o nome do pagador quando difere do paciente.
- **WhatsApp de cobrança com 2ª via.** Mensagem personalizada: nome, valor vencido, qual parcela,
  vencimento e **link do boleto** (`BoletoUrl`). Texto some do genérico atual.

## Fase 2 — Medir o resultado (a opção 3)

- **Relocação.** Aging, taxa de perda e curva da carteira vencida no tempo passam a ser exibidos
  **na Inadimplência**. A `lib/financeiro/analise-parcelas.js` **continua a fonte** (compartilhada);
  muda só **onde é renderizado**. No A Receber, remover esses blocos e manter caixa futuro +
  top pagadores.
- **Painel de recuperação.** Usando `fin_saude_snapshots` (já gravado): entrou em atraso no mês
  R$X, recuperado R$Y, taxa de sucesso, e a curva do vencido ao longo do tempo. Se o snapshot não
  tiver granularidade suficiente, estender o que é gravado (sem novo endpoint).
- **Novas × recebidas por mês** aparece aqui como "das novas entradas, quanto já fura" e permanece
  no A Receber como renovação de caixa (mesmo cálculo).

## Fase 3 — Ponto de desistência (estratégico)

- Coorte por `InstallmentNumber`: agrupar por `TreatmentId`, achar a **última parcela paga** de
  cada plano, e montar a distribuição de "onde as pessoas param" (1ª? 10ª? penúltima?). Normalizar
  pelo total do plano (`MaxInstallmentsCount`) para comparar planos de tamanhos diferentes.
- Cuidados: `InstallmentNumber` pode começar em 0; planos renegociados têm `NewInstallmentNumber`/
  `OriginalDueDate` — tratar renegociação como caso à parte na primeira versão (ignorar ou marcar).

## Fase 4 — Extra opcional

- **Inadimplência por forma de pagamento** (`PaymentForm`: boleto vs. cartão recorrente vs. Pix):
  taxa de furo por forma → vira regra de venda. Só se houver fôlego.

## Riscos e validações

- **Cobertura da produção histórica.** "Entregue" só é fiel se o backfill por `TreatmentId` cobrir
  o histórico relevante. Medir % de linhas de produção que ficaram sem `paciente_clinicorp_id`
  após o backfill; se alto, investigar tratamentos sem match no pagamento.
- **Semântica pago vs. entregue.** `total_pago` é caixa recebido; `amount` da produção é valor
  cheio do procedimento. A comparação mede exposição (entregamos trabalho ainda não pago) — é o
  que se quer, mas deixar explícito na UI para não confundir com "saldo devedor contratual".
- **Renegociação** distorce a curva de desistência — isolar na Fase 3.
- **A Receber ainda não foi validado logado** (STATUS.md). Relocar blocos de lá exige reteste da
  página após a mudança.

## Fora de escopo (YAGNI por ora)

- Régua de cobrança automática (cadência D+1/D+7/…), histórico/timeline de cobrança,
  "próximo passo vira tarefa na Central", ranking da equipe, inadimplência por origem/campanha.
  Ficam como candidatos a fases futuras — não entram nesta entrega.

## Dependência cruzada anotada

O `paciente_clinicorp_id` na produção (Fase 0) também destrava o afazer registrado no STATUS.md:
mostrar **"quanto já foi realizado"** por paciente na aba **Pacientes 2 (beta)**.
