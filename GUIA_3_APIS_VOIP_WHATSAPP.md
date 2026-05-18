# 📞💬 Guia 3 — Ativar TotalVoice (ligações) e WhatsApp Cloud API (mensagens)

Estas são as duas integrações que **dão superpoderes** ao CRM:

1. **TotalVoice** — SDR clica em **📞 Ligar** no CRM, telefone toca, ela atende, conecta com o lead. Conversa fica gravada e disponível pra ouvir dentro do CRM.

2. **WhatsApp Cloud API** — Sistema envia mensagem oficialmente pelo número da clínica, recebe respostas no CRM, dispara templates aprovados (confirmação, lembrete).

⚠️ **Importante**: as duas integrações funcionam melhor **com o sistema na nuvem (Guia 2)**. Em localhost o WhatsApp Cloud API praticamente não funciona porque a Meta precisa enviar webhooks pro seu servidor.

---

# Parte A — TotalVoice / NVoip (~30 min)

## A.1 — Por que essa solução

| Aspecto | Detalhe |
|---|---|
| Tipo | Click-to-call brasileiro com gravação |
| Como funciona | API liga pra SDR primeiro; quando atende, conecta no lead |
| Vantagem | SDR não precisa de softphone, fone gamer ou WebRTC — usa o próprio celular |
| Custo aprox. | R$ 0,07/min fixo · R$ 0,15/min celular · gravação grátis |
| Volume estimado | 100 ligações × 5 min/dia × 22 dias = ~R$ 700-1.500/mês |

## A.2 — Criar conta

1. Acesse <https://www.totalvoice.com.br>
2. Clique em **"Criar conta grátis"**
3. Confirme email
4. Você recebe **R$ 5 em créditos** para testar (~30 ligações curtas)

## A.3 — Pegar o Access-Token

1. No painel, vá em **Configurações → Access-Token**
2. Copie a string (algo como `123abc456def...`)

## A.4 — Configurar no CRM

### Se rodando local (`.env` na pasta clinica-crm):
```
TOTALVOICE_TOKEN=cole_seu_token_aqui
TOTALVOICE_BINA=
```
Reinicie o servidor (Ctrl+C → `npm start`).

### Se rodando no Easypanel:
1. Vá no painel Easypanel → **plataformaama → plataforma → Environment**
2. Adicione `TOTALVOICE_TOKEN` com seu token
3. Salve — Easypanel reinicia automaticamente

## A.5 — Adicionar crédito

1. No painel TotalVoice: **Financeiro → Adicionar crédito**
2. Comece com **R$ 50** (paga ~7h de ligação)
3. Pague com PIX ou cartão

## A.6 — Configurar webhook

⚠️ Webhook só funciona com URL pública (Easypanel em produção).

1. No painel TotalVoice: **Configurações → Webhooks**
2. URL: `https://plataformaama-plataforma.uc5as5.easypanel.host/webhooks/totalvoice`
3. Eventos: marque **"Chamada finalizada"** e **"Gravação disponível"**
4. Salve

## A.7 — Primeira ligação (teste real)

1. Abra o CRM
2. Clique no botão **"Criar lead de teste"** (ou crie via URL com seu próprio número)
3. Abra o lead, clique em **📞 Ligar**
4. Sistema pergunta seu número (SDR) — digite com DDD: `5531987654321`
5. Seu telefone vai tocar em ~5 segundos
6. Atenda → você ouve o telefone do "lead" tocando
7. Conversa, desliga
8. Recarregue o lead → aba **"Chamadas"** mostra a chamada com player de áudio

✅ Funcionou? Você tem **discador profissional integrado**.

## A.8 — Bina (número que aparece pro lead)

Por padrão, a TotalVoice usa um número genérico. Para o lead **ver o número da clínica** quando o telefone toca:

1. No painel TotalVoice: **DIDs → Adquirir número**
2. Escolha um DDD da sua região (DDD 31 para Ipatinga)
3. Custo: ~R$ 25/mês
4. Copie o número (ex: `5531999991234`)
5. No `.env`: `TOTALVOICE_BINA=5531999991234`

Reinicie e pronto. Agora o lead vê o número da clínica e atende mais.

## A.9 — Cuidados

- ⚠️ Anti-spam: se ligar para muitos números rapidamente, operadoras podem bloquear sua bina. Use ritmo natural (1 ligação a cada 1-2 min)
- ⚠️ Horário: ligar fora do horário comercial gera reclamações
- ⚠️ Saldo zerado: ligações falham silenciosamente — configure alerta de saldo no painel

---

# Parte B — WhatsApp Cloud API (~2-7 dias, com burocracia da Meta)

⚠️ **Aviso de transparência**: essa parte é mais demorada porque a Meta exige verificação. Se você só quer **abrir conversa rápida**, pule pra Parte C (botão wa.me — funciona hoje, sem burocracia).

## B.1 — O que dá pra fazer com Cloud API

✅ Enviar mensagens pelo número oficial da clínica
✅ Receber respostas direto no CRM
✅ Automação: ao chegar lead, mensagem de boas-vindas dispara
✅ Templates: lembrete 24h antes da consulta, confirmação automática
✅ Mídia: enviar fotos do consultório, áudio, PDF de orçamento

❌ **Não dá pra fazer ligações de voz** (Meta ainda não libera essa API)

## B.2 — Pré-requisitos

1. **Conta Meta Business verificada** — precisa enviar documentos da empresa (CNPJ, comprovante)
2. **Número de telefone dedicado** — não pode estar em uso no WhatsApp normal nem no Business app
3. **Cartão de crédito** — pra cobranças (US$ 0,02-0,07 por mensagem ativa, depende do país)

## B.3 — Criar app no Meta for Developers

1. Acesse <https://developers.facebook.com>
2. Login com sua conta business
3. **Meus apps → Criar app**
4. Escolha **"Comercial"**
5. Nome: **"Clínica WhatsApp Bot"**
6. Email de contato: seu email
7. Conta empresarial: selecione a da clínica

## B.4 — Adicionar produto WhatsApp

1. No painel do app, role até "Adicionar produtos"
2. Clique em **"Configurar"** no card **"WhatsApp"**
3. Confirme a conta business
4. Você ganha um **número de teste** automaticamente (pode usar enquanto não verifica o número definitivo)

## B.5 — Pegar credenciais

1. No menu lateral: **WhatsApp → API Setup**
2. Copie:
   - **Phone number ID** (número de teste)
   - **Temporary access token** (válido por 24h)
3. Para token permanente:
   - Vá em **Configurações da empresa → Usuários → Usuários do sistema**
   - Crie um usuário admin
   - Gere token com permissão **`whatsapp_business_messaging`**

## B.6 — Configurar no CRM

### `.env`:
```
WHATSAPP_API_TOKEN=EAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
WHATSAPP_PHONE_NUMBER_ID=123456789012345
WHATSAPP_VERIFY_TOKEN=qualquer_string_aleatoria_que_voce_inventar
```

Reinicie servidor.

## B.7 — Testar envio

Use a aba **API Setup** do Meta para enviar a primeira mensagem:

1. Adicione **seu número pessoal** como destinatário de teste
2. Clique em **"Send message"**
3. Você recebe a mensagem `Hello World` no WhatsApp 🎉

## B.8 — Configurar webhook (recebe respostas do lead)

⚠️ Só funciona com URL pública (Easypanel em produção).

1. No painel Meta: **WhatsApp → Configuration → Webhooks**
2. URL de callback: `https://plataformaama-plataforma.uc5as5.easypanel.host/webhooks/whatsapp`
3. Verify token: cole o **mesmo** valor que está em `WHATSAPP_VERIFY_TOKEN`
4. Clique em **Verify and save**
5. Inscreva-se em **messages**

Agora quando um lead responder no WhatsApp, a mensagem aparece no CRM.

## B.9 — Criar templates (mensagens proativas)

Para enviar mensagem **sem o lead ter falado primeiro**, você precisa de templates aprovados pela Meta.

1. **WhatsApp Manager → Templates → Criar template**
2. Sugestões iniciais:

### Template 1: Boas-vindas
- Nome: `boas_vindas_clinica`
- Categoria: **Marketing** (mais barato) ou **Utility**
- Idioma: Português (BR)
- Conteúdo:
  ```
  Olá {{1}}! Aqui é da Clínica AMA. Recebemos seu interesse em conhecer nossos tratamentos. Quando podemos te ligar para uma avaliação?
  ```
- Variáveis: `{{1}}` = nome do lead

### Template 2: Lembrete de consulta
- Nome: `lembrete_consulta`
- Categoria: **Utility**
- Conteúdo:
  ```
  Oi {{1}}! Lembrete: sua avaliação está marcada para amanhã ({{2}}) às {{3}} na Clínica AMA. Confirme respondendo SIM ou REMARCAR.
  ```

3. Aguarde aprovação (24-48h normalmente)
4. Depois de aprovado, o CRM pode disparar via API

## B.10 — Custos reais (Brasil 2026)

| Tipo de conversa | Custo |
|---|---|
| Iniciada pelo lead (ele falou primeiro) | Grátis por 24h |
| Iniciada pela clínica — Marketing | ~R$ 0,30/conversa |
| Iniciada pela clínica — Utility | ~R$ 0,06/conversa |
| Iniciada pela clínica — Authentication | ~R$ 0,06/conversa |

**1.000 conversas/mês = ~R$ 60-300** dependendo do mix.

## B.11 — Verificar número definitivo

Quando estiver tudo funcionando com o número de teste, migre pro definitivo:

1. **WhatsApp → Phone Numbers → Add phone number**
2. Insira o número da clínica (não pode estar em WhatsApp pessoal/business app)
3. Verifique via SMS ou ligação
4. Pronto, agora é o número oficial

⚠️ Migração de número de WhatsApp Business app para Cloud API é **irreversível** sem perder o histórico. Use número novo se possível.

---

# Parte C — Atalho: botão wa.me (sem API, funciona hoje) ✅

Se você não quer encarar a burocracia da Meta agora, o CRM **já tem** um botão verde **💬 WhatsApp** dentro do modal do lead que **abre o WhatsApp Web** direto no número da pessoa.

Vantagens:
- ✅ Funciona sem nenhuma configuração
- ✅ Custo zero
- ✅ Funciona com seu WhatsApp Business app normal
- ✅ A SDR atende como sempre atendeu

Desvantagens:
- ❌ Não tem registro automático no CRM (você precisa anotar a manuscrito)
- ❌ Não tem disparo automático
- ❌ Não tem template de lembrete

**Recomendação**: comece com a Parte C (instantâneo). Quando o volume justificar, parta pra B.

---

# Parte D — Estratégia recomendada: combinação

A melhor estratégia para sua clínica é:

| Canal | Quando usar |
|---|---|
| **TotalVoice (ligação)** | Lead respondeu no WhatsApp mas sumiu — recuperação ativa |
| **WhatsApp wa.me** | Primeiro contato manual (atendimento humano da SDR) |
| **WhatsApp Cloud API** | Confirmações, lembretes 24h antes da consulta, follow-ups automáticos |
| **CAPI Meta** | Sempre — feedback de quem fechou para o algoritmo aprender |

**Sequência sugerida pra implementar:**

1. ✅ **Hoje**: CRM rodando local + botão wa.me funcionando (não custa nada)
2. ⚙️ **Esta semana**: ativar CAPI Meta (Guia 1) — CRM já está no Easypanel
3. 📞 **Semana 2**: ativar TotalVoice (Parte A) — discador real com gravação
4. 💬 **Mês 2**: WhatsApp Cloud API (Parte B) quando tiver volume justificando

---

# 🆘 Problemas comuns

## TotalVoice
| Problema | Solução |
|---|---|
| "Token inválido" | Reverifique copy/paste sem espaços |
| Ligação não chega | Confirme número com DDI: `5531987654321` (13 dígitos) |
| Lead não atende | Bina pode estar bloqueada — adquira DID local (Passo A.8) |
| Gravação não aparece | Webhook não chegou — confira config no Easypanel (Passo A.6) |
| Saldo zerado | Adicione crédito no painel + alerta automático |

## WhatsApp Cloud API
| Problema | Solução |
|---|---|
| Webhook não verifica | Token de verify precisa ser **idêntico** no Meta e no `.env` |
| Mensagem não chega | Lead precisa ter falado primeiro OU ser destinatário de teste autorizado |
| "Template not approved" | Aguarde 24-48h ou ajuste o conteúdo (Meta rejeita venda agressiva) |
| Token expirou | Você usou token temporário (24h) — gere o permanente (Passo B.5) |
| Number quality dropped | Está enviando muita mensagem fora do horário ou conteúdo inadequado — pause 24h |

---

# ✅ Checklist final

- [ ] TotalVoice: token configurado, primeira ligação de teste funcionou
- [ ] TotalVoice: webhook configurado no Easypanel (Passo A.6), gravação aparece no CRM
- [ ] WhatsApp wa.me: botão 💬 abre WhatsApp Web no número certo
- [ ] (Opcional) WhatsApp Cloud API: número de teste enviou Hello World
- [ ] (Opcional) Templates de boas-vindas e lembrete aprovados pela Meta

Quando tudo isso estiver verde, você tem um **CRM operacional completo** com tracking + telefonia + mensageria — todos integrados e seus.
