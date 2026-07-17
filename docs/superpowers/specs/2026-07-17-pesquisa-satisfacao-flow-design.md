# Pesquisa de Satisfação via WhatsApp Flow — Design

**Data:** 2026-07-17
**Status:** Aprovado por Luiz (brainstorm 17/07)

## Objetivo

Enviar automaticamente a Pesquisa de Satisfação (WhatsApp Flow já publicado na Meta)
para pacientes atendidos no dia, capturar as respostas estruturadas no nosso banco e
exibi-las no CRM (módulo próprio + ficha do paciente + card no Painel do Gestor).

## Contexto Meta (já existe, não criamos)

- **Flow publicado:** "Message templates_feedback_survey_form_SURVEY_87f29"
  (id `1597134942036009`), no número **3824-8700** (asset `1501011564952865`).
- **Template aprovado que abre o Flow:** `pesquisa_nps` (idioma pt_BR).
- Payload de conclusão do Flow (`on-click-action: complete`) já definido no JSON:
  `nps`, `motivo_principal`, `avaliacao_recepcao`, `avaliacao_dentista`,
  `avaliacao_espera`, `avaliacao_limpeza`, `avaliacao_explicacoes`, `comentario`.
  As avaliações por categoria são dropdowns com id "1" a "5"; `comentario` é opcional.
- **Não editar o Flow publicado** (a Meta reseta métricas ao republicar). A correlação
  resposta→paciente é por **telefone**, não por flow_token.

## 1. Disparo — job diário às 19h (BRT)

Scheduler **self-healing** no `server.js`, mesmo padrão do `sync-diario` das 02:00
(verifica a cada N minutos se já passou das 19:00 BRT e se já houve execução do dia;
claim atômico numa tabela de controle/`sync_log` para não duplicar entre instâncias).

### Seleção dos destinatários (consulta Clinicorp AO VIVO — não usar `producao_procedimentos`, que só é preenchida pelo sync das 02:00)

1. **Tratamentos executados hoje:** o `from/to` do `/estimates/list` filtra pela
   data do ORÇAMENTO, não da execução — procedimento executado hoje quase sempre
   pertence a orçamento antigo. Buscar janela de **90 dias em fatias de 30**
   (`fetchRangeChunked`, mesmo padrão do `syncProducao` em `sync/clinicorp-sync.js`,
   3 chamadas) e filtrar itens `Executed === 'X'` com `ExecutedDate === hoje`.
   Limitação aceita: orçamento com mais de 90 dias executado hoje escapa — mesma
   janela da `producao_procedimentos`.
2. **Avaliações de hoje:** `/appointment/list` com `from=to=hoje` (1 chamada),
   filtrando `Dentist_PersonId`/`ScheduleToId` pelos avaliadores da tabela
   **`config_avaliadores`** (ativo=true — NÃO usar o array fixo `DENTISTAS_AVALIACAO`
   do server.js) e **comparecimento** pela mesma regra do `syncAvaliacoes`:
   `CheckinTime` presente OU `StatusId` ∈ `config_status_compareceu`.
   ⚠️ Validar na 1ª semana se a recepção mantém o status/check-in da agenda em dia
   — aceito pelo Luiz.
3. **Telefone:** avaliações já trazem `MobilePhone`/`Phone` no appointment. Os
   tratamentos (estimates) NÃO trazem telefone — resolver pelo
   `paciente_clinicorp_id` na tabela `pacientes` local; fallback: telefone do
   agendamento de hoje do mesmo paciente (já buscado no passo 2, sem chamada
   extra); sem telefone → pula e registra motivo.
4. Total ~4 chamadas Clinicorp, dentro do limite de 25/h.

### Regras de dedup e supressão

- **1 pesquisa por TELEFONE a cada 3 meses** (não por paciente): telefones com 0 à
  esquerda são família (compartilhados) — regra do CRM, nunca normalizar/mesclar.
  Comparação por **sufixo-8**, como no resto do sistema.
- Dedup dentro do lote do dia: mesma pessoa em tratamento + avaliação, ou dois
  familiares no mesmo telefone → envia 1 só.
- Telefone vazio/inválido → pula e registra motivo.

### Envio

- Nova função `enviarTemplateFlow({ para, templateName, phoneNumberId })` em
  `whatsapp.js`: envia template `pesquisa_nps` pelo número broadcast (8700,
  `WA_BROADCAST_PHONE_ID`). O `enviarBroadcast` atual só monta componente `body` de
  texto; template com botão de Flow pode exigir componente
  `{ type:'button', sub_type:'flow', index:'0', parameters:[{ type:'action', action:{} }] }`
  — tentar envio simples primeiro (template já tem o Flow vinculado); se a Meta
  exigir o componente, incluí-lo. Confirmar na implementação com 1 envio de teste.
- Ritmo sequencial com pausa (~24/min), reusando o padrão do Disparo em Massa.
- Falha de um envio (número sem WhatsApp etc.) → `status='falhou'` + `erro`, segue o lote.

### Registro do envio

- Linha em `pesquisas_satisfacao` (ver §2) com `status='enviado'`.
- Se o telefone tem lead no CRM: insere em `mensagens` (thread do módulo Conversas,
  mesmo padrão dos templates do disparo) **e** `logEvento(lead_id,
  'pesquisa_enviada', ...)` → aparece no **Trajeto**.
- Paciente sem lead: fica só na tabela de pesquisas (sem thread).

### Disparo manual

Botão "Disparar pesquisas de hoje" no módulo (admin/gestor) chama o mesmo job sob
demanda — regra do projeto: módulo que depende da Clinicorp tem botão de sync manual.
Idempotente: respeita dedup/3 meses, então rodar 2x não duplica envio.

## 2. Dados — tabela `pesquisas_satisfacao`

Uma linha por envio; a resposta atualiza a mesma linha.

| Campo | Tipo | Nota |
|---|---|---|
| `id` | bigint identity PK | |
| `lead_id` | bigint null | FK leads, se houver |
| `paciente_clinicorp_id` | text null | |
| `paciente_nome` | text | snapshot no envio |
| `telefone` | text | como veio, sem normalizar |
| `dentista_nome` | text null | do procedimento/agenda |
| `origem` | text | `tratamento` \| `avaliacao` |
| `enviado_em` | timestamptz null | null na linha órfã |
| `wa_id` | text null | wamid do envio; null na órfã |
| `wa_id_resposta` | text null | wamid da resposta (dedup de reentrega) |
| `status` | text | `enviado` \| `respondido` \| `falhou` |
| `erro` | text null | |
| `respondido_em` | timestamptz null | |
| `nps` | smallint null | valor do campo `nps` do Flow |
| `motivo_principal` | text null | |
| `avaliacao_recepcao` | smallint null | 1–5 |
| `avaliacao_dentista` | smallint null | 1–5 |
| `avaliacao_espera` | smallint null | 1–5 |
| `avaliacao_limpeza` | smallint null | 1–5 |
| `avaliacao_explicacoes` | smallint null | 1–5 |
| `comentario` | text null | |
| `resposta_raw` | jsonb null | payload cru do nfm_reply |

**Segurança (regra do projeto):** `ENABLE ROW LEVEL SECURITY`, **sem policy** — todo
acesso passa pelo `/api` do servidor (service_role) com `requireRole`. Front não lê
a tabela direto.

## 3. Captura — webhook existente `/webhooks/whatsapp`

- Detectar `msg.interactive?.type === 'nfm_reply'` **antes** do fluxo genérico de
  mensagem recebida; `JSON.parse(msg.interactive.nfm_reply.response_json)`.
- Buscar em `pesquisas_satisfacao` a linha mais recente com `status='enviado'` para
  aquele telefone (sufixo-8, janela de 30 dias) → atualizar com notas + `respondido_em`
  + `resposta_raw`, `status='respondido'`.
- **Sem linha pendente** (edge raro): inserir linha órfã (`origem=null`,
  `enviado_em=null`) para não perder o dado; logar aviso.
- Se houver lead: `logEvento(lead_id, 'pesquisa_respondida', 'Respondeu pesquisa —
  nota de recomendação X', {...})` → Trajeto; a mensagem também entra na thread
  (tipo `interactive`) pelo fluxo normal do webhook, com texto amigável tipo
  "📋 Respondeu a Pesquisa de Satisfação".
- Dedup por `wa_id_resposta`: se já existe linha com aquele wamid, ignora
  (reentrega da Meta não duplica).

## 4. Exibição

### 4.1 Módulo `/pesquisa-satisfacao/`
- Lista de respostas (data, paciente, dentista, origem, notas, comentário) com
  filtro por período e dentista.
- Cards de resumo: nota de recomendação média (explicada por extenso, sem sigla
  seca), média por categoria (recepção, dentista, espera, limpeza, explicações),
  nº de enviadas × respondidas (taxa de resposta), últimas falhas.
- Botão "Disparar pesquisas de hoje".
- Página separada (padrão do projeto): `shared-nav.js` + `api.js` próprio; item novo
  em `CRM_NAV` (`nav-config.js`), `roles:'admin,gestor,mod_pesquisa_satisfacao'`.
- Registro no módulo Usuários (checkbox Módulos Extras `mod_pesquisa_satisfacao`,
  `_ROLE_LABELS`, `criarUsuario()`) + middleware `requireRole` no servidor.

### 4.2 Ficha do paciente (Pacientes 2)
Bloco "Pesquisas de Satisfação" com histórico de envios/respostas daquele paciente
(via `/api`, join por `paciente_clinicorp_id` e/ou telefone).

### 4.3 Painel do Gestor
Card novo: nota de recomendação média do período + nº de respostas + semáforo
(verde/amarelo/vermelho por faixa), com "entenda" explicando o cálculo — padrão dos
outros 10 indicadores.

## 5. Erros e casos-limite

- Clinicorp fora do ar às 19h → self-healing tenta de novo no próximo tick até
  conseguir no mesmo dia; após 23:59 desiste (o dia perdeu a janela "mesmo dia").
- Envio individual falho não trava o lote.
- Resposta depois de 30 dias → cai como órfã (aceitável).
- Duas respostas do mesmo telefone (reenvio manual futuro): cada resposta casa com o
  envio pendente mais recente; se nenhum pendente, órfã.
- Job idempotente por dedup de 3 meses/telefone.

## Fora de escopo (agora)

- Lembrete para quem não respondeu.
- Análise dos comentários por IA (candidato a consultor futuro).
- Opt-out automático de pesquisa.
- Backfill de atendimentos passados.

## Validação pós-deploy

1. Envio de teste para o telefone do Luiz (confirmar formato do template/botão Flow).
2. Responder o Flow e conferir a linha em `pesquisas_satisfacao` + Trajeto + thread.
3. 1ª semana: conferir se as avaliações de Marcos/Matheus estão sendo pegas
   (status da agenda atualizado pela recepção).
