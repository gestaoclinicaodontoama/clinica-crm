# Financeiro de Grupo — Caixa Real (Open Banking) + Conciliação + Torre Tributária

**Data do brainstorm:** 12/07/2026 · **Spec salva:** 16/07/2026
**Status:** design apresentado ao Luiz; projeto **EM ESPERA** por decisão dele ("não sei se já vou fazer isso agora"). Nada implementado.
**Pré-requisito externo:** Luiz reconectar o acesso no Meu Pluggy (1ª tentativa dele falhou dias antes de 12/07). A Fase 4 NÃO depende disso.

## 1. Contexto e decisão de plataforma

- Participar do Open Finance Brasil **direto é inviável** (exige instituição autorizada pelo Banco Central, diretório de participantes, certificados ICP-Brasil, FAPI, certificação de conformidade). Caminho escolhido: **Meu Pluggy (gratuito)** — portal da Pluggy para contas próprias → Development Application no dashboard.pluggy.ai → API com `client_id`/`client_secret`, refresh diário. O repo github.com/pluggyai/meu-pluggy é só documentação (inspecionado em 12/07: README + screenshots, sem código).
- **Bancos (5 contas):** Sicoob ×2 (2 CNPJs), Unicred (PF), Caixa (PJ), Inter (PJ, em encerramento — **conectar ANTES de fechar**; o Meu Pluggy preserva o histórico de conta encerrada). Todos os 4 bancos confirmados na cobertura Open Finance da Pluggy (contextos Pessoal e Empresarial).
- Alternativas pagas se a porta gratuita falhar: Tecnospeed PlugBank (~R$1,5k entrada + R$540/mês), contrato Pluggy (~R$2,5k/mês piso), Belvo (~R$6k/mês). Referências de jul/2026.
- Limitações aceitas: transações com até 24h de atraso; consentimento expira em ~12 meses (alerta no monitor de syncs); 1 autorização OAuth por banco; consentimento PJ exige administrador no internet banking.

## 2. As 3 entidades do grupo (contexto fiscal — ver memória `grupo-estrutura-fiscal`)

| Entidade | Regime | Alíquota aprox. | Papel |
|---|---|---|---|
| Vieira e Vidigal Martins LTDA (VVM) | Simples Nacional | ~12–13% (gatilho: >R$150k/mês piora via fator R) | Faturamento mínimo p/ pagar contas |
| Clínica Odontológica Martins | Lucro Presumido, CNAE radiologia | ~8,9% c/ ISS Ipatinga | Presta radiologia ao PF; "teto" mental ~R$250k/mês |
| Marcos Vinicius (PF) | Carnê-Leão + livro-caixa | 27,5% marginal sobre o LUCRO (pequeno) | Recebe o grosso dos pacientes; deduz radiologia (Martins) + NFs de outros dentistas + despesas reais |

Exemplo do Luiz (500k/grupo): VVM 150k (~19,5k), Martins 180k×8,9% (~16k), PF 350k−340k dedutíveis=10k×27,5% (~2,8k) → **efetiva ~7,7%**.

**Refinamento acordado (Luiz concordou):** o ótimo NÃO é "máximo no PF" — é *"PF até onde a dedução REAL acompanha; excedente vai para a VVM"*. Guardas: (a) preço da radiologia precisa de lastro arm's length (no exemplo, 51% da receita PF é a variável frágil — risco de glosa retroativa + multa 75%); (b) margem PF ~3% é perfil de malha — termômetro de risco visível; (c) confirmar com contador se subcontratação de dentistas (que emitem NF ao PF, dedutível) não caracteriza equiparação a PJ.

## 3. Escopo (prioridade do Luiz) e faseamento

Prioridade declarada: caixa real → conciliação → fluxo ancorado → DRE completa → alertas. Incluídos também: calendário intra-mês, visão por CNPJ c/ transferências internas, score 0–100, consultor IA nº1. **FORA:** auditoria de distribuição de lucro aos sócios ("somos pequenos").

- **F0** — Luiz reconecta Meu Pluggy; validar API com 1 conta piloto (Sicoob).
- **F1 — Caixa vivo:** saldos+extratos das 5 contas; card "💰 Caixa do grupo" no Painel do Gestor (consolidado + chips VVM/Martins/PF, semáforo vs piso); página `/financeiro/caixa/`; transferências internas marcadas (não contar dobrado).
- **F2 — Conciliação:** casamento Clinicorp (RECEIVED) × banco. 3 grupos de divergência: "Clinicorp diz que recebeu e não caiu" / "caiu e ninguém lançou" / "diferença de taxa" (taxas de maquininha/antecipação MEDIDAS, por bandeira). Despesas só-do-extrato → fluxo "A categorizar" da DRE existente.
- **F3 — Previsão:** fluxo de caixa ancorado no saldo real ("caixa encosta no mínimo dia X"); calendário/mapa de calor intra-mês (entradas vs vencimentos); alertas no sino (débito não reconhecido, tarifa nova, saldo< piso, recorrência que subiu de preço).
- **F4 — Torre tributária + Calculadora do ponto ótimo** ⚡ pode começar SEM Pluggy (Clinicorp + NFS-e + inputs manuais; extrato refina depois — ex.: detectar DAS/DARF/ISS pagos → alíquota efetiva medida).
- **F5 — Inteligência:** score de saúde financeira 0–100 mensal; **Consultor IA nº 1 — Saúde Financeira** (fila dos 7 consultores; padrão fatos+IA+pergunta livre da DRE).

## 4. Dados e sync

Tabelas novas (Supabase, RLS ligada, acesso só server/service_role):
- `banco_contas` — conta ↔ banco ↔ **entidade** ↔ itemId Pluggy. ⚠️ ABERTO: mapeamento conta→entidade (Sicoob 1=VVM? Sicoob 2=Martins? Caixa=qual CNPJ? Inter=qual?) — Luiz confirma ao conectar.
- `banco_saldos` — snapshot diário por conta.
- `banco_transacoes` — id Pluggy (dedup), data, valor, descrição, categoria, entidade, flag `interna` (transferência entre contas do grupo), vínculo de conciliação.
- `fiscal_config` — entidades, regimes, tabelas de alíquota, tetos, preço-referência da radiologia. **Editável por Luiz/contador, nunca hardcoded.**
- `fiscal_meses` — faturamento/deduções por entidade/mês (auto do Clinicorp/NFS-e onde der + edição manual).
- Tabela de conciliação (pares casados + divergências com status).

Sync: fase nova no job das 02h, isolada (falha não derruba as outras), registrada no monitor Saúde dos Syncs + **alerta de consentimento vencendo** (~12 meses). Botão "Atualizar dados" manual nas páginas (regra da casa). Credenciais Pluggy só no env do Easypanel. Cards mostram frescor ("dados de ontem à noite"). Egress: deltas incrementais, somas no SQL (limite 1000 linhas do Supabase).

## 5. Telas

- **Painel do Gestor:** card Caixa do grupo (consolidado grande + 3 chips por entidade + semáforo vs piso mínimo configurável).
- **`/financeiro/caixa/`:** extrato unificado, filtro entidade/conta, internas acinzentadas, busca; aba Conciliação (F2) com os 3 grupos de divergência.
- **`/financeiro/tributos/` (F4):** termômetros do mês por entidade — VVM: gatilho R$150k + fator R ≥28%; Martins: teto R$250k; PF: razão dedução÷receita com faixa verde/amarela/vermelha — + **calculadora**: input "quanto ainda vamos faturar este mês" → alocação ótima + imposto total do grupo por cenário, respeitando restrições; se o ótimo exigir esticar radiologia além do preço-referência, manda excedente p/ VVM e explica. "▸ entenda" em tudo; sem siglas financeiras (regra do Luiz); disclaimer permanente "orienta; contador valida" + checklist de 3 perguntas p/ o contador (equiparação PJ; preço radiologia defensável; tabelas 2026).
- Erro de servidor = banner vermelho "tentar de novo", nunca "sem dado". Retry 5xx padrão. Acesso: só gestor/admin.

## 6. Calculadora por dentro (coração da F4)

Imposto **marginal do próximo R$1** por canal, recalculado com o acumulado real do mês:
1. PF-com-dedução disponível → efetivo ~8,9% (via Martins; lucro distribuível isento no presumido);
2. VVM → ~12–13% (degraus do Simples; fator R monitorado);
3. PF-sem-dedução → 27,5% (pior canal).

Restrições: VVM ≥ contas fixas E fator R ≥ 28%; Martins ≤ teto; dedução radiologia ≤ preço-referência × volume real de exames; tabela Carnê-Leão mensal progressiva (timing entre meses importa). Parâmetros todos em `fiscal_config`.

## 7. Qualidade

Motores em `lib/financeiro/` (ex.: `banco/`, `conciliar.js`, `torre-fiscal.js`) com testes unitários (TDD, padrão da casa); smoke com dados reais; validação logado pelo Luiz por fase.

## 8. Pendências ao retomar

1. Luiz reconectar Meu Pluggy e conectar os 5 bancos (Inter ANTES de encerrar!). Piloto: Sicoob.
2. Confirmar mapeamento conta→entidade.
3. Decidir se começa pela F4-lite (sem Pluggy) ou espera F0.
4. Aprovação formal do design (apresentado 12/07, reação positiva, sem "aprovo" explícito) → depois `writing-plans`.
5. Levar as 3 perguntas ao contador antes da calculadora orientar decisão.
