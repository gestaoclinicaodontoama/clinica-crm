# Motor de emissão NFS-e via WebService ABRASF (Ipatinga/SigCorp)

**Data:** 2026-07-09 · **Status:** aprovado pelo Luiz (brainstorm 09/07)

Substitui o robô Playwright (`nf-automation/` + serviço `nf-agente` no Easypanel) por
integração servidor-a-servidor com o webservice oficial da prefeitura de Ipatinga.

## 1. Contexto e problema

O sistema atual emite NFS-e **simulando um humano no site do SIGISS** (Playwright +
scraping + captcha). Consequências documentadas: 2 incidentes de "nota falsamente
Emitida" (05/2026), notas PFNI, fragilidade a qualquer mudança no site.

### Descobertas da investigação (08-09/07/2026)

1. **Padrão Nacional NÃO serve para emissão hoje.** Planilha oficial gov.br
   (`municipiosaderentes20260707.xlsx`): Ipatinga é *Conveniado Ativo* e aderente ao
   **Ambiente de Dados Nacional** desde 01/01/2026, mas **AderenteEmissorNacional = Não**.
   Emissão continua obrigatoriamente pelo sistema municipal (SIGISS). O PRD de
   integração com a API Nacional (recebido de colega do Luiz) fica como referência
   futura, caso Ipatinga adira ao Emissor Nacional.
2. **Ipatinga tem webservice oficial ABRASF 2.04** (provedor SigCorp), verificado no ar:
   - Produção: `https://abrasfipatinga.meumunicipio.online/ws` (`?wsdl` ok)
   - **Homologação:** `https://testeipatingaabrasf.meumunicipio.online/ws`
   - Operações: `GerarNfse`, `CancelarNfse`, `ConsultarNfsePorRps`, `ConsultarLoteRps`,
     `ConsultarNfseFaixa`, `ConsultarNfseServicoPrestado/Tomado`, `RecepcionarLoteRps(Sincrono)`,
     `SubstituirNfse`.
   - Fonte da URL: registro ACBr (`ACBrNFSeXServicos.ini`, seção `[3131307]`).
3. **Campos da Reforma Tributária no WS:** manual da prefeitura
   (`/ISS/download/WebService-CamposAdicionais.pdf`) define `cNBS` (obrigatório) e grupo
   `IBSCBS` na raiz da nota. Valores já usados pelo robô atual no SIGISS:
   `cNBS=123012300`, localidade de incidência `3131307` (IBGE Ipatinga), item de
   serviço `412` (4.12 odontologia), alíquota ISS 3,00 / Simples 4,3547.

## 2. Escopo

**Dentro:** motor de emissão + cancelamento para as 2 empresas PJ, via WS ABRASF,
rodando dentro do CRM Node no Easypanel. UI atual da fila mantida (mesma tela, mesmo
botão "Emitir pendentes"). Upload do PDF ao Google Drive.

**Fora (decisões explícitas do Luiz):**
- **Receita Saúde** (recibos PF do Marcos via e-CAC): fluxo atual intocado — exige
  login gov.br 2FA, não automatizável em servidor. Scripts locais permanecem.
- **Fila automática a partir do Clinicorp**: fica como evolução futura (ver §11).
- Emissor Nacional/ADN: monitorar adesão futura de Ipatinga; nada a construir agora.

### Emissores

| Sistema (valor atual em `notas_fiscais.sistema`) | Razão social | CNPJ |
|---|---|---|
| `Vieira` | Vieira e Vidigal Martins LTDA | 05617377000108 |
| `Martins` | Clinica Odontologica Martins | 33967625000186 |

`Receita Saude` continua como terceiro valor válido, mas o motor novo ignora essas
notas (seguem o fluxo manual local).

## 3. Arquitetura

Tudo no repositório do CRM (Node/Express), sem serviço novo:

```
lib/nfse/
  montar-xml.js    → gera XML do RPS (ABRASF 2.04 + cNBS/IBSCBS do manual SigCorp)
  assinar.js       → assinatura digital do XML com certificado A1 (SE a POC provar necessário)
  cliente.js       → POST SOAP (fetch nativo), timeout configurável, sem retry cego
  reconciliar.js   → ConsultarNfsePorRps para fechar estado após timeout/queda
  emitir.js        → orquestra: fila Pendente → Processando → Emitida/Erro
  drive.js         → upload do PDF/DANFSE à pasta do Drive (service account já usada no gspread)
```

- `server.js`: rota `POST /api/notas-fiscais/emitir` (protegida `requireAuth` +
  `requireRole('admin','gestor','mod_notas_fiscais')`) dispara o processamento;
  `GET /api/notas-fiscais/emitir/status` para a barra de progresso (a UI atual já faz polling).
- Rota `POST /api/notas-fiscais/:id/cancelar` (motivo obrigatório; `admin`/`gestor`).
- **Aposentadoria:** serviço `nf-agente` do Easypanel desligado ao final; endpoints
  `/api/nf-captcha*` removidos do `server.js`; pasta `nf-automation/` fica no repo
  apenas pelo uso local do Receita Saúde (README anotando isso).

### Processamento

Sequencial, uma nota por vez (volume é baixo; simplicidade > throughput). Estados:

`Pendente → Processando → Emitida | Erro` (mesmos valores de hoje; nenhuma migração de dados).

Regra de ouro: **só marca `Emitida` com `numero_nfse` + `codigo_verificacao` retornados
pela prefeitura.** Qualquer outra situação → `Erro` com a mensagem oficial (código +
descrição ABRASF) traduzida/legível na tela.

### Idempotência (mata o bug histórico por design)

- Cada nota recebe um **número de RPS** de sequência própria por empresa
  (tabela `nf_rps_seq`, incremento transacional) **antes** do envio.
- Timeout/queda de conexão após envio → status fica `Processando` e o reconciliador
  chama `ConsultarNfsePorRps(rps)`: se a nota existe na prefeitura, completa como
  `Emitida`; se não existe, volta a `Pendente`. **Nunca** reenvia sem consultar antes.
- Reprocessar uma nota `Erro` reutiliza o mesmo RPS (a prefeitura rejeita duplicata,
  proteção extra).

## 4. Modelo de dados

Colunas novas em `notas_fiscais` (aditivo, nada quebra):

- `rps_numero int`, `rps_serie text default '1'`
- `codigo_verificacao text`
- `xml_envio text`, `xml_retorno text` (auditoria/prova fiscal)
- `ambiente text default 'producao'` (`homologacao|producao` — nota de treino nunca se
  mistura com real)
- `drive_link text`
- (já existem: `num_nota`, `data_emissao`, `caminho_pdf`, `erro_msg`, `historico jsonb`)

Tabelas novas (ambas com RLS habilitado, sem policy — acesso só via servidor):

- `nf_emissores`: `sistema` (PK, `Vieira|Martins`), `razao_social`, `cnpj`,
  `inscricao_municipal`, `regime_tributario`, `optante_simples`, `item_lista_servico`
  (ex.: `412`), `cnae`, `codigo_tributacao_municipio`, `aliquota`, `aliquota_simples`
  (o SIGISS usa as duas: ISS 3,00 e Simples 4,3547), `cnbs`,
  `descricao_padrao`, `drive_folder_id`, `ativo`.
- `nf_rps_seq`: `sistema` (PK), `proximo_rps int` (avanço atômico via função SQL).

**Segredos ficam no env do Easypanel, nunca no banco:** `NFSE_AMBIENTE`,
`NFSE_CERT_VIEIRA_B64` + `NFSE_CERT_VIEIRA_SENHA`, `NFSE_CERT_MARTINS_B64` +
`NFSE_CERT_MARTINS_SENHA` (se a POC provar que precisa de certificado; caso o WS
autentique por usuário/senha SIGISS, variáveis `NFSE_WS_*_LOGIN/SENHA` no mesmo molde).

## 5. Fluxo de emissão (ponta a ponta)

1. Usuário lança/importa notas como hoje (nada muda) e clica **Emitir pendentes**.
2. Servidor filtra `status='Pendente'` e `sistema in (Vieira, Martins)`.
3. Por nota: valida dados mínimos (CPF/CNPJ tomador válido, valor > 0, competência,
   emissor configurado) → reserva RPS → monta XML → (assina) → envia `GerarNfse`.
4. Resposta com `Numero` + `CodigoVerificacao` → grava `Emitida`, `num_nota`,
   `data_emissao`, `codigo_verificacao`, `xml_retorno`, monta `caminho_pdf` com o link
   de impressão oficial e sobe o PDF ao Drive (`drive_link`).
5. Resposta com `ListaMensagemRetorno` → `Erro` + `erro_msg` = "E160: CPF do tomador
   inválido" (código oficial + texto). Histórico jsonb registra a transição (já existe).
6. Timeout/erro de rede → permanece `Processando`; reconciliador roda ao final do lote
   (e num tick posterior) consultando por RPS.

### Falha do Drive não bloqueia

Upload ao Drive é pós-emissão e best-effort: se falhar, a nota fica `Emitida` com
`drive_link` vazio e a tela mostra "⚠️ Drive pendente" com botão de retry. Nota emitida
é fato fiscal; Drive é conveniência.

## 6. Cancelamento

Botão **Cancelar nota** na tela (só `admin`/`gestor`; nota `Emitida`; motivo
obrigatório) → `CancelarNfse` com código de cancelamento ABRASF (erro na emissão = 1,
serviço não prestado = 2…). Sucesso → status novo **`Cancelada`** (adicionado a
`NF_STATUS`), `historico` registra quem/quando/motivo. As 3 notas PFNI antigas já foram
canceladas manualmente pelo Luiz (09/07) — sem backlog a limpar.

## 7. Ambientes e rollout

- `NFSE_AMBIENTE=homologacao` → endpoints de teste + banner amarelo na tela
  ("AMBIENTE DE TREINO — notas sem valor fiscal") + `ambiente='homologacao'` gravado.
- Rollout: POC em homologação → suíte completa em homologação → Luiz valida →
  troca env para produção → primeira nota real de valor baixo conferida no portal
  SIGISS → aposentar nf-agente.

## 8. Segurança

- Rotas novas com `requireAuth` antes de `requireRole` (regra da casa).
- Tabelas novas com RLS ligado desde a migração (regra da casa pós-incidente 07/2026).
- Certificado/senhas só em env; `xml_envio/xml_retorno` não contêm a senha.
- Logs técnicos nunca imprimem certificado/senha.

## 9. Tratamento de erros e observabilidade

- Mapa de mensagens ABRASF → português claro na tela (tabela local dos códigos comuns).
- Contadores do lote no status do polling: emitidas/erros/aguardando.
- `registrarJob('nf_emissao', ...)` no monitor de Saúde dos Syncs (infra já existe,
  §job_health) — falha recorrente aparece no sino do gestor.

## 10. Riscos e incógnitas (a POC resolve)

| # | Incógnita | Plano |
|---|---|---|
| 1 | WS exige assinatura digital A1? (padrão ABRASF sim; SigCorp às vezes dispensa) | POC em homologação testa sem assinar; se rejeitar, assina. Luiz já perguntou os certificados ao contador. |
| 2 | Como o WS autentica o prestador (certificado vs usuário/senha no XML) | Idem POC; SigCorp costuma identificar pelo par CNPJ+Inscrição Municipal no XML assinado. |
| 3 | Homologação exige cadastro prévio do CNPJ? | POC descobre; se precisar, contato com suporte SigCorp/prefeitura (chat Movidesk no portal). |
| 4 | Campos IBS/CBS obrigatórios em 2026 além de `cNBS` | Manual da prefeitura já baixado; validar na POC com nota mínima. |
| 5 | Link de impressão do DANFSE no retorno | Se o retorno não trouxer URL, usar consulta pública SIGISS (`nfe_print.php`) como hoje, ou gerar DANFSE própria a partir do XML (decidir na implementação — o que for mais simples). |

## 11. Evoluções futuras (registradas, fora de escopo)

- **Fila automática do Clinicorp:** `payment/list` traz CPF (`PayerDocumentNumber`),
  nome, valor e data — dá para propor notas prontas para revisão. Empresa deduzida
  pela conta que recebeu, com **alerta de divergência** quando o paciente tem notas
  anteriores pela outra empresa (dor real: pagamento de boleto no débito presencial).
- **Emissor Nacional:** se Ipatinga aderir, trocar o `cliente.js` mantendo o resto.
- Drive: envio automático do PDF por e-mail ao contador/tomador.

## 12. Critérios de aceite

1. Nota emitida em **homologação** ponta a ponta pelo botão da tela, com número +
   código de verificação gravados e XMLs de envio/retorno armazenados.
2. Nota com dado inválido → `Erro` com mensagem oficial legível; corrigir e reprocessar
   funciona.
3. Derrubar a conexão no meio do lote → nenhuma nota duplicada nem `Emitida` falsa;
   reconciliador fecha o estado correto.
4. Cancelamento pela tela funciona (homologação) com motivo auditado no histórico.
5. PDF acessível pelo botão da tela e arquivo no Drive na pasta da empresa.
6. Emissão real em produção conferida no portal SIGISS pelo Luiz.
7. Serviço `nf-agente` desligado; endpoints `nf-captcha` removidos; zero regressão no
   fluxo Receita Saúde local.
