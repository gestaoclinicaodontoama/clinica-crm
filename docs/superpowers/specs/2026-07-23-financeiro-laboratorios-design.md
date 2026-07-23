# Financeiro → Laboratórios — módulo de serviços protéticos

**Data:** 2026-07-23 · **Status:** aprovado pelo Luiz (escopo confirmado em conversa)

## Problema

A clínica gasta ~R$ 163 mil/ano (jan–jul/2026 já mapeado) com 5 laboratórios de prótese e não tem
nenhuma visão consolidada: cada lab manda cobrança num formato (PDF de sistema, nota avulsa,
planilha, caderno manuscrito fotografado). Não dá para comparar preço, prazo, retrabalho, nem saber
quanto cada dentista consome. O Controle Protético da Clinicorp não serve de fonte: é API interna
logada que responde 401 ao nosso token (já testado — ver memória reference_clinicorp_controle_protetico).

## Escopo confirmado

- **Módulo vivo**: carga inicial dos dados 2026 + entrada contínua (importador IA com tela de
  conferência + lançamento manual como fallback).
- **Análises da fase 1**: comparador de preços, prazo/atraso, retrabalho, custo por dentista,
  evolução mensal, tabela detalhada com filtros.
- **Fora desta fase** (fase 2 futura): casar paciente com cadastro/360º (lucratividade por
  tratamento), alertas de variação de preço.
- **Local**: seção Financeiro do menu, página `/financeiro/laboratorios/`.
- **Acesso**: mesmas roles das outras páginas do Financeiro (`financeiro`, `mod_financeiro`,
  `admin`; `gestor` NÃO entra por padrão nas páginas `financeiro,mod_financeiro` do nav — seguimos
  o mesmo gate da DRE e do A Receber/A Pagar).

## Os 5 laboratórios e seus formatos (dados reais lidos em 23/07)

| Lab | Formato | Itens/pedidos | Total 2026 | Observações de parsing |
|---|---|---|---|---|
| Ateliê Odonto Protése | PDF "Pedidos Finalizados" (8 pág.) | 95 pedidos / 148 serviços | R$ 99.621,46 | Tem Entr/Prev./Saída → dá % atraso real (40/95 com atraso). Itens "Reparo" a R$ 0. Campo Conv = dentista. |
| LAPROTEC | Notas de serviço PDF (686, 697, 712, 733, 755, 774) | 79 linhas | R$ 48.675,00 | Colunas OS, Dt Entrada, Dt Entregue, Descrição, Paciente, Valor, Dentista. Sem data prevista. |
| Dente & Arte | PDF "Pedidos Finalizados" (mesmo sistema do Ateliê) | 12 pedidos / 13 serviços | R$ 5.942,00 | Tem coluna Dente. Conv = dentista. |
| Búcio (manuscrito) | Fotos de caderno (WhatsApp) | ~12 linhas visíveis | R$ 5.290 visíveis + R$ 1.710 de página não fotografada | Manuscrito: data, paciente, serviço abreviado ("01 c/impl", "01 Rest EMAX 46"), dente, valor. Totais mensais: jan 1.580 · fev 1.140 · mar 465 · mai 2.105; o topo da 4ª foto mostra um "Total = 1.710,00" de página anterior — entra como nota só com `total_informado`, sem itens, `conferir=true`. Linhas duvidosas entram com flag `conferir`. |
| Marcos Miranda (protético PF) | Planilha PDF mensal | 5 linhas (só março) | R$ 1.710,00 | Colunas Paciente, Entrada, Saída, Trabalho, Valor. Dentista implícito (Dr. Joaquim no cabeçalho). |

Constatações que a página deve evidenciar: coroa unitária varia R$ 285 → R$ 440 entre labs;
prazos de 2–3 meses em alguns itens LAPROTEC; reparos R$ 0 no Ateliê (retrabalho).

## Modelo de dados (Supabase, migration nova)

### `protetico_notas` — uma linha por nota/remessa/página de caderno
- `id` bigint pk
- `laboratorio` text not null — nome canônico ('Ateliê Odonto', 'LAPROTEC', 'Dente & Arte', 'Búcio', 'Marcos Miranda'); livre para labs novos
- `referencia` text — nº da nota ou descrição ('Nota 686', 'Caderno 06/01/2026', 'Relatório 05/01–23/07')
- `periodo_inicio` date null, `periodo_fim` date null — período coberto quando o doc informa
- `emitida_em` date null
- `total_informado` numeric(12,2) null — total impresso no documento
- `origem` text not null default 'import' — 'seed' | 'import' | 'manual'
- `criado_por` text null, `criado_em` timestamptz default now()

Regra de conferência: a UI mostra `total_informado` × soma dos itens; divergência vira aviso na
tela (não bloqueia salvar — nota manuscrita às vezes soma errado, e o dado real são os itens).

### `protetico_itens` — uma linha por serviço
- `id` bigint pk, `nota_id` bigint fk → protetico_notas (on delete cascade)
- `paciente_nome` text not null — como está no documento (sem FK nesta fase)
- `dentista_nome` text null — como está no documento ('Conv:'/'Dentista:'); normalização leve na
  gravação (trim/caixa); página agrupa pelo texto
- `descricao_original` text not null — nunca se perde
- `categoria` text not null — categoria canônica (ver catálogo)
- `dente` text null, `quantidade` int not null default 1 check (quantidade > 0)
- `valor_total` numeric(12,2) not null — valor da linha (qtd × unitário); `valor_unitario` numeric gerado = valor_total/quantidade (check garante quantidade > 0)
- `data_entrada` date null, `data_prevista` date null, `data_entrega` date null
- `atrasado` boolean null — calculado quando existe prevista+entrega (entrega > prevista)
- `reparo` boolean not null default false — somente pela descrição (categoria resolvida = 'Reparo'); item de valor 0 que não é reparo (ex.: "Gesso — Acabamento (Cortesia)") NÃO conta como retrabalho
- `conferir` boolean not null default false — extração incerta (manuscrito ilegível etc.)
- `criado_em` timestamptz default now()

### `protetico_categorias` — catálogo de normalização (editável na página)
- `id` bigint pk
- `padrao` text not null unique — trecho a casar na descrição (case/acento-insensitive, `unaccent(lower())`)
- `categoria` text not null — ex.: 'Coroa unitária', 'Protocolo', 'Prótese total', 'Prótese parcial',
  'Provisório', 'Placa de bruxismo', 'Modelo/acessório', 'Enceramento', 'Reparo', 'Outros'
- Nasce semeado pelos padrões reais: CMC, Zircônia/Zirconia Coroa, Coroa Fresada Dissilicato,
  coroa e-max, onlay, c/impl, Rest EMAX → Coroa unitária · Protocolo/PROVA DE PROTOCOLO → Protocolo ·
  PT IMEDIATA/PROTESE TOTAL/PT COMUM → Prótese total · ROACH/PARCIAL → Prótese parcial ·
  PMMA/PROVISÓRIA → Provisório · PLACA → Placa de bruxismo · Modelo/Link/Análogo/Muralha/tbase/
  Parafuso → Modelo/acessório · Enceramento → Enceramento · Reparo/Conserto → Reparo · resto → Outros.
- Item guarda a `categoria` resolvida na gravação (snapshot); recategorizar em massa = botão
  "reaplicar catálogo" (update em lote pela descrição).

RLS ligada nas 3 tabelas (padrão do projeto: leitura/escrita só via servidor com service_role; sem
policy para anon/authenticated).

## Servidor (server.js + lib/protetico/)

Todas as rotas com `requireAuth, requireFinanceiro` (gate existente linha ~508).

- `GET /api/protetico/resumo?desde&ate&lab&categoria&dentista` — devolve, calculado no SQL (sem
  truncar em 1000 — agregações no Postgres via RPC ou `select` agregado):
  cards (total, nº itens, ticket médio, % atraso onde há prevista, % reparo);
  matriz preço mediano categoria×lab (+ volume por célula);
  prazo mediano entrada→entrega por lab; gasto por dentista; série mensal por lab.
  **Data efetiva** de todo filtro/série = `data_entrega`, fallback `data_entrada`, fallback
  `emitida_em` da nota — uma regra só, aplicada igual em cards, matriz, séries e tabela.
- `GET /api/protetico/itens?filtros+paginação` — tabela detalhada.
- `POST /api/protetico/importar` — multipart (PDF/JPG/PNG, ≤15 MB). Manda o arquivo ao Gemini
  (`inline_data`, padrão de `analyzeLigacao`/JSON-mode de `avaliarDRE` em lib/gemini.js) com
  response_schema: `{ laboratorio_sugerido, referencia, total_informado, itens: [{paciente, dentista,
  descricao, dente, quantidade, valor_total, data_entrada, data_prevista, data_entrega, incerto}] }`.
  **Não grava nada**: devolve o JSON extraído para a tela de conferência. Categoria é resolvida no
  servidor (catálogo) e volta junto para o usuário ver/ajustar.
- `POST /api/protetico/notas` — grava nota + itens conferidos (transação; recusa itens sem
  paciente/descrição/valor numérico; `origem='import'|'manual'`).
- `PATCH /api/protetico/itens/:id` e `DELETE` — correções pontuais.
- `GET/POST/PATCH/DELETE /api/protetico/categorias` + `POST /api/protetico/categorias/reaplicar`.
- Erros Gemini: mesmos retries de `callWithRetry`; 503 → mensagem "IA indisponível, tente de novo"
  (padrão social-media).

## Página `/financeiro/laboratorios/` (public/financeiro/laboratorios/index.html)

Item novo no menu: `public/js/nav-config.js`, seção Financeiro (linha ~110), slug
`financeiro-laboratorios`, label "Laboratórios", roles `financeiro,mod_financeiro`, `mode: 'link'`,
href `/financeiro/laboratorios/`.

Padrão visual das irmãs do Financeiro (saude/receita): shared-nav (`data-active="financeiro-laboratorios"`),
tema claro/escuro, retry 5xx 2x (1,5s/3s), filtro de período no topo (padrão: ano corrente) +
filtros lab/categoria/dentista.

1. **Cards**: Gasto total · Itens · Ticket médio/item · % com atraso (nota "só labs que informam
   previsão") · % retrabalho.
2. **💰 Comparador de preços**: matriz categoria × lab, célula = preço mediano unitário + nº de
   itens; célula mais barata da linha em verde, mais cara em vermelho; clique → filtra a tabela
   detalhada.
3. **⏱️ Prazo por laboratório**: prazo mediano em dias + % atraso (quando houver prevista) + nº
   itens ≥ 60 dias.
4. **🦷 Por dentista**: barras de gasto por dentista no período.
5. **📈 Evolução mensal**: colunas empilhadas por lab (chart.min.js já vendorizado).
6. **Tabela detalhada**: paginada, filtros, busca por paciente, badge 🔧 reparo e ⚠️ conferir;
   linha expande mostrando descrição original + nota de origem; editar/excluir inline (role
   financeiro já garantida pela rota).
7. **📥 Importar nota** (modal em 2 passos): (1) upload → spinner IA → (2) tabela de conferência
   editável (lab sugerido, linhas, categoria por dropdown, total extraído × total informado com
   destaque se divergir) → Salvar. Botão "adicionar linha na mão" no mesmo modal cobre o
   lançamento manual (cria nota `origem='manual'` sem arquivo).
8. **⚙️ Categorias**: modal CRUD do catálogo + "reaplicar catálogo".

Sem botão de sync Clinicorp: a regra "botão sync obrigatório em módulo Clinicorp" não se aplica —
fonte é documento do lab, não Clinicorp; o rodapé explica isso em 1 linha.

## Carga inicial (seed)

Script `scripts/seed-protetico-2026.js` (rodável 1x, idempotente por `referencia`+`laboratorio`):
insere as notas/relatórios lidos em 23/07 com TODAS as linhas extraídas por mim dos 9 PDFs + 4
fotos (~250 linhas, ~R$ 163 mil). Linhas manuscritas ilegíveis entram com `conferir=true`.
O arquivo "2ª Alteração – Clínica Odontológica Martins (1).pdf" é contrato social e fica fora.
Fonte dos dados fica commitada em `scripts/seed-protetico-2026.data.json` para auditoria.

## Testes

- Unit (node:test, padrão do repo): resolução de categoria (casos reais dos 5 labs, com/sem acento);
  cálculo de atraso/reparo; validação do payload de gravação (recusa valor não-numérico, aceita
  datas nulas); conferência total_informado × soma.
- Endpoint de importação: mock do Gemini (não chama API em teste).
- Smoke manual pós-deploy: abrir página logado, importar 1 nota real da LAPROTEC de novo e conferir
  que a tela de conferência bate com o PDF.

## Deploy e validação

Branch `feat/financeiro-laboratorios` → merge origin/main → deploy Easypanel (fluxo automático já
combinado). Migration aplicada via Supabase MCP antes do deploy. Item novo na lista de pendências
do Luiz: validar logado (cards batem com os totais desta spec; importar a nota 774 de novo e ver
duplicata ser bloqueada pela referência).

## Riscos e decisões registradas

- **Gemini erra extração** → mitigado: nada é gravado sem passar pela tela de conferência humana.
- **Nome de paciente/dentista sujo** → aceito nesta fase (texto livre); casamento com cadastro é fase 2.
- **Duplicata de importação** → recusa nota com mesma (`laboratorio`,`referencia`) já existente;
  aviso na UI oferece abrir a existente.
- **gestor fora do gate** → decisão consciente de seguir o padrão DRE/A Receber (Luiz é admin).
