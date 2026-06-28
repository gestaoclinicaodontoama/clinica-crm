# Retorno de Prevenção — Fase 1.5: Segmentação + Contagem (Perio conta · Convênio · VIP) — Design

**Data:** 2026-06-26 (consolidada 2026-06-27)
**Status:** Aprovado no brainstorm, pendente revisão da spec escrita
**Pré-requisito de:** Agente de Retorno (conversacional) — esta fase fecha as réguas antes do agente.
**Relaciona:** `2026-06-15-retorno-prevencao-design.md` (Fase 1), `project_retorno_prevencao`, `project_agentes`.

---

## 1. Objetivo

A Fase 1 entregou a lista de prevenção vencida (180d) por Adulto/Infantil (513 vencidos). Esta fase fecha a **segmentação e a contagem** antes do agente conversacional. **Deconflito (2026-06-27):** este é o ÚNICO dono de prevenção/Retorno — absorve os achados do outro terminal (contagem por convênio); o outro terminal volta pra Recuperação (orçou e não fechou).

O que entra:
1. **Categoria Perio** — sub-gengival/alisamento **passa a CONTAR** como prevenção (3ª categoria) + marca o paciente como perio (rota periodontista). 180d. (§2)
2. **Convênio (`bill_type`)** — gravar o convênio nos eventos + regra "particular=1 / convênio=por paciente/dia". (§2b)
3. **Régua VIP** — pacientes do pacote (PPAMA) têm intervalo **mais curto e por-paciente** (mensal a 4-em-4-meses) — o único prazo diferente dos 180d. (§3)

Decisão do Luiz: intervalo é **180d para todos** (adulto/criança/perio); só os **VIPs** têm tempo diferente.

---

## 2. Categoria Perio — sub-gengival CONTA como prevenção (+ selo)

⚠️ **Reconciliação (2026-06-27, deconflito dos 2 terminais):** a Fase 1 excluía sub-gengival **de propósito**, mas o Luiz confirmou: **sub-gengival É a prevenção do periodontista → deve CONTAR**. Então perio deixa de ser "só selo" e vira a **3ª categoria de prevenção** (adulto / infantil / **perio**), unificando as duas visões:

- **O que é perio:** raspagem **sub-gengival / alisamento radicular**. Cirurgias pontuais (retalho/enxerto/gengivectomia) ficam fora. ~40 pacientes.
- **Conta como prevenção:** `syncPrevencao` passa a classificar sub-gengival/alisamento como `categoria='perio'` (em vez de descartar) → o evento entra no `ultima_prevencao` do paciente (a manutenção periodontal É o retorno dele).
- **Também é selo:** paciente com qualquer evento perio fica `pacientes_abc.perio=true` → badge "Perio" + rota pro periodontista (no agente).
- **Intervalo segue 180d** (prazo só muda p/ VIP).
- **Mudança no classificador (`lib/prevencao/classificacao.js`):** a linha que hoje retorna `null` p/ sub-gengival passa a retornar **`'perio'`** quando `(n inclui 'sub' E 'gengiv')` **OU** `n inclui 'alisamento radicular'`. Retorno **cedo** (antes do override infantil — perio não vira infantil). ⚠️ **Atualizar `classificacao.test.js`:** o caso `'85300039 - Raspagem sub-gengival/alisamento radicular'` hoje espera `null` → passa a esperar `'perio'` (mover do teste "NÃO contam" p/ um teste novo "sub-gengival conta como perio"). "Manutenção periodontal" segue `null` (não casa as regras perio).
- **Colunas:** `pacientes_abc.ultima_prevencao_perio DATE` (consistente com adulto/infantil) + `perio BOOLEAN DEFAULT false`. Paciente só-perio (sem profilaxia) entra na lista com badge Perio e `ultima_prevencao` = a data perio.

---

## 2b. Convênio (`bill_type`) + regra de contagem (absorve o achado do outro terminal)

O outro terminal descobriu (ver [[reference_prevencao_convenios]]) que falta gravar o convênio e definiu a regra de contagem. Absorvido aqui:

- **Gravar `bill_type` nos eventos:** `producao_procedimentos.bill_type` existe → `syncPrevencao` passa a gravar `prevencao_eventos.bill_type` (hoje NULL). Habilita segmentar **convênio × particular** e por convênio (Cenibra/Vale/CEF).
- **Regra de contagem (confirmada pelo Luiz):** **particular = 1 procedimento já basta**; **convênio = por paciente/dia** (≥1 procedimento de prevenção no dia = 1 prevenção). Isso é ~o que a `syncPrevencao` atual já faz (dedup por `clinicorp_id|data|categoria`) — **não muda a contagem**, só passa a registrar o convênio.
- **Conjuntos por convênio (Cenibra/Vale/CEF) = documentação/auditoria**, NÃO validação rígida (a regra é "por paciente/dia", não "conjunto completo"). Match por código (os códigos vêm embutidos no nome). Fica como referência p/ um futuro selo "prevenção completa vs incompleta" — fora do escopo desta fase.
- **Convênio-only na lista:** a `syncPrevencao` (abordagem por `producao_procedimentos`, já em produção) casa o paciente por nome → cobre convênio-only que tenham cadastro. (Resolve o gap de ~12% que o outro terminal notou.)

---

## 3. Régua VIP (intervalo por-paciente)

**Modelo atual:** `vip_pacientes` (id, paciente_id, adicionado_em, adicionado_por, obs) — lista curada à mão (~4 hoje, obs "PPAMA"). Cliente-side via Supabase RLS (`public/js/pos-tratamento/vips.js`).

**Mudança:** adicionar `vip_pacientes.intervalo_dias INTEGER` (nullable; varia 30–120d por paciente; setado na marcação). Quando null mas VIP, usar default **120d**.

**Régua efetiva (cálculo de vencido):**
```
intervalo_efetivo(paciente) = é_VIP ? coalesce(intervalo_dias, 120) : 180
vencido = dias_sem_prevencao > intervalo_efetivo
```
Perio segue 180d (selo não altera prazo). VIP mensal vence em 30d; resto em 180d.

---

## 4. Marcação de VIP inline (remove a página VIPs)

Hoje a marcação está na página `vips.html`/`vips.js` (busca paciente → insert em `vip_pacientes`). **Decisão do Luiz: remover a página VIPs** e marcar inline a partir da Curva ABC / Prevenção. Reaproveita 100% o padrão de `vips.js` (insert/delete via cliente Supabase, sem endpoint novo).

Na **Curva ABC / Prevenção**:
- **Por linha:** botão **⭐ VIP** → marca/desmarca o paciente + abre um input de **intervalo (dias)**. Marcar = insert em `vip_pacientes` (paciente_id, adicionado_por, intervalo_dias); desmarcar = delete. Editar intervalo = update (inline, padrão do `editarObs` atual).
- **Adicionar VIP fora da lista:** um campo de **busca** (reusa `buscarPacientes` por nome do `vips.js`) → seleciona → marca VIP + intervalo. Para incluir quem não está na tela de vencidos.

**Remoção da página:** tirar o item `vips` do `CRM_NAV` (`nav-config.js`). Arquivos `vips.html`/`vips.js` ficam no disco (não removidos), só saem do menu. ⚠️ A função de "marcar VIP contatado hoje" (recall logs) da página antiga não é portada agora — o **agente** assume o disparo/contato.

---

## 5. Curva ABC / Prevenção — mudanças de tela

- **Badges** ao lado do nome: **Perio** (se `perio`), **⭐VIP (Nd)** (se VIP, mostrando o intervalo).
- **Coluna Status** passa a usar o **intervalo efetivo** por paciente (carrega `vip_pacientes` — lista pequena — num Map `paciente_id→intervalo_dias`; `statusPrev(data, intervaloEfetivo)`).
- **Filtro por cohorte:** Todos / Adulto / Criança / Perio / VIP (chips, junto do filtro Adulto/Infantil existente).
- Ordenação por data mantém-se; o "vencido" do badge é por régua efetiva. (Ordenar por "mais vencido pela régua" fica como melhoria futura.)

---

## 6. Como alimenta o Agente (fase seguinte, fora desta spec)

O lote diário do agente = pacientes **vencidos pela régua efetiva**, segmentados por cohorte → mensagem + profissional certos:
- Adulto → clínico · Criança → odontopediatra · Perio → periodontista · VIP → recall premium (intervalo próprio).
A config de "qual dentista é periodontista/odontopediatra" é problema do agente (não desta fase).

---

## 7. Arquitetura / arquivos

- **Migração (MCP):** `pacientes_abc.perio BOOLEAN DEFAULT false`, `pacientes_abc.ultima_prevencao_perio DATE`; `vip_pacientes.intervalo_dias INTEGER`.
- **`lib/prevencao/classificacao.js`:** sub-gengival/alisamento radicular → `'perio'` (em vez de `null`).
- **`sync/clinicorp-sync.js`** (`syncPrevencao`): categoria `perio` no agregado (entra no `ultima_prevencao`) + setar `perio`/`ultima_prevencao_perio` + gravar `bill_type` (de `producao_procedimentos`) nos eventos + incluir pacientes só-perio no upsert.
- **`public/js/pos-tratamento/curva-abc.js`**: carregar VIP map; badges Perio/VIP; status por intervalo efetivo; filtro cohorte; marcar/desmarcar VIP + intervalo inline; busca-adicionar-VIP.
- **`public/pos-tratamento/curva-abc.html`**: chips de cohorte + UI de busca/marcação VIP (reusa estilos de `vips.html`).
- **`public/js/nav-config.js`**: remover item `vips`.

---

## 8. Fora de escopo (Fase 1.5)

- O agente conversacional (disparo + triagem) — próxima spec.
- Config de periodontista/odontopediatra por dentista (é do agente).
- Portar o recall-log "contatado hoje" da página VIPs (o agente assume).
- Ordenar a lista por "mais vencido pela régua" (hoje ordena por data).

---

## 9. Critérios de pronto

- Sub-gengival/alisamento agora **conta** como prevenção (categoria `perio`) e entra no `ultima_prevencao`; `perio` flag correto (~40 pacientes); só-perio aparece na lista.
- `bill_type` (convênio) gravado nos `prevencao_eventos` (antes 100% NULL).
- VIP marcável inline na Curva ABC (marcar/desmarcar + intervalo) e por busca; página VIPs fora do menu.
- Coluna Status reflete o intervalo efetivo (VIP vence mais cedo; perio segue 180d).
- Badges Perio/VIP e filtro por cohorte funcionando.
