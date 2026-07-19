# Verificações V1–V3 — Modo de Planejamento

Sonda executada em 2026-07-19 via `scripts/verificar-planejamento.js` — **1 única chamada**
à API Clinicorp (`GET /estimates/list`, janela de 30 dias) + consultas ao Supabase
(`orcamentos`, `profiles`). As consultas de contagem completas (sem o limite de 1000
linhas do client) foram feitas via SQL direto no Supabase (MCP), conforme regra da casa
("somar no SQL, nunca no JS").

Adaptações feitas no script em relação ao texto literal do brief (documentadas em
comentário no próprio arquivo):
- Nomes de env var do Clinicorp e do Supabase batem exatamente com o `.env` real
  (`CLINICORP_USER`, `CLINICORP_TOKEN`, `CLINICORP_SUBSCRIBER_ID`, `CLINICORP_BUSINESS_ID`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) — nenhum fallback precisou ser usado.
- `profiles.roles` é `ARRAY` nativo do Postgres (confirmado via
  `information_schema.columns`) — `(u.roles||[]).includes('dentista')` funciona sem
  parsing de CSV.
- **Bug real encontrado no brief:** `profiles` não tem coluna `email` (colunas reais:
  `id, nome, roles, ativo, criado_em, roles_extra, ...`). A consulta original
  `.select('id, email, roles')` roda sem erro mas devolve os campos que existem — na
  prática o `console.log(u.email, u.id)` imprimia `undefined <uuid>` para todo mundo, e
  o filtro por `roles.includes('dentista')` funcionava, mas a saída ficou ilegível o
  suficiente para mascarar o resultado real na 1ª rodada. Corrigido para `id, nome, roles`
  e a saída agora lista todos os profiles com suas roles (não só quem tem `dentista`),
  o que foi necessário para resolver o V3 de verdade (ver abaixo). Essa correção **não**
  gerou uma segunda chamada à API Clinicorp — foi validada só com SQL/Supabase.

---

## V1 — Estrutura do estimate aprovado (decisão para Tasks 2/4)

Estimate aprovado real (30 dias), chaves do objeto raiz:
```
Amount, BusinessId, CreateDate, LastChange_Date, PatientId, PatientMobilePhone,
PatientName, ProcedureList, ProfessionalId, ProfessionalName, Status, TreatmentId, id
```

Item real de `ProcedureList[0]` (dump completo — chaves relevantes):
```json
{
  "TreatmentId": 4524905256189953,
  "PriceId": 5006276105928704,
  "Tooth": "",
  "Executed": "X",
  "Amount": 8.19,
  "FinalAmount": 8.19,
  "OriginalAmount": 8.19,
  "Dentist_PersonId": 4661396421345280,
  "DentistName": "Thais Cristina Madeira Finamore",
  "StatusId": 6224966574538752,
  "StatusDescription": "Autorizado",
  "ExecutedDate": "2026-06-19T03:00:00.000Z",
  "OperationDescription": "Radiografia bite-wing",
  ...
}
```

### Decisão 1 — existe campo de quantidade por item?
**NÃO.** As chaves candidatas encontradas pela regex (`qty|quant|amount|tooth|dente`)
foram `Tooth, Amount, FinalAmount, MinimumProcedureAmount, OriginalAmount` — todas
monetárias ou o dente tratado, nenhuma é uma contagem de unidades.

→ **Ramo escolhido pela realidade: o fallback da spec.**
`plano_itens.quantidade` nasce com default `1`; agrupamento por `PriceId` repetido
dentro do mesmo `ProcedureList` = quantidade N (N linhas do mesmo `PriceId` viram
quantidade N do mesmo item do plano). Tasks 2/4 devem implementar exatamente essa
regra de agrupamento.

### Decisão 2 — existe status de aprovação POR ITEM?
**Parcialmente — não como um booleano "aprovado/reprovado" separado do estimate, mas
existe um par de campos por item que cumpre o papel prático da spec:**
- `Executed` (`'X'` ou vazio) + `ExecutedDate` — indica se aquele procedimento
  específico já foi executado, independente do estado geral do orçamento.
- `StatusId` / `StatusDescription` (no item observado: `"Autorizado"`) — existe, mas só
  vimos 1 item em 1 estimate nesta sonda (limite de 1 chamada); não dá para confirmar
  se ele varia por item dentro do mesmo estimate (ex.: um item "Autorizado" e outro
  "Pendente" no mesmo orçamento aprovado). Fica como **exploração futura**, não bloqueia
  a Task 2/4.

→ **Ramo escolhido pela realidade: o fallback da spec, usando o campo que É confiável
e existe de fato.** O plano nasce do orçamento inteiro (não item a item); itens com
`Executed === 'X'` nascem como `concluida_retroativa` no `plano_itens` — essa condição
está diretamente disponível no payload, sem depender de `StatusId`/`StatusDescription`.

---

## V2 — Domínio de status em `orcamentos.status` + regra de cancelamento

`orcamentos.status` é gravado **direto do campo `Status` do estimate no Clinicorp**,
sem tradução (`sync/clinicorp-sync.js:439` — `status: o.Status || null`). Janela de
sincronização real: **`FUNIL_DIAS = 180` dias** (`sync/clinicorp-sync.js:18` — o brief
mencionava "120d" como exemplo hipotético; a janela real é 180 dias móveis).

Contagem completa (SQL, sem cap de 1000 linhas do client):

| status | contagem |
|---|---|
| APPROVED | 1.567 |
| OPEN | 1.107 |
| REJECTED | 5 |
| REJECTED_OPPORTUNITY | 2 |
| **total** | **2.681** |

Não apareceu nenhum status `CANCELED`/`CANCELLED` na base — o Clinicorp aparentemente
não usa essa palavra; o mais próximo semanticamente é `REJECTED` / `REJECTED_OPPORTUNITY`.

### Regra concreta adotada
- **Se o sync trouxer, para um `clinicorp_estimate_id` que já tem `plano` gerado, um
  `Status` diferente de `APPROVED`** (ex.: virou `REJECTED`/`REJECTED_OPPORTUNITY`, ou
  qualquer valor novo que a Clinicorp passe a mandar) → marcar o plano como `cancelado`.
  Essa transição é positiva (o Clinicorp *afirmou* outro status), não uma ausência.
- **"Sumiu do retorno" (o `id` não aparece mais na janela de 180 dias) NÃO cancela
  sozinho.** Uma janela móvel de 180 dias pode simplesmente deixar de trazer um
  orçamento antigo sem que ele tenha sido de fato desfeito (falso-positivo). Isso só
  gera um registro em log como `fora_da_janela` — não muda `orcamentos.status` nem o
  `plano` associado. Só uma reaparição futura com `Status` explícito diferente de
  `APPROVED` é que dispara `cancelado`.

---

## V3 — Mapa profissional_nome → user_id

`profiles` tem 13 usuários. Coluna real usada para nome é `nome` (não `email` — ver
nota de adaptação do script acima). Role `dentista` (literal, `roles @> ['dentista']`)
existe em **apenas 1** profile: **Matheus Gregório**
(`95dc2d78-108e-4c3b-9569-3d94280e7090`, roles: `dentista, mod_avaliacao_dentista`).

Isso por si só não cobre o funil: `orcamentos.profissional_nome` tem 18 valores
distintos (variações de encoding incluídas) alimentando orçamentos `APPROVED`. Mapeando
por nome/alias contra os 13 profiles (inclui os aliases internos "Marcos - Avaliação" /
"Matheus G. - Avaliação" / "Marcos - Execução" / "Matheus G. - Execução" — esses são
IDs de profissional fictícios da Clinicorp usados só na etapa de avaliação/execução,
ver `DENTISTAS_AVALIACAO` em `server.js`, e ligados por nome ao Marcos e ao Matheus):

| profissional_nome (orcamentos, APPROVED, contagem real) | user_id | nome do profile | role literal `dentista`? |
|---|---|---|---|
| Helen Cristina Fernandes Toledo dos Santos (360) | **NULL** | — | — |
| Ana Luiza Rodrigues Coelho (223) | **NULL** | — | — |
| Thais Cristina Madeira Finamore (208) | **NULL** | — | — |
| Marcos Vinícius Coelho Vidigal Martins (167) | `0b8c0c41-4c57-4b9a-a7e3-bdc76f0c8abe` | Marcos Vinicius Coelho Vidigal Martins | não (`admin,gestor`) |
| Matheus G. - Execução (148) | `95dc2d78-108e-4c3b-9569-3d94280e7090` | Matheus Gregório | **sim** |
| Fernanda Martins Cardoso (78, obs.: nome vem com espaço final no Clinicorp) | **NULL** | — | — |
| Joaquim Vidigal Martins Filho (78) | **NULL** | — | — |
| Amanda Ferreira Molica (69) | **NULL** | — | — |
| Marcos - Avaliação (69) | `0b8c0c41-4c57-4b9a-a7e3-bdc76f0c8abe` | Marcos Vinicius Coelho Vidigal Martins | não (alias interno, mapeado por nome) |
| Hemylly Vitoria Albino Ferreira (42) | **NULL** | — | — |
| Marcos - Execução (41) | `0b8c0c41-4c57-4b9a-a7e3-bdc76f0c8abe` | Marcos Vinicius Coelho Vidigal Martins | não (alias interno, mapeado por nome) |
| Matheus G. - Avaliação (31) | `95dc2d78-108e-4c3b-9569-3d94280e7090` | Matheus Gregório | sim (alias interno, mapeado por nome) |
| Raíssa Alves Lopes (20) | **NULL** | — | — |
| Lorena Ventura Fernandes (16) | **NULL** | — | — |
| Patrícia Reis de Sá (9) | **NULL** | — | — |
| Lígia Quintão Mayrink Soares (6) | **NULL** | — | — |
| Matheus G. - Execuç��o (1, variante de encoding corrompida) | `95dc2d78-108e-4c3b-9569-3d94280e7090` | Matheus Gregório | sim (mesmo caso, encoding quebrado) |
| Matheus G. - Execu��ão (1, variante de encoding corrompida) | `95dc2d78-108e-4c3b-9569-3d94280e7090` | Matheus Gregório | sim (mesmo caso, encoding quebrado) |

**Total APPROVED (banco inteiro, sem cap): 1.567**
**Mapeados (Marcos + Matheus, únicos com login no CRM): 458 (167+69+41 + 148+31+1+1)**
**Não mapeados (`NULL` → fila da gestora): 1.109 → 70,8% dos orçamentos APPROVED.**

### Conclusão / ação para Tasks 2/4
A imensa maioria dos dentistas que fecham orçamentos no Clinicorp **não tem login no
CRM** — só Marcos e Matheus têm profile aqui, e nenhum dos dois tem a role `dentista`
marcada de forma limpa e única no profile do Marcos (ele é `admin,gestor`; o mapeamento
dele só funciona por casamento de nome, não por role). Recomendação:
1. `plano_itens`/`planos` devem guardar `profissional_nome` (texto bruto do Clinicorp)
   **sempre**, e `dentista_user_id` como coluna nullable, preenchida só quando existir
   mapeamento.
2. A tela/fila da gestora precisa listar explicitamente os planos com
   `dentista_user_id IS NULL` — é a maioria (70,8%), não uma exceção rara.
3. Antes da Task 2/4 assumir 1:1 nome↔login, alguém (Luiz/gestora) precisa decidir se
   vale cadastrar profile para os demais dentistas ou se o fluxo vive permanentemente
   sem esse vínculo para a maior parte dos casos.
