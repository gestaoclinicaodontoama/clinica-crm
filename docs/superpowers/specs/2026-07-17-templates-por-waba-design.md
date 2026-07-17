# Templates por WABA/número (2873 × 8700) — Design

## Contexto

A clínica tem **duas contas WhatsApp Business (WABAs) distintas**, cada uma com um número:
- **2873** (número de conversa / SDR — `WHATSAPP_PHONE_NUMBER_ID`, `whatsapp.defaultPhoneId()`): usado para conversar com leads. Objetivo do template aqui: **reengajar** o paciente depois que passou a janela de 24h que a Meta permite conversa livre.
- **8700** (número de disparo frio — `WHATSAPP_BROADCAST_PHONE_ID`, `whatsapp.broadcastPhoneId()`): usado para campanhas de disparo.

Na Meta, um template aprovado numa WABA **só pode ser enviado por números daquela mesma WABA**. Hoje o CRM ignora isso: a tabela `templates` tem `nome` como chave única global e o `sync-meta` puxa de **uma só** WABA. Consequências:
- Os templates criados na WABA do 2873 (`retomar_atendimento`, `retomar_atendimento_1`, `retomar_atendimento_2`, `ultima_semana_para_garantir_at_15_de_desconto`) nunca entram no banco → não aparecem no chat.
- O mesmo nome não pode coexistir nas duas contas (ex.: `hello_world` existe nas duas), o que impede importar a segunda WABA.

Mapeamento de IDs confirmado pelo padrão de tráfego no banco: `993441140514749` = 2873 (8.492 recebidas / 4.127 enviadas — conversa real); `1142709218919903` = 8700 (19 recebidas / 108 enviadas — perfil de disparo). O código não fixa qual literal é qual — resolve via `defaultPhoneId()`/`broadcastPhoneId()` a partir do env; o sync descobre o número de cada WABA dinamicamente (ver abaixo), então não dependemos de hardcodar esses IDs.

**Premissa:** cada WABA tem **1 número**. O vínculo modelado é template → número (`wa_number_id`). Se um dia uma WABA passar a ter mais de um número, revisitar.

## Objetivo

1. Sincronizar os templates das **duas** WABAs, marcando de qual número cada um é.
2. No chat do CRC, mostrar só templates **aprovados e do número daquela conversa**, e enviar por esse número.
3. Nos Disparos em massa, mostrar só templates da conta do número selecionado na campanha.
4. Deixar legível no histórico do lead o template que ele recebeu (rastreabilidade), independente da WABA.

## 1. Modelo de dados (migração Supabase)

- Adicionar coluna `wa_number_id text not null default ''` em `public.templates`.
- Remover a constraint UNIQUE `templates_nome_key` (`nome`) e criar índice único sobre `(nome, wa_number_id)` — permite o mesmo nome coexistir em WABAs diferentes.
- A tabela já tem RLS ligado; a migração não abre nada novo ao `anon`/`authenticated` (o servidor acessa via service_role; o front lê templates via `/api/templates`, não direto). Nenhuma policy nova necessária. Seguir a regra de segurança do `CLAUDE.md`.

Templates legados que ainda não foram associados ficam com `wa_number_id = ''` até o primeiro sync preenchê-los.

### 1a. Backfill de `leads.wa_number_id` (na mesma migração)

O envio de template no chat exige `leads.wa_number_id` — e o público-alvo do reengajamento é justamente lead parado, muitas vezes antigo. Hoje **120 leads com conversa** estão sem número registrado; **101 deles** têm o número derivável das próprias mensagens. Backfill na migração:

```sql
update leads l set wa_number_id = sub.wa_number_id
from (
  select distinct on (lead_id) lead_id, wa_number_id
  from mensagens
  where wa_number_id is not null and wa_number_id <> ''
  -- prioriza mensagens RECEBIDAS: o número "da conversa" é onde o lead fala,
  -- não onde um disparo foi enviado (um disparo via 8700 não pode virar o número do lead)
  order by lead_id, (direcao = 'recebida') desc, id desc
) sub
where l.id = sub.lead_id and (l.wa_number_id is null or l.wa_number_id = '');
```

Os ~19 restantes (todas as mensagens sem número — era pré-coluna) permanecem vazios e caem no bloqueio com erro claro; não inventar número para eles.

### 1b. Consultas que assumem `nome` único (quebram com a mudança — corrigir juntas)

Com nomes duplicáveis, todo `.eq('nome', X).maybeSingle()` sobre `templates` passa a poder retornar 2 linhas e **falhar**. Três pontos no `server.js` precisam de ajuste na mesma entrega:

1. `templateAprovado(nome)` (linha ~1504, usado pelos Disparos): passa a receber também o número da campanha — `templateAprovado(nome, waNumberId)` — e consultar `.eq('nome', nome).eq('wa_number_id', waNumberId)`. Isso também fecha um furo real: um template aprovado no 2873 mas inexistente/rejeitado no 8700 hoje passaria na checagem e falharia só na Meta.
2. Lookup de `categoria` pós-envio na rota `/api/leads/:id/whatsapp` (linha ~2215): escopar por `wa_number_id` do envio (`.eq('nome', templateName).eq('wa_number_id', <número usado>)`).
3. Checagem de duplicidade no `POST /api/templates` (linha ~2576): manter a regra atual (nome já existe → recusa), mas com consulta que não estoura com múltiplas linhas (`.select('id').eq('nome', nomeLimpo).limit(1)`). Criação local continua nascendo com `wa_number_id = ''` (o sync adota depois da aprovação na Meta); o fluxo `submeter-meta` continua submetendo à WABA configurada, sem mudança.

## 2. Sincronização das duas WABAs (`POST /api/templates/sync-meta`)

Hoje a rota descobre **uma** WABA (primeira de `me/whatsapp_business_accounts`) e importa os templates dela sem número. Passa a:

1. **Coletar todas as WABAs visíveis**, unindo as contas retornadas por `me/whatsapp_business_accounts` para cada token configurado (`META_ACCESS_TOKEN`, `WHATSAPP_API_TOKEN`, `WHATSAPP_BROADCAST_TOKEN`), deduplicando por WABA id — e **lembrando qual token enxergou cada WABA**. As chamadas seguintes de cada WABA (`phone_numbers`, `message_templates`) usam o token que a descobriu; um token de uma conta não necessariamente tem permissão na outra.
2. **Para cada WABA**, descobrir o `phone_number_id` do seu número via `/{waba-id}/phone_numbers` (1 número por WABA, premissa acima) e buscar seus `message_templates` (com paginação, como já é hoje).
3. **Gravar cada template** com `wa_number_id` = o phone_number_id daquela WABA, mapeando o status da Meta para o domínio local (`STATUS_MAP` existente). A associação (nome, número):
   - Se já existe registro `(nome, número)` → atualiza status/meta_id.
   - Senão, se existe registro legado `(nome, '')` ainda não adotado nesta rodada → adota (seta `wa_number_id`, status, meta_id).
   - Senão → insere novo `(nome, número, ...)`.
   Assim o primeiro sync preenche automaticamente os templates atuais (invisalign, prevenção, etc.) com o número correto, sem trabalho manual, e nomes que existem nas duas contas viram dois registros (um por número).

   **Ordem determinística:** processar primeiro a WABA cujo número é o `broadcastPhoneId()` (8700). Os registros legados vieram do sync antigo, que só lia essa conta — assim a adoção do registro `(nome, '')` cai na WABA de origem, preservando corpo/edições locais no registro certo quando o mesmo nome existe nas duas contas.
4. Retornar contagem de atualizados/importados por WABA (para o toast de feedback).

**Allow-list `WA_TEMPLATES` (env):** o `GET /api/templates` mescla nomes do env como pseudo-templates aprovados. Esses itens sintéticos passam a sair com `wa_number_id = whatsapp.broadcastPhoneId()` (eram da era broadcast-only) — sem isso, os filtros novos os esconderiam de todas as telas. A checagem por env em `templateAprovado` permanece.

## 3. Chat do CRC (`public/index.html`)

- `abrirModalTemplate()`: filtrar `_templatesCache` para `status === 'aprovado' && wa_number_id === chatLeadAtual.wa_number_id` (o número da própria conversa, já presente no objeto do lead via RPC `conversas_com_preview`). Se não houver nenhum, manter a opção "Nenhum template aprovado disponível". Caso a conversa não tenha número registrado (`chatLeadAtual.wa_number_id` vazio — ~19 leads pré-backfill), mostrar mensagem específica ("Conversa sem número identificado — não é possível enviar template") em vez da genérica.
- Trocar o texto fixo do modal (hoje sempre "Enviado pelo Número 2 (broadcast)…") por um texto que reflita o número da conversa — usar o rótulo amigável de `_waNumbers[chatLeadAtual.wa_number_id]` (ex.: "Enviado pelo número desta conversa (…-2873)").
- O envio pela rota `/api/leads/:id/broadcast` já sai pelo número da conversa (`lead.wa_number_id`) — implementado antes; sem mudança adicional.
- **Segundo caminho de template esquecido:** a rota `/api/leads/:id/whatsapp` também aceita `templateName` e ainda envia pelo 8700 fixo (`whatsapp.enviarTemplate` sem `phoneNumberId`, linha ~2197). O front atual não usa esse braço (só `/broadcast`), mas é API viva — alinhar à mesma regra: enviar por `lead.wa_number_id` e recusar com erro claro se vazio, igual ao `/broadcast`. O `wa_number_id` gravado em `mensagens` nesse braço acompanha.

## 4. Disparos em massa (`public/index.html`)

- `dispCarregarTemplates()`: filtrar templates por `status === 'aprovado' && wa_number_id === <número selecionado na campanha>`. O seletor de número já existe (`disp-numero` / `wa_number_id`); ao trocar o número, refiltrar a lista de templates. Padrão do seletor segue o do backend (`defaultPhoneId()`), então o filtro inicial usa esse número.

## 5. Rastreabilidade / renderização legível

O registro já existe: todo envio de template — chat (`canal='broadcast'`, texto `[template: …]`) e disparo em massa (runner, texto `[disparo: …]`) — grava uma linha em `mensagens` vinculada ao `lead_id`, com o `wa_number_id` de origem; o histórico do lead (`GET /api/leads/:id/mensagens`) mostra tudo junto, sem filtrar por número. Nada novo a construir para "constar".

Melhoria de leitura: no render da bolha (`_bolhaMsgHtml`), detectar mensagens de template (`canal==='broadcast'` ou texto no formato `[template: …]` / `[disparo: …]` — com ou sem espaço após os dois-pontos; a rota `/whatsapp` grava `[template:x]` sem espaço) e exibir de forma legível — ex.: "📢 Template enviado: **Retomar atendimento**", mantendo o rótulo do número de origem (`waLabel`) e os ticks de entrega já existentes. Extrair o nome do template do texto e, quando possível, mostrar o `titulo` correspondente do template.

## Segurança

- Migração respeita o `CLAUDE.md`: `templates` continua com RLS ligado; sem grant novo a `anon`/`authenticated`. Acesso do front permanece via `/api/*` (service_role).

## Fora de escopo

- Suporte a mais de um número por WABA (premissa: 1 número por WABA).
- Tela de gestão separada por número (Luiz optou por Chat + Disparos, sem tela nova).
- Mudanças no fluxo de criação/submissão de template pelo CRM (`POST /api/templates` + `submeter-meta`) além da robustez de consulta descrita em 1b — continua submetendo à WABA configurada.

## Testes manuais

1. Rodar "↻ Sincronizar com Meta" e confirmar no banco que os 4 templates do 2873 entraram com `wa_number_id` = ID do 2873, e que os antigos ficaram com o número correto de cada WABA.
2. Abrir uma conversa de lead no 2873, clicar em Template: só devem aparecer os aprovados do 2873 (incluindo `retomar_atendimento*`). Enviar um e confirmar no WhatsApp do lead que chegou pelo 2873.
3. Confirmar no banco (`mensagens`) que a linha do envio tem `wa_number_id` = 2873, e que a bolha no histórico aparece legível ("📢 Template enviado: …").
4. Na tela de Disparos, com o número 8700 selecionado, confirmar que só aparecem templates do 8700; ao trocar para 2873, a lista muda para os do 2873.
