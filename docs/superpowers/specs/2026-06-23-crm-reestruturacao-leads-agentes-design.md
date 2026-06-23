# Reestruturação do CRM — Lead/Funil, Ficha Única e Camada de Inteligência

- **Data:** 2026-06-23
- **Status:** Design aprovado (brainstorm) — aguardando plano de implementação
- **Autor:** Luiz + Claude
- **Mockups:** `docs/superpowers/specs/2026-06-23-crm-assets/`

---

## 1. Contexto e problema

Avaliação crítica do estado atual (lida do código real, não de memória):

1. **Lead importado não abre perfil.** O módulo `public/pacientes/` (onde vivem os ~13.800 leads importados até maio/2025) tem linhas **sem nenhum handler de clique** — só `switchTab`. Clicar não faz nada. Já a lista principal (`page-leads`) abre `abrirModal()`. São duas listas com comportamentos opostos.
2. **Estado do lead fragmentado em 3 taxonomias que não batem:**
   - Canônica (`server.js:69`): 19 estágios.
   - Funil visual (`index.html`): 6 baldes que **silenciosamente descartam** ~7 estágios.
   - Dados legados: caixa-baixa (`lead`, `agendado`...) e valores fora da lista canônica (`Avaliação`).
   - `Nutrir` e `Em nutrição` coexistiam — descobriu-se que são **dois momentos opostos** (ver Bloco 1).
3. **Painel de WhatsApp "cego":** o cabeçalho do chat (`abrirChat`) só mostra o badge de status. Sem score, DISC, valor, orçamento, marcos.
4. **Duas fichas paralelas** que não compartilham estado (o modal de 7 abas vs o chat).
5. **Dívida estrutural:** `index.html` 341 KB / `server.js` 337 KB, monólitos, com múltiplas worktrees na `main`.
6. **Qualidade de dado que sabota análise:** `lead_id` NULL em orçamentos/avaliações; `leads.valor` (R$12,9M) não reconcilia com orçamentos (~R$2,5M). `lead_eventos` é a fonte real do funil hoje.

**Objetivo:** reorganizar o CRM num modelo profissional e escalável (referência: HubSpot, Pipedrive, Kommo) **adaptado à clínica odontológica**, que (a) resolva os dois incômodos visíveis e (b) sirva de fundação confiável para agentes de IA que agem e analisam por estado do lead.

**Não-objetivo:** reescrever o sistema do zero; copiar CRM genérico; migrar para framework novo.

---

## 2. Bloco 1 — Fundação: modelo de dados e funil

### 2.1 Objeto central (Opção C)
- **Pessoa** = registro permanente (dados, histórico, consentimento LGPD).
- **Oportunidade** = uma por interesse/tratamento, com seu próprio funil (resolve "voltou para outro tratamento").
- **Conversa de WhatsApp** = ligada ao *número*, que pode ter **vários membros da família** (telefones com 0 à esquerda = estratégia intencional de família — **nunca** mesclar).
- **+ ganchos de clínica** (retorno preventivo, pós-tratamento).

### 2.2 Funil único
Um funil só. Tratamento é **atributo** da oportunidade, não um funil separado.

**Estágios ativos (= colunas do Kanban, evolução esquerda→direita):**
`Novo → Em qualificação → Avaliação agendada → Compareceu → Em negociação`

**Saídas / fora do trabalho diário (abas, não colunas):**
`Fechou ✅` · `Perdido ❌` · `Reativação` (os "frios")

### 2.3 Atributos paralelos (selo no card + filtro — nunca viram coluna)
- **Tratamento:** Invisalign / Implante / Protocolo / Ortodontia / Clínico
- **Carteira:** `Comercial` (entra no funil/metas) vs `Dra. Izabela` (fora dos números, badge na conversa, agentes não tocam). Modela "pacientes dela que só agendamos". Escalável para outros parceiros/convênios fora do funil.
- **Motivo de perda:** preenchido só ao ir para `Perdido` (insumo grátis do Agente de Inteligência v1).
- **Dono/responsável** (CRC).
- **Cadência:** "dias na etapa / próximo toque" — **substitui o D0–D5** (que era contador de dias, não estágio).

### 2.4 Estado "frio / nutrição" — transversal e automático
Decisão-chave (refinada a partir da objeção do Kanban): **nutrição não é um lugar/coluna; é um estado que gruda no lead, e o lead NÃO sai do estágio de origem.**

- Esfria **sozinho por inatividade**: o card fica vermelho/❄️ e, após X dias sem resposta, sai do board para a aba **Reativação**. Botão "→ nutrição" é exceção manual.
- O **tipo é deduzido automaticamente** dos marcos (sem marcação manual):
  - ❄️ **Nunca agendou** (sem `data_agendamento`) → playbook reaquecer para agendar.
  - 💸 **Orçou e não fechou** (tem `data_orcamento`, sem `data_fechamento`) → playbook conteúdo/reconquista.
- Na aba **Reativação** os dois aparecem **agrupados por tipo**. Se a pessoa responde, **volta ao Kanban no estágio de origem**.
- Régua fina de reativação = **Fase 2**, encaixando no módulo **Retorno de Prevenção** existente.

### 2.5 Regra de ouro do Kanban
**Coluna = estágio (você arrasta). Todo o resto (tratamento, tipo de nutrição, motivo de perda, carteira) = selo no card + filtro.** Board enxuto, só estágios ativos.

### 2.6 O que isso conserta
Funil que conta certo (Dra. Izabela fora; fim das 3 taxonomias e do caixa-baixa); Kanban limpo; e a fundação de dados confiável para os agentes.

---

## 3. Bloco 2 — Ficha única (dois níveis)

A mesma pessoa, a mesma fonte de dados, dois níveis de profundidade. Mata "WhatsApp cego" e "lead importado não abre nada" de uma vez — **toda pessoa passa a ser clicável e abre aqui** (lead novo ou paciente importado).

### 3.1 Contexto lateral (layout de 3 painéis — padrão HubSpot/Intercom/Kommo)
`Lista de conversas | Conversa de WhatsApp | Painel de contexto`
- **Lista:** última mensagem + **selo de estágio** (triagem sem abrir).
- **Centro:** a conversa, com atalhos (ligar, sugestão de resposta da IA).
- **Direita (fim do "cego"):** quem é + carteira, **seletor de família** no mesmo número, **Oportunidades** (estágio + cadência + valor), **Sinais** (score, DISC, origem), **Marcos** com data, **Próxima ação**, e alerta `🔁 Retorno preventivo vencido` quando relevante.

### 3.2 Página da Pessoa — Perfil 360º (abre no clique do nome)
Evolução do perfil do appcrc, **unindo marketing/comercial (CRM) + clínico/financeiro (Clinicorp)** numa tela só. (Lembrete: appcrc **não é o teto** — se o Clinicorp expõe o dado, puxamos.)

- **Raio-x do topo:** valor total, nº de oportunidades, **paciente desde**, **última vez que veio**, **último contato**, **próximo retorno**, **inadimplência**, selos (Cliente / Comercial / família).
- **Linha do tempo unificada (coração):** uma fita só com 🟦 lead/anúncio, 💬 conversa, 📅 agendou, 🟣 compareceu, 📄 orçou, 🦷 procedimento realizado, 💰 pagamento — cada evento marcando a fonte (CRM/Clinicorp).
- **Cards (à direita):** Oportunidades, Agendamentos, Financeiro, Ligações, Etiquetas, Anotações, Anexos/LGPD.

**Hierarquia de exibição da 360º:**
- 🟢 Essencial de cara: raio-x, linha do tempo unificada, oportunidades **abertas**.
- ⚪ Colapsado (clique): agendamentos antigos, financeiro detalhado, ligações, etiquetas, anotações, anexos/LGPD, oportunidades já fechadas.

---

## 4. Bloco 3 — Camada de Inteligência & Automação

### 4.1 Autonomia dos agentes de ação — Regra C (híbrido)
- 🤖 **Auto-envia** o seguro e padronizado: **templates UTILITY aprovados** (retorno preventivo, follow-up, reativação ❄️/💸).
- 🧑 **Sugere rascunho** quando é conversa quente e aberta (negociação, dúvida específica); o CRC envia com um toque.
- **Guarda-corpos sempre ativos:** nunca toca carteira *Dra. Izabela* · respeita janela 24h · nunca repete · **para na hora que a pessoa responde** · opt-out.

### 4.2 Configurador de Agentes (no-code) — requisito do Luiz
Painel onde o Luiz cria/edita regras **sem depender do dev**. Cada automação é um bloco **QUANDO → ENTÃO**:
- **QUANDO:** estado + condição de tempo (+ filtros: tratamento etc.).
- **ENTÃO:** enviar template · sugerir rascunho · criar tarefa · mudar estágio · alertar interno.
- **MODO:** 🤖 auto vs 🧑 sugere (a Regra C, por regra).
- **MENSAGEM/CANAL:** regra `auto` escolhe de **lista de templates aprovados** (constraint Meta para fora da janela de 24h); regra `sugere` aceita texto livre. Número (2873 quente / 8700 frio).
- **LIMITES** (defaults ligados), **liga/desliga**, **"Testar em 1 lead"**, e **métricas por regra** (enviados, taxa de resposta).

### 4.3 Catálogo de gatilhos (cardápio do configurador)
- **💰 Financeiro:** boleto vence hoje; inadimplente há 1 dia (interno → CRC); atraso 3/7/15d (régua); pagamento confirmado; recorrência/cartão expirando.
- **🦷 Clínico/Retorno:** 180d da última limpeza; tratamento aberto sem agendamento futuro; pré-consulta D-1 (instruções); pós-procedimento 1–3 dias ("como está se sentindo?"); manutenção de alinhador/aparelho vencendo.
- **😊 Experiência/Pós-venda:** aniversário (Fase 2: áudio do Dr. Marcos); fim de tratamento → NPS; pós-NPS (9–10 → review/indicação; ≤6 → alerta gestor); "1 ano de sorriso novo"; programa de indicação.
- **🔥 Comercial/Reativação:** lead novo sem resposta; negociação parada; frio ❄️/💸; **lead visitou o link/site agora** → alerta CRC (encaixa na estratégia de rastreamento de interesse); orçamento de alto valor parado → escala gestor.
- **🔔 Internos:** conversão de etapa caindo; lead sem dono há X horas / SLA de 1ª resposta; resumo diário de metas.

### 4.4 Conexão WhatsApp
Decisão: **número novo via oficial** (na WABA atual = mais um `phone_id`) **ou via BSP** (Twilio/360dialog/Gupshup — mesma API oficial, onboarding mais fácil, **sem risco de ban**). **Evolution/não-oficial fica fora do projeto** (risco de ban, sobretudo em disparo).

### 4.5 Agentes analíticos (os 7) — viabilidade e priorização
Quase todos dependem da fundação (Blocos 1-2). Divisor extra: **lê conversa** (LLM sobre `mensagens`, custo recorrente) vs **dado estruturado** (barato/determinístico).

| # | Agente | Lê conversa? | Esforço | ROI |
|---|---|---|---|---|
| 1 | Comercial (esquecidos, R$ parado, tarefas) | Não | Baixo | Altíssimo |
| 4 | Performance do Funil (anomalias) | Não | Médio | Alto |
| 5 | Marketing (campanha→faturamento) | Não | Médio | Altíssimo |
| 3 | Inteligência Comercial (objeções) | v1 não / v2 sim | Médio | Alto |
| 2 | Auditor de CRC (qualidade) | Sim | Alto | Alto (indireto) |
| 6 | Experiência do Paciente (churn) | Sim | Alto | Médio |
| 7 | Executivo (consolida tudo) | Não | Baixo* | Alto (alavanca) |

\* fácil só *depois* que os outros existem.

**Conselho de produto:** não construir 7 silos. Construir **um motor analítico** que cresce.

---

## 5. Bloco 4 — Migração (legado + importados)
- Mapear status legados (caixa-baixa, `Avaliação`, `Nutrir`/`Em nutrição`) → conjunto canônico novo.
- Corrigir `lead_id` NULL em orçamentos/avaliações; reconciliar `leads.valor` vs orçamentos (origem da divergência R$12,9M × R$2,5M).
- Dar **ficha 360º** aos importados (hoje sem detalhe no módulo `pacientes`).
- Derivar tipo de nutrição (❄️/💸) e marcos a partir do histórico existente (`lead_eventos`).
- Preservar família no mesmo número (não normalizar telefones com 0 à esquerda).

---

## 6. Priorização de implementação (ORDEM RECOMENDADA — seguir na execução)

0. **Fundação** (Bloco 1 + migração mínima de estado): modelo Pessoa/Oportunidade, funil canônico, atributos, estado frio automático. *Pré-requisito de tudo.*
1. **Ficha única** (Bloco 2): contexto lateral + Página 360º. Resolve as duas dores visíveis e dá a base de leitura para os agentes.
2. **Agente Comercial (#1) + núcleo do Performance (#4)** — mesmo motor; dinheiro na mesa; estruturado, sem conversa.
3. **Configurador de Agentes** + agentes de ação por template (retorno preventivo, follow-up, reativação ❄️/💸) — Regra C.
4. **Agente de Marketing (#5)** — campanha→faturamento cruzando gasto de anúncio; realoca verba.
5. **Inteligência Comercial (#3)** — v1 do motivo de perda (grátis) → v2 lendo conversas.
6. **Auditor de CRC (#2)** — leitura de conversa; coaching.
7. **Experiência do Paciente (#6)** — conversa + sentimento + reviews.
8. **Agente Executivo (#7)** — capstone (versão fina pode entrar já após o passo 2).

ROI mais rápido: **#1** (recupera negócio parado) e **#5** (realoca verba). Mais fáceis: **#1, #4, #3-v1**. Dependem de conversa: **#2, #3-v2, #6** (mensagens já existem).

---

## 7. Riscos e dependências
- **Qualidade de dado legado** pode atrasar a migração (status sujos, valor inconsistente).
- **Custo recorrente de LLM** nos agentes que leem conversa (2/3v2/6) — dimensionar por volume.
- **Sensibilidade** do Auditor de CRC (avalia pessoas) — introduzir com cuidado/transparência.
- **Monólito** (`index.html`/`server.js`) — quebrar em módulos durante o Bloco 2 reduz risco de cada mudança.
- **Worktrees concorrentes na `main`** — isolar trabalho.

## 8. Fase 2 / decisões em aberto
- Régua fina de reativação (ligada ao Retorno de Prevenção).
- Áudio de aniversário do Dr. Marcos.
- Fonte de avaliações (Google) para o Agente de Experiência.
- BSP específico (se sair da Meta direta).
