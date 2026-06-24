# Módulo Públicos (Sub-projeto 1) — Design

**Data:** 2026-06-24
**Autor:** Luiz + Claude
**Status:** Aprovado (aguardando revisão da spec)
**Relacionados:** [[project_disparo_em_massa]] (Fase 2 = segmentação), [[project_disparo_seletor_numero]] (reusa o disparo+seletor de número), reestruturação `2026-06-23-crm-reestruturacao-leads-agentes-design.md` (Oportunidade.tratamento estruturará o interesse no futuro)

## Problema

Para disparar uma campanha hoje, a lista de contatos é montada **na mão** (consultas SQL
cruzando "mencionou o tratamento na conversa / clicou no anúncio dele"). Não há nada no CRM
que deixe o usuário **selecionar um público pela base e disparar**. O `tipo_trat` está quase
todo vazio, então "interesse" não é um campo pronto — precisa ser derivado.

## Escopo (Sub-projeto 1)

Módulo **Públicos** (`/publicos/`): construtor de filtros → preview ao vivo → salvar a regra
(dinâmico) → **Disparar** (reusando o Disparo em Massa + seletor de número) ou **Exportar CSV**.

**Fora de escopo (Sub-projeto 2, spec própria):** congelar/snapshots versionados de um público;
"salvar como interesse X" (tagging que estrutura a base); públicos como fonte das réguas de
automação. O modelo de dados aqui **não impede** essas extensões.

## Decisões (do brainstorm)

| Tema | Decisão |
|------|---------|
| Origem do "interesse" | Camadas: busca ao vivo agora (Sub-proj 1); tagging depois (Sub-proj 2) |
| Onde fica | Módulo próprio `/publicos/` com públicos salvos |
| Público salvo | **Regra (dinâmico)** — recalcula sempre; congelar fica pro Sub-proj 2 |
| Filtros | As 4 dimensões: interesse (texto/anúncio/**origem**), status+período, DDD/origem, engajamento WhatsApp |
| Saídas | Disparar (reusa disparo+número) + Exportar CSV |

## Correção importante: `origem` já carrega o interesse

O campo `leads.origem` é mais estruturado do que parecia: tem valores como
`Facebook - Invisalign`, `Instagram - Invisalign`, `Google Invisalign`, `Site da Invisalign`,
`Leads Antigos - Invisalign`. Então o filtro de **interesse** combina **3 sinais** (OR):
`origem ILIKE '%termo%'` **+** `mensagens.texto ILIKE '%termo%'` **+** `referral_data::text ILIKE '%termo%'`.
Isso captura muito mais e mais confiável do que só texto da conversa.

## Modelo de dados (1 tabela nova)

### `publicos`
| Coluna | Tipo | Notas |
|--------|------|-------|
| id | bigserial PK | |
| nome | text | nome do público |
| regra | jsonb | os filtros (ver schema abaixo) |
| criado_por | uuid | id do usuário |
| criado_em | timestamptz | default now() |
| atualizado_em | timestamptz | default now() |

### Schema da `regra` (jsonb)
Todas as chaves são **opcionais**; ausente/null/[] = "não filtra por isso".
```json
{
  "interesse": { "termo": "invisalign", "em": ["origem","conversa","anuncio"] },
  "status": ["Lead","Nutrir","Em conversa - Lead Qualificado"],
  "periodo": { "campo": "criado_em", "dias": 30 },
  "ddd": ["31"],
  "origem": ["Facebook - Invisalign"],
  "engajamento": {
    "respondeu": true,
    "ultima_interacao_dias": 30,
    "janela24h": false,
    "recebeu_campanha_id": null
  }
}
```
- `interesse.em` default = `["origem","conversa","anuncio"]` (todos). Com `termo` presente, casa se
  **qualquer** fonte selecionada bater.
- `periodo.campo` ∈ {`criado_em`} (Sub-proj 1 usa só `criado_em` — `data_lead` é não-confiável, ver [[project_disparo_seletor_numero]] contexto).
- `engajamento.respondeu`: `true` (tem mensagem recebida) / `false` (nunca respondeu) / null (ignora).
- `engajamento.janela24h`: `true` (última recebida < 24h) / null.
- `engajamento.recebeu_campanha_id`: filtra quem **recebeu** disparo daquela campanha (status `enviado`); null = ignora.

## Motor de matching (a peça crítica) — no banco, sem SQL dinâmico

**Correção da abordagem do brainstorm:** o cliente Supabase não executa SQL arbitrário e montar
string SQL no servidor é risco de injection. Em vez disso, o matching vive em **funções Postgres**
que interpretam a `regra jsonb` com **SQL estático e predicados condicionais** (padrão
`(param IS NULL OR condição)`) — sem `EXECUTE`/SQL dinâmico, parametrizado e seguro.

### Migração: 2 funções
- `publico_contar(regra jsonb) RETURNS bigint` — total que casa (pro preview/contagem; resolve o
  [[feedback_supabase_1000_limit]] porque conta no banco).
- `publico_buscar(regra jsonb, _limit int, _offset int) RETURNS TABLE(id bigint, nome text, telefone text, status text, origem text, criado_em timestamptz)` — linhas paginadas.

Ambas compartilham o mesmo `WHERE`, montado a partir da `regra` extraindo campos do jsonb:
```
termo   := regra->'interesse'->>'termo';
fontes  := regra->'interesse'->'em';        -- jsonb array
status  := regra->'status';                  -- jsonb array (vazio/null = ignora)
dias    := (regra->'periodo'->>'dias')::int;
ddds    := regra->'ddd';
origens := regra->'origem';
resp    := (regra->'engajamento'->>'respondeu')::bool;
ui_dias := (regra->'engajamento'->>'ultima_interacao_dias')::int;
j24     := (regra->'engajamento'->>'janela24h')::bool;
camp    := (regra->'engajamento'->>'recebeu_campanha_id')::bigint;
```
Predicados (todos `param IS NULL OR …`):
- **interesse:** `termo IS NULL OR ( (fontes ? 'origem' AND l.origem ILIKE '%'||termo||'%') OR (fontes ? 'conversa' AND EXISTS(SELECT 1 FROM mensagens m WHERE m.lead_id=l.id AND m.texto ILIKE '%'||termo||'%')) OR (fontes ? 'anuncio' AND l.referral_data::text ILIKE '%'||termo||'%') )`
- **status:** `status IS NULL OR jsonb_array_length(status)=0 OR l.status = ANY(SELECT jsonb_array_elements_text(status))`
- **período:** `dias IS NULL OR l.criado_em >= now() - (dias||' days')::interval`
- **ddd:** `ddds IS NULL OR jsonb_array_length(ddds)=0 OR _ddd_do_telefone(l.telefone) = ANY(SELECT jsonb_array_elements_text(ddds))` — `_ddd_do_telefone` extrai o DDD (tira `55`/`0` à esquerda; **não** altera o cadastro, só lê).
- **origem:** `origens IS NULL OR jsonb_array_length(origens)=0 OR l.origem = ANY(...)`
- **respondeu:** `resp IS NULL OR (resp = EXISTS(SELECT 1 FROM mensagens m WHERE m.lead_id=l.id AND m.direcao='recebida'))`
- **última interação:** `ui_dias IS NULL OR EXISTS(SELECT 1 FROM mensagens m WHERE m.lead_id=l.id AND m.criada_em >= now()-(ui_dias||' days')::interval)`
- **janela 24h:** `j24 IS NULL OR (j24 = EXISTS(SELECT 1 FROM mensagens m WHERE m.lead_id=l.id AND m.direcao='recebida' AND m.criada_em >= now()-interval '24 hours'))`
- **recebeu campanha:** `camp IS NULL OR EXISTS(SELECT 1 FROM disparos_contatos dc WHERE dc.lead_id=l.id AND dc.campanha_id=camp AND dc.status='enviado')`

Excluir `importado_historico`? Não — públicos podem mirar leads antigos. Mas **não** incluir leads
sem telefone válido (a função filtra `l.telefone` não vazio).

## Unidades testáveis em JS (`lib/publicos/`)

- `lib/publicos/regra.js` → `normalizarRegra(input) -> regra` — valida/normaliza/aplica defaults e
  **descarta chaves desconhecidas** antes de mandar pro RPC (defesa: o RPC só lê chaves conhecidas,
  mas normalizar evita lixo persistido). Unit-testado (entradas válidas/parciais/sujas → regra canônica).
- `lib/publicos/csv.js` → `montarCsv(rows) -> string` — gera o CSV (nome, telefone, telefone_wa, status, origem).
  `telefone_wa` = `55`+número quando faltar (mesma regra de `limparNumero`), **preservando** telefones
  com 0 à esquerda (família) sem alterar — ver [[feedback_telefone_zero_familia]]. Unit-testado.

## Backend (endpoints em `server.js`)

Protegidos por `requireAuth` + role (admin/gestor/crc_comercial/`mod_publicos`) + `rateLimit`.
- `POST /api/publicos/preview` — `{ regra }` → `normalizarRegra` → `publico_contar` + `publico_buscar(limit 20, offset 0)`. Retorna `{ total, amostra }`. **Isento do rate limit apertado** (é chamado com debounce enquanto monta).
- `GET /api/publicos` — lista os públicos salvos.
- `POST /api/publicos` — `{ nome, regra }` → normaliza e grava.
- `PUT /api/publicos/:id` — `{ nome, regra }` → atualiza + `atualizado_em`.
- `DELETE /api/publicos/:id`.
- `POST /api/publicos/exportar` — `{ regra }` → pagina via `publico_buscar` (usa `coletarLeadIds`-style, blocos de 1000) → `montarCsv` → responde `text/csv` (download).
- `POST /api/publicos/disparar` — `{ regra | publico_id, nome_campanha, template_nome, wa_number_id }`.
  Valida template (reusa `templateAprovado`) e número (reusa a validação de [[project_disparo_seletor_numero]]: `getPhoneNumbers()`).
  Resolve **todos** os leads (paginado), cria `disparos_campanhas` (status `rascunho`, com `wa_number_id`) +
  `disparos_contatos` **já com `lead_id` setado** (pula matching/criação de lead — são leads existentes),
  `primeiro_nome` = 1º token do nome. Retorna `{ campanha_id, total }`. O disparo em si é iniciado pelo
  endpoint existente `POST /api/disparos/:id/iniciar` (o front redireciona/abre a campanha). **Não duplica** o runner.

## Frontend (`public/publicos/`)

Página separada (shared-nav). Layout:
- **Construtor** (coluna esquerda): campos das 4 dimensões — interesse (termo + checkboxes origem/conversa/anúncio),
  status (multi), período (últimos N dias), DDD (multi/chips), origem (multi a partir dos valores reais da base),
  engajamento (respondeu / última interação / janela 24h / recebeu campanha X).
- **Resultado** (coluna direita): "**X contatos**" (preview com debounce ~400ms ao mexer) + amostra (10-20 linhas).
- **Ações**: Salvar público (nome) · Disparar (abre escolha de template + número, reusa o componente do disparo) · Exportar CSV.
- **Públicos salvos**: lista com carregar/editar/excluir.
- Auth: `public/js/publicos/api.js` (token `sb-…-auth-token`, ver CLAUDE.md).

## Nav + Usuários (padrão obrigatório do CLAUDE.md)
- `public/js/nav-config.js` (fonte única): adicionar um ícone novo `publicos` em `PATHS` (ex.: alvo/segmento — distinto dos existentes) e o item `{ slug:'publicos', label:'Públicos', icon:'publicos', roles:'admin,gestor,crc_comercial,mod_publicos', mode:'link', href:'/publicos/' }`.
- Módulo de Usuários: checkbox "Módulos Extras" `mod_publicos` + `_ROLE_LABELS` + `criarUsuario()`.
- Middleware: `requirePublicos = requireRole('admin','gestor','crc_comercial','mod_publicos')`.

## Erros / bordas
- **Preview 0 resultados:** mostra "nenhum contato"; botões Disparar/Exportar desabilitados.
- **Telefone família (0 à esquerda):** nunca normalizar/mesclar — ver [[feedback_telefone_zero_familia]].
- **Limite de 1000:** contagem e paginação no banco (`publico_contar` / `publico_buscar`).
- **`termo` com `%`/`_`:** passado como **parâmetro** ao ILIKE no RPC (sem concat de SQL) — sem injection; caracteres curinga do usuário são tratados como literais via `regra` jsonb (sem escapar é aceitável: no máximo amplia o match, não quebra).
- **Número/ template inválidos no disparar:** mesma validação do disparo (400 claro).
- **Público sem nenhum filtro:** preview mostra a base inteira; permitido, mas avisa o tamanho antes de disparar.

## Testes
- `lib/publicos/regra.js`: defaults, chaves desconhecidas descartadas, coerção de tipos, regra parcial.
- `lib/publicos/csv.js`: cabeçalho, escaping de vírgula/aspas, `telefone_wa` com/sem 55, família 0-à-esquerda intacto.
- RPC `publico_contar`/`publico_buscar`: verificar via SQL com a base real (ex.: interesse=invisalign 30d DDD31 ≈ os 52 já conhecidos; status; recebeu_campanha).
- Endpoints: preview retorna total coerente; exportar gera CSV; disparar cria campanha com os leads certos (manual/curl).

## Plano de deploy
Branch próprio (worktree) → migração Supabase (tabela + 2 funções + `_ddd_do_telefone`) → `git push` (origin/main, padrão de concorrência) → deploy Easypanel CRM.
