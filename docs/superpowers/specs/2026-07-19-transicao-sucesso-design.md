# Transição do Planejamento — Página da Sucesso + rollout manso — Design (delta)

**Data:** 2026-07-19 (delta sobre `2026-07-19-modo-planejamento-design.md`, cujo código já está na branch `planejamento`)
**Objetivo:** virar o Modo de Planejamento sem despejar o histórico na equipe. O backlog vive na Sucesso (nunca na fila do dentista); a `/pacientes/` atual fica intocada; convênio entra só pela mão da Sucesso; nada de dado do Sucesso se perde.

## Decisões (validadas com o Luiz, 19/07)

1. **`/pacientes/` (Sucesso atual) fica INTOCADA.** Reverter o badge que a Task 9 adicionou a essa página — o dado (`plano_status`/`plano_pendente`/`recado_sucesso`) segue disponível pela API, mas a página antiga não muda um pixel.
2. **Página NOVA** para a camada de planejamento da Sucesso (`/trilhas/`): lista de pacientes reusando os dados que já existem (mesma base) + coluna de planejamento + trilha ao abrir + botão Planejar + "+ Adicionar paciente". Terreno limpo, consome a API já pronta.
3. **Backlog não vai pro dentista.** A fila do dentista (`/planejamento/`) mostra SÓ casos novos. O histórico vive na página nova da Sucesso, "sem planejamento", trabalhado no ritmo dela. → coluna `origem` no plano.
4. **Selo `Particular` / `Convênio` / `Misto`** em TRÊS visões: fila do dentista, página da Sucesso, fila de suspeitas da CRC. Dado já existe (`orcamentos.eh_convenio` + `valor_particular` vs `valor`).
5. **Convênio: automático continua SÓ particular** (paridade com a Conferência antiga). Convênio entra **manualmente**, pela Sucesso, via "+ Adicionar paciente" — resolve o protocolo de convênio que "quase nunca faziam".
6. **Duplicata só SINALIZA, humano decide.** O veredito de duplicata/não-venda NÃO faz mais soft-delete automático de `pacientes_sucesso` — apenas marca a suspeita; a remoção/mescla é ação humana explícita. Protege contra perder um paciente que a equipe já trabalha por uma detecção errada.
7. **Conferência morre** (como já construído); novos entram pelo status APPROVED da Clinicorp.

## Garantias de não-perda de dados (requisito duro)

- A camada de planejamento **só lê** `pacientes_sucesso` e escreve nas tabelas dela (planos/itens/etapas). Nunca faz UPDATE em colunas que a Sucesso preenche.
- Criação em `pacientes_sucesso` é sempre INSERT com dedup por `estimate_id` (nunca sobrescreve linha existente).
- Migração e backfill são aditivos.
- Veredito de duplicata deixa de apagar (decisão 6).

## Modelo de dados (delta)

`plano_tratamento` ganha:
- `origem text NOT NULL DEFAULT 'sync_novo'` CHECK IN (`sync_novo`, `backlog`, `sucesso_manual`). Fila do dentista = só `sync_novo`. Página da Sucesso = todos.
- `tipo_pagamento text` — `particular` | `convenio` | `misto` | NULL. Calculado na criação (particular se `valor_particular = valor`; convênio se `valor_particular = 0`; misto se `0 < valor_particular < valor`). Manual: informado pela Sucesso.
- `descricao_manual text` — para caso incluído sem orçamento na Clinicorp.

Sem tabela nova. Segurança: colunas em tabela que já tem RLS.

## Comportamento

### Sync (delta sobre `syncPlanejamento`)
- Criação nova (nightly) nasce `origem='sync_novo'` (vai pra fila do dentista).
- Calcular `tipo_pagamento` de cada plano na criação e no re-sync (espelho).
- O backfill (script) stampa os históricos como `origem='backlog'` (NÃO vão pra fila do dentista). Ordem garante: backfill cria tudo que já está aprovado como backlog; a partir daí o nightly só cria os genuinamente novos (skip por `planosByEst.has`).

### API (delta)
- `GET /api/planejamento/fila?aba=planejar`: adicionar `.eq('origem','sync_novo')`.
- Nova aba `aba=sucesso` (página nova): TODOS os planos (backlog + novo + manual) com dados do paciente, filtros sem-planejamento/em-tratamento/protocolos, selo, origem. Roles: crc_sucesso, crc_comercial, gestor, admin, mod_planejamento.
- Veredito duplicata/nao_venda (decisão 6): **remover** o `pacientes_sucesso.update(excluido_em)` automático; manter só o flag `possivel_duplicata`/veredito registrado; remoção fica em ação humana separada (fora do escopo ① — por ora só sinaliza).
- `GET /api/planejamento/buscar-paciente?q=`: busca em `pacientes` (nome/telefone) + orçamentos da pessoa (com selo conv/particular). Para o "+ Adicionar".
- `POST /api/planejamento/incluir-manual`: cria `pacientes_sucesso` (se não existir) + `plano_tratamento` com `origem='sucesso_manual'`, a partir de um estimate escolhido OU de `descricao_manual`. Roles: crc_sucesso, gestor, admin, mod_planejamento.
- Sucesso listing (`GET /api/pacientes`): anexar `tipo_pagamento` além do `plano_status` já feito.

### UI
- **Reverter** o badge da Task 9 em `/pacientes/` (página intocada).
- **Página nova `/trilhas/`** (nav na seção CRC Sucesso): lista + trilha (drawer) + botão Planejar (reusa editor do `/planejamento/`) + "+ Adicionar paciente" (busca → escolhe tratamento/descreve → cria manual) + selo + filtros. Escape de HTML em tudo (nomes vêm da Clinicorp).
- **Selo** no card da fila do dentista (`/planejamento/`) e na fila de suspeitas.

## Fora de escopo (mantém do design original)
Registro por etapa da ASB (②), fiscalização (③), tracker público (④), NPS. A "ação humana de mesclar duplicata" (decisão 6) fica como sinalização por ora; a mescla explícita entra depois se necessário.

## Testes
- Unit: cálculo de `tipo_pagamento` (particular/convênio/misto/edge) na lib de triagem.
- Manual pós-deploy: backlog não aparece na fila do dentista; aparece na página da Sucesso; "+ Adicionar" inclui um convênio; selo correto nas 3 telas; `/pacientes/` idêntica ao que era; duplicata só marca.
