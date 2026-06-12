# Avaliação Dentista "amarradinha" — Design

**Data:** 2026-06-12
**Módulo:** `/avaliacao-dentista/` (Copiloto SPIN)
**Status:** aprovado pelo usuário, pronto para virar plano de implementação

## Problema

O módulo de avaliação dos dentistas está pouco prático e gera avaliações "órfãs":

- Dentistas gravam a consulta **fora da plataforma** (gravador do celular) e o **upload do arquivo falha** ("deu problema", sem detalhe). O gestor então recebe o áudio (em geral via WhatsApp) e sobe pela própria conta.
- Quando o gestor sobe, a avaliação fica atribuída a ele, **sem dentista, sem paciente e sem data** da consulta.
- Hoje o paciente é digitado em campo de texto livre (`paciente_vinculado=false`), nada é amarrado.
- Resultado: o **Histórico** vira uma lista solta e inútil, sem como filtrar por dentista/data.

Causa raiz: **falta de amarração** (dentista + paciente + data) + **gravação/upload instável**. Pista do upload: se fosse só tamanho, falharia para o gestor também — mas o arquivo que chega ao gestor via WhatsApp já vem recomprimido/reformatado, por isso funciona. Suspeita a confirmar: formato `.m4a` do gravador do celular e/ou limite de tamanho/timeout no servidor.

## Objetivo

Tornar o fluxo "amarradinho": toda avaliação nasce vinculada a **paciente + dentista + data + agendamento**, com gravação ao vivo como padrão e upload consertado como plano B. Acabar com avaliações órfãs e fazer o Histórico funcionar.

## Escopo (fluxo C aprovado)

Gravar ao vivo como padrão + upload arrumado como plano B.

### 1. Paciente presente (coração da mudança)

- Ao abrir o Copiloto, o dentista vê **a agenda dele de hoje** (Clinicorp), com pacientes que já têm **check-in destacados como "🟢 Presente"**.
- Um toque em "Iniciar consulta" no card do paciente começa a gravação já vinculada a **paciente + dentista + data + agendamento**. Zero digitação.
- Botão **"Atualizar"** recarrega a agenda (padrão de UX dos demais módulos Clinicorp — ver memória do botão de sync).
- O campo de nome manual continua existindo como **exceção** (paciente fora da agenda), não como padrão.

### 2. Identificação do dentista (mapeamento login ↔ Clinicorp)

- Criar mapeamento **usuário do CRM ↔ `Dentist_PersonId` do Clinicorp**. Hoje são **dois avaliadores**: Marcos-Avaliação `5757301300985856` e Matheus G.-Avaliação `6576596377468928`.
- Configurável pelo admin (tela/config simples), para suportar novos dentistas no futuro.
- Toda avaliação passa a gravar **dentista, paciente e data da consulta** — inclusive quando o **gestor** sobe o áudio: a tela de upload pede dentista, paciente (da agenda daquele dia) e data. Acaba a avaliação órfã.

### 3. Upload consertado (plano B)

- **Primeiro investigar a causa real** com logs (primeira tarefa do plano). Teste com `.m4a` grande real (30–60 min).
- Aceitar formatos comuns de gravador: `m4a`, `opus`, `mp3`, `wav` (e o que mais aparecer).
- Converter no servidor com **ffmpeg** quando necessário (ffmpeg já é usado no projeto para áudio de WhatsApp).
- **Barra de progresso** e **mensagem de erro clara** (fim do "deu problema").
- Revisar limites de tamanho/timeout do Express/proxy para suportar consulta inteira.

### 4. Histórico que funciona

- Com as avaliações amarradas, o Histórico ganha colunas **Dentista / Paciente / Data** e filtros por **dentista** e **período**.
- Avaliações antigas órfãs continuam visíveis, marcadas como **"sem vínculo"**.
- **Atribuição manual das antigas:** no Histórico, uma avaliação órfã pode ser atribuída — o gestor/admin escolhe dentista, paciente e data e a avaliação deixa de ser órfã. Permite limpar o histórico legado aos poucos.

## Fora do escopo

- Mudanças no **coaching SPIN** em si e no **Dashboard** — o usuário não reclamou deles. Mexer apenas se aparecerem bugs no caminho.

## Notas técnicas / pontos de partida

- Frontend do módulo: `public/avaliacao-dentista/` + `public/js/avaliacao-dentista/` (copiloto.js, historico.js, dashboard.js, api.js, main.js, state.js, ui.js, coaching.js).
- Backend: rotas `/api/avaliacoes/*` em `server.js`; transcrição via Deepgram (`lib/deepgram`); ffmpeg já presente.
- Config existente: tabela `avaliacao_dentista_config`. Avaliadores em `DENTISTAS_AVALIACAO` (server.js).
- Dados do Clinicorp já sincronizados na tabela `avaliacoes` com `CheckinTime` e `Dentist_PersonId` — base para "paciente presente" e para o mapeamento do dentista.
- Endpoint de agenda do dia: reaproveitar o `/appointment/list` do Clinicorp já usado pelo sync (filtra por dentista + data + check-in).
- Roles: `dentista`, `admin`, `mod_avaliacao_dentista` (Copiloto); `gestor`/`crc_comercial` no Histórico/Dashboard.

## Critérios de sucesso

1. Dentista abre o módulo, vê seu paciente "Presente" e inicia a gravação sem digitar nada.
2. Toda avaliação nova tem dentista + paciente + data + agendamento vinculados (gravação ao vivo OU upload).
3. Upload de `.m4a` grande funciona; em caso de falha, erro claro na tela.
4. Histórico filtra por dentista e período e mostra Dentista/Paciente/Data.
5. Nenhuma avaliação nova fica órfã.
6. Avaliações antigas órfãs podem ser atribuídas manualmente (dentista + paciente + data) pelo gestor/admin.
