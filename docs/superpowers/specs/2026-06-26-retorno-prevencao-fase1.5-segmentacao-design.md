# Retorno de Prevenção — Fase 1.5: Segmentação (Perio + VIP) — Design

**Data:** 2026-06-26
**Status:** Aprovado no brainstorm, pendente revisão da spec escrita
**Pré-requisito de:** Agente de Retorno (conversacional) — esta fase fecha as réguas antes do agente.
**Relaciona:** `2026-06-15-retorno-prevencao-design.md` (Fase 1), `project_retorno_prevencao`, `project_agentes`.

---

## 1. Objetivo

A Fase 1 entregou a lista de prevenção vencida (180d) por Adulto/Infantil (513 vencidos). Faltam **duas segmentações** antes de o agente conversacional disparar com a mensagem/régua certas:

1. **Selo Perio** — identificar pacientes de tratamento periodontal (para rotear a mensagem ao periodontista). **Mesmo intervalo de 180d** — é só um marcador, não muda o prazo.
2. **Régua VIP** — pacientes do pacote (PPAMA) têm intervalo de retorno **mais curto e que varia por paciente** (de mensal a 4-em-4-meses). É o único prazo diferente do padrão de 180d.

Decisão do Luiz: o intervalo é **180d para todos** (adulto/criança/perio); só os **VIPs** têm tempo diferente (por isso a lista VIP existe). Periodontia surgiu como necessidade de **mensagem/profissional diferentes**, não de prazo.

---

## 2. Selo Perio

**Quem é perio:** paciente com histórico de **raspagem sub-gengival / alisamento radicular** (NÃO inclui cirurgias periodontais pontuais — retalho/enxerto/gengivectomia ficam fora, decisão do Luiz). Volume atual: **40 pacientes**.

**Como detectar:** na `syncPrevencao` (que já varre `producao_procedimentos`), além de classificar prevenção, marca-se perio quando `normalizar(procedure_name)` casa **(`sub` E `gengiv`)** OU `alisamento radicular`. (O classificador de prevenção já exclui sub-gengival de propósito — esta é uma checagem paralela, no mesmo loop.)

**Onde guarda:** nova coluna `pacientes_abc.perio BOOLEAN DEFAULT false`. A `syncPrevencao` (rebuild completo) define `perio` para todo paciente casado: `true` se tem procedimento perio, senão `false`.

**Pacientes só-perio (sem prevenção):** um paciente que só fez sub-gengival (nenhuma profilaxia) não entra hoje no agregado de prevenção. Para aparecer na lista (com "Última Prevenção = Nunca" + badge Perio), a `syncPrevencao` inclui esses pacientes no upsert de `pacientes_abc` (já estão casados a um `paciente_id` pelo nome), com `ultima_prevencao=null, perio=true`.

**Uso:** badge "Perio" na lista; e o agente (fase seguinte) usa o selo para mandar a mensagem/rota do periodontista. **NÃO muda o intervalo (180d).**

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

- **Migração (MCP):** `pacientes_abc.perio BOOLEAN DEFAULT false`; `vip_pacientes.intervalo_dias INTEGER`.
- **`sync/clinicorp-sync.js`** (`syncPrevencao`): detecção perio no loop + incluir perio no upsert de `pacientes_abc` + incluir pacientes só-perio.
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

- `syncPrevencao` marca `perio` correto (~40 pacientes) e inclui só-perio na lista.
- VIP marcável inline na Curva ABC (marcar/desmarcar + intervalo) e por busca; página VIPs fora do menu.
- Coluna Status reflete o intervalo efetivo (VIP vence mais cedo; perio segue 180d).
- Badges Perio/VIP e filtro por cohorte funcionando.
