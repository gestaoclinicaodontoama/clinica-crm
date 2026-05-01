# 🚀 Guia 2 — Subir o CRM no Railway (nuvem)

## Por que subir pra nuvem

Hoje seu CRM roda **só no seu PC**. Quando você fecha o PowerShell, o sistema para. Subindo pra nuvem (Railway), você ganha:

- ✅ CRM rodando 24/7 sem precisar do PC ligado
- ✅ Acessar do celular, do consultório, de qualquer lugar
- ✅ URL pública (https://clinica-crm.up.railway.app) pra colocar nos anúncios
- ✅ Webhooks da TotalVoice e do Meta funcionam de verdade (eles precisam alcançar seu sistema pela internet)
- ✅ Backup automático do banco

## Custo: R$ 0 a R$ 25/mês

Railway tem créditos gratuitos. Para um CRM dessa escala (~100 leads/dia), provavelmente fica dentro do free tier, ou no máximo paga uns R$ 15-25/mês.

## Tempo estimado total: 60 minutos (na primeira vez)

---

# Pré-requisito: criar conta GitHub (~10 min, se não tiver)

GitHub é onde o código vai ficar guardado. Railway lê do GitHub e roda o sistema.

1. Acesse <https://github.com>
2. Clique em **"Sign up"**
3. Use seu email principal e crie uma senha forte
4. Confirme o email
5. Você não precisa configurar nada além disso por enquanto

---

# Parte 1: Subir o código no GitHub (~25 min)

## Opção A — Pelo navegador (mais simples, recomendada para você)

### Passo 1.1 — Criar repositório

1. No GitHub, clique no **"+"** no canto superior direito → **"New repository"**
2. Repository name: **`clinica-crm`**
3. Description: `CRM da clínica`
4. Marque **"Private"** (privado, só você vê)
5. NÃO marque "Add a README", "Add .gitignore" nem "Choose a license"
6. Clique em **"Create repository"**

### Passo 1.2 — Fazer upload dos arquivos

1. Na página do repositório recém-criado, você vai ver: **"uploading an existing file"** — clique nesse link
2. Abra a pasta `clinica-crm` no seu PC
3. Selecione **TODOS os arquivos** (Ctrl+A) — incluindo a subpasta `public`
4. ⚠️ **NÃO selecione** a pasta `node_modules` se ela existir (é gerada automaticamente)
5. ⚠️ **NÃO selecione** o arquivo `clinica.db.json` (banco local de teste)
6. ⚠️ **NÃO selecione** o arquivo `.env` (tem suas senhas — vai pelo Railway depois)
7. Arraste todos para a área de upload
8. Embaixo da página, em **"Commit changes"**:
   - Mensagem: `versão inicial`
9. Clique em **"Commit changes"**

Pronto! Seu código está no GitHub.

## Opção B — Via Git no terminal (avançado, pula se a A funcionou)

```bash
cd C:\caminho\para\clinica-crm
git init
git add .
git commit -m "versão inicial"
git remote add origin https://github.com/SEU_USUARIO/clinica-crm.git
git push -u origin main
```

---

# Parte 2: Criar conta no Railway (~5 min)

1. Acesse <https://railway.com>
2. Clique em **"Login"** → **"Login with GitHub"**
3. Autorize o Railway a acessar seu GitHub
4. Pronto, conta criada

---

# Parte 3: Fazer o deploy (~15 min)

## Passo 3.1 — Criar projeto

1. No painel do Railway, clique em **"New Project"**
2. Escolha **"Deploy from GitHub repo"**
3. Se for a primeira vez, clique em **"Configure GitHub App"**:
   - Escolha **"Only select repositories"**
   - Selecione **`clinica-crm`**
   - Clique em **"Install"**
4. Volte ao Railway, clique em **`clinica-crm`**

## Passo 3.2 — Configurar variáveis de ambiente

O Railway está tentando rodar, mas o `.env` não foi enviado (e nem deveria — segredos nunca vão pro GitHub). Vamos colar manualmente:

1. No projeto, clique em **"Variables"** (no menu lateral)
2. Clique em **"Raw Editor"** (ou "+ New Variable" várias vezes)
3. Cole isto e ajuste com seus valores:

```
PORT=3000
WHATSAPP_NUMBER=5531987654321

META_PIXEL_ID=
META_ACCESS_TOKEN=

TOTALVOICE_TOKEN=
TOTALVOICE_BINA=

WHATSAPP_API_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=

GOOGLE_CONVERSION_NAME=Tratamento Fechado
```

4. Salve

> Pode deixar em branco os que ainda não tem (CAPI, TotalVoice, WhatsApp). Vai funcionar do mesmo jeito — só os recursos que dependem deles que ficam desativados.

## Passo 3.3 — Aguardar build

1. Volte na aba **"Deployments"**
2. Aguarde o build terminar (~3 min) — vira verde quando concluir
3. Se aparecer vermelho, clique no deploy → **"Build Logs"** → me mande print

## Passo 3.4 — Pegar a URL pública

1. Vá em **"Settings"**
2. Role até **"Networking"** → **"Public Networking"**
3. Clique em **"Generate Domain"**
4. Sua URL pública aparece, ex: **`clinica-crm-production.up.railway.app`**
5. Acesse essa URL no navegador → o CRM deve abrir!

---

# Parte 4: Persistir o banco de dados (~10 min) ⚠️ IMPORTANTE

Aqui tem uma pegadinha: por padrão, o Railway **apaga o banco a cada deploy** porque o arquivo `clinica.db.json` fica no sistema de arquivos efêmero. Vamos corrigir adicionando um **volume persistente**.

## Passo 4.1 — Adicionar volume

1. No projeto Railway, vá em **"Settings"** do seu serviço
2. Role até **"Volumes"**
3. Clique em **"+ Volume"**
4. Mount path: `/data`
5. Salve

## Passo 4.2 — Atualizar variável

1. Vá em **"Variables"**
2. Adicione/edite:
```
DB_PATH=/data/clinica.db.json
```
3. Salve

O Railway vai reiniciar automaticamente. Agora o banco fica persistente.

---

# Parte 5: Configurar webhooks externos (~10 min)

Agora que tem URL pública, os serviços externos podem mandar dados pra dentro do CRM.

## TotalVoice

1. Acesse o painel da TotalVoice
2. Vá em **Configurações → Webhooks**
3. Cole: `https://SUA-URL.up.railway.app/webhooks/totalvoice`
4. Selecione eventos: **"Chamada finalizada"** + **"Gravação disponível"**
5. Salve

## WhatsApp Cloud API (se for usar)

1. No painel Meta Business → **Configurações do Webhook**
2. URL de callback: `https://SUA-URL.up.railway.app/webhooks/whatsapp`
3. Token de verificação: o mesmo `WHATSAPP_VERIFY_TOKEN` do `.env` Railway
4. Inscreva-se nos eventos: **messages**, **message_status**

## Meta Pixel

Não precisa webhook para CAPI — ele apenas envia eventos. Já está funcionando.

---

# Parte 6: Atualizar links dos anúncios

Agora que o CRM tem URL pública, troque nos seus anúncios:

**Antes:**
```
http://localhost:3000/lead?utm_source=meta...
```

**Agora:**
```
https://clinica-crm-production.up.railway.app/lead?utm_source=meta...
```

No CRM, vá em **Configurações** e troque a "URL base do sistema" pelo seu domínio Railway. Os links abaixo já vão estar atualizados.

---

# 🔄 Como atualizar o sistema no futuro

Quando eu te entregar uma versão nova do código:

## Opção rápida (pelo navegador)

1. Vá no repositório no GitHub
2. Clique no arquivo que mudou (ex: `server.js`)
3. Clique no lápis (Edit)
4. Apague tudo, cole o novo código, commit
5. O Railway detecta automaticamente e faz deploy em ~3 min

## Opção em lote

1. Vá no repositório no GitHub
2. Clique em **"Add file"** → **"Upload files"**
3. Arraste os novos arquivos (eles substituem os antigos)
4. Commit
5. Railway faz deploy automático

---

# 💰 Como controlar custos

1. No Railway, vá em **"Usage"**
2. Veja quanto está gastando por mês
3. Configure um **alerta de uso** em $5/$10
4. Se passar do free tier (~$5 grátis), aparece a opção de adicionar cartão

Para o seu volume (~100 leads/dia, ~10MB de banco), você provavelmente fica **abaixo do free tier**.

---

# 🆘 Problemas comuns

| Problema | Solução |
|---|---|
| Build falhou (vermelho) | Verifique se `package.json` foi enviado pro GitHub |
| URL aberta mas tela branca | F12 → Console → me mande print do erro |
| "Cannot connect to database" | Confirme que adicionou o volume e o `DB_PATH=/data/clinica.db.json` |
| Webhook não chega | A URL pública precisa começar com `https://` (não `http://`) |
| Perdi os leads ao fazer deploy | Você esqueceu o volume — siga Parte 4 e refaça |

---

# ✅ Checklist final

Antes de declarar "pronto":

- [ ] CRM acessível em `https://...railway.app`
- [ ] Login feito do celular funciona
- [ ] Toggle dark/light funciona
- [ ] Criar lead via URL com UTMs salva no banco
- [ ] Lead persiste mesmo após redeploy (volume OK)
- [ ] WhatsApp abre quando clica no botão 💬
- [ ] Anúncios atualizados com a URL nova

Marcou tudo? **Sistema na nuvem oficialmente operacional!** 🎉
