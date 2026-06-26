# Softphone confiável — padrão do SDK 3C (eventos Socket.io + reconexão)

**Data:** 2026-06-26
**Status:** Design aprovado (aguardando review do spec)
**Origem:** Reclamação do usuário — "o sistema de ligação às vezes não funciona, e o lance de abrir outra página é ruim". Investigação confirmou que a falha vem do ramal WebRTC (iframe) cair sem que a gente detecte/recupere.

## Problema

Hoje a ligação click-to-call depende de um iframe que carrega `/extension?api_token=` (o softphone WebRTC do 3C). O disparo via API (`manual_call/enter` → `dial`) só funciona se o ramal estiver **registrado e conectado** — confirmado pelo suporte 3C:

> "Para que a 3C efetivamente origine a ligação, é necessário que o agente esteja com o WebRTC ativo e devidamente conectado na plataforma. Sem essa configuração, a chamada não poderá ser iniciada, mesmo que a requisição de Click-to-Call seja enviada com sucesso."

**Causas-raiz do "às vezes não liga":**
1. **Sem detecção de estado real** — hoje a gente adivinha o registro lendo o *texto* do iframe (`#softphone-status`), não o estado real do ramal.
2. **Sem recuperação** — quando o iframe cai (navegação para uma página separada do CRM, F5, queda de rede), o agente é deslogado e ninguém reconecta. A próxima ligação falha silenciosamente.

O suporte recomendou o **SDK oficial** (https://github.com/wosiak/3cplus-sdk) como o jeito certo de embutir isso num CRM próprio. O SDK usa a **mesma arquitetura que já temos** (iframe oculto + API de discagem), porém adiciona a peça que nos falta: uma **camada de eventos em tempo real via Socket.io** que permite saber o estado do ramal e reconectar sozinho.

## Decisão

Adotar o **padrão** do SDK (não o pacote TypeScript — nosso front é JS puro): iframe oculto persistente + conexão Socket.io para eventos + reconexão automática + checagem real antes de discar. O disparo via API e o cron de polling de log permanecem **sem mudança**.

## Não-objetivos (YAGNI / Fase 2)

- Log e análise Gemini em tempo real via `call-was-finished` (continua no cron de polling por enquanto).
- Status ao vivo da ligação no painel do lead ("chamando… / em ligação 00:42").
- UI de admin para alternar o modo do softphone por usuário (no teste, seta-se a Paola direto via migração/SQL).

## Arquitetura

```
Navegador (index.html, SPA)
 ├─ iframe OCULTO  → https://clnicaama.3c.plus/extension?api_token=<agentToken>   (áudio SIP)
 ├─ Socket.io      → https://socket.3c.plus  ?token=<agentToken>                 (eventos)
 │     ├─ agent-is-connected / agent-is-idle      → estado "pronto"  (libera Ligar)
 │     ├─ agent-was-logged-out / disconnect       → recarrega iframe + reconecta (backoff)
 │     └─ call-was-connected / call-was-finished  → estado da ligação (UI; log = Fase 2)
 ├─ Pílula de status   🟢/🟡/🔴 + botão "reconectar"
 └─ Botão "📞 Ligar"   → POST /api/leads/:id/ligar   (servidor: enter→dial, INALTERADO)

Servidor (INALTERADO)
 ├─ POST /api/leads/:id/ligar  → threec.ligar() (enter→dial)
 └─ cron getCalls() (polling)  → rede de segurança do log em `ligacoes`
```

## Componentes

### 1. Cliente Socket.io no navegador
- Carregar `socket.io-client` no `index.html`. **A versão precisa ser compatível com o servidor do 3C** (socket.io v2 e v3/v4 não conversam) — confirmar a versão lendo o `web/index.html` do SDK antes de implementar.
- Inicializar: `io('https://socket.3c.plus', { transports: ['websocket'], query: { token: agentToken } })`.
- Só inicializa para usuários com `softphone_modo === 'sdk'` e `threec_agent_token` presente.

### 2. Máquina de estado do softphone (no front)
Estado derivado dos eventos:
- `desconectado` (inicial / após `agent-was-logged-out` / `disconnect`)
- `conectando` (iframe carregando / socket conectando)
- `pronto` (recebeu `agent-is-connected` ou `agent-is-idle`)
- `em_ligacao` (entre `call-was-connected` e `call-was-finished`)

A pílula reflete o estado: 🟢 "Softphone conectado", 🟡 "Reconectando…", 🔴 "Desconectado — clique para reconectar".

### 3. Reconexão automática
- Em `agent-was-logged-out`, `disconnect` do socket, ou `error`/`exception`: reagenda reconexão com backoff (ex.: 1s, 3s, 10s, depois a cada 30s) — recarrega o `src` do iframe e reconecta o socket.
- Botão manual "reconectar" na pílula força a reconexão na hora.

### 4. Checagem real antes de discar
- `_garantirSoftfoneAberto()` passa a checar o **estado da máquina** (`pronto`/`em_ligacao`), não o texto do iframe.
- Se não estiver pronto: dispara reconexão e mostra toast com motivo claro ("Softphone reconectando, aguarde o 🟢 e tente de novo"). **Não** chama a API de discar.

### 5. Iframe oculto persistente
- O widget arrastável atual é substituído pela pílula de status; o iframe vira `display:none` (ou 1×1px fora da tela), montado **uma vez** no `index.html` e nunca recriado durante a navegação SPA.
- Mantém `allow="microphone"`.

### 6. Gate por usuário (rollout)
- Nova coluna `profiles.softphone_modo` — texto, default `'iframe'`, valores `'iframe' | 'sdk'`.
- `/api/me` e `loadProfile` passam a devolver o campo.
- Migração liga **só a Paola** em `'sdk'`. Demais CRCs seguem no caminho `'iframe'` atual, intacto.
- Validado com a Paola → migração liga as 5 e o caminho `'iframe'` é aposentado num passo seguinte.

## Backend
- `lib/3cplus.js`: **sem mudança** no disparo (`ligar()` = enter→dial).
- `/api/leads/:id/ligar`: **sem mudança**.
- `loadProfile` / `/api/me`: incluir `softphone_modo`.
- Cron `getCalls()`: **sem mudança** (rede de segurança do log).

## Tratamento de erro
- Socket não autentica com o api_token estático → ver "Riscos" #1. Front mostra 🔴 e instrução; servidor de discagem ainda devolve erro legível do 3C (comportamento atual mantido).
- Falha de discagem (`agent-manual-enter-failed`, `call-was-failed`, `call-was-not-answered`) → toast claro + estado volta a `pronto`.

## Testes / validação (com a Paola)
1. **Autenticação do socket** (risco #1): a conexão `io(..., {query:{token: <api_token estático>}})` autentica? → ver evento `agent-is-connected` no console. Se rejeitar, acionar o plano B (Riscos #1).
2. **Detecção de registro:** ao abrir o CRM, a pílula vira 🟢 só após `agent-is-connected`.
3. **Discagem:** clicar "Ligar" num lead → telefone toca → `call-was-connected` recebido.
4. **Recuperação:** navegar para uma página separada e voltar (ou F5) → pílula reconecta sozinha em segundos; "Ligar" volta a funcionar sem ação manual.
5. **Bloqueio correto:** com o softphone 🔴, clicar "Ligar" não dispara a API e mostra motivo.

## Riscos e incógnitas
1. **🔴 Principal — auth do socket:** o demo do SDK obtém um **JWT via `POST /authenticate` (user+senha)** e usa esse token no socket. Nós guardamos o **api_token estático** do agente (Configurações → Usuários → opções avançadas). O iframe `/extension` já funciona com o token estático; falta provar que o **socket** também aceita.
   - **Plano A:** usar o api_token estático direto no socket (sem guardar senha). Validar no teste 1.
   - **Plano B (se A falhar):** endpoint no servidor que faz `authenticate` e devolve um JWT de curta duração para o front — **exige guardar credenciais do agente**, o que queremos evitar; só adotar se não houver alternativa.
2. **Versão do socket.io-client** precisa casar com o servidor do 3C → confirmar no `web/index.html` do SDK.
3. **`agent/login` em campanha:** o front do SDK loga com `{ campaign, mode: 'dialer' }`; nosso servidor loga com `{ campaign }`. Hoje funciona, mas validar que não conflita com a sessão do socket.
4. **Páginas separadas do CRM:** o iframe+socket vivem no `index.html`. Sair para uma página não-SPA mata os dois; a reconexão automática ao voltar mitiga, mas não elimina, a janela de indisponibilidade. (As ligações partem de leads/Conversas, ambas dentro do `index.html`.)

## Referências
- SDK 3C: https://github.com/wosiak/3cplus-sdk (ver `web/app.js`, `web/index.html`)
- Resposta do suporte 3C (2026-06): WebRTC tem de estar ativo+conectado; recomendaram o SDK.
- Memória do projeto: integração 3cplus (sub-projeto 1), `lib/3cplus.js`, `/api/leads/:id/ligar`.
