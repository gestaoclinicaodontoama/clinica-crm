# WhatsApp CRC: templates só aprovados + envio pelo número certo da conversa

## Contexto

Na tela de conversa do CRC (qualquer aba: "WhatsApp CRC Lead", "WhatsApp CRC Comercial", "WhatsApp API Oficial"), a CRC pode abrir o modal de template (botão "Template" ou banner vermelho "Enviar template" quando a janela de 24h fecha). Hoje esse modal tem dois problemas:

1. **Lista todos os templates, aprovados ou não.** `GET /api/templates` não filtra por status, então templates `rejeitado`/`pendente` aparecem no seletor junto com os `aprovado`, só com um rótulo diferente. A tela de Disparos em massa já filtra para só aprovados — o modal de conversa não.
2. **Envio sempre sai pelo número de disparos (8700), nunca pelo número da conversa (2873 ou outro).** A rota `POST /api/leads/:id/broadcast` é hardcoded pra `whatsapp.broadcastPhoneId()` (8700), independente de qual número o lead está conversando. Isso significa que ao reabrir uma janela fechada com um template, a mensagem sai de um número diferente do que o lead reconhece na conversa.

O dado pra resolver o problema 2 já existe: `leads.wa_number_id` guarda o número "de casa" do lead (setado na primeira mensagem recebida). A rota já faz `select('*')` na tabela `leads` mas nunca lê essa coluna.

## Mudanças

### 1. Filtrar templates aprovados no modal de conversa
Em `public/index.html`, `abrirModalTemplate()`: ao popular o `<select>` de templates, filtrar `_templatesCache` para `status === 'aprovado'` antes de renderizar as `<option>` — mesmo filtro que `dispCarregarTemplates()` já usa pra Disparos.

### 2. Enviar pelo número da conversa, não pelo número de disparos
Em `server.js`, `POST /api/leads/:id/broadcast`:
- Ler `lead.wa_number_id` do resultado já buscado (`select('*')` já traz essa coluna).
- Se `lead.wa_number_id` existir: usar esse valor como `phoneNumberId` em `whatsapp.enviarBroadcast({ ..., phoneNumberId: lead.wa_number_id })`, e gravar o mesmo valor em `mensagens.wa_number_id` (em vez do atual `whatsapp.broadcastPhoneId()` fixo).
- Se `lead.wa_number_id` estiver vazio/nulo (lead sem número de conversa ainda registrado — caso raro, ex.: lead novo sem mensagem recebida): **bloquear o envio** e responder erro (ex.: `400 { error: 'Não foi possível identificar o número desta conversa. Fale com o suporte.' }`) em vez de cair silenciosamente pro 8700.

Escopo explicitamente fora: a rota de Disparos em massa (`/api/disparos/*`) não muda — continua usando o número de disparos (8700) como hoje, com ou sem seletor manual de número.

## Teste manual pós-implementação
1. Abrir uma conversa de um lead com `wa_number_id` = número da SDR (2873), clicar Template, confirmar que só aparecem templates aprovados no seletor.
2. Enviar um template dessa conversa e confirmar no log/tabela `mensagens` que `wa_number_id` gravado é o mesmo da conversa (2873), não 8700.
3. (Se existir um lead de teste sem `wa_number_id`) confirmar que o envio retorna erro claro em vez de mandar por 8700.
