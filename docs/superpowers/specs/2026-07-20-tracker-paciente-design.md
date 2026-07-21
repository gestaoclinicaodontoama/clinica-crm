# Entrega ④ — Tracker do Paciente — Design

**Data:** 2026-07-20. Fecha a série do Modo de Planejamento (①②③ no ar). Alimentada por `plano_tratamento`/`plano_itens`/`plano_etapas` (① e ②) e `agenda_appointments`.

## Objetivo
O paciente acompanha o próprio tratamento por um **link público tokenizado** (sem login, mobile-first). Caso motivador: protocolo de ~6 meses — o paciente espera ansioso e hoje não enxerga nada entre as sessões.

## Decisões (Luiz, 20/07)
- **Conteúdo:** procedimentos + barra de progresso; datas das sessões feitas; próxima consulta agendada; nome do dentista executor.
- **Nunca aparece:** valores/financeiro (valor, entrada, parcelas, inadimplência). Também ficam fora — por serem comunicação interna dirigida à equipe, não conteúdo ao paciente: `orientacao_clinica` e `recado_sucesso`.
- **Entrega do link:** CRC copia e cola no WhatsApp (botão em `/trilhas/`). Envio automático = fase 2.
- **Token:** permanente até revogar; gestora pode regenerar (link antigo morre).

## Abordagem
**Página renderizada pelo servidor** em `GET /t/:token` — sem API JSON pública, sem fetch no cliente. Uma rota, HTML montado no Express com `esc()` em toda interpolação. (Rejeitada a alternativa página estática + endpoint JSON público: mais superfície de ataque sem ganho.)

## Dados — 1 migração
```sql
ALTER TABLE public.plano_tratamento ADD COLUMN IF NOT EXISTS tracker_token text;
ALTER TABLE public.plano_tratamento ADD COLUMN IF NOT EXISTS tracker_revogado_em timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS idx_plano_tracker_token ON public.plano_tratamento(tracker_token) WHERE tracker_token IS NOT NULL;
```
Sem tabela nova (RLS já ligada em `plano_tratamento`). Token gerado no servidor: `crypto.randomBytes(24).toString('base64url')` (32 chars). Aplicar via MCP (project `mtqdpjhhqzvuklnlfpvi`); arquivo `.sql` casando a version retornada pelo `list_migrations`.

## Rota pública — `GET /t/:token`
⚠️ **Ordem de registro (CRÍTICO):** o server tem um **catch-all da SPA** (`app.get(/^\/(?!api\/|lead...|webhooks\/|track\.js).*/)` logo após o `express.static`, server.js ~8300-8303) que casaria `/t/<token>` e serviria a tela de login. A rota `GET /t/:token` **DEVE ser registrada antes do `express.static`/catch-all** — colocar no bloco do planejamento (~5000-5600), nunca no fim do arquivo. Conferir com grep que a linha da rota vem antes da ~8300. Não conflita com o `POST /t` do pixel (server.js ~9913 — métodos diferentes).

Middlewares: **apenas `rateLimit`** (é por IP — 60 req/min; `trust proxy` já ativo no server ~270, então `req.ip` é o IP real do cliente atrás do Easypanel — sem risco de limite compartilhado; sem `requireAuth` por definição). Headers: `X-Robots-Tag: noindex, nofollow` + `Cache-Control: no-store` + `<meta name="robots" content="noindex">` no HTML.

Fluxo:
1. Valida formato do token (`/^[A-Za-z0-9_-]{20,64}$/`); inválido → página neutra.
2. Busca `plano_tratamento` por `tracker_token` com `tracker_revogado_em IS NULL`. Não achou, OU `status IN ('descartado','cancelado')` → **página neutra** "Link inválido ou tratamento não disponível — fale com a clínica" (HTTP 200, sem vazar se o token existe).
3. Carrega itens raiz ativos (`removido_em IS NULL`) com etapas (próprias e de sub-lotes filhos, agregadas no procedimento raiz), ordenados por `ordem`.
4. Próxima consulta: `agenda_appointments` por `paciente_clinicorp_id`, `appointment_date >= hoje (America/Sao_Paulo)`, `deleted = false`, ordenado por `appointment_date, from_time`, primeira linha. (NÃO filtrar `compareceu` — agendamento futuro ainda não compareceu.)
5. Renderiza a página.

## Página (mobile-first, tema claro simples, logo/nome da clínica)
- **Cabeçalho:** "Olá, {primeiro nome}!" — primeiro nome extraído de `paciente_nome` com regex **exata de sufixo-id no FIM**: `.replace(/\s*\(\d+\)\s*$/, '')` e depois primeiro token (padrão real: `"Jeysa Vanessa Rocha Magalhaes Reis (10551)"` → `Jeysa`; nomes SEM sufixo existem — inclusão manual pela Sucesso grava sem "(id)" — e parênteses não-numéricos no meio não podem ser cortados). Subtítulo "Acompanhe seu tratamento na Clínica AMA".
- **Barra de progresso geral:** `% = etapas concluídas ÷ (todas as etapas + itens raiz ativos sem nenhuma etapa)` — item sem etapa conta como 1 unidade pendente (mesma filosofia do fix "temItemSemEtapa": procedimento não detalhado ≠ concluído). Plano `concluido` → 100% + mensagem de parabéns.
- **Lista de procedimentos** (ordem de execução):
  - Status do procedimento: ✅ **Concluído** (≥1 etapa e todas concluídas) · 🔵 **Em andamento** (≥1 concluída, restam pendentes) · ⚪ **A fazer** (0 concluídas).
  - **Executor:** `plano_itens.profissional_executor`; vazio → nome do dentista responsável do plano (via `planejamento_dentistas`, mesmo lookup determinístico do endpoint executar); ambos vazios → omite a linha.
  - **Sessões feitas:** cada etapa concluída vira uma linha "descrição — dd/mm/aaaa" (`concluida_em` em America/Sao_Paulo). Etapa sintética (descrição = nome do procedimento) vira só "Realizado em dd/mm/aaaa". Etapas pendentes NÃO são listadas (só contam no total) — não expor o passo-a-passo técnico futuro.
  - **Decisão explícita (Luiz):** a `descricao` da etapa concluída aparece como está — na pergunta de privacidade foi oferecida a opção "paciente vê só o procedimento, não as etapas técnicas" e NÃO foi escolhida. Consequência operacional: quem digita descrição de etapa deve saber que etapa concluída é visível ao paciente (a sensível de verdade vive em `orientacao_clinica`, que nunca aparece).
- **Próxima consulta:** "📅 Sua próxima consulta: dd/mm às HH:MM" (ou seção omitida se não houver).
- **Rodapé:** telefone/WhatsApp da clínica (constante no template) + "Dúvidas? Fale com a gente".
- **Nunca renderiza:** valores, `orientacao_clinica`, `recado_sucesso`, nomes de ASB, ids internos.
- `esc()` em TODA interpolação (nomes vêm do Clinicorp = dado externo).

## API interna — gerar/copiar/regenerar
`POST /api/planejamento/plano/:id/tracker-link` — `requireAuth` → `blockParceiro` → `requireRole('crc_sucesso','gestor','admin','mod_planejamento','dentista')` → `rateLimit`.
- Body `{ acao?: 'regenerar' | 'revogar' }` — as duas ações só para `gestor`/`admin` (403 amigável para os demais). Sem `acao` = copiar.
- **Copiar** (default): `tracker_token IS NULL` (primeira emissão) → gera (`randomBytes(24).base64url`); com token vivo → devolve o existente (idempotente). **Se revogado → 409 "link revogado — peça à gestora para regenerar"** (revogação é PEGAJOSA: copiar nunca ressuscita link morto — o caso de uso do revogar é reclamação/LGPD/link errado circulando, e uma CRC desavisada não pode desfazê-lo sem querer).
- **`regenerar`** (gestor/admin): sempre gera token novo e zera `tracker_revogado_em` — é o ÚNICO caminho que ressuscita um plano revogado (ato deliberado).
- **`revogar`** (gestor/admin, matar sem reemitir): seta `tracker_revogado_em = now()` e mantém o token (o filtro `tracker_revogado_em IS NULL` da rota pública o mata). Retorna `{ revogado: true }` sem URL.
- Plano `descartado`/`cancelado` → 409 "tratamento não ativo".
- Retorna `{ url: 'https://plataformaama-plataforma.uc5as5.easypanel.host/t/<token>' }` (base = `APP_BASE_URL` do env se existir; senão o host da requisição).
- ⚠️ Registrar ANTES da rota genérica `POST /api/planejamento/plano/:id/:acao` (mesma armadilha do `executar` — Express casa na ordem; conferir com grep).

## UI
1. **`/trilhas/`** (tabela do script inline de `public/trilhas/index.html`): botão **"🔗"** por linha (title "Copiar link de acompanhamento do paciente") → chama a API → `navigator.clipboard.writeText(url)` → toast/alert "Link copiado — cole no WhatsApp do paciente". Fallback se clipboard bloqueado: `prompt('Copie o link:', url)`. ⚠️ O `api()` do `public/js/trilhas/app.js` é IIFE (escopo privado) — o botão da tabela usa o **fetch/token do próprio script inline** do index.html (que já faz chamadas autenticadas).
2. **Modal Planejar** (`editor.js`): no rodapé, link discreto **"🔗 link do paciente"** (mesma chamada, copia); para `gestor`/`admin`, "regenerar" e "revogar" ao lado (confirm em ambos: "O link atual vai parar de funcionar. Continuar?"). O front não sabe as roles → mostra sempre e trata o 403 amigável no clique (padrão do modal).

## Segurança / LGPD
- Token 32 chars aleatórios (base64url) — inviável enumerar; rate limit por IP na rota pública limita tentativa.
- Página expõe SÓ o plano daquele token; nenhum outro paciente, nenhum id interno, nenhum financeiro.
- `noindex` + `no-store`; sem cookies, sem sessão, sem JS de dados.
- Quem tem o link vê — aceito pelo Luiz (modelo "link de acompanhamento", igual rastreio de encomenda); revogação disponível.
- Nada de tabela nova; escrita só via `/api` autenticada (service_role no servidor).
- **Seleção explícita de colunas** na rota pública (nunca `select('*')` em `plano_tratamento`): só `id, status, paciente_nome, paciente_clinicorp_id, dentista_avaliador_id, tracker_revogado_em` — `valor`/`orientacao_clinica`/`recado_sucesso` nem chegam à memória da rota (defesa em profundidade contra vazamento acidental).

## Fora de escopo
- Envio automático via WhatsApp (template Meta) — fase 2.
- NPS em marcos (backlog ligado; o tracker fornece os marcos).
- Tracker multi-plano / histórico de planos antigos (1 link = 1 plano ativo).
- Escrita na ficha Clinicorp (robô).

## Testes
- **Unit:** cálculo do progresso (com sintética, com item sem etapa, plano concluído = 100%); extração do primeiro nome (com/sem sufixo "(id)", nome vazio).
- **Manual:** 1) copiar link no /trilhas/ e abrir aba anônima no celular — página carrega sem login; 2) valor não aparece em lugar nenhum (view-source); 3) marcar etapa → recarregar tracker → progresso sobe; 4) regenerar (gestora) → link antigo mostra página neutra e o novo funciona; 5) **revogar** → link mostra página neutra; "copiar" (CRC) depois → 409 "peça à gestora"; só "regenerar" (gestora) reemite e o novo funciona; 6) plano cancelado → página neutra; 7) token inventado → página neutra + 429 após rajada; 8) próxima consulta bate com a agenda; 9) CRC (sem role gestor) tenta regenerar/revogar → 403 amigável.
