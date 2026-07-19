# Usuário somente-leitura "parceiro" — Design

**Data:** 2026-07-18
**Objetivo:** dar a um amigo (e ao Claude dele) um login que **vê todo o sistema mas
não altera nada**, para entenderem o que dá pra aproveitar (organização de ideias,
inteligência dos módulos). Acesso contínuo e sem supervisão. Decisão consciente do
Luiz: **dados reais**, sem máscara de nome/telefone (opção "liberar tudo").

---

## O que a auditoria revelou (por que "só bloquear no /api" não basta)

1. **O front lê tabelas direto no Supabase** (login `authenticated` + anon key pública),
   e o papel `authenticated` tem **escrita direta** aberta em tabelas centrais
   (`leads`, `mensagens`, `chamadas`, `dentista_config`) sem exigir role. Como o
   `parceiro` seria `authenticated`, ele poderia **gravar por fora do servidor**.
   → Um bloqueio só no Express NÃO torna o usuário somente-leitura.

2. **Brecha de escalada de privilégio (CORRIGIDA 18/07):** qualquer `authenticated`
   podia reescrever o próprio `profiles.roles` e virar admin. Fechada com
   `REVOKE INSERT,UPDATE,DELETE ON profiles FROM authenticated, anon`
   (migração `fix_privesc_profiles_revoke_write_from_authenticated`). Ver
   memória `reference_privesc_profiles_e_escrita_authenticated`.

3. As 3 tabelas que o front escreve direto (`vip_pacientes`, `mensagens_padrao_crc`,
   `recall_logs`) **já exigem papel privilegiado** por RLS — o `parceiro` (que não terá
   nenhum) já está bloqueado nelas. Todas as outras escritas do app passam pelo
   servidor (service_role).

**Conclusão:** o cadeado de "não escreve nada" precisa estar **no banco**, não só no
servidor. Escolha do Luiz: **caminho LEVE** — fechar a escrita direta no banco
revogando os grants abandonados de `authenticated`, em vez de criar papel/hook novo.
Motivo: a ameaça real é "cutucar acidental", não atacante determinado; a parte
perigosa (privesc) já foi corrigida; e um Auth Hook rodaria no login de TODOS —
risco desproporcional para uma feature de "deixar um amigo olhar".

---

## Arquitetura da solução (4 camadas)

### Camada 1 — Fechar a escrita direta no banco (o cadeado real)
O front só escreve DIRETO em 3 tabelas (`vip_pacientes`, `mensagens_padrao_crc`,
`recall_logs`) — todas já role-gated, seguras contra o parceiro. As demais escritas
diretas de `authenticated`/`anon` são **grants abandonados** (o app grava via servidor
com service_role). Revogar esses grants fecha a escrita direta do parceiro **e conserta
uma exposição real do sistema**, sem tocar no login de ninguém.
- Alvo mínimo (exploráveis pelo parceiro, sem exigir role/dono): `chamadas`,
  `dentista_config` (política `true`!), `leads`, `mensagens`.
  `REVOKE INSERT,UPDATE,DELETE ON <tabela> FROM authenticated, anon;`
- Manter os grants das 3 tabelas que o front usa (RLS já barra o parceiro).
- Não é blindado contra tabelas FUTURAS com escrita aberta — mitigado pela regra já
  existente no CLAUDE.md ("toda tabela nova nasce com RLS trancada").

### Camada 2 — Servidor: bloqueio de escrita + GETs com efeito colateral
O servidor usa service_role (ignora o cadeado do banco), então precisa de guarda própria:
- Middleware global (após `requireAuth`): se o usuário é `parceiro` e o método **não é
  GET** → 403. Um lugar só.
- Bloquear também os **GET que escrevem** (o inventário achou 3 relevantes): 
  `GET /api/tarefas` (gera tarefas do dia → insert), `GET /api/social-media/ia/analise`
  (upsert cache + custo Gemini), `GET /api/financeiro/avaliacao` (upsert cache + Gemini).
  Para `parceiro`, servir versão sem efeito (ler cache existente / pular geração) ou 403.

### Camada 3 — Servidor: liberar LEITURA de tudo pro parceiro
- Alterar `requireRole(...)`: se o usuário tem role `parceiro` **e** o método é GET →
  `next()` (passa em qualquer rota de leitura). Uma mudança cobre todas as GETs
  gated por `requireRole`.
- Tratar os handlers que barram por role **por dentro** (inventário, Lista 3): as GETs
  `/api/avaliacoes`, `/api/avaliacoes/:id`, `/api/monitor-crc`, `/api/coletas/:id/dashboard`
  dão 403 a quem não é gestor/dentista. Incluir `parceiro` (leitura, visão de gestor)
  nesses checks. `GET /api/tarefas/templates` só mostra a visão de gestão a gestor —
  incluir parceiro.
- Liberar os POSTs-que-são-leitura (inventário, Lista 1): `/api/campanhas/preview`,
  `/api/disparos/preview`, `/api/publicos/preview`, `/api/publicos/exportar`,
  `/api/social-media/ia/pergunta`. (Sem esses, as telas correspondentes ficam cegas.)
  `/api/leads/exportar` fica de fora do parceiro (gera registro de auditoria LGPD).

### Camada 4 — Front: menu e botões
- `nav-config.js`: incluir `parceiro` nos `roles` dos itens que ele deve ver (todos,
  exceto ações de escrita pura). Fonte única — não editar index/shared-nav.
- Esconder botões de editar/sincronizar/aprovar para `parceiro` (cosmético; o cadeado
  real são as camadas 1–2). Onde o botão continuar visível, o clique só resulta em
  403 — aceitável, mas melhor esconder onde for fácil.
- Registrar o role no módulo de Usuários (padrão do CLAUDE.md) para criar o login.

---

## Fora de escopo / follow-ups
- **Hardening amplo** (revogar escrita direta não-usada de `authenticated` em
  `leads/mensagens/chamadas/dentista_config`): recomendado, mas é mudança de alto
  alcance; tratar em projeto próprio. A Camada 1 já protege o parceiro sem depender disso.
- Máscara de nome/telefone: descartada por decisão do Luiz.
- Módulos de WhatsApp/conversas: o parceiro pode vê-los (decisão "liberar tudo"); se
  preferir esconder, é só omitir do `nav-config` + não liberar as rotas — trivial.

## Rollback
- Camada 1: re-`GRANT` dos writes revogados (mas eles são abandonados; reverter só se
  algo inesperado quebrar). Camadas 2–4: reverter o commit. O REVOKE da profiles
  (privesc) NÃO deve ser revertido — é correção independente.

## Critérios de aceite
1. Logado como `parceiro`, toda tela de leitura carrega com dados reais.
2. Nenhuma ação de escrita funciona: nem por botão, nem por chamada direta ao
   PostgREST (retorna permission denied), nem por GET-com-efeito no servidor (403).
3. Nenhum outro usuário/role é afetado.
