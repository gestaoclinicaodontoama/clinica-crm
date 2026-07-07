# Enriquecimento de e-mail dos leads via Clinicorp — Design

**Data:** 2026-07-07
**Status:** aprovado (brainstorming) — aguardando revisão do spec

## Objetivo e contexto

O CAPI envia hoje telefone + nome (+ `external_id`, adicionado em cdc7397), e o EMQ
(Event Match Quality — nota 0–10 de quão bem a Meta casa o evento com uma pessoa) das
contas Clínica AMA e Dr. Marcos está em **3,4/10**. O maior salto disponível é o
**e-mail**: os leads têm e-mail praticamente zerado (7 de ~16.160), mas o Clinicorp tem
e-mail de **64% dos pacientes** (13.875 de 21.580), já sincronizado na tabela
`pacientes` (`sync/clinicorp-sync.js`, via `/patient/get`).

**Meta:** preencher `leads.email` a partir de `pacientes.email`, casando por telefone.
Uma vez populado, o CAPI enriquece sozinho — `_enviarEventoMetaUnico` **já** manda
`em` quando `lead.email` existe (nenhuma mudança no hot path do disparo).

Estimativa de alcance: **~1.860 leads** enriquecíveis hoje (casamento por sufixo-8).
Como o e-mail só existe depois do comparecimento, o ganho de EMQ se concentra nos
eventos de fundo de funil (Contact/Schedule/Purchase) — os de maior valor.

## Decisões (do brainstorming)

- **Persistir no `leads.email`** (decisão do Luiz), não só resolver na hora do disparo.
  Deixa o e-mail visível no CRM e reusável; o CAPI consome sem alteração.
- **Casamento por sufixo-8 do telefone** — a coluna `leads.clinicorp_patient_id`
  existe mas está preenchida em 1 lead só (morta); o vínculo exato fica fora de escopo.
- **Trabalho todo em SQL** (função no Postgres), seguindo a escada de decisão do
  CLAUDE.md — sem paginação de 1000 linhas, sem loop em JS.

## Componentes

### 1. Função Postgres `enriquecer_emails_leads()`

Migration `supabase/migrations/20260707*_enriquecer_emails_leads.sql`. Retorna
`integer` (quantos leads atualizou). Lógica:

1. **Candidatos (pacientes):** `pacientes` com e-mail **válido**
   (`email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'`) e celular com ≥ 8 dígitos.
   Chave: `right(regexp_replace(telefone_celular,'\D','','g'), 8)` + primeiro nome
   normalizado sem acento (`translate(lower(split_part(nome,' ',1)), ...)`).
2. **Checagem de primeiro nome (ADICIONADA na execução):** casa lead↔paciente por
   **sufixo-8 E primeiro nome igual**. Descoberto no preview: o sufixo sozinho casava
   **pessoas diferentes da mesma família** (~40% da amostra — ex.: lead "Fernando"
   casando com paciente "Camila" no mesmo telefone). O telefone é compartilhado pela
   família, mas o e-mail é pessoal; o **primeiro nome** distingue quem é quem (o
   sobrenome a família compartilha, não serve). Exige primeiro nome com ≥ 2 letras
   (descarta lixo tipo "."). Efeito: precisão alta, ~1.600 leads (vs 1.690 sem a
   checagem, mas com ~40% de e-mail da pessoa errada).
3. **Anti-colisão:** agrupa por **(sufixo, primeiro nome)** e só mantém combinações com
   `count(distinct lower(trim(email))) = 1`. Dois parentes de nomes diferentes no mesmo
   telefone agora se separam por nome (cada um casa com o seu); dois e-mails distintos
   para o mesmo (sufixo, nome) = ambíguo, pula.
4. **Alvos (leads):** `email IS NULL OR email = ''`, telefone com ≥ 8 dígitos, e
   **telefone que NÃO começa com `0`** — zero à esquerda é a convenção da casa para
   familiar compartilhando o número do titular (regra: NUNCA mesclar).
5. **Update:** `leads.email = lower(trim(email))` do paciente casado.

**Limitação residual aceita:** o e-mail é o "de cadastro" do paciente no Clinicorp;
às vezes é um e-mail de família (ex.: paciente Maria cadastrada com o e-mail do marido
José). Como lead e paciente são a mesma pessoa (nome bate), é o melhor contato que
temos para ela — aceitável. O que a checagem elimina é o caso pior: e-mail de **outra
pessoa** (lead ≠ paciente).

**Segurança (regra do CLAUDE.md):** função nasce trancada —
`REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role`.
Sem `SECURITY DEFINER` (o servidor chama via `.rpc()` com service_role, que já
ignora RLS). Nenhuma tabela nova; RLS do `leads` inalterada.

### 2. Backfill único

Após aplicar a migration, uma chamada manual `select enriquecer_emails_leads();`
(~1.860 updates esperados). Antes do update, rodar a versão `SELECT` (contagem +
amostra de 10 pares lead↔email) para validar o casamento a olho.

### 3. Recorrência — hook no sync diário

Em `sync/clinicorp-sync.js`, logo após a fase que faz upsert de `pacientes`:
chamada `supabase.rpc('enriquecer_emails_leads')` **isolada em try/catch próprio**
(padrão de isolamento por fase do sync) — falha no enriquecimento loga e não derruba
as fases seguintes. Loga o retorno (`N leads enriquecidos`) no `sync_log`.

**Limitação conhecida:** o upsert de `pacientes` no sync usa `ignoreDuplicates: true`
— paciente já existente **não** tem o e-mail atualizado depois; só pacientes novos
entram com e-mail. O ganho recorrente vem de pacientes novos (lead → comparece →
cadastro com e-mail → sync → enriquece). Atualizar e-mail de pacientes antigos no
sync é mudança à parte, fora deste escopo.

## Fluxo de dados

```
Clinicorp /patient/get ──sync diário──▶ pacientes.email
                                            │ enriquecer_emails_leads()
                                            ▼ (sufixo-8, anti-colisão, sem leads 0-prefixo)
                                       leads.email
                                            │ dispararConversaoMeta (já existente)
                                            ▼ user_data.em = sha256(email)
                                          Meta CAPI ──▶ EMQ ↑
```

## Casos de borda e tratamento de erro

| Caso | Comportamento |
|------|---------------|
| Lead já tem e-mail | Intocado (filtro `email IS NULL OR ''`) |
| Sufixo casa com 2+ e-mails distintos | Pula (ambíguo — família com e-mails diferentes) |
| 2+ pacientes, mesmo e-mail | Grava (1 e-mail distinto) |
| Lead com telefone iniciando em `0` | Pula (convenção familiar — e-mail seria do titular) |
| E-mail inválido no Clinicorp (`-`, sem `@`) | Filtrado pela regex, nunca gravado |
| Paciente sem celular / < 8 dígitos | Fora dos candidatos |
| RPC falha no sync | try/catch isolado; loga; demais fases seguem |
| Função exposta ao front | Não — revoke PUBLIC/anon/authenticated |

## Testes / validação

1. **Preview antes do backfill:** versão `SELECT` da mesma lógica — contagem total +
   amostra de 10 pares (nome do lead, telefone, e-mail que seria gravado) conferida
   a olho.
2. **Guarda de colisão:** verificar no preview que sufixos com e-mails distintos não
   aparecem (query de conferência com `count(distinct email) > 1`).
3. **Regra do zero:** conferir que nenhum lead com telefone `0...` está no preview.
4. **Idempotência:** rodar a função 2× seguidas — a 2ª retorna 0.
5. **Pós-deploy:** conferir no `sync_log` do dia seguinte a linha do enriquecimento;
   em ~3–4 dias, puxar o EMQ de novo (`ads_get_dataset_quality`) e comparar com o
   baseline 3,4.

## Fora de escopo (YAGNI)

- Ressuscitar `leads.clinicorp_patient_id` (vínculo exato lead↔paciente) — projeto à
  parte; quando existir, o casamento por sufixo pode ser aposentado.
- Casar por `telefone_fixo` (leads nascem de WhatsApp = celular).
- Exibir cobertura de e-mail no painel `/capi-saude/` (a barra de cobertura já mostra
  `email %` — vai subir sozinha).
- Apagar/atualizar e-mails já gravados quando o Clinicorp mudar (só preenche vazio;
  atualização contínua é complexidade sem demanda).
