# Monitor Diário das CRCs — Design

**Data:** 2026-06-11
**Objetivo:** O gestor acompanha, por dia e por CRC, o trabalho realizado no CRC de Leads (conversas, mensagens, templates, agendamentos, movimentações, ligações, anotações, tempo de 1ª resposta), num painel navegável + resumo automático por push às 18h30.

## Decisões do brainstorm (Luiz)

- Consumo: **painel no CRM + resumo automático diário**.
- Resumo: **notificação push** (infra VAPID já ativa) para admin/gestor — sem WhatsApp na v1.
- Acesso: **admin/gestor veem todas as CRCs; cada CRC (`crc_leads`) vê só os próprios números**.
- Métricas extras aprovadas: tempo de 1ª resposta, templates, movimentações de funil, ligações 3cplus, anotações SDR.
- Sem mockup; arquitetura: **Abordagem A** — agregação on-the-fly de `lead_eventos` (sem schema novo de stats).

## Métricas (por CRC, por dia, fuso America/Sao_Paulo)

| Métrica | Fonte | Definição |
|---|---|---|
| Conversas atendidas | `lead_eventos` tipo `mensagem_enviada` | Leads DISTINTOS com ≥1 mensagem da CRC no dia |
| Mensagens enviadas | idem | Total de eventos no dia |
| Templates | tipo `template_enviado` | Total no dia |
| Agendamentos | tipo `status_mudou` com `metadata.para='Agendado'` | Total no dia |
| Movimentações de funil | tipo `status_mudou` (qualquer destino) | Total + breakdown por destino (`metadata.para`) |
| Ligações | tabela `ligacoes` (`usuario_id`, `status`, `criada_em`) | atendidas / total no dia. Quais valores de `status` contam como "atendida" será confirmado na implementação consultando os valores reais da tabela (`select distinct status from ligacoes`) |
| Anotações SDR | **NOVO** tipo `nota_sdr_editada` | Total no dia (só a partir do deploy — sem retroativo) |
| Tempo de 1ª resposta | `mensagens` (recebidas) × eventos `mensagem_enviada` | Média do dia, atribuída à CRC que respondeu |
| ⚠️ Leads sem resposta | idem | Leads que escreveram no dia e seguem sem resposta (métrica do TIME, não por CRC) |

Regras de atribuição:
- Eventos com `usuario_id` null (webhook, sync Clinicorp, cron de agendadas) **não contam** para nenhuma CRC. Mensagens do cron de agendadas não geram evento `mensagem_enviada` — já ficam de fora naturalmente.
- Nome da CRC: `profiles.nome`; sem nome → e-mail truncado (padrão atual `_nomeCrc`).

Tempo de 1ª resposta — definição precisa:
- Uma "espera" começa na primeira mensagem `recebida` sem resposta posterior pendente e termina no próximo evento `mensagem_enviada` (de qualquer CRC) do mesmo lead. Mensagens recebidas em rajada não abrem novas esperas.
- A espera concluída entra na média da CRC que respondeu (e na média do time).
- Espera ainda aberta ao consultar → lead entra em "sem resposta" e NÃO entra na média.
- Esperas iniciadas no dia consultado contam para aquele dia (mesmo que respondidas no dia seguinte — atribuição pela data de início da espera).

## Novo evento `nota_sdr_editada`

No `patchLead` (`server.js`), quando o patch contém `notas_sdr` e o valor difere de `lead.notas_sdr` anterior: `logEvento(id, 'nota_sdr_editada', 'Anotação SDR atualizada', { tamanho: <chars> }, req.user?.id)`. Não grava o conteúdo no evento (a nota já vive no lead; evita duplicar dado sensível).

## Arquitetura

### 1. `lib/monitor/crc.js` — agregador puro (testável)

```
montarMonitorCrc({ eventos, ligacoes, recebidas, agora }) → {
  porCrc: [{ usuario_id, conversas, mensagens, templates, agendamentos,
             movimentacoes: { total, porDestino: {<status>: n} },
             ligacoes: { total, atendidas }, anotacoes,
             primeiraRespostaMediaMin, respostas: n }],
  time: { ...somas..., semResposta: [{ lead_id, desde }] }
}
```
Entradas já filtradas pelo dia (IO fora). Sem acesso a banco — segue o padrão de `lib/monitor/diario.js` e `lib/funil/*`. Testes em `lib/monitor/crc.test.js`.

### 2. `GET /api/monitor-crc?data=YYYY-MM-DD` (`server.js`)

- `requireAuth` + role: `admin`/`gestor` → todas as CRCs; `crc_leads` → resposta filtrada para o próprio `usuario_id` (filtro NO SERVIDOR) e sem a lista de outros; demais roles → 403.
- IO: busca `lead_eventos` do dia (tipos relevantes), `ligacoes` do dia, mensagens `recebidas` do dia (+ eventos `mensagem_enviada` do dia seguinte até o momento, para fechar esperas), nomes em `profiles`. Janela do dia calculada em America/Sao_Paulo.
- Resposta inclui `nomes: {usuario_id: nome}` resolvidos.

### 3. Página `/monitor-crc/` (novo módulo, padrão CLAUDE.md)

- `public/monitor-crc/index.html` + `public/js/monitor-crc/` com `shared-nav.js` (`data-active="monitor-crc"`); entrada no nav do `index.html` e do `shared-nav.js` com `data-roles="admin,gestor,crc_leads"`.
- Header: navegação por dia (◀ data ▶, atalho "Hoje"), botão Atualizar.
- Cards do time: conversas, mensagens, agendamentos, ligações, tempo médio 1ª resposta, e card vermelho "⚠️ N leads sem resposta" (lista expandível com nome/desde quando).
- Tabela por CRC (colunas = métricas; movimentações com tooltip do breakdown). Para `crc_leads`, a página mostra só os próprios cards (sem tabela comparativa).
- Auth da página: padrão de páginas separadas (token `sb-*-auth-token` do localStorage).

### 4. Resumo automático (push 18h30)

- Agendador in-process no `server.js` (padrão do cron de agendadas): a cada 60s confere hora local América/Sao_Paulo; quando ≥18:30 e `app_config.resumo_crc_ultimo_envio <> hoje`, marca a data (claim primeiro, idempotente a restart/instâncias) e envia.
- Push via infra existente (`web-push` + tabela de subscriptions) para usuários com role admin/gestor.
- Texto: `Resumo CRC 11/06 — 38 conversas, 9 agendamentos, 3 sem resposta | Paola 20c/5a · Maria 18c/4a`. Payload com URL `/monitor-crc/` (clicar abre o painel).
- Coluna nova `app_config.resumo_crc_ultimo_envio date` (migration).

## Casos de borda

- Dia sem atividade → painel zerado; push envia mesmo assim (ausência também é sinal).
- Dia futuro → 400. Data inválida → 400.
- `crc_leads` consultando dia antigo → permitido (só os próprios números).
- Anotações SDR antes do deploy → 0 (registro começa agora; demais métricas são retroativas desde a criação do CRM).
- Eventos `status_mudou` do sistema (usuario_id null) aparecem só em métricas do time? NÃO — fora de tudo no monitor (o funil já tem dashboards próprios).

## Fora de escopo (YAGNI)

- Resumo por WhatsApp (template Meta) — fase 2 se o push não bastar.
- Comparativos semanais/mensais e gráficos de tendência.
- Metas individuais por CRC (existe só a meta diária global de agendamentos).
- Snapshot em tabela (`crc_stats_diarios`) — migrar se o volume crescer.

## Validação

1. Testes do agregador: distinct de conversas; atribuição por usuario_id (null fora); rajada de recebidas = 1 espera; espera aberta → sem resposta e fora da média; breakdown de movimentações; ligações atendidas/total; fronteira de fuso (23h59 BRT).
2. Painel de hoje × medidor de meta de agendamentos da lista de conversas: números de agendados por CRC devem bater.
3. Push de teste: forçar envio (endpoint interno com `requireCronSecret`, padrão existente) e conferir recebimento no celular do gestor.
