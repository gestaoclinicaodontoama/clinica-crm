# 🎯 Guia 1 (atualizado) — CAPI WhatsApp já está pronto!

## ✅ O que já está configurado pelo Manus

| Item | Status |
|---|---|
| Pixel ID (Dataset) | ✅ `904146029308947` |
| Token CAPI permanente | ✅ Já no `.env` do projeto |
| Page ID Dr. Marcos Vinicius | ✅ `106183378976777` |
| Suporte a `ctwa_clid` (WhatsApp CTWA) | ✅ Implementado no servidor |
| Suporte a `fbclid` (anúncios web) | ✅ Implementado no servidor |
| Disparo automático no funil | ✅ 4 eventos configurados |

**Tudo isso já está dentro do `.env` e do `server.js`. Você só precisa fazer 2 coisas pra ativar.**

---

## 🎯 Eventos enviados pra Meta automaticamente

A cada mudança de status no CRM, o sistema dispara o evento certo:

| Status no CRM | Evento Meta | O que a Meta faz |
|---|---|---|
| Lead | `LeadSubmitted` | Aprende quem entra no funil |
| Agendado | `Schedule` | Otimiza para quem agenda |
| Compareceu | `Contact` | Otimiza para quem comparece |
| Em Avaliação | (sem evento) | Etapa interna |
| Orçamento Enviado | (sem evento) | Etapa interna |
| **Fechou** | **`Purchase` com valor R$** | 🎯 **Otimização principal** — busca lookalikes |
| Perdido | (sem evento) | — |

Cada evento dispara **uma única vez por lead** — sem duplicação.

---

## 🚀 Passo 1 — Testar antes de usar valendo (~10 min)

### 1.1 — Pegar código de Test Events

1. Acesse: <https://business.facebook.com/events_manager2/list/dataset>
2. Clique no Dataset **`904146029308947`**
3. Menu lateral → **"Eventos de teste"** (Test Events)
4. Você verá um **código de teste** no formato `TEST12345`
5. **Copie esse código**

### 1.2 — Adicionar no `.env`

Abra o arquivo `.env` na pasta `clinica-crm` e adicione:

```
META_TEST_EVENT_CODE=TEST12345
```

(substituindo pelo seu código real)

### 1.3 — Reiniciar o servidor

```
Ctrl+C
npm start
```

### 1.4 — Disparar evento de teste

Abra o navegador e visite (simula um anúncio CTWA):
```
http://localhost:3000/lead?name=Maria%20Teste&phone=5531987654321&utm_source=meta&utm_campaign=teste_capi&ctwa_clid=ARDfTeste123
```

Você será redirecionado pro WhatsApp. Volte ao CRM e:

1. Acesse <http://localhost:3000>
2. Clique no lead "Maria Teste"
3. Mude status para **Agendado** → Salvar
4. Mude status para **Compareceu** → Salvar
5. Mude status para **Fechou** → preencha valor `8500` → Salvar

### 1.5 — Confirmar no Meta

1. Volte para **Events Manager → Eventos de teste**
2. Em até 30 segundos, devem aparecer **3 eventos** seguidos:
   - `Schedule` (origem: Conversões da empresa via WhatsApp)
   - `Contact`
   - `Purchase` com valor R$ 8.500
3. **Match quality** deve aparecer 3+ estrelas (porque enviamos telefone + nome + email + ctwa_clid)

✅ **Funcionou? Você está oficialmente rastreando o funil completo!**

### 1.6 — Remover o test code (ativar valendo)

1. Edite o `.env` e **apague** a linha `META_TEST_EVENT_CODE=...` (ou deixe vazia)
2. Reinicie o servidor
3. Pronto — agora os eventos vão **valendo** pro algoritmo da Meta

---

## 🚀 Passo 2 — Capturar `ctwa_clid` dos seus leads reais

Aqui está a parte que precisa de uma decisão sua. Existem 2 caminhos:

### 🅰️ Caminho rápido (sem WhatsApp Cloud API)

**Como funciona:** o lead vem pelo link do CRM (`http://seu-dominio/lead?...`) e o `ctwa_clid` precisa estar na URL.

Mas o problema é: **a Meta NÃO coloca o `ctwa_clid` na URL** automaticamente quando o anúncio leva pro WhatsApp. Esse código só é enviado **via webhook** depois que o lead manda mensagem.

**Solução temporária**: use `fbclid` no link (anúncio Meta direto pro CRM antes de ir pro WA):

```
https://seu-dominio/lead?utm_source=meta&utm_campaign=NOME&fbclid={{fbclid}}
```

A Meta substitui `{{fbclid}}` automaticamente. Aí o sistema usa `fbclid` em vez de `ctwa_clid` — ainda funciona, mas com **match quality um pouco menor**.

### 🅱️ Caminho ideal (com WhatsApp Cloud API)

Para capturar o `ctwa_clid` real dos anúncios Click-to-WhatsApp:

1. Configurar **WhatsApp Cloud API** (ver Guia 3 — leva 2-7 dias por causa da verificação Meta)
2. Apontar webhook: `https://seu-dominio/webhooks/whatsapp`
3. Quando lead manda primeira mensagem, o webhook recebe:

```json
{
  "messages": [{
    "from": "5531987654321",
    "referral": {
      "ctwa_clid": "ARDfCtwaIdReal987654",
      "source_id": "anuncio_id_meta",
      "source_url": "https://fb.me/...",
      "headline": "Implante dentário com 50% off"
    }
  }]
}
```

4. O sistema **automaticamente** salva esse `ctwa_clid` no lead correspondente
5. Quando o lead fechar, o CAPI dispara `Purchase` com `ctwa_clid` real → match quality 4-5 estrelas

**Recomendação**: comece com o **Caminho A (fbclid)** essa semana e migre para o **Caminho B** quando ativar o WhatsApp Cloud API.

---

## 📊 Passo 3 — Acompanhar resultados (após 2-4 semanas)

### Onde olhar

1. **Events Manager** → Dataset `904146029308947` → Visão geral
   - Veja quantos eventos por dia (Schedule, Contact, Purchase)
   - Match quality médio (precisa estar > 3 estrelas)

2. **Gerenciador de Anúncios** → Suas campanhas
   - A coluna **Conversões** agora mostra `Purchase`
   - Custo por conversão começa a fazer sentido

### Quando configurar otimização avançada

Quando tiver **30+ eventos `Purchase` reais**:

1. No conjunto de anúncios, troque otimização de **"Lead"** para **"Purchase"**
2. Crie **público lookalike** baseado em `Purchase`:
   - Públicos → Criar → Semelhante
   - Origem: pessoas que dispararam `Purchase`
   - Tamanho: 1% (mais qualificado)

**Resultado esperado em 60 dias**: CAC cai 30-50% porque o algoritmo busca pessoas com perfil parecido com seus **fechadores reais**, não com qualquer um que clica.

---

## 🧪 Como saber se está realmente funcionando

| Sinal | O que verificar |
|---|---|
| ✅ Eventos chegando | Events Manager → últimas 24h tem `Schedule`, `Contact`, `Purchase`? |
| ✅ Match quality > 3⭐ | Na visão geral, cada evento mostra estrelas |
| ✅ Sem duplicação | Mesmo lead não aparece 2x no mesmo evento |
| ✅ Page ID correto | No detalhe do evento, deve mostrar Dr. Marcos Vinicius - AMA |
| ✅ Valor preenchido | Eventos `Purchase` mostram R$ correto |

---

## 🆘 Problemas comuns

| Problema | Solução |
|---|---|
| "Meta CAPI ✗" no console | Token expirou — gere novo no Events Manager |
| Match quality < 2⭐ | Falta dados — confirme que está enviando telefone E email do lead |
| Eventos não aparecem | Verifique se `META_TEST_EVENT_CODE` está vazio (em produção) |
| `ctwa_clid` aparece como vazio | Lead veio antes do WhatsApp Cloud API estar ativo — normal |
| Valor zerado no Purchase | Você esqueceu de preencher o valor antes de marcar Fechou |
| Eventos duplicados | Não acontece — sistema controla via `eventos_meta_enviados` |

---

## ⚠️ Cuidados importantes

1. **Token é sensível** — nunca compartilhe. Se vazar, regere no Events Manager
2. **Não envie eventos fake** — Meta detecta e penaliza match quality
3. **Não dispare CAPI em testes** sem o `test_event_code` — polui suas métricas
4. **Page ID `106183378976777`** está fixo no `.env` — se mudar a página principal da clínica, atualize

---

## ✅ Checklist final

- [ ] Test event code adicionado no `.env`
- [ ] Servidor reiniciado
- [ ] Lead de teste criado com ctwa_clid simulado
- [ ] 3 eventos chegaram em Test Events (Schedule, Contact, Purchase)
- [ ] Match quality 3+ estrelas
- [ ] Test event code removido do `.env`
- [ ] Servidor reiniciado novamente
- [ ] Anúncios Meta atualizados com link `?utm_source=meta&fbclid={{fbclid}}`

Se marcou tudo, **CAPI está oficialmente vivo**. 🎉

---

## 📜 Para referência: o script Python do Manus

O Manus te entregou o `meta_capi_whatsapp_funnel.py` — esse arquivo é **uma alternativa** se você quiser disparar eventos manualmente do Python, sem passar pelo CRM.

**Você não precisa dele** — o CRM Node.js já faz tudo automaticamente quando muda o status do lead. Mas guarde como backup pra debug ou disparo manual.

Para usá-lo isolado:
```bash
pip install requests
python -c "from meta_capi_whatsapp_funnel import send_meta_event; print(send_meta_event('Purchase', ctwa_clid='TESTE', value=100, test_code='TEST12345'))"
```
