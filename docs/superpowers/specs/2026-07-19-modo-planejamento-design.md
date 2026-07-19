# Modo de Planejamento (Produção ①) — Design

**Data:** 2026-07-19
**Objetivo:** todo tratamento aprovado passa por um modo de planejamento onde o dentista avaliador monta as etapas, o profissional executor e o tempo de cada etapa — alimentando a Sucesso do Cliente com equipe+trilha, preparando o registro por sessão (ASB), a comparação planejado×real e o acompanhamento do paciente.

Design validado em 2 rodadas de revisão adversarial (18–19/07). Decisões do Luiz incorporadas.

## Contexto e motivação

Procedimentos multi-sessão (faceta: preparo→prova→cimentação; protocolo: ~6 meses entre provisório e definitivo) são lançados no Clinicorp como **1 procedimento**, marcado "Executed" só na entrega final. Consequências hoje:

- Auditoria de Registro Diário acusa **falsa pendência** nas sessões intermediárias (baseline ~28% de cobertura).
- Ninguém rastreia **etapas**; a Sucesso não sabe a equipe nem o próximo passo do paciente.
- Zero comparação **horas planejadas × reais** (custo de hora clínica e margem ficam invisíveis).

**Limitação técnica confirmada (18/07):** a API pública do Clinicorp NÃO escreve produção/evolução na ficha (404 em todos os endpoints candidatos). Escrita na ficha só pela API interna com sessão logada (login usuário+senha → "usuário-robô" server-side é plausível; formato do login ainda não capturado — única incerteza técnica, fora do caminho crítico desta entrega).

## Visão em entregas (esta spec = ①)

1. **① Planejamento** (esta spec) — fila automática, dentista monta plano, Sucesso ganha trilha.
2. **② Registro por sessão (ASB)** — ASB marca etapa realizada + tempo real no NOSSO sistema, gravando qual ASB foi responsável. Envio à ficha do Clinicorp via usuário-robô = evolução futura (pende captura do login).
3. **③ Fiscalização da gestora** — cobertura de anotações + planejado×real com custo de hora clínica e margem (configuráveis).
4. **④ Tracker do paciente** — link público tokenizado para acompanhar etapas.

**Backlog ligado (não é entrega desta série):** NPS em marcos do tratamento — venda aprovada, meio, fim — com regra global de **no máximo 1 pesquisa por pessoa a cada 3 meses** (número em aberto). Estende a Pesquisa de Satisfação já no ar; o planejamento fornece os marcos "meio" e "fim" que hoje não existem como dado.

## Arquitetura de decisões (o que as revisões cravaram)

1. **Desacoplado:** o paciente nasce em `pacientes_sucesso` **na aprovação** (sync), com flag `plano_pendente`. O planejamento é **enriquecimento**, nunca portão — ninguém trava o cuidado.
2. **Clinicorp é a verdade financeira:** aprovado no Clinicorp = conta como receita. Valor/entrada aparecem no plano **somente leitura** (espelho). Divergência → pendência para corrigir NO Clinicorp; o re-sync traz o valor certo. Nada de editar valor no CRM.
3. **Checagem comercial leve (caça-erro, não portão):** a CRC recebe fila enxuta de suspeitas — possível duplicata (renegociação), valor estranho — com **poder de veredito** (marcar duplicata/não-é-venda → mescla/cancela o registro da Sucesso e descarta o plano). Pendência > N dias escala para a gestora. A tela antiga de Conferência é aposentada.
4. **Triagem automática contra ruído (adoção do dentista = risco nº 1):** cada tipo de procedimento no banco de processos tem a marca `requer_plano`. Limpeza/avulsos de sessão única nascem já resolvidos e **não aparecem** na fila do dentista. Requisito de aceitação: **planejar um caso típico em < 2 minutos** (1 clique aplica o padrão; dentista só ajusta tempos; sub-lotes são exceção, não formulário default).
5. **Maleabilidade:** todo estado tem caminho de alteração manual (cancelar, reativar, mesclar, reatribuir) — nada fica travado em pedra.

## Dados (Supabase próprio — 4 tabelas novas)

### `plano_tratamento` — 1 por orçamento aprovado
- `estimate_id` (único, vínculo Clinicorp), `paciente_clinicorp_id`, nome espelhado.
- `dentista_avaliador_id` → usuário do CRM. Sugerido pelo profissional do estimate; **troca livre** (sistema pode identificar errado, ou outro dentista capturou a avaliação dentro do combinado) com registro de quem trocou e quando. Estimate cujo profissional não mapeia para dentista do CRM → fila da **gestora para atribuir** (nunca erro nem plano órfão).
- `status`: `aguardando_planejamento → planejado → em_andamento → concluido`; laterais: `descartado` (= "não precisa de etapas"; **nunca** remove da Sucesso), `cancelado` (venda desfeita — marca, não deleta; efeito espelhado no registro da Sucesso).
- `valor`, `entrada`: espelho read-only do Clinicorp.
- `orientacao_clinica` (avaliador→executor) e `recado_sucesso` (avaliador→CRC Sucesso): **dois campos** — leitores diferentes, textos diferentes.
- Flags: `possivel_duplicata` (heurística do sync), `divergencia_reportada`.

### `plano_itens` — item do orçamento dentro do plano
- `procedure_name`/`price_id`, **`quantidade` de primeira classe**.
- O dentista pode **dividir em sub-lotes** (ex.: 6 facetas → 4 sup numa sessão + 2 inf em outra). Restrição de conservação: soma das quantidades dos sub-lotes = quantidade do item.
- Default: **1 sub-lote auto-criado por item** com a sequência do padrão aplicada — dividir é ação explícita.

### `plano_etapas` — por sub-lote, ordenadas
- `descricao`, `profissional_executor`, `tempo_planejado_min`, `status`, `tempo_real_min` (nulo até a ②), `asb_responsavel` (nulo até a ②).
- Etapas de backfill já realizadas → status `concluida_retroativa` (não polui o futuro planejado×real).

### `processos_padrao` — banco de processos
- Por tipo de procedimento do catálogo: etapas-padrão com profissional sugerido e **tempo sugerido**.
- **Tempo NUNCA multiplica pela quantidade** (6 facetas ≈ 20–30% menos que 6×1) — padrão sugere, dentista crava o tempo do lote. Futuro: aprender tempo médio real por tipo/quantidade e sugerir.
- `requer_plano` (triagem automática — ver decisões).
- Governança: dentista salva novo padrão como **rascunho** (utilizável por ele imediatamente); gestora aprova/mescla (evita "Faceta"/"Facetas"/"Faceta emax" triplicadas).

### Config (schema agora, UI na ③ — YAGNI)
- `custo_hora_clinica` (hoje R$180 — **varia no tempo**, editável pela gestão) e `margem_alvo_default` (hoje 20% — default, sobrescrevível por procedimento). Usados na entrega ③.

**Segurança (obrigatório na migration de criação, não hardening depois):** RLS ligado nas 4 tabelas; escrita só server-side (service_role); leitura pelo front apenas via `/api` com `requireAuth`+role. `orientacao_clinica` é dado sensível.

## Fluxo

1. **Sync noturno** (ou botão manual) detecta orçamento aprovado →
   a. cria registro em `pacientes_sucesso` **imediatamente** com `plano_pendente` (dedup por `estimate_id` mantido);
   b. roda a **heurística de duplicata**: mesmo paciente + itens sobrepostos + janela curta → `possivel_duplicata` → fila da CRC;
   c. cria `plano_tratamento` em `aguardando_planejamento`; itens com `requer_plano=false` em todos → plano nasce `descartado` automático (não aparece pro dentista).
2. **Dentista** abre a fila "Planejar" (só o que requer plano): padrão aplicado em 1 clique, ajusta tempos/profissionais, escreve orientação + recado, divide sub-lotes se precisar. Concluir → `planejado`; a Sucesso ganha equipe+trilha e `plano_pendente` sai.
3. **CRC** vê a fila caça-erro (duplicatas, divergências) e dá veredito; correções de valor acontecem no Clinicorp.
4. **Pressões contra fila parada:** a Sucesso enxerga "paciente sem trilha" e cobra; alerta de plano parado > N dias escala para a **gestora** (não para o dentista).
5. **Auditoria de Registro Diário** (ganho imediato): sessão intermediária de paciente com plano ativo vira **"esperada pelo plano"** em vez de falsa pendência. Limitação documentada: se a agenda não expõe o procedimento da sessão, a dispensa é por paciente (grosseira) — pode mascarar pendência real de procedimento avulso; aceito conscientemente na ①, refinar na ② com o registro por etapa.

## Regras de re-sync (tabela de primeira classe)

| Mudança no Clinicorp | Regra |
|---|---|
| Item adicionado ao orçamento | cria item/sub-plano pendente automático; avisa o dentista |
| Item removido, sem etapas executadas | remove item do plano; registra no histórico |
| Item removido, com etapas executadas | **trava e sinaliza humano** — nunca reconciliar em silêncio |
| Quantidade alterada, sem etapas executadas | invalida sub-lotes do item e pede replanejamento |
| Quantidade alterada, com etapas executadas | **trava e sinaliza humano** |
| Valor/entrada alterado | atualiza espelho; alerta se o plano foi concluído sobre outro valor |
| Orçamento sumiu do retorno / status reverteu | sinal de cancelamento → marca `cancelado` + espelha na Sucesso (ver pré-requisito V2) |

## Pré-requisitos de verificação (antes de codar)

- **V1 — aprovação por item:** confirmar se `estimates/list` traz status por item (orçamento parcialmente aprovado → o plano filtra por item aprovado). Se não trouxer, definir fallback (plano do orçamento inteiro com aviso).
- **V2 — cancelamento visível:** confirmar o que o sync enxerga quando uma venda é desfeita (status muda? item some? orçamento some do retorno?). A regra de `cancelado` depende disso.
- **V3 — mapeamento dentistas:** conferir logins/roles dos 9 dentistas no CRM e medir nos estimates históricos quantos têm profissional que não mapeia (dimensiona a fila da gestora).
- **V4 — rate limit:** botão de sync manual passa pelo **throttle central** de chamadas Clinicorp (fila única, debounce por tela, sync dirigido por data) — não pode disputar às cegas as ~25 calls/h com Análise de Receita e sync noturno.

## Migração e cutover

- **Mesmo deploy:** desliga o hook de `pacientes_sucesso` da Conferência e liga a criação via sync (dedup por `estimate_id` protege a transição).
- A tela de Conferência antiga só morre depois que a fila caça-erro existir e a fila antiga estiver zerada.
- **Backfill dirigido — 3 populações:**
  1. conferidos-não-planejados (viram planos `aguardando_planejamento`);
  2. aprovados-não-conferidos na virada (não podem cair no vão entre os gatilhos);
  3. **tratamentos longos JÁ EM CURSO** (protocolos etc. — o motivo do projeto): gestora prioriza planejamento retroativo (lista curta), etapas já feitas = `concluida_retroativa`.

## UI

- **Fila "Planejar"** (dentista; role nova `dentista` reusada + `mod_planejamento`): página própria seguindo padrão do CRM (`nav-config.js` como fonte única, `shared-nav.js`, registro no módulo de Usuários em 3 lugares + middleware, retry 5xx padrão).
- **Tela do plano:** itens com padrão pré-aplicado, ajuste de tempos inline, divisão em sub-lotes sob demanda, dois campos de texto, valor/entrada read-only com "reportar divergência".
- **Fila caça-erro** (CRC): duplicatas + divergências, veredito com efeito.
- **Fila da gestora:** planos sem dentista mapeado (atribuir) + alertas de plano parado.
- Botão de **sync manual** (regra da casa em módulo Clinicorp).
- Critério de aceitação de UX: **caso típico planejado em < 2 minutos**.

## Estados sem dono nesta entrega

- `planejado → em_andamento`: gatilho definido = primeiro comparecimento do paciente após plano concluído (agenda já sincronizada). Até a ② existir, `em_andamento → concluido` pode ser manual (dentista/gestora) — documentado.

## Fora de escopo desta entrega

- Registro por etapa da ASB (②), fiscalização planejado×real (③), tracker do paciente (④).
- Escrita na ficha do Clinicorp (usuário-robô — pende captura do formato do login).
- UI de configuração de custo/margem (schema criado agora, tela na ③).
- NPS em marcos (backlog; regra de cooldown ≥3 meses por pessoa).
- Filtro fino de "quais tratamentos requerem plano" — default inicial: tudo requer, exceto tipos marcados `requer_plano=false` pela gestora (limpeza etc.); calibrar em produção.

## Testes

- Unit (JS puro, padrão `lib/`): heurística de duplicata; triagem `requer_plano`; conservação de quantidades nos sub-lotes; máquina de estados (transições válidas/inválidas); regras de re-sync (cada linha da tabela); gatilho `em_andamento`.
- Manual pós-deploy: aprovar orçamento de teste → conferir nascimento na Sucesso com `plano_pendente` + plano na fila; planejar caso típico cronometrado (< 2 min); reportar divergência e corrigir no Clinicorp → re-sync atualiza espelho.
